'use strict';

const crypto = require('crypto');
const axios = require('axios');
const logger = require('../../config/logger');
const scrubHttpError = require('../../utils/scrubHttpError');

// Kraken Spot REST client. READ ENDPOINTS ONLY -- see ALLOWED_ENDPOINTS below.
//
// Docs consulted at implementation time (2026-07):
//   auth ......... https://docs.kraken.com/api/docs/guides/spot-rest-auth
//   intro ........ https://docs.kraken.com/api/docs/guides/spot-rest-intro
//   errors ....... https://docs.kraken.com/api/docs/guides/spot-errors
//   rate limits .. https://docs.kraken.com/api/docs/guides/spot-rest-ratelimits
//   Balance ...... https://docs.kraken.com/api/docs/rest-api/get-account-balance
//   Ledgers ...... https://docs.kraken.com/api/docs/rest-api/get-ledgers-info
//   WithdrawStatus https://docs.kraken.com/api/docs/rest-api/get-status-recent-withdrawals
//   DepositStatus  https://docs.kraken.com/api/docs/rest-api/get-status-recent-deposits

const BASE_URL = 'https://api.kraken.com';
const TIMEOUT_MS = 20000;

// The app is a tracker. It must never be able to place an order or move funds
// no matter what the stored key is permitted to do, so the endpoint is checked
// here rather than trusted to every call site. A key with trade or withdraw
// rights is the user's mistake to make; using it would be ours.
const ALLOWED_ENDPOINTS = new Set([
  'Balance',
  'BalanceEx',
  'Ledgers',
  'QueryLedgers',
  'TradesHistory',
  'WithdrawStatus',
  'DepositStatus',
]);

// https://docs.kraken.com/api/docs/guides/spot-rest-ratelimits
// Counter caps at 15 on the Starter tier and decays at 0.33/sec; ledger and
// trade-history calls cost 2, everything else 1. Assuming Starter is the safe
// default -- a Pro key just spends its allowance more slowly than it could.
const COUNTER_MAX = 15;
const COUNTER_DECAY_PER_SEC = 0.33;
const EXPENSIVE_ENDPOINTS = new Set(['Ledgers', 'QueryLedgers', 'TradesHistory']);

// "additional calls will be restricted for a few seconds (or possibly longer
// if calls continue to be made while the rate limits are active)" -- so a
// retry that fires too early extends the penalty rather than clearing it.
const RATE_LIMIT_BACKOFF_MS = [5000, 15000];

// Per-key state. The nonce is documented as "an always increasing, unsigned
// 64-bit integer for each request that is made with a particular API key", so
// two concurrent requests on one key race and the loser gets
// EAPI:Invalid nonce. Both the nonce and the rate-limit counter are therefore
// keyed by the API key and serialized through one promise chain.
const keyState = new Map();

function stateFor(apiKey) {
  let state = keyState.get(apiKey);
  if (!state) {
    state = { lastNonce: 0, counter: 0, updatedAt: Date.now(), queue: Promise.resolve() };
    keyState.set(apiKey, state);
  }
  return state;
}

function nextNonce(state) {
  // Milliseconds, forced monotonic: a clock that steps backwards (NTP, a
  // container resume) would otherwise emit a nonce Kraken has already seen and
  // lock the key out of every subsequent request.
  const nonce = Math.max(Date.now(), state.lastNonce + 1);
  state.lastNonce = nonce;
  return String(nonce);
}

// Set only by tests. The counter below mirrors Kraken's real decay, so a
// 25-page walk genuinely takes ~2.5 minutes of wall clock; a test that
// exercises the page budget would otherwise spend all of it asleep. Off is
// never the default, and nothing in src/ turns it off. It also short-circuits
// the retry backoff, so a test that exercises a transport failure does not
// spend 20 seconds asleep proving it.
let pacingEnabled = true;

const sleep = (ms) => (pacingEnabled ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve());

// Client-side mirror of Kraken's counter, so the common case never touches the
// server-side limiter at all.
async function spendCounter(state, cost) {
  if (!pacingEnabled) return;
  for (;;) {
    const now = Date.now();
    state.counter = Math.max(0, state.counter - ((now - state.updatedAt) / 1000) * COUNTER_DECAY_PER_SEC);
    state.updatedAt = now;
    if (state.counter + cost <= COUNTER_MAX) {
      state.counter += cost;
      return;
    }
    const overBy = (state.counter + cost) - COUNTER_MAX;
    await sleep(Math.ceil((overBy / COUNTER_DECAY_PER_SEC) * 1000) + 50);
  }
}

function krakenError(messages, { code = 'KRAKEN_API_ERROR' } = {}) {
  const list = Array.isArray(messages) ? messages : [String(messages)];
  const error = new Error(`Kraken error: ${list.join(', ')}`);
  error.code = code;
  error.krakenErrors = list;
  return error;
}

// Kraken answers HTTP 200 with a populated `error` array on failure, and may
// omit `result` entirely. Treating 2xx as success is the classic way to import
// an empty ledger and call it a complete history.
function classify(errors) {
  const joined = errors.join(' ');
  if (/Rate limit exceeded|EService:\s*Throttled/i.test(joined)) return 'KRAKEN_RATE_LIMITED';
  if (/Invalid key|Invalid signature|Permission denied|Temporary lockout|Invalid nonce/i.test(joined)) {
    return 'KRAKEN_AUTH_FAILED';
  }
  return 'KRAKEN_API_ERROR';
}

/**
 * Signature for a private request.
 *
 * API-Sign = base64( HMAC-SHA512( base64decode(secret),
 *                                 uriPath || SHA256(nonce || postData) ) )
 *
 * https://docs.kraken.com/api/docs/guides/spot-rest-auth -- "HMAC-SHA512 of
 * (URI path + SHA256(nonce + POST data)) and base64 decoded secret API key".
 *
 * Two details the formula hides and a re-implementation gets wrong:
 *   - `postData` is the urlencoded body EXACTLY as it goes on the wire, and it
 *     already begins with nonce=..., so the nonce appears twice in the SHA256
 *     input. The string signed and the string sent must be byte-identical.
 *   - the SHA256 digest is concatenated as RAW BYTES, not hex. Kraken's own
 *     Node sample routes it through a latin1 string; Buffer.concat says the
 *     same thing without the encoding hazard.
 *
 * Verified against the worked example published on that page (nonce
 * 1616492376594, /0/private/AddOrder) -- see tests/exchangeSync.test.js.
 */
function sign(uriPath, postData, apiSecret) {
  const nonce = new URLSearchParams(postData).get('nonce');
  if (!nonce) throw new Error('Kraken request signing requires a nonce in the POST data');
  const hashed = crypto.createHash('sha256').update(nonce + postData, 'utf8').digest();
  const message = Buffer.concat([Buffer.from(uriPath, 'utf8'), hashed]);
  return crypto
    .createHmac('sha512', Buffer.from(apiSecret, 'base64'))
    .update(message)
    .digest('base64');
}

// The exact body that gets signed and sent. URLSearchParams preserves
// insertion order, and nonce goes first because the signature prepends it.
function encodeBody(nonce, params) {
  const body = new URLSearchParams();
  body.set('nonce', nonce);
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue;
    body.set(key, String(value));
  }
  return body.toString();
}

class KrakenClient {
  constructor({ apiKey, apiSecret }) {
    if (!apiKey || !apiSecret) {
      const error = new Error('Kraken API key and private key are both required');
      error.code = 'EXCHANGE_NOT_CONFIGURED';
      throw error;
    }
    this.apiKey = apiKey;
    this.apiSecret = apiSecret;
  }

  static get ALLOWED_ENDPOINTS() { return ALLOWED_ENDPOINTS; }

  // Exposed for the signing test: the algorithm is the part a mistake makes
  // undebuggable (every call returns EAPI:Invalid signature and nothing says
  // which of the four steps was wrong).
  static sign(uriPath, postData, apiSecret) { return sign(uriPath, postData, apiSecret); }
  static encodeBody(nonce, params) { return encodeBody(nonce, params); }

  async request(endpoint, params = {}) {
    if (!ALLOWED_ENDPOINTS.has(endpoint)) {
      // Not a validation nicety: this is the line that makes "read-only" a
      // property of the code rather than a property of the user's key.
      throw new Error(`Kraken endpoint ${endpoint} is not a read endpoint this app may call`);
    }
    const state = stateFor(this.apiKey);
    // One request at a time per key: the nonce must strictly increase, and
    // Kraken rejects the whole request when it does not.
    const run = state.queue.then(
      () => this._send(state, endpoint, params),
      () => this._send(state, endpoint, params)
    );
    state.queue = run.then(() => undefined, () => undefined);
    return run;
  }

  async _send(state, endpoint, params, attempt = 0) {
    const uriPath = `/0/private/${endpoint}`;
    await spendCounter(state, EXPENSIVE_ENDPOINTS.has(endpoint) ? 2 : 1);

    const postData = encodeBody(nextNonce(state), params);
    let response;
    try {
      response = await axios.post(`${BASE_URL}${uriPath}`, postData, {
        timeout: TIMEOUT_MS,
        headers: {
          'API-Key': this.apiKey,
          'API-Sign': sign(uriPath, postData, this.apiSecret),
          'Content-Type': 'application/x-www-form-urlencoded; charset=utf-8',
          'User-Agent': 'my-money-tracker/1.0',
        },
        // 5xx and 429 come back as exceptions; everything else is inspected.
        validateStatus: (status) => status >= 200 && status < 500,
      });
    } catch (err) {
      if (attempt < RATE_LIMIT_BACKOFF_MS.length) {
        await sleep(RATE_LIMIT_BACKOFF_MS[attempt]);
        return this._send(state, endpoint, params, attempt + 1);
      }
      // The raw AxiosError carries the signed request on `config.headers`:
      // API-Key and API-Sign, in the clear, on an object pino serializes whole.
      throw scrubHttpError(err);
    }

    const body = response.data || {};
    const errors = Array.isArray(body.error) ? body.error : [];
    if (errors.length > 0) {
      const code = classify(errors);
      if (code === 'KRAKEN_RATE_LIMITED' && attempt < RATE_LIMIT_BACKOFF_MS.length) {
        logger.warn({ endpoint, attempt }, 'Kraken rate limited; backing off');
        // Kraken's counter is server-side and ours has clearly drifted low.
        // Pushing it to the cap makes the next call wait the full decay.
        state.counter = COUNTER_MAX;
        state.updatedAt = Date.now();
        await sleep(RATE_LIMIT_BACKOFF_MS[attempt]);
        return this._send(state, endpoint, params, attempt + 1);
      }
      throw krakenError(errors, { code });
    }
    // `result` may be absent on a rejected request even with an empty error
    // array; an undefined result must not read as an empty ledger.
    if (body.result === undefined || body.result === null) {
      throw krakenError(['Kraken returned no result'], { code: 'KRAKEN_API_ERROR' });
    }
    return body.result;
  }

  // Smallest authenticated read there is, and the one the Test Connection
  // button calls: it proves the key, the signature and the Query Funds
  // permission in a single request without touching any history.
  // https://docs.kraken.com/api/docs/rest-api/get-account-balance
  async getBalance() {
    const result = await this.request('Balance');
    if (typeof result !== 'object' || Array.isArray(result)) {
      throw krakenError(['Balance returned an unexpected shape']);
    }
    return result;
  }
}

module.exports = KrakenClient;
module.exports.BASE_URL = BASE_URL;
module.exports.COUNTER_MAX = COUNTER_MAX;
module.exports._resetKeyState = () => keyState.clear();
module.exports._setPacingForTests = (enabled) => { pacingEnabled = enabled; };

'use strict';

const crypto = require('crypto');
const axios = require('axios');
const logger = require('../../config/logger');
const scrubHttpError = require('../../utils/scrubHttpError');

// Coinbase App / Advanced Trade REST client. READ ENDPOINTS ONLY -- every
// request goes through get(), and there is no post/put/delete on this class.
//
// Docs consulted at implementation time (2026-07):
//   CDP key auth ... https://docs.cdp.coinbase.com/coinbase-app/authentication-authorization/api-key-authentication
//   JWT (general) .. https://docs.cdp.coinbase.com/get-started/authentication/jwt-authentication
//   Advanced Trade . https://docs.cdp.coinbase.com/coinbase-app/advanced-trade-apis/rest-api
//   List Accounts .. https://docs.cdp.coinbase.com/api-reference/advanced-trade-api/rest-api/accounts/list-accounts
//   List Fills ..... https://docs.cdp.coinbase.com/api-reference/advanced-trade-api/rest-api/orders/list-fills
//   v2 accounts .... https://docs.cdp.coinbase.com/coinbase-app/track-apis/accounts
//   v2 transactions  https://docs.cdp.coinbase.com/coinbase-app/track-apis/transactions
//   v2 pagination .. https://docs.cdp.coinbase.com/coinbase-app/api-architecture/pagination
//   v2 errors ...... https://docs.cdp.coinbase.com/coinbase-app/api-architecture/error-messages
//   rate limiting .. https://docs.cdp.coinbase.com/coinbase-app/api-architecture/rate-limiting

const HOST = 'api.coinbase.com';
const BASE_URL = `https://${HOST}`;
const TIMEOUT_MS = 20000;

// "By default, each API key or OAuth-authenticated Coinbase user is rate
// limited to 10,000 requests per hour."
// -- https://docs.cdp.coinbase.com/coinbase-app/api-architecture/rate-limiting
// That is ~2.8/sec sustained. No per-second figure is published for Advanced
// Trade REST any more (the page 404s and is absent from the sitemap), so this
// is the documented ceiling to code against rather than a remembered one.
const MIN_REQUEST_INTERVAL_MS = 360;

// "Your JWT expires after 2 minutes" and "You must generate a different JWT
// for each unique API request."
const JWT_TTL_SECONDS = 120;

// How far `nbf` is backdated against clock skew. See buildJwt.
const CLOCK_SKEW_LEEWAY_SECONDS = 30;

// Every path this app is allowed to reach. A prefix list rather than a
// per-request judgement call: the tracker must never be able to place an order
// or move funds, whatever the stored key is permitted to do. /v2/accounts/…
// POST is Coinbase's Send Money endpoint, which is exactly why only GET exists
// on this client.
const ALLOWED_PATH_PREFIXES = [
  '/api/v3/brokerage/accounts',
  '/api/v3/brokerage/orders/historical/fills',
  '/v2/accounts',
];

// A 429 is a provider-wide budget signal, not a transient socket hiccup.
// Retry progressively and honor Retry-After when Coinbase supplies it. The
// backfill worker adds a durable, longer pause after these in-request retries
// are exhausted, so a process restart cannot turn the same limit into a hot
// loop.
const RETRY_BACKOFF_MS = [1000, 4000, 12000, 30000, 60000];

const lastRequestAt = new Map();

// Set only by tests, for the same reason as the Kraken client's: a paginated
// walk paced at the documented request ceiling spends its whole runtime
// asleep. Off is never the default, and nothing in src/ turns it off. It also
// short-circuits the retry backoff, so a test that exercises a transport
// failure does not spend five seconds asleep proving it.
let pacingEnabled = true;

const sleep = (ms) => (pacingEnabled ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve());

function base64url(input) {
  return Buffer.from(input).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function coinbaseError(message, { code = 'COINBASE_API_ERROR', status } = {}) {
  const error = new Error(`Coinbase error: ${message}`);
  error.code = code;
  error.httpStatus = status;
  return error;
}

function parseRetryAfter(value) {
  if (value === undefined || value === null || value === '') return 0;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, Math.round(seconds * 1000));
  const timestamp = Date.parse(String(value));
  return Number.isFinite(timestamp) ? Math.max(0, timestamp - Date.now()) : 0;
}

// Three different error envelopes are in play and only two are documented
// together: v2 answers {errors:[{id,message}]}, v3 answers the gRPC-gateway
// {error, code, message, details}, and the OAuth token endpoints answer
// {error, error_description}. Reading only one of them turns a permission
// problem into "undefined".
function describeError(status, body) {
  if (body && Array.isArray(body.errors) && body.errors.length) {
    const first = body.errors[0];
    return { id: first.id || null, message: first.message || first.id || 'request failed' };
  }
  if (body && typeof body === 'object') {
    const message = body.message || body.error_description || body.error;
    if (message) return { id: body.error || null, message: String(message) };
  }
  return { id: null, message: `HTTP ${status}` };
}

function classify(status, id) {
  if (status === 401 || status === 403) return 'COINBASE_AUTH_FAILED';
  if (status === 429) return 'COINBASE_RATE_LIMITED';
  if (['authentication_error', 'invalid_token', 'expired_token', 'revoked_token', 'invalid_scope', 'unauthorized']
    .includes(id)) {
    return 'COINBASE_AUTH_FAILED';
  }
  if (['rate_limit_exceeded', 'resource_exhausted'].includes(id)) return 'COINBASE_RATE_LIMITED';
  return 'COINBASE_API_ERROR';
}

/**
 * A CDP secret API key, as downloaded from the Coinbase developer portal.
 *
 * The docs are emphatic that the Coinbase App / Advanced Trade surface takes
 * ECDSA (P-256) keys only:
 *
 *   "When using Coinbase App SDKs, Ed25519 (EdDSA) keys are NOT supported.
 *    You must use ES256 key format."
 *   -- https://docs.cdp.coinbase.com/coinbase-app/authentication-authorization/api-key-authentication
 *
 * An Ed25519 key downloads as bare base64 rather than PEM, so the two are told
 * apart by the PEM armor. Naming the mismatch here is worth a lot: signed with
 * the wrong algorithm the request just returns 401, which reads as "bad key"
 * and sends the user to regenerate the same unusable key again.
 */
function parsePrivateKey(secret) {
  const text = String(secret || '').trim();
  if (!text) throw coinbaseError('the CDP private key is empty', { code: 'EXCHANGE_NOT_CONFIGURED' });
  // The portal hands out a JSON blob whose privateKey field has literal \n.
  const pem = text.replace(/\\n/g, '\n');
  if (!pem.includes('-----BEGIN')) {
    throw coinbaseError(
      'this looks like an Ed25519 key. Coinbase App and Advanced Trade require an ECDSA key '
      + '(the PEM one beginning "-----BEGIN EC PRIVATE KEY-----"); regenerate the key and choose ECDSA.',
      { code: 'COINBASE_KEY_FORMAT' }
    );
  }
  try {
    return crypto.createPrivateKey(pem);
  } catch (err) {
    throw coinbaseError(`the CDP private key could not be read (${err.message})`, { code: 'COINBASE_KEY_FORMAT' });
  }
}

/**
 * ES256 JWT, per the Coinbase App auth page's own JavaScript sample.
 *
 *   header  { alg: 'ES256', typ: 'JWT', kid: <key name>, nonce: <random hex> }
 *   payload { iss: 'cdp', sub: <key name>, nbf: now - 30, exp: now + 120,
 *             uri: '<METHOD> <host><path>' }
 *
 * `nbf` is backdated 30 seconds because it has no leeway otherwise: a server
 * clock a second or two ahead of Coinbase's makes every token not-yet-valid,
 * which arrives as the same opaque 401 a bad key does. `exp` still counts from
 * the real issue time, so the token's life is shortened by the skew allowance
 * rather than extended past the documented 2 minutes.
 *
 * Three details that are easy to get wrong and all produce the same opaque 401:
 *   - the nonce lives in the HEADER, not the claims;
 *   - `iss` is 'cdp'. The C# sample on that same page still says
 *     'coinbase-cloud'; every other sample, and the JS one this follows, says
 *     'cdp';
 *   - `uri` is "METHOD host+path" with NO scheme and NO query string, so a
 *     paginated request signs the bare path and appends its query separately.
 *
 * Signed with node's crypto rather than a JWT library: ES256's JOSE encoding
 * is the raw r||s pair, which is exactly what dsaEncoding 'ieee-p1363' emits.
 * DER (node's default) would be rejected.
 */
function buildJwt({ keyName, privateKey, method, path, nowSeconds }) {
  const issuedAt = nowSeconds ?? Math.floor(Date.now() / 1000);
  const header = {
    alg: 'ES256',
    typ: 'JWT',
    kid: keyName,
    nonce: crypto.randomBytes(16).toString('hex'),
  };
  const payload = {
    iss: 'cdp',
    sub: keyName,
    nbf: issuedAt - CLOCK_SKEW_LEEWAY_SECONDS,
    exp: issuedAt + JWT_TTL_SECONDS,
    uri: `${method} ${HOST}${path}`,
  };
  const signingInput = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(payload))}`;
  const signature = crypto.sign('sha256', Buffer.from(signingInput), {
    key: privateKey,
    dsaEncoding: 'ieee-p1363',
  });
  return `${signingInput}.${base64url(signature)}`;
}

class CoinbaseClient {
  constructor({ apiKey, apiSecret }) {
    if (!apiKey || !apiSecret) {
      const error = new Error('Coinbase key name and private key are both required');
      error.code = 'EXCHANGE_NOT_CONFIGURED';
      throw error;
    }
    this.keyName = String(apiKey).trim();
    this.privateKey = parsePrivateKey(apiSecret);
  }

  static get ALLOWED_PATH_PREFIXES() { return ALLOWED_PATH_PREFIXES; }

  // Exposed for the JWT shape test: header/claims are the part that fails
  // silently as a 401 with nothing to debug against.
  static buildJwt(options) { return buildJwt(options); }
  static parsePrivateKey(secret) { return parsePrivateKey(secret); }

  _authorize(method, path) {
    if (!ALLOWED_PATH_PREFIXES.some((prefix) => path === prefix || path.startsWith(`${prefix}/`)
      || path.startsWith(`${prefix}?`))) {
      throw new Error(`Coinbase path ${path} is not a read endpoint this app may call`);
    }
    return buildJwt({ keyName: this.keyName, privateKey: this.privateKey, method, path });
  }

  /**
   * GET only, by design. `path` must carry no query string -- the JWT signs
   * the bare path, so the query rides in `params` and is appended after.
   */
  async get(path, params = {}, attempt = 0) {
    const since = Date.now() - (lastRequestAt.get(this.keyName) || 0);
    if (pacingEnabled && since < MIN_REQUEST_INTERVAL_MS) await sleep(MIN_REQUEST_INTERVAL_MS - since);
    lastRequestAt.set(this.keyName, Date.now());

    let response;
    try {
      response = await axios.get(`${BASE_URL}${path}`, {
        timeout: TIMEOUT_MS,
        params,
        headers: {
          Authorization: `Bearer ${this._authorize('GET', path)}`,
          // Both endpoints declare a text/event-stream variant alongside JSON;
          // asking for JSON explicitly keeps a streaming response from
          // arriving as an unparseable string.
          Accept: 'application/json',
          'User-Agent': 'my-money-tracker/1.0',
        },
        validateStatus: (status) => status >= 200 && status < 500,
      });
    } catch (err) {
      if (attempt < RETRY_BACKOFF_MS.length) {
        await sleep(RETRY_BACKOFF_MS[attempt]);
        return this.get(path, params, attempt + 1);
      }
      // The raw AxiosError carries `Authorization: Bearer <jwt>` on
      // config.headers, and pino's err serializer copies it verbatim.
      throw scrubHttpError(err);
    }

    if (response.status >= 400) {
      const { id, message } = describeError(response.status, response.data);
      const code = classify(response.status, id);
      if (code === 'COINBASE_RATE_LIMITED' && attempt < RETRY_BACKOFF_MS.length) {
        const retryAfterMs = parseRetryAfter(response.headers?.['retry-after']);
        const delayMs = Math.max(RETRY_BACKOFF_MS[attempt], retryAfterMs);
        logger.warn({ path, attempt, delayMs }, 'Coinbase rate limited; backing off');
        await sleep(delayMs);
        return this.get(path, params, attempt + 1);
      }
      const error = coinbaseError(message, { code, status: response.status });
      if (code === 'COINBASE_RATE_LIMITED') {
        error.retryAfterMs = Math.max(
          RETRY_BACKOFF_MS[Math.min(attempt, RETRY_BACKOFF_MS.length - 1)],
          parseRetryAfter(response.headers?.['retry-after'])
        );
      }
      throw error;
    }
    return response.data;
  }

  // The Test Connection probe: the smallest authenticated read on the
  // Advanced Trade surface, which proves the key name, the ES256 signature and
  // the `view` permission without touching any history.
  // https://docs.cdp.coinbase.com/api-reference/advanced-trade-api/rest-api/accounts/list-accounts
  async listBrokerageAccounts({ limit = 250, cursor } = {}) {
    const body = await this.get('/api/v3/brokerage/accounts', cursor ? { limit, cursor } : { limit });
    if (!body || !Array.isArray(body.accounts)) {
      throw coinbaseError('the accounts list came back in an unexpected shape');
    }
    return body;
  }
}

module.exports = CoinbaseClient;
module.exports.HOST = HOST;
module.exports.JWT_TTL_SECONDS = JWT_TTL_SECONDS;
module.exports.CLOCK_SKEW_LEEWAY_SECONDS = CLOCK_SKEW_LEEWAY_SECONDS;
module.exports.RETRY_BACKOFF_MS = RETRY_BACKOFF_MS;
module.exports._resetRateState = () => lastRequestAt.clear();
module.exports._setPacingForTests = (enabled) => { pacingEnabled = enabled; };

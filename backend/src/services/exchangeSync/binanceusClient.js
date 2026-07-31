'use strict';

const crypto = require('crypto');
const axios = require('axios');
const logger = require('../../config/logger');
const scrubHttpError = require('../../utils/scrubHttpError');

// Binance.US Exchange API. This client deliberately exposes only GET
// endpoints used for history and balances. No order, withdrawal, transfer, or
// staking mutation endpoint is reachable through this class, even if a user
// accidentally grants those permissions to the key.
const BASE_URL = 'https://api.binance.us';
const TIMEOUT_MS = 20000;
const RECV_WINDOW = 5000;
const MIN_REQUEST_INTERVAL_MS = 150;

const ALLOWED_ENDPOINTS = new Set([
  '/api/v3/account',
  '/api/v3/exchangeInfo',
  '/api/v3/myTrades',
  '/sapi/v1/capital/config/getall',
  '/sapi/v1/capital/deposit/hisrec',
  '/sapi/v1/capital/withdraw/history',
  '/sapi/v1/asset/assetDistributionHistory',
  '/sapi/v1/asset/query/dust-logs',
  '/sapi/v1/fiatpayment/query/deposit/history',
  '/sapi/v1/fiatpayment/query/withdraw/history',
  '/sapi/v1/staking/history',
  '/sapi/v1/staking/stakingRewardsHistory',
]);

const RETRY_BACKOFF_MS = [500, 2000, 5000, 15000, 30000];
const RATE_LIMIT_RE = /rate|too many|429|418|1003|1015/i;
const keyState = new Map();
let pacingEnabled = true;

const sleep = (ms) => (pacingEnabled
  ? new Promise((resolve) => setTimeout(resolve, ms))
  : Promise.resolve());

function encodeParams(params) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params || {})) {
    if (value === undefined || value === null || value === '') continue;
    if (Array.isArray(value)) {
      for (const item of value) query.append(key, String(item));
    } else {
      query.set(key, String(value));
    }
  }
  return query.toString();
}

function sign(query, secret) {
  return crypto.createHmac('sha256', String(secret)).update(query, 'utf8').digest('hex');
}

function binanceError(status, body) {
  const code = Number.isFinite(Number(body?.code)) ? Number(body.code) : null;
  const message = body?.msg || body?.message || `HTTP ${status}`;
  let errorCode = 'BINANCE_US_API_ERROR';
  if (status === 401 || status === 403 || [-1002, -1022, -2014, -2015].includes(code)) {
    errorCode = 'BINANCE_US_AUTH_FAILED';
  } else if (status === 429 || status === 418 || RATE_LIMIT_RE.test(`${code ?? ''} ${message}`)) {
    errorCode = 'BINANCE_US_RATE_LIMITED';
  }
  const error = new Error(`Binance.US error: ${message}`);
  error.code = errorCode;
  error.httpStatus = status;
  error.binanceCode = code;
  return error;
}

function stateFor(apiKey) {
  let state = keyState.get(apiKey);
  if (!state) {
    state = { queue: Promise.resolve(), lastRequestAt: 0 };
    keyState.set(apiKey, state);
  }
  return state;
}

class BinanceUSClient {
  constructor({ apiKey, apiSecret }) {
    if (!apiKey || !apiSecret) {
      const error = new Error('Binance.US API key and secret are both required');
      error.code = 'EXCHANGE_NOT_CONFIGURED';
      throw error;
    }
    this.apiKey = String(apiKey).trim();
    this.apiSecret = String(apiSecret).trim();
  }

  static encodeParams(params) { return encodeParams(params); }
  static sign(query, secret) { return sign(query, secret); }

  async get(path, params = {}, { signed = true, attempt = 0 } = {}) {
    if (!ALLOWED_ENDPOINTS.has(path)) {
      throw new Error(`Binance.US endpoint ${path} is not a read endpoint this app may call`);
    }
    const state = stateFor(this.apiKey);
    const run = state.queue.then(
      () => this._send(state, path, params, { signed, attempt }),
      () => this._send(state, path, params, { signed, attempt })
    );
    state.queue = run.then(() => undefined, () => undefined);
    return run;
  }

  async _send(state, path, params, { signed, attempt }) {
    const now = Date.now();
    const wait = Math.max(0, MIN_REQUEST_INTERVAL_MS - (now - state.lastRequestAt));
    await sleep(wait);
    state.lastRequestAt = Date.now();

    const requestParams = signed
      ? { ...params, recvWindow: params.recvWindow ?? RECV_WINDOW, timestamp: Date.now() }
      : { ...params };
    let query = encodeParams(requestParams);
    if (signed) query = `${query}&signature=${sign(query, this.apiSecret)}`;

    let response;
    try {
      response = await axios.get(`${BASE_URL}${path}${query ? `?${query}` : ''}`, {
        timeout: TIMEOUT_MS,
        headers: {
          'X-MBX-APIKEY': this.apiKey,
          Accept: 'application/json',
          'User-Agent': 'my-money-tracker/1.0',
        },
        validateStatus: (status) => status >= 200 && status < 500,
      });
    } catch (err) {
      if (attempt < RETRY_BACKOFF_MS.length) {
        await sleep(RETRY_BACKOFF_MS[attempt]);
        return this._send(state, path, params, { signed, attempt: attempt + 1 });
      }
      throw scrubHttpError(err);
    }

    const body = response.data;
    if (response.status >= 400 || (body && !Array.isArray(body) && body.code !== undefined && Number(body.code) < 0)) {
      const error = binanceError(response.status, body);
      if (error.code === 'BINANCE_US_RATE_LIMITED' && attempt < RETRY_BACKOFF_MS.length) {
        logger.warn({ path, attempt }, 'Binance.US rate limited; backing off');
        await sleep(RETRY_BACKOFF_MS[attempt]);
        return this._send(state, path, params, { signed, attempt: attempt + 1 });
      }
      if (error.code === 'BINANCE_US_RATE_LIMITED') {
        error.retryAfterMs = RETRY_BACKOFF_MS[Math.min(attempt, RETRY_BACKOFF_MS.length - 1)];
      }
      throw error;
    }
    return body;
  }

  async getAccount() {
    const body = await this.get('/api/v3/account');
    if (!body || !Array.isArray(body.balances)) {
      throw binanceError(200, { msg: 'account returned an unexpected shape' });
    }
    return body;
  }

  async getExchangeInfo() {
    const body = await this.get('/api/v3/exchangeInfo', {}, { signed: false });
    if (!body || !Array.isArray(body.symbols)) {
      throw binanceError(200, { msg: 'exchangeInfo returned an unexpected shape' });
    }
    return body;
  }
}

module.exports = BinanceUSClient;
module.exports.BASE_URL = BASE_URL;
module.exports.RECV_WINDOW = RECV_WINDOW;
module.exports.MIN_REQUEST_INTERVAL_MS = MIN_REQUEST_INTERVAL_MS;
module.exports._resetKeyState = () => keyState.clear();
module.exports._setPacingForTests = (enabled) => { pacingEnabled = enabled; };

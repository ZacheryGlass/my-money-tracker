'use strict';

const crypto = require('node:crypto');
const JSONbig = require('json-bigint')({ useNativeBigInt: true });
const { sha256, stableJson } = require('./normalizer');

// CDP's address-history JSON-RPC endpoint is network-scoped. The client API
// key is deliberately kept only in this instance; it is never part of a
// persisted request parameter object or an error message.
const ROOT = 'https://api.developer.coinbase.com/rpc/v1/base';
const DEFAULT_SPACING_MS = 25;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const MAX_INLINE_RETRY_MS = 30_000;
const MAX_ATTEMPTS = 3;
const MAX_PAGES = 100_000;
const MAX_PAGE_SIZE = 100;
const queues = new Map();

function providerError(message, code, extra = {}) {
  const error = new Error(message);
  error.code = code;
  Object.assign(error, extra);
  return error;
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseRetryAfter(value) {
  if (!value) return null;
  if (/^\d+(?:\.\d+)?$/.test(value)) return Math.ceil(Number(value) * 1000);
  const at = Date.parse(value);
  return Number.isFinite(at) ? Math.max(0, at - Date.now()) : null;
}

function normalizeJsonNumbers(value) {
  if (typeof value === 'bigint') return value.toString();
  if (Array.isArray(value)) return value.map(normalizeJsonNumbers);
  if (!value || typeof value !== 'object') return value;
  const normalized = {};
  const numericFields = [];
  for (const [key, child] of Object.entries(value)) {
    if (typeof child === 'bigint') {
      normalized[key] = child.toString();
      numericFields.push(key);
    } else {
      normalized[key] = normalizeJsonNumbers(child);
    }
  }
  if (numericFields.length) normalized.__evm_json_numeric_fields = numericFields;
  return normalized;
}

function isQuotaError(detail, code = '') {
  return /(?:quota|credit|billing|usage).*(?:exhaust|limit|exceed)|(?:exhaust|limit|exceed).*(?:quota|credit|billing|usage)/i.test(detail)
    || /quota|credit|billing|usage[_ -]?(?:limit|exhausted|exceeded)/i.test(String(code || ''));
}

function nextCalendarMonth() {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1, 0, 0, 0));
}

function resultError(body) {
  const result = body?.result;
  if (!result || typeof result !== 'object' || Array.isArray(result)) return null;
  const code = typeof result.code === 'string' ? result.code.trim() : '';
  const detail = [result.message, result.details]
    .filter((value) => typeof value === 'string' && value.trim())
    .join(': ');
  if (!code && !detail) return null;
  return { code: code || null, detail: detail || code };
}

function redactSecret(value, apiKey) {
  if (!apiKey) return value;
  if (typeof value === 'string') return value.split(String(apiKey)).join('[redacted]');
  if (Array.isArray(value)) return value.map((child) => redactSecret(child, apiKey));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [
    redactSecret(key, apiKey), redactSecret(child, apiKey),
  ]));
}

function safeDetail(value, apiKey) {
  const detail = String(redactSecret(value, apiKey) || '').replace(/\s+/g, ' ').trim();
  return detail.slice(0, 500);
}

function responseError(response, body, method, apiKey = null) {
  const resultFailure = resultError(body);
  const detail = safeDetail(
    resultFailure?.detail || body?.error?.message || body?.message || '', apiKey
  );
  const resultCode = String(resultFailure?.code || '').toLowerCase();
  const bodyErrorCode = String(body?.error?.code || '').toLowerCase();
  const authFailure = /unauthorized|unauthenticated|forbidden|invalid.{0,20}(?:key|credential)|permission/i.test(detail)
    || /unauthoriz|unauthenticated|forbidden|permission/.test(resultCode);
  const rateFailure = /rate.?limit|too many requests|slow down/i.test(detail)
    || /rate|throttl|resource[_ -]?exhausted|resource[_ -]?limit/.test(resultCode);
  const bodyRateFailure = /rate|throttl|resource[_ -]?exhausted|resource[_ -]?limit/.test(bodyErrorCode);
  const quotaFailure = isQuotaError(detail, resultCode)
    || (body?.error && isQuotaError(detail, bodyErrorCode));
  if (response.status === 429) {
    const retryAfterMs = parseRetryAfter(response.headers.get('retry-after')) ?? 5_000;
    return providerError('Coinbase CDP rate limit reached; Base history deferred', 'CDP_RATE_LIMITED', {
      httpStatus: response.status,
      retryAfterMs,
      retryAt: new Date(Date.now() + retryAfterMs),
    });
  }
  if (quotaFailure) {
    return providerError('Coinbase CDP usage limit reached; Base history deferred', 'CDP_QUOTA_EXHAUSTED', {
      httpStatus: response.status,
      // CDP Node's free billing-unit allowance is documented as a calendar-
      // month allowance. A portal/account-specific quota may differ, so the
      // UI still displays this as a provider retry boundary, not a promise
      // that all credits reset after 24 hours.
      retryAt: nextCalendarMonth(),
    });
  }
  if ((resultFailure && rateFailure) || (body?.error && bodyRateFailure)) {
    return providerError('Coinbase CDP rate limit reached; Base history deferred', 'CDP_RATE_LIMITED', {
      httpStatus: response.status,
      retryAfterMs: 5_000,
      retryAt: new Date(Date.now() + 5_000),
    });
  }
  if ([401, 403].includes(response.status)) {
    return providerError('Coinbase CDP rejected the configured credential', 'CDP_AUTH_FAILED', {
      httpStatus: response.status,
    });
  }
  if (resultFailure && authFailure) {
    return providerError('Coinbase CDP rejected the configured credential', 'CDP_AUTH_FAILED', {
      httpStatus: response.status,
    });
  }
  if (resultFailure) {
    return providerError(
      `Coinbase CDP ${method} returned an error${detail ? `: ${detail}` : ''}`,
      'CDP_API_ERROR',
      { httpStatus: response.status }
    );
  }
  if (body?.error) {
    if (authFailure || /unauthoriz|unauthenticated|forbidden|permission/.test(bodyErrorCode)) {
      return providerError('Coinbase CDP rejected the configured credential', 'CDP_AUTH_FAILED', {
        httpStatus: response.status,
      });
    }
    return providerError(
      `Coinbase CDP ${method} returned an error${detail ? `: ${detail}` : ''}`,
      'CDP_API_ERROR',
      { httpStatus: response.status }
    );
  }
  return providerError(
    `Coinbase CDP ${method} returned HTTP ${response.status}${detail ? `: ${detail}` : ''}`,
    'CDP_API_ERROR',
    { httpStatus: response.status }
  );
}

function pageCursor(value, method) {
  if (value == null || value === '') return null;
  if (typeof value !== 'string') {
    throw providerError(
      `Coinbase CDP ${method} returned an invalid page cursor`,
      'CDP_INVALID_RESPONSE'
    );
  }
  return value;
}

function resultShape(value) {
  if (value == null) return value === null ? 'null' : 'missing';
  if (Array.isArray(value)) return `array(${value.length})`;
  if (typeof value !== 'object') return typeof value;
  const keys = Object.keys(value).sort();
  return keys.length ? `object{${keys.slice(0, 20).join(',')}}` : 'object{}';
}

function collectionFromResult(response, preferred, aliases, method) {
  const result = response.body;
  const candidates = [preferred, ...aliases];
  const present = candidates.filter((key) => Array.isArray(result?.[key]));
  if (present.length > 1) {
    const first = stableJson(result[present[0]]);
    if (present.slice(1).some((key) => stableJson(result[key]) !== first)) {
      throw providerError(
        `Coinbase CDP ${method} returned conflicting result collections (${present.join(',')})`,
        'CDP_CONFLICTING_RESULT'
      );
    }
  }
  if (present.length) return result[present[0]];
  throw providerError(
    `Coinbase CDP ${method} returned an invalid result shape (${resultShape(result)})`,
    'CDP_INVALID_RESPONSE'
  );
}

function addressTransactionItems(result) {
  return collectionFromResult(
    { body: result }, 'addressTransactions', ['transactions'], 'address history'
  );
}

class CdpClient {
  constructor(apiKey, {
    spacingMs = DEFAULT_SPACING_MS,
    requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
    requestTimeoutGraceMs = 1000,
    maxAttempts = MAX_ATTEMPTS,
    baseUrl = ROOT,
    onFailedAttempt = null,
  } = {}) {
    if (!apiKey) throw providerError('Coinbase CDP Client API key is not configured', 'CDP_NOT_CONFIGURED');
    this.apiKey = apiKey;
    this.spacingMs = spacingMs;
    this.requestTimeoutMs = requestTimeoutMs;
    this.requestTimeoutGraceMs = requestTimeoutGraceMs;
    this.maxAttempts = maxAttempts;
    this.baseUrl = String(baseUrl).replace(/\/$/, '');
    this.onFailedAttempt = onFailedAttempt;
    this.queueKey = crypto.createHash('sha256').update(apiKey).digest('hex');
  }

  async _scheduled(task) {
    const previous = queues.get(this.queueKey) || Promise.resolve();
    const run = previous.catch(() => {}).then(async () => {
      await wait(this.spacingMs);
      return task();
    });
    const queued = run.catch(() => {}).finally(() => {
      if (queues.get(this.queueKey) === queued) queues.delete(this.queueKey);
    });
    queues.set(this.queueKey, queued);
    return run;
  }

  async _request(method, params, endpoint = method) {
    return this._scheduled(async () => {
      const url = `${this.baseUrl}/${encodeURIComponent(this.apiKey)}`;
      for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
        let response;
        let text;
        let timedOut = false;
        try {
          const controller = new AbortController();
          let timeout;
          const request = (async () => {
            const result = await fetch(url, {
              method: 'POST',
              headers: { 'content-type': 'application/json', accept: 'application/json' },
              body: JSON.stringify({
                jsonrpc: '2.0', id: 1, method,
                params: [{ ...params, pageSize: Math.min(MAX_PAGE_SIZE, Number(params.pageSize || MAX_PAGE_SIZE)) }],
              }),
              signal: controller.signal,
            });
            return { response: result, text: await result.text() };
          })();
          request.catch(() => {});
          try {
            ({ response, text } = await Promise.race([
              request,
              new Promise((_, reject) => {
                timeout = setTimeout(() => {
                  timedOut = true;
                  controller.abort();
                  reject(providerError(`Coinbase CDP ${endpoint} request exceeded its deadline`, 'CDP_TRANSPORT_ERROR'));
                }, this.requestTimeoutMs + this.requestTimeoutGraceMs);
              }),
            ]));
          } finally {
            clearTimeout(timeout);
          }
        } catch {
          await this.onFailedAttempt?.({
            provider: 'coinbase-cdp', endpoint, method: 'POST', attemptNo: attempt,
            requestParams: params, outcome: attempt < this.maxAttempts && !timedOut ? 'deferred' : 'failed',
            errorCode: 'CDP_TRANSPORT_ERROR', errorDetail: 'Network request failed before a response.',
          });
          if (attempt < this.maxAttempts && !timedOut) {
            await wait(500 * (2 ** (attempt - 1)));
            continue;
          }
          // Do not attach the fetch error as `cause`: some HTTP clients include
          // the request URL in a transport error, and this URL contains the
          // Client API key. The retained provider-attempt detail is deliberately
          // generic for the same reason.
          throw providerError(`Coinbase CDP ${endpoint} request failed`, 'CDP_TRANSPORT_ERROR');
        }

        let body;
        try { body = normalizeJsonNumbers(JSONbig.parse(text)); } catch {
          body = null;
        }
        const hasResult = body && typeof body === 'object' && !Array.isArray(body)
          && body.result != null;
        const resultFailure = resultError(body);
        // Do not accept a malformed JSON-RPC envelope that contains both an
        // error and a result. A partial result paired with an error is not a
        // proven page and must not advance a durable cursor.
        if (response.ok && hasResult && !body.error && !resultFailure) {
          return {
            body: body.result,
            rawText: text,
            responseSha256: sha256(text),
            requestId: response.headers.get('x-request-id') || null,
          };
        }

        const error = responseError(response, body, method, this.apiKey);
        const retryable = error.code === 'CDP_RATE_LIMITED' && attempt < this.maxAttempts;
        const responseRaw = redactSecret(text, this.apiKey);
        await this.onFailedAttempt?.({
          provider: 'coinbase-cdp', endpoint, method: 'POST', attemptNo: attempt,
          requestParams: params, outcome: retryable || error.code === 'CDP_QUOTA_EXHAUSTED' ? 'deferred' : 'failed',
          httpStatus: error.httpStatus || response.status,
          errorCode: error.code, errorDetail: error.message,
          requestId: response.headers.get('x-request-id') || null,
          responseSha256: sha256(responseRaw),
          responseRaw,
          responseJson: redactSecret(body, this.apiKey),
        });
        if (retryable && error.retryAfterMs <= MAX_INLINE_RETRY_MS) {
          await wait(error.retryAfterMs);
          continue;
        }
        throw error;
      }
      throw providerError(`Coinbase CDP ${endpoint} retry budget exhausted`, 'CDP_TRANSPORT_ERROR');
    });
  }

  async *addressTransactionPages(address, { cursor = null, pageSize = MAX_PAGE_SIZE } = {}) {
    const normalizedAddress = String(address || '').toLowerCase();
    let next = pageCursor(cursor, 'address history');
    const seenCursors = new Set();
    let pages = 0;
    do {
      if (next != null) {
        if (seenCursors.has(next)) {
          throw providerError('Coinbase CDP address history returned a repeated page token', 'CDP_PAGINATION_STALLED');
        }
        seenCursors.add(next);
      }
      const params = {
        address: normalizedAddress,
        pageSize: Math.min(MAX_PAGE_SIZE, Math.max(1, Number(pageSize) || MAX_PAGE_SIZE)),
        pageToken: next || '',
      };
      const response = await this._request('cdp_listAddressTransactions', params, 'address-history');
      // `transactions` is accepted as a compatibility alias because Coinbase
      // documents cdp_listTransactions as an alias for this method, while the
      // response examples use addressTransactions. Keep the shape diagnostic
      // bounded to field names so a provider change never exposes raw history.
      const items = addressTransactionItems(response.body);
      pages += 1;
      if (pages > MAX_PAGES) {
        throw providerError('Coinbase CDP address history exceeded the pagination safety bound', 'CDP_PAGINATION_STALLED');
      }
      const cursorOut = pageCursor(response.body?.nextPageToken, 'address history');
      if (cursorOut && seenCursors.has(cursorOut)) {
        throw providerError('Coinbase CDP address history returned a repeated page token', 'CDP_PAGINATION_STALLED');
      }
      yield { ...response, items, cursorIn: next, cursorOut };
      next = cursorOut;
    } while (next);
  }

  async *balancePages(address, { cursor = null, pageSize = MAX_PAGE_SIZE } = {}) {
    const normalizedAddress = String(address || '').toLowerCase();
    let next = pageCursor(cursor, 'balances');
    const seenCursors = new Set();
    let pages = 0;
    do {
      if (next != null) {
        if (seenCursors.has(next)) {
          throw providerError('Coinbase CDP balances returned a repeated page token', 'CDP_PAGINATION_STALLED');
        }
        seenCursors.add(next);
      }
      const params = {
        address: normalizedAddress,
        pageSize: Math.min(MAX_PAGE_SIZE, Math.max(1, Number(pageSize) || MAX_PAGE_SIZE)),
        pageToken: next || '',
      };
      const response = await this._request('cdp_listBalances', params, 'balance-history');
      const items = collectionFromResult(response, 'balances', [], 'balance history');
      pages += 1;
      if (pages > MAX_PAGES) {
        throw providerError('Coinbase CDP balances exceeded the pagination safety bound', 'CDP_PAGINATION_STALLED');
      }
      const cursorOut = pageCursor(response.body?.nextPageToken, 'balances');
      if (cursorOut && seenCursors.has(cursorOut)) {
        throw providerError('Coinbase CDP balances returned a repeated page token', 'CDP_PAGINATION_STALLED');
      }
      yield { ...response, items, cursorIn: next, cursorOut };
      next = cursorOut;
    } while (next);
  }
}

module.exports = CdpClient;
module.exports.addressTransactionItems = addressTransactionItems;
module.exports.parseRetryAfter = parseRetryAfter;
module.exports.normalizeJsonNumbers = normalizeJsonNumbers;
module.exports.providerError = providerError;

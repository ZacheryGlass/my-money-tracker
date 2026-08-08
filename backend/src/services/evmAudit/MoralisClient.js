'use strict';

const crypto = require('node:crypto');
const { sha256 } = require('./normalizer');

const ROOT = 'https://deep-index.moralis.io/api/v2.2';
const DEFAULT_SPACING_MS = 250;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const MAX_INLINE_RETRY_MS = 30_000;
const MAX_ATTEMPTS = 3;
const queues = new Map();

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseRetryAfter(value) {
  if (!value) return null;
  if (/^\d+(?:\.\d+)?$/.test(value)) return Math.ceil(Number(value) * 1000);
  const at = Date.parse(value);
  return Number.isFinite(at) ? Math.max(0, at - Date.now()) : null;
}

function providerError(message, code, extra = {}) {
  const error = new Error(message);
  error.code = code;
  Object.assign(error, extra);
  return error;
}

class MoralisClient {
  constructor(apiKey, {
    spacingMs = DEFAULT_SPACING_MS,
    requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
    requestTimeoutGraceMs = 1000,
    onFailedAttempt = null,
  } = {}) {
    if (!apiKey) throw providerError('Moralis API key is not configured', 'MORALIS_NOT_CONFIGURED');
    this.apiKey = apiKey;
    this.spacingMs = spacingMs;
    this.requestTimeoutMs = requestTimeoutMs;
    this.requestTimeoutGraceMs = requestTimeoutGraceMs;
    this.onFailedAttempt = onFailedAttempt;
    // Hashing avoids retaining the credential as a map key or loggable label.
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

  async _request(path, params, endpoint) {
    return this._scheduled(async () => {
      const url = new URL(`${ROOT}${path}`);
      for (const [key, value] of Object.entries(params || {})) {
        if (Array.isArray(value)) {
          for (const item of value) url.searchParams.append(key, String(item));
        } else if (value != null && value !== '') {
          url.searchParams.set(key, String(value));
        }
      }

      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
        let response;
        let text;
        try {
          const controller = new AbortController();
          let timedOut = false;
          let timeout;
          const request = (async () => {
            const result = await fetch(url, {
              headers: { 'X-API-Key': this.apiKey, Accept: 'application/json' },
              signal: controller.signal,
            });
            return { response: result, text: await result.text() };
          })();
          // A custom fetch implementation may ignore abort, so the caller
          // still needs a hard upper bound. Native fetch aborts the request
          // before the next retry starts.
          request.catch(() => {});
          try {
            ({ response, text } = await Promise.race([
              request,
              new Promise((_, reject) => {
                timeout = setTimeout(() => {
                  timedOut = true;
                  controller.abort();
                  reject(providerError(
                    `Moralis ${endpoint} request exceeded its deadline`,
                    'MORALIS_TRANSPORT_ERROR'
                  ));
                }, this.requestTimeoutMs + this.requestTimeoutGraceMs);
              }),
            ]));
          } finally {
            clearTimeout(timeout);
          }
          if (timedOut) {
            throw providerError(
              `Moralis ${endpoint} request exceeded its deadline`,
              'MORALIS_TRANSPORT_ERROR'
            );
          }
        } catch (cause) {
          await this.onFailedAttempt?.({
            provider: 'moralis', endpoint, method: 'GET', attemptNo: attempt,
            requestParams: params || {}, outcome: attempt < MAX_ATTEMPTS ? 'deferred' : 'failed',
            errorCode: 'MORALIS_TRANSPORT_ERROR', errorDetail: 'Network request failed before a response.',
          });
          if (attempt < MAX_ATTEMPTS) {
            await wait(500 * (2 ** (attempt - 1)));
            continue;
          }
          throw providerError(`Moralis ${endpoint} request failed`, 'MORALIS_TRANSPORT_ERROR', { cause });
        }

        let body;
        try { body = JSON.parse(text); } catch { body = null; }
        if (response.ok && body && typeof body === 'object') {
          return {
            body,
            rawText: text,
            responseSha256: sha256(text),
            requestId: response.headers.get('x-request-id') || null,
          };
        }

        const detail = String(body?.message || body?.error || '').slice(0, 500);
        const retryable = response.status === 429 && attempt < MAX_ATTEMPTS;
        await this.onFailedAttempt?.({
          provider: 'moralis', endpoint, method: 'GET', attemptNo: attempt,
          requestParams: params || {}, outcome: retryable ? 'deferred' : 'failed',
          httpStatus: response.status,
          errorCode: response.status === 429 ? 'MORALIS_RATE_LIMITED'
            : [401, 403].includes(response.status) ? 'MORALIS_AUTH_FAILED' : 'MORALIS_API_ERROR',
          errorDetail: detail || `HTTP ${response.status}`,
          requestId: response.headers.get('x-request-id') || null,
          responseSha256: sha256(text), responseRaw: text, responseJson: body,
        });
        if (response.status === 429) {
          const retryAfterMs = parseRetryAfter(response.headers.get('retry-after')) ?? 5_000;
          if (attempt < MAX_ATTEMPTS && retryAfterMs <= MAX_INLINE_RETRY_MS) {
            await wait(retryAfterMs);
            continue;
          }
          throw providerError(
            'Moralis rate limit reached; audit deferred',
            'MORALIS_RATE_LIMITED',
            { retryAfterMs, retryAt: new Date(Date.now() + retryAfterMs), httpStatus: 429 }
          );
        }
        if (response.status === 401 || response.status === 403) {
          throw providerError(
            'Moralis rejected the configured credential',
            'MORALIS_AUTH_FAILED',
            { httpStatus: response.status }
          );
        }
        throw providerError(
          `Moralis ${endpoint} returned HTTP ${response.status}${detail ? `: ${detail}` : ''}`,
          'MORALIS_API_ERROR',
          { httpStatus: response.status }
        );
      }
      throw providerError(`Moralis ${endpoint} retry budget exhausted`, 'MORALIS_TRANSPORT_ERROR');
    });
  }

  activeChains(address, chains) {
    return this._request(`/wallets/${address}/chains`, { chains }, 'active-chain discovery');
  }

  async *walletHistoryPages(address, {
    chain, fromBlock, throughBlock, cursor = null, limit = 100,
  }) {
    let next = cursor;
    let pages = 0;
    do {
      const response = await this._request(`/wallets/${address}/history`, {
        chain,
        from_block: fromBlock,
        to_block: throughBlock,
        include_internal_transactions: true,
        nft_metadata: false,
        order: 'ASC',
        limit,
        cursor: next,
      }, 'wallet history');
      const items = response.body.result;
      if (!Array.isArray(items)) {
        throw providerError('Moralis wallet history returned an invalid result shape', 'MORALIS_INVALID_RESPONSE');
      }
      pages += 1;
      if (pages > 10_000) {
        throw providerError('Moralis wallet history exceeded the pagination safety bound', 'MORALIS_PAGINATION_STALLED');
      }
      const cursorOut = response.body.cursor || null;
      if (cursorOut && cursorOut === next) {
        throw providerError('Moralis wallet history returned a repeated cursor', 'MORALIS_PAGINATION_STALLED');
      }
      yield { ...response, items, cursorIn: next, cursorOut };
      next = cursorOut;
    } while (next);
  }

  transactionByHash(hash, chain) {
    return this._request(`/transaction/${hash}`, {
      chain, include: 'internal_transactions',
    }, 'transaction lookup');
  }
}

module.exports = MoralisClient;
module.exports.parseRetryAfter = parseRetryAfter;

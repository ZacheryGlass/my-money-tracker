'use strict';

// One classification of provider failures. Every provider client keeps its
// own legacy error `code` (persisted in statuses and coverage rows), and also
// carries `kind`, the provider-neutral answer callers branch on:
//
//   rate_limited       back off and retry later (429, quota)
//   not_configured     no credential for this provider
//   auth               the credential was refused
//   unsupported        the provider does not serve this feed or action
//   chain_unavailable  the provider (or this key's plan) cannot reach the chain
//   partial_index      the provider's index is incomplete for the range
//   transient          transport failure or provider-side error; retryable
//   malformed          the response did not have the documented shape
//
// A caller adding a provider adds codes here only when its spelling is new;
// a code that matches no rule has no kind and is treated as fatal.

// Node/axios/undici transport failures: the request never got a provider answer.
const TRANSPORT_CODES = new Set([
  'ECONNRESET', 'ETIMEDOUT', 'ECONNABORTED', 'EAI_AGAIN', 'ECONNREFUSED',
  'EHOSTUNREACH', 'ENETUNREACH', 'ENOTFOUND', 'EPIPE', 'ERR_NETWORK',
  'ERR_BAD_RESPONSE', 'UND_ERR_CONNECT_TIMEOUT', 'ERR_SOCKET_CONNECTION_TIMEOUT',
]);

const RULES = [
  ['rate_limited', (code) => /_RATE_LIMITED$|_QUOTA_EXHAUSTED$/.test(code)],
  ['not_configured', (code) => /_NOT_CONFIGURED$/.test(code)],
  ['auth', (code) => /_AUTH_FAILED$|^COINBASE_KEY_FORMAT$/.test(code)],
  ['unsupported', (code) => /_FEED_UNSUPPORTED$|^RPC_UNSUPPORTED$|^NON_EVM_CHAIN$/.test(code)],
  ['chain_unavailable', (code) => /_CHAIN_UNAVAILABLE$/.test(code)],
  ['partial_index', (code) => /_PARTIAL_INDEX$|_HISTORY_INCOMPLETE$/.test(code)],
  ['malformed', (code) => /_MALFORMED$|^EVM_INVALID_RAW_PAGE$/.test(code)],
  ['transient', (code) => TRANSPORT_CODES.has(code) || /_TRANSPORT_ERROR$|_API_ERROR$/.test(code)],
];

function kindOf(error) {
  if (!error || typeof error !== 'object') return null;
  if (error.kind) return error.kind;
  const code = String(error.code || '');
  for (const [kind, matches] of RULES) {
    if (code && matches(code)) return kind;
  }
  const status = Number(error.response?.status ?? error.request_summary?.status);
  if (status === 429) return 'rate_limited';
  if (status === 401 || status === 403) return 'auth';
  if (status >= 500) return 'transient';
  return null;
}

// Stamps `kind` on the error (keeping its code) and returns it.
function withKind(error) {
  if (error && typeof error === 'object' && !error.kind) {
    const kind = kindOf(error);
    if (kind) error.kind = kind;
  }
  return error;
}

module.exports = { kindOf, withKind, TRANSPORT_CODES };

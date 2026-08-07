'use strict';

// Etherscan API V2: one key serves every chain; the chain is picked per
// request via the chainid param. The set of chains and their ids live in
// ./chains.js; CHAIN_ID here is only the fallback for a caller that names none.
const BASE_URL = 'https://api.etherscan.io/v2/api';
const { DEFAULT_CHAIN_ID: CHAIN_ID } = require('./chains');

// Free tier allows 5 req/s; space calls 250 ms apart (4 req/s) to stay under.
// The spacing is an environment override so a provider plan can be tuned
// without changing application code. Anonymous Blockscout limits are scoped
// by outbound IP rather than wallet. Keep those calls at 40/minute so a long
// multi-wallet scan does not exhaust a minute bucket even when the documented
// per-instance default is more generous.
function envMilliseconds(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value >= 0 ? Math.floor(value) : fallback;
}

const REQUEST_SPACING_MS = envMilliseconds('ETHERSCAN_REQUEST_SPACING_MS', 250);
const BLOCKSCOUT_REQUEST_SPACING_MS = envMilliseconds('BLOCKSCOUT_REQUEST_SPACING_MS', 1500);
const RPC_REQUEST_SPACING_MS = envMilliseconds('RPC_REQUEST_SPACING_MS', 250);
// EtherscanService accepts endpoint-specific floors up to one minute. Retain
// each host's completion timestamp through that whole window so a stricter
// incoming request cannot arrive after a shorter predecessor's state expired.
// Operator defaults above one minute extend the retention automatically.
const MAX_INCOMING_SPACING_MS = Math.max(
  60_000,
  REQUEST_SPACING_MS,
  BLOCKSCOUT_REQUEST_SPACING_MS,
  RPC_REQUEST_SPACING_MS
);

// A rate limit is scoped to the provider host (or to an Etherscan key), not to
// the wallet/feed currently being fetched. Keep queues and cooldowns separate
// so a busy public Blockscout instance cannot either starve Etherscan or be
// accidentally bypassed by another wallet's request.
const queues = new Map();
const pausedUntil = new Map();
const DEFAULT_QUEUE_KEY = 'legacy:etherscan';

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function pausedError(key, retryAfterMs) {
  const error = new Error(
    `Explorer provider is rate limited; retry after ${Math.max(1, Math.ceil(retryAfterMs / 1000))}s`
  );
  error.code = 'EXPLORER_RATE_LIMITED';
  error.providerKey = key;
  error.retryAfterMs = retryAfterMs;
  error.retryAfterAt = new Date(Date.now() + retryAfterMs);
  return error;
}

function throttled(fn, {
  key = DEFAULT_QUEUE_KEY,
  spacingMs = REQUEST_SPACING_MS,
  bypassPause = false,
} = {}) {
  const requestedSpacingMs = Math.max(0, Number(spacingMs) || 0);
  const state = queues.get(key) || {
    tail: Promise.resolve(),
    completedAt: 0,
    spacingMs: 0,
  };
  const run = state.tail.then(async () => {
    // Provider limits are host-wide, so a handoff between endpoint classes
    // must satisfy both sides. Sleeping only the preceding request's floor
    // lets a 15s account call hand off to a 30s state-sync call after 15s.
    const requiredSpacingMs = Math.max(state.spacingMs, requestedSpacingMs);
    const spacingRemainingMs = state.completedAt
      ? Math.max(0, requiredSpacingMs - (Date.now() - state.completedAt))
      : 0;
    if (spacingRemainingMs > 0) await sleep(spacingRemainingMs);
    try {
      const pauseRemainingMs = Math.max(0, (pausedUntil.get(key) || 0) - Date.now());
      if (pauseRemainingMs > 0 && !bypassPause) {
        throw pausedError(key, pauseRemainingMs);
      }
      return await fn();
    } finally {
      state.completedAt = Date.now();
      state.spacingMs = requestedSpacingMs;
    }
  });
  const tail = run.catch(() => {});
  state.tail = tail;
  queues.set(key, state);
  // Retain the completed timestamp only while it can still constrain a new
  // request. The identity checks preserve state when newer work arrived.
  tail.then(() => {
    const cleanupTimer = setTimeout(() => {
      if (queues.get(key) === state && state.tail === tail) queues.delete(key);
    }, Math.max(state.spacingMs, MAX_INCOMING_SPACING_MS));
    cleanupTimer.unref?.();
  });
  return run;
}

function pause(key, delayMs) {
  const duration = Math.max(0, Math.ceil(Number(delayMs) || 0));
  if (duration === 0) return;
  const until = Date.now() + duration;
  pausedUntil.set(key, Math.max(pausedUntil.get(key) || 0, until));
}

// Test/support hook. Production callers only ever add state through pause().
function resetRateLimits() {
  queues.clear();
  pausedUntil.clear();
}

module.exports = {
  BASE_URL,
  CHAIN_ID,
  REQUEST_SPACING_MS,
  BLOCKSCOUT_REQUEST_SPACING_MS,
  RPC_REQUEST_SPACING_MS,
  throttled,
  pause,
  resetRateLimits,
};

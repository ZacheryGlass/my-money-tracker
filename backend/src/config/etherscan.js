'use strict';

// Etherscan API V2: one key serves every chain; the chain is picked per
// request via the chainid param. The set of chains and their ids live in
// ./chains.js; CHAIN_ID here is only the fallback for a caller that names none.
const BASE_URL = 'https://api.etherscan.io/v2/api';
const { DEFAULT_CHAIN_ID: CHAIN_ID } = require('./chains');

// Free tier allows 5 req/s; space calls 250 ms apart (4 req/s) to stay under.
// The spacing is an environment override so a provider plan can be tuned
// without changing application code. Blockscout's public instances are more
// conservative, so EtherscanService supplies its 500 ms queue for those hosts.
function envMilliseconds(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value >= 0 ? Math.floor(value) : fallback;
}

const REQUEST_SPACING_MS = envMilliseconds('ETHERSCAN_REQUEST_SPACING_MS', 250);
const BLOCKSCOUT_REQUEST_SPACING_MS = envMilliseconds('BLOCKSCOUT_REQUEST_SPACING_MS', 500);
const RPC_REQUEST_SPACING_MS = envMilliseconds('RPC_REQUEST_SPACING_MS', 250);

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
  return error;
}

function throttled(fn, {
  key = DEFAULT_QUEUE_KEY,
  spacingMs = REQUEST_SPACING_MS,
  bypassPause = false,
} = {}) {
  const queue = queues.get(key) || Promise.resolve();
  const run = queue.then(async () => {
    const remaining = Math.max(0, (pausedUntil.get(key) || 0) - Date.now());
    if (remaining > 0 && !bypassPause) throw pausedError(key, remaining);
    return fn();
  });
  const tail = run
    .catch(() => {})
    .then(() => sleep(Math.max(0, spacingMs)));
  queues.set(key, tail);
  // Do not retain a resolved promise for every provider forever. The identity
  // check preserves a newer queue when another request arrived meanwhile.
  tail.then(() => {
    if (queues.get(key) === tail) queues.delete(key);
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

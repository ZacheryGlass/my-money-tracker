'use strict';

// Etherscan API V2: one key serves every chain; the chain is picked per
// request via the chainid param (1 = Ethereum mainnet).
const BASE_URL = 'https://api.etherscan.io/v2/api';
const CHAIN_ID = 1;

// Free tier allows 5 req/s; space calls 250 ms apart (4 req/s) to stay under.
const REQUEST_SPACING_MS = 250;

function isConfigured() {
  return Boolean(process.env.ETHERSCAN_API_KEY);
}

function apiKey() {
  return process.env.ETHERSCAN_API_KEY;
}

// All Etherscan calls funnel through this serializer so concurrent syncs
// cannot exceed the rate limit.
let queue = Promise.resolve();

function throttled(fn) {
  const run = queue.then(fn);
  queue = run
    .catch(() => {})
    .then(() => new Promise((resolve) => setTimeout(resolve, REQUEST_SPACING_MS)));
  return run;
}

module.exports = { BASE_URL, CHAIN_ID, isConfigured, apiKey, throttled };

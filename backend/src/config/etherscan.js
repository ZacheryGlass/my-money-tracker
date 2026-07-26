'use strict';

// Etherscan API V2: one key serves every chain; the chain is picked per
// request via the chainid param. The set of chains and their ids live in
// ./chains.js; CHAIN_ID here is only the fallback for a caller that names none.
const BASE_URL = 'https://api.etherscan.io/v2/api';
const { DEFAULT_CHAIN_ID: CHAIN_ID } = require('./chains');

// Free tier allows 5 req/s; space calls 250 ms apart (4 req/s) to stay under.
const REQUEST_SPACING_MS = 250;

// Keys are per-user, resolved via SecretsService (DB value, env fallback) by
// EthWalletService and threaded through EtherscanService per request.
//
// All Etherscan calls funnel through this serializer so concurrent syncs
// cannot exceed the rate limit. It is deliberately global across users AND
// across chains: the rate limit is per key, not per chain, so syncing five
// chains must not multiply the request rate by five.
let queue = Promise.resolve();

function throttled(fn) {
  const run = queue.then(fn);
  queue = run
    .catch(() => {})
    .then(() => new Promise((resolve) => setTimeout(resolve, REQUEST_SPACING_MS)));
  return run;
}

module.exports = { BASE_URL, CHAIN_ID, throttled };

'use strict';

// Account-history provider adapters: every directory here with an index.js
// is one adapter, selected per feed by a network's `routes`
// (crypto/registry/networks). Adding a provider is adding a directory.
//
// Adapter contract:
//   id                 the name networks route to
//   pages(ctx)         async generator of pages in the shape
//                      EtherscanService.accountFeedPages has always yielded
//                      ({ rows, cursorIn, cursorOut, itemCount } plus evidence:
//                      provider, endpoint, requestParams, rawText, responseJson,
//                      responseSha256, requestId)
//   routeKey?(chain, feed)  the persisted provenance string for a feed; when
//                      absent the chains facade derives today's string
//   credential?        { service, label } when the adapter needs a user key
//
// ctx: { service (EtherscanService, late-bound so test stubs apply),
//        internals ({ apiError, PAGE_SIZE, MAX_ACCOUNT_PAGES }), action,
//        address, startBlock, endBlock, apiKey, chainId, accountApi }
//
// CRYPTO_EXTRA_PROVIDERS_DIR adds a second directory, for the extensibility
// acceptance test.

const fs = require('fs');
const path = require('path');

const DEFAULT_ADAPTER = 'etherscan-compatible';

function loadDir(dir) {
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && fs.existsSync(path.join(dir, entry.name, 'index.js')))
    .map((entry) => require(path.join(dir, entry.name, 'index.js')));
}

const ADAPTERS = new Map();
for (const adapter of [
  ...loadDir(__dirname),
  ...(process.env.CRYPTO_EXTRA_PROVIDERS_DIR ? loadDir(path.resolve(process.env.CRYPTO_EXTRA_PROVIDERS_DIR)) : []),
]) {
  if (!adapter.id || typeof adapter.pages !== 'function') {
    throw new Error('a provider adapter needs an id and a pages() generator');
  }
  if (ADAPTERS.has(adapter.id)) throw new Error(`duplicate provider adapter ${adapter.id}`);
  ADAPTERS.set(adapter.id, adapter);
}

function adapter(id) {
  return ADAPTERS.get(id) || null;
}

module.exports = { ADAPTERS, DEFAULT_ADAPTER, adapter };

'use strict';

// Extensibility acceptance: a provider is ONE adapter directory, and moving a
// feed to it is ONE route line in a network file. A synthetic adapter and a
// network that routes only its normal feed there must serve that feed through
// the adapter, give only that feed a new provenance string (so only it
// replays), and leave the other feeds on their existing provider.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'synthetic-provider-'));
const providersDir = path.join(root, 'providers');
const networksDir = path.join(root, 'networks');
fs.mkdirSync(path.join(providersDir, 'synthetic-feed'), { recursive: true });
fs.mkdirSync(networksDir);
fs.writeFileSync(path.join(providersDir, 'synthetic-feed', 'index.js'), `'use strict';
module.exports = {
  id: 'synthetic-feed',
  routeKey: (chain, feed) => 'Synthetic Indexer (' + chain.id + '/' + feed + ')',
  async *pages({ action, address, startBlock, endBlock }) {
    yield {
      provider: 'Synthetic Indexer', endpoint: 'synthetic://', requestParams: { action, address, startBlock, endBlock },
      rawText: '[]', responseJson: [], responseSha256: null, requestId: null,
      rows: [{ hash: '0x' + 'a'.repeat(64), blockNumber: String(startBlock + 1), from: address, to: address, value: '0' }],
      cursorIn: String(startBlock), cursorOut: null, itemCount: 1,
    };
  },
};
`);
fs.writeFileSync(path.join(networksDir, 'synthroute.js'), `'use strict';
module.exports = {
  order: 96, id: 999002, caip2: 'eip155:999002', family: 'evm', name: 'SynthRoute', shortName: 'SynthRoute',
  nativeAsset: 'ETH', coingeckoPlatform: 'synthroute', enabledByDefault: true,
  accountApi: { provider: 'Blockscout', baseUrl: 'https://explorer.synthroute.example/api', requiresApiKey: false },
  routes: { normal: 'synthetic-feed' },
  explorer: { baseUrl: 'https://explorer.synthroute.example', txPath: '/tx/{hash}', addressPath: '/address/{address}' },
  exchangeAliases: [], audit: {},
};
`);
process.env.CRYPTO_EXTRA_PROVIDERS_DIR = providersDir;
process.env.CRYPTO_EXTRA_NETWORKS_DIR = networksDir;
process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = 'postgresql://test:test@localhost/test';
delete process.env.ETH_CHAINS;

const chains = require('../src/config/chains');
const EtherscanService = require('../src/services/EtherscanService');

test.after(() => fs.rmSync(root, { recursive: true, force: true }));

test('the routed feed is served by the new adapter', async () => {
  assert.equal(chains.accountFeedRoute(999002, 'txlist'), 'synthetic-feed');
  const pages = [];
  for await (const page of EtherscanService.accountFeedPages('txlist', '0x' + 'b'.repeat(40), 5, null, 999002, 100)) {
    pages.push(page);
  }
  assert.equal(pages.length, 1);
  assert.equal(pages[0].provider, 'Synthetic Indexer');
  assert.equal(pages[0].rows[0].blockNumber, '6');
});

test('only the routed feed gets the new provenance string; the others keep theirs', () => {
  assert.equal(chains.accountHistoryProviderName(999002, 'normal'), 'Synthetic Indexer (999002/normal)');
  assert.equal(chains.accountHistoryProviderName(999002, 'token'), 'Blockscout (https://explorer.synthroute.example/api)');
  assert.equal(chains.accountFeedRoute(999002, 'tokentx'), 'etherscan-compatible');
});

test('built-in routes are unchanged for existing networks', () => {
  assert.equal(chains.accountFeedRoute(10, 'txlist'), 'blockscout-v2');
  assert.equal(chains.accountFeedRoute(10, 'tokentx'), 'etherscan-compatible');
  assert.equal(chains.accountFeedRoute(1, 'txlist'), 'etherscan-compatible');
});

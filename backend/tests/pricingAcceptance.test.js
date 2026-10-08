'use strict';

// Extensibility acceptance: a price provider is ONE file. A synthetic one in
// an extra directory must join its declared route, get its own throttle, and
// price an asset the built-in route could not -- with no core file edited.
// Also the contract every provider meets.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'synthetic-pricing-'));
fs.writeFileSync(path.join(root, 'synthprice.js'), `'use strict';
module.exports = {
  id: 'synthprice', label: 'SynthPrice', limiter: 'synthprice', spacingMs: 0, routes: ['erc20'],
  supports(request) { return request.parsed.chainId === 1; },
  async fetchDaily(request, window) {
    return { points: [[Date.parse(window.from + 'T00:00:00Z'), '1.25'], [Date.parse(window.to + 'T00:00:00Z'), '1.5']] };
  },
};
`);
process.env.CRYPTO_EXTRA_PRICE_PROVIDERS_DIR = root;
process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = 'postgresql://test:test@localhost/test';

test.after(() => fs.rmSync(root, { recursive: true, force: true }));

const stored = [];
function fakeQuery(text, params = []) {
  const sql = String(text).replace(/\s+/g, ' ').trim();
  if (/^INSERT INTO asset_price_history/.test(sql)) {
    for (let i = 0; i < params.length; i += 4) stored.push({ date: params[i + 1], price: params[i + 2], source: params[i + 3] });
    return { rows: [], rowCount: params.length / 4 };
  }
  if (/^SELECT MIN\(price_date\) AS earliest/.test(sql)) {
    const dates = stored.map((row) => row.date).sort();
    return { rows: [{ earliest: dates[0] || null, latest: dates[dates.length - 1] || null, points: dates.length }] };
  }
  return { rows: [], rowCount: 0 };
}
const pgPath = require.resolve('pg');
require.cache[pgPath] = {
  id: pgPath, filename: pgPath, loaded: true,
  exports: {
    Pool: class FakePool {
      async query(text, params) { return fakeQuery(text, params); }
      async connect() { return { query: async (text, params) => fakeQuery(text, params), release() {} }; }
      on() {}
    },
    types: { setTypeParser() {} },
  },
};
const requests = [];
const axiosPath = require.resolve('axios');
require.cache[axiosPath] = {
  id: axiosPath, filename: axiosPath, loaded: true,
  exports: {
    async get(url) {
      requests.push(url);
      const error = new Error('Request failed with status code 404');
      error.response = { status: 404, data: { error: 'coin not found' } };
      throw error;
    },
  },
};

const SecretsService = require('../src/services/SecretsService');
SecretsService.getAppSetting = async () => null;
const pricing = require('../src/crypto/pricing');
const { ROUTES } = require('../src/crypto/pricing/order');
const { PROVIDER_SPACING_MS } = require('../src/crypto/pricing/limiter');
const HistoricalPriceService = require('../src/services/HistoricalPriceService');
for (const key of Object.keys(PROVIDER_SPACING_MS)) PROVIDER_SPACING_MS[key] = 0;

test('every provider meets the contract and every route names a provider', () => {
  for (const provider of pricing.PROVIDERS.values()) {
    assert.equal(typeof provider.id, 'string', 'id');
    assert.ok(provider.id.length <= 40, `${provider.id} fits asset_price_history.source`);
    assert.equal(typeof provider.label, 'string', provider.id);
    assert.equal(typeof provider.supports, 'function', provider.id);
    assert.equal(typeof provider.fetchDaily, 'function', provider.id);
  }
  for (const ids of Object.values(ROUTES)) {
    for (const id of ids) assert.ok(pricing.provider(id), id);
  }
  // Persisted as asset_price_history.source; renaming one orphans its rows.
  assert.deepEqual(Object.values(ROUTES).flat().sort(), ['bitfinex', 'coinbase-exchange', 'coingecko', 'coingecko'].sort());
});

test('a provider file joins its declared route and prices what the built-ins could not', async () => {
  assert.equal(PROVIDER_SPACING_MS.synthprice, 0, 'its throttle key is registered');
  const entry = await HistoricalPriceService.ensureAsset({
    asset_key: 'erc20:1:0x1111111111111111111111111111111111111111', asset_symbol: 'SYN', first_date: '2026-09-01',
  });
  assert.equal(requests.length, 1, 'CoinGecko is still asked first');
  assert.equal(entry.status, 'covered');
  assert.equal(entry.provider, 'synthprice');
  assert.match(entry.detail, /^CoinGecko fell through: CoinGecko has no series/);
  assert.ok(stored.length > 0 && stored.every((row) => row.source === 'synthprice'));
});

test('an asset the new provider does not support keeps the built-in verdict', async () => {
  requests.length = 0;
  const entry = await HistoricalPriceService.ensureAsset({
    asset_key: 'erc20:137:0x2222222222222222222222222222222222222222', asset_symbol: 'X', first_date: '2026-09-01',
  });
  assert.equal(requests.length, 1);
  assert.equal(entry.status, 'unlisted');
  assert.equal(entry.provider, null);
});

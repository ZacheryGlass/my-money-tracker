'use strict';

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = 'postgresql://test:test@localhost/test';

const pgModulePath = require.resolve('pg');
require.cache[pgModulePath] = {
  id: pgModulePath,
  filename: pgModulePath,
  loaded: true,
  exports: {
    Pool: class FakePool {
      async query() { return { rows: [] }; }
      on() {}
    },
    types: { setTypeParser() {} },
  },
};

const calls = [];
let axiosResponse = { status: 200, data: {} };
const fakeAxios = (url, config) => {
  calls.push({ url, config });
  return Promise.resolve(axiosResponse);
};
fakeAxios.get = (url, config) => {
  calls.push({ url, config });
  return Promise.resolve(axiosResponse);
};
const axiosPath = require.resolve('axios');
require.cache[axiosPath] = { id: axiosPath, filename: axiosPath, loaded: true, exports: fakeAxios };

// Market-data keys must come from SecretsService (DB, then env), never from a
// direct process.env read inside PriceService -- otherwise the Server tab's
// Market Data Keys card stores values the price fetchers ignore.
let appSettings = {};
const secretsPath = require.resolve('../src/services/SecretsService');
require.cache[secretsPath] = {
  id: secretsPath,
  filename: secretsPath,
  loaded: true,
  exports: { getAppSetting: async (name) => appSettings[name] || null },
};

const PriceService = require('../src/services/PriceService');

beforeEach(() => {
  calls.length = 0;
  appSettings = {};
  axiosResponse = { status: 200, data: {} };
  delete process.env.CG_API_KEY;
  delete process.env.CMC_PRO_API_KEY;
});

test('CoinMarketCap sends the stored key as a header, not a query param', async () => {
  appSettings.cmc_api_key = 'stored-cmc-key';
  axiosResponse = { status: 200, data: { data: { BTC: { quote: { USD: { price: 12345.67 } } } } } };

  const price = await PriceService.getCoinMarketCapPrice('BTC');

  assert.equal(price, 12345.67);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].config.headers['X-CMC_PRO_API_KEY'], 'stored-cmc-key');
  assert.ok(!calls[0].url.includes('stored-cmc-key'), 'key must stay out of the URL');
});

test('CoinMarketCap skips the request when SecretsService has no key, even with the env var set', async () => {
  process.env.CMC_PRO_API_KEY = 'env-key-that-must-be-ignored';

  const price = await PriceService.getCoinMarketCapPrice('BTC');

  assert.equal(price, null);
  assert.equal(calls.length, 0);
});

test('CoinGecko sends the key resolved by SecretsService', async () => {
  appSettings.cg_api_key = 'stored-cg-key';
  process.env.CG_API_KEY = 'env-key-that-must-be-ignored';
  axiosResponse = { status: 200, data: { bitcoin: { usd: 42 } } };

  const price = await PriceService.getCoinGeckoPrice('BTC', { BTC: 'bitcoin' });

  assert.equal(price, 42);
  assert.equal(calls[0].config.headers['x-cg-api-key'], 'stored-cg-key');
});

test('CoinGecko omits the auth header when no key is configured', async () => {
  axiosResponse = { status: 200, data: { bitcoin: { usd: 7 } } };

  const price = await PriceService.getCoinGeckoPrice('BTC', { BTC: 'bitcoin' });

  assert.equal(price, 7);
  assert.equal(calls[0].config.headers['x-cg-api-key'], undefined);
});

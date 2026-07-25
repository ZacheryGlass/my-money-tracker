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

let coinListFetches = 0;
const COIN_LIST = [
  { id: 'bitcoin', symbol: 'btc', name: 'Bitcoin' },
  { id: 'solana', symbol: 'sol', name: 'Solana' },
  { id: 'ethereum', symbol: 'eth', name: 'Ethereum' },
];

const fakeAxios = (url) => {
  if (String(url).includes('/coins/list')) {
    coinListFetches++;
    return Promise.resolve({ status: 200, data: COIN_LIST });
  }
  return Promise.resolve({ status: 200, data: {} });
};
fakeAxios.get = fakeAxios;
const axiosPath = require.resolve('axios');
require.cache[axiosPath] = { id: axiosPath, filename: axiosPath, loaded: true, exports: fakeAxios };

const secretsPath = require.resolve('../src/services/SecretsService');
require.cache[secretsPath] = {
  id: secretsPath,
  filename: secretsPath,
  loaded: true,
  exports: { getAppSetting: async () => null },
};

const PriceService = require('../src/services/PriceService');

beforeEach(() => {
  coinListFetches = 0;
});

test('the cached id map serves tickers it was not originally asked for', async () => {
  // fetchPrice looks up one ticker at a time. Caching the FILTERED result meant
  // the first ticker through the CoinGecko fallback cached a map holding only
  // itself, so every later ticker found no id and skipped CoinGecko for the
  // next six hours -- falling through to CoinMarketCap without a word.
  const first = await PriceService.buildCoinGeckoIdMap(['BTC']);
  assert.deepEqual(first, { BTC: 'bitcoin' });

  const second = await PriceService.buildCoinGeckoIdMap(['SOL']);
  assert.deepEqual(second, { SOL: 'solana' }, 'SOL must resolve from the cached full list');

  const third = await PriceService.buildCoinGeckoIdMap(['ETH', 'BTC']);
  assert.deepEqual(third, { ETH: 'ethereum', BTC: 'bitcoin' });

  assert.equal(coinListFetches, 1, 'the coin list should be fetched once, then served from cache');
});

test('unknown tickers are simply absent from the returned map', async () => {
  const map = await PriceService.buildCoinGeckoIdMap(['NOTACOIN']);
  assert.deepEqual(map, {});
});

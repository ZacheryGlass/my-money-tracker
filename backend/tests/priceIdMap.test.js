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
  // Two coins claiming 'pol', imposter LAST so last-match-wins would pick it.
  // CoinGecko really does list several; this is the collision in miniature.
  { id: 'polygon-ecosystem-token', symbol: 'pol', name: 'POL (ex-MATIC)' },
  { id: 'some-other-pol', symbol: 'pol', name: 'Totally Different POL' },
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

test("a chain's native asset resolves to the registry's declared coin id, not the list's", async () => {
  // The scan is last-match-wins over a list where several coins share a symbol,
  // so a native asset must not be left to it. A wrong price here is not a gap:
  // it is a plausible number sitting in someone's balance.
  const map = await PriceService.buildCoinGeckoIdMap(['POL']);
  assert.deepEqual(map, { POL: 'polygon-ecosystem-token' });
});

test('a native asset never takes a symbol-matched quote from Yahoo', async () => {
  // The bug this pins, found live in production: Yahoo lists POL-USD as "Proof
  // Of Liquidity", an unrelated token, and Yahoo is tried FIRST for crypto --
  // so POL was priced 9x low. Providers that can be asked by ID go first for
  // these symbols, and if none answers the price stays absent.
  const calls = [];
  const originalYahoo = PriceService.getYahooFinancePrice;
  const originalCoinbase = PriceService.getCoinbasePrice;
  const originalGecko = PriceService.getCoinGeckoPrice;
  PriceService.getYahooFinancePrice = async (t) => { calls.push(`yahoo:${t}`); return 0.00824; };
  PriceService.getCoinbasePrice = async (t) => { calls.push(`coinbase:${t}`); return 0.0763; };
  PriceService.getCoinGeckoPrice = async (t) => { calls.push(`gecko:${t}`); return 0.0745; };
  try {
    const result = await PriceService.fetchPrice('POL', 'Crypto');
    assert.deepEqual(result, { price: 0.0763, source: 'coinbase' });
    assert.ok(!calls.some((c) => c.startsWith('yahoo')), 'Yahoo must not be consulted for POL');

    // And with Coinbase down it falls to the declared CoinGecko id, still never
    // to Yahoo -- an absent price beats a confident wrong one.
    calls.length = 0;
    PriceService.getCoinbasePrice = async () => null;
    assert.deepEqual(await PriceService.fetchPrice('POL', 'Crypto'), { price: 0.0745, source: 'coingecko' });

    calls.length = 0;
    PriceService.getCoinGeckoPrice = async () => null;
    assert.equal(await PriceService.fetchPrice('POL', 'Crypto'), null);
    assert.ok(!calls.some((c) => c.startsWith('yahoo')), 'not even as a last resort');
  } finally {
    PriceService.getYahooFinancePrice = originalYahoo;
    PriceService.getCoinbasePrice = originalCoinbase;
    PriceService.getCoinGeckoPrice = originalGecko;
  }
});

test('an ordinary crypto ticker still goes to Yahoo first', async () => {
  // The native-asset path is a narrow exception, not a reordering. ETH is a
  // native asset and takes the new path; SOL is not and must not.
  const calls = [];
  const originalYahoo = PriceService.getYahooFinancePrice;
  PriceService.getYahooFinancePrice = async (t) => { calls.push(t); return 123; };
  try {
    assert.deepEqual(await PriceService.fetchPrice('SOL', 'Crypto'), { price: 123, source: 'yahoo' });
    assert.deepEqual(calls, ['SOL']);
  } finally {
    PriceService.getYahooFinancePrice = originalYahoo;
  }
});

'use strict';

// Golden for the historical price waterfall: every provider answer the
// waterfall distinguishes, crossed per route (native, token, alias), pinned as
// the exact request sequence and the exact coverage verdict ensureAsset
// returns. Recorded from the pre-split HistoricalPriceService, so moving a
// provider into its own file cannot change a single call or verdict.
//
// Regenerate (only for an approved behavior change): GOLDEN_WRITE=1.

const { test, mock } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = 'postgresql://test:test@localhost/test';

const GOLDEN = path.join(__dirname, 'fixtures', 'pricing', 'waterfall-golden.json');
const TOKEN = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';
const EOS_KEY = 'erc20:1:0x86fa049857e0209aa7d9e616f7eb3b3b78ecfdb0';

const prices = [];
function fakeQuery(text, params = []) {
  const sql = String(text).replace(/--[^\n]*/g, '').replace(/\s+/g, ' ').trim();
  if (/^INSERT INTO asset_price_history/.test(sql)) {
    for (let i = 0; i < params.length; i += 4) {
      const row = { asset_key: params[i], price_date: params[i + 1], price_usd: params[i + 2], source: params[i + 3] };
      const existing = prices.find((p) => p.asset_key === row.asset_key && p.price_date === row.price_date);
      if (existing) Object.assign(existing, row); else prices.push(row);
    }
    return { rows: [], rowCount: params.length / 4 };
  }
  if (/^SELECT MIN\(price_date\) AS earliest/.test(sql)) {
    const dates = prices.filter((p) => p.asset_key === params[0]).map((p) => p.price_date).sort();
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

let handleGet = null;
const requests = [];
const axiosPath = require.resolve('axios');
require.cache[axiosPath] = {
  id: axiosPath, filename: axiosPath, loaded: true,
  exports: {
    async get(url) { requests.push(url); return handleGet(url); },
    async post() { throw new Error('unexpected POST'); },
  },
};

const SecretsService = require('../src/services/SecretsService');
SecretsService.getAppSetting = async () => null;
const HistoricalPriceService = require('../src/services/HistoricalPriceService');
for (const key of Object.keys(HistoricalPriceService.PROVIDER_SPACING_MS)) {
  HistoricalPriceService.PROVIDER_SPACING_MS[key] = 0;
}

function httpError(status, data) {
  const error = new Error(`Request failed with status code ${status}`);
  error.response = { status, data };
  return error;
}

const day = (date) => Date.parse(`${date}T00:00:00Z`);

// --- provider answers -------------------------------------------------------

const CG = {
  ok: () => ({ status: 200, data: { prices: [[day('2017-06-01'), 250], [day('2026-10-06'), 2500]] } }),
  empty: () => ({ status: 200, data: { prices: [] } }),
  offshape: () => ({ status: 200, data: { nope: true } }),
  unlisted: () => { throw httpError(404, { error: 'coin not found' }); },
  badKey: () => { throw httpError(401, { status: { error_code: 10002 } }); },
  limited: () => { throw httpError(429, {}); },
  down: () => { throw httpError(500, {}); },
  range: () => { throw httpError(401, { error: { status: { error_code: 10012 } } }); },
};
// The narrowed retry is the same path asked for a later `from`.
const CG_NARROWED = {
  ok: () => ({ status: 200, data: { prices: [[day('2025-10-08'), 2000], [day('2026-10-06'), 2500]] } }),
  empty: CG.empty,
  limited: CG.limited,
};
const CB = {
  ok: (url) => {
    const start = /start=(\d{4}-\d{2}-\d{2})/.exec(url)[1];
    return { status: 200, data: [[day(start) / 1000, 1, 2, 1, 1.5, 9]] };
  },
  empty: () => ({ status: 200, data: [] }),
  offshape: () => ({ status: 200, data: { message: 'maintenance' } }),
  unlisted: () => { throw httpError(404, { message: 'NotFound' }); },
  down: () => { throw httpError(500, {}); },
};
const BFX = {
  ok: () => ({ status: 200, data: [[day('2017-07-01'), 1, 2, 3, 1, 9], [day('2018-01-01'), 1, 9, 10, 1, 9]] }),
  empty: () => ({ status: 200, data: [] }),
  errorArray: () => ({ status: 200, data: ['error', 10020, 'symbol: invalid'] }),
  limited: () => { throw httpError(429, {}); },
  down: () => { throw httpError(500, {}); },
};

function router({ cg, cgNarrowed, cb, cbPartial, bfx }) {
  let cbPages = 0;
  return async (url) => {
    if (url.includes('coingecko.com')) {
      const from = Number(/from=(\d+)/.exec(url)[1]) * 1000;
      const narrowed = from > day('2025-01-01');
      if (narrowed && cgNarrowed) return CG_NARROWED[cgNarrowed](url);
      return CG[cg](url);
    }
    if (url.includes('exchange.coinbase.com')) {
      cbPages += 1;
      if (cbPartial && cbPages > 2) return CB.down(url);
      return CB[cb](url);
    }
    if (url.includes('bitfinex.com')) return BFX[bfx](url);
    throw new Error(`unexpected GET ${url}`);
  };
}

function scenarios() {
  const list = [];
  const nativeCg = ['ok', 'empty', 'offshape', 'unlisted', 'badKey', 'limited', 'down',
    'range', 'range+ok', 'range+empty', 'range+limited'];
  const split = (mode) => {
    const [cg, cgNarrowed] = mode.split('+');
    return { cg, cgNarrowed: cgNarrowed || null };
  };
  for (const firstDate of ['2017-06-01', '2026-06-01']) {
    for (const cgMode of nativeCg) {
      for (const cb of ['ok', 'empty', 'offshape', 'unlisted', 'down', 'partial']) {
        list.push({
          name: `native ${firstDate} cg=${cgMode} cb=${cb}`,
          asset: { asset_key: 'ETH', asset_symbol: 'ETH', first_date: firstDate },
          answers: { ...split(cgMode), cb: cb === 'partial' ? 'ok' : cb, cbPartial: cb === 'partial' },
        });
      }
      list.push({
        name: `token ${firstDate} cg=${cgMode}`,
        asset: { asset_key: `erc20:1:${TOKEN}`, asset_symbol: 'USDC', first_date: firstDate },
        answers: split(cgMode),
      });
    }
    list.push({
      name: `polygon native ${firstDate}`,
      asset: { asset_key: 'POL', asset_symbol: 'POL', first_date: firstDate },
      answers: { cg: 'range', cgNarrowed: 'ok', cb: 'ok' },
    });
  }
  list.push({
    name: 'token on a chain with no platform',
    asset: { asset_key: `erc20:999999:${TOKEN}`, asset_symbol: 'X', first_date: '2020-01-01' },
    answers: { cg: 'ok' },
  });
  list.push({
    name: 'native with no registry entry',
    asset: { asset_key: 'NOPE', asset_symbol: 'NOPE', first_date: '2020-01-01' },
    answers: { cg: 'ok', cb: 'ok' },
  });
  for (const firstDate of ['2017-06-01', '2017-07-01', '2018-03-01']) {
    for (const bfx of Object.keys(BFX)) {
      list.push({
        name: `alias ${firstDate} bfx=${bfx}`,
        asset: { asset_key: EOS_KEY, asset_symbol: 'EOS', first_date: firstDate },
        answers: { bfx },
      });
    }
  }
  return list;
}

async function run(scenario) {
  prices.length = 0;
  requests.length = 0;
  HistoricalPriceService.resetProviderPauses();
  handleGet = router(scenario.answers);
  const entry = await HistoricalPriceService.ensureAsset(scenario.asset, scenario.coverage || null);
  return {
    name: scenario.name,
    requests: [...requests],
    entry,
    stored: prices.map((p) => [p.price_date, p.price_usd, p.source]),
  };
}

test('every waterfall verdict and request sequence matches the recorded golden', async (t) => {
  mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-07T12:00:00Z') });
  t.after(() => mock.timers.reset());

  const results = [];
  for (const scenario of scenarios()) results.push(await run(scenario));

  if (process.env.GOLDEN_WRITE) {
    fs.mkdirSync(path.dirname(GOLDEN), { recursive: true });
    fs.writeFileSync(GOLDEN, `${JSON.stringify(results, null, 2)}\n`);
  }
  const golden = JSON.parse(fs.readFileSync(GOLDEN, 'utf8'));
  assert.equal(results.length, golden.length);
  for (let i = 0; i < golden.length; i++) {
    assert.deepEqual(JSON.parse(JSON.stringify(results[i])), golden[i], golden[i].name);
  }
});

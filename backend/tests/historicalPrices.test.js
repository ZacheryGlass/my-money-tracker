'use strict';

// Historical USD valuation (#73, migration 043): a dated price series, so a
// 2017 transfer is worth 2017 dollars.
//
// The pure halves -- the asset-key convention, the daily-close fold, the fetch
// window, the coverage cadence, the USD rollup -- are exercised directly. The
// stateful half runs against a fake pg Pool and a fake axios installed through
// require.cache, the same way ethActivity.test.js and exchangeSync.test.js do.

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = 'postgresql://test:test@localhost/test';

const WALLET = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const OTHER = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';
const DEAD_TOKEN = '0xdeaddeaddeaddeaddeaddeaddeaddeaddeaddead';
const NFT_CONTRACT = '0xd1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1';
const TX = '0x1111111111111111111111111111111111111111111111111111111111111111';
const TX2 = '0x2222222222222222222222222222222222222222222222222222222222222222';

const OWNER_ID = 1;
const OWNED_WALLET_ID = 1;

// --- the fake database -----------------------------------------------------

const db = {
  prices: [],      // {asset_key, price_date, price_usd, source}
  coverage: [],    // asset_price_coverage rows
  ledgerAssets: [],
  unpriced: [],
};
const queries = [];

function fakeQuery(text, params = []) {
  const sql = String(text).replace(/--[^\n]*/g, '').replace(/\s+/g, ' ').trim();
  queries.push({ sql, params });

  if (/^INSERT INTO asset_price_history/.test(sql)) {
    let upserted = 0;
    for (let i = 0; i < params.length; i += 4) {
      const row = {
        asset_key: params[i], price_date: params[i + 1],
        price_usd: params[i + 2], source: params[i + 3],
      };
      const existing = db.prices.find(
        (p) => p.asset_key === row.asset_key && p.price_date === row.price_date
      );
      if (existing) Object.assign(existing, row);
      else db.prices.push(row);
      upserted++;
    }
    return { rows: [], rowCount: upserted };
  }
  if (/^SELECT MIN\(price_date\) AS earliest/.test(sql)) {
    const rows = db.prices.filter((p) => p.asset_key === params[0]).map((p) => p.price_date).sort();
    return {
      rows: [{
        earliest: rows[0] || null,
        latest: rows[rows.length - 1] || null,
        points: rows.length,
      }],
    };
  }
  if (/^INSERT INTO asset_price_coverage/.test(sql)) {
    const [assetKey, assetSymbol, chainId, contractAddress, status, provider,
      earliestDate, latestDate, detail] = params;
    const row = {
      asset_key: assetKey, asset_symbol: assetSymbol, chain_id: chainId,
      contract_address: contractAddress, status, provider,
      earliest_date: earliestDate, latest_date: latestDate, detail,
      checked_at: new Date(),
    };
    const index = db.coverage.findIndex((c) => c.asset_key === assetKey);
    if (index >= 0) db.coverage[index] = row;
    else db.coverage.push(row);
    return { rows: [row] };
  }
  if (/^SELECT \* FROM asset_price_coverage WHERE asset_key = ANY/.test(sql)) {
    const wanted = new Set(params[0]);
    return { rows: db.coverage.filter((c) => wanted.has(c.asset_key)) };
  }
  if (/^SELECT CASE WHEN t\.transfer_type IN \('nft', 'nft1155'\) THEN NULL/.test(sql)) {
    // Both the job's work list and the unpriced enumeration open with the
    // asset-key CASE; the unpriced one filters on usd_basis.
    return { rows: /usd_basis = 'unpriced'/.test(sql) ? db.unpriced : db.ledgerAssets };
  }
  if (/^UPDATE eth_transfers up SET usd_at_time/.test(sql)) {
    return { rows: [], rowCount: 3 };
  }
  return { rows: [], rowCount: 0 };
}

const pgModulePath = require.resolve('pg');
require.cache[pgModulePath] = {
  id: pgModulePath,
  filename: pgModulePath,
  loaded: true,
  exports: {
    Pool: class FakePool {
      async query(text, params) { return fakeQuery(text, params); }
      async connect() {
        return { query: async (text, params) => fakeQuery(text, params), release() {} };
      }
      on() {}
    },
    types: { setTypeParser() {} },
  },
};

// --- the fake price providers ----------------------------------------------

let handleGet = null;
const requests = [];

const axiosModulePath = require.resolve('axios');
require.cache[axiosModulePath] = {
  id: axiosModulePath,
  filename: axiosModulePath,
  loaded: true,
  exports: {
    async get(url, config) {
      requests.push({ url, headers: config?.headers || {} });
      if (!handleGet) throw new Error(`unexpected GET ${url}`);
      return handleGet(url, config);
    },
    async post() { throw new Error('unexpected POST'); },
  },
};

// An axios-shaped rejection: the BODY is what distinguishes CoinGecko's
// "your plan stops at 365 days" from a bad key, so the fake has to carry it.
function httpError(status, data) {
  const error = new Error(`Request failed with status code ${status}`);
  error.response = { status, data };
  return error;
}

const request = require('supertest');
const app = require('../src/server');
const AssetPriceHistory = require('../src/models/AssetPriceHistory');
const HistoricalPriceService = require('../src/services/HistoricalPriceService');
const SecretsService = require('../src/services/SecretsService');
const {
  assetKeyForTransfer, tokenAssetKey, parseAssetKey, NATIVE_ASSET_KEY,
} = require('../src/utils/assetPriceKey');
const { buildActivityRows } = require('../src/services/EthActivityService');
const { buildMirrorRow } = require('../src/services/EthTransactionMirrorService');

// The service asks for the shared CoinGecko key on every request; the fake DB
// has no app_settings, so short-circuit it rather than exercising secrets here.
SecretsService.getAppSetting = async () => null;

// The real spacing is 2100 ms per CoinGecko call (30/min on the demo tier) and
// 250 ms for Coinbase. Against a fake axios those gaps buy nothing but minutes
// of suite time, so they are zeroed here -- the VALUES are asserted below,
// which is the part that has to be right.
const SHIPPED_SPACING = { ...HistoricalPriceService.PROVIDER_SPACING_MS };
HistoricalPriceService.PROVIDER_SPACING_MS.coingecko = 0;
HistoricalPriceService.PROVIDER_SPACING_MS.coingeckoPro = 0;
HistoricalPriceService.PROVIDER_SPACING_MS.coinbase = 0;

beforeEach(() => {
  db.prices = [];
  db.coverage = [];
  db.ledgerAssets = [];
  db.unpriced = [];
  queries.length = 0;
  requests.length = 0;
  handleGet = null;
  // A 429 shuts the CoinGecko queue for the rest of the RUN; a direct
  // ensureAsset call is its own run, so each test starts with it open.
  HistoricalPriceService.resetProviderPauses();
});

// --- the asset key ---------------------------------------------------------

test('an asset key is a chain-scoped contract, never a ticker', () => {
  assert.equal(assetKeyForTransfer({ transfer_type: 'native' }), 'ETH');
  assert.equal(assetKeyForTransfer({ transfer_type: 'internal' }), 'ETH');
  assert.equal(assetKeyForTransfer({ transfer_type: 'gas' }), 'ETH');

  // Same contract address, two chains, two assets. Pooling them is the 039
  // trap: the wrong platform answers "unknown", which reads as a pricing
  // outage that never resolves rather than as an error.
  assert.equal(assetKeyForTransfer({ transfer_type: 'token', chain_id: 1, token_contract: USDC }),
    `erc20:1:${USDC}`);
  assert.equal(assetKeyForTransfer({ transfer_type: 'token', chain_id: 42161, token_contract: USDC }),
    `erc20:42161:${USDC}`);
  assert.notEqual(tokenAssetKey(1, USDC), tokenAssetKey(42161, USDC));

  // Case never forks a key: the feed lowercases contracts, and one stray
  // checksum-cased row would otherwise become a second, permanently unpriced
  // asset.
  assert.equal(tokenAssetKey(1, USDC.toUpperCase().replace('0X', '0x')), `erc20:1:${USDC}`);

  // NFT valuation is out of scope, and value_wei on those rows is a COUNT OF
  // UNITS -- a key would invite exactly that confusion.
  assert.equal(assetKeyForTransfer({ transfer_type: 'nft', token_contract: NFT_CONTRACT }), null);
  assert.equal(assetKeyForTransfer({ transfer_type: 'nft1155', token_contract: NFT_CONTRACT }), null);
  // A token row with no contract is malformed, not native.
  assert.equal(assetKeyForTransfer({ transfer_type: 'token', chain_id: 1, token_contract: null }), null);
});

test('parseAssetKey is the exact inverse, and rejects anything else', () => {
  assert.deepEqual(parseAssetKey('ETH'), { kind: 'native', chainId: null, contract: null });
  assert.deepEqual(parseAssetKey(`erc20:42161:${USDC}`),
    { kind: 'erc20', chainId: 42161, contract: USDC });
  assert.equal(parseAssetKey('erc20:1:not-an-address'), null);
  assert.equal(parseAssetKey('erc721:1:0x00'), null);
  assert.equal(parseAssetKey(''), null);
  assert.equal(parseAssetKey(null), null);
});

test('the SQL key expression is built from the same parts as the JS one', () => {
  // The valuation runs in SQL and the ledger reads it back in JS; if the two
  // key forms drifted, every token row would be valued against a key nothing
  // ever writes and would silently go unpriced.
  const sql = AssetPriceHistory.assetKeySql('t').replace(/\s+/g, ' ');
  assert.ok(sql.includes(`ELSE '${NATIVE_ASSET_KEY}'`));
  assert.ok(sql.includes("'erc20:' || t.chain_id || ':' || LOWER(t.token_contract)"));
  assert.ok(sql.includes("t.transfer_type IN ('nft', 'nft1155') THEN NULL"));
});

// --- the daily convention --------------------------------------------------

test('a day takes its LAST observation, and junk points are dropped', () => {
  const folded = HistoricalPriceService.foldToDailyClose([
    [Date.parse('2017-06-12T01:00:00Z'), 300],
    [Date.parse('2017-06-12T23:00:00Z'), 350],   // later on the same UTC day wins
    [Date.parse('2017-06-13T00:00:00Z'), 360],
    [Date.parse('2017-06-11T12:00:00Z'), 280],
    [Date.parse('2017-06-14T00:00:00Z'), null],  // dropped
    [Date.parse('2017-06-15T00:00:00Z'), -5],    // dropped: a price is never negative
  ]);

  assert.deepEqual(folded, [
    { date: '2017-06-11', price: 280 },
    { date: '2017-06-12', price: 350 },
    { date: '2017-06-13', price: 360 },
  ]);
});

test('the fold is UTC, not local, so a series cannot shift by a day', () => {
  // 23:30Z belongs to the 23rd everywhere. A local-time fold would file it
  // under the 24th for anyone east of Greenwich and the 23rd for anyone west,
  // making the stored series depend on where the server happens to run.
  const folded = HistoricalPriceService.foldToDailyClose([
    [Date.parse('2021-11-23T23:30:00Z'), 4200],
  ]);
  assert.deepEqual(folded, [{ date: '2021-11-23', price: 4200 }]);
});

// --- the fetch window ------------------------------------------------------

test('the first run fetches the whole history; later runs only the trailing edge', async () => {
  const first = await HistoricalPriceService.missingWindow('ETH', '2017-01-01', '2026-07-26');
  assert.deepEqual(first, { from: '2017-01-01', to: '2026-07-26' });

  db.prices = [
    { asset_key: 'ETH', price_date: '2017-01-01' },
    { asset_key: 'ETH', price_date: '2026-07-25' },
  ];
  const steady = await HistoricalPriceService.missingWindow('ETH', '2017-01-01', '2026-07-26');
  // Two days of overlap, deliberately: the close stored for a day that had not
  // finished is provisional and re-fetching corrects it.
  assert.deepEqual(steady, { from: '2026-07-23', to: '2026-07-26' });
});

test('adding an older wallet re-fetches the history the series never covered', async () => {
  db.prices = [
    { asset_key: 'ETH', price_date: '2025-01-01' },
    { asset_key: 'ETH', price_date: '2026-07-25' },
  ];
  // The ledger now reaches back to 2017 and the series starts in 2025. Resuming
  // at the trailing edge would leave eight years permanently unpriced.
  const window = await HistoricalPriceService.missingWindow('ETH', '2017-06-01', '2026-07-26');
  assert.deepEqual(window, { from: '2017-06-01', to: '2026-07-26' });
});

// --- coverage cadence ------------------------------------------------------

test('a dead token is asked once, not every night, but is not written off forever', () => {
  assert.equal(HistoricalPriceService.shouldFetch(null), true);
  assert.equal(HistoricalPriceService.shouldFetch({ status: 'covered' }), true);
  assert.equal(HistoricalPriceService.shouldFetch({ status: 'error' }), true);
  assert.equal(HistoricalPriceService.shouldFetch({ status: 'range_limited' }), true);

  const yesterday = new Date(Date.now() - 86400000);
  assert.equal(HistoricalPriceService.shouldFetch({ status: 'unlisted', checked_at: yesterday }), false);

  // A token CAN get listed later, and a verdict nothing ever revisits is
  // indistinguishable from a bug.
  const longAgo = new Date(Date.now() - 40 * 86400000);
  assert.equal(HistoricalPriceService.shouldFetch({ status: 'unlisted', checked_at: longAgo }), true);
});

// --- providers -------------------------------------------------------------

test('CoinGecko refusing 2017 falls through to Coinbase, which actually has it', async () => {
  // The exact live answer: HTTP 401 carrying error_code 10012.
  handleGet = async (url) => {
    if (url.includes('api.coingecko.com')) {
      // The exact body shape observed live, nesting and all.
      throw httpError(401, {
        error: {
          status: {
            timestamp: '2026-07-26T16:26:33.461+00:00',
            error_code: 10012,
            error_message: 'Your request exceeds the allowed time range. Public API users are limited to querying historical data within the past 365 days.',
          },
        },
      });
    }
    if (url.includes('api.exchange.coinbase.com')) {
      // [time, low, high, open, close, volume]; time is the bucket START in
      // seconds and close is that day's close. The first candle sits on the
      // window's first day, which is what makes this a COVERED fill rather than
      // a series that stops short of the dates the ledger asked for.
      return {
        status: 200,
        data: [
          [Date.parse('2017-06-01T00:00:00Z') / 1000, 200, 260, 210, 250, 999],
          [Date.parse('2017-06-12T00:00:00Z') / 1000, 290, 400, 300, 350, 1234],
        ],
      };
    }
    throw new Error(`unexpected GET ${url}`);
  };

  const entry = await HistoricalPriceService.ensureAsset({
    asset_key: 'ETH', asset_symbol: 'ETH', first_date: '2017-06-01',
  });

  assert.equal(entry.status, 'covered');
  assert.equal(entry.provider, 'coinbase-exchange');
  assert.match(entry.detail, /365 days/);
  assert.deepEqual(db.prices.map((p) => [p.price_date, p.price_usd, p.source]),
    [['2017-06-01', '250', 'coinbase-exchange'], ['2017-06-12', '350', 'coinbase-exchange']]);
});

test('a series that stops short of the ledger reports range_limited, not covered', async () => {
  // A non-empty response is not a covered window. The fill starts eleven days
  // after the date the ledger needs, so those rows stay unpriced -- and a green
  // tick over them is exactly the kind of quiet claim #73 exists to remove.
  handleGet = async (url) => {
    if (url.includes('api.coingecko.com')) {
      throw httpError(401, { error: { status: { error_code: 10012 } } });
    }
    return {
      status: 200,
      data: [[Date.parse('2017-06-12T00:00:00Z') / 1000, 290, 400, 300, 350, 1234]],
    };
  };

  const entry = await HistoricalPriceService.ensureAsset({
    asset_key: 'ETH', asset_symbol: 'ETH', first_date: '2017-06-01',
  });

  assert.equal(entry.status, 'range_limited');
  assert.equal(entry.earliestDate, '2017-06-12');
  assert.equal(db.prices.length, 1, 'the closes that DID land are still stored');
});

test('the Coinbase walk pages under the 300-candle cap instead of being truncated', async () => {
  const windows = [];
  handleGet = async (url) => {
    if (url.includes('api.coingecko.com')) {
      throw httpError(401, { error: { status: { error_code: 10012 } } });
    }
    const start = /start=(\d{4}-\d{2}-\d{2})/.exec(url)[1];
    const end = /end=(\d{4}-\d{2}-\d{2})/.exec(url)[1];
    windows.push([start, end]);
    return { status: 200, data: [[Date.parse(`${start}T00:00:00Z`) / 1000, 1, 2, 1, 1.5, 9]] };
  };

  await HistoricalPriceService.ensureAsset({
    asset_key: 'ETH', asset_symbol: 'ETH', first_date: '2016-05-18',
  });

  assert.ok(windows.length > 10, 'a decade cannot fit in one 300-candle page');
  const spanDays = ([start, end]) => (Date.parse(end) - Date.parse(start)) / 86400000 + 1;
  for (const window of windows) {
    // Exceeding the cap answers an error, not a short page, so a walk that
    // overshot would lose whole years silently.
    assert.ok(spanDays(window) <= 300, `page ${window.join('..')} exceeds the cap`);
  }
  // Contiguous: a gap between pages is a gap in the series.
  for (let i = 1; i < windows.length; i++) {
    const previousEnd = Date.parse(windows[i - 1][1]);
    assert.equal(Date.parse(windows[i][0]), previousEnd + 86400000);
  }
});

test('a token is asked against its own chain platform, and a 404 is a permanent verdict', async () => {
  handleGet = async () => { throw httpError(404, { error: 'coin not found' }); };

  const entry = await HistoricalPriceService.ensureAsset({
    asset_key: `erc20:1:${DEAD_TOKEN}`, asset_symbol: 'DEAD', first_date: '2017-03-01',
  });

  assert.equal(entry.status, 'unlisted');
  assert.equal(entry.upserted, 0);
  assert.equal(db.prices.length, 0, 'an unlisted token stores no prices, least of all $0');
  assert.ok(requests[0].url.includes(`/coins/ethereum/contract/${DEAD_TOKEN}/market_chart/range`));
  // No fiat-pair fallback for a token: Coinbase has no notion of a contract.
  assert.equal(requests.filter((r) => r.url.includes('coinbase')).length, 0);
});

test('a token refused for 2017 still gets the year the plan WILL serve', async () => {
  // Tokens have no fiat-pair fallback -- Coinbase has no notion of a contract
  // address -- so a plan cap on the full window used to leave them with no
  // prices at all, which the ledger renders as $0.00 on every token row. The
  // cap is a property of the WINDOW, so the narrowed retry is the whole fix.
  const asked = [];
  handleGet = async (url) => {
    const from = Number(/from=(\d+)/.exec(url)[1]);
    asked.push(new Date(from * 1000).toISOString().slice(0, 10));
    if (from < Date.parse('2025-01-01T00:00:00Z') / 1000) {
      throw httpError(401, { error: { status: { error_code: 10012 } } });
    }
    return { status: 200, data: { prices: [[Date.parse('2026-07-25T00:00:00Z'), 1.0]] } };
  };

  const entry = await HistoricalPriceService.ensureAsset({
    asset_key: `erc20:1:${USDC}`, asset_symbol: 'USDC', first_date: '2017-03-01',
  });

  assert.equal(asked.length, 2, 'refused once at the full window, retried narrowed');
  assert.equal(asked[0], '2017-03-01');
  assert.ok(asked[1] > '2025-01-01', 'the retry is inside the plan cap');
  // NOT 'covered': the years before the cap are genuinely missing, and calling
  // that covered would hide them behind a green tick.
  assert.equal(entry.status, 'range_limited');
  assert.equal(db.prices.length, 1);
});

test('a capped asset is not re-asked for a decade it will never get', async () => {
  // Without a provider floor, missingWindow sees "the ledger reaches further
  // back than the series" on every run, so every run spends a guaranteed
  // refusal re-asking for history the plan has already declined.
  db.prices = [
    { asset_key: `erc20:1:${USDC}`, price_date: '2025-08-01' },
    { asset_key: `erc20:1:${USDC}`, price_date: '2026-07-25' },
  ];
  const asked = [];
  handleGet = async (url) => {
    asked.push(new Date(Number(/from=(\d+)/.exec(url)[1]) * 1000).toISOString().slice(0, 10));
    return { status: 200, data: { prices: [[Date.parse('2026-07-26T00:00:00Z'), 1.0]] } };
  };

  await HistoricalPriceService.ensureAsset(
    { asset_key: `erc20:1:${USDC}`, asset_symbol: 'USDC', first_date: '2017-03-01' },
    { status: 'range_limited', earliest_date: '2025-08-01', checked_at: new Date() }
  );

  assert.equal(asked.length, 1, 'one call, not a refusal plus a retry');
  // The trailing edge only: two days back from the stored latest.
  assert.equal(asked[0], '2026-07-23');
});

test("a token's window starts at its own history, not at ETH's listing date", async () => {
  // NATIVE_HISTORY_START is Coinbase's ETH-USD listing (2016-05-18). Clamping a
  // 2015-era ERC-20 to it would drop its first year, and since the stored
  // earliest would then equal the wanted one, nothing would ever re-ask.
  const asked = [];
  handleGet = async (url) => {
    asked.push(new Date(Number(/from=(\d+)/.exec(url)[1]) * 1000).toISOString().slice(0, 10));
    return { status: 200, data: { prices: [[Date.parse('2015-09-01T00:00:00Z'), 0.5]] } };
  };

  await HistoricalPriceService.ensureAsset({
    asset_key: `erc20:1:${USDC}`, asset_symbol: 'OLD', first_date: '2015-08-01',
  });
  assert.equal(asked[0], '2015-08-01');

  // The native asset still IS clamped: asking Coinbase for pre-listing ETH only
  // burns calls to be told nothing.
  asked.length = 0;
  db.prices = [];
  await HistoricalPriceService.ensureAsset({
    asset_key: 'ETH', asset_symbol: 'ETH', first_date: '2014-01-01',
  });
  assert.equal(asked[0], HistoricalPriceService.NATIVE_HISTORY_START);
});

test('a chain with no CoinGecko platform is never guessed at', async () => {
  handleGet = async () => { throw new Error('must not be called'); };
  const entry = await HistoricalPriceService.ensureAsset({
    asset_key: `erc20:999999:${USDC}`, asset_symbol: 'USDC', first_date: '2024-01-01',
  });
  assert.equal(entry.status, 'unlisted');
  assert.match(entry.detail, /no CoinGecko asset platform/);
  assert.equal(requests.length, 0);
});

test('an off-shape 200 is a transient error, never a cached "no series"', async () => {
  // The same rule the method-signature cache applies to Sourcify: storing
  // "unlisted" for a healthy asset would freeze it unpriced until someone
  // noticed by hand.
  handleGet = async () => ({ status: 200, data: { unexpected: true } });
  const entry = await HistoricalPriceService.ensureAsset({
    asset_key: `erc20:1:${USDC}`, asset_symbol: 'USDC', first_date: '2024-01-01',
  });
  assert.equal(entry.status, 'error');
  assert.notEqual(entry.status, 'unlisted');
  assert.equal(HistoricalPriceService.shouldFetch({ status: 'error' }), true);
});

test('the backfill skips assets already written off and reports what it deferred', async () => {
  db.ledgerAssets = [
    { asset_key: 'ETH', asset_symbol: 'ETH', first_date: '2024-01-01', transfer_count: 50 },
    { asset_key: `erc20:1:${USDC}`, asset_symbol: 'USDC', first_date: '2024-01-01', transfer_count: 10 },
    { asset_key: `erc20:1:${DEAD_TOKEN}`, asset_symbol: 'DEAD', first_date: '2017-01-01', transfer_count: 2 },
  ];
  db.coverage = [{ asset_key: `erc20:1:${DEAD_TOKEN}`, status: 'unlisted', checked_at: new Date() }];
  handleGet = async () => ({
    status: 200,
    // Reaching the window's first day, so the fill is genuinely covered.
    data: {
      prices: [
        [Date.parse('2024-01-01T00:00:00Z'), 2200],
        [Date.parse('2026-07-25T00:00:00Z'), 3000],
      ],
    },
  });

  const summary = await HistoricalPriceService.backfillLedgerAssets({ maxAssets: 1 });

  assert.equal(summary.assets, 3);
  assert.equal(summary.skippedKnown, 1, 'the dead token is not re-probed');
  assert.equal(summary.fetched, 1);
  // A silently truncated run reads as "everything is covered"; it is not.
  assert.equal(summary.deferred, 1);
  assert.equal(summary.covered, 1);
  assert.equal(requests.filter((r) => r.url.includes(DEAD_TOKEN)).length, 0);
});

test('the request spacing shipped is the one the provider limits allow', () => {
  // 250 ms is 240 calls/min. CoinGecko's demo tier allows 30, so a shared
  // 250 ms queue put every call after the first thirty into a 429 -- and with
  // the work list ordered the same way every night, always the SAME thirty.
  assert.ok(SHIPPED_SPACING.coingecko >= 2100, 'demo tier is 30 calls/min');
  assert.ok(SHIPPED_SPACING.coinbase <= 250, 'Coinbase public market data is ~10 req/s');
  // A paid key buys 500+/min; keeping it at 2.1 s would make a 200-asset budget
  // a seven-minute walk for no reason.
  assert.ok(SHIPPED_SPACING.coingeckoPro <= 250);
});

test('a 429 pauses CoinGecko for the run and writes NO coverage verdict', async () => {
  // A rate limit says nothing about the asset. Recording `error` per asset
  // would invent a provider verdict AND refresh checked_at, so a run that died
  // at asset 31 would look exactly like one that examined all 200.
  db.ledgerAssets = [
    { asset_key: `erc20:1:${USDC}`, asset_symbol: 'USDC', first_date: '2024-01-01', transfer_count: 9 },
    { asset_key: `erc20:1:${DEAD_TOKEN}`, asset_symbol: 'DEAD', first_date: '2024-01-01', transfer_count: 8 },
  ];
  handleGet = async () => { throw httpError(429, { status: { error_code: 429 } }); };

  const summary = await HistoricalPriceService.backfillLedgerAssets();

  assert.equal(summary.rateLimited, 2);
  assert.equal(summary.failed, 0, 'not an error: the assets were never examined');
  assert.equal(db.coverage.length, 0, 'no verdict is written, so both stay due');
  // Only the FIRST call goes out; the queue is shut for the rest of the run.
  assert.equal(requests.length, 1);
});

test('an empty series is a verdict of its own, not an error re-probed nightly', async () => {
  handleGet = async () => ({ status: 200, data: { prices: [] } });

  const entry = await HistoricalPriceService.ensureAsset({
    asset_key: `erc20:1:${DEAD_TOKEN}`, asset_symbol: 'DEAD', first_date: '2018-01-01',
  });

  assert.equal(entry.status, 'empty');
  assert.equal(db.prices.length, 0);
  // Same slow cadence as `unlisted`: a series can appear later, but asking
  // every night is what the coverage table exists to stop.
  assert.equal(HistoricalPriceService.shouldFetch({ status: 'empty', checked_at: new Date() }), false);
  assert.equal(
    HistoricalPriceService.shouldFetch({ status: 'empty', checked_at: new Date(Date.now() - 40 * 86400000) }),
    true
  );
});

test('a covered series already reaching yesterday does not spend the budget', () => {
  const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  const twoDaysAgo = new Date(Date.now() - 2 * 86400000).toISOString().slice(0, 10);
  assert.equal(
    HistoricalPriceService.shouldFetch({ status: 'covered', latest_date: yesterday }), false);
  // Two days stale IS due -- and that run also corrects the provisional close
  // stored for the day that had not finished.
  assert.equal(
    HistoricalPriceService.shouldFetch({ status: 'covered', latest_date: twoDaysAgo }), true);
});

test('the budget rotates by staleness, so the tail is deferred and not starved', async () => {
  // The work list is ordered by transfer count, which barely changes -- so
  // slicing the top N out of it handed the same assets the whole budget every
  // run and the tail was never reached at all.
  const stale = new Date(Date.now() - 10 * 86400000);
  db.ledgerAssets = [
    { asset_key: 'ETH', asset_symbol: 'ETH', first_date: '2024-01-01', transfer_count: 500 },
    { asset_key: `erc20:1:${USDC}`, asset_symbol: 'USDC', first_date: '2024-01-01', transfer_count: 2 },
  ];
  db.coverage = [
    { asset_key: 'ETH', status: 'range_limited', checked_at: new Date() },
    { asset_key: `erc20:1:${USDC}`, status: 'range_limited', checked_at: stale },
  ];
  handleGet = async () => ({ status: 200, data: { prices: [[Date.parse('2026-07-25T00:00:00Z'), 1]] } });

  await HistoricalPriceService.backfillLedgerAssets({ maxAssets: 1 });

  assert.equal(requests.length, 1);
  assert.ok(requests[0].url.includes(USDC), 'the longest-unchecked asset goes first');
});

test('re-running the backfill over a window it already holds changes nothing', async () => {
  db.ledgerAssets = [{ asset_key: 'ETH', asset_symbol: 'ETH', first_date: '2026-07-01', transfer_count: 1 }];
  handleGet = async () => ({
    status: 200,
    data: {
      prices: [
        [Date.parse('2026-07-24T00:00:00Z'), 3000],
        [Date.parse('2026-07-25T00:00:00Z'), 3100],
      ],
    },
  });

  await HistoricalPriceService.backfillLedgerAssets();
  const afterFirst = JSON.stringify(db.prices);
  await HistoricalPriceService.backfillLedgerAssets();

  assert.equal(JSON.stringify(db.prices), afterFirst, 'the backfill is idempotent');
  assert.equal(db.prices.length, 2);
});

// --- the valuation statement ----------------------------------------------

test('the valuation is one exact-NUMERIC SQL pass that cannot reach a current price', async () => {
  await AssetPriceHistory.applyToWallet(OWNED_WALLET_ID);
  const update = queries.find((q) => /^UPDATE eth_transfers up SET usd_at_time/.test(q.sql));
  assert.ok(update, 'the valuation runs as a single UPDATE');

  // The bug this replaces: a current price reaching a historical row.
  assert.ok(!/price_cache/.test(update.sql));
  assert.ok(!/CURRENT_DATE/.test(update.sql));
  // The carry window is bounded and one-directional.
  assert.ok(/price_date <= t\.block_time::date/.test(update.sql));
  assert.ok(new RegExp(`price_date >= t\\.block_time::date - ${AssetPriceHistory.MAX_CARRY_DAYS}`).test(update.sql));
  // Exact NUMERIC, never a float cast.
  assert.ok(/::numeric/.test(update.sql));
  assert.ok(!/float8|::float|::real|::double/.test(update.sql));
  // Decimals are resolved per (chain, contract), the same repair the activity
  // builder makes. Etherscan omits tokenDecimal on some legs of a contract it
  // fills in on others; scaling one of those by a blind 18 would put $0.00 and
  // "6 FOO" on the same row.
  assert.ok(/MIN\(t\.token_decimals\) OVER \(PARTITION BY t\.chain_id, t\.token_contract\)/.test(update.sql));
  // The whole basis vocabulary, and nothing invented.
  for (const basis of ['exact', 'carried', 'unpriced', 'not_applicable']) {
    assert.ok(update.sql.includes(`'${basis}'`), `basis ${basis} is written`);
  }
});

test('the unpriced enumeration is fail-closed and reports the provider verdict', async () => {
  await assert.rejects(() => AssetPriceHistory.unpricedAssetsForUser(null), /requires a userId/);

  db.unpriced = [
    { asset_key: `erc20:1:${DEAD_TOKEN}`, asset_symbol: 'DEAD', chain_id: 1, contract_address: DEAD_TOKEN, transfer_count: 4 },
    { asset_key: `erc20:1:${USDC}`, asset_symbol: 'USDC', chain_id: 1, contract_address: USDC, transfer_count: 1 },
  ];
  db.coverage = [{
    asset_key: `erc20:1:${DEAD_TOKEN}`, status: 'unlisted',
    detail: 'CoinGecko has no series for this asset', checked_at: new Date(),
  }];

  const assets = await AssetPriceHistory.unpricedAssetsForUser(OWNER_ID);
  assert.equal(assets.length, 2);
  assert.equal(assets[0].coverage_status, 'unlisted');
  assert.match(assets[0].coverage_detail, /no series/);
  // No coverage row means "the job has not reached this yet", which is not the
  // same claim as "no provider has it".
  assert.equal(assets[1].coverage_status, 'pending');

  const scoped = queries.find((q) => /usd_basis = 'unpriced'/.test(q.sql));
  assert.ok(/JOIN eth_wallets w ON w\.id = t\.wallet_id/.test(scoped.sql));
  assert.ok(/w\.user_id = \$1/.test(scoped.sql));
  assert.equal(scoped.params[0], OWNER_ID);
  // NULL means "never valued", which the ledger ALSO renders as $0.00 -- the
  // exact silently-zero state this endpoint exists to expose. Matches 043's
  // index predicate.
  assert.ok(/t\.usd_basis IS NULL OR t\.usd_basis = 'unpriced'/.test(scoped.sql));
});

test('GET /api/eth/prices/unpriced enumerates them for the calling user only', async () => {
  db.unpriced = [{
    asset_key: `erc20:1:${DEAD_TOKEN}`, asset_symbol: 'DEAD', chain_id: 1,
    contract_address: DEAD_TOKEN, transfer_count: 4,
  }];
  db.coverage = [{
    asset_key: `erc20:1:${DEAD_TOKEN}`, status: 'unlisted',
    detail: 'CoinGecko has no series for this asset', checked_at: new Date(),
  }];

  const response = await request(app).get('/api/eth/prices/unpriced');
  assert.equal(response.status, 200);
  assert.equal(response.body.total, 1);
  assert.equal(response.body.data[0].asset_symbol, 'DEAD');
  assert.equal(response.body.data[0].coverage_status, 'unlisted');

  // The enumeration is scoped through the wallet join to the CALLER, using the
  // dev-stub identity the other route tests use.
  const scoped = queries.filter((q) => /usd_basis = 'unpriced'/.test(q.sql)).pop();
  assert.equal(scoped.params[0], OWNER_ID);
});

// --- the rollup onto activity rows -----------------------------------------

function leg(overrides = {}) {
  return {
    wallet_id: OWNED_WALLET_ID,
    chain_id: 1,
    tx_hash: TX,
    transfer_type: 'native',
    block_number: 100,
    block_time: new Date('2017-06-12T14:00:00Z'),
    from_address: WALLET,
    to_address: OTHER,
    value_wei: '0',
    token_contract: null,
    token_symbol: null,
    token_decimals: null,
    token_standard: null,
    token_id: null,
    is_error: false,
    tx_is_error: false,
    counterparty_is_own: false,
    counterparty_exchange: null,
    method_id: null,
    method_name: null,
    usd_at_time: null,
    usd_basis: 'unpriced',
    ...overrides,
  };
}

const gasLeg = (overrides = {}) => leg({
  transfer_type: 'gas', to_address: OTHER, value_wei: '1000000000000000',
  usd_at_time: '2.50', usd_basis: 'exact', ...overrides,
});

test('a 2017 send carries 2017 dollars all the way to the activity row', () => {
  const [row] = buildActivityRows(WALLET, [
    leg({ value_wei: '500000000000000000', usd_at_time: '150.00', usd_basis: 'exact' }), // 0.5 ETH
    gasLeg(),
  ]);

  assert.equal(row.category, 'send');
  assert.equal(row.usd_value, 150);
  assert.equal(row.usd_fee, 2.5);
  assert.equal(row.usd_basis, 'exact');
  assert.equal(row.legs[0].usd, 150);
  assert.equal(row.legs[0].usd_basis, 'exact');
  // The ETH amount is the stable fact; the dollars derive from it.
  assert.equal(row.legs[0].amount, '0.5');
});

test('a swap is valued on ONE side, not both', () => {
  const [row] = buildActivityRows(WALLET, [
    leg({ value_wei: '1000000000000000000', usd_at_time: '3000.00', usd_basis: 'exact' }),
    leg({
      transfer_type: 'token', from_address: OTHER, to_address: WALLET,
      token_contract: USDC, token_symbol: 'USDC', token_decimals: 6,
      token_standard: 'erc20', value_wei: '3000000000',
      usd_at_time: '3000.00', usd_basis: 'exact',
    }),
    gasLeg(),
  ]);

  assert.equal(row.category, 'swap');
  // 1 ETH out for 3,000 USDC in is a $3,000 event, not a $6,000 one.
  assert.equal(row.usd_value, 3000);
  assert.equal(row.legs.length, 2);
});

test('one unpriced leg makes the transaction unpriced, never a partial sum', () => {
  const [row] = buildActivityRows(WALLET, [
    leg({
      transfer_type: 'token', token_contract: DEAD_TOKEN, token_symbol: 'DEAD',
      token_decimals: 18, token_standard: 'erc20', value_wei: '5000000000000000000',
      usd_at_time: null, usd_basis: 'unpriced',
    }),
    gasLeg(),
  ]);

  // NULL, not 0. A partial sum presented as a total is the silent-zero failure
  // wearing a different hat.
  assert.equal(row.usd_value, null);
  assert.equal(row.usd_basis, 'unpriced');
  assert.equal(row.legs[0].usd, null);
  assert.equal(row.legs[0].usd_basis, 'unpriced');
  // The fee is a separate, real fact and survives.
  assert.equal(row.usd_fee, 2.5);
});

test('a leg from the wallet to itself nets its dollars away, like its quantity', () => {
  // Both `incoming` and `outgoing` are true for a self-directed leg, so the
  // quantity nets to zero. A ternary on `incoming` would ADD its dollars and
  // never subtract them, reporting "2 ETH out, worth $300" for a $600 outflow.
  const [row] = buildActivityRows(WALLET, [
    leg({
      to_address: WALLET, value_wei: '1000000000000000000',
      usd_at_time: '300.00', usd_basis: 'exact',
    }),
    leg({
      block_number: 101, value_wei: '2000000000000000000',
      usd_at_time: '600.00', usd_basis: 'exact',
    }),
    gasLeg(),
  ]);

  assert.equal(row.legs.length, 1);
  assert.equal(row.legs[0].amount, '2');
  assert.equal(row.legs[0].usd, 600);
  assert.equal(row.usd_value, 600);
});

test('a carried close is a real valuation and says so', () => {
  const [row] = buildActivityRows(WALLET, [
    leg({ value_wei: '1000000000000000000', usd_at_time: '2950.00', usd_basis: 'carried' }),
    gasLeg(),
  ]);
  assert.equal(row.usd_value, 2950);
  assert.equal(row.usd_basis, 'carried');
});

test('the weakest basis across a transaction wins', () => {
  const [row] = buildActivityRows(WALLET, [
    leg({ value_wei: '1000000000000000000', usd_at_time: '3000.00', usd_basis: 'exact' }),
    leg({
      transfer_type: 'token', token_contract: USDC, token_symbol: 'USDC',
      token_decimals: 6, token_standard: 'erc20', value_wei: '1000000',
      usd_at_time: '1.00', usd_basis: 'carried',
    }),
    gasLeg(),
  ]);
  // Both outbound, so both feed usd_value; one carried close makes the total
  // carried rather than exact.
  assert.equal(row.usd_basis, 'carried');
  assert.equal(row.usd_value, 3001);
});

test('an NFT purchase is valued by the ETH that was actually paid', () => {
  const [row] = buildActivityRows(WALLET, [
    leg({ value_wei: '200000000000000000', usd_at_time: '400.00', usd_basis: 'exact' }), // 0.2 ETH
    leg({
      transfer_type: 'nft', from_address: OTHER, to_address: WALLET,
      token_contract: NFT_CONTRACT, token_symbol: 'PUNK', token_id: '42',
      token_standard: 'erc721', token_decimals: 0, value_wei: '1',
      usd_at_time: null, usd_basis: 'not_applicable',
    }),
    gasLeg(),
  ]);

  assert.equal(row.category, 'nft_purchase');
  // NFT valuation is out of scope; the ETH leg already IS the at-the-time
  // value, and the NFT leg's value_wei is a COUNT OF UNITS.
  assert.equal(row.usd_value, 400);
  assert.equal(row.usd_basis, 'exact');
  const nftLeg = row.legs.find((entry) => entry.token_standard === 'erc721');
  assert.equal(nftLeg.usd, null);
  assert.equal(nftLeg.usd_basis, 'not_applicable');
  assert.equal(nftLeg.amount, '1');
});

test('a reverted transaction has a real fee and no value', () => {
  const [row] = buildActivityRows(WALLET, [
    leg({
      tx_hash: TX2, is_error: true, value_wei: '1000000000000000000',
      usd_at_time: null, usd_basis: 'not_applicable',
    }),
    gasLeg({ tx_hash: TX2 }),
  ]);

  assert.equal(row.category, 'failed');
  assert.equal(row.usd_value, null);
  assert.equal(row.usd_basis, 'not_applicable');
  // The fee did not fail.
  assert.equal(row.usd_fee, 2.5);
});

test('valuation is netted in cents, so a rebuild cannot drift by a fraction', () => {
  // Three legs of the same asset whose dollar values are not representable in
  // binary floating point. Summing parsed dollars lands this at 8.209999...;
  // integer cents lands it exactly.
  const legs = ['0.29', '2.87', '5.05'].map((usd, i) => leg({
    transfer_type: 'token', token_contract: USDC, token_symbol: 'USDC',
    token_decimals: 6, token_standard: 'erc20', value_wei: '1000000',
    block_number: 100 + i, usd_at_time: usd, usd_basis: 'exact',
  }));
  const [row] = buildActivityRows(WALLET, [...legs, gasLeg()]);
  assert.equal(row.usd_value, 8.21);
});

test('the same legs rebuild to byte-identical valuations', () => {
  const legs = [
    leg({ value_wei: '500000000000000000', usd_at_time: '150.00', usd_basis: 'exact' }),
    gasLeg(),
  ];
  const first = buildActivityRows(WALLET, legs);
  const second = buildActivityRows(WALLET, legs);
  // The acceptance criterion, stated as code: re-running classification does
  // not drift valuations, because nothing here consults a clock or a network.
  assert.equal(JSON.stringify(first), JSON.stringify(second));
});

test('the mirror and the activity row agree on what a leg was worth', () => {
  // Both read the same stored column. Before #73 they each fetched their own
  // price and could disagree by a whole market move.
  const valued = leg({ value_wei: '500000000000000000', usd_at_time: '150.00', usd_basis: 'exact' });
  const [row] = buildActivityRows(WALLET, [valued, gasLeg()]);
  const mirrored = buildMirrorRow(valued, WALLET);
  assert.equal(mirrored.amount, row.usd_value);
});

// --- the nightly job's post-loop passes (#76) --------------------------------
//
// rebuildForWallet REPLACES the wallet's eth_activity rows, and that DELETE
// cascades eth_activity_links away with them. So the 08:10 job must re-run the
// two user-wide passes the sync job runs, or every bridge pair is destroyed for
// the rest of the day and one $6,000 bridge renders as two rows summing $12,000.

const historicalPriceJob = require('../src/jobs/historicalPriceJob');
const JobLog = require('../src/models/JobLog');
const EthWallet = require('../src/models/EthWallet');
const EthTransactionMirrorService = require('../src/services/EthTransactionMirrorService');
const EthActivityService = require('../src/services/EthActivityService');
const ExchangeMatchService = require('../src/services/ExchangeMatchService');

async function runJobWithStubs(wallets, { failMatchesFor = null } = {}) {
  const calls = [];
  const saved = {
    isRunning: JobLog.isRunning, create: JobLog.create, complete: JobLog.complete,
    fail: JobLog.fail,
    findAllForJobs: EthWallet.findAllForJobs,
    applyToWallet: AssetPriceHistory.applyToWallet,
    backfill: HistoricalPriceService.backfillLedgerAssets,
    mirror: EthTransactionMirrorService.rebuildForWallet,
    activity: EthActivityService.rebuildForWallet,
    bridge: EthActivityService.matchBridgeTransfersForUser,
    matches: ExchangeMatchService.rebuildForUserSafely,
  };
  JobLog.isRunning = async () => false;
  JobLog.create = async () => ({ id: 1 });
  JobLog.complete = async () => {};
  JobLog.fail = async () => {};
  EthWallet.findAllForJobs = async () => wallets;
  AssetPriceHistory.applyToWallet = async () => 0;
  HistoricalPriceService.backfillLedgerAssets = async () => ({
    assets: 0, covered: 0, rangeLimited: 0, failed: 0,
  });
  EthTransactionMirrorService.rebuildForWallet = async (id) => { calls.push(['mirror', id]); };
  EthActivityService.rebuildForWallet = async (id, options) => {
    calls.push(['activity', id, options]);
  };
  EthActivityService.matchBridgeTransfersForUser = async (userId) => {
    calls.push(['bridge', userId]);
  };
  ExchangeMatchService.rebuildForUserSafely = async (userId, context) => {
    calls.push(['matches', userId, context]);
    if (userId === failMatchesFor) throw new Error('match rebuild blew up');
    return {};
  };
  try {
    const result = await historicalPriceJob.run();
    return { calls, result };
  } finally {
    JobLog.isRunning = saved.isRunning;
    JobLog.create = saved.create;
    JobLog.complete = saved.complete;
    JobLog.fail = saved.fail;
    EthWallet.findAllForJobs = saved.findAllForJobs;
    AssetPriceHistory.applyToWallet = saved.applyToWallet;
    HistoricalPriceService.backfillLedgerAssets = saved.backfill;
    EthTransactionMirrorService.rebuildForWallet = saved.mirror;
    EthActivityService.rebuildForWallet = saved.activity;
    EthActivityService.matchBridgeTransfersForUser = saved.bridge;
    ExchangeMatchService.rebuildForUserSafely = saved.matches;
  }
}

test('the nightly job re-runs the match and bridge passes once per user', async () => {
  const { calls } = await runJobWithStubs([
    { id: 1, user_id: OWNER_ID },
    { id: 2, user_id: OWNER_ID },
    { id: 3, user_id: 2 },
  ]);

  // Per wallet: the match rebuild is suppressed, so it does not re-derive the
  // owner's whole match set once per wallet against a half-rebuilt feed.
  const activity = calls.filter((c) => c[0] === 'activity');
  assert.equal(activity.length, 3);
  for (const call of activity) assert.equal(call[2].rebuildMatches, false);

  // Per USER, after the loop: both passes, exactly once each.
  assert.deepEqual(
    calls.filter((c) => c[0] === 'matches').map((c) => c[1]),
    [OWNER_ID, 2]
  );
  assert.deepEqual(
    calls.filter((c) => c[0] === 'bridge').map((c) => c[1]),
    [OWNER_ID, 2]
  );
  // And after every wallet has landed -- a bridge_out on one wallet pairs with
  // a bridge_in on another, so pairing cannot be decided mid-loop.
  const lastActivity = calls.map((c) => c[0]).lastIndexOf('activity');
  const firstBridge = calls.map((c) => c[0]).indexOf('bridge');
  assert.ok(firstBridge > lastActivity);
});

test('one user\'s failed post-loop pass does not skip the next user\'s', async () => {
  const { calls } = await runJobWithStubs(
    [{ id: 1, user_id: OWNER_ID }, { id: 2, user_id: 2 }],
    { failMatchesFor: OWNER_ID }
  );

  // User 1's match pass throws, so its bridge pass is skipped -- but user 2's
  // pair still runs. Per-user isolation, the same shape the wallet loop uses.
  assert.deepEqual(calls.filter((c) => c[0] === 'bridge').map((c) => c[1]), [2]);
  assert.deepEqual(calls.filter((c) => c[0] === 'matches').map((c) => c[1]), [OWNER_ID, 2]);
});

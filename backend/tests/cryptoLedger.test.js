'use strict';

// The unified crypto ledger (#63): one chronological stream over eth_activity
// and exchange_records, with a matched pair rendered once.
//
// Three things are worth pinning here, and they are what this file covers:
//
//  1. The filters are FAIL-CLOSED. An unknown ?category= or ?source= is a 400,
//     never the unfiltered feed -- a review queue whose filter silently widens
//     reads as "there is nothing else", which is the opposite of the promise.
//  2. The query orders on TIME and scopes BOTH sources. block_number is a
//     per-chain sequence (039) and an exchange record has no block at all, so
//     ordering on it would interleave a multi-chain, multi-source feed wrongly;
//     and either branch losing its user join leaks another user's history.
//  3. The row mapper normalizes both sources into one shape -- exact decimal
//     strings, never floats -- and the CSV export carries a folded pair's venue
//     half onto the same line.
//
// Runs against a fake pg Pool installed through require.cache, the same harness
// ethActivity.test.js and exchangeRoutes.test.js use.

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = 'postgresql://test:test@localhost/test';

const OWNER_ID = 1;
const OWNED_WALLET_ID = 1;
const OWNED_ACCOUNT_ID = 7;
const FOREIGN_ID = 99;

const TX = '0x1111111111111111111111111111111111111111111111111111111111111111';
const WALLET = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const EXCHANGE_ADDR = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

// --- the fake database -----------------------------------------------------

// Raw rows as the UNION would emit them: every column of the common shape, on
// both branches. `ledgerRows` is what the ledger query returns; the fake does
// not re-implement the SQL -- the point of these tests is the layers ABOVE it
// (validation, mapping, export) plus assertions on the SQL text itself.
let ledgerRows = [];
const queries = [];

function onchainRow(overrides = {}) {
  return {
    source: 'onchain',
    row_id: 10,
    occurred_at: new Date('2026-03-02T00:00:00Z'),
    category: 'swap',
    needs_review: false,
    review_reason: null,
    wallet_id: OWNED_WALLET_ID,
    chain_id: 42161,
    tx_hash: TX,
    block_number: '300000000',
    counterparty_address: EXCHANGE_ADDR,
    counterparty_name: null,
    method_id: '0x38ed1739',
    method_name: 'swapExactTokensForTokens(uint256,uint256,address[],address,uint256)',
    legs: [
      { asset: 'ETH', direction: 'out', amount: '0.5' },
      { asset: 'USDC', direction: 'in', amount: '1832.4' },
    ],
    // 21000 * 40 gwei, as NUMERIC(78,0) comes back: a string.
    fee_wei: '840000000000000',
    confidence: 'high',
    derived_category: 'swap',
    override_category: null,
    override_note: null,
    is_overridden: false,
    wallet_address: WALLET,
    wallet_label: 'Main',
    exchange_account_id: null,
    exchange: null,
    account_name: null,
    record_type: null,
    base_asset: null,
    base_amount: null,
    quote_asset: null,
    quote_amount: null,
    fee_asset: null,
    fee_amount: null,
    external_id: null,
    record_address: null,
    record_source: null,
    exchange_matches: [],
    ...overrides,
  };
}

function exchangeRow(overrides = {}) {
  return {
    ...onchainRow(),
    source: 'exchange',
    row_id: 55,
    occurred_at: new Date('2026-03-01T00:00:00Z'),
    category: 'exchange_trade',
    needs_review: true,
    review_reason: null,
    wallet_id: null,
    chain_id: null,
    tx_hash: null,
    block_number: null,
    counterparty_address: null,
    counterparty_name: null,
    method_id: null,
    method_name: null,
    legs: [],
    fee_wei: null,
    confidence: null,
    derived_category: null,
    is_overridden: false,
    wallet_address: null,
    wallet_label: null,
    exchange_account_id: OWNED_ACCOUNT_ID,
    exchange: 'kraken',
    account_name: 'Kraken',
    record_type: 'trade',
    // NUMERIC(38,18) arrives fully padded, and signed as the venue wrote it.
    base_asset: 'ETH',
    base_amount: '-0.500000000000000000',
    quote_asset: 'USD',
    quote_amount: '1832.400000000000000000',
    fee_asset: 'USD',
    fee_amount: '4.760000000000000000',
    external_id: 'LEDGER-1',
    record_address: null,
    record_source: 'api',
    exchange_matches: [],
    ...overrides,
  };
}

function fakeQuery(text, params = []) {
  const sql = String(text).replace(/--[^\n]*/g, '').replace(/\s+/g, ' ').trim();
  queries.push({ sql, params });

  if (/^SELECT \* FROM eth_wallets WHERE id = \$1 AND user_id = \$2/.test(sql)) {
    const [id, userId] = params;
    return { rows: id === OWNED_WALLET_ID && userId === OWNER_ID ? [{ id, user_id: userId, address: WALLET }] : [] };
  }
  if (/FROM exchange_accounts WHERE id = \$1 AND user_id = \$2/.test(sql)) {
    const [id, userId] = params;
    return { rows: id === OWNED_ACCOUNT_ID && userId === OWNER_ID ? [{ id, user_id: userId, name: 'Kraken' }] : [] };
  }
  if (/SELECT COUNT\(\*\)::int AS total,/.test(sql) && /FROM \(SELECT \* FROM onchain UNION ALL/.test(sql)) {
    return {
      rows: [{
        total: ledgerRows.length,
        needs_review_count: ledgerRows.filter((r) => r.needs_review).length,
        onchain_count: ledgerRows.filter((r) => r.source === 'onchain').length,
        exchange_count: ledgerRows.filter((r) => r.source === 'exchange').length,
        onchain_needs_review: 0,
        exchange_needs_review: 0,
        matched_count: ledgerRows.filter((r) => (r.exchange_matches || []).length > 0).length,
        first_at: null,
        last_at: null,
      }],
    };
  }
  if (/FROM \(SELECT \* FROM onchain UNION ALL SELECT \* FROM exch\) r/.test(sql)) {
    return { rows: ledgerRows.map((row) => ({ ...row, total_count: ledgerRows.length })) };
  }
  return { rows: [] };
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

const request = require('supertest');
const app = require('../src/server');
const CryptoLedger = require('../src/models/CryptoLedger');

const lastLedgerQuery = () => queries.filter((q) => /UNION ALL SELECT \* FROM exch/.test(q.sql)).at(-1);

beforeEach(() => {
  queries.length = 0;
  ledgerRows = [];
});

// --- fail-closed filters ---------------------------------------------------

test('an unknown category is a 400, never a silently unfiltered ledger', async () => {
  const response = await request(app).get('/api/crypto/ledger?category=stakingreward');
  assert.equal(response.status, 400);
  assert.match(response.body.error, /Unknown category/);
  assert.equal(lastLedgerQuery(), undefined, 'the query must not run at all');
});

test('an unknown source is a 400', async () => {
  const response = await request(app).get('/api/crypto/ledger?source=chain');
  assert.equal(response.status, 400);
  assert.match(response.body.error, /source must be one of/);
});

test("needs_review only accepts 'true' or 'false'", async () => {
  const response = await request(app).get('/api/crypto/ledger?needs_review=yes');
  assert.equal(response.status, 400);
  assert.match(response.body.error, /needs_review/);
});

// Every category the client can offer has to be one the server accepts, or the
// picker holds a dead option that 400s the whole feed.
test('every advertised category is accepted', async () => {
  for (const category of CryptoLedger.CATEGORIES) {
    const response = await request(app).get(`/api/crypto/ledger?category=${category}`);
    assert.equal(response.status, 200, `category ${category} was rejected`);
  }
});

test('the two exchange-only categories exist beside the activity vocabulary', () => {
  assert.deepEqual(CryptoLedger.EXCHANGE_ONLY_CATEGORIES, ['fee', 'exchange_transfer']);
  // 'exchange_transfer' is deliberately NOT self_transfer: an unrecognized
  // venue row says nothing about whether both ends are the user's.
  assert.ok(!CryptoLedger.CATEGORIES.includes('self_transfer_exchange'));
});

test('a foreign wallet id is a 404, not a feed widened back to every wallet', async () => {
  const response = await request(app).get(`/api/crypto/ledger?wallet_id=${FOREIGN_ID}`);
  assert.equal(response.status, 404);
  assert.equal(lastLedgerQuery(), undefined);
});

test('a foreign exchange account id is a 404', async () => {
  const response = await request(app).get(`/api/crypto/ledger?exchange_account_id=${FOREIGN_ID}`);
  assert.equal(response.status, 404);
  assert.equal(lastLedgerQuery(), undefined);
});

test('an owned wallet id narrows the query rather than being ignored', async () => {
  const response = await request(app).get(`/api/crypto/ledger?wallet_id=${OWNED_WALLET_ID}&category=swap&needs_review=false`);
  assert.equal(response.status, 200);
  const { sql, params } = lastLedgerQuery();
  assert.match(sql, /r\.wallet_id = \$\d+/);
  assert.match(sql, /r\.category = \$\d+/);
  assert.match(sql, /r\.needs_review = \$\d+/);
  assert.ok(params.includes(OWNED_WALLET_ID));
  assert.ok(params.includes('swap'));
  assert.ok(params.includes(false));
});

// --- the query's own invariants --------------------------------------------

test('the ledger orders by time, never by block number', async () => {
  await request(app).get('/api/crypto/ledger');
  const { sql } = lastLedgerQuery();
  // block_number is a PER-CHAIN sequence and an exchange record has none, so
  // it cannot appear in the merged ordering at all.
  const orderBy = sql.slice(sql.lastIndexOf('ORDER BY'));
  assert.match(orderBy, /ORDER BY r\.occurred_at DESC/);
  assert.ok(!/block_number/.test(orderBy), 'block_number must not order a merged feed');
  // The tiebreak has to be total or LIMIT/OFFSET repeats one row and drops
  // another: neither id is unique across the union, the pair is.
  assert.match(orderBy, /r\.source DESC, r\.row_id DESC/);
});

test('both sources are scoped to the caller inside the query', async () => {
  await request(app).get('/api/crypto/ledger');
  const { sql, params } = lastLedgerQuery();
  assert.equal(params[0], OWNER_ID);
  assert.match(sql, /FROM eth_activity a JOIN eth_wallets w ON w\.id = a\.wallet_id/);
  assert.match(sql, /WHERE w\.user_id = \$1/);
  assert.match(sql, /JOIN exchange_accounts ea ON ea\.id = er\.exchange_account_id WHERE ea\.user_id = \$1/);
});

// A folded record is suppressed from its own branch, so if a filter only ever
// tested the HOST's columns the event would appear nowhere at all -- and that
// is the normal case, not a corner one: the venue files a "withdrawal" for the
// transaction the wallet files as a deposit.
test('a folded record still answers to its own source, category and account', async () => {
  await request(app).get('/api/crypto/ledger?source=exchange');
  const bySource = lastLedgerQuery().sql;
  assert.match(bySource, /r\.source = \$\d+ OR \(\$\d+ = 'exchange' AND jsonb_array_length\(r\.exchange_matches\) > 0\)/);

  await request(app).get('/api/crypto/ledger?category=exchange_withdrawal');
  assert.match(lastLedgerQuery().sql, /r\.category = \$\d+ OR \$\d+ = ANY\(r\.match_categories\)/);

  await request(app).get(`/api/crypto/ledger?exchange_account_id=${OWNED_ACCOUNT_ID}`);
  assert.match(lastLedgerQuery().sql, /r\.exchange_account_id = \$\d+ OR \$\d+ = ANY\(r\.match_account_ids\)/);
});

test('a folded amount leaves Postgres as text, never a JSON number', async () => {
  await request(app).get('/api/crypto/ledger');
  const { sql } = lastLedgerQuery();
  // jsonb_build_object emits a NUMERIC as a JSON number, and node-pg parses
  // jsonb with JSON.parse -- so without the cast a folded amount arrives as a
  // double: exponent notation below 1e-6, lost digits above 2^53.
  assert.match(sql, /'base_amount', er\.base_amount::text/);
  assert.match(sql, /'quote_amount', er\.quote_amount::text/);
  assert.match(sql, /'fee_amount', er\.fee_amount::text/);
});

test('a matched exchange record is folded exactly once, by hash', async () => {
  await request(app).get('/api/crypto/ledger');
  const { sql } = lastLedgerQuery();
  // DISTINCT ON (er.id): the same hash can belong to two activity rows when
  // two of the user's own wallets are both party to it, and exchange_records
  // has no chain column. Without it the record renders once per match.
  assert.match(sql, /SELECT DISTINCT ON \(er\.id\) er\.id AS record_id, a\.id AS activity_id/);
  assert.match(sql, /LOWER\(a\.tx_hash\) = LOWER\(er\.tx_hash\)/);
  // ... and is suppressed from its own branch, or it appears twice.
  assert.match(sql, /NOT EXISTS \(SELECT 1 FROM matched mm WHERE mm\.record_id = er\.id\)/);
});

// --- the row shape ---------------------------------------------------------

test('an on-chain row carries netted legs and gas scaled exactly', async () => {
  ledgerRows = [onchainRow()];
  const response = await request(app).get('/api/crypto/ledger');
  assert.equal(response.status, 200);
  const [row] = response.body.data;

  // Keyed on (chain, hash, wallet) -- eth_activity's UNIQUE -- NOT on its
  // BIGSERIAL id: the table is deleted and rebuilt on every sync and every
  // label write, so an id-keyed client loses the row it had open the moment a
  // relabel reclassifies the history.
  assert.equal(row.id, `onchain:42161:${TX}:${OWNED_WALLET_ID}`);
  assert.equal(row.source, 'onchain');
  assert.equal(row.row_id, 10, 'the underlying id still rides along');
  // The chain's own name, so the ledger says WHERE without shipping a registry
  // constant on every row.
  assert.equal(row.source_label, 'Arbitrum One');
  assert.deepEqual(row.legs, [
    { asset: 'ETH', direction: 'out', amount: '0.5' },
    { asset: 'USDC', direction: 'in', amount: '1832.4' },
  ]);
  // wei -> whole units through BigInt: Number('840000000000000')/1e18 is
  // 0.00084 only by luck, and most gas figures have more significant digits
  // than a double holds.
  assert.equal(row.fee_amount, '0.00084');
  assert.equal(row.fee_asset, 'ETH');
});

test('an exchange row is turned into the same leg shape, signs intact', async () => {
  ledgerRows = [exchangeRow()];
  const response = await request(app).get('/api/crypto/ledger');
  const [row] = response.body.data;

  assert.equal(row.id, 'exchange:55');
  // The venue account's own name, not a chain.
  assert.equal(row.source_label, 'Kraken');
  assert.equal(row.category, 'exchange_trade');
  assert.deepEqual(row.legs, [
    // Amounts are stored SIGNED as the venue wrote them; the sign IS the
    // direction, and the padding is stripped without going through a float.
    { asset: 'ETH', direction: 'out', amount: '0.5' },
    { asset: 'USD', direction: 'in', amount: '1832.4' },
  ]);
  assert.equal(row.fee_amount, '4.76');
  assert.equal(row.fee_asset, 'USD');
  assert.equal(row.needs_review, true);
});

test('a zero-amount quote leg is dropped rather than rendered as a 0 movement', async () => {
  ledgerRows = [exchangeRow({ quote_asset: 'USD', quote_amount: '0.000000000000000000' })];
  const response = await request(app).get('/api/crypto/ledger');
  const [row] = response.body.data;
  assert.deepEqual(row.legs.map((leg) => leg.asset), ['ETH']);
});

test('an override is resolved over the derived verdict and clears the flag', async () => {
  ledgerRows = [onchainRow({
    category: 'spend',
    derived_category: 'send',
    override_category: 'spend',
    override_note: 'Bought a domain',
    is_overridden: true,
    needs_review: false,
  })];
  const response = await request(app).get('/api/crypto/ledger');
  const [row] = response.body.data;
  assert.equal(row.category, 'spend');
  assert.equal(row.derived_category, 'send');
  assert.equal(row.is_overridden, true);
  assert.equal(row.needs_review, false);
});

test('the summary counts every source and is not filtered by the feed', async () => {
  ledgerRows = [onchainRow(), exchangeRow()];
  const response = await request(app).get('/api/crypto/ledger/summary');
  assert.equal(response.status, 200);
  assert.equal(response.body.summary.total, 2);
  assert.equal(response.body.summary.onchain_count, 1);
  assert.equal(response.body.summary.exchange_count, 1);
  assert.equal(response.body.summary.needs_review_count, 1);
});

// --- CSV export ------------------------------------------------------------

test('the CSV export is columns, not a rendered sentence', async () => {
  ledgerRows = [onchainRow()];
  const response = await request(app).get('/api/crypto/ledger/export');
  assert.equal(response.status, 200);
  assert.match(response.headers['content-type'], /text\/csv/);
  assert.match(response.headers['content-disposition'], /crypto-ledger\.csv/);

  const [header, first] = response.text.trim().split('\n');
  // Assets in and out get their own columns: "0.5 ETH -> 1,832.4 USDC" reads
  // well and cannot be summed, which is the whole point of a spreadsheet.
  assert.equal(header, 'date,source,location,category,counterparty,assets_in,assets_out,fee_amount,fee_asset,needs_review,tx_hash,chain_id,external_id,note');
  assert.match(first, /1832\.4 USDC/);
  assert.match(first, /0\.5 ETH/);
  assert.match(first, /Arbitrum One/);
  assert.match(first, /,no,/);
});

test('the export carries a folded pair’s venue half onto the same line', async () => {
  ledgerRows = [onchainRow({
    category: 'exchange_deposit',
    legs: [{ asset: 'ETH', direction: 'out', amount: '1.25' }],
    exchange_matches: [{
      id: 55, exchange_account_id: OWNED_ACCOUNT_ID, account_name: 'Kraken', exchange: 'kraken',
      record_type: 'deposit', base_asset: 'ETH', base_amount: '1.250000000000000000',
      quote_asset: null, quote_amount: null, needs_review: false, external_id: 'DEP-1',
    }],
  })];
  const response = await request(app).get('/api/crypto/ledger/export');
  const [, line] = response.text.trim().split('\n');
  // One line, both halves: the wallet's outflow and the venue's credit.
  assert.match(line, /1\.25 ETH/);
  assert.equal(line.split('1.25 ETH').length - 1, 2, 'both halves belong on the folded line');
  // The venue account names the counterparty when the chain side has no label.
  assert.match(line, /Kraken/);
});

// A counterparty NAME is attacker-reachable: it comes from a user label or
// from the 5k scraped builtin pack. Excel and Sheets evaluate a cell that
// OPENS with a formula character the moment the file is opened, and quoting
// alone does not stop it.
test('a name that opens with a formula character cannot execute on open', async () => {
  ledgerRows = [onchainRow({
    counterparty_name: '=cmd|\'/c calc\'!A1',
    override_note: '@SUM(1+1)',
  })];
  const response = await request(app).get('/api/crypto/ledger/export');
  const [, line] = response.text.trim().split('\n');
  assert.ok(!/,"?=cmd/.test(line), 'a formula must not open a cell');
  assert.match(line, /'=cmd/);
  assert.match(line, /'@SUM/);
  // Numeric columns stay untouched, or a fee stops being a number to a
  // spreadsheet -- which is the entire reason the file is a CSV.
  assert.match(line, /,0\.00084,ETH,/);
});

// A leg cell always OPENS with its amount, so it is safe as written; the guard
// is there for the day an amount is absent, not because a symbol can lead.
test('a hostile token symbol rides along without leading its cell', async () => {
  ledgerRows = [onchainRow({ legs: [{ asset: '=HYPERLINK("x")', direction: 'in', amount: '1' }] })];
  const response = await request(app).get('/api/crypto/ledger/export');
  const [, line] = response.text.trim().split('\n');
  assert.match(line, /1 =HYPERLINK/);
  assert.ok(!/,"?=HYPERLINK/.test(line));
});

test('the export honours the same filters as the feed and refuses the same junk', async () => {
  const rejected = await request(app).get('/api/crypto/ledger/export?category=nonsense');
  assert.equal(rejected.status, 400);

  ledgerRows = [onchainRow()];
  const ok = await request(app).get('/api/crypto/ledger/export?source=onchain');
  assert.equal(ok.status, 200);
  const { sql, params } = lastLedgerQuery();
  assert.match(sql, /r\.source = \$\d+/);
  assert.ok(params.includes('onchain'));
  // Truncation has to be announceable: a silent cut at the cap looks exactly
  // like "that is the whole history".
  assert.equal(ok.headers['x-row-count'], '1');
  assert.ok(Number(ok.headers['x-row-limit']) > 0);
});

// --- exact decimal helpers -------------------------------------------------

test('wei is scaled through BigInt, so no precision is invented or lost', () => {
  const { weiToDecimalString, trimDecimal } = CryptoLedger;
  assert.equal(weiToDecimalString('1000000000000000000'), '1');
  assert.equal(weiToDecimalString('1'), '0.000000000000000001');
  // 19 significant digits: past what a double can represent exactly.
  assert.equal(weiToDecimalString('1234567890123456789'), '1.234567890123456789');
  assert.equal(weiToDecimalString('0'), '0');
  assert.equal(weiToDecimalString(null), null);
  assert.equal(trimDecimal('-0.500000000000000000'), '-0.5');
  assert.equal(trimDecimal('0.000000000000000000'), '0');
  assert.equal(trimDecimal('1832'), '1832');
});

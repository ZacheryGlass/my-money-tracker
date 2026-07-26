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
    // At-the-time dollars (043), NUMERIC -> string.
    usd_value: '1832.40',
    usd_fee: '2.35',
    usd_basis: 'exact',
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
    exchange_match: null,
    match_category: null,
    match_account_id: null,
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
  if (/AS total, /.test(sql) && /FROM \(SELECT \* FROM onchain UNION ALL/.test(sql)) {
    // The counts the summary query would produce. Quarantined rows are excluded
    // from every count and reported on their own, which is the contract
    // summaryForUser states in SQL and this fake has to mirror.
    const visible = ledgerRows.filter((r) => !r.spam);
    return {
      rows: [{
        total: visible.length,
        needs_review_count: visible.filter((r) => r.needs_review).length,
        onchain_count: visible.filter((r) => r.source === 'onchain').length,
        exchange_count: visible.filter((r) => r.source === 'exchange').length,
        onchain_needs_review: 0,
        exchange_needs_review: 0,
        matched_count: visible.filter((r) => r.exchange_match).length,
        bridge_matched_count: visible.filter((r) => r.bridge_match).length,
        spam_count: ledgerRows.filter((r) => r.spam).length,
        unpriced_count: visible.filter((r) => r.usd_basis === 'unpriced').length,
        carried_count: 0,
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

// The FEED query, not the scalar count findForUser falls back to when a page
// comes back empty (COUNT(*) OVER() rides on returned rows, so an out-of-range
// offset has no count to read). Both run the same CTE; only the feed is the one
// these assertions are about.
const lastLedgerQuery = () => queries
  .filter((q) => /UNION ALL SELECT \* FROM exch/.test(q.sql) && !/COUNT\(\*\)::int AS total_count/.test(q.sql))
  .at(-1);

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

// --- the spam quarantine (#74) ---------------------------------------------

test('an unknown spam filter is a 400, not a feed that quietly shows everything', async () => {
  const response = await request(app).get('/api/crypto/ledger?spam=hide');
  assert.equal(response.status, 400);
  assert.match(response.body.error, /spam must be one of/);
  assert.equal(lastLedgerQuery(), undefined, 'the query must not run at all');
});

test('the ledger speaks the SAME spam vocabulary as the activity feed', () => {
  // Two readers over the same quarantined rows. A value that works on one page
  // and 400s on the other is a filter nobody can trust.
  assert.deepEqual(CryptoLedger.SPAM_FILTERS, ['exclude', 'only', 'all']);
});

test('quarantined rows are excluded by default, without being asked for', async () => {
  await request(app).get('/api/crypto/ledger');
  // The flagship "no transaction unexplained" screen must not re-surface the
  // noise 045 removed. NOT r.spam is the default, present with no ?spam= at all.
  assert.match(lastLedgerQuery().sql, /WHERE NOT r\.spam/);
});

test("?spam=only is the Spam view and ?spam=all lifts the filter entirely", async () => {
  await request(app).get('/api/crypto/ledger?spam=only');
  assert.match(lastLedgerQuery().sql, /WHERE r\.spam/);

  await request(app).get('/api/crypto/ledger?spam=all');
  assert.ok(!/r\.spam/.test(lastLedgerQuery().sql.split('FROM (SELECT')[1] || ''),
    'all means no spam predicate at all');
});

test('the resolved verdict decides, and a quarantined row is not "unexplained"', async () => {
  await request(app).get('/api/crypto/ledger');
  const { sql } = lastLedgerQuery();
  // COALESCE(override, derived), exactly as EthActivity's readers resolve it.
  assert.match(sql, /COALESCE\(o\.spam, a\.spam\) AS spam/);
  // ...and needs_review is MASKED by it rather than stored cleared, which is
  // what makes an un-quarantine lossless: the flag comes back with the row.
  assert.match(sql, /o\.category IS NOT NULL OR COALESCE\(o\.spam, a\.spam\) THEN FALSE/);
  assert.match(sql, /o\.category IS NOT NULL OR COALESCE\(o\.spam, a\.spam\) THEN NULL/);
});

test('a collapse group is quarantined only when EVERY half is', async () => {
  await request(app).get('/api/crypto/ledger');
  const { sql } = lastLedgerQuery();
  // BOOL_AND, opposite to needs_review's BOOL_OR, and deliberately: a missed
  // flag leaves a visible row unexplained, while a wrong quarantine HIDES a
  // real movement -- so one half saying "this is real" renders the event.
  assert.match(sql, /BOOL_AND\(q\.spam\) OVER \(PARTITION BY q\.chain_id, q\.tx_hash\)/);
});

test('a venue record can never be quarantined, and never NULL either', async () => {
  await request(app).get('/api/crypto/ledger');
  // NULL on the exchange branch would make `NOT r.spam` drop the whole venue
  // side of the ledger silently.
  assert.match(lastLedgerQuery().sql, /FALSE AS spam, NULL::text AS spam_reason/);
});

test('the summary excludes the quarantine from its counts and says how many', async () => {
  ledgerRows = [onchainRow(), onchainRow({ row_id: 11, spam: true, spam_reason: 'address_poisoning' })];
  const response = await request(app).get('/api/crypto/ledger/summary');
  assert.equal(response.body.summary.total, 1);
  // Hiding rows without stating the number is the one thing a quarantine must
  // not do -- it is indistinguishable from a sync that never fetched them.
  assert.equal(response.body.summary.spam_count, 1);
});

test('a quarantined row exported on request says so, with its reason', async () => {
  ledgerRows = [onchainRow({ spam: true, spam_reason: 'unsolicited_token' })];
  const response = await request(app).get('/api/crypto/ledger/export?spam=only');
  const [header, line] = response.text.trim().split('\n');
  assert.equal(line.split(',')[header.split(',').indexOf('quarantined')], 'unsolicited_token');
});

// --- the bridge fold (#59) -------------------------------------------------

test('a linked bridge pair folds into one row hosted by the out side', async () => {
  await request(app).get('/api/crypto/ledger');
  const { sql } = lastLedgerQuery();
  // Read from 044's link table, not re-derived: the matching pass already
  // decided these two transactions are one movement.
  assert.match(sql, /LEFT JOIN eth_activity_links lo ON lo\.out_activity_id = a\.id/);
  assert.match(sql, /LEFT JOIN eth_activity_links li ON li\.in_activity_id = a\.id/);
  // The IN side is suppressed only when its OUT side is in this same,
  // user-scoped CTE -- which is what keeps a cross-user link from folding.
  assert.match(sql, /FROM onchain_collapsed i WHERE h\.bridge_role = 'out' AND i\.bridge_role = 'in'/);
  assert.match(sql, /h\.bridge_role IS DISTINCT FROM 'in'/);
  // Never a join to the counterpart activity row: eth_activity_links has no
  // owner column, so reaching through it would render another user's row.
  assert.ok(!/JOIN eth_activity pair/.test(sql));
});

test('the folded bridge half stays addressable by wallet and by category', async () => {
  await request(app).get('/api/crypto/ledger?category=bridge_in');
  const { sql } = lastLedgerQuery();
  // The in side was suppressed from its own row, so a filter that only tested
  // the host's column would return nothing while the event is right there.
  assert.match(sql, /OR r\.bridge_category = \$\d+/);
  assert.match(sql, /ARRAY\[i\.wallet_id\] \|\| COALESCE\(i\.fold_wallet_ids/);
});

test('a folded bridge pair reports itself once in the export', async () => {
  ledgerRows = [onchainRow({
    category: 'bridge_out',
    chain_id: 1,
    legs: [{ asset: 'ETH', direction: 'out', amount: '3' }],
    usd_value: '6000.00',
    bridge_match: {
      link_id: 4, wallet_id: 1, wallet_label: 'Main', chain_id: 42161,
      tx_hash: TX, category: 'bridge_in', needs_review: false,
      legs: [{ asset: 'ETH', direction: 'in', amount: '2.998' }],
      usd_value: '5996.00', usd_basis: 'exact',
      asset: 'ETH', out_amount: '3', in_amount: '2.998', fee_amount: '0.002',
    },
  })];
  const response = await request(app).get('/api/crypto/ledger/export');
  const lines = response.text.trim().split('\n');
  const [header, line] = lines;
  const cell = (name) => line.split(',')[header.split(',').indexOf(name)];

  assert.equal(lines.length, 2, 'one movement, one line');
  // The arrival is the SAME money landing, so it is not added to assets_in --
  // the identical rule the exchange fold and the self-transfer collapse follow.
  assert.equal(cell('assets_out'), '3 ETH');
  assert.equal(cell('assets_in'), '');
  // Trimmed off NUMERIC(38,18), and the far side's 5,996 is nowhere in the row.
  assert.equal(cell('usd_value'), '6000');
  // ...and the line SAYS what it already accounts for, so a reader summing the
  // export can see the pair is one movement.
  assert.match(cell('matched_with'), /Arbitrum One/);
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
  assert.match(bySource, /r\.source = \$\d+ OR \(\$\d+ = 'exchange' AND r\.exchange_match IS NOT NULL\)/);

  await request(app).get('/api/crypto/ledger?category=exchange_withdrawal');
  assert.match(lastLedgerQuery().sql, /r\.category = \$\d+ OR r\.match_category = \$\d+/);

  await request(app).get(`/api/crypto/ledger?exchange_account_id=${OWNED_ACCOUNT_ID}`);
  assert.match(lastLedgerQuery().sql, /r\.exchange_account_id = \$\d+ OR r\.match_account_id = \$\d+/);
});

test('a folded amount leaves Postgres as text, never a JSON number', async () => {
  await request(app).get('/api/crypto/ledger');
  const { sql } = lastLedgerQuery();
  // jsonb_build_object emits a NUMERIC as a JSON number, and node-pg parses
  // jsonb with JSON.parse -- so without the cast a folded amount arrives as a
  // double: exponent notation below 1e-6, lost digits above 2^53.
  assert.match(sql, /'base_amount', mer\.base_amount::text/);
  assert.match(sql, /'quote_amount', mer\.quote_amount::text/);
  assert.match(sql, /'fee_amount', mer\.fee_amount::text/);
});

// The fold is #61's matcher, not a hash comparison done here. Re-deriving one
// would be a second matcher disagreeing with the first -- and it would lose the
// evidence, the confidence and the user verdict that make a pairing judgeable.
test('the fold reads exchange_matches rather than re-deriving a matcher', async () => {
  await request(app).get('/api/crypto/ledger');
  const { sql } = lastLedgerQuery();
  assert.match(sql, /LEFT JOIN exchange_matches em ON em\.activity_id = a\.id/);
  assert.match(sql, /LEFT JOIN exchange_match_verdicts mv/);
  assert.ok(!/LOWER\(a\.tx_hash\) = LOWER\(er\.tx_hash\)/.test(sql),
    'no second hash matcher of our own');
  // Both of 041's shapes are accounted for: a record folded into an on-chain
  // row, and a counter record folded into its pair's primary.
  assert.match(sql, /JOIN eth_activity a ON a\.id = em\.activity_id/);
  assert.match(sql, /em\.counter_record_id IS NOT NULL/);
  // ... and a folded record is suppressed from its own branch, or it renders
  // twice.
  assert.match(sql, /NOT EXISTS \(SELECT 1 FROM matched_records mm WHERE mm\.record_id = er\.id\)/);
});

// A venue pair shows the COUNTER record while 041 keys the verdict on the
// primary, so the ids a confirm/reject must use are stated by the side that
// knows rather than inferred from what is on screen.
test('the match object names the ids a verdict must be addressed to', async () => {
  await request(app).get('/api/crypto/ledger');
  const { sql } = lastLedgerQuery();
  assert.match(sql, /'verdict_exchange_record_id', em\.exchange_record_id/);
  assert.match(sql, /'verdict_counter_record_id', em\.counter_record_id/);
});

// A LEFT JOIN's record_type is NULL on an unmatched row, and a bare CASE over
// it falls to the ELSE. Without the guard that stamped 'exchange_transfer' on
// every unmatched row, and `OR r.match_category = $n` then returned the ENTIRE
// ledger for that one category -- a filter that silently widens, which is what
// every filter here is fail-closed against.
test('an unmatched row has NO match category, so one value cannot widen the feed', async () => {
  await request(app).get('/api/crypto/ledger?category=exchange_transfer');
  const { sql } = lastLedgerQuery();
  assert.match(sql, /CASE WHEN mer\.id IS NULL THEN NULL ELSE/);
  assert.match(sql, /CASE WHEN cer\.id IS NULL THEN NULL ELSE/);
});

// 038 writes one eth_activity row per WALLET, so a transfer between two of the
// user's own tracked wallets is two rows for ONE movement -- and the feed
// rendered both, doubling the dollars and the event count.
test('a transaction two tracked wallets both saw collapses to one event', async () => {
  await request(app).get('/api/crypto/ledger');
  const { sql } = lastLedgerQuery();
  // (chain_id, tx_hash), never tx_hash alone: a cross-chain replay genuinely
  // shares a hash and is two real movements.
  assert.match(sql, /ROW_NUMBER\(\) OVER \( PARTITION BY q\.chain_id, q\.tx_hash/);
  assert.match(sql, /BOOL_OR\(q\.needs_review\) OVER \(PARTITION BY q\.chain_id, q\.tx_hash\)/);
  // The SENDING side hosts, so the surviving legs, gas and dollars are the
  // mover's rather than an arbitrary one of the two.
  assert.match(sql, /ORDER BY q\.has_out_leg DESC/);
  assert.match(sql, /WHERE r\.rn = 1/);
});

// A REJECTED venue-to-venue pairing has no exchange_matches row left to hang an
// undo on, and the exchange branch used to hardcode NULL here -- which made
// rejecting one permanent, with no screen anywhere able to take it back.
test('a rejected venue pair stays addressable from either half', async () => {
  await request(app).get('/api/crypto/ledger');
  const { sql } = lastLedgerQuery();
  assert.match(sql, /WHERE \(v\.exchange_record_id = er\.id OR v\.counter_record_id = er\.id\)/);
  assert.match(sql, /crv\.verdict::text AS rejected_verdict/);
  assert.match(sql, /crv\.counter_record_id AS rejected_counter_record_id/);
});

// Nothing in the schema forbids an exchange_matches row whose two sides belong
// to different users. The matcher never writes one; the ledger must not depend
// on that, because an unscoped fold join renders another user's record inline.
test('every fold join is scoped to the caller, not just the root reads', async () => {
  await request(app).get('/api/crypto/ledger');
  const { sql } = lastLedgerQuery();
  assert.match(sql, /LEFT JOIN exchange_accounts mea ON mea\.id = mer\.exchange_account_id AND mea\.user_id = \$1/);
  assert.match(sql, /LEFT JOIN exchange_accounts cea ON cea\.id = cer\.exchange_account_id AND cea\.user_id = \$1/);
  assert.match(sql, /oa\.id = mer\.exchange_account_id AND oa\.user_id = \$1/);
  assert.match(sql, /oa\.id = cer\.exchange_account_id AND oa\.user_id = \$1/);
  // The suppression side too: hiding a record because SOMEBODY's transaction
  // folded it would delete another user's row from their own feed.
  assert.match(sql, /JOIN exchange_accounts mra ON mra\.id = mr\.exchange_account_id WHERE w\.user_id = \$1 AND mra\.user_id = \$1/);
});

// The dollars are 043's, denormalized onto the row by the valuation pass. A
// ledger that recomputed them here would price a 2017 send at today's ETH.
test('USD rides along from the dated valuation, never recomputed', async () => {
  await request(app).get('/api/crypto/ledger');
  const { sql } = lastLedgerQuery();
  assert.match(sql, /a\.usd_value::text AS usd_value/);
  assert.match(sql, /a\.usd_fee::text AS usd_fee/);
  assert.match(sql, /a\.usd_basis::text AS usd_basis/);
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
  // Base units + their scale ride beside the decimal string, so the client
  // renders through the SHARED BigInt formatter rather than a second one.
  assert.deepEqual(row.legs, [
    { asset: 'ETH', direction: 'out', amount: '0.5', units: '5', decimals: 1 },
    { asset: 'USDC', direction: 'in', amount: '1832.4', units: '18324', decimals: 1 },
  ]);
  // wei -> whole units through BigInt: Number('840000000000000')/1e18 is
  // 0.00084 only by luck, and most gas figures have more significant digits
  // than a double holds.
  assert.equal(row.fee_amount, '0.00084');
  assert.equal(row.fee_asset, 'ETH');
  assert.equal(row.fee_units, '84');
  assert.equal(row.fee_decimals, 5);
  // At-the-time dollars, carried through with their basis. Trimmed: a venue
  // figure comes off NUMERIC(38,18), and a money column must not carry
  // eighteen places of a quantity's padding.
  assert.equal(row.usd_value, '1832.4');
  assert.equal(row.usd_basis, 'exact');
});

// A 2017 half-ETH send was worth ~$150. Recomputing at today's price would make
// it a different transaction, so the ledger only ever passes 043's figure on --
// and when there is none it says so rather than showing zero.
test('an unpriced row reports no price, never a zero', async () => {
  ledgerRows = [onchainRow({ usd_value: null, usd_fee: null, usd_basis: 'unpriced' })];
  const response = await request(app).get('/api/crypto/ledger');
  const [row] = response.body.data;
  assert.equal(row.usd_value, null);
  assert.equal(row.usd_basis, 'unpriced');

  const csv = await request(app).get('/api/crypto/ledger/export');
  const [header, line] = csv.text.trim().split('\n');
  const columns = header.split(',');
  const cells = line.split(',');
  // Empty, not '0': this column gets summed, and a fabricated zero is
  // indistinguishable from a real one. The basis beside it tells them apart.
  assert.equal(cells[columns.indexOf('usd_value')], '');
  assert.equal(cells[columns.indexOf('usd_basis')], 'unpriced');
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
    { asset: 'ETH', direction: 'out', amount: '0.5', units: '5', decimals: 1 },
    { asset: 'USD', direction: 'in', amount: '1832.4', units: '18324', decimals: 1 },
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

test('the summary narrows to the wallet the feed is narrowed to', async () => {
  // The header sentence sits directly above the rows. A user-wide count over a
  // one-wallet feed described a ledger that was not on screen.
  ledgerRows = [onchainRow()];
  const response = await request(app).get(`/api/crypto/ledger/summary?wallet_id=${OWNED_WALLET_ID}`);
  assert.equal(response.status, 200);
  const { sql, params } = queries.filter((q) => /AS needs_review_count/.test(q.sql)).at(-1);
  assert.match(sql, /r\.wallet_id = \$\d+/);
  assert.ok(params.includes(OWNED_WALLET_ID));
});

test('a foreign wallet id 404s the summary too, rather than widening it', async () => {
  const response = await request(app).get(`/api/crypto/ledger/summary?wallet_id=${FOREIGN_ID}`);
  assert.equal(response.status, 404);
  assert.equal(queries.filter((q) => /AS needs_review_count/.test(q.sql)).length, 0);
});

test('the view filters never move the summary, only the wallet does', async () => {
  // A needs-review badge that read zero because the user filtered those rows
  // away is a badge that lies.
  ledgerRows = [onchainRow()];
  await request(app).get('/api/crypto/ledger/summary?category=swap&needs_review=false&source=onchain');
  const { sql } = queries.filter((q) => /AS needs_review_count/.test(q.sql)).at(-1);
  assert.doesNotMatch(sql, /r\.category = \$\d+/);
  assert.doesNotMatch(sql, /r\.needs_review = \$\d+/);
  assert.doesNotMatch(sql, /r\.source = \$\d+/);
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
  assert.equal(header, 'date,source,location,category,counterparty,assets_in,assets_out,fee_amount,fee_asset,usd_value,usd_fee,usd_basis,needs_review,quarantined,matched_with,tx_hash,chain_id,external_id,note');
  assert.match(first, /1832\.4 USDC/);
  assert.match(first, /0\.5 ETH/);
  assert.match(first, /Arbitrum One/);
  assert.match(first, /,no,/);
  assert.match(first, /,1832\.4,2\.35,exact,/);
});

test('the export reports a folded pair without double-counting its assets', async () => {
  ledgerRows = [onchainRow({
    category: 'exchange_deposit',
    legs: [{ asset: 'ETH', direction: 'out', amount: '1.25' }],
    exchange_match: {
      match_id: 3, exchange_record_id: 55, verdict_exchange_record_id: 55,
      verdict_counter_record_id: null, match_method: 'tx_hash', match_confidence: 'high',
      verdict: null, exchange_account_id: OWNED_ACCOUNT_ID, account_name: 'Kraken',
      exchange: 'kraken', record_type: 'deposit',
      base_asset: 'ETH', base_amount: '1.250000000000000000',
      quote_asset: null, quote_amount: null, fee_asset: null, fee_amount: null,
      needs_review: false, external_id: 'DEP-1', category: 'exchange_deposit',
    },
  })];
  const response = await request(app).get('/api/crypto/ledger/export');
  const [header, line] = response.text.trim().split('\n');
  const cell = (name) => line.split(',')[header.split(',').indexOf(name)];

  // #61 only ever pairs a deposit with a withdrawal, so the other half is the
  // SAME money seen from the other side. Writing it into assets_in as well as
  // assets_out would make SUM(assets_in) stop meaning "what arrived".
  assert.equal(cell('assets_out'), '1.25 ETH');
  assert.equal(cell('assets_in'), '', 'the venue half is the same money, not a second arrival');
  assert.equal(line.split('1.25 ETH').length - 1, 1);
  // The venue account names the counterparty when the chain side has no label.
  assert.match(line, /Kraken/);
  // ...and the line SAYS it already accounts for the other record, on what
  // evidence. A reader summing the ledger has to see the pair is one movement.
  assert.match(line, /Kraken DEP-1 \(tx_hash\)/);
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

// fee_asset is an ASSET CODE off an imported CSV -- attacker-authored in
// exactly the way a token symbol is -- and it is the one text column that used
// to skip the guard while sitting in its own cell, where nothing precedes it.
test('a hostile fee asset code cannot open its cell with a formula either', async () => {
  ledgerRows = [exchangeRow({ fee_asset: '=cmd|\'/c calc\'!A1', fee_amount: '4.76' })];
  const response = await request(app).get('/api/crypto/ledger/export');
  const [, line] = response.text.trim().split('\n');
  assert.ok(!/,"?=cmd/.test(line), 'a fee asset must not open a cell with a formula');
  assert.match(line, /'=cmd/);
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

'use strict';

// Reconciliation ADJUSTMENTS (048): documented, audit-side corrections summed
// into the derived figure before the delta and status are decided. The three
// claims worth testing:
//
//   * the adjustment shifts the DERIVED figure by an exact amount -- ETH keeps
//     its zero tolerance, and the stored derived_units stays the raw ledger
//     figure (the thing under test)
//   * a verdict is recomputable from stored figures alone (immediate, no
//     Etherscan call), and only where a comparison actually exists
//   * writes are user-scoped fail-closed (foreign ids 404) and the note is
//     mandatory -- an adjustment without its explanation is indistinguishable
//     from fudging the audit
//
// Wallet ids, addresses and amounts are synthetic; the fee figure used in a
// few tests (123456789 wei) is just a number here.

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = 'postgresql://test:test@localhost/test';

const queries = [];
const responder = { fn: null };

const pgModulePath = require.resolve('pg');
require.cache[pgModulePath] = {
  id: pgModulePath,
  filename: pgModulePath,
  loaded: true,
  exports: {
    Pool: class FakePool {
      async query(text, params) {
        queries.push({ text, params });
        const answer = responder.fn && responder.fn(text, params);
        return answer || { rows: [], rowCount: 0 };
      }
      connect() { throw new Error('Unexpected connect'); }
      on() {}
    },
    types: { setTypeParser() {} },
  },
};

const request = require('supertest');
const app = require('../src/server');
const EthReconciliationService = require('../src/services/EthReconciliationService');
const EtherscanService = require('../src/services/EtherscanService');
const EthDerivedPipeline = require('../src/services/EthDerivedPipeline');
const EthReconciliation = require('../src/models/EthReconciliation');
const EthReconciliationAdjustment = require('../src/models/EthReconciliationAdjustment');
const EthTransfer = require('../src/models/EthTransfer');
const EthWallet = require('../src/models/EthWallet');
const EthWalletChain = require('../src/models/EthWalletChain');

const WALLET = { id: 7, user_id: 1, address: '0x1111111111111111111111111111111111111111' };
const ONE_ETH = 1000000000000000000n;
const CLASSIC_FEES = 123456789n;

const sqlOf = (query) => query.text.replace(/--[^\n]*/g, '').replace(/\s+/g, ' ').trim();
const MIGRATION = fs.readFileSync(
  path.join(__dirname, '..', 'migrations', '048_reconciliation_adjustments.sql'), 'utf8'
);
const MIGRATION_SQL = MIGRATION.replace(/--[^\n]*/g, '');

beforeEach(() => {
  responder.fn = null;
  queries.length = 0;
});

function stubHarness(t, { native = {}, adjustments = new Map() } = {}) {
  const restore = [];
  const stub = (obj, key, fn) => { restore.push([obj, key, obj[key]]); obj[key] = fn; };
  const priorChains = process.env.ETH_CHAINS;
  process.env.ETH_CHAINS = '1';
  t.after(() => {
    for (const [o, k, v] of restore.reverse()) o[k] = v;
    if (priorChains === undefined) delete process.env.ETH_CHAINS;
    else process.env.ETH_CHAINS = priorChains;
  });

  const calls = { stored: [] };
  stub(EthTransfer, 'nativeBalanceDeltas', async () =>
    Object.entries(native).map(([chainId, wei]) => ({ chain_id: Number(chainId), balance_wei: wei })));
  stub(EthTransfer, 'tokenBalanceDeltas', async () => []);
  stub(EthReconciliation, 'lastCheckedByAsset', async () => new Map());
  stub(EthReconciliation, 'upsert', async (walletId, row) => { calls.stored.push(row); return row; });
  stub(EthReconciliation, 'pruneMissing', async () => 0);
  stub(EthWalletChain, 'findForWallet', async () => []);
  stub(EthReconciliationAdjustment, 'sumsForWallet', async () => adjustments);
  return { calls, stub };
}

// ---------------------------------------------------------------------------
// The audit applies adjustments -- exactly, and only to the verdict
// ---------------------------------------------------------------------------

test('an adjustment absorbs an explained drift: delta 0, status match, derived stored RAW', async (t) => {
  // The classic-fee case: the ledger derives HIGH by fees no feed reports, and
  // a negative adjustment of exactly that documents it away.
  const derived = ONE_ETH + CLASSIC_FEES;
  const { calls } = stubHarness(t, {
    native: { 1: derived.toString() },
    adjustments: new Map([['1:ETH', -CLASSIC_FEES]]),
  });

  const summary = await EthReconciliationService.reconcileWallet(WALLET, {
    liveWeiByChain: { 1: ONE_ETH.toString() },
    chainResults: [{ chainId: 1, unavailable: false, skippedFeeds: [], unsupportedFeeds: [] }],
    apiKey: 'key',
  });

  const row = calls.stored.find((r) => r.chain_id === 1 && r.asset_key === 'ETH');
  assert.equal(row.status, 'match');
  assert.equal(row.delta_units, '0');
  // The raw ledger figure, NOT the adjusted one: derived_units is the thing
  // under test, and folding the adjustment in would make the recompute
  // double-apply it -- and hide the raw number the adjustment explains.
  assert.equal(row.derived_units, derived.toString());
  assert.equal(summary.nativeMismatches, 0);
});

test('ETH keeps zero tolerance: an adjustment off by one wei is still a mismatch', async (t) => {
  const { calls } = stubHarness(t, {
    native: { 1: (ONE_ETH + CLASSIC_FEES).toString() },
    adjustments: new Map([['1:ETH', -(CLASSIC_FEES - 1n)]]),
  });

  await EthReconciliationService.reconcileWallet(WALLET, {
    liveWeiByChain: { 1: ONE_ETH.toString() },
    chainResults: [{ chainId: 1, unavailable: false, skippedFeeds: [], unsupportedFeeds: [] }],
    apiKey: 'key',
  });

  const row = calls.stored.find((r) => r.chain_id === 1 && r.asset_key === 'ETH');
  assert.equal(row.status, 'mismatch');
  assert.equal(row.delta_units, '1');
});

test('an unreadable adjustments table audits WITHOUT them, never wrongly', async (t) => {
  const { stub, calls } = stubHarness(t, { native: { 1: ONE_ETH.toString() } });
  stub(EthReconciliationAdjustment, 'sumsForWallet', async () => { throw new Error('boom'); });

  await EthReconciliationService.reconcileWallet(WALLET, {
    liveWeiByChain: { 1: ONE_ETH.toString() },
    chainResults: [{ chainId: 1, unavailable: false, skippedFeeds: [], unsupportedFeeds: [] }],
    apiKey: 'key',
  });

  // A verdict decided without adjustments is exactly what stood before 048;
  // failing the audit for a read error would trade a real verdict for none.
  const row = calls.stored.find((r) => r.chain_id === 1 && r.asset_key === 'ETH');
  assert.equal(row.status, 'match');
});

test('a token adjustment sums into the token verdict the same way (API-only; no UI form)', async (t) => {
  const DAI = '0x6b175474e89094c44da98b954eedeac495271d0f';
  // Far past the token dust band (1e-8 of a unit and 1ppm of live are both
  // ~1e10-1e12 base units at 18 decimals), so without the adjustment this is a
  // reported mismatch.
  const TOKEN_DRIFT = 5000000000000000n;
  const { calls, stub } = stubHarness(t, {
    native: { 1: ONE_ETH.toString() },
    adjustments: new Map([[`1:${DAI}`, -TOKEN_DRIFT]]),
  });
  stub(EthTransfer, 'tokenBalanceDeltas', async () => [{
    chain_id: 1, token_contract: DAI, token_symbol: 'DAI', token_decimals: 18,
    balance_units: (ONE_ETH + TOKEN_DRIFT).toString(),
  }]);
  stub(EtherscanService, 'getTokenBalance', async () => ONE_ETH.toString());

  await EthReconciliationService.reconcileWallet(WALLET, {
    liveWeiByChain: { 1: ONE_ETH.toString() },
    chainResults: [{ chainId: 1, unavailable: false, skippedFeeds: [], unsupportedFeeds: [] }],
    apiKey: 'key',
  });

  const row = calls.stored.find((r) => r.asset_key === DAI);
  assert.equal(row.status, 'match');
  assert.equal(row.delta_units, '0');
  // The RAW ledger figure, same rule as native: the adjustment moves only the
  // verdict, never the number under test.
  assert.equal(row.derived_units, (ONE_ETH + TOKEN_DRIFT).toString());
});

// ---------------------------------------------------------------------------
// The immediate recompute -- stored figures only, no Etherscan call
// ---------------------------------------------------------------------------

function stubRecompute(t, { row, sums = new Map() }) {
  const restore = [];
  const stub = (obj, key, fn) => { restore.push([obj, key, obj[key]]); obj[key] = fn; };
  t.after(() => { for (const [o, k, v] of restore.reverse()) o[k] = v; });
  const calls = { updated: null };
  stub(EthReconciliation, 'findByKey', async () => row);
  stub(EthReconciliationAdjustment, 'sumsForWallet', async () => sums);
  stub(EthReconciliation, 'updateVerdict', async (walletId, chainId, assetKey, verdict) => {
    calls.updated = { walletId, chainId, assetKey, ...verdict };
    return { ...row, ...verdict };
  });
  return calls;
}

test('recompute re-decides a compared verdict from stored figures', async (t) => {
  const calls = stubRecompute(t, {
    row: {
      wallet_id: 7, chain_id: 42161, asset_key: 'ETH', asset_type: 'native', token_decimals: 18,
      derived_units: (ONE_ETH + CLASSIC_FEES).toString(), live_units: ONE_ETH.toString(),
      delta_units: CLASSIC_FEES.toString(), status: 'mismatch',
    },
    sums: new Map([['42161:ETH', -CLASSIC_FEES]]),
  });

  const updated = await EthReconciliationService.recomputeStoredVerdict(7, 42161, 'ETH');

  assert.equal(calls.updated.status, 'match');
  assert.equal(calls.updated.delta_units, '0');
  assert.equal(updated.status, 'match');
});

test('recompute leaves a row that was never compared alone', async (t) => {
  // A skipped or unavailable row has no live figure: there is no comparison to
  // re-decide, and inventing one against NULL would report the whole position
  // as drift.
  const row = {
    wallet_id: 7, chain_id: 1, asset_key: 'ETH', asset_type: 'native',
    derived_units: ONE_ETH.toString(), live_units: null, status: 'skipped',
  };
  const calls = stubRecompute(t, { row });

  const result = await EthReconciliationService.recomputeStoredVerdict(7, 1, 'ETH');

  assert.equal(result, row);
  assert.equal(calls.updated, null, 'no verdict write for an uncompared row');
});

test('recompute returns null when no verdict row exists yet', async (t) => {
  const calls = stubRecompute(t, { row: null });
  assert.equal(await EthReconciliationService.recomputeStoredVerdict(7, 1, 'ETH'), null);
  assert.equal(calls.updated, null);
});

test('the verdict update touches delta and status, never the comparison itself', async () => {
  queries.length = 0;
  await EthReconciliation.updateVerdict(7, 1, 'ETH', { delta_units: '0', status: 'match' });
  const sql = sqlOf(queries.at(-1));

  // derived_units and live_units are the stored comparison; checked_at is WHEN
  // it happened. An adjustment re-decides the verdict, it does not re-run the
  // comparison, so none of the three may move.
  assert.match(sql, /SET delta_units = \$4, status = \$5, skip_reason = NULL, updated_at = CURRENT_TIMESTAMP/);
  assert.doesNotMatch(sql, /derived_units =|live_units =|checked_at =/);
});

// ---------------------------------------------------------------------------
// Model scoping: fail closed, exact NUMERIC
// ---------------------------------------------------------------------------

test('writes verify the wallet against the caller inside the statement', async () => {
  queries.length = 0;
  await EthReconciliationAdjustment.create(1, {
    walletId: 7, chainId: 42161, assetKey: 'ETH', amountWei: '-1', note: 'x',
  });
  const insert = sqlOf(queries.at(-1));
  // INSERT ... SELECT from eth_wallets: a foreign wallet selects no source row
  // and inserts nothing, which the route turns into a 404.
  assert.match(insert, /INSERT INTO eth_reconciliation_adjustments/);
  assert.match(insert, /FROM eth_wallets w WHERE w\.id = \$1 AND w\.user_id = \$2/);

  queries.length = 0;
  await EthReconciliationAdjustment.deleteForUser(1, 5);
  const del = sqlOf(queries.at(-1));
  assert.match(del, /USING eth_wallets w WHERE a\.id = \$1 AND w\.id = a\.wallet_id AND w\.user_id = \$2/);

  queries.length = 0;
  await EthReconciliationAdjustment.findForUser(1, { walletId: 7 });
  const read = sqlOf(queries.at(-1));
  assert.match(read, /JOIN eth_wallets w ON w\.id = a\.wallet_id/);
  assert.match(read, /w\.user_id = \$1 AND a\.wallet_id = \$2/);
});

test('a write or read without a userId throws rather than crossing users', async () => {
  await assert.rejects(() => EthReconciliationAdjustment.create(null, {}), /requires a userId/);
  await assert.rejects(() => EthReconciliationAdjustment.deleteForUser(undefined, 1), /requires a userId/);
  await assert.rejects(() => EthReconciliationAdjustment.findForUser(null), /requires a userId/);
});

test('sums are exact BigInt off a text-cast NUMERIC aggregate, keyed per (chain, asset)', async (t) => {
  responder.fn = (text) => (/SUM\(amount_wei\)/.test(text) ? {
    rows: [
      { chain_id: 42161, asset_key: 'ETH', total_units: (-CLASSIC_FEES).toString() },
      { chain_id: 1, asset_key: 'ETH', total_units: '7' },
      { chain_id: 1, asset_key: 'nonsense', total_units: 'not-a-number' },
    ],
  } : undefined);
  t.after(() => { responder.fn = null; });

  const sums = await EthReconciliationAdjustment.sumsForWallet(7);
  assert.equal(sums.get('42161:ETH'), -CLASSIC_FEES);
  assert.equal(sums.get('1:ETH'), 7n);
  // A stored value that will not parse is skipped, never read as zero.
  assert.equal(sums.get('1:nonsense'), undefined);
  assert.match(sqlOf(queries.at(-1)), /SUM\(amount_wei\)::text AS total_units[\s\S]*GROUP BY chain_id, asset_key/);
});

// ---------------------------------------------------------------------------
// Routes: user-scoped, fail-closed validation, immediate recompute
// ---------------------------------------------------------------------------

// Dispatches the route's queries: ownership check, insert/delete, then the
// recompute's reads and write.
function routeResponder({ walletRows = [{ id: 7, user_id: 1, address: '0xabc' }], sink = {} } = {}) {
  return (text, params) => {
    if (/FROM eth_wallets WHERE id = \$1 AND user_id = \$2/.test(text)) {
      return { rows: walletRows };
    }
    if (/INSERT INTO eth_reconciliation_adjustments/.test(text)) {
      sink.insertParams = params;
      if (!walletRows.length) return { rows: [] };
      return { rows: [{ id: 3, wallet_id: params[0], chain_id: params[2], asset_key: params[3], amount_wei: params[4], note: params[5], created_at: '2026-07-27T00:00:00Z' }] };
    }
    if (/DELETE FROM eth_reconciliation_adjustments/.test(text)) {
      sink.deleteParams = params;
      return sink.deleteRows ? { rows: sink.deleteRows } : { rows: [] };
    }
    if (/SELECT \* FROM eth_reconciliation\s+WHERE wallet_id/.test(text)) {
      return {
        rows: [{
          wallet_id: 7, chain_id: 42161, asset_key: 'ETH', asset_type: 'native', token_decimals: 18,
          derived_units: (ONE_ETH + CLASSIC_FEES).toString(), live_units: ONE_ETH.toString(),
          delta_units: CLASSIC_FEES.toString(), status: 'mismatch',
        }],
      };
    }
    if (/SUM\(amount_wei\)/.test(text)) {
      return { rows: [{ chain_id: 42161, asset_key: 'ETH', total_units: (-CLASSIC_FEES).toString() }] };
    }
    if (/UPDATE eth_reconciliation\s+SET delta_units/.test(text)) {
      sink.verdictParams = params;
      return { rows: [{ wallet_id: 7, chain_id: 42161, asset_key: 'ETH', delta_units: params[3], status: params[4] }] };
    }
    return undefined;
  };
}

test('POST recomputes the stored verdict immediately and returns it', async () => {
  const sink = {};
  responder.fn = routeResponder({ sink });

  const response = await request(app)
    .post('/api/eth/reconciliation/adjustments')
    .send({ wallet_id: 7, chain_id: 42161, asset_key: 'eth', amount_wei: (-CLASSIC_FEES).toString(), note: '  Classic-era L2 fees Etherscan does not report  ' });

  assert.equal(response.status, 201);
  // Normalized on the way in: native keys uppercase (the verdict row's key),
  // the note trimmed.
  assert.equal(sink.insertParams[3], 'ETH');
  assert.equal(sink.insertParams[5], 'Classic-era L2 fees Etherscan does not report');
  // The recompute ran and the response carries the re-decided verdict -- no
  // sync, no Etherscan call.
  assert.equal(sink.verdictParams[3], '0');
  assert.equal(sink.verdictParams[4], 'match');
  assert.equal(response.body.reconciliation.status, 'match');
});

test('POST 404s a foreign wallet exactly like a made-up one', async () => {
  responder.fn = routeResponder({ walletRows: [] });
  const response = await request(app)
    .post('/api/eth/reconciliation/adjustments')
    .send({ wallet_id: 999, chain_id: 42161, asset_key: 'ETH', amount_wei: '-1', note: 'x' });
  assert.equal(response.status, 404);
});

test('POST refuses what would fudge the audit: zero, floats, no note', async () => {
  responder.fn = routeResponder({});
  const cases = [
    { amount_wei: '0', note: 'x' },
    { amount_wei: '-0', note: 'x' },
    { amount_wei: '1.5', note: 'x' },
    { amount_wei: 1.5, note: 'x' },
    { amount_wei: '', note: 'x' },
    // The note IS the point: without its explanation an adjustment is
    // indistinguishable from fudging the audit until it stops talking.
    { amount_wei: '-1', note: '' },
    { amount_wei: '-1', note: '   ' },
    { amount_wei: '-1' },
    { amount_wei: '-1', note: 'x', asset_key: 'not an asset!' },
    // A truncated contract paste is NOT a native symbol, and a symbol that is
    // not THIS chain's native key would store an adjustment no audit row can
    // ever consume -- saved, silently inert, impossible to notice.
    { amount_wei: '-1', note: 'x', asset_key: '0X1234' },
    { amount_wei: '-1', note: 'x', asset_key: 'POL' },
    { amount_wei: '-1', note: 'x', asset_key: 'EHT' },
  ];
  for (const body of cases) {
    const response = await request(app)
      .post('/api/eth/reconciliation/adjustments')
      .send({ wallet_id: 7, chain_id: 42161, asset_key: 'ETH', ...body });
    assert.equal(response.status, 400, JSON.stringify(body));
  }
});

test('the native asset_key must be THIS chain\'s native symbol, named in the rejection', async () => {
  responder.fn = routeResponder({});
  const response = await request(app)
    .post('/api/eth/reconciliation/adjustments')
    .send({ wallet_id: 7, chain_id: 42161, asset_key: 'BTC', amount_wei: '-1', note: 'x' });
  assert.equal(response.status, 400);
  // The message names the one symbol that would have worked.
  assert.match(response.body.error, /ETH/);

  // And the registry answers per chain: POL is Polygon's native key, so the
  // same spelling that 400s on Arbitrum normalizes and stores on 137.
  const sink = {};
  responder.fn = routeResponder({ sink });
  const accepted = await request(app)
    .post('/api/eth/reconciliation/adjustments')
    .send({ wallet_id: 7, chain_id: 137, asset_key: 'pol', amount_wei: '-1', note: 'x' });
  assert.equal(accepted.status, 201);
  assert.equal(sink.insertParams[3], 'POL');
});

test('the recompute runs on the per-user derived lane, late-bound off the pipeline module', async () => {
  const sink = {};
  responder.fn = routeResponder({ sink });
  const lanes = [];
  const original = EthDerivedPipeline.serializedForUser;
  // Property assignment, the pipeline's own test convention: the route must
  // resolve the lane off the module object at call time or this stub -- and
  // every test like it -- is silently bypassed.
  EthDerivedPipeline.serializedForUser = (userId, fn) => {
    lanes.push(userId);
    return original.call(EthDerivedPipeline, userId, fn);
  };
  try {
    const response = await request(app)
      .post('/api/eth/reconciliation/adjustments')
      .send({ wallet_id: 7, chain_id: 42161, asset_key: 'ETH', amount_wei: '-1', note: 'x' });
    assert.equal(response.status, 201);
  } finally {
    EthDerivedPipeline.serializedForUser = original;
  }
  // The wallet owner's lane -- the one the nightly sync holds while it writes
  // verdicts, so the read-modify-write recompute serializes instead of racing.
  assert.deepEqual(lanes, [1]);
  assert.ok(sink.verdictParams, 'the recompute ran inside the lane');
});

test('DELETE is scoped in the statement and recomputes the verdict it uncovered', async () => {
  const sink = {
    deleteRows: [{ id: 3, wallet_id: 7, chain_id: 42161, asset_key: 'ETH', amount_wei: (-CLASSIC_FEES).toString(), note: 'x' }],
  };
  responder.fn = routeResponder({ sink });

  const response = await request(app).delete('/api/eth/reconciliation/adjustments/3');

  assert.equal(response.status, 200);
  assert.deepEqual(sink.deleteParams, [3, 1]);
  // Removing the correction puts the drift back on display NOW: with no
  // adjustment rows left the recompute reads sums that no longer apply --
  // here the fake still returns the sum, so the verdict stays 'match'; the
  // point under test is that the recompute RAN against the removed row's key.
  assert.ok(sink.verdictParams, 'the stored verdict was recomputed');
  assert.equal(response.body.removed.id, 3);
});

test('DELETE 404s a foreign or unknown adjustment', async () => {
  responder.fn = routeResponder({});
  const response = await request(app).delete('/api/eth/reconciliation/adjustments/999');
  assert.equal(response.status, 404);
});

// ---------------------------------------------------------------------------
// The wallets API's summary shell
// ---------------------------------------------------------------------------

test('a wallet never audited still surfaces its adjustments through a summary shell', async (t) => {
  const restore = [];
  const stub = (obj, key, fn) => { restore.push([obj, key, obj[key]]); obj[key] = fn; };
  t.after(() => { for (const [o, k, v] of restore.reverse()) o[k] = v; });

  stub(EthWallet, 'findAllByUser', async () => [
    { id: 7, address: '0x1111111111111111111111111111111111111111', label: 'Main' },
    { id: 8, address: '0x2222222222222222222222222222222222222222', label: 'Cold' },
  ]);
  stub(EthWalletChain, 'findAllForWallets', async () => []);
  stub(EthWallet, 'getAccountForWallet', async () => null);
  stub(EthWallet, 'getEthQuantity', async () => 0);
  // No verdict rows at all: an adjustment filed before the first audit.
  stub(EthReconciliation, 'summaryForWallets', async () => new Map());
  stub(EthReconciliation, 'openIssuesForWallets', async () => new Map());
  stub(EthReconciliationAdjustment, 'findForUser', async () => [{
    id: 3, wallet_id: 7, chain_id: 42161, asset_key: 'ETH',
    amount_wei: (-CLASSIC_FEES).toString(), note: 'Classic-era fees', created_at: '2026-07-27T00:00:00Z',
  }]);

  const response = await request(app).get('/api/eth/wallets');
  assert.equal(response.status, 200);

  // The shell: "never audited" in every count, but the adjustment is visible
  // -- a null here would hide it (and its Remove button) until the first
  // audit happened to run.
  const withAdjustment = response.body.wallets.find((w) => w.id === 7);
  assert.ok(withAdjustment.reconciliation, 'the summary shell exists');
  assert.equal(withAdjustment.reconciliation.assets_checked, 0);
  assert.equal(withAdjustment.reconciliation.needs_review, false);
  assert.deepEqual(withAdjustment.reconciliation.issues, []);
  assert.equal(withAdjustment.reconciliation.adjustments.length, 1);
  assert.equal(withAdjustment.reconciliation.adjustments[0].id, 3);

  // No counts AND no adjustments stays null: never-audited and audited-clean
  // remain different claims, and the panel says which.
  const bare = response.body.wallets.find((w) => w.id === 8);
  assert.equal(bare.reconciliation, null);
});

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

test('the migration stores signed exact NUMERIC, a mandatory note, and cascades with the wallet', () => {
  assert.match(MIGRATION_SQL, /amount_wei NUMERIC\(78, 0\) NOT NULL/);
  assert.match(MIGRATION_SQL, /CHECK \(amount_wei <> 0\)/);
  assert.match(MIGRATION_SQL, /note TEXT NOT NULL/);
  assert.match(MIGRATION_SQL, /CHECK \(btrim\(note\) <> ''\)/);
  assert.match(MIGRATION_SQL, /wallet_id INT NOT NULL REFERENCES eth_wallets\(id\) ON DELETE CASCADE/);
  assert.doesNotMatch(MIGRATION_SQL, /DOUBLE PRECISION|REAL|FLOAT/i);
});

test('the migration re-runs cleanly: no UNIQUE on the key, several rows may sum', () => {
  assert.match(MIGRATION, /CREATE TABLE IF NOT EXISTS eth_reconciliation_adjustments/);
  for (const index of MIGRATION.match(/CREATE INDEX[^;]*/g) || []) {
    assert.match(index, /IF NOT EXISTS/);
  }
  // Several adjustments per (wallet, chain, asset) are the design -- each one
  // documents a distinct explanation and the audit SUMS them -- so the key
  // index must not be unique.
  assert.doesNotMatch(MIGRATION_SQL, /UNIQUE/);
});

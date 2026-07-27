'use strict';

// The derived-data rebuild pipeline (EthDerivedPipeline). The step list used
// to be hand-copied at four call sites and had drifted once (the nightly price
// job forgot the classification backfill), so these tests pin:
//   * the canonical step order, in both fatality modes
//   * the sync policy (first failure throws, later steps never run) vs the
//     refresh policy (each step isolated, neighbours and other wallets go on)
//   * the user-wide tail: match -> bridge (non-fatal) -> backfill (fatal),
//     exactly once, after every wallet
//   * late binding: every dependency is resolved off the module object at call
//     time, because the suite's harnesses stub by property assignment and a
//     captured function reference would silently bypass them

const { test } = require('node:test');
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
      async query() { return { rows: [], rowCount: 0 }; }
      connect() { throw new Error('Unexpected connect'); }
      on() {}
    },
    types: { setTypeParser() {} },
  },
};

const EthDerivedPipeline = require('../src/services/EthDerivedPipeline');
const EthWalletService = require('../src/services/EthWalletService');
const EthWallet = require('../src/models/EthWallet');
const EthTransfer = require('../src/models/EthTransfer');
const AssetPriceHistory = require('../src/models/AssetPriceHistory');
const HistoricalPriceService = require('../src/services/HistoricalPriceService');
const MirrorService = require('../src/services/EthTransactionMirrorService');
const EthActivityService = require('../src/services/EthActivityService');
const ExchangeMatchService = require('../src/services/ExchangeMatchService');
const TransactionClassificationService = require('../src/services/TransactionClassificationService');

// Records every step as a tuple, in call order. `failures[name]` throws that
// step: `true` always, a number only when the step's first argument matches --
// which is what lets one wallet's mirror fail while the other wallet's runs.
function harness(t, { wallets = [{ id: 7 }, { id: 8 }], failures = {} } = {}) {
  const restore = [];
  const stub = (obj, key, fn) => { restore.push([obj, key, obj[key]]); obj[key] = fn; };
  t.after(() => { for (const [o, k, v] of restore.reverse()) o[k] = v; });

  const calls = [];
  const maybeFail = (name, scope) => {
    const failure = failures[name];
    if (failure === true || (failure != null && failure === scope)) {
      throw new Error(`${name} failed`);
    }
  };

  stub(EthTransfer, 'reclassifyCounterparties', async (userId) => {
    calls.push(['reclassify', userId]); maybeFail('reclassify', userId);
  });
  stub(HistoricalPriceService, 'ensureAssetsForWallet', async (walletId) => {
    calls.push(['ensureAssets', walletId]); maybeFail('ensureAssets', walletId);
    return { assets: 2 };
  });
  stub(AssetPriceHistory, 'applyToWallet', async (walletId) => {
    calls.push(['value', walletId]); maybeFail('value', walletId);
    return 3;
  });
  stub(EthWalletService, 'refreshHoldings', async (walletId) => {
    calls.push(['holdings', walletId]); maybeFail('holdings', walletId);
    return { liveWeiByChain: {} };
  });
  stub(MirrorService, 'rebuildForWallet', async (walletId) => {
    calls.push(['mirror', walletId]); maybeFail('mirror', walletId);
    return { written: 1 };
  });
  stub(EthActivityService, 'rebuildForWallet', async (walletId, options) => {
    calls.push(['activity', walletId, options]); maybeFail('activity', walletId);
    return { activity: 1, matches: null };
  });
  stub(ExchangeMatchService, 'rebuildForUserSafely', async (userId, context) => {
    calls.push(['matches', userId, context]); maybeFail('matches', userId);
    return { matched: 0 };
  });
  stub(EthActivityService, 'matchBridgeTransfersForUser', async (userId) => {
    calls.push(['bridge', userId]); maybeFail('bridge', userId);
    return { matched: 0, unmatched: 0 };
  });
  stub(TransactionClassificationService, 'backfill', async () => {
    calls.push(['backfill']); maybeFail('backfill');
  });
  stub(EthWallet, 'findAllByUser', async () => wallets);

  return { calls, stub };
}

// ---------------------------------------------------------------------------
// rebuildWallet -- the sync shape
// ---------------------------------------------------------------------------

test('rebuildWallet runs the sync shape in canonical order', async (t) => {
  const { calls } = harness(t);
  const result = await EthDerivedPipeline.rebuildWallet(7, {
    reclassifyUserId: 1, fillPrices: true, holdings: true, rebuildMatches: true,
  });
  assert.deepEqual(calls, [
    ['reclassify', 1],
    ['ensureAssets', 7],
    ['value', 7],
    ['holdings', 7],
    ['mirror', 7],
    ['activity', 7, { rebuildMatches: true }],
  ]);
  assert.deepEqual(result, {
    priced: { assets: 2 },
    valued: 3,
    holdings: { liveWeiByChain: {} },
    mirror: { written: 1 },
    activity: { activity: 1, matches: null },
  });
});

test('rebuildWallet skips the provider walk and reclassify when not asked for them', async (t) => {
  const { calls } = harness(t);
  await EthDerivedPipeline.rebuildWallet(7, { holdings: true });
  assert.deepEqual(calls.map((c) => c[0]), ['value', 'holdings', 'mirror', 'activity']);
});

test('sync shape: a mirror failure is fatal and the activity rebuild never runs', async (t) => {
  const { calls } = harness(t, { failures: { mirror: true } });
  await assert.rejects(
    () => EthDerivedPipeline.rebuildWallet(7, { holdings: true }),
    /mirror failed/
  );
  assert.ok(!calls.some((c) => c[0] === 'activity'), 'activity must not run after a fatal mirror');
});

test('sync shape: a price-fill failure warns and the pipeline continues', async (t) => {
  const { calls } = harness(t, { failures: { ensureAssets: true } });
  const result = await EthDerivedPipeline.rebuildWallet(7, { fillPrices: true, holdings: true });
  assert.equal(result.priced, null);
  assert.deepEqual(calls.map((c) => c[0]),
    ['ensureAssets', 'value', 'holdings', 'mirror', 'activity']);
});

// ---------------------------------------------------------------------------
// finishUser -- the user-wide tail
// ---------------------------------------------------------------------------

test('finishUser runs match -> bridge -> backfill and returns the match result', async (t) => {
  const { calls } = harness(t);
  const result = await EthDerivedPipeline.finishUser(1, {
    matchContext: { reason: 'classification-refresh' },
  });
  assert.deepEqual(calls, [
    ['matches', 1, { reason: 'classification-refresh' }],
    ['bridge', 1],
    ['backfill'],
  ]);
  assert.deepEqual(result.matches, { matched: 0 });
});

test('finishUser: a bridge failure is non-fatal and the backfill still runs', async (t) => {
  const { calls } = harness(t, { failures: { bridge: true } });
  await EthDerivedPipeline.finishUser(1, { match: false });
  assert.deepEqual(calls, [['bridge', 1], ['backfill']]);
});

test('finishUser: a backfill failure propagates', async (t) => {
  harness(t, { failures: { backfill: true } });
  await assert.rejects(() => EthDerivedPipeline.finishUser(1, { match: false }), /backfill failed/);
});

// ---------------------------------------------------------------------------
// runForUser -- the refresh shapes
// ---------------------------------------------------------------------------

test('runForUser classification shape: reclassify first, per-wallet steps, tail once', async (t) => {
  const { calls } = harness(t);
  await EthDerivedPipeline.runForUser(1, {
    reclassify: true, context: 'classification refresh', matchReason: 'classification-refresh',
  });
  assert.deepEqual(calls, [
    ['reclassify', 1],
    ['value', 7],
    ['mirror', 7],
    ['activity', 7, { rebuildMatches: false }],
    ['value', 8],
    ['mirror', 8],
    ['activity', 8, { rebuildMatches: false }],
    ['matches', 1, { reason: 'classification-refresh' }],
    ['bridge', 1],
    ['backfill'],
  ]);
});

test('runForUser derived shape: holdings after value, no reclassify', async (t) => {
  const { calls } = harness(t);
  await EthDerivedPipeline.runForUser(1, {
    holdings: true, context: 'derived-data refresh', matchReason: 'derived-refresh',
  });
  assert.deepEqual(calls, [
    ['value', 7],
    ['holdings', 7],
    ['mirror', 7],
    ['activity', 7, { rebuildMatches: false }],
    ['value', 8],
    ['holdings', 8],
    ['mirror', 8],
    ['activity', 8, { rebuildMatches: false }],
    ['matches', 1, { reason: 'derived-refresh' }],
    ['bridge', 1],
    ['backfill'],
  ]);
});

test('runForUser isolates a step failure to that step, not its wallet or its neighbour', async (t) => {
  // Wallet 7's mirror throws; wallet 7's activity, all of wallet 8, and the
  // tail must still run. This is the refresh policy: one derivation's hiccup
  // cannot skip the rebuild the user's click was actually for.
  const { calls } = harness(t, { failures: { mirror: 7 } });
  await EthDerivedPipeline.runForUser(1, {
    context: 'classification refresh', matchReason: 'classification-refresh',
  });
  assert.deepEqual(calls.map((c) => c.slice(0, 2)), [
    ['value', 7],
    ['mirror', 7],
    ['activity', 7],
    ['value', 8],
    ['mirror', 8],
    ['activity', 8],
    ['matches', 1],
    ['bridge', 1],
    ['backfill'],
  ]);
});

test('runForUser: a reclassify failure propagates before any wallet is touched', async (t) => {
  const { calls } = harness(t, { failures: { reclassify: true } });
  await assert.rejects(
    () => EthDerivedPipeline.runForUser(1, { reclassify: true, context: 'classification refresh' }),
    /reclassify failed/
  );
  assert.deepEqual(calls, [['reclassify', 1]]);
});

// ---------------------------------------------------------------------------
// The per-user queue
// ---------------------------------------------------------------------------

const gate = () => {
  let release;
  const promise = new Promise((resolve) => { release = resolve; });
  return { promise, release };
};
const tick = () => new Promise((resolve) => setImmediate(resolve));

test('work for one user is serialized in FIFO order', async (t) => {
  const events = [];
  const g = gate();
  // Releasing twice is a no-op; the after-hook guarantees a failed assertion
  // while the gate is held cannot leave the lane unsettled and hang the tests
  // behind it on this lane.
  t.after(g.release);
  const first = EthDerivedPipeline.serializedForUser(1, async () => {
    events.push('a-start'); await g.promise; events.push('a-end');
  });
  const second = EthDerivedPipeline.serializedForUser(1, async () => { events.push('b'); });
  await tick();
  assert.deepEqual(events, ['a-start'], 'the second job must wait for the first');
  g.release();
  await Promise.all([first, second]);
  assert.deepEqual(events, ['a-start', 'a-end', 'b']);
});

test('two users run in parallel lanes', async (t) => {
  const events = [];
  const g = gate();
  t.after(g.release);
  const slow = EthDerivedPipeline.serializedForUser(1, async () => {
    events.push('u1-start'); await g.promise; events.push('u1-end');
  });
  await EthDerivedPipeline.serializedForUser(2, async () => { events.push('u2'); });
  assert.deepEqual(events, ['u1-start', 'u2'], 'user 2 must not queue behind user 1');
  g.release();
  await slow;
});

test('a rejection reaches its caller, unblocks the lane, and leaks nowhere', async (t) => {
  const unhandled = [];
  const onUnhandled = (err) => unhandled.push(err);
  process.on('unhandledRejection', onUnhandled);
  t.after(() => process.removeListener('unhandledRejection', onUnhandled));

  await assert.rejects(
    EthDerivedPipeline.serializedForUser(1, async () => { throw new Error('lane job failed'); }),
    /lane job failed/
  );
  const next = await EthDerivedPipeline.serializedForUser(1, async () => 'ran');
  assert.equal(next, 'ran', 'a failed predecessor must not block the lane');
  await tick();
  assert.deepEqual(unhandled, []);
});

test('settled lanes are cleaned out of the map', async () => {
  await EthDerivedPipeline.serializedForUser(1, async () => 'x');
  await EthDerivedPipeline.serializedForUser(2, async () => 'y');
  await tick();
  assert.equal(EthDerivedPipeline.pendingQueueCount(), 0);
});

test('the global backfill chokepoint keeps two users\' backfills from overlapping', async (t) => {
  const { stub } = harness(t);
  const events = [];
  const g = gate();
  t.after(g.release);
  let firstEntered;
  const entered = new Promise((resolve) => { firstEntered = resolve; });
  stub(TransactionClassificationService, 'backfill', async () => {
    const isFirst = events.length === 0;
    events.push('backfill-start');
    if (isFirst) { firstEntered(); await g.promise; }
    events.push('backfill-end');
  });

  const first = EthDerivedPipeline.finishUser(1, { match: false });
  await entered;
  const second = EthDerivedPipeline.finishUser(2, { match: false });
  await tick();
  await tick();
  assert.deepEqual(events, ['backfill-start'], 'the second backfill must wait for the first');
  g.release();
  await Promise.all([first, second]);
  assert.deepEqual(events, ['backfill-start', 'backfill-end', 'backfill-start', 'backfill-end']);
});

// ---------------------------------------------------------------------------
// Late binding -- the contract every harness in this suite depends on
// ---------------------------------------------------------------------------

test('the pipeline resolves dependencies at call time, so a re-stub takes effect', async (t) => {
  const { stub } = harness(t);
  const seen = [];
  stub(EthActivityService, 'rebuildForWallet', async (walletId) => {
    seen.push(['first', walletId]);
    return {};
  });
  await EthDerivedPipeline.rebuildWallet(7, {});
  stub(EthActivityService, 'rebuildForWallet', async (walletId) => {
    seen.push(['second', walletId]);
    return {};
  });
  await EthDerivedPipeline.rebuildWallet(7, {});
  assert.deepEqual(seen, [['first', 7], ['second', 7]]);
});

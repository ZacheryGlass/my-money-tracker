'use strict';

// The derived-data rebuild pipeline (EthDerivedPipeline). The step list used
// to be hand-copied at four call sites and had drifted once (the nightly price
// job forgot the classification backfill), so these tests pin:
//   * the canonical step order, in both fatality modes
//   * the sync policy (first failure throws, later steps never run) vs the
//     refresh policy (each step isolated, neighbours and other wallets go on)
//   * the user-wide tail: match -> bridge -> mirror -> backfill, with mirror
//     fatal for sync/audit callers and isolated per wallet for refresh callers
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
const BridgeMatchingService = require('../src/services/BridgeMatchingService');
const TransactionClassificationService = require('../src/services/TransactionClassificationService');

// Records every step as a tuple, in call order. `failures[name]` throws that
// step: `true` always, a number only when the step's first argument matches --
// which is what lets one wallet's mirror fail while the other wallet's runs.
function harness(t, { wallets = [{ id: 7 }, { id: 8 }], failures = {} } = {}) {
  const restore = [];
  const stub = (obj, key, fn) => { restore.push([obj, key, obj[key]]); obj[key] = fn; };
  t.after(() => { for (const [o, k, v] of restore.reverse()) o[k] = v; });

  const calls = [];
  const mirrorOptions = [];
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
  stub(EthActivityService, 'rebuildForWallet', async (walletId) => {
    calls.push(['activity', walletId]); maybeFail('activity', walletId);
    return { activity: 1 };
  });
  stub(ExchangeMatchService, 'rebuildForUserSafely', async (userId, context) => {
    calls.push(['matches', userId, context]); maybeFail('matches', userId);
    return { matched: 0 };
  });
  stub(BridgeMatchingService, 'rebuildForUser', async (userId) => {
    calls.push(['bridge', userId]); maybeFail('bridge', userId);
    return { matched: 0, unmatched: 0 };
  });
  stub(MirrorService, 'rebuildForUser', async (userId, options) => {
    calls.push(['mirror', userId]); maybeFail('mirror', userId);
    mirrorOptions.push(options);
    return {
      summary: { wallets: wallets.length, mirrored: 0, unpricedSkipped: 0 },
      resultsByWallet: new Map(wallets.map((wallet) => [
        wallet.id, { receipt: { mirrored: 0, unpricedSkipped: 0 }, error: null },
      ])),
    };
  });
  stub(TransactionClassificationService, 'backfillForUser', async (userId) => {
    calls.push(['backfill', userId]); maybeFail('backfill', userId);
  });
  stub(EthWallet, 'findAllByUser', async () => wallets);

  return { calls, mirrorOptions, stub };
}

// ---------------------------------------------------------------------------
// rebuildWallet -- the sync shape
// ---------------------------------------------------------------------------

test('rebuildWallet runs the sync shape in canonical order', async (t) => {
  const { calls } = harness(t);
  const result = await EthDerivedPipeline.rebuildWallet(7, {
    reclassifyUserId: 1, fillPrices: true, holdings: true,
  });
  assert.deepEqual(calls, [
    ['reclassify', 1],
    ['ensureAssets', 7],
    ['value', 7],
    ['holdings', 7],
    ['activity', 7],
  ]);
  assert.deepEqual(result, {
    priced: { assets: 2 },
    valued: 3,
    holdings: { liveWeiByChain: {} },
    mirror: null,
    activity: { activity: 1 },
  });
});

test('rebuildWallet skips the provider walk and reclassify when not asked for them', async (t) => {
  const { calls } = harness(t);
  await EthDerivedPipeline.rebuildWallet(7, { holdings: true });
  assert.deepEqual(calls.map((c) => c[0]), ['value', 'holdings', 'activity']);
});

test('sync shape: an activity failure is fatal', async (t) => {
  const { calls } = harness(t, { failures: { activity: true } });
  await assert.rejects(
    () => EthDerivedPipeline.rebuildWallet(7, { holdings: true }),
    /activity failed/
  );
  assert.equal(calls.at(-1)[0], 'activity');
});

test('sync shape: a price-fill failure warns and the pipeline continues', async (t) => {
  const { calls } = harness(t, { failures: { ensureAssets: true } });
  const result = await EthDerivedPipeline.rebuildWallet(7, { fillPrices: true, holdings: true });
  assert.equal(result.priced, null);
  assert.deepEqual(calls.map((c) => c[0]),
    ['ensureAssets', 'value', 'holdings', 'activity']);
});

// ---------------------------------------------------------------------------
// finishUser -- the user-wide tail
// ---------------------------------------------------------------------------

test('finishUser runs match -> bridge -> mirror -> backfill once', async (t) => {
  const { calls } = harness(t);
  const result = await EthDerivedPipeline.finishUser(1, {
    matchContext: { reason: 'classification-refresh' },
  });
  assert.deepEqual(calls, [
    ['matches', 1, { reason: 'classification-refresh' }],
    ['bridge', 1],
    ['mirror', 1],
    ['backfill', 1],
  ]);
  assert.deepEqual(result.mirror.summary, { wallets: 2, mirrored: 0, unpricedSkipped: 0 });
  assert.deepEqual(result.matches, { matched: 0 });
});

test('finishUser: a bridge failure is non-fatal and mirror plus backfill still run', async (t) => {
  const { calls } = harness(t, { failures: { bridge: true } });
  await EthDerivedPipeline.finishUser(1);
  assert.deepEqual(calls, [
    ['matches', 1, {}], ['bridge', 1], ['mirror', 1], ['backfill', 1],
  ]);
});

test('finishUser: a mirror failure is fatal by default', async (t) => {
  const { calls } = harness(t, { failures: { mirror: true } });
  await assert.rejects(() => EthDerivedPipeline.finishUser(1), /mirror failed/);
  assert.deepEqual(calls, [
    ['matches', 1, {}], ['bridge', 1], ['mirror', 1],
  ]);
});

test('finishUser: an isolated mirror failure still lets classification run', async (t) => {
  const { calls } = harness(t, { failures: { mirror: true } });
  const result = await EthDerivedPipeline.finishUser(1, { isolateMirror: true });
  assert.deepEqual(calls, [
    ['matches', 1, {}], ['bridge', 1], ['mirror', 1], ['backfill', 1],
  ]);
  assert.equal(result.mirror, null);
});

test('finishUser passes refresh context to the user-wide mirror', async (t) => {
  const { mirrorOptions } = harness(t);
  await EthDerivedPipeline.finishUser(1, {
    isolateMirror: true,
    context: 'classification refresh',
  });
  assert.deepEqual(mirrorOptions.at(-1), {
    context: 'classification refresh',
  });
});

test('finishUser classifies sibling mirrors, then fails only the requested wallet', async (t) => {
  const { calls, stub } = harness(t);
  const mirror = {
    summary: { wallets: 2, mirrored: 1, unpricedSkipped: 0 },
    resultsByWallet: new Map([
      [7, { receipt: null, error: new Error('wallet 7 mirror failed') }],
      [8, { receipt: { mirrored: 1, unpricedSkipped: 0 }, error: null }],
    ]),
  };
  stub(MirrorService, 'rebuildForUser', async () => mirror);

  await assert.rejects(
    () => EthDerivedPipeline.finishUser(1, { walletId: 7 }),
    /wallet 7 mirror failed/
  );
  assert.equal(calls.filter((call) => call[0] === 'backfill').length, 1,
    'successful sibling mirrors are classified before the target error returns');
  const other = await EthDerivedPipeline.finishUser(1, { walletId: 8 });
  assert.equal(other.mirror, mirror);
  assert.equal(calls.filter((call) => call[0] === 'backfill').length, 2);
});

test('finishUser: a backfill failure propagates', async (t) => {
  harness(t, { failures: { backfill: true } });
  await assert.rejects(() => EthDerivedPipeline.finishUser(1), /backfill failed/);
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
    ['activity', 7],
    ['value', 8],
    ['activity', 8],
    ['matches', 1, { reason: 'classification-refresh' }],
    ['bridge', 1],
    ['mirror', 1],
    ['backfill', 1],
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
    ['activity', 7],
    ['value', 8],
    ['holdings', 8],
    ['activity', 8],
    ['matches', 1, { reason: 'derived-refresh' }],
    ['bridge', 1],
    ['mirror', 1],
    ['backfill', 1],
  ]);
});

test('runForUser isolates a step failure to that step, not its wallet or its neighbour', async (t) => {
  // Wallet 7's activity rebuild throws; all of wallet 8 and the user-wide tail
  // must still run. This is the refresh policy: one derivation's hiccup cannot
  // skip the rebuild the user's click was actually for.
  const { calls } = harness(t, { failures: { activity: 7 } });
  await EthDerivedPipeline.runForUser(1, {
    context: 'classification refresh', matchReason: 'classification-refresh',
  });
  assert.deepEqual(calls.map((c) => c.slice(0, 2)), [
    ['value', 7],
    ['activity', 7],
    ['value', 8],
    ['activity', 8],
    ['matches', 1],
    ['bridge', 1],
    ['mirror', 1],
    ['backfill', 1],
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

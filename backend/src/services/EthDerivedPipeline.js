'use strict';

// The derived-data rebuild pipeline, stated ONCE.
//
// Everything derived from eth_transfers is rebuilt in this order:
//
//   reclassify? -> ensureAssets? -> value -> holdings? -> mirror -> activity
//      (user)        (wallet)      (wallet)  (wallet)     (wallet)   (wallet)
//   -> match? -> bridge -> mirror -> backfill
//       (user)    (user)    (user)    (global)
//
// Before this module the sequence was hand-copied at four sites (_syncWallet,
// refreshClassificationsForUser, refreshDerivedForUser, historicalPriceJob),
// and it had already drifted once: the nightly price job forgot the final
// backfill, so a transactions row first created by a backfilled price stayed
// unclassified until the next day's expense sync. The step list lives here and
// the call sites only parameterize it.
//
// Value before mirror and activity is load-bearing: both derivations read
// eth_transfers.usd_at_time, so a stale valuation would be baked into both.
// Value before holdings is canonicalization only -- holdings read no usd
// columns -- chosen to match the sync site's historical order.
//
// EVERY dependency is resolved at call time off the required module objects
// (never destructured, never captured): the test harnesses stub these services
// by assigning properties on the module objects, and a captured function
// reference would silently bypass the stub. EthWalletService is required
// LAZILY inside the holdings step for the same reason plus a require cycle --
// EthWalletService requires this module at load time.

const logger = require('../config/logger');
const EthTransfer = require('../models/EthTransfer');
const EthWallet = require('../models/EthWallet');
const AssetPriceHistory = require('../models/AssetPriceHistory');
const HistoricalPriceService = require('./HistoricalPriceService');
const EthTransactionMirrorService = require('./EthTransactionMirrorService');
const EthActivityService = require('./EthActivityService');
const ExchangeMatchService = require('./ExchangeMatchService');
const TransactionClassificationService = require('./TransactionClassificationService');

// --- serialization ----------------------------------------------------------
//
// transactions/holdings rebuilds are delete-then-insert, so two rebuilds over
// the same user's data running concurrently (cron job, manual sync,
// sync-on-add, ignore-list refresh) would corrupt derived data. All such work
// funnels through a PER-USER lane: one user's two-click label write no longer
// queues behind another user's block-0 initial sync, which cross-user blocking
// was all the old single global chain bought beyond this. Single-process
// assumption, like every other coordination mechanism in this codebase.
const queues = new Map();

function serializedOn(key, fn) {
  const prev = queues.get(key) || Promise.resolve();
  // fn runs whether the predecessor resolved or rejected -- a failed rebuild
  // must not block its lane forever...
  const run = prev.then(fn, fn);
  // ...and the stored tail swallows both arms so the chain itself can never
  // surface as an unhandled rejection. The CALLER owns run's outcome.
  const tail = run.then(() => undefined, () => undefined);
  queues.set(key, tail);
  // Deleted only when no newer work superseded this tail -- the identity check
  // is load-bearing, or finishing one job would drop a busy lane's entry and
  // let the next enqueue start a second, concurrent chain.
  tail.then(() => { if (queues.get(key) === tail) queues.delete(key); });
  return run;
}

function serializedForUser(userId, fn) {
  return serializedOn(userId == null ? 'user:null' : `user:${userId}`, fn);
}

// Test introspection: how many lanes still hold work.
function pendingQueueCount() {
  return queues.size;
}

// One wallet's derived rows, in canonical order, up to (not including) the
// user-wide tail. Two fatality policies, matching the two kinds of caller:
//
//   isolateSteps: false -- the sync's policy. The first failure throws, the
//     caller's outer catch badges the wallet. (ensureAssets is the exception
//     and stays warn-caught: a price provider being down must not fail a sync
//     that already has every transfer.)
//   isolateSteps: true -- the refresh policy. Each step gets its own catch and
//     the rest still run, logged as '<Step> failed during <context>' with the
//     caller's context string, so one derivation's hiccup cannot skip its
//     neighbours on a click the user made for a different derivation entirely.
async function rebuildWallet(walletId, {
  reclassifyUserId = null,
  fillPrices = false,
  holdings = false,
  rebuildMatches = false,
  isolateSteps = false,
  context = null,
} = {}) {
  const results = { priced: null, valued: null, holdings: null, mirror: null, activity: null };

  const runStep = async (label, fn) => {
    if (!isolateSteps) return fn();
    try {
      return await fn();
    } catch (err) {
      logger.warn({ walletId, err }, `${label} failed during ${context}`);
      return null;
    }
  };

  // Counterparty labels are address-keyed with no chain dimension, so this is
  // user-wide, and it runs FIRST: the activity ladder reads counterparty_is_own
  // and counterparty_exchange off the freshly-classified legs. Throws in both
  // modes -- a reclassify that did not land makes every later step derive from
  // stale verdicts.
  if (reclassifyUserId != null) {
    await EthTransfer.reclassifyCounterparties(reclassifyUserId);
  }

  // At-the-time valuation (#73), BEFORE the mirror and the activity rebuild:
  // both read eth_transfers.usd_at_time instead of fetching a current price,
  // so a stale valuation here would be baked into both derivations. Filling
  // the series is best-effort -- a price provider being down must not fail a
  // sync that already has every transfer, and the rows simply stay unpriced
  // (never $0, never today's price) until the nightly job reaches them.
  if (fillPrices) {
    try {
      results.priced = await HistoricalPriceService.ensureAssetsForWallet(walletId);
    } catch (err) {
      logger.warn({ walletId, err }, 'Historical price fill failed; legs keep their previous valuation');
    }
  }
  // The SQL re-valuation runs every time: it touches no network, and skipping
  // it would strand the mirror on yesterday's prices.
  results.valued = await runStep('Re-valuation', () => AssetPriceHistory.applyToWallet(walletId));

  if (holdings) {
    // Lazy require: EthWalletService requires this module at load time, and the
    // multichain harness stubs refreshHoldings on the class object -- both need
    // the property lookup to happen here, at call time.
    results.holdings = await runStep('Holdings refresh',
      () => require('./EthWalletService').refreshHoldings(walletId));
  }

  results.mirror = await runStep('Mirror rebuild',
    () => EthTransactionMirrorService.rebuildForWallet(walletId));

  // rebuildMatches: false is for a caller walking EVERY wallet of one user --
  // the match pass is user-wide, so it belongs in finishUser after the loop,
  // not once per wallet against a half-rebuilt feed. The single-wallet sync
  // passes true so the pass runs inside the rebuild and its result rides on
  // the sync response.
  results.activity = await runStep('Activity rebuild',
    () => EthActivityService.rebuildForWallet(walletId, { rebuildMatches }));

  return results;
}

// The user-wide tail every walker runs once after its wallets have landed:
// match -> bridge -> mirror -> backfill.
async function finishUser(userId, {
  match = true,
  matchContext = {},
  context = null,
  // For log metadata only, on the sync-flavored call where the caller is a
  // single wallet rather than a user-wide refresh.
  walletId = null,
} = {}) {
  // rebuildForUserSafely never throws; a failed match pass logs itself and
  // returns null.
  const matches = match
    ? await ExchangeMatchService.rebuildForUserSafely(userId, matchContext)
    : null;

  // Bridge pairing is cross-CHAIN and cross-WALLET, so it runs once over the
  // owner's whole activity set -- the far side of a bridge a sync just
  // ingested may well sit on a different wallet row. Non-fatal: an unpaired
  // leg is flagged and visible, which is strictly better than reporting work
  // that landed as failed. Also NOT optional cleanup after a rebuild: the
  // activity DELETE cascades eth_activity_links away, so skipping this would
  // silently unpair every bridge the user has ever made.
  try {
    await EthActivityService.matchBridgeTransfersForUser(userId);
    // The per-wallet mirror runs before this user-wide matcher because the far
    // side of a bridge may live on another wallet. Once links exist, rebuild
    // the legacy transactions mirror so a confirmed bridge is a self-transfer
    // everywhere, while unmatched legs retain their conservative category.
    await EthTransactionMirrorService.rebuildForUser(userId);
  } catch (err) {
    if (context) logger.warn({ userId, err }, `Bridge matching failed during ${context}`);
    else logger.warn({ walletId, err }, 'Bridge matching failed; legs stay flagged for review');
  }

  // The final backfill stays GLOBAL -- it is an account-keyed derivation over
  // transactions, not an eth-wallet read -- and it throws: the callers that
  // treat the tail as fatal are the ones whose response promises the rebuild
  // landed. With per-user lanes, two users' tails could otherwise run this
  // full-table upsert concurrently -- a lock-order deadlock candidate -- so it
  // takes the one reserved cross-user chokepoint. No cycle: user lanes await
  // this lane, never the reverse.
  await serializedOn('global:backfill', () => TransactionClassificationService.backfill());

  return { matches };
}

// The whole pipeline for every wallet of one user, with per-step isolation --
// the shape behind a label write, an ignore toggle, and the nightly re-derive.
async function runForUser(userId, {
  reclassify = false,
  holdings = false,
  context = null,
  matchReason = null,
} = {}) {
  // Propagates, like the sync site: classification is what the caller's click
  // was for, so a reclassify that did not land is a failure, not a warning.
  if (reclassify) {
    await EthTransfer.reclassifyCounterparties(userId);
  }
  const wallets = await EthWallet.findAllByUser(userId);
  for (const wallet of wallets) {
    await rebuildWallet(wallet.id, {
      holdings, rebuildMatches: false, isolateSteps: true, context,
    });
  }
  return finishUser(userId, { matchContext: { reason: matchReason }, context });
}

// Follow-up, deliberately out of scope here: syncAllWallets still walks
// wallets flat and runs the user-wide tail once per WALLET (inside each
// _syncWallet). Giving it a once-per-user tail changes the nightly job's
// observable per-wallet results, so it is a separate decision.

module.exports = {
  rebuildWallet,
  finishUser,
  runForUser,
  serializedForUser,
  pendingQueueCount,
};

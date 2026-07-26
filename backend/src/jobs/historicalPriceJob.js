'use strict';

const JobLog = require('../models/JobLog');
const EthWallet = require('../models/EthWallet');
const HistoricalPriceService = require('../services/HistoricalPriceService');
const EthDerivedPipeline = require('../services/EthDerivedPipeline');
const logger = require('../config/logger');

const JOB_NAME = 'historical-prices';

// Two phases, in this order and for this reason:
//
//   1. Extend every ledger asset's dated series (the only phase that touches
//      the network). Backfill and daily append are the SAME operation -- the
//      series' stored range decides how far back the window reaches -- so the
//      first run backfills a decade and every run after appends a day, with no
//      separate one-shot script to remember to run.
//   2. Re-value the stored legs against the series and re-derive whatever moved,
//      through EthDerivedPipeline -- the same step list the sync and the label
//      writes run, which is what keeps this job from drifting away from them
//      again (it used to skip the classification backfill, so a transactions
//      row first created by a backfilled price stayed unclassified until the
//      next day's expense sync). Pure SQL and pure DB: neither the mirror nor
//      the activity rebuild fetches a price any more.
//
// Runs at 8:10 UTC: AFTER the ETH sync (7:50) so today's new transfers and any
// newly-seen token are in the work list, and before snapshots (9:00).
//
// A wallet whose re-derive throws does not stop the others -- the failure count
// is reported and the next run retries it, the same isolation the sync job
// applies per wallet.
async function run({ maxAssets } = {}) {
  logger.info({ job: JOB_NAME }, 'Starting historical price job');

  const isAlreadyRunning = await JobLog.isRunning(JOB_NAME);
  if (isAlreadyRunning) {
    logger.info({ job: JOB_NAME }, 'Job already running, skipping');
    return { skipped: true, reason: 'concurrent_execution' };
  }

  const jobLog = await JobLog.create(JOB_NAME);

  try {
    const backfill = await HistoricalPriceService.backfillLedgerAssets(
      maxAssets ? { maxAssets } : {}
    );

    const wallets = await EthWallet.findAllForJobs();
    const revalued = { wallets: wallets.length, legs: 0, rebuilt: 0, failed: 0 };

    // Grouped by OWNER, first-seen order, each user's wallet order preserved --
    // and each user's whole block runs inside their rebuild lane
    // (serializedForUser): these are the same delete-then-insert rebuilds the
    // 7:50 sync runs, and before the lane this job ran them unqueued, racing
    // any user-triggered sync or label write in flight.
    const byUser = new Map();
    for (const wallet of wallets) {
      const key = wallet.user_id ?? null;
      if (!byUser.has(key)) byUser.set(key, []);
      byUser.get(key).push(wallet);
    }

    for (const [userId, userWallets] of byUser) {
      await EthDerivedPipeline.serializedForUser(userId, async () => {
        for (const wallet of userWallets) {
          try {
            // Rebuilt UNCONDITIONALLY, not only when a valuation moved:
            // applyToWallet is idempotent, so "0 legs changed" is also what a
            // successful run looks like the night AFTER a rebuild threw, and a
            // single transient failure would otherwise strand the mirror on
            // pre-backfill amounts permanently. rebuildMatches: false, like
            // every per-wallet walker -- the match pass is user-wide and runs
            // once in the tail below.
            const derived = await EthDerivedPipeline.rebuildWallet(wallet.id, {
              rebuildMatches: false,
            });
            revalued.legs += derived.valued;
            revalued.rebuilt++;
          } catch (err) {
            revalued.failed++;
            logger.warn({ job: JOB_NAME, walletId: wallet.id, err }, 'Re-valuation failed for one wallet');
          }
        }

        // The user-wide tail: match, bridge, and the classification backfill.
        // Not optional cleanup -- rebuildWallet replaced eth_activity rows and
        // that DELETE cascaded eth_activity_links away, so skipping this would
        // render one $6,000 bridge as two rows summing $12,000 for the rest of
        // the day. Ownerless wallets have no tail: all three passes are
        // user-scoped derivations.
        if (userId == null) return;
        try {
          await EthDerivedPipeline.finishUser(userId, {
            matchContext: { reason: 'historical-prices' },
            context: 'nightly re-valuation',
          });
        } catch (err) {
          logger.warn({ job: JOB_NAME, userId, err }, 'Match/bridge rebuild failed for one user');
        }
      });
    }

    const result = { backfill, revalued };
    await JobLog.complete(
      jobLog.id,
      backfill.assets,
      backfill.covered + backfill.rangeLimited,
      backfill.failed + revalued.failed,
      result
    );
    logger.info({ job: JOB_NAME, ...result }, 'Historical price job completed');
    return result;
  } catch (error) {
    logger.error({ job: JOB_NAME, err: error }, 'Job failed');
    await JobLog.fail(jobLog.id, error.message, { stack: error.stack });
    throw error;
  }
}

module.exports = {
  JOB_NAME,
  run,
};

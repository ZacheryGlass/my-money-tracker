'use strict';

const JobLog = require('../models/JobLog');
const AssetPriceHistory = require('../models/AssetPriceHistory');
const EthWallet = require('../models/EthWallet');
const HistoricalPriceService = require('../services/HistoricalPriceService');
const EthTransactionMirrorService = require('../services/EthTransactionMirrorService');
const EthActivityService = require('../services/EthActivityService');
const logger = require('../config/logger');

const JOB_NAME = 'historical-prices';

// Two phases, in this order and for this reason:
//
//   1. Extend every ledger asset's dated series (the only phase that touches
//      the network). Backfill and daily append are the SAME operation -- the
//      series' stored range decides how far back the window reaches -- so the
//      first run backfills a decade and every run after appends a day, with no
//      separate one-shot script to remember to run.
//   2. Re-value the stored legs against the series and re-derive whatever moved.
//      Pure SQL and pure DB: neither the mirror nor the activity rebuild fetches
//      a price any more, they read eth_transfers.usd_at_time. That is what makes
//      a nightly full re-derive affordable, and it is what heals history the
//      moment a backfill reaches dates that were unpriced yesterday.
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

    for (const wallet of wallets) {
      try {
        revalued.legs += await AssetPriceHistory.applyToWallet(wallet.id);
        // Rebuilt UNCONDITIONALLY, not only when a valuation moved.
        //
        // applyToWallet is idempotent, so "0 legs changed" is also what a
        // successful run looks like on the night AFTER a rebuild threw --
        // meaning a single transient failure would strand the mirror on
        // pre-backfill amounts permanently. The only other unconditional
        // rebuild is the ETH sync, and that SKIPS wallets whose owner has no
        // Etherscan key, so for those nothing would ever heal it. Both rebuilds
        // are pure DB work since #73 (neither fetches a price any more), which
        // is what makes doing them every night affordable.
        await EthTransactionMirrorService.rebuildForWallet(wallet.id);
        await EthActivityService.rebuildForWallet(wallet.id);
        revalued.rebuilt++;
      } catch (err) {
        revalued.failed++;
        logger.warn({ job: JOB_NAME, walletId: wallet.id, err }, 'Re-valuation failed for one wallet');
      }
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

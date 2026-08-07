'use strict';

const JobLog = require('../models/JobLog');
const EthWalletService = require('../services/EthWalletService');
const EthWallet = require('../models/EthWallet');
const logger = require('../config/logger');

const JOB_NAME = 'eth-sync';

async function execute(jobLog) {
  try {
    const wallets = await EthWallet.findAllForJobs();
    if (wallets.length === 0) {
      const summary = {
        processed: 0,
        succeeded: 0,
        failed: 0,
        deferred: 0,
        unsupported: 0,
        unverified: 0,
        skipped: 0,
        results: [],
      };
      await JobLog.complete(jobLog.id, 0, 0, 0, { ...summary, reason: 'no_wallets' });
      logger.info({ job: JOB_NAME }, 'No ETH wallets to sync');
      return { ...summary, skipped: true, reason: 'no_wallets' };
    }
    // Keys are per-user now: syncAllWallets skips wallets whose owner has no
    // Etherscan key, so there is no global configured/not-configured gate.
    logger.info({ job: JOB_NAME }, 'Starting ETH wallet sync job');

    const summary = await EthWalletService.syncAllWallets();
    await JobLog.complete(jobLog.id, summary.processed, summary.succeeded, summary.failed, {
      deferred: summary.deferred,
      unsupported: summary.unsupported,
      unverified: summary.unverified,
      skipped: summary.skipped,
      results: summary.results,
    });
    logger.info({ job: JOB_NAME, ...summary }, 'ETH wallet sync job completed');
    return summary;
  } catch (error) {
    logger.error({ job: JOB_NAME, err: error }, 'Job failed');
    await JobLog.fail(jobLog.id, error.message, { stack: error.stack });
    throw error;
  }
}

async function claim() {
  const jobLog = await JobLog.createIfNotRunning(JOB_NAME);
  if (!jobLog) {
    logger.info({ job: JOB_NAME }, 'Job already running, skipping');
    return null;
  }
  return jobLog;
}

async function run() {
  const jobLog = await claim();
  if (!jobLog) return { skipped: true, reason: 'concurrent_execution' };
  return execute(jobLog);
}

// Manual full scans can legitimately wait through several provider cooldowns.
// Claim the durable JobLog row before responding, then run outside the HTTP
// request lifecycle so Azure's request timeout cannot turn a healthy scan into
// an apparent UI failure. Errors are already persisted by execute().
async function enqueue() {
  const jobLog = await claim();
  if (!jobLog) return { skipped: true, reason: 'concurrent_execution' };
  setImmediate(() => {
    void execute(jobLog).catch(() => {});
  });
  return { started: true, jobLogId: jobLog.id };
}

module.exports = { JOB_NAME, run, enqueue };

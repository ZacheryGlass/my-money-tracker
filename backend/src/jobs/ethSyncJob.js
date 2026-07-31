'use strict';

const JobLog = require('../models/JobLog');
const EthWalletService = require('../services/EthWalletService');
const EthWallet = require('../models/EthWallet');
const logger = require('../config/logger');

const JOB_NAME = 'eth-sync';

async function run() {
  const wallets = await EthWallet.findAllForJobs();
  if (wallets.length === 0) {
    logger.info({ job: JOB_NAME }, 'No ETH wallets to sync, skipping');
    return { skipped: true, reason: 'no_wallets' };
  }
  // Keys are per-user now: syncAllWallets skips wallets whose owner has no
  // Etherscan key, so there is no global configured/not-configured gate.

  logger.info({ job: JOB_NAME }, 'Starting ETH wallet sync job');

  const jobLog = await JobLog.createIfNotRunning(JOB_NAME);
  if (!jobLog) {
    logger.info({ job: JOB_NAME }, 'Job already running, skipping');
    return { skipped: true, reason: 'concurrent_execution' };
  }


  try {
    const summary = await EthWalletService.syncAllWallets();
    await JobLog.complete(jobLog.id, summary.processed, summary.succeeded, summary.failed, { results: summary.results });
    logger.info({ job: JOB_NAME, ...summary }, 'ETH wallet sync job completed');
    return summary;
  } catch (error) {
    logger.error({ job: JOB_NAME, err: error }, 'Job failed');
    await JobLog.fail(jobLog.id, error.message, { stack: error.stack });
    throw error;
  }
}

module.exports = { JOB_NAME, run };

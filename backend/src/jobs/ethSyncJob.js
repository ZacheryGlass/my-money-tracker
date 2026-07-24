'use strict';

const JobLog = require('../models/JobLog');
const EthWalletService = require('../services/EthWalletService');
const EthWallet = require('../models/EthWallet');
const etherscan = require('../config/etherscan');
const logger = require('../config/logger');

const JOB_NAME = 'eth-sync';

async function run() {
  const wallets = await EthWallet.findAll();
  if (wallets.length === 0) {
    logger.info({ job: JOB_NAME }, 'No ETH wallets to sync, skipping');
    return { skipped: true, reason: 'no_wallets' };
  }
  if (!etherscan.isConfigured()) {
    logger.warn({ job: JOB_NAME }, 'ETHERSCAN_API_KEY not set, skipping');
    return { skipped: true, reason: 'not_configured' };
  }

  logger.info({ job: JOB_NAME }, 'Starting ETH wallet sync job');

  const isAlreadyRunning = await JobLog.isRunning(JOB_NAME);
  if (isAlreadyRunning) {
    logger.info({ job: JOB_NAME }, 'Job already running, skipping');
    return { skipped: true, reason: 'concurrent_execution' };
  }

  const jobLog = await JobLog.create(JOB_NAME);

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

'use strict';

const JobLog = require('../models/JobLog');
const ExchangeAccount = require('../models/ExchangeAccount');
const ExchangeSyncService = require('../services/ExchangeSyncService');
const logger = require('../config/logger');

const JOB_NAME = 'exchange-sync';

async function run() {
  // findAllForJobs already restricts to accounts holding a credential, so an
  // account that only ever took CSV uploads is not counted as a skip every
  // night -- there is nothing to sync and nothing wrong.
  const accounts = await ExchangeAccount.findAllForJobs();
  if (accounts.length === 0) {
    logger.info({ job: JOB_NAME }, 'No connected exchange accounts to sync, skipping');
    return { skipped: true, reason: 'no_accounts' };
  }
  // Credentials are per account, so there is no global configured/not
  // configured gate: syncAllAccounts skips the ones whose key is missing or
  // unreadable and keeps going.

  logger.info({ job: JOB_NAME }, 'Starting exchange API sync job');

  const jobLog = await JobLog.createIfNotRunning(JOB_NAME);
  if (!jobLog) {
    logger.info({ job: JOB_NAME }, 'Job already running, skipping');
    return { skipped: true, reason: 'concurrent_execution' };
  }

  try {
    const summary = await ExchangeSyncService.syncAllAccounts();
    await JobLog.complete(jobLog.id, summary.processed, summary.succeeded, summary.failed, {
      results: summary.results,
      skipped: summary.skipped,
      mismatched: summary.mismatched,
    });
    logger.info({ job: JOB_NAME, ...summary }, 'Exchange API sync job completed');
    return summary;
  } catch (error) {
    logger.error({ job: JOB_NAME, err: error }, 'Job failed');
    await JobLog.fail(jobLog.id, error.message, { stack: error.stack });
    throw error;
  }
}

module.exports = { JOB_NAME, run };

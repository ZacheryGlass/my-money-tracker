'use strict';

const JobLog = require('../models/JobLog');
const PlaidService = require('../services/PlaidService');
const PlaidItem = require('../models/PlaidItem');
const logger = require('../config/logger');

const JOB_NAME = 'plaid-sync';

async function run() {
  const items = await PlaidItem.findAll();
  if (items.length === 0) {
    logger.info({ job: JOB_NAME }, 'No Plaid items to sync, skipping');
    return { skipped: true, reason: 'no_items' };
  }

  logger.info({ job: JOB_NAME }, 'Starting Plaid sync job');

  const isAlreadyRunning = await JobLog.isRunning(JOB_NAME);
  if (isAlreadyRunning) {
    logger.info({ job: JOB_NAME }, 'Job already running, skipping');
    return { skipped: true, reason: 'concurrent_execution' };
  }

  const jobLog = await JobLog.create(JOB_NAME);

  try {
    const summary = await PlaidService.syncAllItems();
    await JobLog.complete(jobLog.id, summary.processed, summary.succeeded, summary.failed, { results: summary.results });
    logger.info({ job: JOB_NAME, ...summary }, 'Plaid sync job completed');
    return summary;
  } catch (error) {
    logger.error({ job: JOB_NAME, err: error }, 'Job failed');
    await JobLog.fail(jobLog.id, error.message, { stack: error.stack });
    throw error;
  }
}

module.exports = { JOB_NAME, run };

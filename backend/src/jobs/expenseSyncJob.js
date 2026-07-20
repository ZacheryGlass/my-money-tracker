'use strict';

const JobLog = require('../models/JobLog');
const ExpenseSyncService = require('../services/ExpenseSyncService');
const TransactionClassificationService = require('../services/TransactionClassificationService');
const logger = require('../config/logger');

const JOB_NAME = 'expense-sync';

async function run() {
  logger.info({ job: JOB_NAME }, 'Starting expense sync job');

  const isAlreadyRunning = await JobLog.isRunning(JOB_NAME);
  if (isAlreadyRunning) {
    logger.info({ job: JOB_NAME }, 'Job already running, skipping');
    return { skipped: true, reason: 'concurrent_execution' };
  }

  const jobLog = await JobLog.create(JOB_NAME);

  try {
    const classification = await TransactionClassificationService.backfill();
    const result = await ExpenseSyncService.run();
    const updated = result.refreshed.length + result.created.length;
    await JobLog.complete(jobLog.id, result.groupCount, updated, 0, {
      classified: classification.classified,
      matched: result.matched,
      refreshed: result.refreshed.length,
      created: result.created,
      skipped: result.skipped,
    });
    logger.info({ job: JOB_NAME, updated, created: result.created.length }, 'Expense sync job completed');
    return result;
  } catch (error) {
    logger.error({ job: JOB_NAME, err: error }, 'Job failed');
    await JobLog.fail(jobLog.id, error.message, { stack: error.stack });
    throw error;
  }
}

module.exports = { run, JOB_NAME };

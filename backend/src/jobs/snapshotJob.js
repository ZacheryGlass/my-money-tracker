'use strict';

const JobLog = require('../models/JobLog');
const SnapshotService = require('../services/SnapshotService');
const logger = require('../config/logger');

const JOB_NAME = 'snapshot-creation';

async function run() {
  logger.info({ job: JOB_NAME }, 'Starting snapshot creation job');

  // Check for concurrent execution
  const isAlreadyRunning = await JobLog.isRunning(JOB_NAME);
  if (isAlreadyRunning) {
    logger.info({ job: JOB_NAME }, 'Job already running, skipping');
    return { skipped: true, reason: 'concurrent_execution' };
  }

  // Create job log entry
  const jobLog = await JobLog.create(JOB_NAME);
  logger.info({ job: JOB_NAME, logId: jobLog.id }, 'Created job log entry');

  try {
    const now = new Date();
    const snapshotDate = now.toISOString().split('T')[0];

    logger.info({ job: JOB_NAME, snapshotDate }, 'Creating snapshots');

    // Create daily snapshots
    const result = await SnapshotService.createDailySnapshots(snapshotDate);

    if (result.skipped) {
      await JobLog.complete(jobLog.id, 0, 0, 0, { message: result.reason });
      logger.info({ job: JOB_NAME, reason: result.reason }, 'Snapshot creation skipped');
      return result;
    }

    // Extract metrics from result
    const tickerProcessed = result.tickerSnapshots.processed;
    const tickerSucceeded = result.tickerSnapshots.succeeded;
    const tickerFailed = result.tickerSnapshots.failed;
    const totalCreated = result.tickerSnapshots.created + result.accountSnapshots.created;

    // Log results
    await JobLog.complete(jobLog.id, tickerProcessed, tickerSucceeded, tickerFailed, {
      snapshotDate,
      tickerSnapshots: result.tickerSnapshots,
      accountSnapshots: result.accountSnapshots
    });

    logger.info({ job: JOB_NAME, totalCreated }, 'Snapshot creation job completed');
    return result;

  } catch (error) {
    logger.error({ job: JOB_NAME, err: error }, 'Job failed');
    await JobLog.fail(jobLog.id, error.message, { stack: error.stack });
    throw error;
  }
}

module.exports = {
  JOB_NAME,
  run
};

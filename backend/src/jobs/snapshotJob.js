const JobLog = require('../models/JobLog');
const SnapshotService = require('../services/SnapshotService');

const JOB_NAME = 'snapshot-creation';

async function run() {
  console.log(`[${JOB_NAME}] Starting snapshot creation job...`);

  // Check for concurrent execution
  const isAlreadyRunning = await JobLog.isRunning(JOB_NAME);
  if (isAlreadyRunning) {
    console.log(`[${JOB_NAME}] Job already running, skipping...`);
    return { skipped: true, reason: 'concurrent_execution' };
  }

  // Create job log entry
  const jobLog = await JobLog.create(JOB_NAME);
  console.log(`[${JOB_NAME}] Created job log entry: ${jobLog.id}`);

  try {
    // Snapshot is created for today's date, using prices fetched 1 hour earlier at 8 AM
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const snapshotDate = today.toISOString().split('T')[0];

    console.log(`[${JOB_NAME}] Creating snapshots for date: ${snapshotDate}`);

    // Create daily snapshots
    const result = await SnapshotService.createDailySnapshots(snapshotDate);

    if (result.skipped) {
      await JobLog.complete(jobLog.id, 0, 0, 0, { message: result.reason });
      console.log(`[${JOB_NAME}] Snapshot creation skipped: ${result.reason}`);
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

    console.log(`[${JOB_NAME}] Completed: ${totalCreated} snapshots created`);
    return result;

  } catch (error) {
    console.error(`[${JOB_NAME}] Job failed:`, error.message);
    await JobLog.fail(jobLog.id, error.message, { stack: error.stack });
    throw error;
  }
}

module.exports = {
  JOB_NAME,
  run
};

const cron = require('node-cron');
const PriceUpdateJob = require('./priceUpdateJob');
const SnapshotJob = require('./snapshotJob');
const JobLog = require('../models/JobLog');

const TIMEZONE = 'America/Mexico_City';

// Store scheduled task references
let priceUpdateTask = null;
let snapshotTask = null;

function initializeJobs() {
  // Schedule price update at 8 AM daily
  priceUpdateTask = cron.schedule('0 8 * * *', async () => {
    console.log('[scheduler] Running scheduled price update...');
    try {
      await PriceUpdateJob.run();
    } catch (error) {
      console.error('[scheduler] Price update failed:', error.message);
    }
  }, {
    timezone: TIMEZONE
  });

  // Schedule snapshot creation at 9 AM daily (after price update)
  snapshotTask = cron.schedule('0 9 * * *', async () => {
    console.log('[scheduler] Running scheduled snapshot creation...');
    try {
      await SnapshotJob.run();
    } catch (error) {
      console.error('[scheduler] Snapshot creation failed:', error.message);
    }
  }, {
    timezone: TIMEZONE
  });

  console.log(`Scheduled jobs initialized (timezone: ${TIMEZONE})`);
  console.log('  - price-update: 0 8 * * * (8 AM daily)');
  console.log('  - snapshot-creation: 0 9 * * * (9 AM daily)');
}

function stopJobs() {
  if (priceUpdateTask) {
    priceUpdateTask.stop();
    priceUpdateTask.destroy();
  }
  if (snapshotTask) {
    snapshotTask.stop();
    snapshotTask.destroy();
  }
  console.log('[scheduler] Scheduled jobs stopped');
}

async function getJobStatus() {
  const [latestPriceUpdate, latestSnapshot] = await Promise.all([
    JobLog.getLatest(PriceUpdateJob.JOB_NAME),
    JobLog.getLatest(SnapshotJob.JOB_NAME)
  ]);

  return {
    jobs: {
      'price-update': {
        schedule: '0 8 * * *',
        timezone: TIMEZONE,
        description: 'Fetches crypto prices from multiple providers',
        lastRun: latestPriceUpdate || null
      },
      'snapshot-creation': {
        schedule: '0 9 * * *',
        timezone: TIMEZONE,
        description: 'Creates daily snapshots of portfolio holdings and account totals',
        lastRun: latestSnapshot || null
      }
    }
  };
}

module.exports = {
  initializeJobs,
  stopJobs,
  getJobStatus,
  PriceUpdateJob,
  SnapshotJob
};

'use strict';

const cron = require('node-cron');
const PriceUpdateJob = require('./priceUpdateJob');
const SnapshotJob = require('./snapshotJob');
const PlaidSyncJob = require('./plaidSyncJob');
const JobLog = require('../models/JobLog');
const logger = require('../config/logger');

const TIMEZONE = 'America/Mexico_City';

// Store scheduled task references
let plaidSyncTask = null;
let priceUpdateTask = null;
let snapshotTask = null;

function initializeJobs() {
  // Schedule Plaid sync at 7:30 AM daily (before price update)
  plaidSyncTask = cron.schedule('30 7 * * *', async () => {
    logger.info('[scheduler] Running scheduled Plaid sync...');
    try {
      await PlaidSyncJob.run();
    } catch (error) {
      logger.error({ err: error }, '[scheduler] Plaid sync failed');
    }
  }, {
    timezone: TIMEZONE
  });

  // Schedule price update at 8 AM daily
  priceUpdateTask = cron.schedule('0 8 * * *', async () => {
    logger.info('[scheduler] Running scheduled price update...');
    try {
      await PriceUpdateJob.run();
    } catch (error) {
      logger.error({ err: error }, '[scheduler] Price update failed');
    }
  }, {
    timezone: TIMEZONE
  });

  // Schedule snapshot creation at 9 AM daily (after price update)
  snapshotTask = cron.schedule('0 9 * * *', async () => {
    logger.info('[scheduler] Running scheduled snapshot creation...');
    try {
      await SnapshotJob.run();
    } catch (error) {
      logger.error({ err: error }, '[scheduler] Snapshot creation failed');
    }
  }, {
    timezone: TIMEZONE
  });

  logger.info({ timezone: TIMEZONE }, 'Scheduled jobs initialized');
}

function stopJobs() {
  if (plaidSyncTask) {
    plaidSyncTask.stop();
    plaidSyncTask.destroy();
  }
  if (priceUpdateTask) {
    priceUpdateTask.stop();
    priceUpdateTask.destroy();
  }
  if (snapshotTask) {
    snapshotTask.stop();
    snapshotTask.destroy();
  }
  logger.info('[scheduler] Scheduled jobs stopped');
}

async function getJobStatus() {
  const [latestPlaidSync, latestPriceUpdate, latestSnapshot] = await Promise.all([
    JobLog.getLatest(PlaidSyncJob.JOB_NAME),
    JobLog.getLatest(PriceUpdateJob.JOB_NAME),
    JobLog.getLatest(SnapshotJob.JOB_NAME)
  ]);

  return {
    jobs: {
      'plaid-sync': {
        schedule: '30 7 * * *',
        timezone: TIMEZONE,
        description: 'Syncs balances and holdings from connected Plaid accounts',
        lastRun: latestPlaidSync || null
      },
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
  PlaidSyncJob,
  PriceUpdateJob,
  SnapshotJob
};

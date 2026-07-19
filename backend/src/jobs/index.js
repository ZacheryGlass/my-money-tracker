'use strict';

const cron = require('node-cron');
const PriceUpdateJob = require('./priceUpdateJob');
const SnapshotJob = require('./snapshotJob');
const PlaidSyncJob = require('./plaidSyncJob');
const BenchmarkUpdateJob = require('./benchmarkUpdateJob');
const JobLog = require('../models/JobLog');
const logger = require('../config/logger');

// Store scheduled task references
let plaidSyncTask = null;
let priceUpdateTask = null;
let snapshotTask = null;
let benchmarkUpdateTask = null;

function initializeJobs() {
  // Schedule Plaid sync at 7:30 AM UTC daily (before price update)
  plaidSyncTask = cron.schedule('30 7 * * *', async () => {
    logger.info('[scheduler] Running scheduled Plaid sync...');
    try {
      await PlaidSyncJob.run();
    } catch (error) {
      logger.error({ err: error }, '[scheduler] Plaid sync failed');
    }
  }, {
    timezone: 'Etc/UTC'
  });

  // Schedule price update at 8 AM UTC daily
  priceUpdateTask = cron.schedule('0 8 * * *', async () => {
    logger.info('[scheduler] Running scheduled price update...');
    try {
      await PriceUpdateJob.run();
    } catch (error) {
      logger.error({ err: error }, '[scheduler] Price update failed');
    }
  }, {
    timezone: 'Etc/UTC'
  });

  // Schedule benchmark price update at 8:30 AM UTC daily (after price update)
  benchmarkUpdateTask = cron.schedule('30 8 * * *', async () => {
    logger.info('[scheduler] Running scheduled benchmark update...');
    try {
      await BenchmarkUpdateJob.run();
    } catch (error) {
      logger.error({ err: error }, '[scheduler] Benchmark update failed');
    }
  }, {
    timezone: 'Etc/UTC'
  });

  // Schedule snapshot creation at 9 AM UTC daily (after price update)
  snapshotTask = cron.schedule('0 9 * * *', async () => {
    logger.info('[scheduler] Running scheduled snapshot creation...');
    try {
      await SnapshotJob.run();
    } catch (error) {
      logger.error({ err: error }, '[scheduler] Snapshot creation failed');
    }
  }, {
    timezone: 'Etc/UTC'
  });

  logger.info('Scheduled jobs initialized (UTC)');
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
  if (benchmarkUpdateTask) {
    benchmarkUpdateTask.stop();
    benchmarkUpdateTask.destroy();
  }
  logger.info('[scheduler] Scheduled jobs stopped');
}

async function getJobStatus() {
  const [latestPlaidSync, latestPriceUpdate, latestSnapshot, latestBenchmarkUpdate] = await Promise.all([
    JobLog.getLatest(PlaidSyncJob.JOB_NAME),
    JobLog.getLatest(PriceUpdateJob.JOB_NAME),
    JobLog.getLatest(SnapshotJob.JOB_NAME),
    JobLog.getLatest(BenchmarkUpdateJob.JOB_NAME)
  ]);

  return {
    jobs: {
      'plaid-sync': {
        schedule: '30 7 * * *',
        timezone: 'Etc/UTC',
        description: 'Syncs balances and holdings from connected Plaid accounts',
        lastRun: latestPlaidSync || null
      },
      'price-update': {
        schedule: '0 8 * * *',
        timezone: 'Etc/UTC',
        description: 'Fetches crypto prices from multiple providers',
        lastRun: latestPriceUpdate || null
      },
      'benchmark-update': {
        schedule: '30 8 * * *',
        timezone: 'Etc/UTC',
        description: 'Fetches S&P 500 (SPY) and Nasdaq 100 (QQQ) daily prices for benchmark comparison',
        lastRun: latestBenchmarkUpdate || null
      },
      'snapshot-creation': {
        schedule: '0 9 * * *',
        timezone: 'Etc/UTC',
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
  SnapshotJob,
  BenchmarkUpdateJob
};

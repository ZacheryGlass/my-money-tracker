'use strict';

const cron = require('node-cron');
const PriceUpdateJob = require('./priceUpdateJob');
const SnapshotJob = require('./snapshotJob');
const PlaidSyncJob = require('./plaidSyncJob');
const EthSyncJob = require('./ethSyncJob');
const ExchangeSyncJob = require('./exchangeSyncJob');
const BenchmarkUpdateJob = require('./benchmarkUpdateJob');
const HistoricalPriceJob = require('./historicalPriceJob');
const ExpenseSyncJob = require('./expenseSyncJob');
const JobLog = require('../models/JobLog');
const logger = require('../config/logger');

// Store scheduled task references
let plaidSyncTask = null;
let ethSyncTask = null;
let exchangeSyncTask = null;
let priceUpdateTask = null;
let snapshotTask = null;
let benchmarkUpdateTask = null;
let historicalPriceTask = null;
let expenseSyncTask = null;
const PROCESS_STARTED_AT = new Date();

async function initializeJobs() {
  const interrupted = await JobLog.failInterruptedRuns(PROCESS_STARTED_AT);
  if (interrupted.length > 0) {
    logger.warn({
      jobs: interrupted.map(({ id, job_name: jobName, started_at: startedAt }) => ({
        id, jobName, startedAt,
      })),
    }, 'Marked jobs interrupted by the previous application process as failed');
  }

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

  // Schedule expense sync at 7:45 AM UTC daily (after Plaid sync lands new transactions)
  expenseSyncTask = cron.schedule('45 7 * * *', async () => {
    logger.info('[scheduler] Running scheduled expense sync...');
    try {
      await ExpenseSyncJob.run();
    } catch (error) {
      logger.error({ err: error }, '[scheduler] Expense sync failed');
    }
  }, {
    timezone: 'Etc/UTC'
  });

  // Schedule ETH wallet sync at 7:50 AM UTC daily (before price update so the
  // ETH price and 9:00 snapshots see fresh quantities)
  ethSyncTask = cron.schedule('50 7 * * *', async () => {
    logger.info('[scheduler] Running scheduled ETH wallet sync...');
    try {
      await EthSyncJob.run();
    } catch (error) {
      logger.error({ err: error }, '[scheduler] ETH wallet sync failed');
    }
  }, {
    timezone: 'Etc/UTC'
  });

  // Schedule exchange API sync at 7:55 AM UTC daily (after the ETH sync, before
  // the price update, so the 9:00 snapshots see a settled picture)
  exchangeSyncTask = cron.schedule('55 7 * * *', async () => {
    logger.info('[scheduler] Running scheduled exchange API sync...');
    try {
      await ExchangeSyncJob.run();
    } catch (error) {
      logger.error({ err: error }, '[scheduler] Exchange API sync failed');
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

  // Schedule the historical price backfill at 8:10 AM UTC daily -- AFTER the
  // ETH sync (7:50), so today's new transfers and any newly-seen token are in
  // the work list, and before snapshots (9:00). It also re-values stored legs
  // and re-derives whatever moved, which is what heals a date that was unpriced
  // yesterday.
  historicalPriceTask = cron.schedule('10 8 * * *', async () => {
    logger.info('[scheduler] Running scheduled historical price backfill...');
    try {
      await HistoricalPriceJob.run();
    } catch (error) {
      logger.error({ err: error }, '[scheduler] Historical price backfill failed');
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
  if (ethSyncTask) {
    ethSyncTask.stop();
    ethSyncTask.destroy();
  }
  if (exchangeSyncTask) {
    exchangeSyncTask.stop();
    exchangeSyncTask.destroy();
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
  if (historicalPriceTask) {
    historicalPriceTask.stop();
    historicalPriceTask.destroy();
  }
  if (expenseSyncTask) {
    expenseSyncTask.stop();
    expenseSyncTask.destroy();
  }
  logger.info('[scheduler] Scheduled jobs stopped');
}

async function getJobStatus() {
  const [latestPlaidSync, latestEthSync, latestExchangeSync, latestPriceUpdate, latestSnapshot, latestBenchmarkUpdate, latestExpenseSync, latestHistoricalPrices] = await Promise.all([
    JobLog.getLatest(PlaidSyncJob.JOB_NAME),
    JobLog.getLatest(EthSyncJob.JOB_NAME),
    JobLog.getLatest(ExchangeSyncJob.JOB_NAME),
    JobLog.getLatest(PriceUpdateJob.JOB_NAME),
    JobLog.getLatest(SnapshotJob.JOB_NAME),
    JobLog.getLatest(BenchmarkUpdateJob.JOB_NAME),
    JobLog.getLatest(ExpenseSyncJob.JOB_NAME),
    JobLog.getLatest(HistoricalPriceJob.JOB_NAME)
  ]);

  return {
    jobs: {
      'plaid-sync': {
        schedule: '30 7 * * *',
        timezone: 'Etc/UTC',
        description: 'Syncs balances and holdings from connected Plaid accounts',
        lastRun: latestPlaidSync || null
      },
      'expense-sync': {
        schedule: '45 7 * * *',
        timezone: 'Etc/UTC',
        description: 'Matches recurring expenses to transaction merchants and refreshes derived costs',
        lastRun: latestExpenseSync || null
      },
      'eth-sync': {
        schedule: '50 7 * * *',
        timezone: 'Etc/UTC',
        description: 'Syncs transfers and balances for tracked EVM wallets through configured chain providers',
        lastRun: latestEthSync || null
      },
      'exchange-sync': {
        schedule: '55 7 * * *',
        timezone: 'Etc/UTC',
        description: 'Pulls ledger activity and balances from connected Kraken and Coinbase accounts',
        lastRun: latestExchangeSync || null
      },
      'price-update': {
        schedule: '0 8 * * *',
        timezone: 'Etc/UTC',
        description: 'Fetches crypto prices from multiple providers',
        lastRun: latestPriceUpdate || null
      },
      'historical-prices': {
        schedule: '10 8 * * *',
        timezone: 'Etc/UTC',
        description: 'Backfills and extends the dated USD price series, then re-values on-chain history at its transaction dates',
        lastRun: latestHistoricalPrices || null
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
  EthSyncJob,
  ExchangeSyncJob,
  PriceUpdateJob,
  SnapshotJob,
  BenchmarkUpdateJob,
  HistoricalPriceJob,
  ExpenseSyncJob
};

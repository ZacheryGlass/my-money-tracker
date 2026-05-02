'use strict';

const Holding = require('../models/Holding');
const JobLog = require('../models/JobLog');
const PriceService = require('../services/PriceService');
const logger = require('../config/logger');

const JOB_NAME = 'price-update';

async function run() {
  logger.info({ job: JOB_NAME }, 'Starting price update job');

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
    // Get all holdings and filter for crypto
    const holdings = await Holding.findAll();
    const cryptoHoldings = holdings.filter(h => h.category === 'Crypto');

    // Extract unique tickers
    const tickers = [...new Set(
      cryptoHoldings
        .map(h => h.ticker)
        .filter(t => t) // Remove null/undefined
    )];

    logger.info({ job: JOB_NAME, tickers }, `Found ${tickers.length} unique crypto tickers`);

    if (tickers.length === 0) {
      await JobLog.complete(jobLog.id, 0, 0, 0, { message: 'No crypto tickers found' });
      logger.info({ job: JOB_NAME }, 'No crypto tickers to update');
      return { processed: 0, succeeded: 0, failed: 0 };
    }

    // Fetch prices for all tickers
    const results = await PriceService.fetchPricesForTickers(tickers);

    const succeeded = results.filter(r => r.success).length;
    const failed = results.filter(r => !r.success).length;

    // Log results
    await JobLog.complete(jobLog.id, tickers.length, succeeded, failed, { results });

    logger.info({ job: JOB_NAME, succeeded, failed }, 'Price update job completed');
    return { processed: tickers.length, succeeded, failed, results };

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

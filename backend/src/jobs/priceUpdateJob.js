const Holding = require('../models/Holding');
const JobLog = require('../models/JobLog');
const PriceService = require('../services/PriceService');

const JOB_NAME = 'price-update';

async function run() {
  console.log(`[${JOB_NAME}] Starting price update job...`);

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
    // Get all holdings and filter for crypto
    const holdings = await Holding.findAll();
    const cryptoHoldings = holdings.filter(h => h.category === 'Crypto');

    // Extract unique tickers
    const tickers = [...new Set(
      cryptoHoldings
        .map(h => h.ticker)
        .filter(t => t) // Remove null/undefined
    )];

    console.log(`[${JOB_NAME}] Found ${tickers.length} unique crypto tickers: ${tickers.join(', ')}`);

    if (tickers.length === 0) {
      await JobLog.complete(jobLog.id, 0, 0, 0, { message: 'No crypto tickers found' });
      console.log(`[${JOB_NAME}] No crypto tickers to update`);
      return { processed: 0, succeeded: 0, failed: 0 };
    }

    // Fetch prices for all tickers
    const results = await PriceService.fetchPricesForTickers(tickers);

    const succeeded = results.filter(r => r.success).length;
    const failed = results.filter(r => !r.success).length;

    // Log results
    await JobLog.complete(jobLog.id, tickers.length, succeeded, failed, { results });

    console.log(`[${JOB_NAME}] Completed: ${succeeded} succeeded, ${failed} failed`);
    return { processed: tickers.length, succeeded, failed, results };

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

'use strict';

const Holding = require('../models/Holding');
const JobLog = require('../models/JobLog');
const PriceService = require('../services/PriceService');
const { classifyTicker } = require('../utils/assetClassifier');
const logger = require('../config/logger');

const JOB_NAME = 'price-update';

async function run() {
  logger.info({ job: JOB_NAME }, 'Starting price update job');

  const isAlreadyRunning = await JobLog.isRunning(JOB_NAME);
  if (isAlreadyRunning) {
    logger.info({ job: JOB_NAME }, 'Job already running, skipping');
    return { skipped: true, reason: 'concurrent_execution' };
  }

  const jobLog = await JobLog.create(JOB_NAME);
  logger.info({ job: JOB_NAME, logId: jobLog.id }, 'Created job log entry');

  try {
    const holdings = await Holding.findAll();
    const holdingsWithTickers = holdings.filter(h => h.ticker && parseFloat(h.quantity || 0) > 0);

    const assetTypeMap = {};
    const tickerSet = new Set();
    for (const h of holdingsWithTickers) {
      const t = h.ticker;
      if (!tickerSet.has(t)) {
        tickerSet.add(t);
        assetTypeMap[t] = classifyTicker(t, h.category);
      }
    }

    const tickers = [...tickerSet];
    logger.info({ job: JOB_NAME, tickers, assetTypeMap }, `Found ${tickers.length} unique tickers`);

    if (tickers.length === 0) {
      await JobLog.complete(jobLog.id, 0, 0, 0, { message: 'No tickers found' });
      logger.info({ job: JOB_NAME }, 'No tickers to update');
      return { processed: 0, succeeded: 0, failed: 0 };
    }

    const results = await PriceService.fetchPricesForTickers(tickers, assetTypeMap);

    const succeeded = results.filter(r => r.success).length;
    const failed = results.filter(r => !r.success).length;

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

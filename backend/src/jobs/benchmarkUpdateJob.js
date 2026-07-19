'use strict';

const JobLog = require('../models/JobLog');
const BenchmarkService = require('../services/BenchmarkService');
const logger = require('../config/logger');

const JOB_NAME = 'benchmark-update';

async function run() {
  logger.info({ job: JOB_NAME }, 'Starting benchmark update job');

  const isAlreadyRunning = await JobLog.isRunning(JOB_NAME);
  if (isAlreadyRunning) {
    logger.info({ job: JOB_NAME }, 'Job already running, skipping');
    return { skipped: true, reason: 'concurrent_execution' };
  }

  const jobLog = await JobLog.create(JOB_NAME);

  try {
    const symbols = [];
    let totalFetched = 0;
    let totalUpserted = 0;
    let failed = 0;

    // Weekly full refresh (Sundays UTC): Yahoo rescales historical adjclose
    // on dividends/splits, so incremental-only syncing drifts over time.
    const fullRefresh = new Date().getUTCDay() === 0;

    // One symbol failing must not block the others; aggregate per-symbol
    // outcomes and only fail the job when every symbol fails.
    for (const symbol of BenchmarkService.SYMBOLS) {
      try {
        const symbolResult = await BenchmarkService.updateBenchmarkPrices(symbol, { fullRefresh });
        symbols.push(symbolResult);
        totalFetched += symbolResult.fetched;
        totalUpserted += symbolResult.upserted;
        logger.info({ job: JOB_NAME, ...symbolResult }, 'Benchmark symbol updated');
      } catch (error) {
        failed++;
        symbols.push({ symbol, error: error.message });
        logger.error({ job: JOB_NAME, symbol, err: error }, 'Benchmark symbol failed');
      }
    }

    if (failed === BenchmarkService.SYMBOLS.length) {
      throw new Error(`All benchmark symbols failed: ${symbols.map((s) => `${s.symbol}: ${s.error}`).join('; ')}`);
    }

    const result = { symbols, fetched: totalFetched, upserted: totalUpserted, failed, fullRefresh };
    await JobLog.complete(jobLog.id, totalFetched, totalUpserted, failed, result);
    logger.info({ job: JOB_NAME, fetched: totalFetched, upserted: totalUpserted, failed }, 'Benchmark update job completed');
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

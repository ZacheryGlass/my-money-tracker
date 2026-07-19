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

    for (const symbol of BenchmarkService.SYMBOLS) {
      const symbolResult = await BenchmarkService.updateBenchmarkPrices(symbol);
      symbols.push(symbolResult);
      totalFetched += symbolResult.fetched;
      totalUpserted += symbolResult.upserted;
      logger.info({ job: JOB_NAME, ...symbolResult }, 'Benchmark symbol updated');
    }

    const result = { symbols, fetched: totalFetched, upserted: totalUpserted };
    await JobLog.complete(jobLog.id, totalFetched, totalUpserted, totalFetched - totalUpserted, result);
    logger.info({ job: JOB_NAME, fetched: totalFetched, upserted: totalUpserted }, 'Benchmark update job completed');
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

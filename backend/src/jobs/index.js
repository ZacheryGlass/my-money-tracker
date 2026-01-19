const cron = require('node-cron');
const PriceUpdateJob = require('./priceUpdateJob');
const JobLog = require('../models/JobLog');

const TIMEZONE = 'America/Mexico_City';

// Store scheduled task references
let priceUpdateTask = null;

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

  console.log(`Scheduled jobs initialized (timezone: ${TIMEZONE})`);
  console.log('  - price-update: 0 8 * * * (8 AM daily)');
}

async function getJobStatus() {
  const latestPriceUpdate = await JobLog.getLatest(PriceUpdateJob.JOB_NAME);

  return {
    jobs: {
      'price-update': {
        schedule: '0 8 * * *',
        timezone: TIMEZONE,
        description: 'Fetches crypto prices from multiple providers',
        lastRun: latestPriceUpdate || null
      }
    }
  };
}

module.exports = {
  initializeJobs,
  getJobStatus,
  PriceUpdateJob
};

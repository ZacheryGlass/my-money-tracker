const express = require('express');
const router = express.Router();
const authenticateToken = require('../middleware/auth');
const { getJobStatus, PriceUpdateJob } = require('../jobs');
const JobLog = require('../models/JobLog');

// All routes require authentication
router.use(authenticateToken);

// GET /api/jobs/status - Get job configuration and status
router.get('/status', async (req, res, next) => {
  try {
    const status = await getJobStatus();
    res.json(status);
  } catch (error) {
    next(error);
  }
});

// GET /api/jobs/health - Health check for jobs
router.get('/health', async (req, res, next) => {
  try {
    const latestRun = await JobLog.getLatest(PriceUpdateJob.JOB_NAME);

    if (!latestRun) {
      return res.status(200).json({
        status: 'ok',
        message: 'No jobs have run yet'
      });
    }

    // Check if last run was successful and within 25 hours
    const lastRunTime = new Date(latestRun.started_at);
    const hoursSinceLastRun = (Date.now() - lastRunTime.getTime()) / (1000 * 60 * 60);

    if (latestRun.status === 'failed') {
      return res.status(503).json({
        status: 'unhealthy',
        message: 'Last job run failed',
        lastRun: latestRun
      });
    }

    if (hoursSinceLastRun > 25) {
      return res.status(503).json({
        status: 'unhealthy',
        message: 'Last job run was more than 25 hours ago',
        hoursSinceLastRun: Math.round(hoursSinceLastRun),
        lastRun: latestRun
      });
    }

    res.status(200).json({
      status: 'healthy',
      hoursSinceLastRun: Math.round(hoursSinceLastRun * 10) / 10,
      lastRun: latestRun
    });
  } catch (error) {
    next(error);
  }
});

// GET /api/jobs/history - Get job execution history
router.get('/history', async (req, res, next) => {
  try {
    const limit = parseInt(req.query.limit) || 10;
    const history = await JobLog.getHistory(PriceUpdateJob.JOB_NAME, limit);
    res.json({ history });
  } catch (error) {
    next(error);
  }
});

// POST /api/jobs/trigger/price-update - Manually trigger price update
router.post('/trigger/price-update', async (req, res, next) => {
  try {
    // Check if already running
    const isRunning = await JobLog.isRunning(PriceUpdateJob.JOB_NAME);
    if (isRunning) {
      return res.status(409).json({
        error: 'Job already running',
        message: 'A price update job is currently in progress'
      });
    }

    // Run the job
    const result = await PriceUpdateJob.run();
    res.json({
      message: 'Price update job completed',
      result
    });
  } catch (error) {
    next(error);
  }
});

module.exports = router;

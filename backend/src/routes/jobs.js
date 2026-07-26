const express = require('express');
const router = express.Router();
const requireUser = require('../middleware/auth');
const { getJobStatus, PriceUpdateJob, SnapshotJob, BenchmarkUpdateJob, PlaidSyncJob, EthSyncJob, ExchangeSyncJob, ExpenseSyncJob } = require('../jobs');
const JobLog = require('../models/JobLog');

// All routes require authentication
router.use(requireUser);

// Every job below price-update operates on EVERY user's data: the Plaid and
// ETH syncs resolve each item/wallet owner's own API credentials, and the
// snapshot/expense jobs write rows for all users. Triggering them is therefore
// admin-only -- hiding the Run Now buttons in the Server tab is not a control.
//
// price-update is deliberately left to any authenticated user: price_cache is
// shared global market data by design, and the Dashboard refresh button
// (Dashboard.jsx handleRefresh) calls it for everyone.
// The read endpoints are admin-only for the same reason: job_logs rows are
// shared across users and their `details` carry cross-user output -- the
// expense sync records every user's matched merchant names and costs, the
// price update every user's tickers. Nothing in the UI calls these; the Server
// tab gets job status through /api/admin/overview instead.
const requireAdmin = requireUser.requireAdmin;

// GET /api/jobs/status - Get job configuration and status
router.get('/status', requireAdmin, async (req, res, next) => {
  try {
    const status = await getJobStatus();
    res.json(status);
  } catch (error) {
    next(error);
  }
});

// GET /api/jobs/health - Health check for jobs
router.get('/health', requireAdmin, async (req, res, next) => {
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
router.get('/history', requireAdmin, async (req, res, next) => {
  try {
    const limit = parseInt(req.query.limit) || 10;
    const history = await JobLog.getHistory(PriceUpdateJob.JOB_NAME, limit);
    res.json({ history });
  } catch (error) {
    next(error);
  }
});

// Each job re-checks JobLog.isRunning itself, and the scheduler can start in
// the gap after the check below -- in which case the job returns
// { skipped: 'concurrent_execution' } rather than throwing. Reporting that as
// a 200 told the caller the run finished when nothing ran (the Server tab
// shows a success toast on any 200), so a self-skip becomes a 409 too. Other
// skip reasons (no_items, no_wallets) really are successful no-ops.
async function runTrigger(res, { job, label, project }) {
  const busy = () => res.status(409).json({
    error: 'Job already running',
    message: `${label} is currently in progress`
  });

  if (await JobLog.isRunning(job.JOB_NAME)) return busy();

  const result = await job.run();
  if (result?.skipped && result.reason === 'concurrent_execution') return busy();

  return res.json({
    message: `${label} completed`,
    result: project ? project(result) : result
  });
}

// POST /api/jobs/trigger/price-update - Manually trigger price update
router.post('/trigger/price-update', async (req, res, next) => {
  try {
    // Counts only. This is the one trigger any user may call, and the job's
    // `results` array is built from Holding.findAllForJobs() -- returning it
    // would hand the caller every other user's ticker inventory. The full
    // detail stays in the job log, which is admin-only.
    await runTrigger(res, {
      job: PriceUpdateJob,
      label: 'Price update job',
      project: ({ processed, succeeded, failed }) => ({ processed, succeeded, failed })
    });
  } catch (error) {
    next(error);
  }
});

// POST /api/jobs/trigger/benchmark-update - Manually trigger benchmark price update
router.post('/trigger/benchmark-update', requireAdmin, async (req, res, next) => {
  try {
    await runTrigger(res, { job: BenchmarkUpdateJob, label: 'Benchmark update job' });
  } catch (error) {
    next(error);
  }
});

// POST /api/jobs/trigger/plaid-sync - Manually trigger Plaid sync for every item
router.post('/trigger/plaid-sync', requireAdmin, async (req, res, next) => {
  try {
    await runTrigger(res, { job: PlaidSyncJob, label: 'Plaid sync job' });
  } catch (error) {
    next(error);
  }
});

// POST /api/jobs/trigger/eth-sync - Manually trigger ETH wallet sync for every wallet
router.post('/trigger/eth-sync', requireAdmin, async (req, res, next) => {
  try {
    await runTrigger(res, { job: EthSyncJob, label: 'ETH wallet sync job' });
  } catch (error) {
    next(error);
  }
});

// POST /api/jobs/trigger/exchange-sync - Manually trigger the API sync for
// every connected exchange account. Admin-only for the same reason the Plaid
// and ETH triggers are: it runs against every user's accounts using each
// account OWNER's credentials.
router.post('/trigger/exchange-sync', requireAdmin, async (req, res, next) => {
  try {
    await runTrigger(res, { job: ExchangeSyncJob, label: 'Exchange API sync job' });
  } catch (error) {
    next(error);
  }
});

// POST /api/jobs/trigger/expense-sync - Manually trigger classification,
// investment cash flow derivation, tax lot rebuild and expense matching
router.post('/trigger/expense-sync', requireAdmin, async (req, res, next) => {
  try {
    // Runs the same job the scheduler runs, rather than a subset: a manual run
    // that skipped the cash-flow derivation and tax-lot rebuild left those
    // stale, and writing no JobLog row meant the concurrency guard could never
    // see a manual run in progress.
    await runTrigger(res, { job: ExpenseSyncJob, label: 'Expense sync job' });
  } catch (error) {
    next(error);
  }
});

// POST /api/jobs/trigger/snapshot - Manually trigger snapshot creation
router.post('/trigger/snapshot', requireAdmin, async (req, res, next) => {
  try {
    await runTrigger(res, { job: SnapshotJob, label: 'Snapshot creation job' });
  } catch (error) {
    next(error);
  }
});

module.exports = router;

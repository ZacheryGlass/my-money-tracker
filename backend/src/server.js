require('dotenv').config();
const express = require('express');
const cors = require('cors');

// Routes
const authRoutes = require('./routes/auth');
const holdingsRoutes = require('./routes/holdings');
const accountsRoutes = require('./routes/accounts');
const dashboardRoutes = require('./routes/dashboard');
const jobsRoutes = require('./routes/jobs');
const historyRoutes = require('./routes/history');
const exportRoutes = require('./routes/export');

// Jobs
const { initializeJobs, stopJobs } = require('./jobs');

// Middleware
const errorHandler = require('./middleware/errorHandler');

const app = express();
const PORT = process.env.PORT || 3000;

// Trust the Azure App Service / reverse proxy so req.ip and HTTPS detection work.
app.set('trust proxy', 1);

// CORS: in production, restrict to the configured frontend origin(s).
const corsOrigin = process.env.CORS_ORIGIN;
if (process.env.NODE_ENV === 'production' && corsOrigin) {
  const allowed = corsOrigin.split(',').map((o) => o.trim()).filter(Boolean);
  app.use(cors({ origin: allowed, credentials: true }));
} else {
  app.use(cors());
}

app.use(express.json({ limit: '5mb' }));
app.use(express.urlencoded({ extended: true, limit: '5mb' }));

const pool = require('./config/database');

// Liveness: cheap, always returns 200 if the process is up.
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'OK', timestamp: new Date().toISOString() });
});

// Readiness: verifies the database is reachable. Used by Azure health checks.
app.get('/ready', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    res.status(200).json({ status: 'ready' });
  } catch (err) {
    res.status(503).json({ status: 'not_ready', error: err.message });
  }
});

// Routes
app.use('/api/auth', authRoutes);
app.use('/api/accounts', accountsRoutes);
app.use('/api/holdings', holdingsRoutes);
app.use('/api/dashboard', dashboardRoutes);
app.use('/api/jobs', jobsRoutes);
app.use('/api/history', historyRoutes);
app.use('/api/export', exportRoutes);

// Error handling middleware (must be last)
app.use(errorHandler);

// Start server
const server = app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  // Allow disabling cron jobs (e.g. on additional scaled instances) so they
  // only run on a single worker. Default: enabled.
  if (process.env.RUN_SCHEDULED_JOBS !== 'false') {
    initializeJobs();
  } else {
    console.log('Scheduled jobs disabled by RUN_SCHEDULED_JOBS=false');
  }
});

// Graceful shutdown handlers
process.on('SIGTERM', () => {
  console.log('SIGTERM received, shutting down gracefully...');
  stopJobs();
  server.close(() => {
    console.log('Server closed');
    process.exit(0);
  });
});

process.on('SIGINT', () => {
  console.log('SIGINT received, shutting down gracefully...');
  stopJobs();
  server.close(() => {
    console.log('Server closed');
    process.exit(0);
  });
});

module.exports = app;

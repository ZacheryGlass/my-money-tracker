require('dotenv').config();
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const express = require('express');
const cors = require('cors');
const pinoHttp = require('pino-http');
const rateLimit = require('express-rate-limit');

const logger = require('./config/logger');

// Routes
const holdingsRoutes = require('./routes/holdings');
const accountsRoutes = require('./routes/accounts');
const dashboardRoutes = require('./routes/dashboard');
const jobsRoutes = require('./routes/jobs');
const historyRoutes = require('./routes/history');
const exportRoutes = require('./routes/export');
const salaryRoutes = require('./routes/salary');
const expensesRoutes = require('./routes/expenses');
const plaidRoutes = require('./routes/plaid');
const ethRoutes = require('./routes/eth');
const transactionsRoutes = require('./routes/transactions');
const analyticsRoutes = require('./routes/analytics');
const mcpRoutes = require('./routes/mcp');

// Jobs
const { initializeJobs, stopJobs } = require('./jobs');

// Middleware
const errorHandler = require('./middleware/errorHandler');
const requireUser = require('./middleware/auth');

const app = express();
const PORT = process.env.PORT || 3000;
const isProduction = process.env.NODE_ENV === 'production';

const rateLimitJsonHandler = (message) => (req, res) => {
  res.status(429).json({ error: message });
};

// Trust the Azure App Service / reverse proxy so req.ip and HTTPS detection work.
app.set('trust proxy', 1);

// HTTP request logging with per-request ID
app.use(pinoHttp({
  logger,
  genReqId(req) {
    return req.headers['x-request-id'] || crypto.randomUUID();
  },
}));

// Global rate limit: 300 req / 15 min per IP
app.use(rateLimit({
  windowMs: 15 * 60 * 1000,
  max: isProduction ? 300 : 5000,
  standardHeaders: true,
  legacyHeaders: false,
  handler: rateLimitJsonHandler('Too many requests. Please try again later.'),
}));

// CORS: in production, restrict to the configured frontend origin(s).
const corsOrigin = process.env.CORS_ORIGIN;
if (isProduction && corsOrigin) {
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
// Identity comes from Azure Easy Auth headers (see middleware/auth.js).
app.get('/api/me', requireUser, (req, res) => {
  res.status(200).json({ user: req.user });
});
app.use('/api/accounts', accountsRoutes);
app.use('/api/holdings', holdingsRoutes);
app.use('/api/dashboard', dashboardRoutes);
app.use('/api/jobs', jobsRoutes);
app.use('/api/history', historyRoutes);
app.use('/api/export', exportRoutes);
app.use('/api/salary', salaryRoutes);
app.use('/api/expenses', expensesRoutes);
app.use('/api/plaid', plaidRoutes);
app.use('/api/eth', ethRoutes);
app.use('/api/transactions', transactionsRoutes);
app.use('/api/analytics', analyticsRoutes);
app.use('/mcp', mcpRoutes);

// Public landing page (excluded from Easy Auth in the Azure config).
app.use(express.static(path.join(__dirname, '../public')));

// Private React app. Azure Easy Auth enforces login for /private/* upstream;
// locally the dist may not exist since Vite serves the app in dev.
const frontendDist = path.join(__dirname, '../../frontend/dist');
if (fs.existsSync(frontendDist)) {
  app.use('/private', express.static(frontendDist));
  // SPA fallback for client-side routes (Express 5 wildcard syntax).
  app.get('/private/{*splat}', (req, res) => {
    res.sendFile(path.join(frontendDist, 'index.html'));
  });
}

// Error handling middleware (must be last)
app.use(errorHandler);

// Start server only when run directly (not when imported by tests)
if (require.main === module) {
  const server = app.listen(PORT, () => {
    logger.info({ port: PORT }, 'Server running');
    if (process.env.RUN_SCHEDULED_JOBS !== 'false') {
      initializeJobs();
    } else {
      logger.info('Scheduled jobs disabled by RUN_SCHEDULED_JOBS=false');
    }
  });

  process.on('SIGTERM', () => {
    logger.info('SIGTERM received, shutting down gracefully...');
    stopJobs();
    server.close(() => {
      logger.info('Server closed');
      process.exit(0);
    });
  });

  process.on('SIGINT', () => {
    logger.info('SIGINT received, shutting down gracefully...');
    stopJobs();
    server.close(() => {
      logger.info('Server closed');
      process.exit(0);
    });
  });
}

module.exports = app;

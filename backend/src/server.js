require('dotenv').config();
const crypto = require('crypto');
const express = require('express');
const cors = require('cors');
const pinoHttp = require('pino-http');
const rateLimit = require('express-rate-limit');

const logger = require('./config/logger');

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

// Trust proxy (Azure App Service sits behind a load balancer)
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
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
}));

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Health check endpoint
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'OK', timestamp: new Date().toISOString() });
});

// Auth rate limit: 10 req / 15 min per IP
const authRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
});

// Routes
app.use('/api/auth', authRateLimit, authRoutes);
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
  logger.info({ port: PORT }, 'Server running');
  initializeJobs();
});

// Graceful shutdown handlers
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

module.exports = app;

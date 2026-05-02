'use strict';

const logger = require('../config/logger');

// Express requires the 4-argument signature to recognize this as an error handler
// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, next) {
  const requestId = req.id || req.headers['x-request-id'];
  logger.error({ err, requestId, method: req.method, url: req.url }, 'Request error');

  // JWT errors
  if (err.name === 'JsonWebTokenError' || err.name === 'TokenExpiredError') {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }

  // Unique constraint violation
  if (err.code === '23505') {
    return res.status(409).json({ error: 'This holding already exists for this account' });
  }

  // Foreign key violation
  if (err.code === '23503') {
    return res.status(400).json({ error: 'Referenced account does not exist' });
  }

  const status = err.status || 500;

  // Don't leak internal details in production for 5xx errors
  if (status >= 500 && process.env.NODE_ENV === 'production') {
    return res.status(status).json({ error: 'Internal server error' });
  }

  res.status(status).json({ error: err.message || 'Internal server error' });
}

module.exports = errorHandler;

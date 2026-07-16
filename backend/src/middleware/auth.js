'use strict';

const jwt = require('jsonwebtoken');
const logger = require('../config/logger');

function isDevelopmentAuthBypassEnabled() {
  return process.env.NODE_ENV === 'development' && process.env.DEV_BYPASS_AUTH === 'true';
}

function authenticateToken(req, res, next) {
  if (isDevelopmentAuthBypassEnabled()) {
    req.user = {
      id: Number.parseInt(process.env.DEV_AUTH_USER_ID || '1', 10),
      username: process.env.DEV_AUTH_USERNAME || 'zachery',
      developmentBypass: true,
    };
    return next();
  }

  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1]; // Bearer TOKEN

  if (!token) {
    return res.status(401).json({ error: 'Access token required' });
  }

  jwt.verify(token, process.env.JWT_SECRET, (err, user) => {
    if (err) {
      logger.warn({ err }, 'Token verification failed');
      return res.status(401).json({ error: 'Invalid or expired token' });
    }
    req.user = user;
    next();
  });
}

module.exports = authenticateToken;

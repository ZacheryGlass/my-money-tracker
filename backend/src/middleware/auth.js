'use strict';

const logger = require('../config/logger');

// Authentication is handled upstream by Azure App Service Authentication
// ("Easy Auth"): the platform forces a Microsoft login before requests reach
// this app and injects the verified identity as request headers. This
// middleware only reads those headers -- it never validates credentials.
//
// Outside production (local dev, tests) there is no login at all; a fixed
// single-user identity is attached so route handlers behave identically.
function requireUser(req, res, next) {
  if (process.env.NODE_ENV !== 'production') {
    req.user = {
      id: Number.parseInt(process.env.DEV_AUTH_USER_ID || '1', 10),
      username: process.env.DEV_AUTH_USERNAME || 'zachery',
    };
    return next();
  }

  const principalName = req.headers['x-ms-client-principal-name'];
  if (!principalName) {
    // Defense in depth: Easy Auth should have redirected unauthenticated
    // requests already. Reaching here means the platform auth is missing
    // or misconfigured (e.g. running in production without Easy Auth).
    logger.warn({ path: req.path }, 'Request missing Easy Auth principal');
    return res.status(401).json({ error: 'Authentication required' });
  }

  req.user = {
    id: 1,
    username: principalName,
    principalId: req.headers['x-ms-client-principal-id'] || null,
  };
  return next();
}

module.exports = requireUser;

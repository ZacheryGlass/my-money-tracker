'use strict';

const logger = require('../config/logger');

// Authentication is handled upstream by Azure App Service Authentication
// ("Easy Auth"): the platform forces a Google sign-in before requests reach
// this app and injects the verified identity as request headers. This
// middleware only reads those headers -- it never validates credentials.
//
// Google accepts any Google account, so authentication alone is not enough:
// the verified email must also appear in the ALLOWED_PRINCIPALS allowlist
// (comma-separated, case-insensitive). The check fails closed -- production
// with no allowlist configured rejects everyone.
//
// Outside production (local dev, tests) there is no login at all; a fixed
// single-user identity is attached so route handlers behave identically.

function allowedPrincipals() {
  return (process.env.ALLOWED_PRINCIPALS || '')
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
}

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

  // 403 (not 401) so the frontend does not reload-loop trying to
  // re-authenticate an account that is signed in but not allowed.
  if (!allowedPrincipals().includes(principalName.toLowerCase())) {
    logger.warn(
      { path: req.path, principal: principalName },
      'Authenticated principal not in ALLOWED_PRINCIPALS'
    );
    return res.status(403).json({ error: 'Not authorized' });
  }

  req.user = {
    id: 1,
    username: principalName,
    principalId: req.headers['x-ms-client-principal-id'] || null,
  };
  return next();
}

module.exports = requireUser;

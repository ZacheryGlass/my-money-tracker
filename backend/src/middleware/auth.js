'use strict';

const logger = require('../config/logger');
const pool = require('../config/database');
const User = require('../models/User');

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
// An allowlisted email is resolved to a users row via user_identities; an
// allowlisted email seen for the first time auto-provisions its user. The
// allowlist check runs BEFORE any DB access, and resolved identities are
// cached in-process so steady-state requests cost no query.
//
// Outside production (local dev, tests) there is no login at all; a fixed
// identity from DEV_AUTH_USER_ID/DEV_AUTH_USERNAME is attached, and a
// matching users row is ensured best-effort so foreign keys hold when
// simulating a second local user.

const CACHE_TTL_MS = 5 * 60 * 1000;
const identityCache = new Map(); // email -> { user, expiresAt }

function allowedPrincipals() {
  return (process.env.ALLOWED_PRINCIPALS || '')
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
}

// Memoizes the in-flight attempt, not just the completed one. Caching the id
// up front meant a single transient DB error (Postgres still starting)
// suppressed the bootstrap for the rest of the process, and later writes hit
// foreign-key violations against a users row that was never created; caching
// only on success would instead let every request in a page load -- a dozen
// parallel calls -- issue its own pair of queries. A failed attempt is
// dropped so the next request retries.
const devEnsured = new Map(); // id -> Promise
function ensureDevUser(id, username) {
  if (!devEnsured.has(id)) {
    const attempt = (async () => {
      await pool.query(
        'INSERT INTO users (id, username) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING',
        [id, username]
      );
      await pool.query(
        "SELECT setval('users_id_seq', GREATEST((SELECT COALESCE(MAX(id), 1) FROM users), 1))"
      );
    })().catch(() => {
      // Best effort: unit tests run with a throwing fake pool and no schema.
      devEnsured.delete(id);
    });
    devEnsured.set(id, attempt);
  }
  return devEnsured.get(id);
}

async function requireUser(req, res, next) {
  if (process.env.NODE_ENV !== 'production') {
    const id = Number.parseInt(process.env.DEV_AUTH_USER_ID || '1', 10);
    const username = process.env.DEV_AUTH_USERNAME || 'zachery';
    await ensureDevUser(id, username);
    // Mirrors production: user 1 is the sole admin.
    req.user = { id, username, isAdmin: id === 1 };
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

  const email = principalName.toLowerCase();

  // 403 (not 401) so the frontend does not reload-loop trying to
  // re-authenticate an account that is signed in but not allowed.
  if (!allowedPrincipals().includes(email)) {
    logger.warn(
      { path: req.path, principal: principalName },
      'Authenticated principal not in ALLOWED_PRINCIPALS'
    );
    return res.status(403).json({ error: 'Not authorized' });
  }

  const cached = identityCache.get(email);
  if (cached && cached.expiresAt > Date.now()) {
    req.user = { ...cached.user, principalId: req.headers['x-ms-client-principal-id'] || null };
    return next();
  }

  try {
    let user = await User.findByEmail(email);
    if (!user) {
      user = await User.provisionByEmail(email);
      logger.info({ email, userId: user?.id }, 'Auto-provisioned user for allowlisted email');
    }
    if (!user) throw new Error('Identity provisioning returned no user');

    const resolved = {
      id: user.id,
      username: user.username,
      displayName: user.display_name || null,
      isAdmin: Boolean(user.is_admin),
    };
    identityCache.set(email, { user: resolved, expiresAt: Date.now() + CACHE_TTL_MS });
    req.user = { ...resolved, principalId: req.headers['x-ms-client-principal-id'] || null };
    return next();
  } catch (err) {
    // 503, never 401: the axios interceptor reloads the page on 401, which
    // would loop while the database is unavailable.
    logger.error({ err, email }, 'Identity lookup failed');
    return res.status(503).json({ error: 'Identity lookup failed' });
  }
}

// Admin gate for the server-configuration surface. Mount AFTER requireUser.
// 403 (not 401) for the same reload-loop reason as the allowlist check.
function requireAdmin(req, res, next) {
  if (!req.user?.isAdmin) {
    return res.status(403).json({ error: 'Not authorized' });
  }
  return next();
}

// Test hook: clears the in-process caches between scenarios.
requireUser._clearCache = () => {
  identityCache.clear();
  devEnsured.clear();
};

requireUser.requireAdmin = requireAdmin;

module.exports = requireUser;

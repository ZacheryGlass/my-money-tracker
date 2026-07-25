'use strict';

const fs = require('fs');
const path = require('path');
const express = require('express');
const requireUser = require('../middleware/auth');
const pool = require('../config/database');
const secretCrypto = require('../utils/secretCrypto');
const SecretsService = require('../services/SecretsService');
const { getJobStatus } = require('../jobs');
const logger = require('../config/logger');

const router = express.Router();

router.use(requireUser);
router.use(requireUser.requireAdmin);

// Secret env values are reported as set/unset plus masked last-4 ONLY.
// Full values never leave the server, admin or not: they would otherwise
// sit in browser memory and devtools network logs.
function maskedEnv(name) {
  const value = process.env[name];
  if (!value) return { name, set: false, masked: null };
  return { name, set: true, masked: secretCrypto.mask(value.slice(-4)) };
}

function plainEnv(name, fallback = null) {
  return { name, set: Boolean(process.env[name]), value: process.env[name] || fallback };
}

function buildEnvOverview() {
  let databaseHost = null;
  try {
    databaseHost = process.env.DATABASE_URL ? new URL(process.env.DATABASE_URL).hostname : null;
  } catch {
    databaseHost = 'unparseable';
  }
  return [
    {
      // No last-4 for this one, unlike the API keys below: it is the key that
      // decrypts every stored secret, and set/valid already answers the only
      // question the Server tab asks. Masking it would leak key material into
      // browser memory and devtools for no diagnostic gain.
      name: 'SECRETS_ENCRYPTION_KEY',
      set: Boolean(process.env.SECRETS_ENCRYPTION_KEY),
      valid: secretCrypto.isConfigured(),
      masked: null,
    },
    maskedEnv('MCP_API_KEY'),
    { name: 'DATABASE_URL', set: Boolean(process.env.DATABASE_URL), host: databaseHost },
    plainEnv('PLAID_ENV', 'sandbox (default)'),
    plainEnv('ALLOWED_PRINCIPALS'),
    plainEnv('RUN_SCHEDULED_JOBS', 'true (default)'),
    plainEnv('CORS_ORIGIN'),
    plainEnv('LOG_LEVEL', 'info (default)'),
  ];
}

async function buildUsers() {
  const result = await pool.query(
    `SELECT u.id, u.username, u.display_name, u.is_admin, u.created_at,
            COALESCE(ARRAY_AGG(DISTINCT ui.email) FILTER (WHERE ui.email IS NOT NULL), '{}') AS emails,
            (SELECT COUNT(*)::int FROM accounts a WHERE a.user_id = u.id) AS account_count,
            (SELECT COUNT(*)::int FROM eth_wallets w WHERE w.user_id = u.id) AS wallet_count,
            (SELECT COUNT(*)::int FROM plaid_items p WHERE p.user_id = u.id) AS plaid_item_count,
            COALESCE(ARRAY_AGG(DISTINCT k.service) FILTER (WHERE k.service IS NOT NULL), '{}') AS configured_keys
     FROM users u
     LEFT JOIN user_identities ui ON ui.user_id = u.id
     LEFT JOIN user_api_keys k ON k.user_id = u.id
     GROUP BY u.id
     ORDER BY u.id`
  );
  return result.rows;
}

async function buildHealth() {
  const health = { dbReachable: false, encryptionConfigured: secretCrypto.isConfigured() };
  try {
    await pool.query('SELECT 1');
    health.dbReachable = true;
  } catch {
    health.dbReachable = false;
  }
  try {
    const prices = await pool.query('SELECT MAX(fetched_at) AS latest FROM price_cache');
    health.latestPriceFetchedAt = prices.rows[0]?.latest || null;
  } catch {
    health.latestPriceFetchedAt = null;
  }
  try {
    health.migrationCount = fs.readdirSync(path.join(__dirname, '../../migrations'))
      .filter((f) => f.endsWith('.sql')).length;
  } catch {
    health.migrationCount = null;
  }
  return health;
}

// GET /api/admin/overview - everything the Server tab renders, in one call
router.get('/overview', async (req, res) => {
  try {
    const appSettings = {};
    for (const key of SecretsService.APP_KEYS) {
      appSettings[key] = await SecretsService.getAppSettingStatus(key);
    }
    const [users, health, jobs] = await Promise.all([
      buildUsers(),
      buildHealth(),
      getJobStatus(),
    ]);
    res.status(200).json({
      appSettings,
      encryptionConfigured: secretCrypto.isConfigured(),
      env: buildEnvOverview(),
      users,
      jobs,
      health,
    });
  } catch (error) {
    logger.error({ err: error }, 'Admin overview error');
    res.status(500).json({ error: 'Failed to build admin overview' });
  }
});

module.exports = router;

'use strict';

const pool = require('../config/database');
const logger = require('../config/logger');
const secretCrypto = require('../utils/secretCrypto');

// Resolution order everywhere: decrypted DB value -> env var fallback -> null.
// If SECRETS_ENCRYPTION_KEY is unset, reads skip the DB entirely (env-only)
// and writes throw SECRETS_NOT_CONFIGURED. A DB value that fails to decrypt
// (rotated key) logs a warning and falls back to env rather than breaking.

const USER_SERVICES = ['plaid_client_id', 'plaid_secret', 'etherscan'];
const APP_KEYS = ['cg_api_key', 'cmc_api_key'];

const ENV_FALLBACKS = {
  plaid_client_id: 'PLAID_CLIENT_ID',
  plaid_secret: 'PLAID_SECRET',
  etherscan: 'ETHERSCAN_API_KEY',
  cg_api_key: 'CG_API_KEY',
  cmc_api_key: 'CMC_PRO_API_KEY',
};

// Price jobs resolve per ticker; keep a short cache so they cost one query.
//
// Single-instance assumption: this cache and the identity cache in
// middleware/auth.js are per-process, and writes only invalidate the instance
// that served them. On a scaled-out App Service plan (or during an
// overlapping-restart deploy) another worker can keep using a key for up to
// this TTL after it is cleared. Cross-instance invalidation would need a
// shared channel (Redis, or Postgres LISTEN/NOTIFY); until the app runs on
// more than one instance the bounded staleness is the accepted trade.
const CACHE_TTL_MS = 60 * 1000;
const cache = new Map(); // cacheKey -> { value, expiresAt }

function cacheKey(scope, name) {
  return `${scope}:${name}`;
}

function envValue(name) {
  const envVar = ENV_FALLBACKS[name];
  return (envVar && process.env[envVar]) || null;
}

function ensureWritable() {
  if (!secretCrypto.isConfigured()) {
    const error = new Error('SECRETS_ENCRYPTION_KEY is not configured on the server');
    error.code = 'SECRETS_NOT_CONFIGURED';
    throw error;
  }
}

async function readRow(sql, params, name) {
  if (!secretCrypto.isConfigured()) return null;
  const result = await pool.query(sql, params);
  const row = result.rows[0];
  if (!row) return null;
  try {
    return { value: secretCrypto.decrypt(row.encrypted_value), last4: row.last4 };
  } catch (err) {
    logger.warn({ err, name }, 'Stored secret failed to decrypt; falling back to env');
    return null;
  }
}

class SecretsService {
  static get USER_SERVICES() { return USER_SERVICES; }
  static get APP_KEYS() { return APP_KEYS; }

  static clearCache() {
    cache.clear();
  }

  static async getUserKey(userId, service) {
    const key = cacheKey(`user:${userId}`, service);
    const cached = cache.get(key);
    if (cached && cached.expiresAt > Date.now()) return cached.value;

    const row = await readRow(
      'SELECT encrypted_value, last4 FROM user_api_keys WHERE user_id = $1 AND service = $2',
      [userId, service],
      service
    );
    const value = row ? row.value : envValue(service);
    cache.set(key, { value, expiresAt: Date.now() + CACHE_TTL_MS });
    return value;
  }

  // Goes through readRow so the status reflects what resolution would actually
  // return. Reporting 'db' on the mere existence of a row meant that after an
  // encryption-key change the UI showed a stored key while every read had
  // silently fallen back to env (or null), with no signal to re-enter it.
  static async getUserKeyStatus(userId, service) {
    const row = await readRow(
      'SELECT encrypted_value, last4 FROM user_api_keys WHERE user_id = $1 AND service = $2',
      [userId, service],
      service
    );
    if (row) {
      return { source: 'db', masked: secretCrypto.mask(row.last4) };
    }
    return envValue(service)
      ? { source: 'env', masked: null }
      : { source: 'none', masked: null };
  }

  static async setUserKey(userId, service, value) {
    ensureWritable();
    await pool.query(
      `INSERT INTO user_api_keys (user_id, service, encrypted_value, last4, updated_at)
       VALUES ($1, $2, $3, $4, CURRENT_TIMESTAMP)
       ON CONFLICT (user_id, service)
       DO UPDATE SET encrypted_value = EXCLUDED.encrypted_value,
                     last4 = EXCLUDED.last4,
                     updated_at = CURRENT_TIMESTAMP`,
      [userId, service, secretCrypto.encrypt(value), secretCrypto.last4(value)]
    );
    cache.delete(cacheKey(`user:${userId}`, service));
    return this.getUserKeyStatus(userId, service);
  }

  static async deleteUserKey(userId, service) {
    ensureWritable();
    await pool.query(
      'DELETE FROM user_api_keys WHERE user_id = $1 AND service = $2',
      [userId, service]
    );
    cache.delete(cacheKey(`user:${userId}`, service));
    return this.getUserKeyStatus(userId, service);
  }

  static async getAppSetting(name) {
    const key = cacheKey('app', name);
    const cached = cache.get(key);
    if (cached && cached.expiresAt > Date.now()) return cached.value;

    const row = await readRow(
      'SELECT encrypted_value, last4 FROM app_settings WHERE key = $1',
      [name],
      name
    );
    const value = row ? row.value : envValue(name);
    cache.set(key, { value, expiresAt: Date.now() + CACHE_TTL_MS });
    return value;
  }

  static async getAppSettingStatus(name) {
    const row = await readRow(
      'SELECT encrypted_value, last4 FROM app_settings WHERE key = $1',
      [name],
      name
    );
    if (row) {
      return { source: 'db', masked: secretCrypto.mask(row.last4) };
    }
    return envValue(name)
      ? { source: 'env', masked: null }
      : { source: 'none', masked: null };
  }

  static async setAppSetting(name, value) {
    ensureWritable();
    await pool.query(
      `INSERT INTO app_settings (key, encrypted_value, last4, updated_at)
       VALUES ($1, $2, $3, CURRENT_TIMESTAMP)
       ON CONFLICT (key)
       DO UPDATE SET encrypted_value = EXCLUDED.encrypted_value,
                     last4 = EXCLUDED.last4,
                     updated_at = CURRENT_TIMESTAMP`,
      [name, secretCrypto.encrypt(value), secretCrypto.last4(value)]
    );
    cache.delete(cacheKey('app', name));
    return this.getAppSettingStatus(name);
  }

  static async deleteAppSetting(name) {
    ensureWritable();
    await pool.query('DELETE FROM app_settings WHERE key = $1', [name]);
    cache.delete(cacheKey('app', name));
    return this.getAppSettingStatus(name);
  }
}

module.exports = SecretsService;

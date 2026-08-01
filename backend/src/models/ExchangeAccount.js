'use strict';

const pool = require('../config/database');

// Root table: ownership lives here and exchange_records inherits it by joining
// through this table. Every read is scoped, and a missing userId throws rather
// than quietly widening to every user's accounts.
function requireUserId(method, userId) {
  if (!userId) {
    throw new Error(`ExchangeAccount.${method} requires a userId`);
  }
}

const EXCHANGES = new Set(['coinbase', 'kraken', 'binance_us', 'other']);
// Which venues the API sync can talk to is NOT a model concern: the single
// source of truth is CONNECTORS in services/exchangeSync/index.js, which the
// routes and ExchangeSyncService both consult via connectorFor().

// Migration 040 put ciphertext on this table, so `SELECT *` is now a leak
// waiting to happen: every route that returns an account returns whatever the
// query selected. Anything user-facing goes through this list instead, which
// omits api_key_encrypted and api_secret_encrypted and keeps only the last4
// the masked status is built from.
const PUBLIC_COLUMNS = [
  'id', 'user_id', 'name', 'exchange', 'last_import_at', 'created_at', 'updated_at',
  'api_key_last4', 'api_secret_last4',
  'last_sync_at', 'last_sync_status', 'last_sync_error', 'balance_report',
  // Deliberately NOT sync_cursor: it is an internal resume point, and for
  // Coinbase it carries per-account ids that are of no use to the client.
];

const publicSelect = (alias) => PUBLIC_COLUMNS.map((column) => `${alias}.${column}`).join(', ');

// "Is a credential stored", answered without decrypting anything. The route
// turns this into {configured, masked} -- the same contract the API Keys tab
// has, where the client only ever learns the last four characters.
const CREDENTIAL_FLAG = 'api_key_encrypted IS NOT NULL AS api_configured';

class ExchangeAccount {
  static get EXCHANGES() {
    return EXCHANGES;
  }

  static get PUBLIC_COLUMNS() {
    return PUBLIC_COLUMNS;
  }

  // The Settings list: each account with the two numbers that tell the user
  // whether an import worked -- how many records it holds and when it last ran.
  static async findAllByUser(userId) {
    requireUserId('findAllByUser', userId);
    const result = await pool.query(
      `SELECT ${publicSelect('ea')},
              ea.${CREDENTIAL_FLAG},
              COUNT(er.id)::int AS record_count,
              COUNT(er.id) FILTER (WHERE er.needs_review)::int AS needs_review_count,
              COUNT(er.id) FILTER (WHERE er.duplicate_candidate)::int AS duplicate_candidate_count,
              MIN(er.occurred_at) AS first_record_at,
              MAX(er.occurred_at) AS last_record_at
       FROM exchange_accounts ea
       LEFT JOIN exchange_records er ON er.exchange_account_id = ea.id
       WHERE ea.user_id = $1
       GROUP BY ea.id
       ORDER BY ea.created_at DESC`,
      [userId]
    );
    return result.rows;
  }

  // The route-facing lookup. Public columns only: whatever a route hands back
  // as `account` is what reaches the browser.
  static async findByIdForUser(id, userId) {
    requireUserId('findByIdForUser', userId);
    const result = await pool.query(
      `SELECT ${PUBLIC_COLUMNS.join(', ')}, ${CREDENTIAL_FLAG}
       FROM exchange_accounts WHERE id = $1 AND user_id = $2`,
      [id, userId]
    );
    return result.rows[0];
  }

  // The one read that returns ciphertext, named so it cannot be reached by
  // accident. Only ExchangeSyncService calls it, and it decrypts in-process:
  // nothing here is ever serialized into a response.
  static async findWithCredentialsForUser(id, userId) {
    requireUserId('findWithCredentialsForUser', userId);
    const result = await pool.query(
      'SELECT * FROM exchange_accounts WHERE id = $1 AND user_id = $2',
      [id, userId]
    );
    return result.rows[0];
  }

  // Cross-user, for the nightly job only -- the same explicit escape hatch
  // EthWallet and PlaidItem have. Restricted to accounts that actually hold a
  // credential, so an account that only ever took CSV uploads is not counted
  // as a skip every single night.
  static async findAllForJobs() {
    const result = await pool.query(
      `SELECT * FROM exchange_accounts
       WHERE api_key_encrypted IS NOT NULL
       ORDER BY id`
    );
    return result.rows;
  }

  static async create(userId, { name, exchange }) {
    requireUserId('create', userId);
    const result = await pool.query(
      `INSERT INTO exchange_accounts (user_id, name, exchange)
       VALUES ($1, $2, $3)
       RETURNING ${PUBLIC_COLUMNS.join(', ')}, ${CREDENTIAL_FLAG}`,
      [userId, name, exchange]
    );
    return result.rows[0];
  }

  // Both filters on the same statement: a foreign id updates nothing and the
  // route turns the empty result into a 404.
  static async update(id, userId, { name, exchange }) {
    requireUserId('update', userId);
    const result = await pool.query(
      `UPDATE exchange_accounts
       SET name = COALESCE($3, name),
           exchange = COALESCE($4, exchange),
           sync_cursor = CASE WHEN $4::text IS NOT NULL AND $4::text <> exchange THEN NULL ELSE sync_cursor END,
           last_sync_at = CASE WHEN $4::text IS NOT NULL AND $4::text <> exchange THEN NULL ELSE last_sync_at END,
           last_sync_status = CASE WHEN $4::text IS NOT NULL AND $4::text <> exchange THEN NULL ELSE last_sync_status END,
           last_sync_error = CASE WHEN $4::text IS NOT NULL AND $4::text <> exchange THEN NULL ELSE last_sync_error END,
           balance_report = CASE WHEN $4::text IS NOT NULL AND $4::text <> exchange THEN NULL ELSE balance_report END,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $1 AND user_id = $2
         AND (
           $4::text IS NULL
           OR $4::text = exchange
           OR (
             api_key_encrypted IS NULL
             AND NOT EXISTS (
               SELECT 1 FROM exchange_records er
               WHERE er.exchange_account_id = exchange_accounts.id
             )
             AND (sync_lock_token IS NULL OR sync_lock_until IS NULL OR sync_lock_until < CURRENT_TIMESTAMP)
           )
         )
       RETURNING ${PUBLIC_COLUMNS.join(', ')}, ${CREDENTIAL_FLAG}`,
      [id, userId, name ?? null, exchange ?? null]
    );
    return result.rows[0];
  }

  static async delete(id, userId) {
    requireUserId('delete', userId);
    const result = await pool.query(
      `DELETE FROM exchange_accounts WHERE id = $1 AND user_id = $2
       RETURNING ${PUBLIC_COLUMNS.join(', ')}`,
      [id, userId]
    );
    return result.rows[0];
  }

  static async touchImport(id, userId) {
    requireUserId('touchImport', userId);
    const result = await pool.query(
      `UPDATE exchange_accounts
       SET last_import_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
       WHERE id = $1 AND user_id = $2
       RETURNING ${PUBLIC_COLUMNS.join(', ')}, ${CREDENTIAL_FLAG}`,
      [id, userId]
    );
    return result.rows[0];
  }

  // Both halves in one statement. The table's CHECK requires them to be set
  // and cleared together -- half a credential fails every request with a
  // signature error instead of being skipped as unconfigured.
  //
  // Changing the key invalidates the cursor's provenance. Existing records are
  // retained, but the next backfill starts from the head and safely dedupes
  // overlap against them. The lock predicate makes replacement atomic with a
  // running sync, so an old worker cannot write a cursor for the new key.
  static async setCredentials(id, userId, {
    apiKeyEncrypted, apiKeyLast4, apiSecretEncrypted, apiSecretLast4,
  }) {
    requireUserId('setCredentials', userId);
    const client = await pool.connect();
    let committed = false;
    try {
      await client.query('BEGIN');
      // Use separate commands after the row lock so a claim that was waiting
      // on this account is visible in a fresh READ COMMITTED snapshot. A
      // single UPDATE ... NOT EXISTS can otherwise miss a job claimed while
      // its statement snapshot was already open.
      const locked = await client.query(
        `SELECT id
         FROM exchange_accounts
         WHERE id = $1 AND user_id = $2
           AND (sync_lock_token IS NULL OR sync_lock_until IS NULL OR sync_lock_until < CURRENT_TIMESTAMP)
         FOR UPDATE`,
        [id, userId]
      );
      if (!locked.rows[0]) {
        await client.query('ROLLBACK');
        return null;
      }
      // Cancel the old credential generation while the account row is locked.
      // ExchangeSyncJob.enqueue takes the same lock, so a queued request cannot
      // slip between this cancellation and the new credentials_updated_at.
      await client.query(
        `UPDATE exchange_sync_jobs
         SET status = 'failed',
             completed_at = CURRENT_TIMESTAMP,
             next_run_at = NULL,
             lease_until = NULL,
             claim_token = NULL,
             last_error_code = $2,
             last_error = $3,
             updated_at = CURRENT_TIMESTAMP
         WHERE exchange_account_id = $1
           AND status IN ('queued', 'backoff')`,
        [id, 'EXCHANGE_CREDENTIALS_REPLACED', 'Exchange credentials were replaced before this backfill ran']
      );
      const running = await client.query(
        `SELECT 1 FROM exchange_sync_jobs
         WHERE exchange_account_id = $1 AND status = 'running'
         LIMIT 1`,
        [id]
      );
      if (running.rows[0]) {
        await client.query('ROLLBACK');
        return null;
      }
      const result = await client.query(
        `UPDATE exchange_accounts
         SET api_key_encrypted = $3,
             api_key_last4 = $4,
             api_secret_encrypted = $5,
             api_secret_last4 = $6,
             credentials_updated_at = CURRENT_TIMESTAMP,
             sync_cursor = NULL,
             last_sync_at = NULL,
             last_sync_status = NULL,
             last_sync_error = NULL,
             balance_report = NULL,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = $1 AND user_id = $2
         RETURNING ${PUBLIC_COLUMNS.join(', ')}, ${CREDENTIAL_FLAG}`,
        [id, userId, apiKeyEncrypted, apiKeyLast4, apiSecretEncrypted, apiSecretLast4]
      );
      await client.query('COMMIT');
      committed = true;
      return result.rows[0];
    } catch (error) {
      if (!committed) {
        try { await client.query('ROLLBACK'); } catch (rollbackError) {
          // Preserve the original database error; the connection is released
          // immediately and the transaction is discarded with it.
          void rollbackError;
        }
      }
      throw error;
    } finally {
      client.release();
    }
  }

  // Disconnecting keeps every record already imported -- exactly like an ETH
  // wallet disconnected with removeData=false. The history is the part no live
  // connection can recover once the key is gone.
  static async clearCredentials(id, userId) {
    requireUserId('clearCredentials', userId);
    const client = await pool.connect();
    let committed = false;
    try {
      await client.query('BEGIN');
      const locked = await client.query(
        `SELECT id
         FROM exchange_accounts
         WHERE id = $1 AND user_id = $2
           AND (sync_lock_token IS NULL OR sync_lock_until IS NULL OR sync_lock_until < CURRENT_TIMESTAMP)
         FOR UPDATE`,
        [id, userId]
      );
      if (!locked.rows[0]) {
        await client.query('ROLLBACK');
        return null;
      }
      const running = await client.query(
        `SELECT 1 FROM exchange_sync_jobs
         WHERE exchange_account_id = $1 AND status = 'running'
         LIMIT 1`,
        [id]
      );
      if (running.rows[0]) {
        await client.query('ROLLBACK');
        return null;
      }
      const result = await client.query(
        `UPDATE exchange_accounts
         SET api_key_encrypted = NULL,
             api_key_last4 = NULL,
             api_secret_encrypted = NULL,
             api_secret_last4 = NULL,
             credentials_updated_at = NULL,
             sync_cursor = NULL,
             last_sync_at = NULL,
             last_sync_status = NULL,
             last_sync_error = NULL,
             balance_report = NULL,
             sync_lock_token = NULL,
             sync_lock_until = NULL,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = $1 AND user_id = $2
         RETURNING ${PUBLIC_COLUMNS.join(', ')}, ${CREDENTIAL_FLAG}`,
        [id, userId]
      );
      await client.query('COMMIT');
      committed = true;
      return result.rows[0];
    } catch (error) {
      if (!committed) {
        try { await client.query('ROLLBACK'); } catch (rollbackError) {
          void rollbackError;
        }
      }
      throw error;
    } finally {
      client.release();
    }
  }

  // Written by the job, which iterates every user's accounts, so this one is
  // keyed by id alone -- the caller is findAllForJobs, not a request.
  //
  // The cursor is only advanced when a cursor is passed: a failed sync writes
  // its status and leaves the resume point where it was, because advancing
  // past rows that were never fetched would drop them silently and forever
  // (the same rule the ETH per-feed cursors follow).
  static async saveSyncState(id, { cursor, status, error, balanceReport, syncLockToken = null }) {
    const result = await pool.query(
      `UPDATE exchange_accounts
       SET sync_cursor = COALESCE($2::jsonb, sync_cursor),
           last_sync_at = CURRENT_TIMESTAMP,
           last_sync_status = $3,
           last_sync_error = $4,
           balance_report = COALESCE($5::jsonb, balance_report),
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $1
         AND ($6::uuid IS NULL OR (sync_lock_token = $6::uuid AND sync_lock_until > CURRENT_TIMESTAMP))
       RETURNING ${PUBLIC_COLUMNS.join(', ')}, ${CREDENTIAL_FLAG}`,
      [
        id,
        cursor === undefined || cursor === null ? null : JSON.stringify(cursor),
        status ?? null,
        error ?? null,
        balanceReport === undefined || balanceReport === null ? null : JSON.stringify(balanceReport),
        syncLockToken,
      ]
    );
    return result.rows[0];
  }

  // A database-backed lease shared by the nightly sync, the durable backfill,
  // and legacy synchronous clients. This closes the check-then-use window
  // where two app instances could read and overwrite one cursor.
  static async claimSyncLock(id, token, leaseMs) {
    const result = await pool.query(
      `UPDATE exchange_accounts
       SET sync_lock_token = $2::uuid,
           sync_lock_until = CURRENT_TIMESTAMP + ($3::bigint * INTERVAL '1 millisecond'),
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $1
         AND api_key_encrypted IS NOT NULL
         AND api_secret_encrypted IS NOT NULL
         AND (sync_lock_token IS NULL OR sync_lock_until IS NULL OR sync_lock_until < CURRENT_TIMESTAMP)
       RETURNING id`,
      [id, token, leaseMs]
    );
    return result.rows[0] || null;
  }

  static async refreshSyncLock(id, token, leaseMs) {
    const result = await pool.query(
      `UPDATE exchange_accounts
       SET sync_lock_until = CURRENT_TIMESTAMP + ($3::bigint * INTERVAL '1 millisecond'),
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $1 AND sync_lock_token = $2::uuid AND sync_lock_until > CURRENT_TIMESTAMP
       RETURNING id`,
      [id, token, leaseMs]
    );
    return result.rows[0] || null;
  }

  static async ownsSyncLock(id, token) {
    if (!token) return false;
    const result = await pool.query(
      `SELECT id
       FROM exchange_accounts
       WHERE id = $1 AND sync_lock_token = $2::uuid AND sync_lock_until > CURRENT_TIMESTAMP`,
      [id, token]
    );
    return Boolean(result.rows[0]);
  }

  static async releaseSyncLock(id, token) {
    if (!token) return null;
    const result = await pool.query(
      `UPDATE exchange_accounts
       SET sync_lock_token = NULL,
           sync_lock_until = NULL,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $1 AND sync_lock_token = $2::uuid
       RETURNING id`,
      [id, token]
    );
    return result.rows[0] || null;
  }
}

module.exports = ExchangeAccount;

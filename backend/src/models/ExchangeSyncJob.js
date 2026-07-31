'use strict';

const crypto = require('crypto');
const pool = require('../config/database');

const ACTIVE_STATUSES = ['queued', 'running', 'backoff'];
const LEASE_MS = 10 * 60 * 1000;

function requireUserId(method, userId) {
  if (!userId) throw new Error(`ExchangeSyncJob.${method} requires a userId`);
}

function publicRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    account_id: row.exchange_account_id,
    status: row.status,
    requested_at: row.requested_at,
    started_at: row.started_at,
    completed_at: row.completed_at,
    next_run_at: row.next_run_at,
    batches: row.batches,
    fetched: row.fetched_rows,
    imported: row.imported_rows,
    upgraded: row.upgraded_rows,
    duplicates: row.duplicate_rows,
    flagged: row.flagged_rows,
    backfill_pending: row.backfill_pending,
    backoff_attempts: row.backoff_attempts,
    last_batch: row.last_batch || null,
    last_error: row.last_error_code || row.last_error
      ? { code: row.last_error_code || null, message: row.last_error || null }
      : null,
  };
}

class ExchangeSyncJob {
  static get ACTIVE_STATUSES() { return ACTIVE_STATUSES; }

  static toPublic(row) { return publicRow(row); }

  /**
   * Create one active job, or return the active job already walking this
   * account. The partial unique index is the concurrency guard; the conflict
   * arm makes repeated button presses idempotent without resetting progress.
   */
  static async enqueue(userId, exchangeAccountId) {
    requireUserId('enqueue', userId);
    const result = await pool.query(
      `WITH account AS (
         SELECT ea.id, ea.user_id
         FROM exchange_accounts ea
         WHERE ea.id = $1 AND ea.user_id = $2
           AND ea.api_key_encrypted IS NOT NULL
           AND ea.api_secret_encrypted IS NOT NULL
         FOR UPDATE
       )
       INSERT INTO exchange_sync_jobs (exchange_account_id, user_id, status)
       SELECT account.id, account.user_id, 'queued'
       FROM account
       ON CONFLICT (exchange_account_id)
         WHERE status IN ('queued', 'running', 'backoff')
       DO UPDATE SET
         next_run_at = CASE
           WHEN exchange_sync_jobs.status = 'queued'
             THEN LEAST(COALESCE(exchange_sync_jobs.next_run_at, CURRENT_TIMESTAMP), CURRENT_TIMESTAMP)
           ELSE exchange_sync_jobs.next_run_at
         END,
         updated_at = CURRENT_TIMESTAMP
       RETURNING *`,
      [exchangeAccountId, userId]
    );
    return publicRow(result.rows[0]);
  }

  static async findLatestForAccount(userId, exchangeAccountId) {
    requireUserId('findLatestForAccount', userId);
    const result = await pool.query(
      `SELECT esj.*
       FROM exchange_sync_jobs esj
       JOIN exchange_accounts ea ON ea.id = esj.exchange_account_id
       WHERE esj.exchange_account_id = $1 AND esj.user_id = $2 AND ea.user_id = $2
         AND ea.api_key_encrypted IS NOT NULL
         AND (ea.credentials_updated_at IS NULL OR esj.requested_at >= ea.credentials_updated_at)
       ORDER BY esj.requested_at DESC, esj.id DESC
       LIMIT 1`,
      [exchangeAccountId, userId]
    );
    return publicRow(result.rows[0]);
  }

  static async hasActiveForAccount(exchangeAccountId) {
    const result = await pool.query(
      `SELECT 1
       FROM exchange_sync_jobs
       WHERE exchange_account_id = $1
         AND status IN ('queued', 'running', 'backoff')
       LIMIT 1`,
      [exchangeAccountId]
    );
    return result.rows.length > 0;
  }

  /**
   * Atomically claim one due job. A lease makes a process that died in the
   * provider call recoverable without allowing two live workers to walk the
   * same cursor: SELECT ... FOR UPDATE SKIP LOCKED and the UPDATE are one
   * statement, so only one claimant can see a candidate.
   */
  static async claimDue({ leaseMs = LEASE_MS } = {}) {
    const leaseUntil = new Date(Date.now() + leaseMs);
    const claimToken = crypto.randomUUID();
    const result = await pool.query(
      `WITH candidate AS (
       SELECT esj.id
         FROM exchange_sync_jobs esj
         JOIN exchange_accounts ea ON ea.id = esj.exchange_account_id
         WHERE (
           (esj.status IN ('queued', 'backoff') AND COALESCE(esj.next_run_at, CURRENT_TIMESTAMP) <= CURRENT_TIMESTAMP)
            OR (esj.status = 'running' AND (esj.lease_until IS NULL OR esj.lease_until < CURRENT_TIMESTAMP))
         )
           AND (ea.credentials_updated_at IS NULL OR esj.requested_at >= ea.credentials_updated_at)
         ORDER BY esj.next_run_at NULLS FIRST, esj.id
         -- Lock the account row together with the job. Credential rotation
         -- waits for this claim and then sees status='running'; if rotation
         -- wins first, the generation predicate above leaves this old job
         -- unclaimable instead of running under a new key invisibly.
         FOR UPDATE OF esj, ea SKIP LOCKED
         LIMIT 1
       )
       UPDATE exchange_sync_jobs esj
       SET status = 'running',
           started_at = COALESCE(esj.started_at, CURRENT_TIMESTAMP),
           lease_until = $1,
           claim_token = $2,
           updated_at = CURRENT_TIMESTAMP
       FROM candidate
       WHERE esj.id = candidate.id
       RETURNING esj.*`,
      [leaseUntil, claimToken]
    );
    return result.rows[0] || null;
  }

  static async heartbeat(id, claimToken, { leaseMs = LEASE_MS } = {}) {
    if (!claimToken) return null;
    const leaseUntil = new Date(Date.now() + leaseMs);
    const result = await pool.query(
      `UPDATE exchange_sync_jobs
       SET lease_until = $3, updated_at = CURRENT_TIMESTAMP
       WHERE id = $1 AND claim_token = $2 AND status = 'running'
       RETURNING *`,
      [id, claimToken, leaseUntil]
    );
    return result.rows[0] || null;
  }

  static async requeue(id, claimToken, {
    fetched = 0, imported = 0, upgraded = 0, duplicates = 0, flagged = 0,
    backfillPending = true, lastBatch = null, delayMs = 250,
  } = {}) {
    const nextRunAt = new Date(Date.now() + Math.max(0, delayMs));
    const result = await pool.query(
      `UPDATE exchange_sync_jobs
       SET status = 'queued',
           next_run_at = $3,
           lease_until = NULL,
           backoff_attempts = 0,
           claim_token = NULL,
           batches = batches + 1,
           fetched_rows = fetched_rows + $4,
           imported_rows = imported_rows + $5,
           upgraded_rows = upgraded_rows + $6,
           duplicate_rows = duplicate_rows + $7,
           flagged_rows = flagged_rows + $8,
           backfill_pending = $9,
           last_batch = $10::jsonb,
           last_error_code = NULL,
           last_error = NULL,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $1 AND claim_token = $2 AND status = 'running'
       RETURNING *`,
      [id, claimToken, nextRunAt, fetched, imported, upgraded, duplicates, flagged,
        backfillPending, lastBatch ? JSON.stringify(lastBatch) : null]
    );
    return publicRow(result.rows[0]);
  }

  static async complete(id, claimToken, {
    fetched = 0, imported = 0, upgraded = 0, duplicates = 0, flagged = 0,
    lastBatch = null,
  } = {}) {
    const result = await pool.query(
      `UPDATE exchange_sync_jobs
       SET status = 'completed',
           completed_at = CURRENT_TIMESTAMP,
           next_run_at = NULL,
           lease_until = NULL,
           claim_token = NULL,
           backoff_attempts = 0,
           batches = batches + 1,
           fetched_rows = fetched_rows + $3,
           imported_rows = imported_rows + $4,
           upgraded_rows = upgraded_rows + $5,
           duplicate_rows = duplicate_rows + $6,
           flagged_rows = flagged_rows + $7,
           backfill_pending = FALSE,
           last_batch = $8::jsonb,
           last_error_code = NULL,
           last_error = NULL,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $1 AND claim_token = $2 AND status = 'running'
       RETURNING *`,
      [id, claimToken, fetched, imported, upgraded, duplicates, flagged,
        lastBatch ? JSON.stringify(lastBatch) : null]
    );
    return publicRow(result.rows[0]);
  }

  static async backoff(id, claimToken, { delayMs, errorCode, errorMessage }) {
    const nextRunAt = new Date(Date.now() + Math.max(0, delayMs));
    const result = await pool.query(
      `UPDATE exchange_sync_jobs
       SET status = 'backoff',
           next_run_at = $3,
           lease_until = NULL,
           claim_token = NULL,
           backoff_attempts = backoff_attempts + 1,
           last_error_code = $4,
           last_error = $5,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $1 AND claim_token = $2 AND status = 'running'
       RETURNING *`,
      [id, claimToken, nextRunAt, errorCode || null, errorMessage || 'The exchange API rate limit was reached']
    );
    return publicRow(result.rows[0]);
  }

  static async fail(id, claimToken, { errorCode, errorMessage }) {
    const result = await pool.query(
      `UPDATE exchange_sync_jobs
       SET status = 'failed',
           completed_at = CURRENT_TIMESTAMP,
           next_run_at = NULL,
           lease_until = NULL,
           claim_token = NULL,
           last_error_code = $3,
           last_error = $4,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $1 AND claim_token = $2 AND status = 'running'
       RETURNING *`,
      [id, claimToken, errorCode || null, errorMessage || 'Exchange sync failed']
    );
    return publicRow(result.rows[0]);
  }

  /** Cancel active work before a credential is revoked. */
  static async cancelForAccount(exchangeAccountId, { errorCode = 'EXCHANGE_CREDENTIALS_REMOVED', errorMessage = 'Exchange credentials were removed' } = {}) {
    const result = await pool.query(
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
         AND status IN ('queued', 'running', 'backoff')
       RETURNING *`,
      [exchangeAccountId, errorCode, errorMessage]
    );
    return result.rows.map(publicRow);
  }

}

ExchangeSyncJob.LEASE_MS = LEASE_MS;
module.exports = ExchangeSyncJob;

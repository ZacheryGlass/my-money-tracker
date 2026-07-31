'use strict';

const pool = require('../config/database');

const ACTIVE_STATUSES = ['queued', 'running', 'backoff'];

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
      `INSERT INTO exchange_sync_jobs (exchange_account_id, user_id, status)
       SELECT ea.id, ea.user_id, 'queued'
       FROM exchange_accounts ea
       WHERE ea.id = $1 AND ea.user_id = $2
       ON CONFLICT (exchange_account_id)
         WHERE status IN ('queued', 'running', 'backoff')
       DO UPDATE SET
         next_run_at = CASE
           WHEN exchange_sync_jobs.status = 'queued'
             THEN LEAST(exchange_sync_jobs.next_run_at, CURRENT_TIMESTAMP)
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
  static async claimDue({ leaseMs = 10 * 60 * 1000 } = {}) {
    const leaseUntil = new Date(Date.now() + leaseMs);
    const result = await pool.query(
      `WITH candidate AS (
         SELECT id
         FROM exchange_sync_jobs
         WHERE (status IN ('queued', 'backoff') AND next_run_at <= CURRENT_TIMESTAMP)
            OR (status = 'running' AND lease_until < CURRENT_TIMESTAMP)
         ORDER BY next_run_at NULLS FIRST, id
         FOR UPDATE SKIP LOCKED
         LIMIT 1
       )
       UPDATE exchange_sync_jobs esj
       SET status = 'running',
           started_at = COALESCE(esj.started_at, CURRENT_TIMESTAMP),
           lease_until = $1,
           updated_at = CURRENT_TIMESTAMP
       FROM candidate
       WHERE esj.id = candidate.id
       RETURNING esj.*`,
      [leaseUntil]
    );
    return result.rows[0] || null;
  }

  static async requeue(id, {
    fetched = 0, imported = 0, upgraded = 0, duplicates = 0, flagged = 0,
    backfillPending = true, lastBatch = null, delayMs = 250,
  } = {}) {
    const nextRunAt = new Date(Date.now() + Math.max(0, delayMs));
    const result = await pool.query(
      `UPDATE exchange_sync_jobs
       SET status = 'queued',
           next_run_at = $2,
           lease_until = NULL,
           backoff_attempts = 0,
           batches = batches + 1,
           fetched_rows = fetched_rows + $3,
           imported_rows = imported_rows + $4,
           upgraded_rows = upgraded_rows + $5,
           duplicate_rows = duplicate_rows + $6,
           flagged_rows = flagged_rows + $7,
           backfill_pending = $8,
           last_batch = $9::jsonb,
           last_error_code = NULL,
           last_error = NULL,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $1
       RETURNING *`,
      [id, nextRunAt, fetched, imported, upgraded, duplicates, flagged,
        backfillPending, lastBatch ? JSON.stringify(lastBatch) : null]
    );
    return publicRow(result.rows[0]);
  }

  static async complete(id, {
    fetched = 0, imported = 0, upgraded = 0, duplicates = 0, flagged = 0,
    lastBatch = null,
  } = {}) {
    const result = await pool.query(
      `UPDATE exchange_sync_jobs
       SET status = 'completed',
           completed_at = CURRENT_TIMESTAMP,
           next_run_at = NULL,
           lease_until = NULL,
           backoff_attempts = 0,
           batches = batches + 1,
           fetched_rows = fetched_rows + $2,
           imported_rows = imported_rows + $3,
           upgraded_rows = upgraded_rows + $4,
           duplicate_rows = duplicate_rows + $5,
           flagged_rows = flagged_rows + $6,
           backfill_pending = FALSE,
           last_batch = $7::jsonb,
           last_error_code = NULL,
           last_error = NULL,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $1
       RETURNING *`,
      [id, fetched, imported, upgraded, duplicates, flagged,
        lastBatch ? JSON.stringify(lastBatch) : null]
    );
    return publicRow(result.rows[0]);
  }

  static async backoff(id, { delayMs, errorCode, errorMessage }) {
    const nextRunAt = new Date(Date.now() + Math.max(0, delayMs));
    const result = await pool.query(
      `UPDATE exchange_sync_jobs
       SET status = 'backoff',
           next_run_at = $2,
           lease_until = NULL,
           backoff_attempts = backoff_attempts + 1,
           last_error_code = $3,
           last_error = $4,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $1
       RETURNING *`,
      [id, nextRunAt, errorCode || null, errorMessage || 'The exchange API rate limit was reached']
    );
    return publicRow(result.rows[0]);
  }

  static async fail(id, { errorCode, errorMessage }) {
    const result = await pool.query(
      `UPDATE exchange_sync_jobs
       SET status = 'failed',
           completed_at = CURRENT_TIMESTAMP,
           next_run_at = NULL,
           lease_until = NULL,
           last_error_code = $2,
           last_error = $3,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $1
       RETURNING *`,
      [id, errorCode || null, errorMessage || 'Exchange sync failed']
    );
    return publicRow(result.rows[0]);
  }
}

module.exports = ExchangeSyncJob;

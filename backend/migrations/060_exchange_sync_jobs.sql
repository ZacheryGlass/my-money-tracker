-- Durable exchange backfill orchestration.
--
-- exchange_accounts.sync_cursor remains the provider-shaped resume point and
-- exchange_records' unique key remains the deduplication boundary. This table
-- is only the user-visible/worker-visible state around those two primitives:
-- one active job per account, resumable after a process restart, and explicit
-- about a provider rate-limit pause instead of pretending a partial pass is
-- complete.

CREATE TABLE IF NOT EXISTS exchange_sync_jobs (
  id BIGSERIAL PRIMARY KEY,
  exchange_account_id BIGINT NOT NULL REFERENCES exchange_accounts(id) ON DELETE CASCADE,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status VARCHAR(20) NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'running', 'backoff', 'completed', 'failed')),
  requested_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  started_at TIMESTAMP,
  completed_at TIMESTAMP,
  next_run_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  lease_until TIMESTAMP,
  backoff_attempts INTEGER NOT NULL DEFAULT 0 CHECK (backoff_attempts >= 0),
  batches INTEGER NOT NULL DEFAULT 0 CHECK (batches >= 0),
  fetched_rows INTEGER NOT NULL DEFAULT 0 CHECK (fetched_rows >= 0),
  imported_rows INTEGER NOT NULL DEFAULT 0 CHECK (imported_rows >= 0),
  upgraded_rows INTEGER NOT NULL DEFAULT 0 CHECK (upgraded_rows >= 0),
  duplicate_rows INTEGER NOT NULL DEFAULT 0 CHECK (duplicate_rows >= 0),
  flagged_rows INTEGER NOT NULL DEFAULT 0 CHECK (flagged_rows >= 0),
  backfill_pending BOOLEAN,
  last_batch JSONB,
  last_error_code VARCHAR(80),
  last_error TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- A second click while a job is running should observe the same job, not
-- create two walks from the same exchange cursor. Completed jobs are allowed
-- to be followed by a new run.
CREATE UNIQUE INDEX IF NOT EXISTS idx_exchange_sync_jobs_active_account
  ON exchange_sync_jobs(exchange_account_id)
  WHERE status IN ('queued', 'running', 'backoff');

CREATE INDEX IF NOT EXISTS idx_exchange_sync_jobs_due
  ON exchange_sync_jobs(next_run_at, id)
  WHERE status IN ('queued', 'backoff');

CREATE INDEX IF NOT EXISTS idx_exchange_sync_jobs_user_account
  ON exchange_sync_jobs(user_id, exchange_account_id, requested_at DESC);

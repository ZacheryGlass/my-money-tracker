-- Cross-process ownership for exchange syncs.
--
-- The durable job row protects user-requested backfills. These two tokens also
-- protect the account cursor itself, including the nightly one-pass sync and
-- legacy synchronous API clients. A short lease makes a crashed process
-- recoverable; live workers refresh it while a provider call is in flight.
ALTER TABLE exchange_sync_jobs
  ADD COLUMN IF NOT EXISTS claim_token UUID;

ALTER TABLE exchange_accounts
  ADD COLUMN IF NOT EXISTS sync_lock_token UUID,
  ADD COLUMN IF NOT EXISTS sync_lock_until TIMESTAMP,
  ADD COLUMN IF NOT EXISTS credentials_updated_at TIMESTAMP;

CREATE INDEX IF NOT EXISTS idx_exchange_accounts_sync_lock_until
  ON exchange_accounts(sync_lock_until)
  WHERE sync_lock_token IS NOT NULL;

-- JobLog's old isRunning-then-insert sequence was a cross-process race. One
-- running scheduler row per job name makes acquisition atomic for every
-- scheduled job; callers that lose the unique conflict simply skip this tick.
WITH ranked AS (
  SELECT id,
         ROW_NUMBER() OVER (PARTITION BY job_name ORDER BY started_at DESC, id DESC) AS rank
  FROM job_logs
  WHERE status = 'running'
)
UPDATE job_logs jl
SET status = 'failed',
    completed_at = COALESCE(completed_at, CURRENT_TIMESTAMP),
    error_message = COALESCE(error_message, 'Superseded duplicate running scheduler row')
FROM ranked
WHERE jl.id = ranked.id AND ranked.rank > 1;

CREATE UNIQUE INDEX IF NOT EXISTS idx_job_logs_one_running_per_name
  ON job_logs(job_name)
  WHERE status = 'running';

-- Binance (and some provider-side enrichment feeds) can be honest about a
-- known historical coverage boundary while still importing the rows they can
-- enumerate. Preserve that distinction in the durable account status.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'exchange_accounts_last_sync_status_check'
      AND conrelid = 'exchange_accounts'::regclass
  ) THEN
    ALTER TABLE exchange_accounts DROP CONSTRAINT exchange_accounts_last_sync_status_check;
  END IF;
  ALTER TABLE exchange_accounts
    ADD CONSTRAINT exchange_accounts_last_sync_status_check
    CHECK (last_sync_status IS NULL
           OR last_sync_status IN ('ok', 'error', 'balance_mismatch', 'not_configured', 'coverage_limited'));
END $$;

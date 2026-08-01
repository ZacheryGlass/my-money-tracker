-- Durable exchange balance reconciliation evidence and review decisions.
--
-- exchange_accounts.balance_report remains a compatibility summary. These
-- tables are the auditable source of truth: a completed comparison gets an
-- immutable run/snapshot, while one current exception per account/asset keeps
-- the review queue small and actionable.
--
-- Migrations run on every boot, so all statements are idempotent.

CREATE TABLE IF NOT EXISTS exchange_balance_audit_runs (
  id BIGSERIAL PRIMARY KEY,
  exchange_account_id INT NOT NULL REFERENCES exchange_accounts(id) ON DELETE CASCADE,
  sync_job_id BIGINT REFERENCES exchange_sync_jobs(id) ON DELETE SET NULL,
  run_status VARCHAR(24) NOT NULL,
  backfill_pending BOOLEAN NOT NULL DEFAULT FALSE,
  balances_incomplete BOOLEAN NOT NULL DEFAULT FALSE,
  coverage_limitations JSONB NOT NULL DEFAULT '[]'::jsonb,
  calculated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'exchange_balance_audit_runs'::regclass
      AND conname = 'exchange_balance_audit_runs_status_check'
  ) THEN
    ALTER TABLE exchange_balance_audit_runs
      ADD CONSTRAINT exchange_balance_audit_runs_status_check
      CHECK (run_status IN ('authoritative', 'coverage_limited', 'skipped'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_exchange_balance_audit_runs_account_time
  ON exchange_balance_audit_runs(exchange_account_id, calculated_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS exchange_balance_audit_snapshots (
  id BIGSERIAL PRIMARY KEY,
  audit_run_id BIGINT NOT NULL REFERENCES exchange_balance_audit_runs(id) ON DELETE CASCADE,
  exchange_account_id INT NOT NULL REFERENCES exchange_accounts(id) ON DELETE CASCADE,
  canonical_asset VARCHAR(40) NOT NULL,
  provider_asset_codes JSONB NOT NULL DEFAULT '[]'::jsonb,
  provider_balances JSONB NOT NULL DEFAULT '{}'::jsonb,
  derived_balance NUMERIC(38, 18) NOT NULL,
  live_balance NUMERIC(38, 18) NOT NULL,
  delta NUMERIC(38, 18) NOT NULL,
  comparison_status VARCHAR(12) NOT NULL,
  calculated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (audit_run_id, canonical_asset)
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'exchange_balance_audit_snapshots'::regclass
      AND conname = 'exchange_balance_audit_snapshots_status_check'
  ) THEN
    ALTER TABLE exchange_balance_audit_snapshots
      ADD CONSTRAINT exchange_balance_audit_snapshots_status_check
      CHECK (comparison_status IN ('match', 'dust', 'mismatch'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_exchange_balance_snapshots_account_time
  ON exchange_balance_audit_snapshots(exchange_account_id, calculated_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS exchange_balance_exceptions (
  id BIGSERIAL PRIMARY KEY,
  exchange_account_id INT NOT NULL REFERENCES exchange_accounts(id) ON DELETE CASCADE,
  canonical_asset VARCHAR(40) NOT NULL,
  current_snapshot_id BIGINT REFERENCES exchange_balance_audit_snapshots(id) ON DELETE SET NULL,
  status VARCHAR(12) NOT NULL DEFAULT 'open',
  category VARCHAR(32),
  evidence TEXT,
  adjustment NUMERIC(38, 18) NOT NULL DEFAULT 0,
  adjusted_delta NUMERIC(38, 18),
  reviewer_id INT REFERENCES users(id) ON DELETE SET NULL,
  reviewed_at TIMESTAMP,
  resolved_at TIMESTAMP,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (exchange_account_id, canonical_asset)
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'exchange_balance_exceptions'::regclass
      AND conname = 'exchange_balance_exceptions_status_check'
  ) THEN
    ALTER TABLE exchange_balance_exceptions
      ADD CONSTRAINT exchange_balance_exceptions_status_check
      CHECK (status IN ('open', 'accepted', 'cleared'));
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'exchange_balance_exceptions'::regclass
      AND conname = 'exchange_balance_exceptions_category_check'
  ) THEN
    ALTER TABLE exchange_balance_exceptions
      ADD CONSTRAINT exchange_balance_exceptions_category_check
      CHECK (category IS NULL OR category IN (
        'opening_balance_gap', 'provider_migration', 'rounding_dust',
        'parser_defect', 'missing_activity'
      ));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_exchange_balance_exceptions_open
  ON exchange_balance_exceptions(exchange_account_id, updated_at DESC)
  WHERE status IN ('open', 'accepted');

-- 040/061 own this constraint's history. Keep the union when widening it.
DO $$
BEGIN
  ALTER TABLE exchange_accounts
    ALTER COLUMN last_sync_status TYPE VARCHAR(40);
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'exchange_accounts_last_sync_status_check'
      AND conrelid = 'exchange_accounts'::regclass
  ) THEN
    ALTER TABLE exchange_accounts DROP CONSTRAINT exchange_accounts_last_sync_status_check;
  END IF;
  ALTER TABLE exchange_accounts
    ADD CONSTRAINT exchange_accounts_last_sync_status_check
    CHECK (last_sync_status IS NULL OR last_sync_status IN (
      'ok', 'error', 'balance_mismatch', 'not_configured', 'coverage_limited',
      'reconciled_with_exceptions'
    ));
END $$;

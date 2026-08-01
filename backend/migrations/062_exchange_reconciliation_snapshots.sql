-- Exchange reconciliation snapshots (#84).
--
-- The balance report is derived and public; the complete provider balance
-- picture is private input used to rebuild it after a CSV import. Existing
-- reports cannot reconstruct that picture, so legacy accounts deliberately
-- start as unknown until a complete API sync supplies a snapshot.
--
-- Migrations run on every boot, so every statement is idempotent.

ALTER TABLE exchange_accounts
  ADD COLUMN IF NOT EXISTS provider_balance_snapshot JSONB,
  ADD COLUMN IF NOT EXISTS reconciliation_status VARCHAR(20) NOT NULL DEFAULT 'unknown';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                 WHERE conrelid = 'exchange_accounts'::regclass
                   AND conname = 'exchange_accounts_reconciliation_status_check'
                   AND pg_get_constraintdef(oid) LIKE '%stale%') THEN
    ALTER TABLE exchange_accounts
      DROP CONSTRAINT IF EXISTS exchange_accounts_reconciliation_status_check;
    ALTER TABLE exchange_accounts
      ADD CONSTRAINT exchange_accounts_reconciliation_status_check
      CHECK (reconciliation_status IN ('current', 'mismatch', 'stale', 'unknown'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_exchange_accounts_reconciliation_status
  ON exchange_accounts(user_id, reconciliation_status);

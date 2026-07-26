-- Exchange API sync: per-account read-only credentials, a resume cursor, and
-- the result of the balance reconciliation that runs after every sync.
--
-- CSV import (037) stays the fallback -- it is the only way to reach a closed
-- account's history, or history that predates the key -- so nothing here
-- replaces it. Both sources write exchange_records through the same
-- UNIQUE (exchange_account_id, external_id) upsert, which is what lets them
-- overlap without duplicating.
--
-- Credentials live HERE rather than in user_api_keys because the key is a
-- property of the account, not of the user: one person can hold two Kraken
-- accounts, and user_api_keys is keyed (user_id, service) with no room for the
-- second. The storage format is still the SecretsService one -- AES-256-GCM
-- via utils/secretCrypto, with the last4 kept alongside so the UI can show a
-- masked status without ever decrypting.
--
-- Re-runs on every boot, so every statement is idempotent.

-- ADD COLUMN IF NOT EXISTS is idempotent on its own; no guard needed.
ALTER TABLE exchange_accounts
  -- Ciphertext, never a plaintext key. Nothing user-facing may SELECT * from
  -- this table any more: reads that reach a response go through
  -- ExchangeAccount.PUBLIC_COLUMNS, which omits both encrypted columns.
  ADD COLUMN IF NOT EXISTS api_key_encrypted TEXT,
  ADD COLUMN IF NOT EXISTS api_key_last4 VARCHAR(8),
  ADD COLUMN IF NOT EXISTS api_secret_encrypted TEXT,
  ADD COLUMN IF NOT EXISTS api_secret_last4 VARCHAR(8),
  -- Provider-shaped resume point, not a shared scalar: Kraken's Ledgers feed
  -- resumes from a unix time, Coinbase's fills from an RFC3339 timestamp and
  -- its per-account transaction feeds from their own ids. One TEXT column
  -- would force the two connectors to agree on a meaning they do not share.
  ADD COLUMN IF NOT EXISTS sync_cursor JSONB,
  -- Set by every sync attempt including one that finds nothing, for the same
  -- reason last_import_at is: it answers "did the sync run", not "did the
  -- exchange have news".
  ADD COLUMN IF NOT EXISTS last_sync_at TIMESTAMP,
  ADD COLUMN IF NOT EXISTS last_sync_status VARCHAR(20),
  ADD COLUMN IF NOT EXISTS last_sync_error TEXT,
  -- Per-asset derived-vs-live comparison from the last sync. A mismatch means
  -- records were missed or misparsed, and the whole point of storing it is
  -- that the account says so instead of silently looking complete.
  ADD COLUMN IF NOT EXISTS balance_report JSONB;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                 WHERE conrelid = 'exchange_accounts'::regclass
                   AND conname = 'exchange_accounts_last_sync_status_check') THEN
    ALTER TABLE exchange_accounts
      ADD CONSTRAINT exchange_accounts_last_sync_status_check
      CHECK (last_sync_status IS NULL
             OR last_sync_status IN ('ok', 'error', 'balance_mismatch', 'not_configured'));
  END IF;
END $$;

-- A key is only usable when BOTH halves are present: Kraken signs with the
-- private key and identifies with the API key, and Coinbase's JWT needs the
-- key name as `kid` and the PEM to sign with. Half a credential would make
-- every sync fail with a signature error instead of skipping the account, so
-- the pairing is enforced here rather than hoped for in the route.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                 WHERE conrelid = 'exchange_accounts'::regclass
                   AND conname = 'exchange_accounts_credential_pair_check') THEN
    ALTER TABLE exchange_accounts
      ADD CONSTRAINT exchange_accounts_credential_pair_check
      CHECK ((api_key_encrypted IS NULL) = (api_secret_encrypted IS NULL));
  END IF;
END $$;

-- The nightly job's work list: accounts that actually have a credential. A
-- partial index keeps it to the handful of connected accounts rather than
-- every account ever created for a CSV upload.
CREATE INDEX IF NOT EXISTS idx_exchange_accounts_api_configured
  ON exchange_accounts(user_id) WHERE api_key_encrypted IS NOT NULL;

-- Where a record came from. NULL means "CSV or pre-040", which is exactly what
-- every existing row is: a backfill that stamped 'csv' would be inventing
-- provenance for rows imported before the column existed. Nothing votes on it
-- -- dedupe and the needs_review upgrade guard are both blind to source, so an
-- API row and a CSV row for the same event still collapse onto one record.
ALTER TABLE exchange_records
  ADD COLUMN IF NOT EXISTS source VARCHAR(10);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                 WHERE conrelid = 'exchange_records'::regclass
                   AND conname = 'exchange_records_source_check') THEN
    ALTER TABLE exchange_records
      ADD CONSTRAINT exchange_records_source_check
      CHECK (source IS NULL OR source IN ('csv', 'api'));
  END IF;
END $$;

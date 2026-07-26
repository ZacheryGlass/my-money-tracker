-- Exchange accounts and their imported activity records.
--
-- On-exchange activity (trades, exchange-to-exchange transfers, fiat on/off
-- ramps) never touches a tracked wallet, so no on-chain source can show it.
-- These two tables are where a CSV export -- or, later, an API sync -- lands.
--
-- Ownership lives on exchange_accounts (root table, user_id NOT NULL);
-- exchange_records inherits scope by joining through it, exactly like
-- holdings/transactions inherit from accounts. There is no NULL/shared row
-- here: an exchange account is always somebody's.
--
-- Re-runs on every boot, so every statement is idempotent.
CREATE TABLE IF NOT EXISTS exchange_accounts (
  id SERIAL PRIMARY KEY,
  user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name VARCHAR(120) NOT NULL,
  exchange VARCHAR(20) NOT NULL DEFAULT 'other',
  -- Set by every import attempt, including one that inserts nothing. "Last
  -- import" is a question about the user's action, not about whether the file
  -- happened to contain new rows.
  last_import_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- CREATE TABLE IF NOT EXISTS skips its whole body once the table exists, so
-- constraints that may need to change later are added by guarded DO blocks
-- rather than inline. Widening the allowed list is then a drop + re-add here.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                 WHERE conrelid = 'exchange_accounts'::regclass
                   AND conname = 'exchange_accounts_exchange_check') THEN
    ALTER TABLE exchange_accounts
      ADD CONSTRAINT exchange_accounts_exchange_check
      CHECK (exchange IN ('coinbase', 'kraken', 'other'));
  END IF;
END $$;

-- One account per name per user: re-uploading into "Kraken" must reach the
-- same account rather than quietly creating a second one whose records never
-- dedupe against the first.
CREATE UNIQUE INDEX IF NOT EXISTS uq_exchange_accounts_user_name
  ON exchange_accounts(user_id, LOWER(name));

-- One row per economic event, not per CSV line: a Kraken trade's two ledger
-- legs and a Coinbase Pro trade's two match rows plus its fee row each collapse
-- into a single record carrying both assets and the fee.
--
-- external_id is the exchange's own identifier for that event (Coinbase's row
-- ID, a Coinbase Pro transfer/order id, a Kraken txid or refid). Rows that
-- carry no native id -- Coinbase Pro conversions, for instance -- get a
-- deterministic content hash instead, so UNIQUE (exchange_account_id,
-- external_id) makes re-importing a fuller export a no-op for rows already
-- held. That property is the whole reason the column is NOT NULL.
CREATE TABLE IF NOT EXISTS exchange_records (
  id BIGSERIAL PRIMARY KEY,
  exchange_account_id INT NOT NULL REFERENCES exchange_accounts(id) ON DELETE CASCADE,
  record_type VARCHAR(20) NOT NULL,
  occurred_at TIMESTAMP NOT NULL,
  base_asset VARCHAR(20),
  base_amount NUMERIC(38, 18),
  quote_asset VARCHAR(20),
  quote_amount NUMERIC(38, 18),
  fee_asset VARCHAR(20),
  fee_amount NUMERIC(38, 18),
  -- Exchanges usually publish the on-chain hash for crypto withdrawals; it is
  -- the key to matching an exchange withdrawal against a wallet deposit.
  tx_hash VARCHAR(80),
  -- Withdrawal destination / deposit source when the export provides one. Some
  -- exports put a venue name ("GDAX", "BTC Vault") here rather than an address,
  -- hence the loose type.
  address VARCHAR(80),
  external_id VARCHAR(120) NOT NULL,
  -- An unrecognized row type imports flagged rather than being dropped: a
  -- silent skip is indistinguishable from a row the exchange never wrote.
  needs_review BOOLEAN NOT NULL DEFAULT FALSE,
  raw JSONB,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (exchange_account_id, external_id)
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                 WHERE conrelid = 'exchange_records'::regclass
                   AND conname = 'exchange_records_record_type_check') THEN
    ALTER TABLE exchange_records
      ADD CONSTRAINT exchange_records_record_type_check
      CHECK (record_type IN ('trade', 'deposit', 'withdrawal', 'fee', 'reward', 'conversion', 'transfer'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_exchange_records_account_time
  ON exchange_records(exchange_account_id, occurred_at DESC);
-- Partial: the review queue is a handful of rows against a full history.
CREATE INDEX IF NOT EXISTS idx_exchange_records_needs_review
  ON exchange_records(exchange_account_id) WHERE needs_review;
-- No reader yet: this pre-builds the by-hash lookup the on-chain matching
-- pass (#61) needs. Until then it is write cost only.
CREATE INDEX IF NOT EXISTS idx_exchange_records_tx_hash
  ON exchange_records(tx_hash) WHERE tx_hash IS NOT NULL;

-- Historical venue accounts whose provider records can never be recovered.
-- This is an explicit completeness verdict, not a claim that the account had
-- no activity.  It lets the ledger stop nagging while still showing the
-- bounded on-exchange gap.
ALTER TABLE exchange_accounts
  ADD COLUMN IF NOT EXISTS records_unavailable BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE eth_address_labels
  ADD COLUMN IF NOT EXISTS exchange_account_id INT REFERENCES exchange_accounts(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_eth_address_labels_exchange_account
  ON eth_address_labels(exchange_account_id)
  WHERE exchange_account_id IS NOT NULL;

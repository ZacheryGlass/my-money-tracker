-- A source-owned portfolio account lets every existing holdings consumer see
-- exchange balances without confusing transaction-derived balances with cash
-- actually held at the venue. Removing the exchange removes its projection.
CREATE UNIQUE INDEX IF NOT EXISTS exchange_accounts_id_user_unique
  ON exchange_accounts(id, user_id);
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS exchange_account_id INT;
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS exchange_balance_as_of TIMESTAMPTZ;
CREATE UNIQUE INDEX IF NOT EXISTS accounts_exchange_unique ON accounts(exchange_account_id);
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'accounts_exchange_owner_fk') THEN
    ALTER TABLE accounts ADD CONSTRAINT accounts_exchange_owner_fk
      FOREIGN KEY (exchange_account_id, user_id) REFERENCES exchange_accounts(id, user_id) ON DELETE CASCADE;
  END IF;
END $$;
-- Preserve provider precision (including staking dust) in portfolio quantities.
ALTER TABLE holdings ALTER COLUMN quantity TYPE NUMERIC(38,18);

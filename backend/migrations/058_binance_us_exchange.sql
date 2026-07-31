-- Binance.US is a first-class read-only API source. Existing installations
-- have the venue check from 037, so replace it idempotently rather than
-- relying on CREATE TABLE IF NOT EXISTS to revisit the old constraint.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint
             WHERE conrelid = 'exchange_accounts'::regclass
               AND conname = 'exchange_accounts_exchange_check') THEN
    ALTER TABLE exchange_accounts DROP CONSTRAINT exchange_accounts_exchange_check;
  END IF;
  ALTER TABLE exchange_accounts
    ADD CONSTRAINT exchange_accounts_exchange_check
    CHECK (exchange IN ('coinbase', 'kraken', 'binance_us', 'other'));
END $$;

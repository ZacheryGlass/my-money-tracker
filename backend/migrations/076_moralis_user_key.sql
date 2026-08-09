-- Moralis is an optional, per-user EVM audit/backfill source. Its credential
-- belongs beside the user's Etherscan key and is encrypted by SecretsService;
-- it is never an app-wide setting because audit requests expose wallet history.
--
-- Migrations re-run on every boot. Migration 027 creates the original narrower
-- constraint on a fresh database, then this migration widens it exactly once.
-- The wallet audit credentials remain separate from the Coinbase exchange key.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conrelid = 'user_api_keys'::regclass
       AND conname = 'user_api_keys_service_check'
       AND pg_get_constraintdef(oid) LIKE '%moralis%'
  ) THEN
    ALTER TABLE user_api_keys
      DROP CONSTRAINT IF EXISTS user_api_keys_service_check;
    ALTER TABLE user_api_keys
      ADD CONSTRAINT user_api_keys_service_check
      CHECK (service IN (
        'plaid_client_id', 'plaid_secret', 'etherscan', 'moralis'
      ));
  END IF;
END $$;

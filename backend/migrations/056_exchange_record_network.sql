-- Network identity for exchange deposits and withdrawals.
--
-- A transaction hash or a 20-byte address is not a chain identity. The same
-- address can exist on every EVM chain, and a signed transaction can be
-- replayed on more than one chain. Keep both representations:
--   network  - the venue's original human/machine-readable value
--   chain_id - the normalized EVM chain id when it can be established
--
-- NULL is intentional for old rows and non-EVM networks. Backfilling a chain
-- from an asset ticker would invent evidence; later API/CSV imports can fill
-- these columns additively from source data.
ALTER TABLE exchange_records
  ADD COLUMN IF NOT EXISTS network VARCHAR(80),
  ADD COLUMN IF NOT EXISTS chain_id BIGINT;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                 WHERE conrelid = 'exchange_records'::regclass
                   AND conname = 'exchange_records_chain_id_check') THEN
    ALTER TABLE exchange_records
      ADD CONSTRAINT exchange_records_chain_id_check
      CHECK (chain_id IS NULL OR chain_id > 0);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_exchange_records_chain_hash
  ON exchange_records(chain_id, tx_hash)
  WHERE tx_hash IS NOT NULL;

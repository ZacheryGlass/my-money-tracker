-- An explicit user assumption splits a net ETH deposit into gross receipt and
-- rounding loss in the ledger. Source amounts, fees, and balances stay intact.
ALTER TABLE exchange_records
  ADD COLUMN IF NOT EXISTS eth_rounding_adjustment_wei NUMERIC(78,0),
  ADD COLUMN IF NOT EXISTS eth_rounding_adjustment_note TEXT;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
    WHERE conrelid = 'exchange_records'::regclass
      AND conname = 'exchange_records_eth_rounding_check') THEN
    ALTER TABLE exchange_records ADD CONSTRAINT exchange_records_eth_rounding_check CHECK (
      (eth_rounding_adjustment_wei IS NULL AND eth_rounding_adjustment_note IS NULL)
      OR (eth_rounding_adjustment_wei IS NOT NULL AND eth_rounding_adjustment_wei < 0
        AND eth_rounding_adjustment_note IS NOT NULL
        AND length(btrim(eth_rounding_adjustment_note)) BETWEEN 1 AND 2000
        AND record_type = 'deposit' AND base_asset IS NOT NULL AND base_asset = 'ETH'
        AND base_amount IS NOT NULL AND base_amount >= 0)
    );
  END IF;
END $$;

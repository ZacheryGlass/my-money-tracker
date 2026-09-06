-- Preserve the Ethereum priority-operation hash exposed by the official
-- zkSync Lite archive on Deposit records. Lite's own txHash differs from the
-- L1 transaction hash, so this field is the protocol identity that joins the
-- two bridge sides.

ALTER TABLE eth_transfers
  ADD COLUMN IF NOT EXISTS bridge_source_tx_hash VARCHAR(66);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'eth_transfers'::regclass
       AND conname = 'eth_transfers_bridge_source_tx_hash_check'
  ) THEN
    ALTER TABLE eth_transfers
      ADD CONSTRAINT eth_transfers_bridge_source_tx_hash_check CHECK (
        bridge_source_tx_hash IS NULL
        OR bridge_source_tx_hash ~ '^0x[0-9a-f]{64}$'
      );
  END IF;
END $$;

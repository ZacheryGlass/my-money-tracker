-- Mirrors eth_transfers rows into the transactions ledger. The column is the
-- only coupling point: reverting the mirror feature is
-- DELETE FROM transactions WHERE eth_transfer_id IS NOT NULL, after which the
-- nullable column is inert.
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS eth_transfer_id BIGINT REFERENCES eth_transfers(id) ON DELETE CASCADE;
CREATE UNIQUE INDEX IF NOT EXISTS idx_transactions_eth_transfer
  ON transactions(eth_transfer_id) WHERE eth_transfer_id IS NOT NULL;

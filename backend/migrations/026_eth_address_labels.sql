-- Labeled counterparty addresses (exchanges). Two sources:
--   'user'    -- added via the API (e.g. a personal Coinbase deposit address)
--   'builtin' -- seeded below from Etherscan public name tags
-- Re-runs every boot: ON CONFLICT DO NOTHING never overwrites an existing row,
-- so a user upsert of a builtin address (which flips source to 'user') survives.
CREATE TABLE IF NOT EXISTS eth_address_labels (
  address VARCHAR(42) PRIMARY KEY CHECK (address = LOWER(address)),
  name VARCHAR(64) NOT NULL,
  source VARCHAR(10) NOT NULL DEFAULT 'user' CHECK (source IN ('user', 'builtin')),
  note TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- NULL = counterparty is not a labeled exchange. Snapshot of the label name at
-- classification time; recomputed wholesale by EthTransfer.reclassifyCounterparties.
ALTER TABLE eth_transfers ADD COLUMN IF NOT EXISTS counterparty_exchange VARCHAR(64);

-- The builtin exchange seed moved to 029_user_scoping_enforce.sql: its
-- ON CONFLICT (address) target disappears once 029 swaps this table's PK to
-- a surrogate id with partial unique indexes.

-- Durable receipts for bounded forgotten-wallet discovery walks. Migration
-- 057 already created this table with one row per address; this migration
-- upgrades it to one receipt per (address, chain, depth) without losing the
-- old counters or failure explanations.
CREATE TABLE IF NOT EXISTS eth_discovery_fetches (
  id BIGSERIAL PRIMARY KEY,
  user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  address VARCHAR(42) NOT NULL,
  chain_id INT NOT NULL,
  depth SMALLINT NOT NULL DEFAULT 0 CHECK (depth >= 0),
  status VARCHAR(20) NOT NULL CHECK (status IN ('complete', 'failed', 'truncated', 'contract', 'high_traffic', 'dust')),
  rows_fetched INT NOT NULL DEFAULT 0,
  error_message TEXT,
  fetched_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (user_id, address, chain_id, depth)
);

-- 057's table has no surrogate id, depth, or rows_fetched columns. Add them
-- catalog-guarded, backfill the existing receipt as depth zero, and replace
-- its address-level primary key with the new surrogate key.
ALTER TABLE eth_discovery_fetches ADD COLUMN IF NOT EXISTS id BIGINT;
ALTER TABLE eth_discovery_fetches ADD COLUMN IF NOT EXISTS depth SMALLINT;
ALTER TABLE eth_discovery_fetches ADD COLUMN IF NOT EXISTS rows_fetched INT;
ALTER TABLE eth_discovery_fetches ADD COLUMN IF NOT EXISTS tx_count INT;

CREATE SEQUENCE IF NOT EXISTS eth_discovery_fetches_id_seq;
ALTER SEQUENCE eth_discovery_fetches_id_seq OWNED BY eth_discovery_fetches.id;
ALTER TABLE eth_discovery_fetches
  ALTER COLUMN id SET DEFAULT nextval('eth_discovery_fetches_id_seq'),
  ALTER COLUMN depth SET DEFAULT 0,
  ALTER COLUMN rows_fetched SET DEFAULT 0;

UPDATE eth_discovery_fetches
SET id = nextval('eth_discovery_fetches_id_seq')
WHERE id IS NULL;
UPDATE eth_discovery_fetches
SET depth = 0
WHERE depth IS NULL;
UPDATE eth_discovery_fetches
SET rows_fetched = COALESCE(rows_fetched, tx_count, 0)
WHERE rows_fetched IS NULL;

ALTER TABLE eth_discovery_fetches
  ALTER COLUMN id SET NOT NULL,
  ALTER COLUMN depth SET NOT NULL,
  ALTER COLUMN rows_fetched SET NOT NULL;

ALTER TABLE eth_discovery_fetches
  DROP CONSTRAINT IF EXISTS eth_discovery_fetches_pkey,
  DROP CONSTRAINT IF EXISTS eth_discovery_fetches_status_check;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'eth_discovery_fetches'::regclass
      AND contype = 'p'
  ) THEN
    ALTER TABLE eth_discovery_fetches ADD PRIMARY KEY (id);
  END IF;
END $$;

ALTER TABLE eth_discovery_fetches
  ADD CONSTRAINT eth_discovery_fetches_status_check
  CHECK (status IN ('complete', 'failed', 'truncated', 'contract', 'high_traffic', 'dust'));

CREATE UNIQUE INDEX IF NOT EXISTS eth_discovery_fetches_user_address_chain_depth_key
  ON eth_discovery_fetches(user_id, address, chain_id, depth);

CREATE INDEX IF NOT EXISTS idx_eth_discovery_fetches_user_status
  ON eth_discovery_fetches(user_id, status, fetched_at DESC);

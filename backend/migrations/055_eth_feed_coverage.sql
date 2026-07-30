-- 055: durable per-wallet/per-chain/per-feed source coverage.
--
-- eth_wallet_chains keeps compact resume cursors and one rolled-up error slot.
-- That is enough to resume ingestion but not enough to audit it: after two
-- feeds fail, the slot cannot say which provider error belonged to which feed,
-- when the attempt ran, or what indexed head bounded the successful feeds.
-- This table is the source-coverage manifest behind GET /api/eth/coverage.
CREATE TABLE IF NOT EXISTS eth_feed_coverage (
  wallet_id INT NOT NULL REFERENCES eth_wallets(id) ON DELETE CASCADE,
  chain_id INT NOT NULL,
  feed VARCHAR(16) NOT NULL CHECK (
    feed IN ('normal', 'internal', 'token', 'nft', 'nft1155', 'statesync')
  ),
  -- EVM feeds use block heights. zkSync Lite predates EIP-155/EVM blocks and
  -- uses its archive operation serial, which must not be mislabeled a block.
  cursor_kind VARCHAR(20) NOT NULL DEFAULT 'evm_block'
    CHECK (cursor_kind IN ('evm_block', 'archive_serial')),
  provider VARCHAR(200) NOT NULL,
  status VARCHAR(20) NOT NULL CHECK (
    status IN ('complete', 'failed', 'unsupported', 'not_applicable', 'unverified')
  ),
  covered_from_block BIGINT,
  covered_through_block BIGINT,
  covered_from_at TIMESTAMPTZ,
  covered_through_at TIMESTAMPTZ,
  indexed_head BIGINT,
  attempted_from_block BIGINT,
  error_code VARCHAR(100),
  error_message TEXT,
  last_attempt_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_success_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (wallet_id, chain_id, feed),
  CHECK (
    status <> 'complete'
    OR (covered_from_block IS NOT NULL AND covered_through_block IS NOT NULL)
  ),
  CHECK (
    status NOT IN ('failed', 'unsupported')
    OR error_message IS NOT NULL
  )
);

CREATE INDEX IF NOT EXISTS idx_eth_feed_coverage_status
  ON eth_feed_coverage(status, chain_id, feed);

-- A legacy cursor says where ingestion stopped, but the old rolled-up error
-- slot cannot prove which feed actually reached it. Schedule one safe genesis
-- recapture for rows that predate this manifest. The version column is the
-- idempotency sentinel because this repository deliberately re-runs every
-- migration on every boot. New rows start at the current version and already
-- start with zero cursors.
ALTER TABLE eth_wallet_chains
  ADD COLUMN IF NOT EXISTS coverage_recapture_version INT NOT NULL DEFAULT 0;

-- Existing cursors came from the genesis-starting importer, but the old
-- rolled-up error slot cannot prove the last per-feed attempt. Seed those
-- boundaries as UNVERIFIED, never COMPLETE. The first post-055 sync replaces
-- each row with an exact verdict. This makes migration honest while preserving
-- the useful lower/upper bounds already stored.
INSERT INTO eth_feed_coverage (
  wallet_id, chain_id, feed, cursor_kind, provider, status,
  covered_from_block, covered_through_block, attempted_from_block,
  last_attempt_at, last_success_at
)
SELECT c.wallet_id,
       c.chain_id,
       f.feed,
       CASE WHEN c.chain_id = 32401 THEN 'archive_serial' ELSE 'evm_block' END,
       'pre-coverage migration',
       'unverified',
       0,
       f.cursor_value,
       GREATEST(0, f.cursor_value - 64),
       COALESCE(c.last_synced_at AT TIME ZONE 'UTC', c.updated_at AT TIME ZONE 'UTC'),
       CASE
         WHEN c.last_synced_at IS NULL THEN NULL
         ELSE c.last_synced_at AT TIME ZONE 'UTC'
       END
  FROM eth_wallet_chains c
 CROSS JOIN LATERAL (
   VALUES
     ('normal', c.last_block_normal),
     ('internal', c.last_block_internal),
     ('token', c.last_block_token),
     ('nft', c.last_block_nft),
     ('nft1155', c.last_block_1155)
 ) AS f(feed, cursor_value)
ON CONFLICT (wallet_id, chain_id, feed) DO NOTHING;

-- The sixth feed is active only on these currently configured chains. Keep
-- the registry fact explicit in this one-time compatibility seed; normal syncs
-- derive applicability from config/chains.js and write not_applicable rows for
-- every other chain.
INSERT INTO eth_feed_coverage (
  wallet_id, chain_id, feed, cursor_kind, provider, status,
  covered_from_block, covered_through_block, attempted_from_block,
  last_attempt_at, last_success_at
)
SELECT c.wallet_id,
       c.chain_id,
       'statesync',
       'evm_block',
       'pre-coverage migration',
       'unverified',
       0,
       c.last_block_statesync,
       GREATEST(0, c.last_block_statesync - 64),
       COALESCE(c.last_synced_at AT TIME ZONE 'UTC', c.updated_at AT TIME ZONE 'UTC'),
       CASE
         WHEN c.last_synced_at IS NULL THEN NULL
         ELSE c.last_synced_at AT TIME ZONE 'UTC'
       END
 FROM eth_wallet_chains c
 WHERE c.chain_id IN (10, 100, 137, 8453)
ON CONFLICT (wallet_id, chain_id, feed) DO NOTHING;

-- Reset only resume state, never source evidence or annotations. Each feed's
-- normal delete-then-insert path removes old raw rows only after its own
-- genesis fetch succeeds; unsupported/failed feeds keep both cursor zero and
-- all previously stored rows until an authoritative replacement is available.
UPDATE eth_wallet_chains
   SET last_block_normal = 0,
       last_block_internal = 0,
       last_block_token = 0,
       last_block_nft = 0,
       last_block_1155 = 0,
       last_block_statesync = 0,
       coverage_recapture_version = 1,
       last_synced_at = NULL,
       updated_at = CURRENT_TIMESTAMP
 WHERE coverage_recapture_version < 1;

ALTER TABLE eth_wallet_chains
  ALTER COLUMN coverage_recapture_version SET DEFAULT 1;

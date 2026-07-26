-- Multi-chain wallet sync (#58). One wallet ADDRESS is now synced across
-- several chains -- Etherscan V2 serves them all from one key via the chainid
-- param -- so every raw row grows a chain dimension and resume state moves off
-- the wallet row onto a per-(wallet, chain) row.
--
-- Chain set and the live feed-parity findings behind it: backend/src/config/chains.js.
--
-- Re-runs on every boot, so every statement below is idempotent and converges
-- from any starting state.

-- Every row that predates this column came from mainnet, which is exactly what
-- DEFAULT 1 backfills it as. NOT NULL from the start: a NULL chain would make
-- the UNIQUE below fall open (NULLs never conflict), so two re-syncs of the
-- same tx could both insert.
ALTER TABLE eth_transfers ADD COLUMN IF NOT EXISTS chain_id INT NOT NULL DEFAULT 1;

-- The dedupe key. `ordinal` is a position within one feed, so without chain_id
-- the same address's tx #0 on Arbitrum and on mainnet collide on
-- (wallet, type, hash, ordinal) -- and ON CONFLICT DO NOTHING means the second
-- chain's row is DROPPED SILENTLY rather than erroring. Different chains do
-- produce different hashes in practice, but "in practice" is not a constraint:
-- a deterministic-deployment contract call replayed across L2s, or any wallet
-- that rebroadcasts the same signed payload, lands the same hash twice.
--
-- Guarded on the constraint DEFINITION rather than a name: the pre-#58
-- constraint is auto-named, and a name-only guard would either skip the swap
-- forever or redo it on every boot.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                 WHERE conrelid = 'eth_transfers'::regclass
                   AND contype = 'u'
                   AND pg_get_constraintdef(oid) LIKE '%chain_id%') THEN
    ALTER TABLE eth_transfers
      DROP CONSTRAINT IF EXISTS eth_transfers_wallet_id_transfer_type_tx_hash_ordinal_key;
    ALTER TABLE eth_transfers
      ADD CONSTRAINT eth_transfers_wallet_chain_feed_key
      UNIQUE (wallet_id, chain_id, transfer_type, tx_hash, ordinal);
  END IF;
END $$;

-- Sync's delete-then-insert window is now per (wallet, chain, feed, block), and
-- the pre-#58 index has no chain column to narrow on.
CREATE INDEX IF NOT EXISTS idx_eth_transfers_wallet_chain
  ON eth_transfers(wallet_id, chain_id, block_number DESC);

-- Per-(wallet, chain) sync state. Every cursor that used to live on
-- eth_wallets lives here instead, the NFT cursors from #54 included -- those
-- default to 0 like they do on the wallet row, so a newly-enabled chain
-- backfills NFTs from block 0 on its first sync.
CREATE TABLE IF NOT EXISTS eth_wallet_chains (
  wallet_id INT NOT NULL REFERENCES eth_wallets(id) ON DELETE CASCADE,
  chain_id INT NOT NULL,
  last_block_normal BIGINT NOT NULL DEFAULT 0,
  last_block_internal BIGINT NOT NULL DEFAULT 0,
  last_block_token BIGINT NOT NULL DEFAULT 0,
  last_block_nft BIGINT NOT NULL DEFAULT 0,
  last_block_1155 BIGINT NOT NULL DEFAULT 0,
  -- Per-chain error slot, same convention as eth_wallets.error_code so the
  -- FEED_SKIPPED partial-sync badge from #54 reads identically here:
  --   FEED_SKIPPED       -- a feed failed transiently; its cursor is frozen and
  --                         the next sync retries it
  --   FEED_UNSUPPORTED   -- a feed this chain/key cannot serve at all
  --   CHAIN_UNAVAILABLE  -- no feed on this chain is readable with this key
  error_code VARCHAR(100),
  error_message TEXT,
  -- The feeds this chain could not serve, by cursor name ('normal', 'internal',
  -- 'token', 'nft', 'nft1155'). This is the gap record reconciliation (#62)
  -- reads: an unsupported feed leaves its cursor frozen, so rows in that feed
  -- were never ingested and anything derived from them is INCOMPLETE, not
  -- merely stale. A missing 'internal' feed is the sharp case -- ETH arriving
  -- from a contract is only visible in traces -- so derived ETH balances on
  -- such a chain can legitimately disagree with action=balance:
  --   WHERE unsupported_feeds && ARRAY['normal','internal','token']
  -- selects exactly the (wallet, chain) pairs where that drift is expected
  -- rather than a bug worth chasing.
  unsupported_feeds TEXT[] NOT NULL DEFAULT '{}',
  last_synced_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (wallet_id, chain_id)
);

-- Existing wallets have synced mainnet and nothing else, so their stored
-- cursors ARE their chain-1 cursors. Seeded here rather than left to the first
-- post-upgrade sync, which would otherwise resume chain 1 from block 0 and
-- re-ingest every wallet's entire history.
--
-- DO NOTHING, NEVER DO UPDATE. This migration re-runs on every boot, and
-- eth_wallets.last_block_* stops being written from #58 on (see below), so a
-- DO UPDATE would rewind every live chain-1 cursor to a frozen value at every
-- restart -- and because sync deletes its resume window before re-inserting,
-- that is not just wasted refetching: each boot would delete and rebuild the
-- wallet's whole transfer history.
INSERT INTO eth_wallet_chains (
  wallet_id, chain_id,
  last_block_normal, last_block_internal, last_block_token,
  last_block_nft, last_block_1155,
  error_code, error_message, last_synced_at
)
SELECT w.id, 1,
       w.last_block_normal, w.last_block_internal, w.last_block_token,
       w.last_block_nft, w.last_block_1155,
       w.error_code, w.error_message, w.last_synced_at
  FROM eth_wallets w
ON CONFLICT (wallet_id, chain_id) DO NOTHING;

-- eth_wallets.last_block_normal/_internal/_token/_nft/_1155 are SUPERSEDED and
-- frozen from here, not dropped: the seed above reads them, and it has to keep
-- working on every future boot for any wallet that has not been re-synced yet.
-- eth_wallets.error_code / last_synced_at stay live as the whole-wallet
-- rollup across chains.

-- Chain context on the mirrored ledger. NULL on every row that is not on-chain
-- (Plaid, manual, CSV imports), so it doubles as "is this an on-chain row" for
-- the activity layer and the chain column/filter in #63.
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS chain_id INT;

-- Backfill the rows the mirror wrote before this column existed, or "NULL means
-- not on-chain" is a lie for every pre-#58 mirrored transaction: they carry an
-- eth_transfer_id and a NULL chain, the one combination the sentinel above
-- claims cannot occur.
--
-- Cheap and idempotent: only NULLs are touched, so a re-run (this file executes
-- on every boot) matches nothing, and the join is on transactions.eth_transfer_id,
-- which 025 indexed. The chain comes from the transfer rather than a flat 1, so
-- it stays correct once an L2 sync has mirrored rows of its own.
UPDATE transactions t
   SET chain_id = e.chain_id
  FROM eth_transfers e
 WHERE t.eth_transfer_id = e.id
   AND t.chain_id IS NULL;

-- Chain context on holdings. The wallet's crypto account now carries one ETH
-- holding PER CHAIN plus per-chain token rows, and they are distinguished by
-- name for display -- but derived-data cleanup has to know which rows a given
-- sync is responsible for, and parsing a display name to find out is exactly
-- the kind of thing that quietly deletes a disabled chain's positions.
ALTER TABLE holdings ADD COLUMN IF NOT EXISTS chain_id INT;

-- Every holding that already exists on a wallet account is mainnet's, ETH and
-- tokens alike. Only NULLs are touched, so a later sync's own values stand.
UPDATE holdings h
   SET chain_id = 1
  FROM accounts a
 WHERE a.id = h.account_id
   AND a.eth_wallet_id IS NOT NULL
   AND h.chain_id IS NULL;

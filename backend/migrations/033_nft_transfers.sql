-- ERC-721 / ERC-1155 transfers. Etherscan serves these as two more account
-- feeds (tokennfttx, token1155tx) alongside txlist/txlistinternal/tokentx, and
-- both honor the same ascending startblock/endblock paging _fetchPaged depends
-- on -- verified live against 0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045.
--
-- Each feed gets its OWN transfer_type ('nft', 'nft1155') rather than folding
-- into 'token' plus token_standard. UNIQUE (wallet_id, transfer_type, tx_hash,
-- ordinal) makes `ordinal` a position WITHIN one feed, and sync is
-- delete-then-insert per feed from that feed's own resume block. Sharing
-- 'token' across three independently-paged feeds would interleave three
-- ordinal sequences under one key, so a resync that returned a different
-- number of ERC-20 rows for a tx would silently renumber -- and collide with --
-- that tx's NFT rows. Separate types keep each feed's dedupe self-contained.
--
-- Re-runs every boot, so every statement below is idempotent and converges
-- from any starting state.
ALTER TABLE eth_transfers ADD COLUMN IF NOT EXISTS token_standard VARCHAR(8);

-- The on-chain id. NUMERIC(78,0) because an ERC-1155 id is a full uint256 --
-- far past both BIGINT and JS Number, so it is read and written as a string.
ALTER TABLE eth_transfers ADD COLUMN IF NOT EXISTS token_id NUMERIC(78, 0);

-- Every row that predates this column came from tokentx, which is ERC-20 only.
UPDATE eth_transfers SET token_standard = 'erc20'
 WHERE transfer_type = 'token' AND token_standard IS NULL;

-- Guarded on the constraint's DEFINITION, not just its name: the name already
-- exists (024 declares the CHECK inline), so a name-only guard would skip the
-- swap forever and 'nft' rows would never insert.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                 WHERE conrelid = 'eth_transfers'::regclass
                   AND conname = 'eth_transfers_transfer_type_check'
                   AND pg_get_constraintdef(oid) LIKE '%nft1155%') THEN
    ALTER TABLE eth_transfers DROP CONSTRAINT IF EXISTS eth_transfers_transfer_type_check;
    ALTER TABLE eth_transfers
      ADD CONSTRAINT eth_transfers_transfer_type_check
      CHECK (transfer_type IN ('native', 'internal', 'token', 'gas', 'nft', 'nft1155'));
  END IF;
END $$;

-- NULL on native/internal/gas rows -- those move ETH, which has no standard.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                 WHERE conrelid = 'eth_transfers'::regclass
                   AND conname = 'eth_transfers_token_standard_check') THEN
    ALTER TABLE eth_transfers
      ADD CONSTRAINT eth_transfers_token_standard_check
      CHECK (token_standard IS NULL OR token_standard IN ('erc20', 'erc721', 'erc1155'));
  END IF;
END $$;

-- value_wei on NFT rows is a COUNT OF UNITS, not wei and not a scaled decimal:
--   erc721  -> always 1; the token is indivisible and tokennfttx carries no
--              value field at all.
--   erc1155 -> the feed's tokenValue, which is how many copies of that id
--              moved (1 for a normal NFT, more for a semi-fungible edition).
-- token_decimals is written as 0 on both rather than left NULL, because the
-- shared unit helpers default a NULL to 18 and would render every NFT as
-- 0.000000000000000001.
--
-- Etherscan already emits ONE ROW PER ID for an ERC-1155 batch transfer
-- (verified: a safeBatchTransferFrom of 10 ids returns 10 rows sharing a
-- tx_hash), so ordinals unbundle a batch with no extra work.

-- No reader yet: this pre-builds the per-token (contract, id) lookup the
-- Crypto page's NFT facet (#56) needs. Until then it is write cost only.
CREATE INDEX IF NOT EXISTS idx_eth_transfers_nft
  ON eth_transfers(token_contract, token_id) WHERE token_id IS NOT NULL;

-- Per-feed resume cursors, matching last_block_normal/internal/token.
ALTER TABLE eth_wallets ADD COLUMN IF NOT EXISTS last_block_nft BIGINT NOT NULL DEFAULT 0;
ALTER TABLE eth_wallets ADD COLUMN IF NOT EXISTS last_block_1155 BIGINT NOT NULL DEFAULT 0;

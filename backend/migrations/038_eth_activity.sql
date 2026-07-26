-- Transaction-level activity, derived wholesale from eth_transfers.
--
-- eth_transfers is per LEG. One transaction is many legs: a Uniswap swap is a
-- token-out row, a token-in row and a gas row, which the per-leg ledger mirror
-- renders as three unrelated entries. This table is the tx-level explanation --
-- exactly ONE row per (wallet_id, chain_id, tx_hash) -- so "no transaction
-- unexplained" becomes a countable property: every row is either confidently
-- categorized or carries needs_review with a reason.
--
-- DERIVED, NEVER HAND-EDITED. Rebuilt wholesale on sync and on every
-- classification change, exactly like reclassifyCounterparties. Corrections
-- live in eth_activity_overrides and are joined at read time, so a rebuild can
-- never erase one -- which is the entire reason they are two tables.
--
-- The per-leg `transactions` mirror is deliberately untouched: Spending reads
-- it, and it stays the ledger. This is the ledger's explanation, not its
-- replacement.
--
-- Re-runs on every boot, so every statement below is idempotent.
CREATE TABLE IF NOT EXISTS eth_activity (
  id BIGSERIAL PRIMARY KEY,
  wallet_id INT NOT NULL REFERENCES eth_wallets(id) ON DELETE CASCADE,
  -- Ethereum mainnet until #58 adds L2s. In the key from day one so adding a
  -- chain is an insert, not a unique-constraint swap on a populated table.
  chain_id INT NOT NULL DEFAULT 1,
  tx_hash VARCHAR(66) NOT NULL,
  block_number BIGINT NOT NULL,
  block_time TIMESTAMP NOT NULL,
  category VARCHAR(32) NOT NULL,
  counterparty_address VARCHAR(42),
  -- Display text only. Matches eth_address_labels.name (VARCHAR(64)).
  counterparty_name VARCHAR(64),
  -- Copied from the one leg that carries calldata (034) for DISPLAY ONLY.
  -- No classification rule reads either column: a decoded name is a
  -- low-confidence hint and selector collisions are mined deliberately, so
  -- letting either vote would put an attacker in charge of whether a
  -- transaction reads as spending.
  method_id VARCHAR(10),
  method_name VARCHAR(200),
  -- What actually moved, netted per asset:
  --   [{asset, contract, token_id, token_standard, direction, amount, amount_raw}]
  -- `amount` is whole units, `amount_raw` is base units. value_wei on an NFT
  -- leg is a COUNT OF UNITS (033), never wei, so the builder branches on
  -- transfer_type BEFORE scaling -- a blind /1e18 renders a 1-of-1 as
  -- 0.000000000000000001.
  legs JSONB NOT NULL DEFAULT '[]'::jsonb,
  -- Gas actually burned, in wei. Populated even for a reverted transaction:
  -- the fee is real whether or not the transfer landed.
  fee_wei NUMERIC(78, 0) NOT NULL DEFAULT 0,
  needs_review BOOLEAN NOT NULL DEFAULT FALSE,
  review_reason VARCHAR(200),
  confidence VARCHAR(10) NOT NULL DEFAULT 'high',
  classified_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  -- The acceptance invariant, enforced by the database rather than trusted of
  -- the builder: one activity row per transaction per owning wallet.
  UNIQUE (wallet_id, chain_id, tx_hash)
);

-- CREATE TABLE IF NOT EXISTS skips its whole body once the table exists, so
-- the category list lives in a guarded DO block instead of inline: widening it
-- (#58 bridges, #61 staking, a future merchant kind) is then a drop + re-add
-- here. Guarded on the constraint's DEFINITION, not just its name -- a
-- name-only guard would skip every later widening forever. BUMP THE SENTINEL
-- BELOW when adding a value, or the swap never runs.
--
-- 'nft_burn' is the one addition to the enum as issued: rule 3 of the ladder
-- resolves zero-address legs to mint AND burn, and the issue's list -- which it
-- calls a superset for later issues to fill in -- named only nft_mint. Without
-- it a burn falls through to rule 7 and gets flagged for review, which is a
-- silent guess about the one transaction shape the chain states outright.
--
-- 'spend' and 'approval' are reachable only by override, not by any rule:
-- spend needs a merchant-labeled counterparty (eth_address_labels has no
-- merchant kind yet) and approval needs the calldata selector, which is
-- display-only here. Both are in the list so an override can name them.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                 WHERE conrelid = 'eth_activity'::regclass
                   AND conname = 'eth_activity_category_check'
                   AND pg_get_constraintdef(oid) LIKE '%nft_burn%') THEN
    ALTER TABLE eth_activity DROP CONSTRAINT IF EXISTS eth_activity_category_check;
    ALTER TABLE eth_activity
      ADD CONSTRAINT eth_activity_category_check
      CHECK (category IN (
        'self_transfer', 'exchange_deposit', 'exchange_withdrawal', 'exchange_trade',
        'staking_reward', 'swap', 'nft_purchase', 'nft_sale', 'nft_mint', 'nft_burn',
        'airdrop', 'send', 'receive', 'spend', 'approval', 'contract_interaction',
        'bridge_out', 'bridge_in', 'failed'
      ));
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                 WHERE conrelid = 'eth_activity'::regclass
                   AND conname = 'eth_activity_confidence_check') THEN
    ALTER TABLE eth_activity
      ADD CONSTRAINT eth_activity_confidence_check
      CHECK (confidence IN ('high', 'medium', 'low'));
  END IF;
END $$;

-- The feed's default ordering. block_number is chain-global, so it sorts a
-- merged multi-wallet feed correctly.
CREATE INDEX IF NOT EXISTS idx_eth_activity_wallet_block
  ON eth_activity(wallet_id, block_number DESC);
-- Partial: the review queue is a handful of rows against a full history.
CREATE INDEX IF NOT EXISTS idx_eth_activity_needs_review
  ON eth_activity(wallet_id) WHERE needs_review;
CREATE INDEX IF NOT EXISTS idx_eth_activity_category
  ON eth_activity(wallet_id, category);

-- Manual corrections. Separate table on purpose: eth_activity is deleted and
-- rebuilt in full on every sync and every label change, so a correction stored
-- ON that table would be erased by the next sync -- silently, and exactly for
-- the user who cared enough to make one. Readers COALESCE override over
-- derived, so a correction outlives any number of re-derivations.
--
-- Ownership lives on eth_wallets (the root table); this inherits scope through
-- the wallet join, like holdings and eth_transfers. ON DELETE CASCADE matches
-- eth_transfers: disconnecting a wallet with removeData=false already drops its
-- transfers, so there would be nothing left for an override to correct.
CREATE TABLE IF NOT EXISTS eth_activity_overrides (
  id BIGSERIAL PRIMARY KEY,
  wallet_id INT NOT NULL REFERENCES eth_wallets(id) ON DELETE CASCADE,
  chain_id INT NOT NULL DEFAULT 1,
  tx_hash VARCHAR(66) NOT NULL,
  category VARCHAR(32) NOT NULL,
  note TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  -- Same key as eth_activity, so the read-time join is 1:1 and re-correcting a
  -- transaction updates the verdict rather than stacking a second one.
  UNIQUE (wallet_id, chain_id, tx_hash)
);

-- Same list as eth_activity's. Kept in step deliberately: an override exists to
-- name a category the ladder could not reach, so a value legal on one table and
-- illegal on the other would be a correction the user can save and never see.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                 WHERE conrelid = 'eth_activity_overrides'::regclass
                   AND conname = 'eth_activity_overrides_category_check'
                   AND pg_get_constraintdef(oid) LIKE '%nft_burn%') THEN
    ALTER TABLE eth_activity_overrides DROP CONSTRAINT IF EXISTS eth_activity_overrides_category_check;
    ALTER TABLE eth_activity_overrides
      ADD CONSTRAINT eth_activity_overrides_category_check
      CHECK (category IN (
        'self_transfer', 'exchange_deposit', 'exchange_withdrawal', 'exchange_trade',
        'staking_reward', 'swap', 'nft_purchase', 'nft_sale', 'nft_mint', 'nft_burn',
        'airdrop', 'send', 'receive', 'spend', 'approval', 'contract_interaction',
        'bridge_out', 'bridge_in', 'failed'
      ));
  END IF;
END $$;

-- The 4-byte method selector of the top-level transaction, so "Contract
-- interaction" can eventually read "Uniswap: swapExactETHForTokens".
--
-- Only the top-level tx carries a selector, so both columns are populated on the
-- native leg (ordinal 0) of the txlist row and stay NULL on internal, token and
-- gas legs. Both are nullable and always will be: a plain ETH send has no
-- selector at all, and a selector nobody can name has no method_name.
--
-- method_name is a DISPLAY HINT ONLY. Selector collisions are real and cheap to
-- mint (0x7ff36ab5 is both swapExactETHForTokens and a spam signature), so
-- nothing in classification may read this column -- movement, counterparty and
-- label decide what a transfer IS.
ALTER TABLE eth_transfers ADD COLUMN IF NOT EXISTS method_id VARCHAR(10);
ALTER TABLE eth_transfers ADD COLUMN IF NOT EXISTS method_name VARCHAR(200);

-- Global and shared like price_cache and security_master: a selector -> name
-- mapping is a property of the chain, not of a user, and there is nothing
-- private in it. No user_id, and every sync reads and writes the same rows.
--
-- A row exists for every selector ever looked up, INCLUDING misses (name NULL,
-- source 'none'). That is the whole point of the table: without cached misses,
-- the undecodable selectors -- the ones that repeat forever -- would be refetched
-- on every single sync. name is TEXT rather than VARCHAR(200) because it stores
-- the upstream signature verbatim; eth_transfers.method_name is the truncated
-- display copy.
CREATE TABLE IF NOT EXISTS eth_method_signatures (
  selector VARCHAR(10) PRIMARY KEY,
  name TEXT,
  source VARCHAR(20),
  fetched_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Matches the decode pass's pending scan exactly. Partial, because rows that
-- already carry a name (the overwhelming majority, since Etherscan names most
-- verified contracts inline) never need to be visited again.
CREATE INDEX IF NOT EXISTS idx_eth_transfers_method_pending
  ON eth_transfers(wallet_id, method_id)
  WHERE method_id IS NOT NULL AND method_name IS NULL;

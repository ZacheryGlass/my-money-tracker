-- On-chain balance reconciliation (#62). "No transaction unaccounted for" is a
-- claim, not a fact, until the stored ledger reproduces the balance the chain
-- itself reports. This table is where that comparison is written down, so drift
-- is visible instead of silent.
--
-- One row per (wallet, chain, asset). The asset is the chain's native ETH or an
-- ERC-20 contract; NFTs are deliberately absent -- their value_wei is a COUNT OF
-- UNITS (033), not a quantity, and there is no live "balance" endpoint to
-- compare a token-id set against.
--
-- Shape follows the exchange-sync reconciliation (040's balance_report) in every
-- way that matters: derive in exact NUMERIC, compare against the live figure,
-- REPORT the difference rather than correcting it -- the derived number is the
-- thing under test, so overwriting it with the live one would hide the bug this
-- exists to find -- and skip the comparison outright while the picture is
-- incomplete rather than recording a mismatch that says nothing.
--
-- Re-runs on every boot, so every statement below is idempotent.

CREATE TABLE IF NOT EXISTS eth_reconciliation (
  id SERIAL PRIMARY KEY,
  wallet_id INT NOT NULL REFERENCES eth_wallets(id) ON DELETE CASCADE,
  -- Per chain, never rolled up. Block numbers, feeds and cursors are all
  -- per-chain (039), so an incomplete Arbitrum feed must not be able to make
  -- mainnet's ETH look like it drifted.
  chain_id INT NOT NULL,
  -- 'ETH' for the native asset, else the lowercase 0x token contract. A single
  -- NOT NULL text key rather than a nullable token_contract column because the
  -- UNIQUE below is the upsert target, and a NULL there would never conflict --
  -- so every sync would insert another native row for the same chain forever.
  asset_key VARCHAR(42) NOT NULL,
  asset_type VARCHAR(10) NOT NULL,
  -- Display only, copied off the transfer rows. A token that renames itself
  -- mid-history is a curiosity, not a reconciliation input.
  token_symbol VARCHAR(64),
  -- NULL means 18 in the shared unit helpers, and readers here follow the same
  -- rule. Stored so the UI can scale delta_units without re-reading transfers.
  token_decimals INT,
  -- BASE UNITS (wei for ETH, the token's own smallest unit otherwise), exact
  -- integers, never a float and never pre-scaled. NUMERIC(78,0) is the same
  -- width as eth_transfers.value_wei, which is what these are summed from:
  -- a uint256 total does not fit anything narrower, and float8 would round away
  -- exactly the small drift this table exists to surface.
  derived_units NUMERIC(78, 0),
  -- NULL when the live figure could not be read this run (status 'unavailable'
  -- or 'skipped'). Zero and unknown are not the same thing: a NULL that
  -- defaulted to 0 would report the wallet's entire holding as missing.
  live_units NUMERIC(78, 0),
  -- derived - live. Positive means the ledger claims more than the chain does.
  delta_units NUMERIC(78, 0),
  --   match       -- delta is exactly zero
  --   dust        -- nonzero but below the display threshold (tokens only)
  --   mismatch    -- a real difference: a movement was missed or misparsed
  --   skipped     -- not compared, because the stored picture is incomplete
  --   unavailable -- the live balance could not be read this run
  status VARCHAR(20) NOT NULL,
  -- Why a row is 'skipped'/'unavailable', so the UI can say something other
  -- than "unknown". See EthReconciliationService.SKIP_REASONS.
  skip_reason VARCHAR(40),
  -- When the asset was last actually COMPARED -- not when the row was last
  -- written. NULLABLE, and NULL is load-bearing: a row written because the
  -- lookup budget deferred it has never been compared, and the rotation sorts
  -- those first. Stamping every write would give the deferred tail a LATER
  -- timestamp than the assets just checked (each upsert is its own statement),
  -- so the same head of the list would be re-checked nightly forever.
  checked_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  -- The upsert target. One verdict per asset per chain per wallet: the point is
  -- the CURRENT state of the audit, not a time series (a nightly row per token
  -- would grow without bound and answer no question the latest row does not).
  UNIQUE (wallet_id, chain_id, asset_key)
);

-- checked_at started life NOT NULL DEFAULT CURRENT_TIMESTAMP; a table created
-- by an earlier boot still carries that. Both statements are no-ops once
-- applied, which is what makes them safe on a migration file that re-runs every
-- boot. Existing rows keep their stamps: a skipped row's timestamp now freezes
-- instead of advancing, so the rotation corrects itself on the next sync.
ALTER TABLE eth_reconciliation ALTER COLUMN checked_at DROP NOT NULL;
ALTER TABLE eth_reconciliation ALTER COLUMN checked_at DROP DEFAULT;

-- Named constraints, added under a catalog guard so a re-run neither fails nor
-- re-adds them. Spelled as DO blocks rather than ADD CONSTRAINT IF NOT EXISTS
-- because Postgres has no such form for CHECK.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                 WHERE conrelid = 'eth_reconciliation'::regclass
                   AND conname = 'eth_reconciliation_status_check') THEN
    ALTER TABLE eth_reconciliation
      ADD CONSTRAINT eth_reconciliation_status_check
      CHECK (status IN ('match', 'dust', 'mismatch', 'skipped', 'unavailable'));
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                 WHERE conrelid = 'eth_reconciliation'::regclass
                   AND conname = 'eth_reconciliation_asset_type_check') THEN
    ALTER TABLE eth_reconciliation
      ADD CONSTRAINT eth_reconciliation_asset_type_check
      CHECK (asset_type IN ('native', 'token'));
  END IF;
END $$;

-- The reader's access path: every wallet's rows, worst first. Partial on the
-- two statuses that mean something is wrong, because that is the query the
-- badge and the data-health check run and it is answered from a handful of rows
-- even on a wallet carrying hundreds of matched tokens.
CREATE INDEX IF NOT EXISTS idx_eth_reconciliation_open
  ON eth_reconciliation(wallet_id) WHERE status IN ('mismatch', 'unavailable');

-- Live-balance lookups are rate-limited (one global Etherscan throttle shared
-- across every user and chain), so a wallet holding more tokens than one sync's
-- budget checks them least-recently-checked first and rotates through. This is
-- the ordering that makes that rotation cheap.
CREATE INDEX IF NOT EXISTS idx_eth_reconciliation_wallet_checked
  ON eth_reconciliation(wallet_id, checked_at);

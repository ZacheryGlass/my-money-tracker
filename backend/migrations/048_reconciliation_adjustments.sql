-- Reconciliation ADJUSTMENTS: documented, audit-side corrections to the
-- balance audit's derived figure.
--
-- Why they exist: some drift is real, explained, and IRREPRODUCIBLE from any
-- feed. The canonical case is Arbitrum classic-era gas -- the true fees paid
-- before Nitro appear in NO Etherscan field (the migrated rows carry
-- gasUsed = 0, gasPrice = 0), so after the classic-deposit reshape a wallet
-- that transacted pre-Nitro audits high by exactly those fees, forever, and
-- the one signal the audit exists to raise (a NEW missed movement) drowns
-- under a permanent known delta.
--
-- An adjustment is the audit-side answer: a signed base-unit amount with a
-- MANDATORY note, SUMMED into the derived figure before delta/status are
-- decided. Several rows per (wallet, chain, asset) are allowed -- each one
-- documents a distinct explanation, and the audit sums them.
--
-- Scope, stated so it cannot creep: adjustments touch RECONCILIATION ONLY.
-- Holdings still come from the live balance, the mirror and activity layers
-- never read this table, and Spending is untouched. ETH keeps its zero
-- tolerance band -- an adjustment does not loosen the comparison, it documents
-- one exact, explained term of it. eth_reconciliation.derived_units stays the
-- RAW ledger-derived figure (the thing under test); only delta_units and
-- status reflect the adjustment, which is also what lets a verdict be
-- recomputed from stored figures without an Etherscan call.
--
-- UI scope, also stated so it cannot creep: only NATIVE adjustments get a form
-- (WalletsPanel's Adjust button rides the native drift list); token
-- adjustments are API-only by design, because token drift gets the dust band
-- and is never badged, so there is no token alarm for a correction to clear.
--
-- Child table, like eth_reconciliation itself: ownership lives on eth_wallets,
-- writers verify the wallet against the caller (foreign ids 404), and every
-- read joins eth_wallets on user_id. The CASCADE below means adjustments die
-- with the eth_wallets row, which every disconnect deletes -- removeData=false
-- keeps the ACCOUNT, not the wallet row -- so a classic-fee correction must be
-- re-entered after a remove + re-add: a decision, not a surprise (the re-add
-- re-ingests from block 0 and the audit re-measures the drift first anyway).
--
-- Re-runs on every boot, so the statement is idempotent. The CHECKs live
-- inline in the CREATE: they are born with the table or not at all, which is
-- exactly the guarantee a guarded ALTER would re-implement.

CREATE TABLE IF NOT EXISTS eth_reconciliation_adjustments (
  id SERIAL PRIMARY KEY,
  wallet_id INT NOT NULL REFERENCES eth_wallets(id) ON DELETE CASCADE,
  -- Per chain, like the verdict rows: an explained delta on Arbitrum says
  -- nothing about mainnet.
  chain_id INT NOT NULL,
  -- 'ETH'/'POL' for a native asset, else the lowercase 0x token contract --
  -- the same key eth_reconciliation rows carry, so the sum lands on exactly
  -- one verdict row.
  asset_key VARCHAR(42) NOT NULL,
  -- SIGNED base units (wei for ETH). Negative absorbs a ledger that derives
  -- HIGH (the classic-fee case); positive absorbs one that derives low.
  -- NUMERIC(78,0) like every other base-unit column: exact, never a float,
  -- and a zero adjustment is refused outright -- it would document nothing
  -- while making the audit look hand-touched.
  amount_wei NUMERIC(78, 0) NOT NULL CONSTRAINT eth_recon_adjustments_nonzero CHECK (amount_wei <> 0),
  -- The whole point. An adjustment without its explanation is
  -- indistinguishable from fudging the audit until it stops talking.
  note TEXT NOT NULL CONSTRAINT eth_recon_adjustments_note_nonempty CHECK (btrim(note) <> ''),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- The audit's read path: every adjustment for one wallet, summed per
-- (chain, asset) -- and the delete path's ownership join.
CREATE INDEX IF NOT EXISTS idx_eth_recon_adjustments_key
  ON eth_reconciliation_adjustments(wallet_id, chain_id, asset_key);

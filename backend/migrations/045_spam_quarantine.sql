-- Spam quarantine (#74). Address poisoning, dust and scam airdrops recognized
-- at classification time and taken OUT of the review queue instead of demanding
-- a human verdict each.
--
-- QUARANTINE, NEVER DELETION. Nothing here removes a row, a leg or a balance:
--   * eth_transfers is untouched, so the balance audit (042) still derives from
--     every wei that actually moved. A spam quarantine that dropped legs would
--     make reconciliation report drift the chain does not have.
--   * eth_activity keeps its ladder verdict, its netted legs and its at-the-time
--     dollars (043). `spam` is a FLAG BESIDE the verdict, not a replacement for
--     it -- which is what makes un-quarantining lossless: the row that comes
--     back is the row that was there, not a guess at what it used to say.
--   * needs_review keeps the ladder's honest answer too. Readers mask it while
--     the row is quarantined; un-quarantining uncovers it again, so a false
--     positive returns to the queue instead of silently becoming "reviewed".
--
-- Re-runs on every boot, so every statement below is idempotent.

-- The quarantine flag itself. NOT NULL DEFAULT FALSE: every pre-045 row is
-- unquarantined, which is the honest answer for history classified before the
-- heuristics existed, and the next rebuild (any sync, any label write) applies
-- them retroactively -- unlike 034's method capture and 038's tx_is_error,
-- nothing here needs re-ingesting from the chain, because the heuristics read
-- only stored rows.
ALTER TABLE eth_activity ADD COLUMN IF NOT EXISTS spam BOOLEAN NOT NULL DEFAULT FALSE;

-- WHICH heuristic fired, as a REASON CODE -- deliberately unlike
-- eth_activity.review_reason, which stores the finished sentence.
--
-- The poisoning verdict has to render differently from the others: it carries a
-- security warning ("never copy an address out of transaction history") that a
-- dust airdrop must not, and a client cannot branch on prose. Codes also keep
-- the CHECK below meaningful.
ALTER TABLE eth_activity ADD COLUMN IF NOT EXISTS spam_reason VARCHAR(32);

-- Guarded on the constraint's DEFINITION, like 038's category check and for the
-- same reason: a name-only guard is satisfied by the constraint already there,
-- so a later widening would be skipped forever on every deployed database while
-- looking perfectly applied on a fresh one. BUMP THE SENTINEL BELOW
-- ('unsolicited_nft', the newest value) when adding a reason.
--
-- NULL is legal and means "not quarantined"; the paired CHECK after it is what
-- keeps the flag and the reason from disagreeing.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                 WHERE conrelid = 'eth_activity'::regclass
                   AND conname = 'eth_activity_spam_reason_check'
                   AND pg_get_constraintdef(oid) LIKE '%unsolicited_nft%') THEN
    ALTER TABLE eth_activity DROP CONSTRAINT IF EXISTS eth_activity_spam_reason_check;
    ALTER TABLE eth_activity
      ADD CONSTRAINT eth_activity_spam_reason_check
      CHECK (spam_reason IS NULL OR spam_reason IN (
        'address_poisoning', 'zero_value_transfer', 'unsolicited_token', 'unsolicited_nft'
      ));
  END IF;
END $$;

-- A quarantined row always says why, and an unquarantined row never carries a
-- stale reason. Enforced here rather than trusted of the builder: "hidden, and
-- nobody can say on what grounds" is the failure mode a quarantine cannot have.
-- Definition-guarded like the other two, and for the reason the comment above
-- already gives: a name-only guard is satisfied by whatever constraint happens
-- to bear the name, so tightening or loosening this pairing later would be
-- skipped forever on every deployed database while looking perfectly applied on
-- a fresh one. BUMP THE SENTINEL BELOW ('spam_reason IS NULL', the closing
-- clause of the current definition) when changing the rule.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                 WHERE conrelid = 'eth_activity'::regclass
                   AND conname = 'eth_activity_spam_reason_paired'
                   AND pg_get_constraintdef(oid) LIKE '%spam_reason IS NULL%') THEN
    ALTER TABLE eth_activity DROP CONSTRAINT IF EXISTS eth_activity_spam_reason_paired;
    ALTER TABLE eth_activity
      ADD CONSTRAINT eth_activity_spam_reason_paired
      CHECK ((spam AND spam_reason IS NOT NULL) OR (NOT spam AND spam_reason IS NULL));
  END IF;
END $$;

-- The user's own verdict on the quarantine, in the SAME table that already
-- survives the wholesale rebuild (038). eth_activity is delete-then-insert on
-- every sync and every label change, so a correction stored on it would be
-- erased -- silently, and exactly for the user who cared enough to make one.
--
-- Three-valued on purpose:
--   NULL   no opinion; the heuristics decide.
--   FALSE  "not spam" -- the one-click unquarantine. Sticks across resync.
--   TRUE   "this IS spam" -- the manual quarantine, for the tail the heuristics
--          cannot see (a priced token from a chatty contract, say).
-- COALESCE(override, derived) at read time, exactly like the category.
ALTER TABLE eth_activity_overrides ADD COLUMN IF NOT EXISTS spam BOOLEAN;

-- An override used to be a category and nothing else, so category was NOT NULL.
-- A spam verdict is an override that deliberately says NOTHING about the
-- category: un-quarantining a scam-token arrival must restore the row exactly as
-- the ladder classified it, not re-label it. Readers already COALESCE
-- (o.category, a.category), so a NULL here uncovers the derived verdict.
ALTER TABLE eth_activity_overrides ALTER COLUMN category DROP NOT NULL;

-- ...which means an override row can now be written that says nothing at all.
-- Refuse it: an empty correction is a row the user can neither see nor undo.
--
-- Definition-guarded like the two above, and this one needs it most: the CHECK
-- ENUMERATES the nullable verdict columns, so a third one (a "hide from
-- spending" flag, say) has to widen it. A name-only guard is satisfied by the
-- constraint already there, so that widening would be skipped forever on every
-- deployed database while looking perfectly applied on a fresh one -- and the
-- two would then disagree about whether a third-column-only override is legal.
-- BUMP THE SENTINEL BELOW ('spam', the newest column named) when widening.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                 WHERE conrelid = 'eth_activity_overrides'::regclass
                   AND conname = 'eth_activity_overrides_not_empty'
                   AND pg_get_constraintdef(oid) LIKE '%spam%') THEN
    ALTER TABLE eth_activity_overrides DROP CONSTRAINT IF EXISTS eth_activity_overrides_not_empty;
    ALTER TABLE eth_activity_overrides
      ADD CONSTRAINT eth_activity_overrides_not_empty
      CHECK (category IS NOT NULL OR spam IS NOT NULL);
  END IF;
END $$;

-- The counterparty side of the rebuild, which DOES need indexes.
--
-- detectSpam has to know which counterparties already carry a verdict, and that
-- includes 036's 5,129 builtin label rows -- but only for addresses THIS wallet
-- has actually transacted with. Answering that means asking eth_transfers for
-- the wallet's distinct counterparty addresses, and the only index that existed
-- was (wallet_id, block_number), which makes it a heap scan of every leg the
-- wallet owns. On a 30k-transfer wallet that was 16.9 seconds -- inside
-- rebuildForWallet, which routes/eth.js AWAITS on every label write and every
-- ignore-list toggle, so the cost lands on a user's click.
--
-- Two composite indexes, one per direction, because a counterparty is whichever
-- end of the leg is not us and no single index covers both. They also serve the
-- distinct scan index-only: (wallet_id, address) is exactly the pair being read.
CREATE INDEX IF NOT EXISTS idx_eth_transfers_wallet_from
  ON eth_transfers (wallet_id, from_address);
CREATE INDEX IF NOT EXISTS idx_eth_transfers_wallet_to
  ON eth_transfers (wallet_id, to_address);

-- NO INDEX ON `spam`, deliberately, and this note is here so the next reader
-- does not add one back on reflex. Nothing can use it: the triage queue's
-- exclusion probes eth_activity by (wallet_id, chain_id, tx_hash) and is served
-- by the UNIQUE index, and the activity feed filters on COALESCE(override,
-- derived) outside the CTE that scans the table, which no index on the base
-- column can answer. A partial index here would cost every insert and serve
-- nothing.

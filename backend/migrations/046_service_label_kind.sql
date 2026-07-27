-- 046: a fifth address-label kind, 'service'.
--
-- An instant-swap service (Changelly, ShapeShift, and the untagged hubs that
-- behaved identically in 2017) issues a ONE-TIME deposit address per order:
-- you send ETH, it sends back a different asset -- usually on a different
-- chain, to an address you named at order time. On this chain, all that is
-- visible is money leaving and never coming back.
--
-- None of the four existing kinds says that:
--   'exchange' books it as an internal transfer, which DELETES a disposal from
--             the record -- the exact failure mode 036's demotion list exists
--             to avoid, applied to 164 ETH of it.
--   'external' is inert in classification, so every transfer stays on ladder
--             rung 8 flagged as possible spending, one hand override each.
--   'own'/'bridge' both assert the money is still the user's. It is not.
--
-- So 'service' earns its own rung, classifying the transfer as an
-- exchange_trade: a disposal (or an acquisition inbound), which is what
-- happened, with no far side to wait for. The category already exists in 038's
-- CHECK and in the vocabulary -- 038 anticipated exactly this, noting that
-- 'spend' and 'approval' "wait on a merchant label kind". This is that kind's
-- first half.
--
-- Re-runs on every boot, so every statement below is idempotent.

-- eth_address_labels_kind_check is owned by 032 (name-only guard, harmless
-- forever), 044 and now this file. Guard on the DEFINITION and BUMP THE
-- SENTINEL to the newest value ('service'), exactly as 044 did for 'bridge'.
--
-- 044's list is widened to the same union in the same commit, per the rule the
-- 041/044 source-check tug-of-war wrote down: WHEN TWO MIGRATIONS WIDEN THE
-- SAME CONSTRAINT, BOTH MUST LIST THE UNION OF EVERY VALUE. It is not strictly
-- required here -- 044's '%bridge%' sentinel stays satisfied by any union that
-- still contains 'bridge' -- but a reader should never have to re-derive that
-- argument to know whether the pair is safe, and the next kind added by
-- someone who does not know it would be.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                 WHERE conrelid = 'eth_address_labels'::regclass
                   AND conname = 'eth_address_labels_kind_check'
                   AND pg_get_constraintdef(oid) LIKE '%service%') THEN
    ALTER TABLE eth_address_labels DROP CONSTRAINT IF EXISTS eth_address_labels_kind_check;
    ALTER TABLE eth_address_labels
      ADD CONSTRAINT eth_address_labels_kind_check
      CHECK (kind IN ('exchange', 'external', 'own', 'bridge', 'service'));
  END IF;
END $$;

-- No category work. 'exchange_trade' has been in eth_activity's and
-- eth_activity_overrides' CHECK since 038 and in CATEGORIES since then too --
-- reachable by hand override all along, just never by the ladder. This
-- migration adds no column, no table and no seed: the swap services a user
-- deals with are their own history, and a builtin pack of them would be
-- guesses about which 2017 hub belonged to whom.

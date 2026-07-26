-- Linking the two halves of one movement: an on-chain transfer (eth_activity,
-- 038) and the exchange's own record of it (exchange_records, 037/040).
--
-- "Sent 1.4 ETH to Coinbase" and "Coinbase received 1.4 ETH" are ONE event seen
-- twice. Until now they were two unrelated rows in two unrelated feeds, so the
-- money looked like it left and then arrived from nowhere. This table is the
-- statement that they are the same money.
--
-- DERIVED WHOLESALE, exactly like eth_activity itself: the matching pass runs
-- inside the activity rebuild, deletes every match it owns and re-derives them.
-- That is why activity_id can be a plain surrogate FK here and must NOT be one
-- in the verdict table below -- see there.
--
-- Two shapes live in one table because they are one question ("where did this
-- money go") answered against different evidence:
--   on-chain      activity_id + exchange_record_id
--   exchange pair exchange_record_id + counter_record_id, no on-chain leg at
--                 all -- Coinbase -> Kraken never touches a tracked wallet, so
--                 there is no eth_activity row to point at.
-- Splitting them into two tables would duplicate the verdict table, the reads
-- and the scoping join for a discriminator's worth of difference.
--
-- Re-runs on every boot, so every statement below is idempotent.
CREATE TABLE IF NOT EXISTS exchange_matches (
  id BIGSERIAL PRIMARY KEY,
  -- The exchange side. NOT NULL on both shapes: every match has at least one
  -- exchange record, and for an exchange-to-exchange pair this is always the
  -- WITHDRAWAL leg. Fixing which leg lands here gives the pair ONE identity
  -- instead of two orderings of the same two ids.
  exchange_record_id BIGINT NOT NULL REFERENCES exchange_records(id) ON DELETE CASCADE,
  -- The on-chain side, when there is one. CASCADE is what makes the rebuild
  -- self-cleaning: eth_activity is delete-then-insert, so a wallet's matches
  -- disappear with its activity rows and the pass re-derives them.
  activity_id BIGINT REFERENCES eth_activity(id) ON DELETE CASCADE,
  -- The far exchange record of an exchange-to-exchange pair (the deposit).
  counter_record_id BIGINT REFERENCES exchange_records(id) ON DELETE CASCADE,
  -- How the two sides were tied together, weakest evidence last:
  --   'tx_hash'        the exchange published the on-chain hash. Identity.
  --   'address_amount' asset + amount + time window, AND the record's stored
  --                    address is one of the two addresses in the transfer.
  --   'amount_window'  asset + amount + time window alone. A heuristic.
  --   'manual'         the user confirmed it; see exchange_match_verdicts.
  match_method VARCHAR(20) NOT NULL,
  confidence VARCHAR(10) NOT NULL DEFAULT 'high',
  matched_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CREATE TABLE IF NOT EXISTS skips its whole body once the table exists, so
-- every constraint that may need widening later lives in a guarded DO block.
-- Guarded on the constraint's DEFINITION, not just its name: a name-only guard
-- is satisfied by the constraint already there, so a later widening would be
-- skipped forever on every deployed database while looking applied on a fresh
-- one. BUMP THE SENTINEL in each LIKE when adding a value.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                 WHERE conrelid = 'exchange_matches'::regclass
                   AND conname = 'exchange_matches_method_check'
                   AND pg_get_constraintdef(oid) LIKE '%manual%') THEN
    ALTER TABLE exchange_matches DROP CONSTRAINT IF EXISTS exchange_matches_method_check;
    ALTER TABLE exchange_matches
      ADD CONSTRAINT exchange_matches_method_check
      CHECK (match_method IN ('tx_hash', 'address_amount', 'amount_window', 'manual'));
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                 WHERE conrelid = 'exchange_matches'::regclass
                   AND conname = 'exchange_matches_confidence_check'
                   AND pg_get_constraintdef(oid) LIKE '%medium%') THEN
    ALTER TABLE exchange_matches DROP CONSTRAINT IF EXISTS exchange_matches_confidence_check;
    ALTER TABLE exchange_matches
      ADD CONSTRAINT exchange_matches_confidence_check
      CHECK (confidence IN ('high', 'medium', 'low'));
  END IF;
END $$;

-- Exactly one shape per row. A match with BOTH an activity and a counter
-- record would be claiming the money moved exchange -> wallet -> exchange in
-- one hop, and a match with NEITHER would be an exchange record linked to
-- nothing -- which is what "unmatched" already means, stored as no row at all.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                 WHERE conrelid = 'exchange_matches'::regclass
                   AND conname = 'exchange_matches_one_shape_check') THEN
    ALTER TABLE exchange_matches
      ADD CONSTRAINT exchange_matches_one_shape_check
      CHECK ((activity_id IS NULL) <> (counter_record_id IS NULL));
  END IF;
END $$;

-- A record cannot be both legs of its own pair.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                 WHERE conrelid = 'exchange_matches'::regclass
                   AND conname = 'exchange_matches_distinct_legs_check') THEN
    ALTER TABLE exchange_matches
      ADD CONSTRAINT exchange_matches_distinct_legs_check
      CHECK (counter_record_id IS NULL OR counter_record_id <> exchange_record_id);
  END IF;
END $$;

-- One movement, one match, from either end. Without these a single on-chain
-- deposit could be tied to three different exchange records -- and the whole
-- point of matching is that the money is counted ONCE.
--
-- These enforce it per COLUMN; the pass also refuses to let a record appear as
-- exchange_record_id here and counter_record_id there, which no index can say.
CREATE UNIQUE INDEX IF NOT EXISTS uq_exchange_matches_record
  ON exchange_matches(exchange_record_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_exchange_matches_activity
  ON exchange_matches(activity_id) WHERE activity_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_exchange_matches_counter
  ON exchange_matches(counter_record_id) WHERE counter_record_id IS NOT NULL;

-- The user's verdict on a match: the half the rebuild must never touch.
--
-- Same argument as eth_activity_overrides (038), and the same shape. A
-- fallback match is a heuristic -- asset, amount and a time window -- so it can
-- be wrong, and being wrong means two unrelated movements are silently reported
-- as one. 'rejected' is how that gets undone permanently; 'confirmed' pins a
-- match the heuristic might stop producing (a re-import that shifts an amount,
-- a widened tolerance) so the user's answer outlives the evidence for it.
--
-- THE ON-CHAIN SIDE IS ADDRESSED BY ITS STABLE IDENTITY, NOT BY
-- eth_activity.id. eth_activity is deleted and re-inserted wholesale on every
-- sync and every label change, so its surrogate ids churn: a verdict stored
-- against id 4171 would, minutes later, be pointing at a different transaction
-- or at nothing. (wallet_id, chain_id, tx_hash) is the key both eth_activity
-- and eth_activity_overrides carry a UNIQUE on, and it survives.
--
-- exchange_record_id, by contrast, IS stable: records are imported, never
-- re-derived, and their id is the same row for as long as the account exists.
CREATE TABLE IF NOT EXISTS exchange_match_verdicts (
  id BIGSERIAL PRIMARY KEY,
  exchange_record_id BIGINT NOT NULL REFERENCES exchange_records(id) ON DELETE CASCADE,
  -- On-chain side (all three together, or none).
  wallet_id INT REFERENCES eth_wallets(id) ON DELETE CASCADE,
  chain_id INT,
  tx_hash VARCHAR(66),
  -- Exchange-to-exchange side.
  counter_record_id BIGINT REFERENCES exchange_records(id) ON DELETE CASCADE,
  verdict VARCHAR(10) NOT NULL,
  note TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                 WHERE conrelid = 'exchange_match_verdicts'::regclass
                   AND conname = 'exchange_match_verdicts_verdict_check'
                   AND pg_get_constraintdef(oid) LIKE '%rejected%') THEN
    ALTER TABLE exchange_match_verdicts DROP CONSTRAINT IF EXISTS exchange_match_verdicts_verdict_check;
    ALTER TABLE exchange_match_verdicts
      ADD CONSTRAINT exchange_match_verdicts_verdict_check
      CHECK (verdict IN ('confirmed', 'rejected'));
  END IF;
END $$;

-- Exactly one side, and the on-chain side all-or-nothing. A verdict carrying a
-- wallet and a chain but no hash names no transaction; one carrying a hash but
-- no wallet names one transaction per wallet the user owns.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                 WHERE conrelid = 'exchange_match_verdicts'::regclass
                   AND conname = 'exchange_match_verdicts_one_shape_check') THEN
    ALTER TABLE exchange_match_verdicts
      ADD CONSTRAINT exchange_match_verdicts_one_shape_check
      CHECK (
        (counter_record_id IS NULL
          AND wallet_id IS NOT NULL AND chain_id IS NOT NULL AND tx_hash IS NOT NULL)
        OR
        (counter_record_id IS NOT NULL
          AND wallet_id IS NULL AND chain_id IS NULL AND tx_hash IS NULL)
      );
  END IF;
END $$;

-- One verdict per pair, so re-answering updates rather than stacking a second
-- opinion. Two partial indexes rather than one over every column: a NULL in a
-- unique key compares as distinct from everything, so a single index would let
-- the same exchange-pair verdict be written any number of times.
CREATE UNIQUE INDEX IF NOT EXISTS uq_exchange_match_verdicts_onchain
  ON exchange_match_verdicts(exchange_record_id, wallet_id, chain_id, tx_hash)
  WHERE counter_record_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_exchange_match_verdicts_pair
  ON exchange_match_verdicts(exchange_record_id, counter_record_id)
  WHERE counter_record_id IS NOT NULL;

-- The fallback pass joins records to activity on asset + amount + time, so the
-- record side needs a time-ordered index that is not account-scoped (037's is).
CREATE INDEX IF NOT EXISTS idx_exchange_records_type_time
  ON exchange_records(record_type, occurred_at)
  WHERE record_type IN ('deposit', 'withdrawal');

-- The activity side of the same join, and the feed's "show me the unmatched
-- exchange flows" filter.
CREATE INDEX IF NOT EXISTS idx_eth_activity_exchange_flows
  ON eth_activity(wallet_id, block_time)
  WHERE category IN ('exchange_deposit', 'exchange_withdrawal');

-- The learning loop's provenance. When a transfer matches an exchange record BY
-- HASH, the counterparty of that transfer is the venue -- proven, not guessed
-- -- so an address nobody has judged yet gets labeled from the match instead of
-- sitting in the triage queue forever. 'auto-match' keeps those rows
-- distinguishable from a person's own verdict ('user'), from the 20
-- hand-verified hot wallets ('builtin', 029) and from the scraped pack
-- ('eth-labels', 036).
--
-- Precedence is untouched, and the writer is the half that enforces it: it
-- inserts ONLY when the address has no label of any kind, user or global. A
-- user's explicit verdict always wins because it is never overwritten, and a
-- builtin's is never outranked because the presence of one stops the write.
--
-- TWO MIGRATIONS OWN THIS ONE CONSTRAINT: 044 widens it for 'builtin-bridge'
-- and this one for 'auto-match'. Each guards on its OWN sentinel, so the two
-- definitions must be the same UNION of every value or they fight: a list here
-- without 'builtin-bridge' fails its own sentinel check after 044 has run,
-- drops 044's constraint, and re-adds a narrower one that 044's already-seeded
-- bridge rows violate -- which took down the SECOND boot of every database
-- (migrations re-run every time) while looking perfectly applied on the first.
-- Add a source in BOTH lists.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                 WHERE conrelid = 'eth_address_labels'::regclass
                   AND conname = 'eth_address_labels_source_check'
                   AND pg_get_constraintdef(oid) LIKE '%auto-match%') THEN
    ALTER TABLE eth_address_labels DROP CONSTRAINT IF EXISTS eth_address_labels_source_check;
    ALTER TABLE eth_address_labels
      ADD CONSTRAINT eth_address_labels_source_check
      CHECK (source IN ('user', 'builtin', 'eth-labels', 'auto-match', 'builtin-bridge'));
  END IF;
END $$;

-- Provenance for eth_address_labels: WHERE a verdict came from and HOW MUCH it
-- is worth. Until now `source` only distinguished 'user' from 'builtin', which
-- was enough while the builtin set was 20 hand-verified hot wallets (029). The
-- bulk pack seeded by 036 is a different animal: ~5k addresses scraped from
-- Etherscan name tags, right often enough to drain the triage queue and wrong
-- often enough that "a builtin said so" must no longer read as "verified".
--
--   source     -- 'user' (typed by a person) | 'builtin' (hand-verified, 029)
--                 | 'eth-labels' (scraped pack, 036). Widened to VARCHAR(40)
--                 so a future pack names itself instead of hiding under
--                 'builtin'.
--   confidence -- 'high' | 'low' | NULL. NULL on user rows: a person's own
--                 verdict has no confidence to report, it simply wins.
--
-- Neither column changes precedence. A user row still shadows any builtin
-- regardless of source, and 'own' still beats 'exchange' -- see
-- EthTransfer.reclassifyCounterparties. confidence is provenance for humans
-- (and for a future "review the low-confidence ones" pass), not a tiebreaker.
--
-- Re-runs every boot, so every statement below converges from any starting
-- state -- including the state this file itself produced on the last boot.

-- 026 created source as VARCHAR(10), which cannot hold 'eth-labels' (10 chars
-- fits, but nothing longer would) -- widen before 036 tries to insert. Guarded
-- on atttypmod (declared length + 4) so a boot on an already-wide column does
-- not take an ACCESS EXCLUSIVE lock for nothing.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_attribute
             WHERE attrelid = 'eth_address_labels'::regclass
               AND attname = 'source'
               AND NOT attisdropped
               AND atttypmod < 44) THEN
    ALTER TABLE eth_address_labels ALTER COLUMN source TYPE VARCHAR(40);
  END IF;
END $$;

UPDATE eth_address_labels SET source = 'user' WHERE source IS NULL;
ALTER TABLE eth_address_labels ALTER COLUMN source SET DEFAULT 'user';
ALTER TABLE eth_address_labels ALTER COLUMN source SET NOT NULL;

-- 026's inline CHECK allows only ('user', 'builtin'), so 036 would abort every
-- boot without this swap. Guarded on the constraint's own definition rather
-- than its mere existence: dropping and re-adding a CHECK over ~5k rows on
-- every boot is a full validation scan for no reason, and a bare
-- "IF NOT EXISTS name" guard would leave a stale two-value CHECK in place
-- forever on any database that already has the constraint.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                 WHERE conrelid = 'eth_address_labels'::regclass
                   AND conname = 'eth_address_labels_source_check'
                   AND pg_get_constraintdef(oid) LIKE '%eth-labels%') THEN
    ALTER TABLE eth_address_labels DROP CONSTRAINT IF EXISTS eth_address_labels_source_check;
    ALTER TABLE eth_address_labels
      ADD CONSTRAINT eth_address_labels_source_check
      CHECK (source IN ('user', 'builtin', 'eth-labels'));
  END IF;
END $$;

ALTER TABLE eth_address_labels ADD COLUMN IF NOT EXISTS confidence VARCHAR(10);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                 WHERE conrelid = 'eth_address_labels'::regclass
                   AND conname = 'eth_address_labels_confidence_check') THEN
    ALTER TABLE eth_address_labels
      ADD CONSTRAINT eth_address_labels_confidence_check
      CHECK (confidence IS NULL OR confidence IN ('high', 'low'));
  END IF;
END $$;

-- Backfill: a global row (user_id IS NULL) is by definition not something a
-- user typed. Scoped to source = 'user' -- the pre-provenance default -- and
-- NOT to "user_id IS NULL" alone, which is the trap this file has to dodge:
-- 036 inserts ~5k rows with user_id NULL and source 'eth-labels', and this
-- file runs BEFORE 036 on every subsequent boot. An unscoped backfill would
-- relabel the whole scraped pack as hand-verified 'builtin' on boot two,
-- permanently erasing the distinction the column was added to record.
UPDATE eth_address_labels SET source = 'builtin'
WHERE user_id IS NULL AND source = 'user';

-- 029's builtins were each checked against their Etherscan tag by hand before
-- being written down; that is exactly the claim 'high' makes. Scoped to
-- confidence IS NULL so it never overwrites a downgrade someone made later.
UPDATE eth_address_labels SET confidence = 'high'
WHERE source = 'builtin' AND confidence IS NULL;

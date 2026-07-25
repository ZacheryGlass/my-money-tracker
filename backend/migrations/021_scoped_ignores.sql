-- The single ignore list hid a merchant from BOTH the Monthly Expenses sync
-- and the Top Merchants ranking. The pages now have independent lists keyed
-- by scope: 'expenses' (skip recurring-charge tracking) and 'merchants'
-- (hide from the spend ranking).
ALTER TABLE ignored_merchants
  ADD COLUMN IF NOT EXISTS scope TEXT NOT NULL DEFAULT 'expenses';

-- Guarded: swap the PK only while it does not yet include scope. Re-runs on a
-- DB where 029 already installed PRIMARY KEY (user_id, merchant_key, scope)
-- must NOT drop-and-revert it (this file re-runs every boot).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.key_column_usage
                 WHERE table_name = 'ignored_merchants'
                   AND constraint_name = 'ignored_merchants_pkey'
                   AND column_name = 'scope') THEN
    ALTER TABLE ignored_merchants DROP CONSTRAINT IF EXISTS ignored_merchants_pkey;
    ALTER TABLE ignored_merchants ADD PRIMARY KEY (merchant_key, scope);
  END IF;
END $$;

-- Every insert names its scope explicitly; a missing scope should fail loudly.
ALTER TABLE ignored_merchants
  ALTER COLUMN scope DROP DEFAULT;

-- The pre-split mirror INSERT (copying expenses-scope ignores into the
-- merchants scope) was removed: every real database migrated past this file
-- long ago, and a fresh database has no rows to mirror. Keeping it would
-- break once 029 adds NOT NULL user_id and retargets the PK.

-- The single ignore list hid a merchant from BOTH the Monthly Expenses sync
-- and the Top Merchants ranking. The pages now have independent lists keyed
-- by scope: 'expenses' (skip recurring-charge tracking) and 'merchants'
-- (hide from the spend ranking).
ALTER TABLE ignored_merchants
  ADD COLUMN IF NOT EXISTS scope TEXT NOT NULL DEFAULT 'expenses';

ALTER TABLE ignored_merchants
  DROP CONSTRAINT IF EXISTS ignored_merchants_pkey;
ALTER TABLE ignored_merchants
  ADD PRIMARY KEY (merchant_key, scope);

-- Every insert names its scope explicitly; a missing scope should fail loudly.
ALTER TABLE ignored_merchants
  ALTER COLUMN scope DROP DEFAULT;

-- Pre-split ignores hid the merchant on both pages; mirror them into the
-- merchants scope so nothing reappears unexpectedly. Each page's panel can
-- then restore its copy independently.
INSERT INTO ignored_merchants (merchant_key, name, last_cost, created_at, scope)
SELECT merchant_key, name, last_cost, created_at, 'merchants'
FROM ignored_merchants
WHERE scope = 'expenses'
ON CONFLICT (merchant_key, scope) DO NOTHING;

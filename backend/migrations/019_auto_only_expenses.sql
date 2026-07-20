-- Monthly Expenses is now fully automatic: every row is a merchant-linked,
-- sync-maintained recurring charge. Manual and budget (category-rollup) rows
-- no longer belong, and the ignored list needs a display snapshot.

-- Snapshot so the Ignored panel can show a friendly name + last amount.
ALTER TABLE ignored_merchants
  ADD COLUMN IF NOT EXISTS name TEXT,
  ADD COLUMN IF NOT EXISTS last_cost NUMERIC(10, 2);

-- Remove manual subscriptions and budget rollups (the only rows with no
-- merchant link). History rows cascade via the existing FK.
DELETE FROM recurring_expenses WHERE merchant_key IS NULL;

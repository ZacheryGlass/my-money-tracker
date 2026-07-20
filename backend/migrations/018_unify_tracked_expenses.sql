-- The bill/subscription split no longer drives anything; tracked vs detected
-- (plus per-row provenance) is the real taxonomy now.
ALTER TABLE recurring_expenses
  DROP COLUMN IF EXISTS type;

-- Merchants the user has untracked. Auto-create skips these so deleting an
-- auto-tracked expense sticks; manually tracking one again removes it.
CREATE TABLE IF NOT EXISTS ignored_merchants (
  merchant_key TEXT PRIMARY KEY,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Link recurring expenses to transaction merchant groups so cost, account,
-- company, cadence, and staleness can be derived instead of hand-entered.
ALTER TABLE recurring_expenses
  ADD COLUMN IF NOT EXISTS merchant_key TEXT,
  ADD COLUMN IF NOT EXISTS account_id INT REFERENCES accounts(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS due_day INT CHECK (due_day BETWEEN 1 AND 31),
  ADD COLUMN IF NOT EXISTS last_charge_date DATE,
  ADD COLUMN IF NOT EXISTS charge_interval_days INT,
  ADD COLUMN IF NOT EXISTS is_auto_tracked BOOLEAN NOT NULL DEFAULT FALSE;

CREATE INDEX IF NOT EXISTS idx_recurring_expenses_merchant_key
  ON recurring_expenses(merchant_key) WHERE merchant_key IS NOT NULL;

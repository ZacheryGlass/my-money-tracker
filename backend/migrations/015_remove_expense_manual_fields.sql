-- Retire manual-entry fields from recurring expenses ahead of transaction-driven automation:
-- autopay is unknowable from manual input, who_uses/notes are free-form context we no longer track.
ALTER TABLE recurring_expenses
  DROP COLUMN IF EXISTS is_autopay,
  DROP COLUMN IF EXISTS who_uses,
  DROP COLUMN IF EXISTS notes;

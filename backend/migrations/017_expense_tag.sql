-- User-supplied label on a recurring expense; the only hand-maintained field
-- left now that everything else derives from transactions. Sync never writes it.
ALTER TABLE recurring_expenses
  ADD COLUMN IF NOT EXISTS tag VARCHAR(100);

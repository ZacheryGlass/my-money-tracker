-- The nightly sync and the restore route both call ExpenseSyncService.run()
-- and can overlap. Each run snapshots the linked keys before inserting, so an
-- overlap could auto-create two rows for the same merchant. Enforce uniqueness
-- at the DB so createAutoTracked's ON CONFLICT can no-op the loser.
DROP INDEX IF EXISTS idx_recurring_expenses_merchant_key;
CREATE UNIQUE INDEX IF NOT EXISTS idx_recurring_expenses_merchant_key
  ON recurring_expenses(merchant_key) WHERE merchant_key IS NOT NULL;

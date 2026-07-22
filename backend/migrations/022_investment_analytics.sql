-- Wiring for the investment analytics tables defined in 013_financial_semantics.sql.
-- Those tables were created but never written to; these two changes are what the
-- new writers need.

-- Cash flows are derived from transactions, so the backfill must be able to
-- re-run without duplicating rows. Partial index because manually entered flows
-- have no originating transaction.
CREATE UNIQUE INDEX IF NOT EXISTS idx_investment_cash_flows_transaction
  ON investment_cash_flows(transaction_id)
  WHERE transaction_id IS NOT NULL;

-- Snapshots stored only USD value, so history could not distinguish a price
-- move from a change in position size. Nullable and forward-only: existing rows
-- keep NULL because the quantities they were computed from are already gone.
ALTER TABLE ticker_snapshots ADD COLUMN IF NOT EXISTS quantity DECIMAL(38, 18);
ALTER TABLE ticker_snapshots ADD COLUMN IF NOT EXISTS price_usd DECIMAL(20, 8);

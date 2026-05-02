-- Composite indexes for snapshot queries that filter by ticker/account and date range.
-- The single-column indexes in 001 cover count(*) scans; these cover the common
-- "give me ticker X over date range Y" access pattern used by history endpoints.
CREATE INDEX IF NOT EXISTS idx_ticker_snapshots_ticker_date
  ON ticker_snapshots(ticker, snapshot_date);

CREATE INDEX IF NOT EXISTS idx_account_snapshots_account_date
  ON account_snapshots(account_id, snapshot_date);

CREATE UNIQUE INDEX IF NOT EXISTS idx_ticker_snapshots_unique
  ON ticker_snapshots(snapshot_date, account_id, ticker);

CREATE UNIQUE INDEX IF NOT EXISTS idx_account_snapshots_unique
  ON account_snapshots(snapshot_date, account_id);

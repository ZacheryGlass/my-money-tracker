-- Fix: the original unique index doesn't handle NULL tickers (NULL != NULL in SQL),
-- so holdings without tickers create duplicate snapshot rows on every run.

-- Clean up existing duplicate NULL-ticker rows first, keeping only the latest (highest id)
DELETE FROM ticker_snapshots a
  USING ticker_snapshots b
  WHERE a.ticker IS NULL
    AND b.ticker IS NULL
    AND a.snapshot_date = b.snapshot_date
    AND a.account_id = b.account_id
    AND a.name = b.name
    AND a.id < b.id;

-- Replace with two indexes: one for non-null tickers, one for null tickers keyed by name.
DROP INDEX IF EXISTS idx_ticker_snapshots_unique;

CREATE UNIQUE INDEX IF NOT EXISTS idx_ticker_snapshots_unique
  ON ticker_snapshots(snapshot_date, account_id, ticker)
  WHERE ticker IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_ticker_snapshots_null_ticker_unique
  ON ticker_snapshots(snapshot_date, account_id, name)
  WHERE ticker IS NULL;

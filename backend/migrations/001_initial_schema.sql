-- Create accounts table
CREATE TABLE IF NOT EXISTS accounts (
  id SERIAL PRIMARY KEY,
  name VARCHAR(100) NOT NULL UNIQUE,
  type VARCHAR(50) NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Create users table for authentication
CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  username VARCHAR(100) NOT NULL UNIQUE,
  password_hash VARCHAR(255) NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Create holdings table
CREATE TABLE IF NOT EXISTS holdings (
  id SERIAL PRIMARY KEY,
  account_id INT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  ticker VARCHAR(20),
  name VARCHAR(200) NOT NULL,
  quantity DECIMAL(20, 8),
  manual_value DECIMAL(15, 2),
  category VARCHAR(50),
  notes TEXT,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(account_id, ticker, name)
);

-- Create price cache table
CREATE TABLE IF NOT EXISTS price_cache (
  ticker VARCHAR(20) PRIMARY KEY,
  price_usd DECIMAL(15, 6) NOT NULL,
  source VARCHAR(50),
  fetched_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Create ticker snapshots table
CREATE TABLE IF NOT EXISTS ticker_snapshots (
  id SERIAL PRIMARY KEY,
  snapshot_date DATE NOT NULL,
  account_id INT REFERENCES accounts(id) ON DELETE CASCADE,
  ticker VARCHAR(20),
  name VARCHAR(200),
  value DECIMAL(15, 2),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Create index on ticker snapshots for efficient queries
CREATE INDEX IF NOT EXISTS idx_ticker_snapshots_date ON ticker_snapshots(snapshot_date);
CREATE INDEX IF NOT EXISTS idx_ticker_snapshots_ticker ON ticker_snapshots(ticker);
CREATE INDEX IF NOT EXISTS idx_ticker_snapshots_account ON ticker_snapshots(account_id);

-- Create account snapshots table
CREATE TABLE IF NOT EXISTS account_snapshots (
  id SERIAL PRIMARY KEY,
  snapshot_date DATE NOT NULL,
  account_id INT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  total_value DECIMAL(15, 2),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Create index on account snapshots for efficient queries
CREATE INDEX IF NOT EXISTS idx_account_snapshots_date ON account_snapshots(snapshot_date);
CREATE INDEX IF NOT EXISTS idx_account_snapshots_account ON account_snapshots(account_id);

-- Seed initial accounts
INSERT INTO accounts (name, type) VALUES
  ('Crypto', 'investment'),
  ('HSA', 'investment'),
  ('Taxable', 'investment'),
  ('401k', 'investment'),
  ('Roth IRA', 'investment'),
  ('Real Estate', 'static'),
  ('Liability', 'static')
ON CONFLICT (name) DO NOTHING;

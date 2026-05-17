-- Transactions table for Plaid transaction data
CREATE TABLE IF NOT EXISTS transactions (
  id SERIAL PRIMARY KEY,
  account_id INT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  plaid_transaction_id VARCHAR(100) UNIQUE,
  date DATE NOT NULL,
  name VARCHAR(500) NOT NULL,
  merchant_name VARCHAR(500),
  amount DECIMAL(15,2) NOT NULL,
  currency_code VARCHAR(10) DEFAULT 'USD',
  category VARCHAR(200),
  pending BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_transactions_account_id ON transactions(account_id);
CREATE INDEX IF NOT EXISTS idx_transactions_date ON transactions(date);
CREATE INDEX IF NOT EXISTS idx_transactions_account_date ON transactions(account_id, date);

-- Cursor for incremental Plaid transaction sync
ALTER TABLE plaid_items ADD COLUMN IF NOT EXISTS transactions_cursor TEXT DEFAULT '';

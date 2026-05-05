CREATE TABLE IF NOT EXISTS plaid_items (
  id SERIAL PRIMARY KEY,
  item_id VARCHAR(100) NOT NULL UNIQUE,
  access_token TEXT NOT NULL,
  institution_id VARCHAR(50),
  institution_name VARCHAR(200),
  consent_expiration TIMESTAMP,
  error_code VARCHAR(100),
  error_message TEXT,
  last_synced_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

ALTER TABLE accounts ADD COLUMN IF NOT EXISTS plaid_item_id INT REFERENCES plaid_items(id) ON DELETE SET NULL;
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS plaid_account_id VARCHAR(100);
CREATE INDEX IF NOT EXISTS idx_accounts_plaid_item ON accounts(plaid_item_id) WHERE plaid_item_id IS NOT NULL;

ALTER TABLE holdings ADD COLUMN IF NOT EXISTS is_plaid_managed BOOLEAN DEFAULT FALSE;

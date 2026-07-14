-- Semantic data required for reproducible agent-facing financial analysis.

CREATE TABLE IF NOT EXISTS transaction_classifications (
  transaction_id INT PRIMARY KEY REFERENCES transactions(id) ON DELETE CASCADE,
  direction VARCHAR(30) CHECK (direction IN (
    'income', 'spending', 'internal_transfer', 'investment_contribution',
    'investment_withdrawal', 'refund', 'reimbursement', 'dividend',
    'interest', 'fee', 'debt_payment', 'other'
  )),
  normalized_category VARCHAR(200),
  is_internal_transfer BOOLEAN NOT NULL DEFAULT FALSE,
  is_refund BOOLEAN NOT NULL DEFAULT FALSE,
  is_reimbursement BOOLEAN NOT NULL DEFAULT FALSE,
  is_essential BOOLEAN,
  is_one_time BOOLEAN NOT NULL DEFAULT FALSE,
  confidence DECIMAL(5, 4),
  notes TEXT,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_transaction_classifications_direction
  ON transaction_classifications(direction);

CREATE TABLE IF NOT EXISTS investment_cash_flows (
  id SERIAL PRIMARY KEY,
  account_id INT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  flow_date DATE NOT NULL,
  amount DECIMAL(15, 2) NOT NULL,
  flow_type VARCHAR(30) NOT NULL CHECK (flow_type IN (
    'contribution', 'withdrawal', 'transfer_in', 'transfer_out',
    'dividend', 'interest', 'fee', 'tax', 'other'
  )),
  is_external BOOLEAN NOT NULL DEFAULT TRUE,
  transaction_id INT REFERENCES transactions(id) ON DELETE SET NULL,
  notes TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_investment_cash_flows_account_date
  ON investment_cash_flows(account_id, flow_date);

CREATE TABLE IF NOT EXISTS benchmark_prices (
  symbol VARCHAR(40) NOT NULL,
  price_date DATE NOT NULL,
  adjusted_close DECIMAL(20, 8) NOT NULL,
  total_return_index DECIMAL(20, 8),
  source VARCHAR(100),
  fetched_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (symbol, price_date)
);

CREATE INDEX IF NOT EXISTS idx_benchmark_prices_date
  ON benchmark_prices(price_date);

CREATE TABLE IF NOT EXISTS security_master (
  symbol VARCHAR(40) PRIMARY KEY,
  name VARCHAR(200),
  security_type VARCHAR(40),
  asset_class VARCHAR(80),
  benchmark_symbol VARCHAR(40),
  is_liquid BOOLEAN,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS trades (
  id SERIAL PRIMARY KEY,
  account_id INT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  holding_id INT REFERENCES holdings(id) ON DELETE SET NULL,
  trade_date DATE NOT NULL,
  symbol VARCHAR(40) NOT NULL,
  side VARCHAR(10) NOT NULL CHECK (side IN ('buy', 'sell')),
  quantity DECIMAL(20, 8) NOT NULL CHECK (quantity > 0),
  price DECIMAL(20, 8) NOT NULL CHECK (price >= 0),
  fees DECIMAL(15, 2) NOT NULL DEFAULT 0,
  external_id VARCHAR(200) UNIQUE,
  notes TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_trades_account_symbol_date
  ON trades(account_id, symbol, trade_date);

CREATE TABLE IF NOT EXISTS tax_lots (
  id SERIAL PRIMARY KEY,
  account_id INT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  symbol VARCHAR(40) NOT NULL,
  acquired_date DATE NOT NULL,
  quantity DECIMAL(20, 8) NOT NULL CHECK (quantity > 0),
  remaining_quantity DECIMAL(20, 8) NOT NULL CHECK (remaining_quantity >= 0),
  cost_basis DECIMAL(15, 2) NOT NULL CHECK (cost_basis >= 0),
  source_trade_id INT REFERENCES trades(id) ON DELETE SET NULL,
  notes TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_tax_lots_account_symbol
  ON tax_lots(account_id, symbol, acquired_date);

CREATE TABLE IF NOT EXISTS debt_terms (
  account_id INT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  apr DECIMAL(8, 5) CHECK (apr >= 0),
  minimum_payment DECIMAL(15, 2) CHECK (minimum_payment >= 0),
  due_day SMALLINT CHECK (due_day BETWEEN 1 AND 31),
  maturity_date DATE,
  is_tax_deductible BOOLEAN NOT NULL DEFAULT FALSE,
  notes TEXT,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS recurring_expense_history (
  id SERIAL PRIMARY KEY,
  recurring_expense_id INT NOT NULL REFERENCES recurring_expenses(id) ON DELETE CASCADE,
  effective_date DATE NOT NULL,
  cost DECIMAL(10, 2) NOT NULL CHECK (cost >= 0),
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (recurring_expense_id, effective_date)
);

CREATE INDEX IF NOT EXISTS idx_recurring_expense_history_date
  ON recurring_expense_history(effective_date);

-- Preserve current recurring costs as the initial known history without
-- overwriting explicitly imported history.
INSERT INTO recurring_expense_history (recurring_expense_id, effective_date, cost)
SELECT id, COALESCE(created_at::date, CURRENT_DATE), cost
FROM recurring_expenses
ON CONFLICT (recurring_expense_id, effective_date) DO NOTHING;

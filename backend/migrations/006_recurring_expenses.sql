CREATE TABLE IF NOT EXISTS recurring_expenses (
  id SERIAL PRIMARY KEY,
  type VARCHAR(20) NOT NULL CHECK (type IN ('bill', 'subscription')),
  name VARCHAR(200) NOT NULL,
  cost DECIMAL(10, 2) NOT NULL,
  is_fixed_rate BOOLEAN DEFAULT true,
  is_autopay BOOLEAN DEFAULT false,
  pay_account VARCHAR(100),
  company VARCHAR(200),
  who_uses VARCHAR(100),
  notes TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

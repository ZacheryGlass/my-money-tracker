CREATE TABLE IF NOT EXISTS salary_history (
  id SERIAL PRIMARY KEY,
  effective_date DATE NOT NULL,
  title VARCHAR(200) NOT NULL,
  salary_amount DECIMAL(12, 2) NOT NULL,
  psu DECIMAL(12, 2) DEFAULT 0,
  rsu DECIMAL(12, 2) DEFAULT 0,
  total_comp DECIMAL(12, 2) NOT NULL,
  change_amount DECIMAL(12, 2),
  change_percent DECIMAL(8, 5),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(effective_date)
);

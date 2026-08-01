-- Links an exchange fiat rail event to the bank transaction Plaid reported.
-- It is derived and rebuilt, like exchange_matches; no provider secret or raw
-- bank payload is copied into this table.
CREATE TABLE IF NOT EXISTS exchange_fiat_matches (
  id BIGSERIAL PRIMARY KEY,
  exchange_record_id BIGINT NOT NULL REFERENCES exchange_records(id) ON DELETE CASCADE,
  transaction_id INT NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
  match_method VARCHAR(30) NOT NULL DEFAULT 'amount_date_name',
  amount NUMERIC(38,18) NOT NULL,
  day_delta INT NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (exchange_record_id),
  UNIQUE (transaction_id)
);

CREATE INDEX IF NOT EXISTS idx_exchange_fiat_matches_transaction
  ON exchange_fiat_matches(transaction_id);

-- Binance.US capital history that resembles an existing CSV record (same
-- type, asset and amount within a day, ids differ) blocks its whole batch
-- until a person decides. The incoming row is not stored anywhere else, so
-- the pair and the incoming record persist here until that decision:
-- 'confirmed' writes a dedupe event (later replays are plain duplicates),
-- 'rejected' lets the incoming record import as its own event.
CREATE TABLE IF NOT EXISTS exchange_overlap_reviews (
  id BIGSERIAL PRIMARY KEY,
  exchange_account_id INT NOT NULL REFERENCES exchange_accounts(id) ON DELETE CASCADE,
  record_id BIGINT NOT NULL REFERENCES exchange_records(id) ON DELETE CASCADE,
  incoming_external_id VARCHAR(120) NOT NULL,
  incoming_record JSONB NOT NULL,
  status VARCHAR(12) NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'confirmed', 'rejected')),
  reviewer_id INT REFERENCES users(id) ON DELETE SET NULL,
  reviewed_at TIMESTAMP,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (exchange_account_id, record_id, incoming_external_id)
);

CREATE INDEX IF NOT EXISTS idx_exchange_overlap_reviews_pending
  ON exchange_overlap_reviews(exchange_account_id) WHERE status = 'pending';

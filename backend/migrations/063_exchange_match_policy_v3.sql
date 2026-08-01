-- Exchange matching policy v3.
--
-- A suggestion is deliberately not an exchange_match: only the latter folds
-- two ledger rows into one. Amount + time evidence and ambiguous alternatives
-- live here until the user confirms or rejects one. The table is derived
-- wholesale on every matching pass; durable answers remain in
-- exchange_match_verdicts.

-- Keep historical v1/v2 heuristic rows readable until the startup rebuild can
-- record their invalidations. From v3 onward, however, the database itself
-- refuses to let a heuristic become an active ledger fold.
ALTER TABLE exchange_matches
  ALTER COLUMN rule_version SET DEFAULT 'v3';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                 WHERE conrelid = 'exchange_matches'::regclass
                   AND conname = 'exchange_matches_v3_automatic_method_check') THEN
    ALTER TABLE exchange_matches
      ADD CONSTRAINT exchange_matches_v3_automatic_method_check
      CHECK (rule_version <> 'v3' OR match_method IN ('tx_hash', 'manual'));
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS exchange_match_suggestions (
  id BIGSERIAL PRIMARY KEY,
  exchange_record_id BIGINT NOT NULL REFERENCES exchange_records(id) ON DELETE CASCADE,
  activity_id BIGINT REFERENCES eth_activity(id) ON DELETE CASCADE,
  counter_record_id BIGINT REFERENCES exchange_records(id) ON DELETE CASCADE,
  wallet_id INT REFERENCES eth_wallets(id) ON DELETE CASCADE,
  chain_id INT,
  tx_hash VARCHAR(66),
  match_method VARCHAR(20) NOT NULL,
  confidence VARCHAR(10) NOT NULL,
  suggestion_reason VARCHAR(30) NOT NULL,
  rule_version VARCHAR(20) NOT NULL DEFAULT 'v3',
  comparison_kind VARCHAR(20),
  comparison_left_amount NUMERIC(38, 18),
  comparison_right_amount NUMERIC(38, 18),
  fee_amount_applied NUMERIC(38, 18),
  amount_delta NUMERIC(38, 18),
  amount_tolerance NUMERIC(38, 18),
  magnitude_ratio NUMERIC(38, 18),
  address_match BOOLEAN,
  time_delta_seconds BIGINT,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT exchange_match_suggestions_shape_check
    CHECK ((activity_id IS NOT NULL AND counter_record_id IS NULL
            AND wallet_id IS NOT NULL AND chain_id IS NOT NULL AND tx_hash IS NOT NULL)
        OR (activity_id IS NULL AND counter_record_id IS NOT NULL
            AND wallet_id IS NULL AND chain_id IS NULL AND tx_hash IS NULL)),
  CONSTRAINT exchange_match_suggestions_method_check
    CHECK (match_method IN ('tx_hash', 'address_amount', 'amount_window')),
  CONSTRAINT exchange_match_suggestions_confidence_check
    CHECK (confidence IN ('high', 'medium', 'low')),
  CONSTRAINT exchange_match_suggestions_reason_check
    CHECK (suggestion_reason IN ('ambiguous', 'address_amount', 'amount_time_only')),
  CONSTRAINT exchange_match_suggestions_comparison_check
    CHECK (comparison_kind IS NULL OR comparison_kind IN ('hash', 'amount')),
  CONSTRAINT exchange_match_suggestions_distinct_records_check
    CHECK (counter_record_id IS NULL OR counter_record_id <> exchange_record_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_exchange_match_suggestions_onchain
  ON exchange_match_suggestions(exchange_record_id, wallet_id, chain_id, tx_hash)
  WHERE counter_record_id IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_exchange_match_suggestions_pair
  ON exchange_match_suggestions(exchange_record_id, counter_record_id)
  WHERE counter_record_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_exchange_match_suggestions_activity
  ON exchange_match_suggestions(activity_id)
  WHERE activity_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_exchange_match_suggestions_record
  ON exchange_match_suggestions(exchange_record_id);

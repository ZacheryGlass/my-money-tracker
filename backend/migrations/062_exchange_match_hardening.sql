-- Exchange-match hardening (#83).
--
-- The matcher is still derived wholesale, but every selected heuristic now
-- carries the exact comparison that won.  Invalidated derived rows are kept in
-- an append-only event table so a rule change never makes a false positive
-- disappear without an explanation.

ALTER TABLE exchange_matches
  ADD COLUMN IF NOT EXISTS rule_version VARCHAR(20) NOT NULL DEFAULT 'v2',
  ADD COLUMN IF NOT EXISTS comparison_kind VARCHAR(20),
  ADD COLUMN IF NOT EXISTS comparison_left_amount NUMERIC(38, 18),
  ADD COLUMN IF NOT EXISTS comparison_right_amount NUMERIC(38, 18),
  ADD COLUMN IF NOT EXISTS fee_amount_applied NUMERIC(38, 18),
  ADD COLUMN IF NOT EXISTS amount_delta NUMERIC(38, 18),
  ADD COLUMN IF NOT EXISTS amount_tolerance NUMERIC(38, 18),
  ADD COLUMN IF NOT EXISTS magnitude_ratio NUMERIC(38, 18),
  ADD COLUMN IF NOT EXISTS address_match BOOLEAN,
  ADD COLUMN IF NOT EXISTS time_delta_seconds BIGINT;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                 WHERE conrelid = 'exchange_matches'::regclass
                   AND conname = 'exchange_matches_comparison_kind_check') THEN
    ALTER TABLE exchange_matches
      ADD CONSTRAINT exchange_matches_comparison_kind_check
      CHECK (comparison_kind IS NULL OR comparison_kind IN ('hash', 'amount', 'manual'));
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS exchange_match_events (
  id BIGSERIAL PRIMARY KEY,
  event_key TEXT NOT NULL,
  event_type VARCHAR(30) NOT NULL,
  exchange_record_id BIGINT NOT NULL REFERENCES exchange_records(id) ON DELETE CASCADE,
  counter_record_id BIGINT REFERENCES exchange_records(id) ON DELETE CASCADE,
  wallet_id INT REFERENCES eth_wallets(id) ON DELETE CASCADE,
  chain_id INT,
  tx_hash VARCHAR(66),
  prior_match_method VARCHAR(20) NOT NULL,
  prior_confidence VARCHAR(10) NOT NULL,
  reason TEXT NOT NULL,
  rule_version VARCHAR(20) NOT NULL,
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
  CONSTRAINT exchange_match_events_type_check
    CHECK (event_type IN ('derived_invalidated')),
  CONSTRAINT exchange_match_events_shape_check
    CHECK ((counter_record_id IS NULL AND wallet_id IS NOT NULL AND chain_id IS NOT NULL AND tx_hash IS NOT NULL)
        OR (counter_record_id IS NOT NULL AND wallet_id IS NULL AND chain_id IS NULL AND tx_hash IS NULL))
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_exchange_match_events_key
  ON exchange_match_events(event_key);

CREATE INDEX IF NOT EXISTS idx_exchange_match_events_record
  ON exchange_match_events(exchange_record_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_exchange_match_events_wallet
  ON exchange_match_events(wallet_id, chain_id, tx_hash, created_at DESC)
  WHERE wallet_id IS NOT NULL;

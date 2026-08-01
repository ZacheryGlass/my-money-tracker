-- Cross-source exchange-event fingerprints.
--
-- external_id remains the exact provider/source replay key. A fingerprint is
-- deliberately non-unique: equal economic fields can describe two genuine
-- events, so candidate groups must be resolved conservatively by the importer.
ALTER TABLE exchange_records
  ADD COLUMN IF NOT EXISTS fingerprint VARCHAR(64),
  ADD COLUMN IF NOT EXISTS fingerprint_version SMALLINT,
  ADD COLUMN IF NOT EXISTS dedupe_provenance JSONB,
  ADD COLUMN IF NOT EXISTS duplicate_candidate BOOLEAN NOT NULL DEFAULT FALSE;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                 WHERE conrelid = 'exchange_records'::regclass
                   AND conname = 'exchange_records_fingerprint_version_check') THEN
    ALTER TABLE exchange_records
      ADD CONSTRAINT exchange_records_fingerprint_version_check
      CHECK (fingerprint IS NULL OR fingerprint_version IS NOT NULL);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_exchange_records_account_fingerprint
  ON exchange_records(exchange_account_id, fingerprint)
  WHERE fingerprint IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_exchange_records_duplicate_candidate
  ON exchange_records(exchange_account_id)
  WHERE duplicate_candidate;

-- Records which were accepted as the same event during a new import. The
-- incoming row is not stored as a second economic record, so this audit keeps
-- its provider id/source/raw payload discoverable without making the
-- fingerprint a uniqueness constraint.
CREATE TABLE IF NOT EXISTS exchange_record_dedupe_events (
  id BIGSERIAL PRIMARY KEY,
  exchange_account_id INT NOT NULL REFERENCES exchange_accounts(id) ON DELETE CASCADE,
  survivor_record_id BIGINT NOT NULL REFERENCES exchange_records(id) ON DELETE CASCADE,
  incoming_external_id VARCHAR(120) NOT NULL,
  incoming_source VARCHAR(10),
  fingerprint VARCHAR(64) NOT NULL,
  fingerprint_version SMALLINT NOT NULL,
  incoming_snapshot JSONB NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_exchange_record_dedupe_events_survivor
  ON exchange_record_dedupe_events(survivor_record_id);

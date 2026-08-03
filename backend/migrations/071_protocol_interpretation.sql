-- Evidence-backed protocol explanations derived from normalized transfer
-- events plus a source-bearing counterparty label.  This is derived data: a
-- wallet rebuild replaces it, while notes and user verdicts remain in their
-- existing durable tables.
--
-- The object is deliberately separate from category/review fields.  A protocol
-- explanation can say "the stored events prove a router-shaped swap" without
-- asserting ownership, personal intent, or that unsupported calldata/event
-- history is complete.
ALTER TABLE eth_activity
  ADD COLUMN IF NOT EXISTS protocol_interpretation JSONB;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'eth_activity'::regclass
       AND conname = 'eth_activity_protocol_interpretation_object_check'
  ) THEN
    ALTER TABLE eth_activity
      ADD CONSTRAINT eth_activity_protocol_interpretation_object_check
      CHECK (protocol_interpretation IS NULL
             OR jsonb_typeof(protocol_interpretation) = 'object');
  END IF;
END $$;

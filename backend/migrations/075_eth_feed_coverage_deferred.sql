-- Provider throttling is a temporary pause, not a failed source read. Keep the
-- last proven coverage boundary while recording when the provider said work may
-- resume. The next manual or scheduled sync always retries these rows.
ALTER TABLE eth_feed_coverage
  ADD COLUMN IF NOT EXISTS retry_after_at TIMESTAMPTZ;

-- Migrations are re-run on every boot. Guard on the definition so an existing
-- pre-075 status constraint is widened exactly once on deployed databases.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conrelid = 'eth_feed_coverage'::regclass
       AND conname = 'eth_feed_coverage_status_check'
       AND pg_get_constraintdef(oid) LIKE '%deferred%'
  ) THEN
    ALTER TABLE eth_feed_coverage
      DROP CONSTRAINT IF EXISTS eth_feed_coverage_status_check;
    ALTER TABLE eth_feed_coverage
      ADD CONSTRAINT eth_feed_coverage_status_check
      CHECK (status IN (
        'complete', 'failed', 'deferred', 'unsupported',
        'not_applicable', 'unverified'
      ));
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conrelid = 'eth_feed_coverage'::regclass
       AND conname = 'eth_feed_coverage_deferred_retry_check'
  ) THEN
    ALTER TABLE eth_feed_coverage
      ADD CONSTRAINT eth_feed_coverage_deferred_retry_check
      CHECK (
        status <> 'deferred'
        OR (error_message IS NOT NULL AND retry_after_at IS NOT NULL)
      );
  END IF;
END $$;

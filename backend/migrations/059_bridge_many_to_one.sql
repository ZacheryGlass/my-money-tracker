-- Allow one destination bridge transaction to settle a bundle assembled from
-- multiple source transactions. The source leg remains unique, while the
-- destination may be referenced once per conserved asset/source component.
-- Matching is still derived and rebuilt wholesale; a duplicate source is a
-- hard database error rather than something to silently overwrite.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'eth_activity_links'::regclass
      AND conname = 'eth_activity_links_in_unique'
  ) THEN
    ALTER TABLE eth_activity_links DROP CONSTRAINT eth_activity_links_in_unique;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_eth_activity_links_in_activity
  ON eth_activity_links(in_activity_id, id);

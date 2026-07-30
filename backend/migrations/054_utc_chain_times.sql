-- 054: make on-chain event timestamps timezone-safe.
--
-- Etherscan and every supported chain source report Unix timestamps. The
-- importer turns those into JavaScript Dates, but the original columns were
-- TIMESTAMP WITHOUT TIME ZONE. PostgreSQL interprets a timestamp-with-offset
-- write into that type in the SESSION timezone, so a developer running outside
-- UTC can store a shifted wall clock even though production's UTC host appears
-- correct. Cross-source ordering and dated valuation must not depend on the
-- database host timezone.
--
-- Existing values were intended and read as UTC (database.js' OID 1114 parser
-- appends Z), so the conversion explicitly interprets the stored wall clock as
-- UTC. Each ALTER is catalog-guarded because migrations re-run on every boot:
-- applying AT TIME ZONE to an already-TIMESTAMPTZ column would change type
-- semantics and could shift data on the second run.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM information_schema.columns
     WHERE table_schema = current_schema()
       AND table_name = 'eth_transfers'
       AND column_name = 'block_time'
       AND data_type = 'timestamp without time zone'
  ) THEN
    ALTER TABLE eth_transfers
      ALTER COLUMN block_time TYPE TIMESTAMPTZ
      USING block_time AT TIME ZONE 'UTC';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM information_schema.columns
     WHERE table_schema = current_schema()
       AND table_name = 'eth_activity'
       AND column_name = 'block_time'
       AND data_type = 'timestamp without time zone'
  ) THEN
    ALTER TABLE eth_activity
      ALTER COLUMN block_time TYPE TIMESTAMPTZ
      USING block_time AT TIME ZONE 'UTC';
  END IF;
END $$;

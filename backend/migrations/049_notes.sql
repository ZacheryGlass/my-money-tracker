-- 049: durable, classification-neutral notes for addresses and transactions.
--
-- eth_address_labels.note is provenance for a LABEL. It cannot safely hold a
-- note about an address whose verdict is still unknown, because creating any
-- label row removes that address from the review queue. Keep the user's prose
-- separate so "likely my cold wallet; confirm on device" remains visible
-- without silently voting `own`.
CREATE TABLE IF NOT EXISTS eth_address_notes (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  address VARCHAR(42) NOT NULL CHECK (address = LOWER(address)),
  note TEXT NOT NULL CHECK (LENGTH(BTRIM(note)) > 0),
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_eth_address_notes_user_address
  ON eth_address_notes(user_id, address);

-- A transaction note is also not necessarily a category verdict. Migration
-- 045 deliberately rejected empty override rows; widen that invariant so a
-- note-only row is valid while a truly empty row is still impossible.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                 WHERE conrelid = 'eth_activity_overrides'::regclass
                   AND conname = 'eth_activity_overrides_not_empty'
                   AND pg_get_constraintdef(oid) LIKE '%note%') THEN
    ALTER TABLE eth_activity_overrides DROP CONSTRAINT IF EXISTS eth_activity_overrides_not_empty;
    ALTER TABLE eth_activity_overrides
      ADD CONSTRAINT eth_activity_overrides_not_empty
      CHECK (category IS NOT NULL OR spam IS NOT NULL OR note IS NOT NULL);
  END IF;
END $$;

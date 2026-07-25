-- Auto-provisioning stores the verified sign-in email as users.username, but
-- the column was VARCHAR(100) while user_identities.email allows 320. An
-- allowlisted address longer than 100 characters therefore failed the INSERT
-- with 22001, which requireUser reports as a 503 identity lookup failure --
-- on every request, so that person could never sign in. Widen to match the
-- email column rather than truncating, which could collide two addresses onto
-- one username and link the wrong identity.
--
-- Guarded so the ALTER does not re-run on every boot. atttypmod for
-- VARCHAR(n) is n + 4, so VARCHAR(320) reads as 324.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_attribute
             WHERE attrelid = 'users'::regclass
               AND attname = 'username'
               AND NOT attisdropped
               AND atttypmod < 324) THEN
    ALTER TABLE users ALTER COLUMN username TYPE VARCHAR(320);
  END IF;
END $$;

-- Single hard-coded admin: user 1. There is deliberately no UI or API to
-- grant admin; the flag exists so the check is data-driven rather than a
-- magic id scattered through code. Re-runs every boot (idempotent).
ALTER TABLE users ADD COLUMN IF NOT EXISTS is_admin BOOLEAN NOT NULL DEFAULT FALSE;
UPDATE users SET is_admin = TRUE WHERE id = 1 AND is_admin = FALSE;

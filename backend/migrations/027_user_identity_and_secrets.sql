-- Multi-user identity and encrypted secret storage.
-- Re-runs every boot: everything here must stay idempotent.

ALTER TABLE users ADD COLUMN IF NOT EXISTS display_name VARCHAR(200);
-- Password login was removed long ago; the column stays for now but must not
-- block auto-provisioned rows.
ALTER TABLE users ALTER COLUMN password_hash DROP NOT NULL;

-- Stable owner row on fresh databases (previously seeded by a standalone
-- password-auth seed script, since deleted).
INSERT INTO users (id, username, display_name) VALUES (1, 'zachery', 'Zachery')
ON CONFLICT (id) DO NOTHING;
SELECT setval('users_id_seq', GREATEST((SELECT COALESCE(MAX(id), 1) FROM users), 1));

-- Maps sign-in emails to users. One person can have several emails; the two
-- seeded rows below are the same person (both are in ALLOWED_PRINCIPALS) and
-- must never be split into separate users by auto-provisioning.
CREATE TABLE IF NOT EXISTS user_identities (
  email VARCHAR(320) PRIMARY KEY CHECK (email = LOWER(email)),
  user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
INSERT INTO user_identities (email, user_id) VALUES
  ('zacheryeglass@gmail.com', 1),
  ('zacheryglass@pm.me', 1)
ON CONFLICT (email) DO NOTHING;

-- Per-user API credentials, AES-256-GCM encrypted with SECRETS_ENCRYPTION_KEY.
-- last4 exists so the UI can mask without decrypting (and survives key loss).
CREATE TABLE IF NOT EXISTS user_api_keys (
  user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  service TEXT NOT NULL CHECK (service IN ('plaid_client_id', 'plaid_secret', 'etherscan')),
  encrypted_value TEXT NOT NULL,
  last4 VARCHAR(4) NOT NULL,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (user_id, service)
);

-- App-wide shared settings (market-data keys; prices are global).
CREATE TABLE IF NOT EXISTS app_settings (
  key TEXT PRIMARY KEY CHECK (key IN ('cg_api_key', 'cmc_api_key')),
  encrypted_value TEXT NOT NULL,
  last4 VARCHAR(4) NOT NULL,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

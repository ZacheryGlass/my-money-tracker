-- Enforces per-user ownership added (nullable) in 028: NOT NULL on the roots,
-- global uniqueness swapped for per-user uniqueness, and the seeds that used
-- to live in 001/026 relocated here where the new constraints exist.
--
-- Re-runs every boot. Constraint/PK swaps are guarded on catalog state so a
-- re-run is a true no-op (never drop-and-readd each boot: that would rebuild
-- indexes on every deploy and race concurrent boots).

-- 1. Backfill then lock down. SET NOT NULL re-runs are cheap no-op validations.
UPDATE accounts           SET user_id = 1 WHERE user_id IS NULL;
UPDATE plaid_items        SET user_id = 1 WHERE user_id IS NULL;
UPDATE eth_wallets        SET user_id = 1 WHERE user_id IS NULL;
UPDATE salary_history     SET user_id = 1 WHERE user_id IS NULL;
UPDATE recurring_expenses SET user_id = 1 WHERE user_id IS NULL;
UPDATE ignored_merchants  SET user_id = 1 WHERE user_id IS NULL;
UPDATE eth_ignored_tokens SET user_id = 1 WHERE user_id IS NULL;
UPDATE eth_address_labels SET user_id = 1 WHERE user_id IS NULL AND source = 'user';

ALTER TABLE accounts           ALTER COLUMN user_id SET NOT NULL;
ALTER TABLE plaid_items        ALTER COLUMN user_id SET NOT NULL;
ALTER TABLE eth_wallets        ALTER COLUMN user_id SET NOT NULL;
ALTER TABLE salary_history     ALTER COLUMN user_id SET NOT NULL;
ALTER TABLE recurring_expenses ALTER COLUMN user_id SET NOT NULL;
ALTER TABLE ignored_merchants  ALTER COLUMN user_id SET NOT NULL;
ALTER TABLE eth_ignored_tokens ALTER COLUMN user_id SET NOT NULL;
-- eth_address_labels.user_id stays NULLABLE: NULL marks a builtin/global row.

-- 2. Unique swaps: global -> (user_id, ...).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                 WHERE conrelid = 'accounts'::regclass
                   AND conname = 'accounts_user_id_name_key') THEN
    ALTER TABLE accounts DROP CONSTRAINT IF EXISTS accounts_name_key;
    ALTER TABLE accounts ADD CONSTRAINT accounts_user_id_name_key UNIQUE (user_id, name);
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                 WHERE conrelid = 'eth_wallets'::regclass
                   AND conname = 'eth_wallets_user_id_address_key') THEN
    ALTER TABLE eth_wallets DROP CONSTRAINT IF EXISTS eth_wallets_address_key;
    ALTER TABLE eth_wallets ADD CONSTRAINT eth_wallets_user_id_address_key UNIQUE (user_id, address);
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                 WHERE conrelid = 'salary_history'::regclass
                   AND conname = 'salary_history_user_id_effective_date_key') THEN
    ALTER TABLE salary_history DROP CONSTRAINT IF EXISTS salary_history_effective_date_key;
    ALTER TABLE salary_history ADD CONSTRAINT salary_history_user_id_effective_date_key UNIQUE (user_id, effective_date);
  END IF;
END $$;

-- 3. PK swaps, guarded on whether user_id is already part of the PK.
-- Guards resolve the table through ::regclass rather than matching
-- information_schema by bare table_name: a same-named table in another schema
-- (a restore, a staging schema) would otherwise answer for this one and either
-- skip a required swap or re-run the drop/add on every boot.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint c
                 JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)
                 WHERE c.conrelid = 'ignored_merchants'::regclass
                   AND c.contype = 'p'
                   AND a.attname = 'user_id') THEN
    ALTER TABLE ignored_merchants DROP CONSTRAINT IF EXISTS ignored_merchants_pkey;
    ALTER TABLE ignored_merchants ADD PRIMARY KEY (user_id, merchant_key, scope);
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint c
                 JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)
                 WHERE c.conrelid = 'eth_ignored_tokens'::regclass
                   AND c.contype = 'p'
                   AND a.attname = 'user_id') THEN
    ALTER TABLE eth_ignored_tokens DROP CONSTRAINT IF EXISTS eth_ignored_tokens_pkey;
    ALTER TABLE eth_ignored_tokens ADD PRIMARY KEY (user_id, contract_address);
  END IF;
END $$;

-- 4. recurring_expenses: per-user partial unique (the old global index is
-- dropped here and 020 was reduced to a no-op so it cannot come back).
DROP INDEX IF EXISTS idx_recurring_expenses_merchant_key;
CREATE UNIQUE INDEX IF NOT EXISTS idx_recurring_expenses_user_merchant_key
  ON recurring_expenses(user_id, merchant_key) WHERE merchant_key IS NOT NULL;

-- 5. eth_address_labels: surrogate PK; per-user rows unique per user, builtin
-- rows (user_id NULL) globally unique.
ALTER TABLE eth_address_labels ADD COLUMN IF NOT EXISTS id SERIAL;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint c
             JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)
             WHERE c.conrelid = 'eth_address_labels'::regclass
               AND c.contype = 'p'
               AND a.attname = 'address') THEN
    ALTER TABLE eth_address_labels DROP CONSTRAINT eth_address_labels_pkey;
    ALTER TABLE eth_address_labels ADD PRIMARY KEY (id);
  END IF;
END $$;
CREATE UNIQUE INDEX IF NOT EXISTS uq_eth_address_labels_user_address
  ON eth_address_labels(user_id, address) WHERE user_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_eth_address_labels_builtin_address
  ON eth_address_labels(address) WHERE user_id IS NULL;

-- 6. Relocated seed: initial accounts for the original user (moved from 001,
-- whose ON CONFLICT (name) lost its inference target).
INSERT INTO accounts (name, type, user_id) VALUES
  ('Crypto', 'investment', 1),
  ('HSA', 'investment', 1),
  ('Taxable', 'investment', 1),
  ('401k', 'investment', 1),
  ('Roth IRA', 'investment', 1),
  ('Real Estate', 'property', 1),
  ('Liability', 'loan', 1)
ON CONFLICT (user_id, name) DO NOTHING;

-- 7. Relocated seed: builtin exchange hot wallets (moved from 026, whose
-- ON CONFLICT (address) lost its inference target). Each address verified
-- against its Etherscan public name tag on 2026-07-24; exact tag in note.
-- SAFETY: a wrong address here silently turns real income/spending into an
-- internal transfer. Only add addresses whose Etherscan tag unambiguously
-- names the exchange; when in doubt, leave it out.
INSERT INTO eth_address_labels (address, name, source, note) VALUES
  ('0x71660c4005ba85c37ccec55d0c4493e66fe775d3', 'Coinbase', 'builtin', 'Etherscan tag: Coinbase 1'),
  ('0x503828976d22510aad0201ac7ec88293211d23da', 'Coinbase', 'builtin', 'Etherscan tag: Coinbase 12'),
  ('0xddfabcdc4d8ffc6d5beaf154f18b778f892a0740', 'Coinbase', 'builtin', 'Etherscan tag: Coinbase 23'),
  ('0x3cd751e6b0078be393132286c442345e5dc49699', 'Coinbase', 'builtin', 'Etherscan tag: Coinbase 33'),
  ('0xb5d85cbf7cb3ee0d56b3bb207d5fc4b82f43f511', 'Coinbase', 'builtin', 'Etherscan tag: Coinbase 44'),
  ('0xeb2629a2734e272bcc07bda959863f316f4bd4cf', 'Coinbase', 'builtin', 'Etherscan tag: Coinbase 54'),
  ('0x2910543af39aba0cd09dbb2d50200b3e800a63d2', 'Kraken', 'builtin', 'Etherscan tag: Kraken 1'),
  ('0x0a869d79a7052c7f1b55a8ebabbea3420f0d1e13', 'Kraken', 'builtin', 'Etherscan tag: Kraken 2'),
  ('0xe853c56864a2ebe4576a807d26fdc4a0ada51919', 'Kraken', 'builtin', 'Etherscan tag: Kraken 3'),
  ('0x267be1c1d684f78cb4f6a176c4911b741e4ffdc0', 'Kraken', 'builtin', 'Etherscan tag: Kraken 4'),
  ('0x3f5ce5fbfe3e9af3971dd833d26ba9b5c936f0be', 'Binance', 'builtin', 'Etherscan tag: Binance'),
  ('0xd551234ae421e3bcba99a0da6d736074f22192ff', 'Binance', 'builtin', 'Etherscan tag: Binance 2'),
  ('0x28c6c06298d514db089934071355e5743bf21d60', 'Binance', 'builtin', 'Etherscan tag: Binance 14'),
  ('0x21a31ee1afc51d94c2efccaa2092ad1028285549', 'Binance', 'builtin', 'Etherscan tag: Binance 15'),
  ('0xdfd5293d8e347dfe59e90efd55b2956a1343963d', 'Binance', 'builtin', 'Etherscan tag: Binance 16'),
  ('0x61189da79177950a7272c88c6058b96d4bcd6be2', 'Binance US', 'builtin', 'Etherscan tag: Binance US'),
  ('0xd24400ae8bfebb18ca49be86258a3c749cf46853', 'Gemini', 'builtin', 'Etherscan tag: Gemini'),
  ('0x6fc82a5fe25a5cdb58bc74600a40a69c065263f8', 'Gemini', 'builtin', 'Etherscan tag: Gemini 2'),
  ('0x61edcdf5bb737adffe5043706e7c5bb1f1a56eea', 'Gemini', 'builtin', 'Etherscan tag: Gemini 3 (Gemini''s Cold Wallet)'),
  ('0x5f65f7b609678448494de4c87521cdf6cef1e932', 'Gemini', 'builtin', 'Etherscan tag: Gemini 4')
ON CONFLICT (address) WHERE user_id IS NULL DO NOTHING;

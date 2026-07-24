-- Labeled counterparty addresses (exchanges). Two sources:
--   'user'    -- added via the API (e.g. a personal Coinbase deposit address)
--   'builtin' -- seeded below from Etherscan public name tags
-- Re-runs every boot: ON CONFLICT DO NOTHING never overwrites an existing row,
-- so a user upsert of a builtin address (which flips source to 'user') survives.
CREATE TABLE IF NOT EXISTS eth_address_labels (
  address VARCHAR(42) PRIMARY KEY CHECK (address = LOWER(address)),
  name VARCHAR(64) NOT NULL,
  source VARCHAR(10) NOT NULL DEFAULT 'user' CHECK (source IN ('user', 'builtin')),
  note TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- NULL = counterparty is not a labeled exchange. Snapshot of the label name at
-- classification time; recomputed wholesale by EthTransfer.reclassifyCounterparties.
ALTER TABLE eth_transfers ADD COLUMN IF NOT EXISTS counterparty_exchange VARCHAR(64);

-- Seed: exchange hot wallets, each verified against its Etherscan public name
-- tag (etherscan.io/address/<addr>) on 2026-07-24; the exact tag is in note.
-- SAFETY: a wrong address here silently turns real income/spending into an
-- internal transfer and the failure is invisible in analytics. Only add
-- addresses whose Etherscan tag unambiguously names the exchange; when in
-- doubt, leave it out (the user can always label manually).
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
ON CONFLICT (address) DO NOTHING;

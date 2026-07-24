CREATE TABLE IF NOT EXISTS eth_wallets (
  id SERIAL PRIMARY KEY,
  address VARCHAR(42) NOT NULL UNIQUE CHECK (address = LOWER(address)),
  label VARCHAR(200),
  last_block_normal BIGINT NOT NULL DEFAULT 0,
  last_block_internal BIGINT NOT NULL DEFAULT 0,
  last_block_token BIGINT NOT NULL DEFAULT 0,
  error_code VARCHAR(100),
  error_message TEXT,
  last_synced_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Raw on-chain activity, one row per transfer leg. A single tx_hash can carry
-- several internal traces and several token logs, and Etherscan's tokentx feed
-- has no logIndex, so uniqueness is (wallet, feed, hash, position-in-feed).
-- Sync is delete-then-insert from a resume block, which keeps ordinals stable.
CREATE TABLE IF NOT EXISTS eth_transfers (
  id BIGSERIAL PRIMARY KEY,
  wallet_id INT NOT NULL REFERENCES eth_wallets(id) ON DELETE CASCADE,
  tx_hash VARCHAR(66) NOT NULL,
  ordinal INT NOT NULL DEFAULT 0,
  transfer_type VARCHAR(10) NOT NULL CHECK (transfer_type IN ('native', 'internal', 'token', 'gas')),
  block_number BIGINT NOT NULL,
  block_time TIMESTAMP NOT NULL,
  from_address VARCHAR(42) NOT NULL,
  to_address VARCHAR(42),
  value_wei NUMERIC(78, 0) NOT NULL,
  token_contract VARCHAR(42),
  token_symbol VARCHAR(64),
  token_decimals INT,
  -- isError=1: the value did not move, but gas was still burned.
  is_error BOOLEAN NOT NULL DEFAULT FALSE,
  counterparty_is_own BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (wallet_id, transfer_type, tx_hash, ordinal)
);

CREATE INDEX IF NOT EXISTS idx_eth_transfers_wallet_block ON eth_transfers(wallet_id, block_number DESC);
CREATE INDEX IF NOT EXISTS idx_eth_transfers_token ON eth_transfers(token_contract) WHERE token_contract IS NOT NULL;

CREATE TABLE IF NOT EXISTS eth_ignored_tokens (
  contract_address VARCHAR(42) PRIMARY KEY CHECK (contract_address = LOWER(contract_address)),
  symbol VARCHAR(64),
  note TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

ALTER TABLE accounts ADD COLUMN IF NOT EXISTS eth_wallet_id INT REFERENCES eth_wallets(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_accounts_eth_wallet ON accounts(eth_wallet_id) WHERE eth_wallet_id IS NOT NULL;

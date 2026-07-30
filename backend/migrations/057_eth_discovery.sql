-- Durable forgotten-wallet discovery candidates (#72).
--
-- A candidate is evidence, not an ownership verdict. Dismissed candidates stay
-- dismissed and confirmed candidates stay confirmed across reruns. chain_id=0
-- means the evidence is EVM-shaped but the source did not identify a chain;
-- this is explicit uncertainty, not a guess that it happened on Ethereum.
CREATE TABLE IF NOT EXISTS eth_discovery_candidates (
  id BIGSERIAL PRIMARY KEY,
  user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  address VARCHAR(42) NOT NULL,
  chain_id INT NOT NULL DEFAULT 0 CHECK (chain_id >= 0),
  status VARCHAR(20) NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'confirmed_own', 'dismissed')),
  score NUMERIC(8, 6),
  source VARCHAR(40) NOT NULL,
  evidence JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (user_id, address, chain_id)
);

CREATE INDEX IF NOT EXISTS idx_eth_discovery_candidates_user_status
  ON eth_discovery_candidates(user_id, status, score DESC, updated_at DESC);

CREATE TABLE IF NOT EXISTS eth_discovery_fetches (
  user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  address VARCHAR(42) NOT NULL,
  chain_id INT NOT NULL CHECK (chain_id > 0),
  status VARCHAR(20) NOT NULL CHECK (status IN ('complete', 'failed', 'truncated')),
  tx_count INT,
  counterparty_count INT,
  fetched_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  error_message TEXT,
  PRIMARY KEY (user_id, address, chain_id)
);

-- 079: separate, encrypted CDP credential and durable Base history checkpoints.
--
-- CDP is not the Coinbase exchange connector. It is a per-user Client API key
-- for the Base address-history JSON-RPC API and must never share that secret's
-- storage name or credential resolution path.

-- Keep indexed-provider credential generations independent. A CDP key change
-- must not reopen a deferred Gnosis/Moralis job, and a Moralis change must not
-- invalidate a Base/CDP run.
ALTER TABLE evm_audit_jobs
  ADD COLUMN IF NOT EXISTS moralis_credential_generation TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS cdp_credential_generation TIMESTAMPTZ;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conrelid = 'user_api_keys'::regclass
       AND conname = 'user_api_keys_service_check'
       AND pg_get_constraintdef(oid) LIKE '%cdp%'
  ) THEN
    ALTER TABLE user_api_keys
      DROP CONSTRAINT IF EXISTS user_api_keys_service_check;
    ALTER TABLE user_api_keys
      ADD CONSTRAINT user_api_keys_service_check
      CHECK (service IN (
        'plaid_client_id', 'plaid_secret', 'etherscan', 'moralis', 'cdp'
      ));
  END IF;
END $$;

-- One opaque cursor is enough because CDP exposes one complete account stream;
-- per-feed block cursors remain the derived ledger's public coverage boundary.
ALTER TABLE eth_wallet_chains
  ADD COLUMN IF NOT EXISTS provider_cursor TEXT,
  ADD COLUMN IF NOT EXISTS provider_scan_id UUID,
  ADD COLUMN IF NOT EXISTS provider_scan_head BIGINT,
  ADD COLUMN IF NOT EXISTS provider_scan_head_hash VARCHAR(66),
  ADD COLUMN IF NOT EXISTS provider_scan_order VARCHAR(20) NOT NULL DEFAULT 'unknown',
  ADD COLUMN IF NOT EXISTS provider_scan_started_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS provider_scan_status VARCHAR(20) NOT NULL DEFAULT 'idle',
  ADD COLUMN IF NOT EXISTS provider_scan_owner VARCHAR(160),
  ADD COLUMN IF NOT EXISTS provider_scan_lease_expires_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS provider_last_page_at TIMESTAMPTZ;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'eth_wallet_chains'::regclass
       AND conname = 'eth_wallet_chains_provider_scan_running_check'
  ) THEN
    ALTER TABLE eth_wallet_chains
      ADD CONSTRAINT eth_wallet_chains_provider_scan_running_check
      CHECK (
        provider_scan_status <> 'running'
        OR (
          provider_scan_id IS NOT NULL
          AND provider_scan_owner IS NOT NULL
          AND provider_scan_lease_expires_at IS NOT NULL
        )
      );
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'eth_wallet_chains'::regclass
       AND conname = 'eth_wallet_chains_provider_scan_complete_check'
  ) THEN
    ALTER TABLE eth_wallet_chains
      ADD CONSTRAINT eth_wallet_chains_provider_scan_complete_check
      CHECK (
        provider_scan_status <> 'complete'
        OR (provider_scan_owner IS NULL AND provider_scan_lease_expires_at IS NULL)
      );
  END IF;
END $$;

-- A CDP cursor is restart state for one job; observed page order is the
-- cross-run proof that lets an incremental walk stop at its reorg overlap
-- instead of replaying genesis. Unknown is deliberately a valid value: a
-- one-item page does not prove an ordering direction.
ALTER TABLE evm_audit_scopes
  ADD COLUMN IF NOT EXISTS provider_order VARCHAR(20) NOT NULL DEFAULT 'unknown';

ALTER TABLE evm_audit_scopes
  ADD COLUMN IF NOT EXISTS coverage_basis TEXT;

ALTER TABLE evm_source_coverage
  ADD COLUMN IF NOT EXISTS provider_order VARCHAR(20) NOT NULL DEFAULT 'unknown';

ALTER TABLE evm_source_coverage
  ADD COLUMN IF NOT EXISTS coverage_basis TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'eth_wallet_chains'::regclass
       AND conname = 'eth_wallet_chains_provider_scan_status_check'
  ) THEN
    ALTER TABLE eth_wallet_chains
      ADD CONSTRAINT eth_wallet_chains_provider_scan_status_check
      CHECK (provider_scan_status IN ('idle', 'running', 'deferred', 'failed', 'complete'));
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'evm_audit_scopes'::regclass
       AND conname = 'evm_audit_scopes_provider_order_check'
  ) THEN
    ALTER TABLE evm_audit_scopes
      ADD CONSTRAINT evm_audit_scopes_provider_order_check
      CHECK (provider_order IN ('unknown', 'newest_first', 'oldest_first'));
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'evm_source_coverage'::regclass
       AND conname = 'evm_source_coverage_provider_order_check'
  ) THEN
    ALTER TABLE evm_source_coverage
      ADD CONSTRAINT evm_source_coverage_provider_order_check
      CHECK (provider_order IN ('unknown', 'newest_first', 'oldest_first'));
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'eth_wallet_chains'::regclass
       AND conname = 'eth_wallet_chains_provider_scan_order_check'
  ) THEN
    ALTER TABLE eth_wallet_chains
      ADD CONSTRAINT eth_wallet_chains_provider_scan_order_check
      CHECK (provider_scan_order IN ('unknown', 'newest_first', 'oldest_first'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_eth_wallet_chains_provider_scan
  ON eth_wallet_chains(wallet_id, chain_id, provider_scan_status, provider_scan_id);

CREATE INDEX IF NOT EXISTS idx_eth_wallet_chains_provider_lease
  ON eth_wallet_chains(wallet_id, chain_id, provider_scan_lease_expires_at);

-- Raw CDP responses are append-only evidence. scan_id makes a retry within one
-- run idempotent while allowing a later incremental run to preserve a fresh
-- response even when the provider returns the same page token again.
CREATE TABLE IF NOT EXISTS eth_provider_pages (
  id BIGSERIAL PRIMARY KEY,
  wallet_id INT NOT NULL REFERENCES eth_wallets(id) ON DELETE CASCADE,
  chain_id INT NOT NULL,
  provider VARCHAR(40) NOT NULL,
  stream VARCHAR(40) NOT NULL,
  scan_id UUID NOT NULL,
  cursor_in TEXT,
  cursor_out TEXT,
  request_params JSONB NOT NULL,
  response_sha256 VARCHAR(64) NOT NULL CHECK (response_sha256 ~ '^[0-9a-f]{64}$'),
  response_raw TEXT,
  response_json JSONB NOT NULL,
  item_count INT NOT NULL CHECK (item_count >= 0),
  observed_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (wallet_id, chain_id, provider, stream, scan_id, response_sha256)
);

CREATE INDEX IF NOT EXISTS idx_eth_provider_pages_wallet_chain
  ON eth_provider_pages(wallet_id, chain_id, observed_at DESC);

-- A CDP page without the exact response body is not a recoverable evidence
-- record. This table is new in 079; fail migration rather than silently
-- accepting an already-corrupt page if a partial rollout inserted NULL raw.
ALTER TABLE eth_provider_pages
  ALTER COLUMN response_raw SET NOT NULL;

-- Candidate expansion is auxiliary to tracked-wallet Sync. Do not let it
-- silently fall back to Base's anonymous Blockscout account feeds now that
-- CDP is the sole Base history provider; retain an explicit amber limitation
-- instead of retrying an unsupported provider forever.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'eth_discovery_fetches'::regclass
       AND conname = 'eth_discovery_fetches_status_check'
  ) THEN
    ALTER TABLE eth_discovery_fetches DROP CONSTRAINT eth_discovery_fetches_status_check;
  END IF;
  ALTER TABLE eth_discovery_fetches
    ADD CONSTRAINT eth_discovery_fetches_status_check
    CHECK (status IN ('complete', 'failed', 'truncated', 'contract', 'high_traffic', 'dust', 'unsupported'));
END $$;

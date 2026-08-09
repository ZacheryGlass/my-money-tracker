-- 077: durable, provider-independent EVM history audits.
--
-- Ordinary wallet sync keeps its five account feeds. Optional audits write to
-- this evidence plane first: provider omissions never delete observations or
-- accepted canonical effects, and a restart can resume from committed page and
-- scope checkpoints. Credentials and request headers are never stored here.

CREATE TABLE IF NOT EXISTS evm_subjects (
  id BIGSERIAL PRIMARY KEY,
  user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  address VARCHAR(42) NOT NULL CHECK (address = LOWER(address)),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (user_id, address),
  UNIQUE (id, user_id)
);

-- Composite keys make ownership a database invariant, not merely a route/model
-- convention. NULL owners remain available only to legacy/shared rows and can
-- never satisfy a user-scoped audit foreign key.
CREATE UNIQUE INDEX IF NOT EXISTS idx_eth_wallets_id_user_owner
  ON eth_wallets(id, user_id);

CREATE TABLE IF NOT EXISTS evm_audit_jobs (
  id BIGSERIAL PRIMARY KEY,
  user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  subject_id BIGINT NOT NULL REFERENCES evm_subjects(id) ON DELETE CASCADE,
  requested_wallet_id INT REFERENCES eth_wallets(id) ON DELETE SET NULL,
  mode VARCHAR(20) NOT NULL CHECK (mode IN ('full', 'incremental')),
  status VARCHAR(24) NOT NULL DEFAULT 'queued' CHECK (
    status IN (
      'queued', 'running', 'deferred', 'unsupported', 'failed',
      'complete', 'complete_with_gaps', 'cancelled'
    )
  ),
  stage VARCHAR(32) NOT NULL DEFAULT 'queued' CHECK (
    stage IN (
      'queued', 'discovering', 'fetching', 'canonicalizing',
      'nonce_verification', 'balance_reconciliation',
      'bridge_reconciliation', 'complete'
    )
  ),
  idempotency_key VARCHAR(160) NOT NULL,
  credential_generation TIMESTAMPTZ,
  requested_chains JSONB NOT NULL DEFAULT '[]'::jsonb,
  discovered_chains JSONB NOT NULL DEFAULT '[]'::jsonb,
  progress JSONB NOT NULL DEFAULT '{}'::jsonb,
  lease_owner VARCHAR(100),
  lease_expires_at TIMESTAMPTZ,
  heartbeat_at TIMESTAMPTZ,
  retry_after_at TIMESTAMPTZ,
  requested_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,
  error_code VARCHAR(100),
  error_detail TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (user_id, idempotency_key),
  UNIQUE (id, subject_id),
  FOREIGN KEY (subject_id, user_id) REFERENCES evm_subjects(id, user_id) ON DELETE CASCADE,
  FOREIGN KEY (requested_wallet_id, user_id) REFERENCES eth_wallets(id, user_id)
    ON DELETE SET NULL (requested_wallet_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_evm_audit_jobs_active_subject
  ON evm_audit_jobs(subject_id)
  WHERE status IN ('queued', 'running', 'deferred');
CREATE INDEX IF NOT EXISTS idx_evm_audit_jobs_due
  ON evm_audit_jobs(status, lease_expires_at, requested_at)
  WHERE status IN ('queued', 'running', 'deferred');
CREATE INDEX IF NOT EXISTS idx_evm_audit_jobs_user_recent
  ON evm_audit_jobs(user_id, requested_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS evm_audit_scopes (
  id BIGSERIAL PRIMARY KEY,
  job_id BIGINT NOT NULL REFERENCES evm_audit_jobs(id) ON DELETE CASCADE,
  chain_id BIGINT NOT NULL CHECK (chain_id > 0),
  provider VARCHAR(40) NOT NULL,
  capability VARCHAR(32) NOT NULL CHECK (
    capability IN (
      'active_chain', 'wallet_history', 'normal', 'internal', 'erc20',
      'erc721', 'erc1155', 'native_credit', 'nonce', 'native_balance',
      'token_balance', 'bridge', 'receipt_verification'
    )
  ),
  status VARCHAR(20) NOT NULL DEFAULT 'queued' CHECK (
    status IN ('queued', 'running', 'deferred', 'unsupported', 'failed', 'complete', 'unverified')
  ),
  requested_from_block BIGINT,
  requested_through_block BIGINT,
  requested_through_hash VARCHAR(66),
  provider_cursor TEXT,
  pagination_exhausted BOOLEAN NOT NULL DEFAULT FALSE,
  pages_committed INT NOT NULL DEFAULT 0 CHECK (pages_committed >= 0),
  items_committed INT NOT NULL DEFAULT 0 CHECK (items_committed >= 0),
  last_checkpoint_at TIMESTAMPTZ,
  error_code VARCHAR(100),
  error_detail TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (job_id, chain_id, provider, capability),
  UNIQUE (id, job_id),
  CHECK (
    status <> 'complete'
    OR (requested_from_block IS NOT NULL AND requested_through_block IS NOT NULL AND pagination_exhausted)
  )
);

CREATE INDEX IF NOT EXISTS idx_evm_audit_scopes_job_status
  ON evm_audit_scopes(job_id, status, chain_id, capability);

CREATE TABLE IF NOT EXISTS evm_provider_pages (
  id BIGSERIAL PRIMARY KEY,
  scope_id BIGINT NOT NULL,
  job_id BIGINT NOT NULL REFERENCES evm_audit_jobs(id) ON DELETE CASCADE,
  provider VARCHAR(40) NOT NULL,
  endpoint VARCHAR(80) NOT NULL,
  request_params JSONB NOT NULL,
  cursor_in TEXT,
  cursor_out TEXT,
  response_sha256 VARCHAR(64) NOT NULL CHECK (response_sha256 ~ '^[0-9a-f]{64}$'),
  response_raw TEXT,
  response_json JSONB NOT NULL,
  request_id TEXT,
  item_count INT NOT NULL CHECK (item_count >= 0),
  observed_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (scope_id, response_sha256),
  UNIQUE (id, job_id),
  FOREIGN KEY (scope_id, job_id) REFERENCES evm_audit_scopes(id, job_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS evm_provider_attempts (
  id BIGSERIAL PRIMARY KEY,
  job_id BIGINT NOT NULL REFERENCES evm_audit_jobs(id) ON DELETE CASCADE,
  scope_id BIGINT,
  provider VARCHAR(40) NOT NULL,
  endpoint VARCHAR(80) NOT NULL,
  method VARCHAR(16) NOT NULL DEFAULT 'GET',
  attempt_no INT NOT NULL DEFAULT 1 CHECK (attempt_no > 0),
  request_params JSONB NOT NULL,
  cursor_in TEXT,
  outcome VARCHAR(16) NOT NULL CHECK (outcome IN ('failed', 'deferred')),
  http_status INT,
  error_code VARCHAR(100) NOT NULL,
  error_detail TEXT,
  request_id TEXT,
  response_sha256 VARCHAR(64) CHECK (response_sha256 IS NULL OR response_sha256 ~ '^[0-9a-f]{64}$'),
  response_raw TEXT,
  response_json JSONB,
  attempted_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (scope_id, job_id) REFERENCES evm_audit_scopes(id, job_id) ON DELETE SET NULL (scope_id)
);

CREATE INDEX IF NOT EXISTS idx_evm_provider_attempts_job
  ON evm_provider_attempts(job_id, attempted_at, id);

CREATE TABLE IF NOT EXISTS evm_provider_observations (
  id BIGSERIAL PRIMARY KEY,
  subject_id BIGINT NOT NULL REFERENCES evm_subjects(id) ON DELETE CASCADE,
  chain_id BIGINT NOT NULL CHECK (chain_id > 0),
  provider VARCHAR(40) NOT NULL,
  evidence_kind VARCHAR(32) NOT NULL CHECK (
    evidence_kind IN (
      'active_chain', 'transaction', 'receipt', 'log', 'native_transfer', 'gas',
      'internal_trace', 'erc20_transfer', 'erc721_transfer',
      'erc1155_transfer', 'native_balance', 'token_balance'
    )
  ),
  provider_object_key TEXT NOT NULL,
  tx_hash VARCHAR(66),
  block_number BIGINT,
  block_hash VARCHAR(66),
  transaction_index INT,
  log_index INT,
  trace_address JSONB,
  payload_json JSONB NOT NULL,
  payload_sha256 VARCHAR(64) NOT NULL CHECK (payload_sha256 ~ '^[0-9a-f]{64}$'),
  first_observed_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_observed_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (
    subject_id, chain_id, provider, evidence_kind,
    provider_object_key, payload_sha256
  ),
  UNIQUE (id, subject_id, chain_id)
);

CREATE INDEX IF NOT EXISTS idx_evm_observations_transaction
  ON evm_provider_observations(subject_id, chain_id, tx_hash)
  WHERE tx_hash IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_evm_observations_coordinates
  ON evm_provider_observations(chain_id, tx_hash, log_index, evidence_kind)
  WHERE tx_hash IS NOT NULL;

ALTER TABLE eth_transfers
  ADD COLUMN IF NOT EXISTS source_log_index INT,
  ADD COLUMN IF NOT EXISTS source_trace_address JSONB,
  ADD COLUMN IF NOT EXISTS audit_effect_key TEXT,
  ADD COLUMN IF NOT EXISTS audit_observation_id BIGINT REFERENCES evm_provider_observations(id) ON DELETE SET NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_eth_transfers_audit_effect_identity
  ON eth_transfers(wallet_id, chain_id, audit_effect_key)
  WHERE audit_effect_key IS NOT NULL;

CREATE TABLE IF NOT EXISTS evm_job_observations (
  job_id BIGINT NOT NULL REFERENCES evm_audit_jobs(id) ON DELETE CASCADE,
  subject_id BIGINT NOT NULL,
  chain_id BIGINT NOT NULL,
  observation_id BIGINT NOT NULL,
  page_id BIGINT,
  observed_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (job_id, observation_id),
  FOREIGN KEY (job_id, subject_id) REFERENCES evm_audit_jobs(id, subject_id) ON DELETE CASCADE,
  FOREIGN KEY (observation_id, subject_id, chain_id)
    REFERENCES evm_provider_observations(id, subject_id, chain_id) ON DELETE CASCADE,
  FOREIGN KEY (page_id, job_id) REFERENCES evm_provider_pages(id, job_id) ON DELETE SET NULL (page_id)
);

CREATE TABLE IF NOT EXISTS evm_mined_transactions (
  id BIGSERIAL PRIMARY KEY,
  subject_id BIGINT NOT NULL REFERENCES evm_subjects(id) ON DELETE CASCADE,
  chain_id BIGINT NOT NULL CHECK (chain_id > 0),
  tx_hash VARCHAR(66) NOT NULL CHECK (tx_hash = LOWER(tx_hash)),
  block_number BIGINT NOT NULL,
  block_hash VARCHAR(66) NOT NULL CHECK (block_hash = LOWER(block_hash)),
  transaction_index INT,
  from_address VARCHAR(42) NOT NULL CHECK (from_address = LOWER(from_address)),
  to_address VARCHAR(42) CHECK (to_address = LOWER(to_address)),
  nonce NUMERIC(78, 0) NOT NULL,
  value_wei NUMERIC(78, 0) NOT NULL,
  input TEXT,
  transaction_type VARCHAR(20),
  receipt_status INT CHECK (receipt_status IN (0, 1)),
  gas_limit NUMERIC(78, 0),
  gas_price NUMERIC(78, 0),
  effective_gas_price NUMERIC(78, 0),
  gas_used NUMERIC(78, 0),
  signedness VARCHAR(20) NOT NULL CHECK (
    signedness IN ('user_signed', 'external_signed', 'protocol_system', 'unknown')
  ),
  finality_status VARCHAR(20) NOT NULL CHECK (
    finality_status IN ('provisional', 'finalized', 'reorged', 'unknown')
  ),
  resolution_status VARCHAR(20) NOT NULL CHECK (
    resolution_status IN ('verified', 'provisional', 'conflict', 'invalidated')
  ),
  selected_observation_id BIGINT,
  conflict_detail JSONB,
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (subject_id, chain_id, tx_hash),
  UNIQUE (id, subject_id, chain_id),
  FOREIGN KEY (selected_observation_id, subject_id, chain_id)
    REFERENCES evm_provider_observations(id, subject_id, chain_id) ON DELETE SET NULL (selected_observation_id)
);

CREATE INDEX IF NOT EXISTS idx_evm_mined_transactions_nonce
  ON evm_mined_transactions(subject_id, chain_id, nonce)
  WHERE signedness = 'user_signed' AND resolution_status <> 'invalidated';

CREATE TABLE IF NOT EXISTS evm_transaction_evidence (
  transaction_id BIGINT NOT NULL,
  subject_id BIGINT NOT NULL,
  chain_id BIGINT NOT NULL,
  observation_id BIGINT NOT NULL,
  evidence_role VARCHAR(20) NOT NULL CHECK (
    evidence_role IN ('enumeration', 'transaction', 'receipt', 'conflict', 'invalidation')
  ),
  linked_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (transaction_id, observation_id),
  FOREIGN KEY (transaction_id, subject_id, chain_id)
    REFERENCES evm_mined_transactions(id, subject_id, chain_id) ON DELETE CASCADE,
  FOREIGN KEY (observation_id, subject_id, chain_id)
    REFERENCES evm_provider_observations(id, subject_id, chain_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS evm_canonical_effects (
  id BIGSERIAL PRIMARY KEY,
  subject_id BIGINT NOT NULL REFERENCES evm_subjects(id) ON DELETE CASCADE,
  chain_id BIGINT NOT NULL CHECK (chain_id > 0),
  tx_hash VARCHAR(66) NOT NULL CHECK (tx_hash = LOWER(tx_hash)),
  effect_key TEXT NOT NULL,
  effect_type VARCHAR(20) NOT NULL CHECK (
    effect_type IN ('native', 'gas', 'internal', 'erc20', 'erc721', 'erc1155', 'native_credit')
  ),
  direction VARCHAR(8) NOT NULL CHECK (direction IN ('in', 'out', 'self', 'neutral')),
  log_index INT,
  trace_address JSONB,
  from_address VARCHAR(42) CHECK (from_address = LOWER(from_address)),
  to_address VARCHAR(42) CHECK (to_address = LOWER(to_address)),
  value_units NUMERIC(78, 0) NOT NULL,
  token_contract VARCHAR(42) CHECK (token_contract = LOWER(token_contract)),
  token_standard VARCHAR(12),
  token_id NUMERIC(78, 0),
  token_decimals INT,
  resolution_status VARCHAR(20) NOT NULL CHECK (
    resolution_status IN ('verified', 'provisional', 'conflict', 'invalidated')
  ),
  selected_observation_id BIGINT,
  conflict_detail JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (subject_id, chain_id, effect_key),
  UNIQUE (id, subject_id, chain_id),
  FOREIGN KEY (selected_observation_id, subject_id, chain_id)
    REFERENCES evm_provider_observations(id, subject_id, chain_id) ON DELETE SET NULL (selected_observation_id)
);

CREATE INDEX IF NOT EXISTS idx_evm_canonical_effects_transaction
  ON evm_canonical_effects(subject_id, chain_id, tx_hash);

CREATE TABLE IF NOT EXISTS evm_effect_evidence (
  effect_id BIGINT NOT NULL,
  subject_id BIGINT NOT NULL,
  chain_id BIGINT NOT NULL,
  observation_id BIGINT NOT NULL,
  linked_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (effect_id, observation_id),
  FOREIGN KEY (effect_id, subject_id, chain_id)
    REFERENCES evm_canonical_effects(id, subject_id, chain_id) ON DELETE CASCADE,
  FOREIGN KEY (observation_id, subject_id, chain_id)
    REFERENCES evm_provider_observations(id, subject_id, chain_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS evm_source_coverage (
  id BIGSERIAL PRIMARY KEY,
  subject_id BIGINT NOT NULL REFERENCES evm_subjects(id) ON DELETE CASCADE,
  chain_id BIGINT NOT NULL CHECK (chain_id > 0),
  provider VARCHAR(40) NOT NULL,
  capability VARCHAR(32) NOT NULL,
  from_block BIGINT NOT NULL,
  through_block BIGINT NOT NULL,
  through_block_hash VARCHAR(66),
  pagination_exhausted BOOLEAN NOT NULL,
  status VARCHAR(20) NOT NULL CHECK (
    status IN ('complete', 'deferred', 'unsupported', 'failed', 'unverified')
  ),
  source_job_id BIGINT REFERENCES evm_audit_jobs(id) ON DELETE SET NULL,
  accepted_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (through_block >= from_block),
  CHECK (status <> 'complete' OR pagination_exhausted),
  UNIQUE (subject_id, chain_id, provider, capability, from_block, through_block, source_job_id)
);

CREATE INDEX IF NOT EXISTS idx_evm_source_coverage_subject
  ON evm_source_coverage(subject_id, chain_id, capability, status, through_block DESC);

CREATE TABLE IF NOT EXISTS evm_nonce_audits (
  id BIGSERIAL PRIMARY KEY,
  job_id BIGINT NOT NULL REFERENCES evm_audit_jobs(id) ON DELETE CASCADE,
  subject_id BIGINT NOT NULL REFERENCES evm_subjects(id) ON DELETE CASCADE,
  chain_id BIGINT NOT NULL CHECK (chain_id > 0),
  boundary_block BIGINT NOT NULL,
  boundary_block_hash VARCHAR(66) NOT NULL,
  next_mined_nonce NUMERIC(78, 0),
  observed_outgoing_count INT NOT NULL DEFAULT 0 CHECK (observed_outgoing_count >= 0),
  missing_nonces JSONB NOT NULL DEFAULT '[]'::jsonb,
  conflicting_nonces JSONB NOT NULL DEFAULT '[]'::jsonb,
  unknown_signedness_count INT NOT NULL DEFAULT 0 CHECK (unknown_signedness_count >= 0),
  status VARCHAR(20) NOT NULL CHECK (
    status IN ('complete', 'unverified', 'failed', 'unsupported')
  ),
  error_code VARCHAR(100),
  error_detail TEXT,
  checked_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (job_id, chain_id),
  FOREIGN KEY (job_id, subject_id) REFERENCES evm_audit_jobs(id, subject_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS evm_balance_audits (
  id BIGSERIAL PRIMARY KEY,
  job_id BIGINT NOT NULL REFERENCES evm_audit_jobs(id) ON DELETE CASCADE,
  subject_id BIGINT NOT NULL REFERENCES evm_subjects(id) ON DELETE CASCADE,
  chain_id BIGINT NOT NULL CHECK (chain_id > 0),
  asset_key TEXT NOT NULL,
  asset_type VARCHAR(12) NOT NULL CHECK (asset_type IN ('native', 'erc20')),
  boundary_block BIGINT,
  derived_units NUMERIC(78, 0),
  live_units NUMERIC(78, 0),
  delta_units NUMERIC(78, 0),
  status VARCHAR(20) NOT NULL CHECK (
    status IN ('match', 'mismatch', 'deferred', 'unsupported', 'failed', 'unverified', 'approved_exception')
  ),
  detail JSONB NOT NULL DEFAULT '{}'::jsonb,
  checked_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (job_id, chain_id, asset_key),
  FOREIGN KEY (job_id, subject_id) REFERENCES evm_audit_jobs(id, subject_id) ON DELETE CASCADE
);

-- Seed durable subjects without changing wallet ownership or deleting any
-- existing history. A later disconnect may remove eth_wallets while these
-- user-owned evidence roots remain.
INSERT INTO evm_subjects (user_id, address)
SELECT user_id, address
  FROM eth_wallets
 WHERE user_id IS NOT NULL
ON CONFLICT (user_id, address) DO NOTHING;

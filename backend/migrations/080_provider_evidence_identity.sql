-- Keep the exact response hash for integrity while adding request-aware
-- identity for idempotent retries. Providers may return the same raw error
-- body for different cursors or Core methods; those are distinct evidence
-- records, not a page conflict.
ALTER TABLE evm_provider_pages
  ADD COLUMN IF NOT EXISTS evidence_identity_sha256 VARCHAR(64);

UPDATE evm_provider_pages
   SET evidence_identity_sha256 = response_sha256
 WHERE evidence_identity_sha256 IS NULL;

ALTER TABLE evm_provider_pages
  ALTER COLUMN evidence_identity_sha256 SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'evm_provider_pages'::regclass
       AND conname = 'evm_provider_pages_evidence_identity_sha256_check'
  ) THEN
    ALTER TABLE evm_provider_pages
      ADD CONSTRAINT evm_provider_pages_evidence_identity_sha256_check
      CHECK (evidence_identity_sha256 ~ '^[0-9a-f]{64}$');
  END IF;
END
$$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'evm_provider_pages'::regclass
       AND conname = 'evm_provider_pages_scope_id_response_sha256_key'
  ) THEN
    ALTER TABLE evm_provider_pages
      DROP CONSTRAINT evm_provider_pages_scope_id_response_sha256_key;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'evm_provider_pages'::regclass
       AND conname = 'evm_provider_pages_scope_id_evidence_identity_sha256_key'
  ) THEN
    ALTER TABLE evm_provider_pages
      ADD CONSTRAINT evm_provider_pages_scope_id_evidence_identity_sha256_key
      UNIQUE (scope_id, evidence_identity_sha256);
  END IF;
END
$$;

ALTER TABLE eth_provider_pages
  ADD COLUMN IF NOT EXISTS evidence_identity_sha256 VARCHAR(64);

UPDATE eth_provider_pages
   SET evidence_identity_sha256 = response_sha256
 WHERE evidence_identity_sha256 IS NULL;

ALTER TABLE eth_provider_pages
  ALTER COLUMN evidence_identity_sha256 SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'eth_provider_pages'::regclass
       AND conname = 'eth_provider_pages_evidence_identity_sha256_check'
  ) THEN
    ALTER TABLE eth_provider_pages
      ADD CONSTRAINT eth_provider_pages_evidence_identity_sha256_check
      CHECK (evidence_identity_sha256 ~ '^[0-9a-f]{64}$');
  END IF;
END
$$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'eth_provider_pages'::regclass
       AND conname = 'eth_provider_pages_wallet_id_chain_id_provider_stream_scan_id_response_sha256_key'
  ) THEN
    ALTER TABLE eth_provider_pages
      DROP CONSTRAINT eth_provider_pages_wallet_id_chain_id_provider_stream_scan_id_response_sha256_key;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'eth_provider_pages'::regclass
       AND conname = 'eth_provider_pages_wallet_id_chain_id_provider_stream_scan_id_evidence_identity_sha256_key'
  ) THEN
    ALTER TABLE eth_provider_pages
      ADD CONSTRAINT eth_provider_pages_wallet_id_chain_id_provider_stream_scan_id_evidence_identity_sha256_key
      UNIQUE (wallet_id, chain_id, provider, stream, scan_id, evidence_identity_sha256);
  END IF;
END
$$;

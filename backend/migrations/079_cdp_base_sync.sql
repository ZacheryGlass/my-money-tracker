-- 079: generic provider-order and source-coverage metadata.
--
-- The historical provider-specific implementation was retired by migration
-- 082. Keep only the metadata used by the generic EVM evidence model so a
-- fresh install and an upgraded database have the same shape.

ALTER TABLE evm_audit_scopes
  ADD COLUMN IF NOT EXISTS provider_order VARCHAR(20) NOT NULL DEFAULT 'unknown',
  ADD COLUMN IF NOT EXISTS coverage_basis TEXT;

ALTER TABLE evm_source_coverage
  ADD COLUMN IF NOT EXISTS provider_order VARCHAR(20) NOT NULL DEFAULT 'unknown',
  ADD COLUMN IF NOT EXISTS coverage_basis TEXT;

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

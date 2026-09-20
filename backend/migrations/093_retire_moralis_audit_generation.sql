-- 093: remove the provider-specific audit generation left by the original 079.
--
-- EVM audit jobs now use the existing credential_generation column for the
-- one optional generation-tracked provider. Fresh installs never create this
-- legacy column, while upgraded databases may still carry it after migration
-- 082 retired only the CDP-specific half.

BEGIN;

-- The original provider split kept the generic column as the newest timestamp
-- across Moralis and CDP. It can therefore hold a retired CDP timestamp. Make
-- its new single-provider meaning exact before removing the redundant source;
-- NULL is safer than retaining an ambiguous legacy value.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM information_schema.columns
     WHERE table_schema = current_schema()
       AND table_name = 'evm_audit_jobs'
       AND column_name = 'moralis_credential_generation'
  ) THEN
    EXECUTE 'UPDATE evm_audit_jobs
                SET credential_generation = moralis_credential_generation
              WHERE credential_generation IS DISTINCT FROM moralis_credential_generation';
  END IF;
END $$;

ALTER TABLE evm_audit_jobs
  DROP COLUMN IF EXISTS moralis_credential_generation;

COMMIT;

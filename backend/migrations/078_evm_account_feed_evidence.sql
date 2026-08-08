-- Blockscout account feeds are retained as a distinct raw evidence kind.
-- Internal traces already have their own semantic kind; normal and token feed
-- rows must not be relabeled as transactions or logs because their provider
-- identity and coverage semantics are different.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint c
    WHERE c.conrelid = 'evm_provider_observations'::regclass
      AND c.conname = 'evm_provider_observations_evidence_kind_check'
      AND pg_get_constraintdef(c.oid) LIKE '%account_feed%'
  ) THEN
    IF EXISTS (
      SELECT 1
      FROM pg_constraint
      WHERE conrelid = 'evm_provider_observations'::regclass
        AND conname = 'evm_provider_observations_evidence_kind_check'
    ) THEN
      ALTER TABLE evm_provider_observations
        DROP CONSTRAINT evm_provider_observations_evidence_kind_check;
    END IF;

    ALTER TABLE evm_provider_observations
      ADD CONSTRAINT evm_provider_observations_evidence_kind_check CHECK (
        evidence_kind IN (
          'active_chain', 'transaction', 'receipt', 'log', 'native_transfer', 'gas',
          'internal_trace', 'account_feed', 'erc20_transfer', 'erc721_transfer',
          'erc1155_transfer', 'native_balance', 'token_balance'
        )
      );
  END IF;
END
$$;

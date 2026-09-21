-- Account-independent native-credit feeds (Polygon state-sync deposits and
-- equivalent configured sources) are retained as their own raw evidence kind.
-- The audit normalizer has emitted `native_credit` since these feeds became
-- auditable; extend the durable allowlist so those observations can be stored.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint c
     WHERE c.conrelid = 'evm_provider_observations'::regclass
       AND c.conname = 'evm_provider_observations_evidence_kind_check'
       AND pg_get_constraintdef(c.oid) LIKE '%native_credit%'
  ) THEN
    ALTER TABLE evm_provider_observations
      DROP CONSTRAINT IF EXISTS evm_provider_observations_evidence_kind_check;

    ALTER TABLE evm_provider_observations
      ADD CONSTRAINT evm_provider_observations_evidence_kind_check CHECK (
        evidence_kind IN (
          'active_chain', 'transaction', 'receipt', 'log', 'native_transfer', 'gas',
          'internal_trace', 'account_feed', 'native_credit', 'erc20_transfer',
          'erc721_transfer', 'erc1155_transfer', 'native_balance', 'token_balance'
        )
      );
  END IF;
END
$$;

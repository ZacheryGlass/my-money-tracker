-- 083: retain an independent consensus-RPC token-log enumeration capability.
--
-- `receipt_verification` is deliberately kept separate: eth_getLogs can
-- discover ERC-20/ERC-721/ERC-1155 effects but cannot prove native value or
-- internal-call completeness.  A distinct capability lets reports preserve
-- that boundary instead of treating token-log coverage as a receipt proof.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conrelid = 'evm_audit_scopes'::regclass
       AND conname = 'evm_audit_scopes_capability_check'
  ) THEN
    ALTER TABLE evm_audit_scopes
      DROP CONSTRAINT evm_audit_scopes_capability_check;
  END IF;

  ALTER TABLE evm_audit_scopes
    ADD CONSTRAINT evm_audit_scopes_capability_check CHECK (
      capability IN (
        'active_chain', 'wallet_history', 'normal', 'internal', 'erc20',
        'erc721', 'erc1155', 'native_credit', 'nonce', 'native_balance',
        'token_balance', 'bridge', 'indexed_token_logs', 'receipt_verification'
      )
    );
END
$$;

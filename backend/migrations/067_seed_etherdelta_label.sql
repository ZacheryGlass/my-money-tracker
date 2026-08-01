-- EtherDelta's historical custody contract.  The contract's internal order
-- book is not represented by standard token transfers, so this label is
-- provenance-only and never pretends that a venue export exists.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                 WHERE conrelid = 'eth_address_labels'::regclass
                   AND conname = 'eth_address_labels_source_check'
                   AND pg_get_constraintdef(oid) LIKE '%builtin-etherdelta%') THEN
    ALTER TABLE eth_address_labels DROP CONSTRAINT IF EXISTS eth_address_labels_source_check;
    ALTER TABLE eth_address_labels
      ADD CONSTRAINT eth_address_labels_source_check
      CHECK (source IN ('user', 'builtin', 'eth-labels', 'auto-match',
                        'builtin-bridge', 'builtin-polymarket', 'builtin-etherdelta'));
  END IF;
END $$;

INSERT INTO eth_address_labels (user_id, address, name, source, kind, confidence, note)
VALUES (
  NULL,
  '0x8d12a197cb00d4747a1fe03395095ce2a5cc6819',
  'EtherDelta',
  'builtin-etherdelta',
  'external',
  'high',
  'Historical EtherDelta custody/order-book contract. Deposits and withdrawals are visible on chain; internal fills may be absent from standard transfer feeds. Source: https://etherscan.io/address/0x8d12a197cb00d4747a1fe03395095ce2a5cc6819'
)
ON CONFLICT (address) WHERE user_id IS NULL DO NOTHING;

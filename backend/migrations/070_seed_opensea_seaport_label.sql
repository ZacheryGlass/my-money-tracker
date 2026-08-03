-- OpenSea Seaport 1.5 deployment.  This is a protocol counterparty label only:
-- it does not assert that a transfer is a sale or infer the user's intent.
-- The address and protocol name are sourced from OpenSea's maintained client
-- repository; method decoding remains display-only and classification stays
-- evidence-backed in the transfer pipeline.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                 WHERE conrelid = 'eth_address_labels'::regclass
                   AND conname = 'eth_address_labels_source_check'
                   AND pg_get_constraintdef(oid) LIKE '%builtin-opensea%') THEN
    ALTER TABLE eth_address_labels DROP CONSTRAINT IF EXISTS eth_address_labels_source_check;
    ALTER TABLE eth_address_labels
      ADD CONSTRAINT eth_address_labels_source_check
      CHECK (source IN ('user', 'builtin', 'eth-labels', 'auto-match',
                        'builtin-bridge', 'builtin-polymarket',
                        'builtin-etherdelta', 'builtin-opensea'));
  END IF;
END $$;

INSERT INTO eth_address_labels (user_id, address, name, source, kind, confidence, note)
VALUES (
  NULL,
  '0x00000000000000adc04c56bf30ac9d3c0aaf14dc',
  'OpenSea: Seaport 1.5',
  'builtin-opensea',
  'external',
  'high',
  'OpenSea Seaport 1.5 deployment. Protocol label only; sale interpretation requires transaction-level consideration evidence. Source: https://github.com/ProjectOpenSea/opensea-js'
)
ON CONFLICT (address) WHERE user_id IS NULL DO NOTHING;

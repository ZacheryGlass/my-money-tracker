-- 052: official Polymarket protocol counterparties.
--
-- Polygon activity contains a large amount of conditional-position traffic.
-- These four contracts are the high-volume Polymarket contracts visible in
-- the user's history. They are protocol counterparties, not custodial
-- exchanges, so `external` removes them from the unknown-counterparty queue
-- without rewriting their transfers as deposits or withdrawals.
--
-- The labels are deliberately a separate provenance pack. A user row still
-- shadows one of these rows and can correct it without the next boot restoring
-- the old verdict. The notes cite first-party deployment sources so the label
-- remains auditable rather than becoming an unexplained magic address.
--
-- Re-runs on every boot; never overwrite a row a user may have corrected.

-- The source CHECK is widened under a definition guard. Migrations 035, 041,
-- and 044 also own this constraint and must keep their sentinels in the UNION,
-- otherwise an earlier migration would narrow the constraint again on the next
-- boot before this file ran.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                 WHERE conrelid = 'eth_address_labels'::regclass
                   AND conname = 'eth_address_labels_source_check'
                   AND pg_get_constraintdef(oid) LIKE '%builtin-polymarket%') THEN
    ALTER TABLE eth_address_labels DROP CONSTRAINT IF EXISTS eth_address_labels_source_check;
    ALTER TABLE eth_address_labels
      ADD CONSTRAINT eth_address_labels_source_check
      CHECK (source IN ('user', 'builtin', 'eth-labels', 'auto-match', 'builtin-bridge', 'builtin-polymarket'));
  END IF;
END $$;

INSERT INTO eth_address_labels (user_id, address, name, source, kind, confidence, note) VALUES
  (NULL, '0x4d97dcd97ec945f40cf65f87097ace5ea0476045', 'Polymarket: Conditional Tokens', 'builtin-polymarket', 'external', 'high', 'Conditional Token Framework contract used by Polymarket. Source: https://github.com/Polymarket/agent-skills'),
  (NULL, '0x4bfb41d5b3570defd03c39a9a4d8de6bd8b8982e', 'Polymarket: CTF Exchange V1', 'builtin-polymarket', 'external', 'high', 'Polymarket CTF Exchange V1. Source: https://github.com/polymarket/ctf-exchange'),
  (NULL, '0xc5d563a36ae78145c45a50134d48a1215220f80a', 'Polymarket: Neg Risk Exchange V1', 'builtin-polymarket', 'external', 'high', 'Polymarket Neg Risk CTF Exchange V1. Source: https://github.com/Polymarket/ctf-exchange'),
  (NULL, '0xd91e80cf2e7be2e162c6513ced06f1dd0da35296', 'Polymarket: Neg Risk Adapter', 'builtin-polymarket', 'external', 'high', 'Polymarket Neg Risk Adapter. Source: https://github.com/Polymarket/agent-skills')
ON CONFLICT (address) WHERE user_id IS NULL DO NOTHING;

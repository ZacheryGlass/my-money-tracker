-- Coinbase v2 uses transaction type `send` on both accounts involved in a
-- transfer. The signed amount is the account-relative direction: negative is
-- a withdrawal, positive is a deposit. Older importer code classified every
-- send as a withdrawal, which prevented otherwise exact transaction-hash
-- matches for incoming on-chain transfers.
--
-- Restrict the repair to source-preserved API rows with a real network hash.
-- Positive peer-to-peer/internal sends without an on-chain identity are not
-- rewritten into the automatic matching pool. Re-running this migration is a
-- no-op once the rows have the correct type.
UPDATE exchange_records er
   SET record_type = 'deposit',
       -- record_type participates in the canonical dedupe fingerprint. Leave
       -- no stale withdrawal fingerprint behind; a subsequent API sync fills
       -- the corrected fingerprint through the normal guarded metadata path.
       fingerprint = NULL,
       fingerprint_version = NULL
  FROM exchange_accounts ea
 WHERE ea.id = er.exchange_account_id
   AND ea.exchange = 'coinbase'
   AND er.record_type = 'withdrawal'
   AND er.base_amount > 0
   AND er.tx_hash IS NOT NULL
   AND BTRIM(er.tx_hash) <> ''
   AND er.raw->>'_format' = 'coinbase'
   AND er.raw->>'_source' = 'api'
   AND LOWER(er.raw->>'type') = 'send';

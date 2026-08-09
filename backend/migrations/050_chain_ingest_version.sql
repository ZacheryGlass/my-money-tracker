-- 050: version per-chain ingestion so a normalization/provider change can
-- trigger one safe historical reingest (#78).
--
-- OP Mainnet could be explicitly enabled before its keyless Blockscout
-- support shipped. Those rows may therefore contain legacy address-to-self
-- deposit transactions and cursors already far beyond them.
-- `ingest_version = 0` marks that stored history as pre-#78. The service sees
-- the registry's version 1, atomically resets all six cursors, and lets each
-- successfully fetched feed delete/rebuild its own full window. A feed that
-- fails keeps its old rows and its zero cursor, preserving fail-closed retry
-- behavior.
--
-- New chain rows are inserted with the registry's current version. DEFAULT 0
-- is deliberately conservative for rows created by old application versions.
-- The migration is idempotent and re-runs safely on every boot.
ALTER TABLE eth_wallet_chains
  ADD COLUMN IF NOT EXISTS ingest_version INT NOT NULL DEFAULT 0;

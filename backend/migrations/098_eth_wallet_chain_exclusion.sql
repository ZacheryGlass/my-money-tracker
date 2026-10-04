-- A user can exclude one chain for one wallet (an address that never used that
-- network). Excluded behaves like a globally disabled chain for that wallet:
-- no sync, no balance read, no audit; cursors and stored history are kept, so
-- re-including resumes where it left off. Mainnet is never excludable.
ALTER TABLE eth_wallet_chains
  ADD COLUMN IF NOT EXISTS excluded BOOLEAN NOT NULL DEFAULT FALSE;

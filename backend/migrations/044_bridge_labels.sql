-- Bridge detection (#59): a fourth label kind, and the join table that pairs
-- the two halves of one cross-chain movement.
--
-- An L1 -> L2 bridge deposit is a transfer between the user's own accounts, but
-- the chains record it as two unrelated transactions: an unexplained outflow on
-- chain A and an unexplained inflow on chain B, with different hashes and
-- different block numbers (per-chain sequences, 039). Before this, the outflow
-- fell to the activity ladder's rule 8 and was flagged as a possible SEND --
-- i.e. as possible spending -- and the inflow as a possible receive.
--
--   kind = 'bridge'  -> the address is a bridge contract. The ladder reads a
--                       value leg to/from it as bridge_out / bridge_in, and the
--                       triage queue drops it like any other labeled address.
--
-- PRECEDENCE IS UNCHANGED, in both directions that matter:
--   * A user row still shadows any builtin (resolved ORDER BY user_id NULLS
--     LAST), so a wrong address here is correctable in two clicks and the fix
--     heals history retroactively through refreshClassificationsForUser.
--   * 'own' still beats everything: an address the user declared theirs is not
--     in the bridge set at all (kind is one column on one winning row), and the
--     ladder's rule 1 claims the transaction before the bridge rung anyway.
--   * 'exchange' keeps the rung it has always had. The bridge rung sits BELOW
--     it, so no transaction that classifies today changes verdict.
--
-- WHY A WRONG BRIDGE LABEL IS CHEAP, by construction: an unmatched bridge leg
-- keeps needs_review = TRUE. A mislabeled address therefore turns one flagged
-- row into a differently-flagged row -- it can only become a confident,
-- unflagged verdict if a leg on ANOTHER chain independently matches its asset,
-- its amount within the fee tolerance, and its time window. That is the
-- opposite of the 'exchange' failure mode, where one wrong row silently deletes
-- real spending from cash flow.
--
-- Re-runs on every boot, so every statement below is idempotent.

-- 032 created the kind CHECK with a NAME-only guard, which is exactly the trap
-- 038 wrote up: satisfied by the constraint that already exists, so a later
-- widening is skipped forever on every deployed database while looking
-- perfectly applied on a fresh one. Guard on the DEFINITION instead, and BUMP
-- THE SENTINEL ('bridge', the newest value) when adding a kind.
--
-- So eth_address_labels_kind_check is dual-owned (032 + here), but unlike the
-- source CHECK the two cannot fight: 032's guard is name-only, and this block
-- always leaves a constraint of that name in place, so after 044 has run once
-- 032's IF NOT EXISTS is satisfied forever and it can never re-narrow.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                 WHERE conrelid = 'eth_address_labels'::regclass
                   AND conname = 'eth_address_labels_kind_check'
                   AND pg_get_constraintdef(oid) LIKE '%bridge%') THEN
    ALTER TABLE eth_address_labels DROP CONSTRAINT IF EXISTS eth_address_labels_kind_check;
    ALTER TABLE eth_address_labels
      ADD CONSTRAINT eth_address_labels_kind_check
      -- The UNION of every kind, 046's 'service' included, for the same reason
      -- the source CHECK below carries every source: two widening lists that
      -- disagree take turns dropping and re-adding each other's constraint.
      CHECK (kind IN ('exchange', 'external', 'own', 'bridge', 'service'));
  END IF;
END $$;

-- 035 widened `source` to VARCHAR(40) and its CHECK to three values; the seed
-- below needs a fourth. Same definition guard, same sentinel discipline
-- ('builtin-bridge'). Naming the pack rather than filing it under 'builtin' is
-- the point of 035: 'builtin' means 029's 20 hand-verified exchange hot wallets,
-- and this pack answers to a different research trail.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                 WHERE conrelid = 'eth_address_labels'::regclass
                   AND conname = 'eth_address_labels_source_check'
                   AND pg_get_constraintdef(oid) LIKE '%builtin-bridge%') THEN
    ALTER TABLE eth_address_labels DROP CONSTRAINT IF EXISTS eth_address_labels_source_check;
    ALTER TABLE eth_address_labels
      ADD CONSTRAINT eth_address_labels_source_check
      -- The UNION of every source, 041's 'auto-match' included: THREE
      -- migrations own this constraint -- 035 creates it (sentinel
      -- 'eth-labels'), 041 and this one widen it under their own sentinels --
      -- and two narrower lists take turns dropping and re-adding each other's,
      -- failing on the second boot once the rows the other list forbids exist.
      -- See the note in 041. Add a source in BOTH widening lists.
      --
      -- 035 stays harmless only while 'eth-labels' remains in this union: it
      -- runs first every boot and its guard passes on seeing that value, so it
      -- never re-narrows what 041/044 widened. Drop 'eth-labels' from the union
      -- and 035 re-narrows the constraint on every single boot.
      CHECK (source IN ('user', 'builtin', 'eth-labels', 'auto-match', 'builtin-bridge'));
  END IF;
END $$;

-- The cross-chain pairing. One row = one movement of the user's own money that
-- the chains recorded twice.
--
-- Ownership deliberately has no column here: it is inherited through
-- eth_activity -> eth_wallets, the root table, exactly like eth_transfers and
-- eth_activity_overrides. A denormalized user_id would be a second answer to
-- "whose row is this", and the two can disagree.
--
-- DERIVED, like eth_activity itself -- and unlike eth_activity_overrides, which
-- is a separate table precisely so a rebuild cannot erase a human's correction.
-- These rows are recomputed from amounts and timestamps, so ON DELETE CASCADE
-- is correct: rebuilding a wallet drops the links that pointed at its rows, and
-- the matching pass immediately re-derives the ones still true. Every caller of
-- rebuildForWallet runs matchBridgeTransfersForUser afterwards for that reason.
--
-- The two UNIQUE constraints are the pairing's integrity: a leg can be claimed
-- by at most one link from each side, so a bridge_out cannot be presented as
-- completed by two different bridge_ins.
--
-- Amounts are unconstrained NUMERIC on purpose. A declared scale ROUNDS
-- silently on insert, and a token with more than 18 decimals would have its
-- amount quietly rewritten on the way in -- in a column whose entire job is to
-- record how much money moved.
CREATE TABLE IF NOT EXISTS eth_activity_links (
  id BIGSERIAL PRIMARY KEY,
  out_activity_id BIGINT NOT NULL REFERENCES eth_activity(id) ON DELETE CASCADE,
  in_activity_id BIGINT NOT NULL REFERENCES eth_activity(id) ON DELETE CASCADE,
  asset VARCHAR(32) NOT NULL,
  out_amount NUMERIC NOT NULL,
  in_amount NUMERIC NOT NULL,
  -- What the bridge took: out_amount - in_amount, in units of the asset. The
  -- gas on each side is already on its own eth_activity row's fee_wei.
  fee_amount NUMERIC NOT NULL,
  matched_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT eth_activity_links_out_unique UNIQUE (out_activity_id),
  CONSTRAINT eth_activity_links_in_unique UNIQUE (in_activity_id),
  -- A transaction cannot be both halves of its own bridge.
  CONSTRAINT eth_activity_links_distinct_legs CHECK (out_activity_id <> in_activity_id)
);

-- BEGIN GENERATED SEED (backend/scripts/generate-bridge-seed.js)
-- 32 addresses, researched 2026-07-26. Sources, one per protocol:
--   arbitrum  https://docs.arbitrum.io/arbitrum-essentials/reference/contract-addresses
--   linea     https://docs.linea.build/network/build/contracts
--   optimism  https://raw.githubusercontent.com/ethereum-optimism/superchain-registry/main/superchain/extra/addresses/addresses.json
--   base      https://docs.base.org/base-chain/network-information/base-contracts
--   across    https://docs.across.to/chains-and-contracts
--   polygon   https://raw.githubusercontent.com/maticnetwork/static/master/network/mainnet/v1/index.json
--
-- ON CONFLICT (address) WHERE user_id IS NULL DO NOTHING -- never DO UPDATE.
-- Migrations re-run on every boot; DO UPDATE would re-stamp a name, a kind or
-- a note the user had already corrected, every boot, forever.
INSERT INTO eth_address_labels (user_id, address, name, source, kind, confidence, note) VALUES
  (NULL, '0x4dbd4fc535ac27206064b68ffcf827b0a60bab3f', 'Arbitrum: Delayed Inbox', 'builtin-bridge', 'bridge', 'high', 'Cross-chain bridge on chain 1. Source: https://docs.arbitrum.io/arbitrum-essentials/reference/contract-addresses'),
  (NULL, '0x8315177ab297ba92a06054ce80a67ed4dbd7ed3a', 'Arbitrum: Bridge', 'builtin-bridge', 'bridge', 'high', 'Cross-chain bridge on chain 1. Source: https://docs.arbitrum.io/arbitrum-essentials/reference/contract-addresses'),
  (NULL, '0x0b9857ae2d4a3dbe74ffe1d7df045bb7f96e4840', 'Arbitrum: Outbox', 'builtin-bridge', 'bridge', 'high', 'Cross-chain bridge on chain 1. Source: https://docs.arbitrum.io/arbitrum-essentials/reference/contract-addresses'),
  (NULL, '0x72ce9c846789fdb6fc1f34ac4ad25dd9ef7031ef', 'Arbitrum One: L1 Gateway Router', 'builtin-bridge', 'bridge', 'high', 'Cross-chain bridge on chain 1. Source: https://docs.arbitrum.io/arbitrum-essentials/reference/contract-addresses'),
  (NULL, '0xa3a7b6f88361f48403514059f1f16c8e78d60eec', 'Arbitrum One: L1 ERC20 Gateway', 'builtin-bridge', 'bridge', 'high', 'Cross-chain bridge on chain 1. Source: https://docs.arbitrum.io/arbitrum-essentials/reference/contract-addresses'),
  (NULL, '0xcee284f754e854890e311e3280b767f80797180d', 'Arbitrum One: L1 Arb-Custom Gateway', 'builtin-bridge', 'bridge', 'high', 'Cross-chain bridge on chain 1. Source: https://docs.arbitrum.io/arbitrum-essentials/reference/contract-addresses'),
  (NULL, '0xd92023e9d9911199a6711321d1277285e6d4e2db', 'Arbitrum One: L1 WETH Gateway', 'builtin-bridge', 'bridge', 'high', 'Cross-chain bridge on chain 1. Source: https://docs.arbitrum.io/arbitrum-essentials/reference/contract-addresses'),
  (NULL, '0x5288c571fd7ad117bea99bf60fe0846c4e84f933', 'Arbitrum One: L2 Gateway Router', 'builtin-bridge', 'bridge', 'high', 'Cross-chain bridge on chain 42161. Source: https://docs.arbitrum.io/arbitrum-essentials/reference/contract-addresses'),
  (NULL, '0x09e9222e96e7b4ae2a407b98d48e330053351eee', 'Arbitrum One: L2 ERC20 Gateway', 'builtin-bridge', 'bridge', 'high', 'Cross-chain bridge on chain 42161. Source: https://docs.arbitrum.io/arbitrum-essentials/reference/contract-addresses'),
  (NULL, '0x096760f208390250649e3e8763348e783aef5562', 'Arbitrum One: L2 Arb-Custom Gateway', 'builtin-bridge', 'bridge', 'high', 'Cross-chain bridge on chain 42161. Source: https://docs.arbitrum.io/arbitrum-essentials/reference/contract-addresses'),
  (NULL, '0x6c411ad3e74de3e7bd422b94a27770f5b86c623b', 'Arbitrum One: L2 WETH Gateway', 'builtin-bridge', 'bridge', 'high', 'Cross-chain bridge on chain 42161. Source: https://docs.arbitrum.io/arbitrum-essentials/reference/contract-addresses'),
  (NULL, '0x0000000000000000000000000000000000000064', 'Arbitrum: ArbSys', 'builtin-bridge', 'bridge', 'high', 'Cross-chain bridge on chain 42161. Source: https://docs.arbitrum.io/arbitrum-essentials/reference/contract-addresses'),
  (NULL, '0xd19d4b5d358258f05d7b411e21a1460d11b0876f', 'Linea: L1 Message Service', 'builtin-bridge', 'bridge', 'high', 'Cross-chain bridge on chain 1. Source: https://docs.linea.build/network/build/contracts'),
  (NULL, '0x051f1d88f0af5763fb888ec4378b4d8b29ea3319', 'Linea: L1 Token Bridge', 'builtin-bridge', 'bridge', 'high', 'Cross-chain bridge on chain 1. Source: https://docs.linea.build/network/build/contracts'),
  (NULL, '0x508ca82df566dcd1b0de8296e70a96332cd644ec', 'Linea: L2 Message Service', 'builtin-bridge', 'bridge', 'high', 'Cross-chain bridge on chain 59144. Source: https://docs.linea.build/network/build/contracts'),
  (NULL, '0x353012dc4a9a6cf55c941badc267f82004a8ceb9', 'Linea: L2 Token Bridge', 'builtin-bridge', 'bridge', 'high', 'Cross-chain bridge on chain 59144. Source: https://docs.linea.build/network/build/contracts'),
  (NULL, '0x99c9fc46f92e8a1c0dec1b1747d010903e884be1', 'Optimism: L1 Standard Bridge', 'builtin-bridge', 'bridge', 'high', 'Cross-chain bridge on chain 1. Source: https://raw.githubusercontent.com/ethereum-optimism/superchain-registry/main/superchain/extra/addresses/addresses.json'),
  (NULL, '0xbeb5fc579115071764c7423a4f12edde41f106ed', 'Optimism: Portal', 'builtin-bridge', 'bridge', 'high', 'Cross-chain bridge on chain 1. Source: https://raw.githubusercontent.com/ethereum-optimism/superchain-registry/main/superchain/extra/addresses/addresses.json'),
  (NULL, '0x25ace71c97b33cc4729cf772ae268934f7ab5fa1', 'Optimism: L1 Cross Domain Messenger', 'builtin-bridge', 'bridge', 'high', 'Cross-chain bridge on chain 1. Source: https://raw.githubusercontent.com/ethereum-optimism/superchain-registry/main/superchain/extra/addresses/addresses.json'),
  (NULL, '0x3154cf16ccdb4c6d922629664174b904d80f2c35', 'Base: L1 Standard Bridge', 'builtin-bridge', 'bridge', 'high', 'Cross-chain bridge on chain 1. Source: https://docs.base.org/base-chain/network-information/base-contracts'),
  (NULL, '0x49048044d57e1c92a77f79988d21fa8faf74e97e', 'Base: Portal', 'builtin-bridge', 'bridge', 'high', 'Cross-chain bridge on chain 1. Source: https://docs.base.org/base-chain/network-information/base-contracts'),
  (NULL, '0x866e82a600a1414e583f7f13623f1ac5d58b0afa', 'Base: L1 Cross Domain Messenger', 'builtin-bridge', 'bridge', 'high', 'Cross-chain bridge on chain 1. Source: https://docs.base.org/base-chain/network-information/base-contracts'),
  (NULL, '0x4200000000000000000000000000000000000010', 'OP Stack: L2 Standard Bridge', 'builtin-bridge', 'bridge', 'high', 'Cross-chain bridge on chain 8453. Source: https://docs.base.org/base-chain/network-information/base-contracts'),
  (NULL, '0x4200000000000000000000000000000000000016', 'OP Stack: L2 To L1 Message Passer', 'builtin-bridge', 'bridge', 'high', 'Cross-chain bridge on chain 8453. Source: https://docs.base.org/base-chain/network-information/base-contracts'),
  (NULL, '0x5c7bcd6e7de5423a257d81b442095a1a6ced35c5', 'Across: Ethereum Spoke Pool', 'builtin-bridge', 'bridge', 'high', 'Cross-chain bridge on chain 1. Source: https://docs.across.to/chains-and-contracts'),
  (NULL, '0xe35e9842fceaca96570b734083f4a58e8f7c5f2a', 'Across: Arbitrum Spoke Pool', 'builtin-bridge', 'bridge', 'high', 'Cross-chain bridge on chain 42161. Source: https://docs.across.to/chains-and-contracts'),
  (NULL, '0x6f26bf09b1c792e3228e5467807a900a503c0281', 'Across: OP Mainnet Spoke Pool', 'builtin-bridge', 'bridge', 'high', 'Cross-chain bridge on chain 10. Source: https://docs.across.to/chains-and-contracts'),
  (NULL, '0x09aea4b2242abc8bb4bb78d537a67a245a7bec64', 'Across: Base Spoke Pool', 'builtin-bridge', 'bridge', 'high', 'Cross-chain bridge on chain 8453. Source: https://docs.across.to/chains-and-contracts'),
  (NULL, '0x7e63a5f1a8f0b4d0934b2f2327daed3f6bb2ee75', 'Across: Linea Spoke Pool', 'builtin-bridge', 'bridge', 'high', 'Cross-chain bridge on chain 59144. Source: https://docs.across.to/chains-and-contracts'),
  (NULL, '0xa0c68c638235ee32657e8f720a23cec1bfc77c77', 'Polygon: PoS Bridge (RootChainManager)', 'builtin-bridge', 'bridge', 'high', 'Cross-chain bridge on chain 1. Source: https://raw.githubusercontent.com/maticnetwork/static/master/network/mainnet/v1/index.json'),
  (NULL, '0x8484ef722627bf18ca5ae6bcf031c23e6e922b30', 'Polygon: PoS Ether Predicate', 'builtin-bridge', 'bridge', 'high', 'Cross-chain bridge on chain 1. Source: https://raw.githubusercontent.com/maticnetwork/static/master/network/mainnet/v1/index.json'),
  (NULL, '0x40ec5b33f54e0e8a33a975908c5ba1c14e5bbbdf', 'Polygon: PoS ERC20 Predicate', 'builtin-bridge', 'bridge', 'high', 'Cross-chain bridge on chain 1. Source: https://raw.githubusercontent.com/maticnetwork/static/master/network/mainnet/v1/index.json')
ON CONFLICT (address) WHERE user_id IS NULL DO NOTHING;

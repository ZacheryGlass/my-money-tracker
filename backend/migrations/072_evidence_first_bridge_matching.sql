-- Evidence-first bridge matching (bridge-match-v1).
--
-- The old bridge link table contained amount/time guesses. Preserve those as
-- inert suggestions, remove their fold, and make every future fold reference a
-- protocol-verified or user-confirmed logical movement.

CREATE TABLE IF NOT EXISTS eth_bridge_endpoints (
  id BIGSERIAL PRIMARY KEY,
  protocol VARCHAR(32) NOT NULL,
  family_version VARCHAR(48) NOT NULL,
  chain_id INTEGER NOT NULL,
  address VARCHAR(42) NOT NULL,
  name VARCHAR(96) NOT NULL,
  role VARCHAR(48) NOT NULL,
  direction VARCHAR(16) NOT NULL,
  valid_from_block BIGINT,
  valid_to_block BIGINT,
  source_url TEXT NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT eth_bridge_endpoint_address_check
    CHECK (address ~ '^0x[0-9a-f]{40}$'),
  CONSTRAINT eth_bridge_endpoint_direction_check
    CHECK (direction IN ('in', 'out', 'both')),
  CONSTRAINT eth_bridge_endpoint_bounds_check
    CHECK (valid_from_block IS NULL OR valid_to_block IS NULL OR valid_from_block <= valid_to_block),
  CONSTRAINT eth_bridge_endpoint_source_check
    CHECK (source_url LIKE 'https://%'),
  UNIQUE (protocol, family_version, chain_id, address, role)
);

CREATE INDEX IF NOT EXISTS idx_eth_bridge_endpoints_lookup
  ON eth_bridge_endpoints (chain_id, address) WHERE enabled;

CREATE TABLE IF NOT EXISTS eth_bridge_receipts (
  id BIGSERIAL PRIMARY KEY,
  wallet_id INTEGER NOT NULL REFERENCES eth_wallets(id) ON DELETE CASCADE,
  chain_id INTEGER NOT NULL,
  tx_hash VARCHAR(66) NOT NULL,
  fetch_status VARCHAR(16) NOT NULL,
  provider VARCHAR(48) NOT NULL,
  provider_boundary JSONB NOT NULL DEFAULT '{}'::jsonb,
  block_number BIGINT,
  block_hash VARCHAR(66),
  transaction_json JSONB,
  receipt_json JSONB,
  error_code VARCHAR(64),
  error_detail TEXT,
  decoder_version VARCHAR(32) NOT NULL DEFAULT 'bridge-match-v1',
  fetched_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  invalidated_at TIMESTAMPTZ,
  invalidation_reason VARCHAR(96),
  CONSTRAINT eth_bridge_receipt_hash_check
    CHECK (tx_hash ~ '^0x[0-9a-f]{64}$'),
  CONSTRAINT eth_bridge_receipt_status_check
    CHECK (fetch_status IN ('complete', 'failed', 'unsupported', 'invalidated')),
  CONSTRAINT eth_bridge_receipt_shape_check CHECK (
    (fetch_status = 'complete' AND transaction_json IS NOT NULL AND receipt_json IS NOT NULL
      AND block_number IS NOT NULL AND block_hash IS NOT NULL AND error_code IS NULL)
    OR
    (fetch_status <> 'complete' AND error_code IS NOT NULL)
  ),
  UNIQUE (wallet_id, chain_id, tx_hash)
);

CREATE INDEX IF NOT EXISTS idx_eth_bridge_receipts_coordinate
  ON eth_bridge_receipts (chain_id, tx_hash);

CREATE TABLE IF NOT EXISTS eth_bridge_receipt_attempts (
  id BIGSERIAL PRIMARY KEY,
  wallet_id INTEGER NOT NULL REFERENCES eth_wallets(id) ON DELETE CASCADE,
  chain_id INTEGER NOT NULL,
  tx_hash VARCHAR(66) NOT NULL,
  provider VARCHAR(48) NOT NULL,
  status VARCHAR(16) NOT NULL,
  provider_boundary JSONB NOT NULL DEFAULT '{}'::jsonb,
  error_code VARCHAR(64),
  error_detail TEXT,
  attempted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT eth_bridge_receipt_attempt_hash_check CHECK (tx_hash ~ '^0x[0-9a-f]{64}$'),
  CONSTRAINT eth_bridge_receipt_attempt_status_check CHECK (status IN ('complete', 'failed', 'unsupported')),
  CONSTRAINT eth_bridge_receipt_attempt_error_check CHECK (
    (status = 'complete' AND error_code IS NULL)
    OR (status <> 'complete' AND error_code IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_eth_bridge_receipt_attempts_coordinate
  ON eth_bridge_receipt_attempts (wallet_id, chain_id, tx_hash, attempted_at DESC);

CREATE TABLE IF NOT EXISTS eth_bridge_movements (
  id BIGSERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  protocol VARCHAR(32) NOT NULL,
  family_version VARCHAR(48) NOT NULL,
  status VARCHAR(24) NOT NULL,
  verification_method VARCHAR(24) NOT NULL,
  correlation_key TEXT NOT NULL,
  rule_version VARCHAR(32) NOT NULL DEFAULT 'bridge-match-v1',
  evidence JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  invalidated_at TIMESTAMPTZ,
  invalidation_reason VARCHAR(96),
  CONSTRAINT eth_bridge_movement_status_check CHECK (status IN (
    'protocol_verified', 'user_confirmed', 'pending', 'refunded',
    'failed', 'unsupported', 'invalidated'
  )),
  -- This is the central safety boundary. There is deliberately no
  -- amount_time/address_amount/heuristic value available to application code.
  CONSTRAINT eth_bridge_movement_verification_check CHECK (
    (verification_method = 'protocol_identity' AND status IN (
      'protocol_verified', 'pending', 'refunded', 'failed', 'unsupported', 'invalidated'
    ))
    OR
    (verification_method = 'user_verdict' AND status IN ('user_confirmed', 'invalidated'))
  ),
  UNIQUE (user_id, protocol, family_version, correlation_key)
);

CREATE TABLE IF NOT EXISTS eth_bridge_movement_members (
  id BIGSERIAL PRIMARY KEY,
  movement_id BIGINT NOT NULL REFERENCES eth_bridge_movements(id) ON DELETE CASCADE,
  wallet_id INTEGER NOT NULL REFERENCES eth_wallets(id) ON DELETE CASCADE,
  chain_id INTEGER NOT NULL,
  tx_hash VARCHAR(66) NOT NULL,
  role VARCHAR(32) NOT NULL,
  receipt_id BIGINT REFERENCES eth_bridge_receipts(id) ON DELETE SET NULL,
  log_index INTEGER,
  asset_id TEXT,
  amount NUMERIC,
  fee_amount NUMERIC,
  evidence JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT eth_bridge_member_hash_check CHECK (tx_hash ~ '^0x[0-9a-f]{64}$'),
  CONSTRAINT eth_bridge_member_role_check CHECK (role IN (
    'initiation', 'destination_execution', 'fill', 'proof',
    'finalization', 'refund', 'fee'
  )),
  CONSTRAINT eth_bridge_member_amount_check CHECK (amount IS NULL OR amount >= 0),
  CONSTRAINT eth_bridge_member_fee_check CHECK (fee_amount IS NULL OR fee_amount >= 0),
  UNIQUE (movement_id, wallet_id, chain_id, tx_hash, role)
);

CREATE INDEX IF NOT EXISTS idx_eth_bridge_members_coordinate
  ON eth_bridge_movement_members (wallet_id, chain_id, tx_hash);

CREATE TABLE IF NOT EXISTS eth_bridge_suggestions (
  id BIGSERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  out_wallet_id INTEGER NOT NULL REFERENCES eth_wallets(id) ON DELETE CASCADE,
  out_chain_id INTEGER NOT NULL,
  out_tx_hash VARCHAR(66) NOT NULL,
  in_wallet_id INTEGER NOT NULL REFERENCES eth_wallets(id) ON DELETE CASCADE,
  in_chain_id INTEGER NOT NULL,
  in_tx_hash VARCHAR(66) NOT NULL,
  protocol VARCHAR(32),
  family_version VARCHAR(48),
  suggestion_reason VARCHAR(48) NOT NULL,
  ambiguous BOOLEAN NOT NULL DEFAULT FALSE,
  rule_version VARCHAR(32) NOT NULL DEFAULT 'bridge-match-v1',
  evidence JSONB NOT NULL DEFAULT '{}'::jsonb,
  source VARCHAR(24) NOT NULL DEFAULT 'derived',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT eth_bridge_suggestion_hashes_check CHECK (
    out_tx_hash ~ '^0x[0-9a-f]{64}$' AND in_tx_hash ~ '^0x[0-9a-f]{64}$'
  ),
  CONSTRAINT eth_bridge_suggestion_direction_check CHECK (out_chain_id <> in_chain_id),
  CONSTRAINT eth_bridge_suggestion_reason_check CHECK (suggestion_reason IN (
    'legacy_amount_time_heuristic', 'address_asset_amount',
    'asset_amount', 'asset_time_only', 'unsupported_protocol_path'
  )),
  CONSTRAINT eth_bridge_suggestion_source_check CHECK (source IN ('derived', 'legacy_migration')),
  UNIQUE (user_id, out_wallet_id, out_chain_id, out_tx_hash,
          in_wallet_id, in_chain_id, in_tx_hash, suggestion_reason)
);

CREATE INDEX IF NOT EXISTS idx_eth_bridge_suggestions_user
  ON eth_bridge_suggestions (user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS eth_bridge_verdicts (
  id BIGSERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  out_wallet_id INTEGER NOT NULL REFERENCES eth_wallets(id) ON DELETE CASCADE,
  out_chain_id INTEGER NOT NULL,
  out_tx_hash VARCHAR(66) NOT NULL,
  in_wallet_id INTEGER NOT NULL REFERENCES eth_wallets(id) ON DELETE CASCADE,
  in_chain_id INTEGER NOT NULL,
  in_tx_hash VARCHAR(66) NOT NULL,
  verdict VARCHAR(16) NOT NULL,
  note TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT eth_bridge_verdict_hashes_check CHECK (
    out_tx_hash ~ '^0x[0-9a-f]{64}$' AND in_tx_hash ~ '^0x[0-9a-f]{64}$'
  ),
  CONSTRAINT eth_bridge_verdict_direction_check CHECK (out_chain_id <> in_chain_id),
  CONSTRAINT eth_bridge_verdict_value_check CHECK (verdict IN ('confirmed', 'rejected')),
  UNIQUE (user_id, out_wallet_id, out_chain_id, out_tx_hash,
          in_wallet_id, in_chain_id, in_tx_hash)
);

-- The application checks conflicts to return a useful error, while these
-- partial indexes close the concurrent-confirmation race at the database.
CREATE UNIQUE INDEX IF NOT EXISTS uq_eth_bridge_confirmed_out_member
  ON eth_bridge_verdicts (user_id, out_wallet_id, out_chain_id, out_tx_hash)
  WHERE verdict = 'confirmed';
CREATE UNIQUE INDEX IF NOT EXISTS uq_eth_bridge_confirmed_in_member
  ON eth_bridge_verdicts (user_id, in_wallet_id, in_chain_id, in_tx_hash)
  WHERE verdict = 'confirmed';

-- Preserve every historical heuristic fold as review evidence before removing
-- it. The old rows are derived, so this does not delete raw activity. Migrations
-- run on every boot, therefore the one-time conversion is gated on the legacy
-- link shape; verified projections created after migration must survive boots.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = current_schema()
       AND table_name = 'eth_activity_links'
       AND column_name = 'movement_id'
  ) THEN
    INSERT INTO eth_bridge_suggestions (
      user_id,
      out_wallet_id, out_chain_id, out_tx_hash,
      in_wallet_id, in_chain_id, in_tx_hash,
      suggestion_reason, ambiguous, evidence, source
    )
    SELECT
      ow.user_id,
      oa.wallet_id, oa.chain_id, oa.tx_hash,
      ia.wallet_id, ia.chain_id, ia.tx_hash,
      'legacy_amount_time_heuristic', TRUE,
      jsonb_build_object(
        'legacy_link_id', l.id,
        'asset', l.asset,
        'out_amount', l.out_amount::text,
        'in_amount', l.in_amount::text,
        'fee_amount', l.fee_amount::text,
        'asset_details', l.asset_details
      ),
      'legacy_migration'
    FROM eth_activity_links l
    JOIN eth_activity oa ON oa.id = l.out_activity_id
    JOIN eth_wallets ow ON ow.id = oa.wallet_id
    JOIN eth_activity ia ON ia.id = l.in_activity_id
    JOIN eth_wallets iw ON iw.id = ia.wallet_id AND iw.user_id = ow.user_id
    WHERE oa.chain_id <> ia.chain_id
    ON CONFLICT DO NOTHING;

    DELETE FROM eth_activity_links;
  END IF;
END $$;

ALTER TABLE eth_activity_links
  ADD COLUMN IF NOT EXISTS movement_id BIGINT REFERENCES eth_bridge_movements(id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS evidence_method VARCHAR(24);

ALTER TABLE eth_activity_links
  ALTER COLUMN movement_id SET NOT NULL,
  ALTER COLUMN evidence_method SET NOT NULL;

ALTER TABLE eth_activity_links
  DROP CONSTRAINT IF EXISTS eth_activity_links_evidence_method_check;
ALTER TABLE eth_activity_links
  ADD CONSTRAINT eth_activity_links_evidence_method_check
    CHECK (evidence_method IN ('protocol_identity', 'user_verdict'));

CREATE OR REPLACE FUNCTION validate_eth_activity_bridge_link()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  movement eth_bridge_movements%ROWTYPE;
  out_owner INTEGER;
  in_owner INTEGER;
BEGIN
  SELECT * INTO movement FROM eth_bridge_movements WHERE id = NEW.movement_id;
  IF movement.id IS NULL
     OR movement.invalidated_at IS NOT NULL
     OR movement.status NOT IN ('protocol_verified', 'user_confirmed')
     OR movement.verification_method <> NEW.evidence_method THEN
    RAISE EXCEPTION 'bridge link requires an active verified or confirmed movement';
  END IF;

  SELECT w.user_id INTO out_owner
    FROM eth_activity a JOIN eth_wallets w ON w.id = a.wallet_id
   WHERE a.id = NEW.out_activity_id;
  SELECT w.user_id INTO in_owner
    FROM eth_activity a JOIN eth_wallets w ON w.id = a.wallet_id
   WHERE a.id = NEW.in_activity_id;
  IF out_owner IS NULL OR in_owner IS NULL
     OR out_owner <> movement.user_id OR in_owner <> movement.user_id THEN
    RAISE EXCEPTION 'bridge link movement and activities must share one owner';
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM eth_activity a
      JOIN eth_bridge_movement_members mm
        ON mm.movement_id = movement.id
       AND mm.wallet_id = a.wallet_id
       AND mm.chain_id = a.chain_id
       AND mm.tx_hash = a.tx_hash
       AND mm.role = 'initiation'
     WHERE a.id = NEW.out_activity_id
  ) OR NOT EXISTS (
    SELECT 1
      FROM eth_activity a
      JOIN eth_bridge_movement_members mm
        ON mm.movement_id = movement.id
       AND mm.wallet_id = a.wallet_id
       AND mm.chain_id = a.chain_id
       AND mm.tx_hash = a.tx_hash
       AND mm.role IN ('destination_execution', 'fill', 'finalization')
     WHERE a.id = NEW.in_activity_id
  ) THEN
    RAISE EXCEPTION 'bridge link activities must be members of the verified movement';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_validate_eth_activity_bridge_link ON eth_activity_links;
CREATE TRIGGER trg_validate_eth_activity_bridge_link
BEFORE INSERT OR UPDATE ON eth_activity_links
FOR EACH ROW EXECUTE FUNCTION validate_eth_activity_bridge_link();

CREATE OR REPLACE FUNCTION remove_invalidated_eth_activity_bridge_links()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.invalidated_at IS NOT NULL
     OR NEW.status NOT IN ('protocol_verified', 'user_confirmed') THEN
    DELETE FROM eth_activity_links WHERE movement_id = NEW.id;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_remove_invalidated_eth_activity_bridge_links ON eth_bridge_movements;
CREATE TRIGGER trg_remove_invalidated_eth_activity_bridge_links
AFTER UPDATE OF status, invalidated_at ON eth_bridge_movements
FOR EACH ROW EXECUTE FUNCTION remove_invalidated_eth_activity_bridge_links();

CREATE OR REPLACE FUNCTION validate_eth_bridge_member_owner()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  movement_owner INTEGER;
  wallet_owner INTEGER;
BEGIN
  SELECT user_id INTO movement_owner FROM eth_bridge_movements WHERE id = NEW.movement_id;
  SELECT user_id INTO wallet_owner FROM eth_wallets WHERE id = NEW.wallet_id;
  IF movement_owner IS NULL OR wallet_owner IS NULL OR movement_owner <> wallet_owner THEN
    RAISE EXCEPTION 'bridge movement member and wallet must share one owner';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_validate_eth_bridge_member_owner ON eth_bridge_movement_members;
CREATE TRIGGER trg_validate_eth_bridge_member_owner
BEFORE INSERT OR UPDATE ON eth_bridge_movement_members
FOR EACH ROW EXECUTE FUNCTION validate_eth_bridge_member_owner();

CREATE OR REPLACE FUNCTION validate_eth_bridge_pair_owner()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  out_owner INTEGER;
  in_owner INTEGER;
BEGIN
  SELECT user_id INTO out_owner FROM eth_wallets WHERE id = NEW.out_wallet_id;
  SELECT user_id INTO in_owner FROM eth_wallets WHERE id = NEW.in_wallet_id;
  IF out_owner IS NULL OR in_owner IS NULL
     OR out_owner <> NEW.user_id OR in_owner <> NEW.user_id THEN
    RAISE EXCEPTION 'bridge pair wallets must belong to the row owner';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_validate_eth_bridge_suggestion_owner ON eth_bridge_suggestions;
CREATE TRIGGER trg_validate_eth_bridge_suggestion_owner
BEFORE INSERT OR UPDATE ON eth_bridge_suggestions
FOR EACH ROW EXECUTE FUNCTION validate_eth_bridge_pair_owner();

DROP TRIGGER IF EXISTS trg_validate_eth_bridge_verdict_owner ON eth_bridge_verdicts;
CREATE TRIGGER trg_validate_eth_bridge_verdict_owner
BEFORE INSERT OR UPDATE ON eth_bridge_verdicts
FOR EACH ROW EXECUTE FUNCTION validate_eth_bridge_pair_owner();

-- BEGIN GENERATED ENDPOINT SEED (backend/scripts/generate-bridge-endpoint-seed.js)
-- 50 chain-scoped endpoints derived from the reviewed first-party pack.
INSERT INTO eth_bridge_endpoints
  (protocol, family_version, chain_id, address, name, role, direction, source_url, metadata)
VALUES
  ('gnosis', 'legacy-xdai', 1, '0x4aa42145aa6ebf72e164c9bbc74fbd3788045016', 'Gnosis: xDAI Bridge (Ethereum)', 'bridge', 'both', 'https://docs.gnosischain.com/bridges/About%20Token%20Bridges/xdai-bridge', '{"docs_name":"xDAI Bridge Contract","researched_on":"2026-07-29"}'::jsonb),
  ('gnosis', 'usds-router', 1, '0x9a873656c19efecbfb4f9fab5b7acdeab466a0b0', 'Gnosis: BridgeRouter (Ethereum)', 'bridge_router', 'both', 'https://docs.gnosischain.com/bridges/About%20Token%20Bridges/xdai-bridge', '{"docs_name":"BridgeRouter Proxy","researched_on":"2026-07-29"}'::jsonb),
  ('gnosis', 'legacy-xdai', 100, '0x7301cfa0e1756b71869e93d4e4dca5c7d0eb0aa6', 'Gnosis: xDAI Bridge', 'bridge', 'both', 'https://docs.gnosischain.com/bridges/About%20Token%20Bridges/xdai-bridge', '{"docs_name":"xDAI Bridge Contract","researched_on":"2026-07-29"}'::jsonb),
  ('gnosis', 'legacy-xdai', 100, '0x481c034c6d9441db23ea48de68bcae812c5d39ba', 'Gnosis: Block Reward Bridge Credit', 'block_reward', 'in', 'https://docs.gnosischain.com/bridges/About%20Token%20Bridges/xdai-bridge', '{"docs_name":"Block Reward Contract","researched_on":"2026-07-29"}'::jsonb),
  ('gnosis', 'usds-router', 100, '0x5c183c8a49aba6e31049997a56d75600e27ff8c9', 'Gnosis: USDS Deposit Contract', 'deposit_contract', 'both', 'https://docs.gnosischain.com/bridges/About%20Token%20Bridges/xdai-bridge', '{"docs_name":"USDSDepositContract","researched_on":"2026-07-29"}'::jsonb),
  ('arbitrum', 'classic-or-nitro', 1, '0x4dbd4fc535ac27206064b68ffcf827b0a60bab3f', 'Arbitrum: Delayed Inbox', 'inbox', 'out', 'https://docs.arbitrum.io/arbitrum-essentials/reference/contract-addresses', '{"docs_name":"Delayed Inbox","researched_on":"2026-07-29"}'::jsonb),
  ('arbitrum', 'classic-or-nitro', 1, '0x8315177ab297ba92a06054ce80a67ed4dbd7ed3a', 'Arbitrum: Bridge', 'bridge', 'both', 'https://docs.arbitrum.io/arbitrum-essentials/reference/contract-addresses', '{"docs_name":"Bridge","researched_on":"2026-07-29"}'::jsonb),
  ('arbitrum', 'nitro', 1, '0x0b9857ae2d4a3dbe74ffe1d7df045bb7f96e4840', 'Arbitrum: Outbox', 'outbox', 'in', 'https://docs.arbitrum.io/arbitrum-essentials/reference/contract-addresses', '{"docs_name":"Outbox","researched_on":"2026-07-29"}'::jsonb),
  ('arbitrum', 'classic-or-nitro', 1, '0x72ce9c846789fdb6fc1f34ac4ad25dd9ef7031ef', 'Arbitrum One: L1 Gateway Router', 'gateway_router', 'both', 'https://docs.arbitrum.io/arbitrum-essentials/reference/contract-addresses', '{"docs_name":"L1 Gateway Router","researched_on":"2026-07-29"}'::jsonb),
  ('arbitrum', 'classic-or-nitro', 1, '0xa3a7b6f88361f48403514059f1f16c8e78d60eec', 'Arbitrum One: L1 ERC20 Gateway', 'token_gateway', 'both', 'https://docs.arbitrum.io/arbitrum-essentials/reference/contract-addresses', '{"docs_name":"L1 ERC20 Gateway","researched_on":"2026-07-29"}'::jsonb),
  ('arbitrum', 'classic-or-nitro', 1, '0xcee284f754e854890e311e3280b767f80797180d', 'Arbitrum One: L1 Arb-Custom Gateway', 'token_gateway', 'both', 'https://docs.arbitrum.io/arbitrum-essentials/reference/contract-addresses', '{"docs_name":"L1 Arb-Custom Gateway","researched_on":"2026-07-29"}'::jsonb),
  ('arbitrum', 'classic-or-nitro', 1, '0xd92023e9d9911199a6711321d1277285e6d4e2db', 'Arbitrum One: L1 WETH Gateway', 'token_gateway', 'both', 'https://docs.arbitrum.io/arbitrum-essentials/reference/contract-addresses', '{"docs_name":"L1 Weth Gateway","researched_on":"2026-07-29"}'::jsonb),
  ('arbitrum', 'classic-or-nitro', 42161, '0x5288c571fd7ad117bea99bf60fe0846c4e84f933', 'Arbitrum One: L2 Gateway Router', 'gateway_router', 'both', 'https://docs.arbitrum.io/arbitrum-essentials/reference/contract-addresses', '{"docs_name":"L2 Gateway Router","researched_on":"2026-07-29"}'::jsonb),
  ('arbitrum', 'classic-or-nitro', 42161, '0x09e9222e96e7b4ae2a407b98d48e330053351eee', 'Arbitrum One: L2 ERC20 Gateway', 'token_gateway', 'both', 'https://docs.arbitrum.io/arbitrum-essentials/reference/contract-addresses', '{"docs_name":"L2 ERC20 Gateway","researched_on":"2026-07-29"}'::jsonb),
  ('arbitrum', 'classic-or-nitro', 42161, '0x096760f208390250649e3e8763348e783aef5562', 'Arbitrum One: L2 Arb-Custom Gateway', 'token_gateway', 'both', 'https://docs.arbitrum.io/arbitrum-essentials/reference/contract-addresses', '{"docs_name":"L2 Arb-Custom Gateway","researched_on":"2026-07-29"}'::jsonb),
  ('arbitrum', 'classic-or-nitro', 42161, '0x6c411ad3e74de3e7bd422b94a27770f5b86c623b', 'Arbitrum One: L2 WETH Gateway', 'token_gateway', 'both', 'https://docs.arbitrum.io/arbitrum-essentials/reference/contract-addresses', '{"docs_name":"L2 Weth Gateway","researched_on":"2026-07-29"}'::jsonb),
  ('arbitrum', 'nitro', 42161, '0x0000000000000000000000000000000000000064', 'Arbitrum: ArbSys', 'system_messenger', 'both', 'https://docs.arbitrum.io/arbitrum-essentials/reference/contract-addresses', '{"docs_name":"ArbSys (precompile)","researched_on":"2026-07-29"}'::jsonb),
  ('arbitrum', 'classic-or-nitro', 42161, '0x000000000000000000000000000000000000006e', 'Arbitrum: ArbRetryableTx', 'retryable_precompile', 'both', 'https://docs.arbitrum.io/build-decentralized-apps/precompiles/reference', '{"docs_name":"ArbRetryableTx (precompile), ''Precompile address: 0x...006E'' on the precompiles reference (source_url) -- the address lives there, not on the protocol''s contract-addresses page. The counterparty of every reshaped classic-era L1->L2 ETH deposit (config/chains.js classicRetryableDeposits), so this label is what classifies those credits bridge_in and lets the matcher pair them with the L1 Delayed Inbox leg.","researched_on":"2026-07-29"}'::jsonb),
  ('linea', 'message-service-v1', 1, '0xd19d4b5d358258f05d7b411e21a1460d11b0876f', 'Linea: L1 Message Service', 'message_service', 'both', 'https://docs.linea.build/network/build/contracts', '{"docs_name":"LineaRollup: Linea Rollup and L1 Message Service","researched_on":"2026-07-29"}'::jsonb),
  ('linea', 'message-service-v1', 1, '0x051f1d88f0af5763fb888ec4378b4d8b29ea3319', 'Linea: L1 Token Bridge', 'token_bridge', 'both', 'https://docs.linea.build/network/build/contracts', '{"docs_name":"L1 Token bridge","researched_on":"2026-07-29"}'::jsonb),
  ('linea', 'message-service-v1', 59144, '0x508ca82df566dcd1b0de8296e70a96332cd644ec', 'Linea: L2 Message Service', 'message_service', 'both', 'https://docs.linea.build/network/build/contracts', '{"docs_name":"L2 Message Service","researched_on":"2026-07-29"}'::jsonb),
  ('linea', 'message-service-v1', 59144, '0x353012dc4a9a6cf55c941badc267f82004a8ceb9', 'Linea: L2 Token Bridge', 'token_bridge', 'both', 'https://docs.linea.build/network/build/contracts', '{"docs_name":"L2 Token bridge","researched_on":"2026-07-29"}'::jsonb),
  ('zksync-lite', 'lite-v1', 1, '0xabea9132b05a70803a4e85094fd0e1800777fbef', 'zkSync Lite: Main Contract', 'rollup_contract', 'both', 'https://docs.lite.zksync.io/api/environments/', '{"docs_name":"zkSync mainnet contract","researched_on":"2026-07-29"}'::jsonb),
  ('zksync', 'era-bridgehub', 1, '0x303a465b659cbb0ab36ee643ea362c509eeb5213', 'ZKsync: Bridgehub', 'bridgehub', 'both', 'https://docs.zksync.io/zksync-protocol/contracts/l1-contracts/zk-chain-addresses', '{"docs_name":"Bridgehub","researched_on":"2026-07-29"}'::jsonb),
  ('zksync', 'era-bridgehub', 1, '0xd7f9f54194c633f36ccd5f3da84ad4a1c38cb2cb', 'ZKsync: Shared Bridge', 'shared_bridge', 'both', 'https://docs.zksync.io/zksync-protocol/contracts/l1-contracts/zk-chain-addresses', '{"docs_name":"Shared Bridge","researched_on":"2026-07-29"}'::jsonb),
  ('zksync', 'era-bridgehub', 1, '0x8829ad80e425c646dab305381ff105169feece56', 'ZKsync: L1 Asset Router', 'asset_router', 'both', 'https://docs.zksync.io/zksync-protocol/contracts/l1-contracts/zk-chain-addresses', '{"docs_name":"L1AssetRouter","researched_on":"2026-07-29"}'::jsonb),
  ('zksync', 'era-bridgehub', 1, '0x32400084c286cf3e17e7b677ea9583e60a000324', 'ZKsync Era: Chain Contract', 'chain_mailbox', 'both', 'https://docs.zksync.io/zksync-protocol/contracts/l1-contracts/zk-chain-addresses', '{"docs_name":"ZKsync Era chain contract","researched_on":"2026-07-29"}'::jsonb),
  ('zksync', 'era-bridgehub', 1, '0x57891966931eb4bb6fb81430e6ce0a03aabde063', 'ZKsync Era: Legacy L1 ERC20 Bridge', 'bridge', 'both', 'https://docs.zksync.io/zksync-protocol/api/zks-rpc', '{"docs_name":"l1Erc20DefaultBridge","researched_on":"2026-07-29"}'::jsonb),
  ('zksync', 'era-bridgehub', 324, '0x11f943b2c77b743ab90f4a0ae7d5a4e7fca3e102', 'ZKsync Era: L2 ERC20 Bridge', 'bridge', 'both', 'https://docs.zksync.io/zksync-protocol/api/zks-rpc', '{"docs_name":"l2Erc20DefaultBridge","researched_on":"2026-07-29"}'::jsonb),
  ('zksync', 'era-bridgehub', 324, '0x000000000000000000000000000000000000800a', 'ZKsync Era: L2 Base Token', 'base_token_system', 'both', 'https://docs.zksync.io/zksync-protocol/era-vm/contracts/system-contracts', '{"docs_name":"L2BaseToken","researched_on":"2026-07-29"}'::jsonb),
  ('optimism', 'bedrock', 1, '0x99c9fc46f92e8a1c0dec1b1747d010903e884be1', 'Optimism: L1 Standard Bridge', 'standard_bridge', 'both', 'https://raw.githubusercontent.com/ethereum-optimism/superchain-registry/main/superchain/extra/addresses/addresses.json', '{"docs_name":"L1StandardBridgeProxy","researched_on":"2026-07-29"}'::jsonb),
  ('optimism', 'bedrock', 1, '0xbeb5fc579115071764c7423a4f12edde41f106ed', 'Optimism: Portal', 'portal', 'both', 'https://raw.githubusercontent.com/ethereum-optimism/superchain-registry/main/superchain/extra/addresses/addresses.json', '{"docs_name":"OptimismPortalProxy","researched_on":"2026-07-29"}'::jsonb),
  ('optimism', 'bedrock', 1, '0x25ace71c97b33cc4729cf772ae268934f7ab5fa1', 'Optimism: L1 Cross Domain Messenger', 'cross_domain_messenger', 'both', 'https://raw.githubusercontent.com/ethereum-optimism/superchain-registry/main/superchain/extra/addresses/addresses.json', '{"docs_name":"L1CrossDomainMessengerProxy","researched_on":"2026-07-29"}'::jsonb),
  ('base', 'bedrock', 1, '0x3154cf16ccdb4c6d922629664174b904d80f2c35', 'Base: L1 Standard Bridge', 'standard_bridge', 'both', 'https://docs.base.org/base-chain/network-information/base-contracts', '{"docs_name":"L1StandardBridge","researched_on":"2026-07-29"}'::jsonb),
  ('base', 'bedrock', 1, '0x49048044d57e1c92a77f79988d21fa8faf74e97e', 'Base: Portal', 'portal', 'both', 'https://docs.base.org/base-chain/network-information/base-contracts', '{"docs_name":"OptimismPortal","researched_on":"2026-07-29"}'::jsonb),
  ('base', 'bedrock', 1, '0x866e82a600a1414e583f7f13623f1ac5d58b0afa', 'Base: L1 Cross Domain Messenger', 'cross_domain_messenger', 'both', 'https://docs.base.org/base-chain/network-information/base-contracts', '{"docs_name":"L1CrossDomainMessenger","researched_on":"2026-07-29"}'::jsonb),
  ('base', 'bedrock', 8453, '0x4200000000000000000000000000000000000010', 'OP Stack: L2 Standard Bridge', 'standard_bridge', 'both', 'https://docs.base.org/base-chain/network-information/base-contracts', '{"docs_name":"L2StandardBridge (predeploy, identical on OP Mainnet and Base)","researched_on":"2026-07-29"}'::jsonb),
  ('base', 'bedrock', 8453, '0x4200000000000000000000000000000000000016', 'OP Stack: L2 To L1 Message Passer', 'message_passer', 'both', 'https://docs.base.org/base-chain/network-information/base-contracts', '{"docs_name":"L2ToL1MessagePasser (predeploy, identical on OP Mainnet and Base)","researched_on":"2026-07-29"}'::jsonb),
  ('across', 'v2-v3', 1, '0x5c7bcd6e7de5423a257d81b442095a1a6ced35c5', 'Across: Ethereum Spoke Pool', 'spoke_pool', 'both', 'https://docs.across.to/chains-and-contracts', '{"docs_name":"SpokePool","researched_on":"2026-07-29"}'::jsonb),
  ('across', 'v2-v3', 42161, '0xe35e9842fceaca96570b734083f4a58e8f7c5f2a', 'Across: Arbitrum Spoke Pool', 'spoke_pool', 'both', 'https://docs.across.to/chains-and-contracts', '{"docs_name":"SpokePool","researched_on":"2026-07-29"}'::jsonb),
  ('across', 'v2-v3', 10, '0x6f26bf09b1c792e3228e5467807a900a503c0281', 'Across: OP Mainnet Spoke Pool', 'spoke_pool', 'both', 'https://docs.across.to/chains-and-contracts', '{"docs_name":"SpokePool","researched_on":"2026-07-29"}'::jsonb),
  ('across', 'v2-v3', 8453, '0x09aea4b2242abc8bb4bb78d537a67a245a7bec64', 'Across: Base Spoke Pool', 'spoke_pool', 'both', 'https://docs.across.to/chains-and-contracts', '{"docs_name":"SpokePool","researched_on":"2026-07-29"}'::jsonb),
  ('across', 'v2-v3', 59144, '0x7e63a5f1a8f0b4d0934b2f2327daed3f6bb2ee75', 'Across: Linea Spoke Pool', 'spoke_pool', 'both', 'https://docs.across.to/chains-and-contracts', '{"docs_name":"SpokePool","researched_on":"2026-07-29"}'::jsonb),
  ('polygon', 'pos-plasma', 1, '0xa0c68c638235ee32657e8f720a23cec1bfc77c77', 'Polygon: PoS Bridge (RootChainManager)', 'root_chain_manager', 'out', 'https://raw.githubusercontent.com/maticnetwork/static/master/network/mainnet/v1/index.json', '{"docs_name":"RootChainManagerProxy","researched_on":"2026-07-29"}'::jsonb),
  ('polygon', 'pos-plasma', 1, '0x8484ef722627bf18ca5ae6bcf031c23e6e922b30', 'Polygon: PoS Ether Predicate', 'predicate', 'out', 'https://raw.githubusercontent.com/maticnetwork/static/master/network/mainnet/v1/index.json', '{"docs_name":"EtherPredicateProxy","researched_on":"2026-07-29"}'::jsonb),
  ('polygon', 'pos-plasma', 1, '0x40ec5b33f54e0e8a33a975908c5ba1c14e5bbbdf', 'Polygon: PoS ERC20 Predicate', 'predicate', 'out', 'https://raw.githubusercontent.com/maticnetwork/static/master/network/mainnet/v1/index.json', '{"docs_name":"ERC20PredicateProxy","researched_on":"2026-07-29"}'::jsonb),
  ('polygon', 'pos-plasma', 1, '0x401f6c983ea34274ec46f84d70b31c151321188b', 'Polygon: Plasma Deposit Manager', 'deposit_manager', 'out', 'https://raw.githubusercontent.com/maticnetwork/static/master/network/mainnet/v1/index.json', '{"docs_name":"Main.Contracts.DepositManagerProxy","researched_on":"2026-07-29"}'::jsonb),
  ('polygon', 'pos-plasma', 137, '0x0000000000000000000000000000000000001010', 'Polygon: MRC20 (Native POL / State Sync)', 'state_sync_token', 'in', 'https://raw.githubusercontent.com/maticnetwork/static/master/network/mainnet/v1/index.json', '{"docs_name":"Matic.Contracts.Tokens.MaticToken (MRC20 precompile)","researched_on":"2026-07-29"}'::jsonb),
  ('optimism', 'bedrock', 10, '0x4200000000000000000000000000000000000010', 'Optimism: L2 Standard Bridge', 'standard_bridge', 'both', 'https://raw.githubusercontent.com/ethereum-optimism/superchain-registry/main/superchain/extra/addresses/addresses.json', '{"docs_name":"L2StandardBridge (predeploy, identical on OP Mainnet and Base)","researched_on":"2026-07-29"}'::jsonb),
  ('optimism', 'bedrock', 10, '0x4200000000000000000000000000000000000016', 'Optimism: L2 To L1 Message Passer', 'message_passer', 'both', 'https://raw.githubusercontent.com/ethereum-optimism/superchain-registry/main/superchain/extra/addresses/addresses.json', '{"docs_name":"L2ToL1MessagePasser (predeploy, identical on OP Mainnet and Base)","researched_on":"2026-07-29"}'::jsonb)
ON CONFLICT (protocol, family_version, chain_id, address, role) DO NOTHING;
-- END GENERATED ENDPOINT SEED

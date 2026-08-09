-- 082: retire Base Mainnet (8453) wallet/audit/accounting support.
--
-- This is deliberately idempotent. It removes chain-owned wallet, bridge and
-- audit evidence while preserving exchange history: exchange_records.network
-- and its raw/source provenance remain, but the retired normalized chain id is
-- cleared rather than pretending the record is still supported on-chain.

BEGIN;

-- Human corrections and derived bridge projections must be removed before the
-- raw activity they reference. The bridge endpoint/route registries are also
-- chain-owned configuration, not user financial history.
DELETE FROM eth_bridge_verdicts
 WHERE out_chain_id = 8453 OR in_chain_id = 8453;
DELETE FROM eth_bridge_suggestions
 WHERE out_chain_id = 8453 OR in_chain_id = 8453;
DELETE FROM eth_bridge_movements
 WHERE protocol = 'base'
    OR id IN (
      SELECT movement_id
        FROM eth_bridge_movement_members
       WHERE chain_id = 8453
    );
DELETE FROM eth_bridge_movement_members
 WHERE chain_id = 8453;
DELETE FROM eth_bridge_receipt_attempts
 WHERE chain_id = 8453;
DELETE FROM eth_bridge_receipts
 WHERE chain_id = 8453;
DELETE FROM eth_hop_bridge_routes
 WHERE source_chain_id = 8453 OR destination_chain_id = 8453;
DELETE FROM eth_bridge_endpoints
 WHERE chain_id = 8453 OR protocol = 'base';

DELETE FROM eth_discovery_fetches WHERE chain_id = 8453;
DELETE FROM eth_discovery_candidates WHERE chain_id = 8453;

DELETE FROM eth_activity_overrides WHERE chain_id = 8453;
DELETE FROM eth_reconciliation_adjustments WHERE chain_id = 8453;
DELETE FROM eth_reconciliation WHERE chain_id = 8453;
DELETE FROM eth_feed_coverage WHERE chain_id = 8453;

-- The raw transfer delete cascades the mirrored transaction, activity links,
-- exchange matches and all other wallet-owned derived rows. Delete the
-- chain-scoped activity first so standalone evidence rows cannot survive a
-- transfer that was already removed by an earlier partial rollout.
DELETE FROM eth_activity WHERE chain_id = 8453;
DELETE FROM eth_transfers WHERE chain_id = 8453;
DELETE FROM eth_wallet_chains WHERE chain_id = 8453;
DELETE FROM holdings WHERE chain_id = 8453;
DELETE FROM transactions WHERE chain_id = 8453;

-- On-chain exchange-match verdicts are not exchange history; they point at the
-- retired wallet chain and must not remain actionable after its removal.
DELETE FROM exchange_match_verdicts WHERE chain_id = 8453;

-- EVM audit evidence is chain-scoped. Child tables are removed before their
-- job/scope roots; foreign-key cascades then clear pages and join rows.
DELETE FROM evm_transaction_evidence WHERE chain_id = 8453;
DELETE FROM evm_effect_evidence WHERE chain_id = 8453;
DELETE FROM evm_canonical_effects WHERE chain_id = 8453;
DELETE FROM evm_balance_audits WHERE chain_id = 8453;
DELETE FROM evm_nonce_audits WHERE chain_id = 8453;
DELETE FROM evm_mined_transactions WHERE chain_id = 8453;
DELETE FROM evm_job_observations WHERE chain_id = 8453;
DELETE FROM evm_provider_observations WHERE chain_id = 8453;
DELETE FROM evm_source_coverage WHERE chain_id = 8453;
DELETE FROM evm_audit_scopes WHERE chain_id = 8453;

-- Mixed-chain audit jobs remain valid with the retired chain removed from the
-- requested/discovered sets. A job that becomes empty has no remaining work.
UPDATE evm_audit_jobs
   SET requested_chains = COALESCE((
         SELECT jsonb_agg(value ORDER BY ord)
           FROM jsonb_array_elements(requested_chains) WITH ORDINALITY AS item(value, ord)
          WHERE trim(both '"' from value::text) <> '8453'
       ), '[]'::jsonb),
       discovered_chains = COALESCE((
         SELECT jsonb_agg(value ORDER BY ord)
           FROM jsonb_array_elements(discovered_chains) WITH ORDINALITY AS item(value, ord)
          WHERE trim(both '"' from value::text) <> '8453'
       ), '[]'::jsonb),
       updated_at = CURRENT_TIMESTAMP
 WHERE requested_chains @> '[8453]'::jsonb
    OR discovered_chains @> '[8453]'::jsonb;
DELETE FROM evm_audit_jobs WHERE requested_chains = '[]'::jsonb;

-- These objects existed only for the retired provider/chain implementation on
-- upgraded databases. DROP COLUMN is safe when a deployment never reached
-- that migration, and Postgres removes their dependent indexes/constraints.
ALTER TABLE evm_audit_jobs DROP COLUMN IF EXISTS cdp_credential_generation;
ALTER TABLE eth_wallet_chains
  DROP COLUMN IF EXISTS provider_cursor,
  DROP COLUMN IF EXISTS provider_scan_id,
  DROP COLUMN IF EXISTS provider_scan_head,
  DROP COLUMN IF EXISTS provider_scan_head_hash,
  DROP COLUMN IF EXISTS provider_scan_order,
  DROP COLUMN IF EXISTS provider_scan_started_at,
  DROP COLUMN IF EXISTS provider_scan_status,
  DROP COLUMN IF EXISTS provider_scan_owner,
  DROP COLUMN IF EXISTS provider_scan_lease_expires_at,
  DROP COLUMN IF EXISTS provider_last_page_at;

DROP TABLE IF EXISTS eth_provider_pages;
DROP TABLE IF EXISTS evm_retired_feed_coverage;

-- Remove credentials for the retired wallet provider, but not Coinbase
-- exchange credentials or exchange records.
DELETE FROM user_api_keys WHERE service = 'cdp';
ALTER TABLE user_api_keys DROP CONSTRAINT IF EXISTS user_api_keys_service_check;
ALTER TABLE user_api_keys
  ADD CONSTRAINT user_api_keys_service_check
  CHECK (service IN ('plaid_client_id', 'plaid_secret', 'etherscan', 'moralis'));

-- The address-label schema predates chain identity. Only labels explicitly
-- named for Base are safe to remove; shared OP Stack predeploy labels remain
-- because they are still valid for OP Mainnet (10).
DELETE FROM eth_address_labels
 WHERE user_id IS NULL AND source = 'builtin-bridge'
   AND (name LIKE 'Base:%' OR name = 'Across: Base Spoke Pool');

-- Preserve exchange rows and their original network/source text while clearing
-- the normalized id that no longer has a supported wallet provider.
UPDATE exchange_records
   SET chain_id = NULL
 WHERE chain_id = 8453;

COMMIT;

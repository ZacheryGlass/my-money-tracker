-- 082: retire the obsolete Coinbase CDP provider implementation.
--
-- Base Mainnet (8453) is supported again through the generic account-feed and
-- consensus-RPC paths. This migration intentionally preserves every Base
-- wallet, transfer, activity, bridge, reconciliation, audit, discovery,
-- exchange, and label row. Migrations run on every application start, so any
-- chain-data cleanup here would delete a later Base recovery repeatedly.

BEGIN;

-- These objects belonged only to the retired CDP paging implementation. The
-- generic provider path does not read them. IF EXISTS keeps upgraded and fresh
-- databases on the same schema without touching financial or audit evidence.
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

-- CDP is no longer an accepted wallet-history credential. Coinbase exchange
-- credentials and every exchange record remain untouched.
DELETE FROM user_api_keys WHERE service = 'cdp';
ALTER TABLE user_api_keys DROP CONSTRAINT IF EXISTS user_api_keys_service_check;
ALTER TABLE user_api_keys
  ADD CONSTRAINT user_api_keys_service_check
  CHECK (service IN ('plaid_client_id', 'plaid_secret', 'etherscan', 'moralis'));

COMMIT;

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const migrationPath = path.join(__dirname, '..', 'migrations', '082_retire_base_chain.sql');
const migration = fs.readFileSync(migrationPath, 'utf8');
const sql = migration.replace(/--[^\n]*/g, '').replace(/\s+/g, ' ').trim();
const indexMigrationPath = path.join(
  __dirname, '..', 'migrations', '081a_evm_observation_fk_indexes.sql'
);
const indexMigration = fs.readFileSync(indexMigrationPath, 'utf8');
const indexSql = indexMigration.replace(/--[^\n]*/g, '').replace(/\s+/g, ' ').trim();
const providerIdentityMigration = fs.readFileSync(
  path.join(__dirname, '..', 'migrations', '080_provider_evidence_identity.sql'), 'utf8'
);
const chains = require('../src/config/chains');

test('provider observation foreign keys are indexed before provider cleanup', () => {
  assert.ok(path.basename(indexMigrationPath) < path.basename(migrationPath));
  assert.match(indexSql, /^BEGIN; .* COMMIT;$/);

  for (const [table, columns] of [
    ['evm_job_observations', 'observation_id, subject_id, chain_id'],
    ['evm_effect_evidence', 'observation_id, subject_id, chain_id'],
    ['evm_transaction_evidence', 'observation_id, subject_id, chain_id'],
    ['eth_transfers', 'audit_observation_id'],
    ['evm_canonical_effects', 'selected_observation_id, subject_id, chain_id'],
    ['evm_mined_transactions', 'selected_observation_id, subject_id, chain_id'],
  ]) {
    assert.match(
      indexSql,
      new RegExp(`CREATE INDEX IF NOT EXISTS \\w+ ON ${table}\\(${columns}\\)`),
      `${table} foreign key index`
    );
  }

  assert.doesNotMatch(indexSql, /DROP (?:CONSTRAINT|INDEX)|DISABLE/);
});

test('retired CDP migration is transactional and repeat-safe', () => {
  assert.match(migration, /^-- 082: retire the obsolete Coinbase CDP provider implementation/m);
  assert.match(sql, /^BEGIN; .* COMMIT;$/);
  assert.match(sql, /DROP TABLE IF EXISTS eth_provider_pages/);
  assert.match(sql, /DROP TABLE IF EXISTS evm_retired_feed_coverage/);
  assert.match(sql, /DROP COLUMN IF EXISTS cdp_credential_generation/);
  assert.match(sql, /DROP CONSTRAINT IF EXISTS user_api_keys_service_check/);
  assert.match(sql, /DELETE FROM user_api_keys WHERE service = 'cdp'/);
  assert.match(sql, /ADD CONSTRAINT user_api_keys_service_check/);
});

test('retired CDP migration preserves every Base chain data surface', () => {
  for (const table of [
    'eth_bridge_verdicts', 'eth_bridge_suggestions', 'eth_bridge_movement_members',
    'eth_bridge_receipt_attempts', 'eth_bridge_receipts', 'eth_hop_bridge_routes',
    'eth_bridge_endpoints', 'eth_discovery_fetches', 'eth_discovery_candidates',
    'eth_activity_overrides', 'eth_reconciliation_adjustments', 'eth_reconciliation',
    'eth_feed_coverage', 'eth_activity', 'eth_transfers', 'eth_wallet_chains',
    'holdings', 'transactions', 'exchange_match_verdicts',
    'evm_transaction_evidence', 'evm_effect_evidence', 'evm_canonical_effects',
    'evm_balance_audits', 'evm_nonce_audits', 'evm_mined_transactions',
    'evm_job_observations', 'evm_provider_observations', 'evm_source_coverage',
    'evm_audit_scopes',
  ]) {
    assert.doesNotMatch(sql, new RegExp(`(?:DELETE FROM|UPDATE) ${table}\\b`), table);
  }
  assert.doesNotMatch(sql, /8453/);
  assert.doesNotMatch(sql, /requested_chains|discovered_chains/);
});

test('Base uses generic bounded feeds and consensus RPC without CDP', () => {
  const base = chains.getChain(8453);
  assert.equal(base.name, 'Base');
  assert.equal(base.enabledByDefault, true);
  assert.equal(base.historyProvider, undefined);
  assert.equal(base.accountApi.provider, 'Blockscout');
  assert.equal(base.accountApi.baseUrl, 'https://base.blockscout.com/api');
  assert.equal(base.accountApi.requiresApiKey, false);
  assert.equal(base.rpcUrl, 'https://mainnet.base.org');
  assert.equal(base.consensusRpcUrl, 'https://mainnet.base.org');
  assert.equal(base.ingestVersion, 3);
  assert.ok(base.opStackDeposits);
  assert.ok(base.stateSyncDeposits);
});

test('retired provider-page identity migration is safe on fresh installs', () => {
  assert.match(providerIdentityMigration, /IF to_regclass\('eth_provider_pages'\) IS NOT NULL/);
  assert.doesNotMatch(providerIdentityMigration, /^ALTER TABLE eth_provider_pages/m);
  assert.doesNotMatch(providerIdentityMigration, /^UPDATE eth_provider_pages/m);
});

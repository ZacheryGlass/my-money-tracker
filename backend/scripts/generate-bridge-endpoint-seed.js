#!/usr/bin/env node
'use strict';

// Builds the chain-scoped decoder-routing registry in migration 072 from the
// already reviewed first-party bridge address pack. Unlike the historical
// address-label seed, chain id is part of identity here, so shared OP Stack
// predeploys are intentionally present once per chain.

const fs = require('fs');
const path = require('path');

const PACK_PATH = path.join(__dirname, '../data/builtin-bridge-labels.json');
const MIGRATION_PATH = path.join(__dirname, '../migrations/072_evidence_first_bridge_matching.sql');
const START = '-- BEGIN GENERATED ENDPOINT SEED (backend/scripts/generate-bridge-endpoint-seed.js)';
const END = '-- END GENERATED ENDPOINT SEED';

const quote = (value) => `'${String(value).replace(/'/g, "''")}'`;

function familyVersion(entry) {
  if (entry.protocol === 'optimism') return 'bedrock';
  if (entry.protocol === 'linea') return 'message-service-v1';
  if (entry.protocol === 'across') return 'v2-v3';
  if (entry.protocol === 'polygon') return 'pos-plasma';
  if (entry.protocol === 'zksync-lite') return 'lite-v1';
  if (entry.protocol === 'zksync') return 'era-bridgehub';
  if (entry.protocol === 'gnosis') {
    return /router|usds/i.test(entry.name) ? 'usds-router' : 'legacy-xdai';
  }
  if (entry.protocol === 'arbitrum') {
    return /arbsys|outbox/i.test(entry.name) ? 'nitro' : 'classic-or-nitro';
  }
  throw new Error(`No bridge family version for ${entry.protocol}`);
}

function role(entry) {
  const name = entry.name.toLowerCase();
  const roles = [
    ['message passer', 'message_passer'], ['message service', 'message_service'],
    ['spoke pool', 'spoke_pool'], ['standard bridge', 'standard_bridge'],
    ['asset router', 'asset_router'], ['gateway router', 'gateway_router'],
    ['erc20 gateway', 'token_gateway'], ['custom gateway', 'token_gateway'],
    ['weth gateway', 'token_gateway'], ['delayed inbox', 'inbox'],
    ['outbox', 'outbox'], ['arbsys', 'system_messenger'],
    ['retryable', 'retryable_precompile'], ['portal', 'portal'],
    ['cross domain messenger', 'cross_domain_messenger'],
    ['bridgehub', 'bridgehub'], ['chain contract', 'chain_mailbox'],
    ['base token', 'base_token_system'], ['token bridge', 'token_bridge'],
    ['shared bridge', 'shared_bridge'], ['main contract', 'rollup_contract'],
    ['rootchainmanager', 'root_chain_manager'], ['ether predicate', 'predicate'],
    ['erc20 predicate', 'predicate'], ['deposit manager', 'deposit_manager'],
    ['mrc20', 'state_sync_token'], ['block reward', 'block_reward'],
    ['deposit contract', 'deposit_contract'], ['bridgerouter', 'bridge_router'],
    ['bridge', 'bridge'],
  ];
  return roles.find(([needle]) => name.includes(needle))?.[1] || 'bridge_endpoint';
}

function direction(entry) {
  const endpointRole = role(entry);
  if (['inbox', 'deposit_manager', 'root_chain_manager', 'predicate'].includes(endpointRole)) return 'out';
  if (['outbox', 'block_reward', 'state_sync_token'].includes(endpointRole)) return 'in';
  return 'both';
}

function endpointRows(pack) {
  const rows = pack.labels.map((entry) => ({
    ...entry,
    family_version: familyVersion(entry),
    role: role(entry),
    direction: direction(entry),
    source_url: entry.source_url || pack.sources[entry.protocol],
  }));

  const seen = new Set();
  for (const entry of rows) {
    const key = [entry.protocol, entry.family_version, entry.chain_id, entry.address, entry.role].join(':');
    if (seen.has(key)) throw new Error(`Duplicate bridge endpoint ${key}`);
    seen.add(key);
    if (!/^0x[0-9a-f]{40}$/.test(entry.address)) throw new Error(`Invalid address ${entry.address}`);
    if (!Number.isInteger(entry.chain_id)) throw new Error(`Invalid chain ${entry.chain_id}`);
    if (!/^https:\/\//.test(entry.source_url)) throw new Error(`Invalid source ${entry.source_url}`);
  }
  return rows;
}

function buildSeed(pack) {
  const rows = endpointRows(pack);
  const values = rows.map((entry, index) => {
    const metadata = JSON.stringify({
      docs_name: entry.docs_name || null,
      researched_on: pack.researchedOn,
    });
    return `  (${quote(entry.protocol)}, ${quote(entry.family_version)}, ${entry.chain_id}, ${quote(entry.address)}, ${quote(entry.name)}, ${quote(entry.role)}, ${quote(entry.direction)}, ${quote(entry.source_url)}, ${quote(metadata)}::jsonb)${index === rows.length - 1 ? '' : ','}`;
  });
  return [
    START,
    `-- ${rows.length} chain-scoped endpoints derived from the reviewed first-party pack.`,
    'INSERT INTO eth_bridge_endpoints',
    '  (protocol, family_version, chain_id, address, name, role, direction, source_url, metadata)',
    'VALUES',
    ...values,
    'ON CONFLICT (protocol, family_version, chain_id, address, role) DO NOTHING;',
    END,
  ].join('\n');
}

function main() {
  const pack = JSON.parse(fs.readFileSync(PACK_PATH, 'utf8'));
  const migration = fs.readFileSync(MIGRATION_PATH, 'utf8');
  const start = migration.indexOf(START);
  const end = migration.indexOf(END, start);
  if (start < 0 || end < 0) throw new Error('Migration seed markers are missing');
  const output = `${migration.slice(0, start)}${buildSeed(pack)}${migration.slice(end + END.length)}`;
  fs.writeFileSync(MIGRATION_PATH, output);
  process.stdout.write(`Wrote ${endpointRows(pack).length} chain-scoped bridge endpoints\n`);
}

if (require.main === module) main();

module.exports = { buildSeed, endpointRows, familyVersion, role, direction, START, END };

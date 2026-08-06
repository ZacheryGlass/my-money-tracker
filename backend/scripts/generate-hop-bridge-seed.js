#!/usr/bin/env node
'use strict';

// Builds the Hop-specific, chain/deployment/asset-scoped registry. Hop is not
// placed in eth_address_labels because the same address can mean different
// contracts on different chains and because asset routes are part of identity.

const fs = require('fs');
const path = require('path');

const PACK_PATH = path.join(__dirname, '../data/hop-bridge-registry.json');
const MIGRATION_PATH = path.join(__dirname, '../migrations/074_hop_bridge_matching.sql');
const START = '-- BEGIN GENERATED HOP SEED (backend/scripts/generate-hop-bridge-seed.js)';
const END = '-- END GENERATED HOP SEED';
const ADDRESS_RE = /^0x[0-9a-f]{40}$/;

const quote = (value) => `'${String(value).replace(/'/g, "''")}'`;
const json = (value) => `${quote(JSON.stringify(value))}::jsonb`;
const lower = (value) => String(value || '').toLowerCase();

function assertAddress(value, label) {
  if (!ADDRESS_RE.test(lower(value))) throw new Error(`Invalid ${label}: ${value}`);
  return lower(value);
}

function chainRows(pack) {
  const rows = [];
  for (const asset of pack.assets || []) {
    const l1 = asset.l1;
    assertAddress(l1.canonicalToken, `${asset.assetKey} L1 canonical token`);
    assertAddress(l1.bridge, `${asset.assetKey} L1 bridge`);
    rows.push({
      asset_key: asset.assetKey,
      chain_id: Number(l1.chainId),
      name: 'Ethereum',
      canonical_token: lower(l1.canonicalToken),
      hop_token: null,
      bridge: lower(l1.bridge),
      wrapper: null,
      valid_from_block: Number(l1.validFromBlock),
      is_l1: true,
    });
    for (const chain of asset.chains || []) {
      for (const [field, label] of [
        ['canonicalToken', 'canonical token'], ['hopToken', 'Hop token'],
        ['bridge', 'bridge'], ['wrapper', 'AMM wrapper'],
      ]) assertAddress(chain[field], `${asset.assetKey} ${chain.name} ${label}`);
      rows.push({
        asset_key: asset.assetKey,
        chain_id: Number(chain.chainId),
        name: chain.name,
        canonical_token: lower(chain.canonicalToken),
        hop_token: lower(chain.hopToken),
        bridge: lower(chain.bridge),
        wrapper: lower(chain.wrapper),
        valid_from_block: Number(chain.validFromBlock),
        is_l1: false,
      });
    }
  }
  return rows;
}

function endpointRows(pack) {
  const rows = [];
  const seen = new Set();
  for (const chain of chainRows(pack)) {
    const endpoints = [
      { address: chain.bridge, name: `Hop v1 ${chain.asset_key} bridge`, role: 'bridge', direction: 'both' },
      ...(chain.wrapper ? [{
        address: chain.wrapper, name: `Hop v1 ${chain.asset_key} AMM wrapper`,
        role: 'amm_wrapper', direction: 'out',
      }] : []),
    ];
    for (const entry of endpoints) {
      const key = ['hop', pack.familyVersion, chain.chain_id, entry.address, entry.role].join(':');
      if (seen.has(key)) continue;
      seen.add(key);
      rows.push({
        protocol: 'hop',
        family_version: pack.familyVersion,
        chain_id: chain.chain_id,
        address: entry.address,
        name: entry.name,
        role: entry.role,
        direction: entry.direction,
        valid_from_block: chain.valid_from_block,
        source_url: pack.sourceUrl,
        metadata: {
          deployment_key: pack.deploymentKey,
          asset_key: chain.asset_key,
          abi_variant: pack.abiVariant,
          source_commit: pack.sourceCommit,
          researched_on: pack.researchedOn,
        },
      });
    }
  }
  return rows;
}

function routeRows(pack) {
  const rows = [];
  for (const asset of pack.assets || []) {
    const destinations = [
      {
        asset_key: asset.assetKey,
        chain_id: Number(asset.l1.chainId),
        name: 'Ethereum',
        canonical_token: lower(asset.l1.canonicalToken),
        hop_token: null,
        bridge: lower(asset.l1.bridge),
        wrapper: null,
        valid_from_block: Number(asset.l1.validFromBlock),
        is_l1: true,
      },
      ...(asset.chains || []).map((chain) => ({
        asset_key: asset.assetKey,
        chain_id: Number(chain.chainId),
        name: chain.name,
        canonical_token: lower(chain.canonicalToken),
        hop_token: lower(chain.hopToken),
        bridge: lower(chain.bridge),
        wrapper: lower(chain.wrapper),
        valid_from_block: Number(chain.validFromBlock),
        is_l1: false,
      })),
    ];
    for (const source of asset.chains || []) {
      for (const destination of destinations) {
        if (source.chainId === destination.chain_id) continue;
        rows.push({
          deployment_key: pack.deploymentKey,
          family_version: pack.familyVersion,
          route_key: `${asset.assetKey}:${source.chainId}->${destination.chain_id}`,
          asset_key: asset.assetKey,
          source_chain_id: Number(source.chainId),
          destination_chain_id: Number(destination.chain_id),
          source_bridge_address: lower(source.bridge),
          source_wrapper_address: lower(source.wrapper),
          destination_bridge_address: lower(destination.bridge),
          destination_wrapper_address: destination.wrapper,
          source_asset_addresses: [lower(source.canonicalToken), lower(source.hopToken)],
          destination_asset_addresses: destination.is_l1
            ? [lower(destination.canonical_token)]
            : [lower(destination.canonical_token), lower(destination.hop_token)],
          source_token_indices: [0, 1],
          destination_token_indices: [0, 1],
          source_valid_from_block: Number(source.validFromBlock),
          source_valid_to_block: null,
          destination_valid_from_block: Number(destination.valid_from_block),
          destination_valid_to_block: null,
          abi_variant: pack.abiVariant,
          finality_policy: pack.finalityPolicy,
          source_url: pack.sourceUrl,
          source_commit: pack.sourceCommit,
          metadata: {
            researched_on: pack.researchedOn,
            source_chain_name: source.name,
            destination_chain_name: destination.name,
            source_kind: 'l2',
            destination_kind: destination.is_l1 ? 'l1' : 'l2',
          },
        });
      }
    }
  }
  return rows;
}

function endpointSeed(pack) {
  const rows = endpointRows(pack);
  const values = rows.map((entry, index) => `  (${[
    quote(entry.protocol), quote(entry.family_version), entry.chain_id,
    quote(entry.address), quote(entry.name), quote(entry.role), quote(entry.direction),
    entry.valid_from_block, 'NULL', quote(entry.source_url), json(entry.metadata),
  ].join(', ')})${index === rows.length - 1 ? '' : ','}`);
  return [
    `-- ${rows.length} chain-scoped Hop endpoints from the reviewed registry.`,
    'INSERT INTO eth_bridge_endpoints',
    '  (protocol, family_version, chain_id, address, name, role, direction,',
    '   valid_from_block, valid_to_block, source_url, metadata)',
    'VALUES',
    ...values,
    'ON CONFLICT (protocol, family_version, chain_id, address, role) DO NOTHING;',
  ].join('\n');
}

function routeSeed(pack) {
  const rows = routeRows(pack);
  const values = rows.map((entry, index) => `  (${[
    quote(entry.deployment_key), quote(entry.family_version), quote(entry.route_key),
    quote(entry.asset_key), entry.source_chain_id, entry.destination_chain_id,
    quote(entry.source_bridge_address), quote(entry.source_wrapper_address),
    quote(entry.destination_bridge_address), entry.destination_wrapper_address
      ? quote(entry.destination_wrapper_address) : 'NULL',
    json(entry.source_asset_addresses), json(entry.destination_asset_addresses),
    json(entry.source_token_indices), json(entry.destination_token_indices),
    entry.source_valid_from_block, entry.source_valid_to_block == null
      ? 'NULL' : entry.source_valid_to_block,
    entry.destination_valid_from_block, entry.destination_valid_to_block == null
      ? 'NULL' : entry.destination_valid_to_block,
    quote(entry.abi_variant), json(entry.finality_policy), quote(entry.source_url),
    quote(entry.source_commit), json(entry.metadata),
  ].join(', ')})${index === rows.length - 1 ? '' : ','}`);
  return [
    `-- ${rows.length} Hop v1 asset/chain routes from the reviewed registry.`,
    'INSERT INTO eth_hop_bridge_routes',
    '  (deployment_key, family_version, route_key, asset_key,',
    '   source_chain_id, destination_chain_id,',
    '   source_bridge_address, source_wrapper_address,',
    '   destination_bridge_address, destination_wrapper_address,',
    '   source_asset_addresses, destination_asset_addresses,',
    '   source_token_indices, destination_token_indices,',
    '   source_valid_from_block, source_valid_to_block,',
    '   destination_valid_from_block, destination_valid_to_block,',
    '   abi_variant, finality_policy, source_url, source_commit, metadata)',
    'VALUES',
    ...values,
    'ON CONFLICT (deployment_key, family_version, route_key) DO NOTHING;',
  ].join('\n');
}

function buildSeed(pack) {
  return [START, endpointSeed(pack), routeSeed(pack), END].join('\n');
}

function main() {
  const pack = JSON.parse(fs.readFileSync(PACK_PATH, 'utf8'));
  const migration = fs.readFileSync(MIGRATION_PATH, 'utf8');
  const start = migration.indexOf(START);
  const end = migration.indexOf(END, start);
  if (start < 0 || end < 0) throw new Error('Hop migration seed markers are missing');
  const output = `${migration.slice(0, start)}${buildSeed(pack)}${migration.slice(end + END.length)}`;
  fs.writeFileSync(MIGRATION_PATH, output);
  process.stdout.write(`Wrote ${endpointRows(pack).length} Hop endpoints and ${routeRows(pack).length} routes\n`);
}

if (require.main === module) main();

module.exports = { buildSeed, chainRows, endpointRows, routeRows, START, END };

#!/usr/bin/env node
'use strict';

// Builds the chain-scoped decoder-routing registry in migration 072 from the
// already reviewed first-party bridge address pack. Unlike the historical
// address-label seed, chain id is part of identity here, so shared OP Stack
// predeploys are intentionally present once per chain.

const fs = require('fs');
const path = require('path');
const { writeSeedDelta } = require('./lib/seedDelta');

const PACK_PATH = path.join(__dirname, '../data/builtin-bridge-labels.json');
const START = '-- BEGIN GENERATED ENDPOINT SEED (backend/scripts/generate-bridge-endpoint-seed.js)';
const END = '-- END GENERATED ENDPOINT SEED';

const quote = (value) => `'${String(value).replace(/'/g, "''")}'`;

// Each pack row states its own bridge family, endpoint role and direction
// (data/builtin-bridge-labels.json); nothing is inferred from its name.
function required(entry, field) {
  const value = entry[field];
  if (typeof value !== 'string' || !value) {
    throw new Error(`Bridge pack row ${entry.address} (${entry.name}) has no ${field}`);
  }
  return value;
}

const familyVersion = (entry) => required(entry, 'family_version');
const role = (entry) => required(entry, 'role');
function direction(entry) {
  const value = required(entry, 'direction');
  if (!['in', 'out', 'both'].includes(value)) throw new Error(`Bridge pack row ${entry.address} has direction ${value}`);
  return value;
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

// Never rewrites an applied migration: a pack change becomes the next
// migration (full block + updates + tombstones), see scripts/lib/seedDelta.js.
const DELTA_SPECS = {
  eth_bridge_endpoints: {
    key: ['protocol', 'family_version', 'chain_id', 'address', 'role'],
    // Hop endpoints share the table and belong to generate-hop-bridge-seed.js.
    scope: "protocol <> 'hop'",
  },
};

function main() {
  const pack = JSON.parse(fs.readFileSync(PACK_PATH, 'utf8'));
  const result = writeSeedDelta({
    start: START,
    end: END,
    desiredBlock: buildSeed(pack),
    stem: 'bridge_endpoint_seed_delta',
    header: '-- Chain-scoped bridge endpoint registry delta.\n'
      + '-- GENERATED FILE -- run backend/scripts/generate-bridge-endpoint-seed.js, do not edit.',
    specs: DELTA_SPECS,
  });
  process.stdout.write(result.written
    ? `Wrote ${path.basename(result.written)}: ${JSON.stringify(result.summary)}\n`
    : `Endpoint seed is up to date (${result.latest})\n`);
}

if (require.main === module) main();

module.exports = { buildSeed, endpointRows, familyVersion, role, direction, START, END, DELTA_SPECS };

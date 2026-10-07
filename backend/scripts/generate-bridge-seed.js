#!/usr/bin/env node
'use strict';

// Seeds the builtin bridge label pack from data/builtin-bridge-labels.json.
// Run after editing the JSON:
//
//   node backend/scripts/generate-bridge-seed.js
//
// Unlike 036's generator this reads a COMMITTED, hand-curated list rather than
// a 21MB dump -- the JSON is the record of the research, not a cache of it. The
// generator exists so the migrations and the JSON cannot drift: a test asserts
// the newest generated block equals buildSeed(pack) byte for byte, which is the
// only thing standing between "someone hand-edited an address into the SQL"
// and a silent wrong verdict on real money.
//
// The pack first shipped in 044. A change never rewrites an applied migration;
// it becomes the next migration (scripts/lib/seedDelta.js).

const fs = require('fs');
const path = require('path');
const { writeSeedDelta } = require('./lib/seedDelta');

const PACK_PATH = path.join(__dirname, '../data/builtin-bridge-labels.json');

// Everything between these lines in the migration is generated.
const SEED_MARKER = '-- BEGIN GENERATED SEED (backend/scripts/generate-bridge-seed.js)';
const SEED_END = '-- END GENERATED SEED (backend/scripts/generate-bridge-seed.js)';

const ADDRESS_RE = /^0x[0-9a-f]{40}$/;
const NAME_MAX = 64;

// Only doubling single quotes is enough BECAUSE nothing else can get in: every
// name and URL below is validated against a strict allowlist first. A
// backslash would be an escape character with standard_conforming_strings off,
// and a newline would split a VALUES row in two.
const quote = (text) => `'${String(text).replace(/'/g, "''")}'`;

function validate(pack) {
  const seen = new Set();
  for (const label of pack.labels) {
    if (!ADDRESS_RE.test(label.address)) throw new Error(`bad address: ${label.address}`);
    if (seen.has(label.address)) throw new Error(`duplicate address: ${label.address}`);
    seen.add(label.address);
    if (!label.name || label.name.length > NAME_MAX) throw new Error(`bad name: ${label.name}`);
    if (!/^[\x20-\x7e]+$/.test(label.name)) throw new Error(`non-ASCII name: ${label.name}`);
    if (!pack.sources[label.protocol]) throw new Error(`no source URL for protocol: ${label.protocol}`);
    // Optional per-entry source, preferred over the protocol source: some
    // addresses live on a different first-party page than the protocol's
    // contract table (the ArbRetryableTx precompile lives on the precompiles
    // reference, not the contract-addresses page). Same allowlist rules as the
    // name: the URL lands inside a quoted SQL literal.
    if (label.source_url !== undefined
      && (typeof label.source_url !== 'string' || !/^https:\/\/[\x20-\x7e]+$/.test(label.source_url))) {
      throw new Error(`bad source_url: ${label.source_url}`);
    }
    if (!Number.isInteger(label.chain_id)) throw new Error(`bad chain_id: ${label.chain_id}`);
  }
  return pack;
}

function buildSeed(pack) {
  const rows = pack.labels.map((label, i) => {
    // The entry's own source wins over the protocol's: the citation must be
    // the page the address was actually read from.
    const url = label.source_url || pack.sources[label.protocol];
    // The note column IS the provenance record in the database: it renders as
    // the label pill's tooltip, so the citation travels with the row instead of
    // living only in a file nobody opens.
    const note = `Cross-chain bridge on chain ${label.chain_id}. Source: ${url}`;
    // The last row carries no comma: the ON CONFLICT clause and the statement
    // terminator follow it.
    const comma = i === pack.labels.length - 1 ? '' : ',';
    return `  (NULL, ${quote(label.address)}, ${quote(label.name)}, 'builtin-bridge', 'bridge', 'high', ${quote(note)})${comma}`;
  });

  return [
    SEED_MARKER,
    `-- ${pack.labels.length} addresses, researched ${pack.researchedOn}. Sources, one per protocol:`,
    ...Object.entries(pack.sources).map(([key, url]) => `--   ${key.padEnd(9)} ${url}`),
    '--',
    '-- ON CONFLICT (address) WHERE user_id IS NULL DO NOTHING -- never DO UPDATE.',
    '-- Migrations re-run on every boot; DO UPDATE would re-stamp a name, a kind or',
    '-- a note the user had already corrected, every boot, forever.',
    'INSERT INTO eth_address_labels (user_id, address, name, source, kind, confidence, note) VALUES',
    ...rows,
    'ON CONFLICT (address) WHERE user_id IS NULL DO NOTHING;',
    SEED_END,
    '',
  ].join('\n');
}

// The committed migration = its hand-written preamble + the generated seed.
function buildSql(pack, preamble) {
  return `${preamble}${buildSeed(pack)}`;
}

function preambleOf(sql) {
  const at = sql.indexOf(SEED_MARKER);
  if (at < 0) throw new Error(`migration is missing the seed marker: ${SEED_MARKER}`);
  return sql.slice(0, at);
}

// Never rewrites an applied migration: a pack change becomes the next
// migration (full block + updates + tombstones), see scripts/lib/seedDelta.js.
const DELTA_SPECS = {
  eth_address_labels: { key: ['address'], scope: "user_id IS NULL AND source = 'builtin-bridge'" },
};

function main() {
  const pack = validate(JSON.parse(fs.readFileSync(PACK_PATH, 'utf-8')));
  const result = writeSeedDelta({
    start: SEED_MARKER,
    end: SEED_END,
    desiredBlock: buildSeed(pack),
    stem: 'bridge_label_seed_delta',
    header: '-- Builtin bridge label pack delta.\n'
      + '-- GENERATED FILE -- edit data/builtin-bridge-labels.json and run backend/scripts/generate-bridge-seed.js.',
    specs: DELTA_SPECS,
  });
  console.log(result.written
    ? `Wrote ${path.basename(result.written)}: ${JSON.stringify(result.summary)}`
    : `Bridge label seed is up to date (${result.latest})`);
}

if (require.main === module) main();

module.exports = { buildSql, buildSeed, preambleOf, validate, quote, SEED_MARKER, SEED_END, NAME_MAX, ADDRESS_RE, DELTA_SPECS };

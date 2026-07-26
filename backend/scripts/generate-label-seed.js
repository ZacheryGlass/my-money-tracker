#!/usr/bin/env node
'use strict';

/**
 * Regenerates the builtin counterparty label pack from the eth-labels dataset.
 *
 *   node scripts/generate-label-seed.js /path/to/accounts.json   # re-extract
 *   node scripts/generate-label-seed.js --from-json              # SQL only
 *
 * The 21MB source dump is NOT checked in -- download it first:
 *   curl -L -o accounts.json \
 *     https://raw.githubusercontent.com/dawsbot/eth-labels/v1/data/json/accounts.json
 *
 * Two artifacts are written, both committed, both generated from the same
 * in-memory list so they can never disagree:
 *   data/builtin-address-labels.json    -- the extracted pack, for review/diff
 *   migrations/036_seed_builtin_labels.sql -- what actually loads it
 *
 * --from-json rebuilds the SQL from the committed JSON, so changing the SQL
 * shape does not require re-downloading 21MB.
 *
 * Output is deterministic (sorted by address, no timestamps): a re-run on the
 * same input produces a byte-identical file, so a diff means the DATA moved.
 *
 * Provenance: the dataset is scraped from Etherscan public name tags (MIT
 * licensed). Seeding it into this private app is fine; do not redistribute it
 * as a public dataset or serve it from an API.
 */

const fs = require('fs');
const path = require('path');

const DATASET_URL = 'https://github.com/dawsbot/eth-labels';
const DATASET_FILE = 'v1/data/json/accounts.json';
const DATASET_LICENSE = 'MIT';

const JSON_OUT = path.join(__dirname, '../data/builtin-address-labels.json');
const SQL_OUT = path.join(__dirname, '../migrations/036_seed_builtin_labels.sql');

// The dataset's `label` field is a coarse category. Only two of its ~200 values
// are safe to act on unattended:
//   'exchange' -> kind 'exchange'. Changes classification: transfers to these
//                 addresses mirror as CRYPTO_EXCHANGE_DEPOSIT/_WITHDRAWAL, i.e.
//                 an internal transfer rather than spending.
//   'dex'      -> kind 'external'. Changes nothing except draining the address
//                 from the triage queue: a swap through a router is a real
//                 outside counterparty, it just is not one worth reviewing.
// Everything else (protocol slugs, mev-bot, airdrop-hunter, nonprofit, ...) is
// left alone -- an unreviewed address showing up in triage is the correct
// outcome for a category nobody has vetted.
const KIND_BY_DATASET_LABEL = { exchange: 'exchange', dex: 'external' };

const ADDRESS_RE = /^0x[0-9a-f]{40}$/;
const NAME_MAX = 64;      // eth_address_labels.name is VARCHAR(64)
const ROWS_PER_INSERT = 500;

const isControlChar = (char) => char.codePointAt(0) < 0x20 || char.codePointAt(0) === 0x7f;

// A name is required (the column is NOT NULL) and it is what the user sees on
// the transfer -- "Coinbase 12" is the whole point. Rows carrying only a bare
// category and no name are dropped rather than given a placeholder: an
// address labeled "Exchange" would silently turn real spending into an
// internal transfer while telling the user nothing about which exchange.
function cleanName(nameTag) {
  if (typeof nameTag !== 'string') return null;
  // Collapse whitespace (a stray newline would split a generated VALUES row
  // across two lines) and drop anything still carrying a control character --
  // a NUL byte would make Postgres reject the statement outright.
  const name = nameTag.replace(/\s+/g, ' ').trim();
  if (!name || [...name].some(isControlChar)) return null;
  return name.length > NAME_MAX ? name.slice(0, NAME_MAX).trim() : name;
}

function extract(accounts) {
  const stats = {
    rowsRead: accounts.length,
    malformedAddress: 0,
    missingNameTag: 0,
    demotedToExternal: 0,
  };
  // address -> { address, name, kind }
  const byAddress = new Map();
  const ambiguous = new Set();

  for (const row of accounts) {
    const kind = KIND_BY_DATASET_LABEL[row && row.label];
    if (!kind) continue;

    // 15 rows in the dump have elided addresses ("0x1985EA6E...2Fdb25c87").
    // The CHECK constraint would reject them anyway; count them so a future
    // dump that mangles thousands is loud rather than quietly smaller.
    // chainId is deliberately not read: the dump tags mainnet rows 43114/480
    // and friends, so filtering on it would throw away correct addresses.
    const address = typeof row.address === 'string' ? row.address.toLowerCase() : '';
    if (!ADDRESS_RE.test(address)) {
      stats.malformedAddress += 1;
      continue;
    }

    const name = cleanName(row.nameTag);
    if (!name) {
      stats.missingNameTag += 1;
      continue;
    }

    const existing = byAddress.get(address);
    if (!existing) {
      byAddress.set(address, { address, name, kind });
      continue;
    }

    // Same address under both categories (four defunct trading venues today).
    // Ambiguity resolves DOWN to 'external', never up: a wrong 'exchange'
    // rewrites real spending as a transfer to yourself and quietly deletes it
    // from cash flow, while a wrong 'external' only means the address stops
    // asking to be reviewed.
    if (existing.kind !== kind) {
      ambiguous.add(address);
      existing.kind = 'external';
    }

    // The same address often appears once per chain with drifting name tags
    // ("Binance 1" / "Binance 55"). Pick the lexicographically smallest so the
    // output does not churn with the dump's row order.
    if (name < existing.name) existing.name = name;
  }

  stats.demotedToExternal = ambiguous.size;
  const labels = [...byAddress.values()].sort((a, b) => (a.address < b.address ? -1 : 1));
  stats.exchange = labels.filter((l) => l.kind === 'exchange').length;
  stats.external = labels.filter((l) => l.kind === 'external').length;
  stats.total = labels.length;
  return { labels, stats };
}

function buildJson(labels, stats) {
  return {
    source: 'eth-labels',
    sourceUrl: DATASET_URL,
    sourceFile: DATASET_FILE,
    license: DATASET_LICENSE,
    note: 'Scraped from Etherscan public name tags. Seeded into this private app only; do not redistribute as a dataset or API. Regenerate with backend/scripts/generate-label-seed.js.',
    // Constant for every row in the pack, so they are stated once instead of
    // 5k times. The generated migration writes them on each INSERT.
    rowDefaults: { user_id: null, source: 'eth-labels', confidence: 'low' },
    counts: { exchange: stats.exchange, external: stats.external, total: stats.total },
    labels,
  };
}

const quote = (value) => `'${String(value).replace(/'/g, "''")}'`;

function buildSql(labels, counts) {
  const header = `-- Builtin counterparty label pack: ${counts.total} addresses (${counts.exchange} exchange, ${counts.external} external).
-- GENERATED FILE -- edit backend/scripts/generate-label-seed.js and re-run it,
-- not this. Mirrors backend/data/builtin-address-labels.json exactly.
--
-- Source: ${DATASET_URL} (${DATASET_FILE}, ${DATASET_LICENSE}), scraped from
-- Etherscan public name tags. Fine to seed into this private app; do not
-- redistribute as a public dataset or API.
--
-- Why this exists: the triage queue is fed by every counterparty with no label
-- row, and exchanges rotate hot wallets faster than anyone hand-verifies them.
-- The 20-address set in 029 could not keep up, so real exchange flows kept
-- landing in the queue as unreviewed strangers -- and an unreviewed exchange
-- deposit reads as spending. This pack is scraped, not verified, which is
-- exactly what source='eth-labels' and confidence='low' record.
--
-- PRECEDENCE IS UNCHANGED. Every row here is a builtin (user_id NULL), so a
-- user row for the same address shadows it (EthTransfer.reclassifyCounterparties
-- resolves ORDER BY user_id NULLS LAST, then reads kind off the winner), and a
-- user's kind='own' still beats any exchange verdict. Nothing here votes twice:
--
--   * ON CONFLICT ... DO NOTHING, never DO UPDATE. Migrations re-run on every
--     boot; DO UPDATE would re-stamp a name (or worse, a kind) the user had
--     already corrected, every single boot.
--   * The conflict target is 029's partial unique index on (address) WHERE
--     user_id IS NULL, so this file can only ever collide with another builtin
--     -- a user's row for the same address is a different row and is untouched.
--   * 029's hand-verified builtins are inserted first (file order) and win any
--     overlap, keeping confidence='high' and their curated names.
--
-- Requires 035 (source widened to VARCHAR(40) and its CHECK extended to admit
-- 'eth-labels'; confidence column added).`;

  const chunks = [];
  for (let i = 0; i < labels.length; i += ROWS_PER_INSERT) {
    const rows = labels.slice(i, i + ROWS_PER_INSERT)
      .map((l) => `  (NULL, ${quote(l.address)}, ${quote(l.name)}, 'eth-labels', ${quote(l.kind)}, 'low')`)
      .join(',\n');
    chunks.push(
      'INSERT INTO eth_address_labels (user_id, address, name, source, kind, confidence) VALUES\n'
      + `${rows}\n`
      + 'ON CONFLICT (address) WHERE user_id IS NULL DO NOTHING;'
    );
  }
  return `${header}\n\n${chunks.join('\n\n')}\n`;
}

function main() {
  const arg = process.argv[2];

  let labels;
  let stats;
  if (arg === '--from-json') {
    const pack = JSON.parse(fs.readFileSync(JSON_OUT, 'utf-8'));
    labels = pack.labels;
    stats = { ...pack.counts, fromJson: true };
    console.log(`Loaded ${labels.length} labels from ${path.relative(process.cwd(), JSON_OUT)}`);
  } else {
    if (!arg) {
      console.error('Usage: generate-label-seed.js <accounts.json> | --from-json');
      console.error(`Download the dump from ${DATASET_URL} (${DATASET_FILE}); it is not checked in.`);
      process.exit(1);
    }
    const accounts = JSON.parse(fs.readFileSync(path.resolve(arg), 'utf-8'));
    if (!Array.isArray(accounts)) {
      console.error('Expected the dump to be a JSON array of {address, label, nameTag} rows');
      process.exit(1);
    }
    ({ labels, stats } = extract(accounts));

    fs.mkdirSync(path.dirname(JSON_OUT), { recursive: true });
    fs.writeFileSync(JSON_OUT, `${JSON.stringify(buildJson(labels, stats), null, 2)}\n`);
    console.log(`Read ${stats.rowsRead} rows; skipped ${stats.malformedAddress} malformed addresses and ${stats.missingNameTag} rows with no name tag; demoted ${stats.demotedToExternal} ambiguous addresses to external.`);
    console.log(`Wrote ${path.relative(process.cwd(), JSON_OUT)}: ${stats.total} labels (${stats.exchange} exchange, ${stats.external} external)`);
  }

  const counts = {
    total: labels.length,
    exchange: labels.filter((l) => l.kind === 'exchange').length,
    external: labels.filter((l) => l.kind === 'external').length,
  };
  fs.writeFileSync(SQL_OUT, buildSql(labels, counts));
  const statements = Math.ceil(labels.length / ROWS_PER_INSERT);
  console.log(`Wrote ${path.relative(process.cwd(), SQL_OUT)}: ${counts.total} rows in ${statements} INSERT statement(s)`);
}

main();

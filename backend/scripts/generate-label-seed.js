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
 * Two rules do the safety work, both documented at their definitions below:
 * KIND_BY_DATASET_LABEL (only two of the dataset's ~200 categories are acted
 * on) and MERCHANT_NAME_RE (payment gateways, on-ramps and deployers are
 * emitted as 'external', because paying one is spending).
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
//
// Null-prototype so a dataset row labeled 'constructor' (or 'toString', or
// '__proto__') reads as "no mapping" instead of returning an inherited function
// and passing the `if (!kind)` guard.
const KIND_BY_DATASET_LABEL = Object.assign(Object.create(null), {
  exchange: 'exchange',
  dex: 'external',
});

// Not every address the dataset files under 'exchange' is a custodial venue you
// move your OWN money to. It also files merchant processors and fiat on-ramps
// there -- Bitrefill, CoinPayments, MoonPay, BitPay, Transak, Simplex, Ramp,
// Mercuryo, Coinify, Coinbase Commerce -- plus each venue's contract-deployer
// address. Paying a merchant gateway is SPENDING; calling it an exchange makes
// the mirror rewrite it as CRYPTO_EXCHANGE_DEPOSIT, an internal transfer, and
// the money silently leaves cash flow. A deployer address is not a deposit
// address at all.
//
// So these are emitted as 'external' -- reviewed, real outside counterparty,
// classification unchanged. That is the safe direction: a wrong 'external'
// shows spending as spending and only costs a queue entry that never gets
// asked about, while a wrong 'exchange' deletes real spending from the ledger.
// Genuinely custodial platforms (Nexo, Abra, Prime Trust, ...) keep 'exchange';
// only their gateway and deployer tags match here.
const MERCHANT_NAME_RE = /payment|gateway|commerce|gift|refill|bitpay|coinpayments|moonpay|transak|simplex|ramp network|mercuryo|coinify|deployer/i;

const ADDRESS_RE = /^0x[0-9a-f]{40}$/;
const NAME_MAX = 64;      // eth_address_labels.name is VARCHAR(64)
const ROWS_PER_INSERT = 500;

// A name is required (the column is NOT NULL) and it is what the user sees on
// the transfer -- "Coinbase 12" is the whole point. Rows carrying only a bare
// category and no name are dropped rather than given a placeholder: an
// address labeled "Exchange" would silently turn real spending into an
// internal transfer while telling the user nothing about which exchange.
function cleanName(nameTag) {
  if (typeof nameTag !== 'string') return null;
  // Sanitize at extraction, not at quoting. A name tag is a display hint
  // scraped off a public site, so there is nothing worth preserving in a byte
  // outside printable ASCII -- and plenty to lose. Backslashes are the reason
  // this is not just a control-character filter: quote() below doubles single
  // quotes, which is correct for a standard_conforming_strings literal, but a
  // server with that setting off reads '\' as an escape and would swallow the
  // closing quote of a name ending in a backslash, corrupting every row after
  // it in the batch. Newlines would split a VALUES row across two lines (the
  // seed test parses line by line) and a NUL byte makes Postgres reject the
  // statement outright. Everything outside \x20-\x7e, backslash included,
  // becomes a space; whitespace then collapses.
  const name = nameTag.replace(/[^\x20-\x7e]|\\/g, ' ').replace(/\s+/g, ' ').trim();
  if (!name) return null;
  // Truncate by code point, not by UTF-16 unit: VARCHAR(64) counts characters,
  // and slice() would cut an astral character in half and leave a lone
  // surrogate. Moot while the filter above is ASCII-only, but the two rules
  // must not silently depend on each other.
  const codePoints = Array.from(name);
  return codePoints.length > NAME_MAX ? codePoints.slice(0, NAME_MAX).join('').trim() : name;
}

function extract(accounts) {
  const stats = {
    rowsRead: accounts.length,
    malformedAddress: 0,
    missingNameTag: 0,
    ambiguousToExternal: 0,
    merchantsToExternal: 0,
  };
  // address -> { address, name, kind }
  const byAddress = new Map();
  const ambiguous = new Set();
  const merchants = new Set();

  for (const row of accounts) {
    const datasetKind = KIND_BY_DATASET_LABEL[row && row.label];
    if (!datasetKind) continue;

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

    // Merchant/gateway/deployer demotion, decided per row off that row's own
    // name tag and then made STICKY per address below: one tag calling the
    // address a payment gateway is enough, even if a different chain's tag for
    // it is a plain venue name. Same reasoning as the ambiguity rule -- the
    // verdict resolves down, never up.
    let kind = datasetKind;
    if (kind === 'exchange' && MERCHANT_NAME_RE.test(name)) {
      kind = 'external';
      merchants.add(address);
    }

    const existing = byAddress.get(address);
    if (!existing) {
      byAddress.set(address, { address, name, kind });
      continue;
    }

    // Same address under both categories (four defunct trading venues today),
    // or one tag demoted and another not. Disagreement resolves DOWN to
    // 'external', never up: a wrong 'exchange' rewrites real spending as a
    // transfer to yourself and quietly deletes it from cash flow, while a wrong
    // 'external' only means the address stops asking to be reviewed.
    if (existing.kind !== kind) {
      // Only count it as dataset ambiguity when the demotion list is not what
      // put the two rows at odds, so the two numbers stay separately readable.
      if (!merchants.has(address)) ambiguous.add(address);
      existing.kind = 'external';
    }

    // The same address often appears once per chain with drifting name tags
    // ("Binance 1" / "Binance 55"). Pick the lexicographically smallest so the
    // output does not churn with the dump's row order. The displayed name can
    // therefore be the non-merchant tag of a demoted address ("Coinbase 5"
    // rather than "Coinbase: Commerce Fee 1") -- the name is a display hint,
    // the kind is the safety-critical half, and only the kind resolves down.
    if (name < existing.name) existing.name = name;
  }

  stats.ambiguousToExternal = ambiguous.size;
  stats.merchantsToExternal = merchants.size;
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
    note: "Scraped from Etherscan public name tags. Seeded into this private app only; do not redistribute as a dataset or API. Regenerate with backend/scripts/generate-label-seed.js. Merchant processors, fiat on-ramps and contract deployers carry kind 'external', not 'exchange': paying one is spending, and calling it an exchange would rewrite that spending as an internal transfer.",
    // Constant for every row in the pack, so they are stated once instead of
    // 5k times. The generated migration writes them on each INSERT.
    rowDefaults: { user_id: null, source: 'eth-labels', confidence: 'low' },
    counts: { exchange: stats.exchange, external: stats.external, total: stats.total },
    labels,
  };
}

// Doubles single quotes, which is the whole escape story for a
// standard_conforming_strings literal. It is only sufficient because cleanName
// has already removed backslashes and everything else outside printable ASCII
// -- do not feed it unsanitized text.
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
-- Merchant processors, fiat on-ramps and contract deployers (Bitrefill,
-- CoinPayments, MoonPay, BitPay, Transak, Simplex, Ramp, Mercuryo, Coinify,
-- Coinbase Commerce, "<venue>: Deployer", ...) are emitted as 'external', not
-- 'exchange', even though the dataset files them under its exchange category.
-- Paying a gateway is spending; an 'exchange' verdict would rewrite it as an
-- internal transfer and drop it out of cash flow entirely.
--
-- WHAT THIS DOES NOT DO: seeding a label does not rewrite transfers that are
-- already stored. eth_transfers.counterparty_exchange is denormalized and only
-- EthTransfer.reclassifyCounterparties rebuilds it -- at the next wallet sync,
-- or immediately when the user writes a label. Migrations do not call it, so
-- history classified before this pack landed keeps its old verdict until one of
-- those happens. The triage queue is the exception: it reads labels live, so a
-- seeded counterparty drops out of it as soon as the migration commits.
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
    console.log(`Read ${stats.rowsRead} rows; skipped ${stats.malformedAddress} malformed addresses and ${stats.missingNameTag} rows with no name tag; demoted ${stats.ambiguousToExternal} ambiguous and ${stats.merchantsToExternal} merchant/gateway/deployer addresses to external.`);
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

if (require.main === module) main();

// Exported for tests: the demotion list and the name sanitizer are the two
// places where a quiet mistake reaches the database as a wrong verdict or a
// broken statement, and neither is observable from the generated artifacts
// alone once the input dump is gone.
module.exports = { cleanName, extract, buildSql, MERCHANT_NAME_RE, NAME_MAX };

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = 'postgresql://test:test@localhost/test';

const queries = [];
const pgModulePath = require.resolve('pg');
require.cache[pgModulePath] = {
  id: pgModulePath,
  filename: pgModulePath,
  loaded: true,
  exports: {
    Pool: class FakePool {
      async query(text, params) {
        queries.push({ text, params });
        return { rows: [] };
      }
      connect() { throw new Error('Unexpected connect'); }
      on() {}
    },
    types: { setTypeParser() {} },
  },
};

const EthAddressLabel = require('../src/models/EthAddressLabel');
const EthTransfer = require('../src/models/EthTransfer');
const { cleanName, extract, buildSql, MERCHANT_NAME_RE, NAME_MAX } = require('../scripts/generate-label-seed');

const migrationsDir = path.join(__dirname, '../migrations');
const readMigration = (file) => fs.readFileSync(path.join(migrationsDir, file), 'utf-8');

const PACK = JSON.parse(fs.readFileSync(path.join(__dirname, '../data/builtin-address-labels.json'), 'utf-8'));
const SEED_SQL = readMigration('036_seed_builtin_labels.sql');
const PROVENANCE_SQL = readMigration('035_label_provenance.sql');
const SCOPING_SQL = readMigration('029_user_scoping_enforce.sql');

// The seed migration's header quotes the rules it obeys ("never DO UPDATE"),
// so anything asserted about the STATEMENTS has to see the comments stripped.
const stripComments = (sql) => sql.replace(/--[^\n]*/g, '');
const sqlOf = (query) => query.text.replace(/--[^\n]*/g, '').replace(/\s+/g, ' ').trim();

const VALUES_ROW = /^ {2}\(NULL, '(0x[0-9a-f]{40})', '(.*)', 'eth-labels', '(exchange|external)', 'low'\),?$/;

function parseSeededRows() {
  const rows = [];
  for (const line of SEED_SQL.split('\n')) {
    if (!line.startsWith('  (')) continue;
    const match = line.match(VALUES_ROW);
    assert.ok(match, `seeded row does not match the expected shape: ${line}`);
    rows.push({ address: match[1], name: match[2].replace(/''/g, "'"), kind: match[3] });
  }
  return rows;
}

test('the generated migration and the committed pack are the same data', () => {
  const seeded = parseSeededRows();
  assert.equal(seeded.length, PACK.labels.length);
  assert.deepEqual(seeded, PACK.labels.map(({ address, name, kind }) => ({ address, name, kind })));
  assert.equal(PACK.counts.total, PACK.labels.length);
  assert.equal(PACK.counts.exchange, PACK.labels.filter((l) => l.kind === 'exchange').length);
  assert.equal(PACK.counts.external, PACK.labels.filter((l) => l.kind === 'external').length);
  // Provenance is what makes a scraped verdict distinguishable from a verified
  // one; the migration writes it on every row.
  assert.deepEqual(PACK.rowDefaults, { user_id: null, source: 'eth-labels', confidence: 'low' });
});

test('every seeded row is a storable builtin', () => {
  const columns = SEED_SQL.match(/INSERT INTO eth_address_labels \(([^)]+)\) VALUES/);
  assert.deepEqual(columns[1].split(', '), ['user_id', 'address', 'name', 'source', 'kind', 'confidence']);
  const addresses = new Set();
  for (const row of parseSeededRows()) {
    // address is VARCHAR(42) CHECK (address = LOWER(address)); name is
    // VARCHAR(64) NOT NULL; kind has a CHECK. One bad row aborts the whole
    // statement, and with it every boot.
    assert.match(row.address, /^0x[0-9a-f]{40}$/);
    assert.ok(row.name.length > 0 && row.name.length <= 64, `bad name: ${row.name}`);
    assert.doesNotMatch(row.name, /[\r\n]/);
    assert.ok(!addresses.has(row.address), `duplicate address: ${row.address}`);
    addresses.add(row.address);
  }
});

test('re-running the seed can never re-vote an existing verdict', () => {
  const statements = stripComments(SEED_SQL).split(';').map((s) => s.trim()).filter(Boolean);
  assert.ok(statements.length > 0);
  // Migrations re-run on EVERY boot. DO UPDATE would re-stamp the pack's
  // scraped name -- or its kind -- over a correction the user made, every boot,
  // forever.
  assert.doesNotMatch(stripComments(SEED_SQL), /DO UPDATE/i);
  for (const statement of statements) {
    assert.match(statement, /^INSERT INTO eth_address_labels /);
    // 029's partial unique index on (address) WHERE user_id IS NULL. Inferring
    // the per-user index instead would make each boot's insert collide with a
    // USER's row for the same address.
    assert.match(statement, /ON CONFLICT \(address\) WHERE user_id IS NULL DO NOTHING$/);
    const rowCount = (statement.match(/\(NULL, '0x/g) || []).length;
    assert.ok(rowCount > 0 && rowCount <= 500, `batch of ${rowCount} rows`);
  }
});

test("029's hand-verified builtins outrank the scraped pack", () => {
  const curated = [...SCOPING_SQL.matchAll(/\('(0x[0-9a-f]{40})', '[^']+', 'builtin'/g)].map((m) => m[1]);
  assert.ok(curated.length >= 20);
  const packed = new Map(PACK.labels.map((l) => [l.address, l]));
  const overlap = curated.filter((address) => packed.has(address));
  // The overlap is the whole point of the ordering guarantee: 029 seeds
  // 'Coinbase' where the pack scraped 'Coinbase 1'. 029 sorts before 036, so
  // the curated row is inserted first and DO NOTHING leaves it alone --
  // keeping its name, its note, and confidence 'high'.
  assert.ok(overlap.length > 0, 'expected the pack to cover some curated addresses');
  assert.match(SEED_SQL, /ON CONFLICT \(address\) WHERE user_id IS NULL DO NOTHING;/);
});

test('035 records provenance without re-stamping the pack', () => {
  // 026 declared source as VARCHAR(10) with a CHECK of ('user', 'builtin');
  // 036 cannot insert 'eth-labels' until both are widened.
  assert.match(PROVENANCE_SQL, /ALTER COLUMN source TYPE VARCHAR\(40\)/);
  assert.match(PROVENANCE_SQL, /CHECK \(source IN \('user', 'builtin', 'eth-labels'\)\)/);
  assert.match(PROVENANCE_SQL, /ADD COLUMN IF NOT EXISTS confidence VARCHAR\(10\)/);
  assert.match(PROVENANCE_SQL, /CHECK \(confidence IS NULL OR confidence IN \('high', 'low'\)\)/);

  // THE re-run trap. 035 runs before 036 on every boot, so ANY statement here
  // that concludes "a global row is a builtin" would relabel all 5k scraped
  // rows as hand-verified on boot two, erasing the distinction this migration
  // exists to record. There is deliberately no such backfill: 029 runs earlier
  // in the same boot and moves the only population one could have targeted
  // (global rows still carrying 026's default source 'user') onto user 1.
  const statements = stripComments(PROVENANCE_SQL)
    .split(';')
    .map((s) => s.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
  assert.deepEqual(
    statements.filter((s) => /^UPDATE eth_address_labels SET source = 'builtin'/.test(s)),
    [],
    'a source=builtin backfill here would restamp the scraped pack on the next boot'
  );
  assert.match(
    stripComments(SCOPING_SQL).replace(/\s+/g, ' '),
    /UPDATE eth_address_labels SET user_id = 1 WHERE user_id IS NULL AND source = 'user'/,
    "029 is what makes the backfill unnecessary; if it goes, 035's assumption goes with it"
  );

  // Whatever this file does write must be unable to reach an 'eth-labels' row:
  // every UPDATE is scoped either to the impossible pre-026 NULL source or to
  // rows already known to be hand-verified builtins.
  for (const statement of statements.filter((s) => s.startsWith('UPDATE eth_address_labels'))) {
    assert.match(
      statement,
      /WHERE (source IS NULL|source = 'builtin' AND confidence IS NULL)$/,
      `unscoped update could touch the pack: ${statement}`
    );
  }
});

// Mirrors the second UPDATE in EthTransfer.reclassifyCounterparties: resolve the
// winning label row first (a user row shadows a builtin), THEN read kind off
// that winner. Both halves are asserted against the real SQL below, so this
// cannot drift into testing itself.
function resolveCounterpartyExchange(labelRows) {
  const winner = [...labelRows].sort((a, b) => {
    if (a.user_id === b.user_id) return 0;
    return a.user_id === null ? 1 : -1;   // ORDER BY user_id NULLS LAST
  })[0];
  if (!winner) return null;
  return winner.kind === 'exchange' ? winner.name : null;
}

test("a user's 'external' label shadows a seeded builtin exchange", async () => {
  const seeded = PACK.labels.find((l) => l.kind === 'exchange');
  const builtinRow = { user_id: null, address: seeded.address, name: seeded.name, kind: 'exchange', source: 'eth-labels' };

  // Baseline: with only the pack row, the address classifies as an exchange.
  // Without this the assertion below would pass even if nothing shadowed
  // anything.
  assert.equal(resolveCounterpartyExchange([builtinRow]), seeded.name);

  // The override, through the real write path.
  queries.length = 0;
  await EthAddressLabel.upsert(7, seeded.address, 'Not my exchange', null, 'external');
  const upsert = queries[0];
  assert.equal(upsert.params[0], 7);
  assert.equal(upsert.params[1], seeded.address);
  assert.equal(upsert.params[4], 'external');
  // The override is a SEPARATE row: user_id 7, conflict-inferred on the
  // per-user index. The builtin (user_id NULL) is not touched -- deleting or
  // updating it would only be undone by the next boot's seed anyway.
  const upsertSql = sqlOf(upsert);
  assert.match(upsertSql, /INSERT INTO eth_address_labels \(user_id, address, name, source, note, kind\)/);
  assert.match(upsertSql, /ON CONFLICT \(user_id, address\) WHERE user_id IS NOT NULL/);
  const userRow = { user_id: 7, address: seeded.address, name: 'Not my exchange', kind: 'external', source: 'user' };

  // Classification: the user row wins precedence and its 'external' verdict
  // leaves counterparty_exchange NULL, so the transfer keeps mirroring as
  // CRYPTO_EXTERNAL instead of a phantom exchange deposit.
  assert.equal(resolveCounterpartyExchange([builtinRow, userRow]), null);
  assert.equal(resolveCounterpartyExchange([userRow, builtinRow]), null);

  // ...and the resolver above is the shape the database actually runs.
  queries.length = 0;
  await EthTransfer.reclassifyCounterparties(7);
  const classify = sqlOf(queries[1]);
  assert.match(classify, /l\.user_id = w\.user_id OR l\.user_id IS NULL/);
  assert.match(classify, /ORDER BY l\.user_id NULLS LAST LIMIT 1/);
  assert.match(classify, /SELECT CASE WHEN l\.kind = 'exchange' THEN l\.name ELSE NULL END/);
  // A seeded builtin must not be able to outrank the override by being the
  // only row left in the candidate set.
  const subquery = classify.slice(classify.indexOf('WHERE l.address'), classify.indexOf('ORDER BY l.user_id'));
  assert.doesNotMatch(subquery, /l\.kind/);
  assert.doesNotMatch(subquery, /l\.source/);
});

test('the label management list hides the bulk pack but keeps overrides', async () => {
  queries.length = 0;
  await EthAddressLabel.findAllForUser(7);
  const sql = sqlOf(queries[0]);
  // 5k scraped rows would bury the user's own labels and ship ~700KB per
  // Settings load. They still classify; they are just not a management list.
  assert.match(sql, /WHERE user_id IS NOT NULL OR source = 'builtin'/);
  // The pack filter runs AFTER precedence resolves, so an override of a packed
  // address is still listed (and still removable).
  const inner = sql.slice(sql.indexOf('SELECT DISTINCT ON'), sql.indexOf(') labels'));
  assert.doesNotMatch(inner, /source/);
  assert.match(inner, /ORDER BY address, user_id NULLS LAST/);
});

// --- the generator itself -------------------------------------------------
// The extraction rules cannot be re-derived from the artifacts once the 21MB
// dump is gone, and they are where a quiet mistake becomes a wrong verdict on
// real money.

const addr = (n) => `0x${String(n).padStart(40, '0')}`;

test('merchant gateways and deployers are seeded external, custodial venues exchange', () => {
  const { labels, stats } = extract([
    // Paying these is SPENDING. An 'exchange' verdict rewrites the transfer as
    // an internal transfer and the money leaves cash flow entirely, so the
    // dataset's exchange category is overridden for them.
    { address: addr(1), label: 'exchange', nameTag: 'Bitrefill: Payment Gateway' },
    { address: addr(2), label: 'exchange', nameTag: 'CoinPayments.net 3' },
    { address: addr(3), label: 'exchange', nameTag: 'MoonPay 5' },
    { address: addr(4), label: 'exchange', nameTag: 'BitPay: Invoice' },
    { address: addr(5), label: 'exchange', nameTag: 'Coinbase: Commerce Fee 1' },
    { address: addr(6), label: 'exchange', nameTag: 'Transak: Wallet 1' },
    { address: addr(7), label: 'exchange', nameTag: 'Ramp Network US 1' },
    { address: addr(8), label: 'exchange', nameTag: 'Coinbase: Deployer 2' },
    // Genuinely custodial platforms keep 'exchange' -- moving money to one of
    // these really is moving your own money, and draining those from the queue
    // is the entire point of the pack.
    { address: addr(9), label: 'exchange', nameTag: 'Nexo 3' },
    { address: addr(10), label: 'exchange', nameTag: 'Prime Trust 1' },
    { address: addr(11), label: 'exchange', nameTag: 'Kraken 4' },
  ]);

  const kinds = new Map(labels.map((l) => [l.name, l.kind]));
  for (const name of ['Bitrefill: Payment Gateway', 'CoinPayments.net 3', 'MoonPay 5', 'BitPay: Invoice',
    'Coinbase: Commerce Fee 1', 'Transak: Wallet 1', 'Ramp Network US 1', 'Coinbase: Deployer 2']) {
    assert.equal(kinds.get(name), 'external', `${name} must not vote 'exchange'`);
  }
  for (const name of ['Nexo 3', 'Prime Trust 1', 'Kraken 4']) {
    assert.equal(kinds.get(name), 'exchange', `${name} is custodial and should stay an exchange`);
  }
  assert.equal(stats.merchantsToExternal, 8);
  assert.equal(stats.ambiguousToExternal, 0, 'a demotion is not a dataset ambiguity');
});

test('a demotion is sticky across the same address under a plain venue tag', () => {
  // The dump repeats an address once per chain with drifting name tags. One tag
  // calling it a gateway is enough: the verdict resolves DOWN, exactly like the
  // dex/exchange ambiguity rule, because only the 'exchange' direction can
  // delete real spending from the ledger.
  const forward = extract([
    { address: addr(1), label: 'exchange', nameTag: 'Coinbase 5' },
    { address: addr(1), label: 'exchange', nameTag: 'Coinbase: Commerce Fee 1' },
  ]);
  const reversed = extract([
    { address: addr(1), label: 'exchange', nameTag: 'Coinbase: Commerce Fee 1' },
    { address: addr(1), label: 'exchange', nameTag: 'Coinbase 5' },
  ]);
  for (const { labels } of [forward, reversed]) {
    assert.equal(labels.length, 1);
    assert.equal(labels[0].kind, 'external');
    // The name still follows the lexicographic rule; only the kind resolves down.
    assert.equal(labels[0].name, 'Coinbase 5');
  }
});

test('dataset categories are read off a null-prototype map', () => {
  // 'constructor' would otherwise resolve to Object's constructor -- a truthy
  // function that sails past the `if (!kind)` guard and lands as a bogus kind.
  const { labels } = extract([
    { address: addr(1), label: 'constructor', nameTag: 'Not an exchange' },
    { address: addr(2), label: 'toString', nameTag: 'Also not' },
    { address: addr(3), label: '__proto__', nameTag: 'Still not' },
    { address: addr(4), label: 'mev-bot', nameTag: 'Some bot' },
  ]);
  assert.deepEqual(labels, []);
});

test('names are sanitized to printable ASCII before they are ever quoted', () => {
  // quote() only doubles single quotes. A backslash surviving to the SQL would
  // be an escape character on a server with standard_conforming_strings off,
  // swallowing the closing quote and corrupting the rest of the batch; a
  // newline would split a VALUES row in two.
  assert.equal(cleanName('Bad\\Name'), 'Bad Name');
  assert.equal(cleanName('Two\nLines'), 'Two Lines');
  assert.equal(cleanName('Nul\0byte'), 'Nul byte', 'a NUL would make Postgres reject the statement');
  assert.equal(cleanName("O'Brien Exchange"), "O'Brien Exchange");
  assert.equal(cleanName('  spaced   out  '), 'spaced out');
  assert.equal(cleanName('échange'), 'change');
  assert.equal(cleanName('   '), null, 'a name that sanitizes to nothing is dropped, not blanked');
  assert.equal(cleanName(undefined), null);

  // VARCHAR(64) counts characters, and the truncation is by code point, so no
  // output can end in half of a surrogate pair -- belt and braces with the
  // ASCII filter above, which must not be the only thing keeping that true.
  const long = cleanName(`${'a'.repeat(80)}`);
  assert.equal(long.length, NAME_MAX);
  const astral = cleanName(`${'\u{1F600}'.repeat(40)}${'b'.repeat(40)}`);
  assert.doesNotMatch(astral, /[\uD800-\uDFFF]/);
  assert.ok(Array.from(astral).length <= NAME_MAX);
});

test('the committed pack has no merchant or deployer voting as an exchange', () => {
  // Guards the artifacts against a regeneration that loses the demotion list.
  const leaked = PACK.labels.filter((l) => l.kind === 'exchange' && MERCHANT_NAME_RE.test(l.name));
  assert.deepEqual(leaked, []);
  assert.ok(PACK.labels.some((l) => l.kind === 'external' && /deployer/i.test(l.name)));
});

test('a seeded address is still resolvable by address', async () => {
  queries.length = 0;
  const seeded = PACK.labels[0];
  await EthAddressLabel.findByAddress(7, seeded.address);
  const sql = sqlOf(queries[0]);
  // The delete route leans on this to tell "builtin, refused" (409) from "no
  // such label" (404); hiding the pack from the list must not hide it here.
  assert.doesNotMatch(sql, /source/);
  assert.match(sql, /user_id = \$2 OR user_id IS NULL/);
});

test('the committed migration is a regeneration of the committed JSON pack', () => {
  // 036 and the JSON are two artifacts of one generator run, and the 21MB
  // dump needed to regenerate them honestly is not committed -- so a hand
  // edit of either artifact would ship silently without this check.
  assert.equal(buildSql(PACK.labels, PACK.counts), SEED_SQL);
});

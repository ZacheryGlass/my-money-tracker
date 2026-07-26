'use strict';

// Runs the unified crypto ledger's REAL queries against a throwaway Postgres.
//
// The rest of the suite fakes the pg Pool, which cannot execute SQL -- so a
// 250-line UNION with a LATERAL, four LEFT JOINs and a window function is
// otherwise only ever asserted as TEXT. This boots a cluster, applies the full
// migration chain TWICE (migrations re-run on every boot, so idempotence is
// part of what is under test), seeds both sources including a matched pair, and
// checks the answers.
//
//   node scripts/verify-ledger-sql.js [--pg-bin /path/to/postgres/bin]
//
// It NEVER touches the configured DATABASE_URL: the cluster is initdb'd into a
// fresh temp dir, listens on a kernel-assigned TCP port with no unix socket,
// and is removed on exit.

const { execFileSync, spawnSync } = require('child_process');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');

const REPO_BACKEND = path.join(__dirname, '..');

// Homebrew, Postgres.app, then a plain PATH install.
function findPgBin() {
  const flagIndex = process.argv.indexOf('--pg-bin');
  if (flagIndex !== -1 && process.argv[flagIndex + 1]) return process.argv[flagIndex + 1];
  const roots = ['/opt/homebrew/opt', '/usr/local/opt', '/Applications/Postgres.app/Contents/Versions'];
  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    for (const entry of fs.readdirSync(root).sort().reverse()) {
      const bin = path.join(root, entry, 'bin');
      if (fs.existsSync(path.join(bin, 'initdb'))) return bin;
    }
  }
  const which = spawnSync('sh', ['-c', 'command -v initdb'], { encoding: 'utf8' });
  if (which.status === 0 && which.stdout.trim()) return path.dirname(which.stdout.trim());
  return null;
}

const PG = findPgBin();
if (!PG) {
  console.error('No Postgres binaries found. Pass --pg-bin /path/to/bin.');
  process.exit(2);
}

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-verify-'));
// LC_ALL/LANG on BOTH initdb and pg_ctl: a mismatch makes the cluster refuse to
// start with a locale error that reads as a corrupt data directory.
const env = { ...process.env, LC_ALL: 'C', LANG: 'C', PGDATA: DATA };
let started = false;

function stop() {
  if (started) {
    spawnSync(path.join(PG, 'pg_ctl'), ['-D', DATA, '-m', 'immediate', 'stop'], { env });
    started = false;
  }
  try { fs.rmSync(DATA, { recursive: true, force: true }); } catch { /* best effort */ }
}
process.on('exit', stop);

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

const checks = [];
const ok = (name, condition) => checks.push([name, Boolean(condition)]);

(async () => {
  console.log(`initdb -> ${DATA}`);
  execFileSync(path.join(PG, 'initdb'),
    ['-D', DATA, '-U', 'postgres', '--encoding=UTF8', '--locale=C', '-A', 'trust'],
    { env, stdio: 'pipe' });

  const pgPort = await freePort();
  execFileSync(path.join(PG, 'pg_ctl'), [
    '-D', DATA, '-l', path.join(DATA, 'server.log'), '-w', '-o',
    // TCP only: unix_socket_directories='' keeps the cluster off any shared
    // socket path, so nothing else on the machine can reach it.
    `-p ${pgPort} -h 127.0.0.1 -k "" -c unix_socket_directories=''`, 'start',
  ], { env, stdio: 'pipe' });
  started = true;

  const url = `postgresql://postgres@127.0.0.1:${pgPort}/postgres`;
  for (const pass of [1, 2]) {
    const result = spawnSync('node', ['scripts/migrate.js'], {
      cwd: REPO_BACKEND,
      env: { ...process.env, DATABASE_URL: url, NODE_ENV: 'test' },
      encoding: 'utf8',
    });
    if (result.status !== 0) {
      console.error(`migration pass ${pass} FAILED\n${result.stdout}\n${result.stderr}`);
      process.exit(1);
    }
    console.log(`migrations pass ${pass}: OK`);
  }

  process.env.DATABASE_URL = url;
  const { Pool } = require('pg');
  const pool = new Pool({ connectionString: url });

  const tx = (c) => `0x${c.repeat(64)}`;
  const addr = (c) => `0x${c.repeat(40)}`;
  const DEPOSIT_TX = tx('3');

  await pool.query("INSERT INTO users (id, username) VALUES (1, 'verify') ON CONFLICT (id) DO NOTHING");
  await pool.query("INSERT INTO users (id, username) VALUES (2, 'other') ON CONFLICT (id) DO NOTHING");
  const wallet = await pool.query(
    "INSERT INTO eth_wallets (user_id, address, label) VALUES (1, $1, 'Main') RETURNING id",
    [addr('a')]
  );
  const walletId = wallet.rows[0].id;

  //  - a swap, priced
  //  - a flagged send on another chain, unpriced
  //  - a deposit a venue also recorded (the pair must render once)
  const activityRows = [
    [1, tx('1'), 19000000, '2026-03-02 14:20', 'swap', addr('c'), 'Uniswap',
      '[{"asset":"ETH","direction":"out","amount":"0.5"},{"asset":"USDC","direction":"in","amount":"1832.412345"}]',
      '840000000000000', false, null, '1832.41', '2.35', 'exact'],
    [42161, tx('2'), 300000000, '2026-03-01 09:05', 'send', addr('d'), null,
      '[{"asset":"ETH","direction":"out","amount":"0.25"}]',
      '120000000000000', true, 'unlabeled', null, null, 'unpriced'],
    [1, DEPOSIT_TX, 18990000, '2026-02-20 18:00', 'exchange_deposit', addr('e'), 'Kraken',
      '[{"asset":"ETH","direction":"out","amount":"1.25"}]',
      '630000000000000', false, null, '4200.00', '2.10', 'exact'],
  ];
  const activityIds = [];
  for (const row of activityRows) {
    const inserted = await pool.query(
      `INSERT INTO eth_activity (wallet_id, chain_id, tx_hash, block_number, block_time, category,
         counterparty_address, counterparty_name, legs, fee_wei, needs_review, review_reason,
         usd_value, usd_fee, usd_basis)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11,$12,$13,$14,$15) RETURNING id`,
      [walletId, ...row]
    );
    activityIds.push(inserted.rows[0].id);
  }

  const account = await pool.query(
    "INSERT INTO exchange_accounts (user_id, name, exchange) VALUES (1, 'Kraken', 'kraken') RETURNING id"
  );
  const accountId = account.rows[0].id;
  const records = await pool.query(
    `INSERT INTO exchange_records (exchange_account_id, record_type, occurred_at, base_asset, base_amount,
       quote_asset, quote_amount, fee_asset, fee_amount, tx_hash, external_id, needs_review, source)
     VALUES
       ($1, 'deposit',  '2026-02-20 18:40', 'ETH', 1.25, NULL,  NULL,    NULL,  NULL, $2,   'DEP-1', false, 'api'),
       ($1, 'trade',    '2026-02-25 10:00', 'ETH', -0.5, 'USD', 1832.40, 'USD', 4.76, NULL, 'TRD-1', false, 'api'),
       ($1, 'transfer', '2025-10-01 12:00', 'ETH', 0.1,  NULL,  NULL,    NULL,  NULL, NULL, 'UNK-1', true,  'csv')
     RETURNING id, external_id`,
    [accountId, DEPOSIT_TX]
  );
  const recordId = (externalId) => records.rows.find((r) => r.external_id === externalId).id;

  // The pairing #61 would derive, written directly: this verifies the LEDGER's
  // reading of exchange_matches, not the matcher itself.
  await pool.query(
    `INSERT INTO exchange_matches (exchange_record_id, activity_id, match_method, confidence)
     VALUES ($1, $2, 'tx_hash', 'high')`,
    [recordId('DEP-1'), activityIds[2]]
  );

  const CryptoLedger = require('../src/models/CryptoLedger');

  const all = await CryptoLedger.findForUser(1, { limit: 100, offset: 0 });
  console.log('\n--- ledger rows (newest first) ---');
  for (const row of all.rows) {
    console.log(
      row.occurred_at.toISOString().slice(0, 10),
      row.source.padEnd(8),
      row.category.padEnd(20),
      `review=${row.needs_review}`,
      `usd=${row.usd_value ?? '-'}/${row.usd_basis}`,
      `matched=${row.exchange_match ? row.exchange_match.external_id : '-'}`,
      `legs=${JSON.stringify(row.legs)}`
    );
  }

  ok('5 rows: 3 activity + 3 records, one pair folded', all.total === 5);
  const folded = all.rows.find((r) => r.exchange_match);
  ok('the matched record folds into its on-chain row',
    folded && folded.exchange_match.external_id === 'DEP-1');
  ok('the fold carries the evidence, not just the fact',
    folded && folded.exchange_match.match_method === 'tx_hash' && folded.exchange_match.match_confidence === 'high');
  // Loose compare: a BIGINT arrives as a string from a column and as a number
  // from inside jsonb_build_object.
  ok('the fold names the ids a verdict must target',
    folded && String(folded.exchange_match.verdict_exchange_record_id) === String(recordId('DEP-1'))
      && folded.exchange_match.verdict_counter_record_id === null);
  ok('a folded amount is an exact string, never a JSON double',
    folded && typeof folded.exchange_match.base_amount === 'string');
  ok('the folded half arrives already in leg shape',
    folded && folded.exchange_match.legs.length === 1 && folded.exchange_match.legs[0].amount === '1.25');
  ok('the folded record does NOT also appear on its own',
    !all.rows.some((r) => r.source === 'exchange' && r.external_id === 'DEP-1'));
  ok('legs carry base units and their scale for the shared formatter',
    all.rows.every((r) => r.legs.every((l) => typeof l.units === 'string' && Number.isInteger(l.decimals))));
  ok('ordering is strictly by time desc',
    all.rows.every((r, i, a) => i === 0 || a[i - 1].occurred_at >= r.occurred_at));
  ok('dated USD rides through untouched',
    all.rows.find((r) => r.tx_hash === tx('1'))?.usd_value === '1832.41');
  ok('an unpriced row reports no price rather than zero', (() => {
    const row = all.rows.find((r) => r.tx_hash === tx('2'));
    return row && row.usd_value === null && row.usd_basis === 'unpriced';
  })());
  // 1832.400000000000000000 off NUMERIC(38,18), trimmed: a money column must
  // not carry eighteen places of a quantity's padding.
  ok('a venue trade quoted in USD is priced exactly, by the venue', (() => {
    const row = all.rows.find((r) => r.external_id === 'TRD-1');
    return row && row.usd_value === '1832.4' && row.usd_basis === 'exact';
  })());
  ok('a venue row with no fiat leg is unpriced, not zero', (() => {
    const row = all.rows.find((r) => r.external_id === 'UNK-1');
    return row && row.usd_value === null && row.usd_basis === 'unpriced';
  })());
  ok('an unrecognized venue row maps to exchange_transfer',
    all.rows.some((r) => r.external_id === 'UNK-1' && r.category === 'exchange_transfer'));

  // A folded record is suppressed from its own branch, so each filter has to
  // find it through its host -- and the venue files a "deposit" for what the
  // wallet files as an exchange_deposit, so the mismatching name matters too.
  const bySource = await CryptoLedger.findForUser(1, { source: 'exchange', limit: 100, offset: 0 });
  ok('source=exchange still reaches the folded record',
    bySource.total === 3 && bySource.rows.some((r) => r.exchange_match));
  const byCategory = await CryptoLedger.findForUser(1, { category: 'exchange_deposit', limit: 100, offset: 0 });
  ok('category=exchange_deposit finds the folded pair once', byCategory.total === 1);
  const byAccount = await CryptoLedger.findForUser(1, { exchangeAccountId: accountId, limit: 100, offset: 0 });
  ok('the account filter reaches the folded record too', byAccount.total === 3);
  const byWallet = await CryptoLedger.findForUser(1, { walletId, limit: 100, offset: 0 });
  ok('the wallet filter keeps the folded pair and drops loose venue rows', byWallet.total === 3);
  const flagged = await CryptoLedger.findForUser(1, { needsReview: true, limit: 100, offset: 0 });
  ok('needs_review narrows the union', flagged.total === 2);

  // A flagged half must raise its host, or it leaves the queue while still
  // being unexplained.
  await pool.query("UPDATE exchange_records SET needs_review = TRUE WHERE external_id = 'DEP-1'");
  const afterFlag = await CryptoLedger.findForUser(1, { limit: 100, offset: 0 });
  ok('a flagged folded half raises the parent row',
    afterFlag.rows.find((r) => r.exchange_match)?.needs_review === true);
  ok('and the badge agrees with the filter',
    (await CryptoLedger.summaryForUser(1)).needs_review_count === 3);
  await pool.query("UPDATE exchange_records SET needs_review = FALSE WHERE external_id = 'DEP-1'");

  // A verdict is joined on (wallet, chain, tx_hash), never eth_activity.id.
  await pool.query(
    `INSERT INTO exchange_match_verdicts (exchange_record_id, wallet_id, chain_id, tx_hash, verdict)
     VALUES ($1, $2, 1, $3, 'confirmed')`,
    [recordId('DEP-1'), walletId, DEPOSIT_TX]
  );
  const confirmed = await CryptoLedger.findForUser(1, { limit: 100, offset: 0 });
  ok('a user verdict is visible on the folded row',
    confirmed.rows.find((r) => r.exchange_match)?.exchange_match.verdict === 'confirmed');

  const summary = await CryptoLedger.summaryForUser(1);
  console.log('\nsummary =', summary);
  ok('summary counts records (folded included) and prices honestly',
    summary.total === 5 && summary.onchain_count === 3 && summary.exchange_count === 3
      && summary.matched_count === 1 && summary.unpriced_count === 2);

  const p1 = await CryptoLedger.findForUser(1, { limit: 3, offset: 0 });
  const p2 = await CryptoLedger.findForUser(1, { limit: 3, offset: 3 });
  const ids = [...p1.rows, ...p2.rows].map((r) => r.id);
  ok('paging is stable (no repeats, no drops)', new Set(ids).size === 5 && ids.length === 5);

  // The row key must survive the wholesale rebuild every sync and label write
  // performs on eth_activity. The match rows CASCADE off it -- which is exactly
  // why 041's pass re-runs at the END of every rebuild -- so this replays that
  // too rather than pretending the fold survives on its own.
  const before = all.rows.map((r) => r.id).sort();
  const kept = await pool.query('SELECT * FROM eth_activity ORDER BY id');
  await pool.query('DELETE FROM eth_activity');
  const rebuiltIds = new Map();
  for (const row of kept.rows) {
    const inserted = await pool.query(
      `INSERT INTO eth_activity (wallet_id, chain_id, tx_hash, block_number, block_time, category,
         counterparty_address, counterparty_name, legs, fee_wei, needs_review, review_reason,
         usd_value, usd_fee, usd_basis)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING id`,
      [row.wallet_id, row.chain_id, row.tx_hash, row.block_number, row.block_time, row.category,
        row.counterparty_address, row.counterparty_name, JSON.stringify(row.legs), row.fee_wei,
        row.needs_review, row.review_reason, row.usd_value, row.usd_fee, row.usd_basis]
    );
    rebuiltIds.set(row.tx_hash, inserted.rows[0].id);
  }
  ok('the match CASCADEd away with the rebuild, as 041 designs for',
    (await pool.query('SELECT COUNT(*)::int AS n FROM exchange_matches')).rows[0].n === 0);
  await pool.query(
    `INSERT INTO exchange_matches (exchange_record_id, activity_id, match_method, confidence)
     VALUES ($1, $2, 'tx_hash', 'high')`,
    [recordId('DEP-1'), rebuiltIds.get(DEPOSIT_TX)]
  );
  const rebuilt = await CryptoLedger.findForUser(1, { limit: 100, offset: 0 });
  const after = rebuilt.rows.map((r) => r.id).sort();
  ok('row ids survive a wholesale eth_activity rebuild', JSON.stringify(before) === JSON.stringify(after));
  // ...and so does the user's verdict, which is keyed on (wallet, chain, hash)
  // for exactly this reason.
  ok('the verdict survives the rebuild too',
    rebuilt.rows.find((r) => r.exchange_match)?.exchange_match.verdict === 'confirmed');

  ok('the export query runs and returns every row',
    (await CryptoLedger.findAllForUser(1, { limit: 10 })).length === 5);

  const other = await CryptoLedger.findForUser(2, { limit: 100, offset: 0 });
  ok('a second user sees none of it', other.total === 0);
  ok('and their summary is zero', (await CryptoLedger.summaryForUser(2)).total === 0);

  await pool.end();

  console.log('\n--- checks ---');
  let failed = 0;
  for (const [name, passed] of checks) {
    console.log(`${passed ? 'PASS  ' : 'FAIL  '}${name}`);
    if (!passed) failed += 1;
  }
  console.log(failed ? `\n${failed} CHECK(S) FAILED` : `\nALL ${checks.length} CHECKS PASSED`);
  process.exit(failed ? 1 : 0);
})().catch((error) => {
  console.error(error);
  process.exit(1);
});

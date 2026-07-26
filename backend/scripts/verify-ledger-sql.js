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

  // A SECOND venue, and a withdrawal there paired with a deposit at the first:
  // 041's other shape, which never touches a tracked wallet. The table's
  // orientation is withdrawal -> deposit, so the withdrawal is the primary and
  // the deposit folds into it.
  const account2 = await pool.query(
    "INSERT INTO exchange_accounts (user_id, name, exchange) VALUES (1, 'Coinbase', 'coinbase') RETURNING id"
  );
  const pair = await pool.query(
    `INSERT INTO exchange_records (exchange_account_id, record_type, occurred_at, base_asset, base_amount,
       external_id, needs_review, source)
     VALUES ($1, 'withdrawal', '2026-01-10 09:00', 'ETH', -0.75, 'CB-WD-1', false, 'api'),
            ($2, 'deposit',    '2026-01-10 09:20', 'ETH',  0.75, 'KR-DEP-2', true,  'api')
     RETURNING id, external_id`,
    [account2.rows[0].id, accountId]
  );
  const pairId = (externalId) => pair.rows.find((r) => r.external_id === externalId).id;
  await pool.query(
    `INSERT INTO exchange_matches (exchange_record_id, counter_record_id, match_method, confidence)
     VALUES ($1, $2, 'address_amount', 'medium')`,
    [pairId('CB-WD-1'), pairId('KR-DEP-2')]
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

  // 3 activity + 5 records, minus the on-chain fold and the venue-pair fold.
  ok('6 rows: two pairs folded, each rendered once', all.total === 6);

  // 041's OTHER shape. The withdrawal is the primary; the deposit folds in.
  const venuePair = all.rows.find((r) => r.external_id === 'CB-WD-1');
  ok('a venue-to-venue pair renders on its primary (the withdrawal)',
    venuePair && venuePair.exchange_match?.external_id === 'KR-DEP-2');
  ok('and its counter does NOT also appear on its own',
    !all.rows.some((r) => r.external_id === 'KR-DEP-2'));
  // The row shows the COUNTER while 041 keys the verdict on the PRIMARY, so
  // inferring the target from what is on screen gets this case backwards.
  ok('the venue pair names the verdict target in the table\'s own orientation',
    venuePair
      && String(venuePair.exchange_match.verdict_exchange_record_id) === String(pairId('CB-WD-1'))
      && String(venuePair.exchange_match.verdict_counter_record_id) === String(pairId('KR-DEP-2')));
  ok('a flagged counter raises the primary row',
    venuePair && venuePair.needs_review === true && venuePair.record_needs_review === false);

  // The one that returned the ENTIRE ledger before the NULL guard: an unmatched
  // row's match_category fell to the CASE's ELSE.
  const transfersOnly = await CryptoLedger.findForUser(1, { category: 'exchange_transfer', limit: 100, offset: 0 });
  ok('category=exchange_transfer returns only transfers, not everything',
    transfersOnly.total === 1 && transfersOnly.rows[0].external_id === 'UNK-1');
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
  // 3 unfolded venue rows + the on-chain host of the folded DEP-1.
  const bySource = await CryptoLedger.findForUser(1, { source: 'exchange', limit: 100, offset: 0 });
  ok('source=exchange still reaches the folded record',
    bySource.total === 4 && bySource.rows.some((r) => r.exchange_match));
  // The on-chain host (its own category) AND the venue pair whose FOLDED half
  // is a deposit -- the venue files a "deposit" for what its counterparty filed
  // as a withdrawal, which is exactly the mismatch the second arm exists for.
  const byCategory = await CryptoLedger.findForUser(1, { category: 'exchange_deposit', limit: 100, offset: 0 });
  ok('category=exchange_deposit finds both, each once', byCategory.total === 2);
  // Kraken's own rows plus the two whose folded half is a Kraken record.
  const byAccount = await CryptoLedger.findForUser(1, { exchangeAccountId: accountId, limit: 100, offset: 0 });
  ok('the account filter reaches the folded record too', byAccount.total === 4);
  const byWallet = await CryptoLedger.findForUser(1, { walletId, limit: 100, offset: 0 });
  ok('the wallet filter keeps the folded pair and drops loose venue rows', byWallet.total === 3);
  const flagged = await CryptoLedger.findForUser(1, { needsReview: true, limit: 100, offset: 0 });
  ok('needs_review narrows the union', flagged.total === 3);

  // A flagged half must raise its host, or it leaves the queue while still
  // being unexplained.
  await pool.query("UPDATE exchange_records SET needs_review = TRUE WHERE external_id = 'DEP-1'");
  const afterFlag = await CryptoLedger.findForUser(1, { limit: 100, offset: 0 });
  ok('a flagged folded half raises the parent row',
    afterFlag.rows.find((r) => r.exchange_match)?.needs_review === true);
  ok('and the badge agrees with the filter',
    (await CryptoLedger.summaryForUser(1)).needs_review_count === 4);
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

  // A REJECTED pairing deletes the match row, so the pair splits back into two
  // rows and there is no match object to hang an undo on. Without a separate
  // handle the rejection is permanent AND invisible: the matcher will never
  // propose it again and nothing on screen can take it back.
  await pool.query('DELETE FROM exchange_match_verdicts');
  await pool.query('DELETE FROM exchange_matches WHERE activity_id IS NOT NULL');
  await pool.query(
    `INSERT INTO exchange_match_verdicts (exchange_record_id, wallet_id, chain_id, tx_hash, verdict)
     VALUES ($1, $2, 1, $3, 'rejected')`,
    [recordId('DEP-1'), walletId, DEPOSIT_TX]
  );
  const afterReject = await CryptoLedger.findForUser(1, { limit: 100, offset: 0 });
  // BOTH sides now carry that hash -- the on-chain row and the record that just
  // un-folded -- so the source has to be named, not inferred from the hash.
  const split = afterReject.rows.find((r) => r.source === 'onchain' && r.tx_hash === DEPOSIT_TX);
  const unfolded = afterReject.rows.find((r) => r.external_id === 'DEP-1');
  ok('rejecting splits the pair back into two rows',
    afterReject.total === 7 && split && split.exchange_match === null && unfolded);
  ok('a rejected pairing stays addressable, so it is not a one-way door',
    split && String(split.rejected_match?.exchange_record_id) === String(recordId('DEP-1')));
  // Put the confirmed verdict and the match back for the checks that follow.
  await pool.query('DELETE FROM exchange_match_verdicts');
  await pool.query(
    `INSERT INTO exchange_matches (exchange_record_id, activity_id, match_method, confidence)
     VALUES ($1, $2, 'tx_hash', 'high')`,
    [recordId('DEP-1'), activityIds[2]]
  );
  await pool.query(
    `INSERT INTO exchange_match_verdicts (exchange_record_id, wallet_id, chain_id, tx_hash, verdict)
     VALUES ($1, $2, 1, $3, 'confirmed')`,
    [recordId('DEP-1'), walletId, DEPOSIT_TX]
  );

  const summary = await CryptoLedger.summaryForUser(1);
  console.log('\nsummary =', summary);
  // exchange_count is RECORDS: 3 rendered on their own + 2 folded = 5, which is
  // what Settings' per-account record_count adds up to.
  // unpriced_count is ON-CHAIN only, matching what the unpriced banner can
  // actually name: just the `send` row here.
  ok('summary counts records (folded included) and prices honestly',
    summary.total === 6 && summary.onchain_count === 3 && summary.exchange_count === 5
      && summary.matched_count === 2 && summary.unpriced_count === 1);

  // The header sentence sits above the rows, so a wallet-filtered feed needs a
  // wallet-filtered summary: a user-wide total there described a ledger that
  // was not on screen.
  const walletSummary = await CryptoLedger.summaryForUser(1, { walletId });
  ok('the summary narrows to the same wallet the feed does',
    walletSummary.total === byWallet.total && walletSummary.total < summary.total);
  ok('and the wallet summary keeps the folded pair once, like the feed',
    walletSummary.onchain_count === 3 && walletSummary.matched_count === 1);

  const p1 = await CryptoLedger.findForUser(1, { limit: 3, offset: 0 });
  const p2 = await CryptoLedger.findForUser(1, { limit: 3, offset: 3 });
  const ids = [...p1.rows, ...p2.rows].map((r) => r.id);
  ok('paging is stable (no repeats, no drops)', new Set(ids).size === 6 && ids.length === 6);

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
  // The ON-CHAIN match CASCADEs off eth_activity; the venue-to-venue pair has
  // no activity_id and survives. That asymmetry is why 041's pass re-runs at
  // the end of every rebuild rather than only when a record changes.
  ok('the on-chain match CASCADEd away with the rebuild, as 041 designs for',
    (await pool.query('SELECT COUNT(*)::int AS n FROM exchange_matches')).rows[0].n === 1);
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
    (await CryptoLedger.findAllForUser(1, { limit: 10 })).length === 6);

  const other = await CryptoLedger.findForUser(2, { limit: 100, offset: 0 });
  ok('a second user sees none of it', other.total === 0);
  ok('and their summary is zero', (await CryptoLedger.summaryForUser(2)).total === 0);

  // COUNT(*) OVER() rides on the RETURNED rows, so a page past the end carries
  // no count at all and the header read "Showing 0 of 0" for a ledger with six
  // rows in it -- a pagination total that lies about the size of the feed.
  const beyond = await CryptoLedger.findForUser(1, { limit: 3, offset: 99 });
  ok('an out-of-range page still reports the real total, not 0',
    beyond.rows.length === 0 && beyond.total === 6);
  const beyondFiltered = await CryptoLedger.findForUser(1,
    { source: 'exchange', limit: 3, offset: 99 });
  ok('and the empty-page count honours the filters', beyondFiltered.total === 4);

  // --- one transaction, one ledger event ------------------------------------
  //
  // 038's UNIQUE is per (wallet, chain, tx_hash), so a transfer between two of
  // the user's OWN tracked wallets is TWO eth_activity rows for ONE movement.
  // Rendering both doubled the dollars and the event count.
  const wallet2 = await pool.query(
    "INSERT INTO eth_wallets (user_id, address, label) VALUES (1, $1, 'Second') RETURNING id",
    [addr('b')]
  );
  const wallet2Id = wallet2.rows[0].id;
  const SELF_TX = tx('7');
  await pool.query(
    `INSERT INTO eth_activity (wallet_id, chain_id, tx_hash, block_number, block_time, category,
       counterparty_address, legs, fee_wei, needs_review, usd_value, usd_basis)
     VALUES
       ($1, 1, $3, 19100000, '2026-04-01 10:00', 'self_transfer', $5,
        '[{"asset":"ETH","direction":"out","amount":"3"}]'::jsonb, '420000000000000', false, 6000.00, 'exact'),
       ($2, 1, $3, 19100000, '2026-04-01 10:00', 'self_transfer', $4,
        '[{"asset":"ETH","direction":"in","amount":"3"}]'::jsonb, 0, true, 6000.00, 'exact')`,
    [walletId, wallet2Id, SELF_TX, addr('a'), addr('b')]
  );

  const collapsed = await CryptoLedger.findForUser(1, { limit: 100, offset: 0 });
  const selfRows = collapsed.rows.filter((r) => r.tx_hash === SELF_TX);
  ok('a transfer between two tracked wallets is ONE ledger event', selfRows.length === 1);
  ok('hosted by the SENDING wallet, so the surviving legs and gas are the mover\'s',
    selfRows[0] && selfRows[0].wallet_id === walletId
      && selfRows[0].legs.length === 1 && selfRows[0].legs[0].direction === 'out');
  // The bug in numbers: $6,000 moved, and the feed said $12,000.
  ok('its dollars are counted ONCE, not doubled',
    selfRows.reduce((sum, r) => sum + Number(r.usd_value || 0), 0) === 6000);
  ok('the receiving side is folded in rather than dropped',
    selfRows[0]?.self_match?.length === 1
      && selfRows[0].self_match[0].wallet_id === wallet2Id
      && selfRows[0].self_match[0].legs[0].direction === 'in');
  // Same rule as the exchange fold: a flagged half that vanishes into an
  // explained host leaves the review queue while still being unexplained.
  ok('a flag on the folded half raises the collapsed row', selfRows[0]?.needs_review === true);
  // ...and the filter must NARROW to the event, never drop it: the receiving
  // wallet's own row is the one that got folded away.
  const byWallet2 = await CryptoLedger.findForUser(1, { walletId: wallet2Id, limit: 100, offset: 0 });
  ok('the receiving wallet still finds its own transfer',
    byWallet2.rows.some((r) => r.tx_hash === SELF_TX));

  const collapsedSummary = await CryptoLedger.summaryForUser(1);
  ok('the summary counts the collapsed transfer once, not twice',
    collapsedSummary.total === 7 && collapsedSummary.onchain_count === 4);
  const exportRows = await CryptoLedger.findAllForUser(1, { limit: 1000 });
  ok('and the CSV export emits one summable line for it',
    exportRows.filter((r) => r.tx_hash === SELF_TX).length === 1);

  // A cross-chain replay -- the same account, nonce and calldata submitted on
  // two chains -- genuinely shares a hash and is two real movements. This is
  // exactly why the partition is (chain_id, tx_hash) and never tx_hash alone.
  const REPLAY_TX = tx('8');
  await pool.query(
    `INSERT INTO eth_activity (wallet_id, chain_id, tx_hash, block_number, block_time, category,
       counterparty_address, legs, fee_wei, needs_review, usd_value, usd_basis)
     VALUES
       ($1, 1,     $2, 19200000, '2026-04-02 10:00', 'send', $3,
        '[{"asset":"ETH","direction":"out","amount":"0.1"}]'::jsonb, '100000000000000', false, 200.00, 'exact'),
       ($1, 42161, $2, 310000000, '2026-04-02 10:05', 'send', $3,
        '[{"asset":"ETH","direction":"out","amount":"0.1"}]'::jsonb, '100000000000000', false, 200.00, 'exact')`,
    [walletId, REPLAY_TX, addr('c')]
  );
  const replayed = await CryptoLedger.findForUser(1, { limit: 100, offset: 0 });
  ok('a cross-chain replay stays TWO events, because the hash is not the key',
    replayed.rows.filter((r) => r.tx_hash === REPLAY_TX).length === 2);

  // A wallet sending to ITSELF is one activity row already; the collapse must
  // not invent a fold for it.
  const SOLO_TX = tx('9');
  await pool.query(
    `INSERT INTO eth_activity (wallet_id, chain_id, tx_hash, block_number, block_time, category,
       counterparty_address, legs, fee_wei, needs_review, usd_value, usd_basis)
     VALUES ($1, 1, $2, 19300000, '2026-04-03 10:00', 'self_transfer', $3,
       '[]'::jsonb, '80000000000000', false, NULL, 'not_applicable')`,
    [walletId, SOLO_TX, addr('a')]
  );
  const soloRows = (await CryptoLedger.findForUser(1, { limit: 100, offset: 0 }))
    .rows.filter((r) => r.tx_hash === SOLO_TX);
  ok('a single-wallet self-send is untouched by the collapse',
    soloRows.length === 1 && soloRows[0].self_match === null);

  // --- rejecting a VENUE pair stays undoable --------------------------------
  //
  // Rejecting deletes the exchange_matches row, so the pair splits into two
  // rows carrying no match object. The exchange branch used to hardcode
  // rejected_verdict NULL, which made the rejection permanent: the Undo button
  // never rendered and no other screen reaches the clear endpoint.
  await pool.query('DELETE FROM exchange_matches WHERE counter_record_id IS NOT NULL');
  await pool.query(
    `INSERT INTO exchange_match_verdicts (exchange_record_id, counter_record_id, verdict)
     VALUES ($1, $2, 'rejected')`,
    [pairId('CB-WD-1'), pairId('KR-DEP-2')]
  );
  const venueSplit = await CryptoLedger.findForUser(1, { limit: 100, offset: 0 });
  const rejectedPrimary = venueSplit.rows.find((r) => r.external_id === 'CB-WD-1');
  const rejectedCounter = venueSplit.rows.find((r) => r.external_id === 'KR-DEP-2');
  ok('rejecting a venue pair splits it back into two rows',
    rejectedPrimary && rejectedCounter && rejectedPrimary.exchange_match === null);
  // Both halves, because either one is where the user might go to undo it.
  ok('and BOTH halves carry the handle that undoes it',
    String(rejectedPrimary?.rejected_match?.exchange_record_id) === String(pairId('CB-WD-1'))
      && String(rejectedPrimary?.rejected_match?.counter_record_id) === String(pairId('KR-DEP-2'))
      && String(rejectedCounter?.rejected_match?.exchange_record_id) === String(pairId('CB-WD-1'))
      && String(rejectedCounter?.rejected_match?.counter_record_id) === String(pairId('KR-DEP-2')));
  await pool.query('DELETE FROM exchange_match_verdicts WHERE counter_record_id IS NOT NULL');

  // --- a cross-user match row cannot leak ------------------------------------
  //
  // Nothing in the schema forbids an exchange_matches row whose two sides
  // belong to different users. The matcher never writes one; the ledger must
  // not depend on that.
  const foreignAccount = await pool.query(
    "INSERT INTO exchange_accounts (user_id, name, exchange) VALUES (2, 'Their Kraken', 'kraken') RETURNING id"
  );
  const foreignRecord = await pool.query(
    `INSERT INTO exchange_records (exchange_account_id, record_type, occurred_at, base_asset,
       base_amount, external_id, needs_review, source)
     VALUES ($1, 'deposit', '2026-02-20 18:45', 'ETH', 1.25, 'THEIRS-1', false, 'api')
     RETURNING id`,
    [foreignAccount.rows[0].id]
  );
  await pool.query('DELETE FROM exchange_matches WHERE activity_id IS NOT NULL');
  await pool.query(
    `INSERT INTO exchange_matches (exchange_record_id, activity_id, match_method, confidence)
     VALUES ($1, $2, 'tx_hash', 'high')`,
    [foreignRecord.rows[0].id, rebuiltIds.get(DEPOSIT_TX)]
  );
  const leaked = await CryptoLedger.findForUser(1, { limit: 100, offset: 0 });
  ok('a cross-user match row folds NOTHING into the owner\'s feed',
    leaked.rows.every((r) => r.exchange_match?.external_id !== 'THEIRS-1'));
  ok('and the foreign record is not suppressed from ITS owner\'s feed',
    (await CryptoLedger.findForUser(2, { limit: 100, offset: 0 }))
      .rows.some((r) => r.external_id === 'THEIRS-1'));

  // --- the spam quarantine, on the merged feed (#74) --------------------------
  //
  // The ledger is the "no transaction unexplained" screen, so a quarantine it
  // does not honour re-surfaces exactly the noise 045 removed -- and the badge
  // stops being able to reach zero, which is what made the queue ignorable in
  // the first place.
  const beforeSpam = await CryptoLedger.findForUser(1, { limit: 200, offset: 0 });
  const beforeSpamSummary = await CryptoLedger.summaryForUser(1);
  await pool.query(
    "UPDATE eth_activity SET spam = TRUE, spam_reason = 'unsolicited_token' WHERE tx_hash = $1",
    [tx('2')]
  );

  const defaultFeed = await CryptoLedger.findForUser(1, { limit: 200, offset: 0 });
  ok('a quarantined row leaves the default feed',
    defaultFeed.total === beforeSpam.total - 1
      && !defaultFeed.rows.some((r) => r.tx_hash === tx('2')));
  const onlySpam = await CryptoLedger.findForUser(1, { spam: 'only', limit: 200, offset: 0 });
  ok("spam='only' is the Spam view, and every row says why it is there",
    onlySpam.total === 1 && onlySpam.rows[0].tx_hash === tx('2')
      && onlySpam.rows[0].spam === true
      && onlySpam.rows[0].spam_reason === 'unsolicited_token');
  // Masked, not cleared: a quarantined row is "not worth explaining", which is
  // a different claim from "explained" -- and the masking is what makes the
  // rescue below lossless.
  ok('a quarantined row is not counted as unexplained',
    onlySpam.rows[0].needs_review === false && onlySpam.rows[0].review_reason === null);
  const allSpam = await CryptoLedger.findForUser(1, { spam: 'all', limit: 200, offset: 0 });
  ok("spam='all' is the whole history again", allSpam.total === beforeSpam.total);

  const spamSummary = await CryptoLedger.summaryForUser(1);
  ok('the summary drops it from every count and reports how many it hid',
    spamSummary.total === beforeSpamSummary.total - 1
      && spamSummary.needs_review_count === beforeSpamSummary.needs_review_count - 1
      && spamSummary.spam_count === 1);
  ok('the export honours the quarantine like the feed does',
    (await CryptoLedger.findAllForUser(1, { limit: 1000 })).every((r) => r.tx_hash !== tx('2'))
      && (await CryptoLedger.findAllForUser(1, { spam: 'only', limit: 1000 })).length === 1);

  // The one-click rescue has to restore the row AS THE LADDER LEFT IT -- flag
  // included. A false positive that came back already marked reviewed would be
  // a second, quieter way to lose it.
  await pool.query(
    `INSERT INTO eth_activity_overrides (wallet_id, chain_id, tx_hash, spam)
     VALUES ($1, 42161, $2, FALSE)
     ON CONFLICT (wallet_id, chain_id, tx_hash) DO UPDATE SET spam = FALSE`,
    [walletId, tx('2')]
  );
  const rescued = await CryptoLedger.findForUser(1, { limit: 200, offset: 0 });
  const rescuedRow = rescued.rows.find((r) => r.tx_hash === tx('2'));
  ok('"not spam" restores the row and uncovers the flag the ladder set',
    rescuedRow && rescuedRow.spam === false && rescuedRow.needs_review === true
      && rescuedRow.review_reason === 'unlabeled');
  await pool.query('DELETE FROM eth_activity_overrides WHERE tx_hash = $1', [tx('2')]);
  await pool.query(
    'UPDATE eth_activity SET spam = FALSE, spam_reason = NULL WHERE tx_hash = $1', [tx('2')]
  );

  // A spam verdict inside a COLLAPSE GROUP. The two halves of a wallet-to-wallet
  // transfer are two rows for one event, and they must agree about being
  // hidden: a spam row that vanished while its folded twin rendered would show
  // the same movement as both real and junk.
  await pool.query(
    `UPDATE eth_activity SET spam = TRUE, spam_reason = 'unsolicited_token'
     WHERE tx_hash = $1 AND wallet_id = $2`,
    [SELF_TX, wallet2Id]
  );
  const halfSpam = await CryptoLedger.findForUser(1, { limit: 200, offset: 0 });
  // ANDed, not ORed: one half saying "this is real" renders the event, because
  // a wrong quarantine hides a real movement while a missed one only leaves a
  // visible row unexplained.
  ok('one quarantined half does NOT hide a collapsed transfer',
    halfSpam.rows.some((r) => r.tx_hash === SELF_TX));
  ok('and the Spam view does not show it either, since the event is not hidden',
    !(await CryptoLedger.findForUser(1, { spam: 'only', limit: 200, offset: 0 }))
      .rows.some((r) => r.tx_hash === SELF_TX));
  await pool.query(
    `UPDATE eth_activity SET spam = TRUE, spam_reason = 'unsolicited_token'
     WHERE tx_hash = $1`,
    [SELF_TX]
  );
  const bothSpam = await CryptoLedger.findForUser(1, { limit: 200, offset: 0 });
  const bothSpamOnly = await CryptoLedger.findForUser(1, { spam: 'only', limit: 200, offset: 0 });
  ok('a unanimously quarantined group hides, and hides exactly ONCE',
    !bothSpam.rows.some((r) => r.tx_hash === SELF_TX)
      && bothSpamOnly.rows.filter((r) => r.tx_hash === SELF_TX).length === 1);
  await pool.query(
    'UPDATE eth_activity SET spam = FALSE, spam_reason = NULL WHERE tx_hash = $1', [SELF_TX]
  );

  // --- a linked bridge pair is ONE event (#59) --------------------------------
  //
  // A bridge_out on chain A and the bridge_in that completes it on chain B are
  // one movement of the user's own money that the chains recorded twice, with
  // different hashes and different per-chain block numbers -- so nothing else
  // in this query merges them.
  const BRIDGE_OUT_TX = tx('a');
  const BRIDGE_IN_TX = tx('b');
  const beforeBridge = await CryptoLedger.summaryForUser(1);
  const bridgeRows = await pool.query(
    `INSERT INTO eth_activity (wallet_id, chain_id, tx_hash, block_number, block_time, category,
       counterparty_address, legs, fee_wei, needs_review, usd_value, usd_basis)
     VALUES
       ($1, 1,     $3, 19400000, '2026-05-01 10:00', 'bridge_out', $5,
        '[{"asset":"ETH","direction":"out","amount":"3"}]'::jsonb, '500000000000000', false, 6000.00, 'exact'),
       ($2, 42161, $4, 320000000, '2026-05-01 10:12', 'bridge_in',  $5,
        '[{"asset":"ETH","direction":"in","amount":"2.998"}]'::jsonb, 0, false, 5996.00, 'exact')
     RETURNING id, tx_hash`,
    [walletId, wallet2Id, BRIDGE_OUT_TX, BRIDGE_IN_TX, addr('f')]
  );
  const bridgeId = (hash) => bridgeRows.rows.find((r) => r.tx_hash === hash).id;
  await pool.query(
    `INSERT INTO eth_activity_links (out_activity_id, in_activity_id, asset, out_amount, in_amount, fee_amount)
     VALUES ($1, $2, 'ETH', 3, 2.998, 0.002)`,
    [bridgeId(BRIDGE_OUT_TX), bridgeId(BRIDGE_IN_TX)]
  );

  const bridged = await CryptoLedger.findForUser(1, { limit: 200, offset: 0 });
  const bridgeHost = bridged.rows.find((r) => r.tx_hash === BRIDGE_OUT_TX);
  ok('a linked bridge pair renders as ONE row, hosted by the out side',
    bridgeHost && !bridged.rows.some((r) => r.tx_hash === BRIDGE_IN_TX)
      && bridgeHost.category === 'bridge_out' && bridgeHost.chain_id === 1);
  ok('the arrival is folded in with its own coordinates, not dropped',
    bridgeHost?.bridge_match
      && bridgeHost.bridge_match.tx_hash === BRIDGE_IN_TX
      && bridgeHost.bridge_match.chain_id === 42161
      && bridgeHost.bridge_match.wallet_id === wallet2Id
      && bridgeHost.bridge_match.legs[0].amount === '2.998');
  // Exact strings, never JSON doubles -- the same rule the venue fold follows.
  ok('the bridge fee and amounts arrive as exact strings',
    bridgeHost?.bridge_match.asset === 'ETH'
      && typeof bridgeHost.bridge_match.fee_amount === 'string'
      && Number(bridgeHost.bridge_match.fee_amount) === 0.002);
  // The bug in numbers: $6,000 moved, and two rows would report $11,996.
  ok('the dollars are counted ONCE, not once per chain',
    bridged.rows
      .filter((r) => r.tx_hash === BRIDGE_OUT_TX || r.tx_hash === BRIDGE_IN_TX)
      .reduce((sum, r) => sum + Number(r.usd_value || 0), 0) === 6000);
  const afterBridge = await CryptoLedger.summaryForUser(1);
  ok('the summary counts the pair once, and says how many pairs it folded',
    afterBridge.total === beforeBridge.total + 1
      && afterBridge.bridge_matched_count === 1);
  ok('and the CSV export emits one summable line for it',
    (await CryptoLedger.findAllForUser(1, { limit: 1000 }))
      .filter((r) => r.tx_hash === BRIDGE_OUT_TX || r.tx_hash === BRIDGE_IN_TX).length === 1);
  // The folded half stays addressable, or the filter DROPS the event instead of
  // narrowing to it -- the failure the venue fold's second arm exists for.
  ok('?category=bridge_in still finds the event through its host',
    (await CryptoLedger.findForUser(1, { category: 'bridge_in', limit: 200, offset: 0 }))
      .rows.some((r) => r.tx_hash === BRIDGE_OUT_TX));
  ok('and the RECEIVING wallet finds it too',
    (await CryptoLedger.findForUser(1, { walletId: wallet2Id, limit: 200, offset: 0 }))
      .rows.some((r) => r.tx_hash === BRIDGE_OUT_TX));

  // An UNLINKED leg is still one honest row: the ladder flagged it, and nothing
  // here may present it as a completed transfer.
  const LONE_BRIDGE_TX = tx('c');
  await pool.query(
    `INSERT INTO eth_activity (wallet_id, chain_id, tx_hash, block_number, block_time, category,
       counterparty_address, legs, fee_wei, needs_review, review_reason, usd_value, usd_basis)
     VALUES ($1, 1, $2, 19500000, '2026-05-02 10:00', 'bridge_out', $3,
       '[{"asset":"ETH","direction":"out","amount":"1"}]'::jsonb, '300000000000000', true,
       'unmatched_bridge', 2000.00, 'exact')`,
    [walletId, LONE_BRIDGE_TX, addr('f')]
  );
  const withLone = await CryptoLedger.findForUser(1, { limit: 200, offset: 0 });
  const lone = withLone.rows.find((r) => r.tx_hash === LONE_BRIDGE_TX);
  ok('an unlinked bridge leg stays a single, still-flagged row',
    lone && lone.bridge_match === null && lone.needs_review === true);

  // --- a cross-user link cannot leak ------------------------------------------
  //
  // eth_activity_links has no owner column (scope is inherited through
  // eth_wallets), so nothing in the schema forbids a link naming another user's
  // activity row. Reached by id, that would render user 2's transaction inside
  // user 1's feed.
  const foreignWallet = await pool.query(
    "INSERT INTO eth_wallets (user_id, address, label) VALUES (2, $1, 'Theirs') RETURNING id",
    [addr('e')]
  );
  const foreignLeg = await pool.query(
    `INSERT INTO eth_activity (wallet_id, chain_id, tx_hash, block_number, block_time, category,
       counterparty_address, legs, fee_wei, needs_review, usd_value, usd_basis)
     VALUES ($1, 42161, $2, 320500000, '2026-05-02 10:10', 'bridge_in', $3,
       '[{"asset":"ETH","direction":"in","amount":"1"}]'::jsonb, 0, true, 2000.00, 'exact')
     RETURNING id`,
    [foreignWallet.rows[0].id, tx('d'), addr('f')]
  );
  await pool.query(
    `INSERT INTO eth_activity_links (out_activity_id, in_activity_id, asset, out_amount, in_amount, fee_amount)
     SELECT id, $2, 'ETH', 1, 1, 0 FROM eth_activity WHERE tx_hash = $1`,
    [LONE_BRIDGE_TX, foreignLeg.rows[0].id]
  );
  const afterForeignLink = await CryptoLedger.findForUser(1, { limit: 200, offset: 0 });
  ok('a cross-user link folds NOTHING into the owner\'s feed',
    afterForeignLink.rows.find((r) => r.tx_hash === LONE_BRIDGE_TX)?.bridge_match === null);
  ok('and it does not suppress the other user\'s own row either',
    (await CryptoLedger.findForUser(2, { limit: 200, offset: 0 }))
      .rows.some((r) => r.tx_hash === tx('d')));

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

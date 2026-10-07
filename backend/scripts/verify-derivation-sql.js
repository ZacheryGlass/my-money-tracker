'use strict';

// Runs the REAL derived pipeline (EthDerivedPipeline.runForUser) against a
// throwaway Postgres. verify-ledger-sql.js seeds eth_activity directly, so
// without this the derivation itself -- reclassify, valuation, the activity
// ladder, exchange and bridge matching, the mirror -- never executes against
// real SQL anywhere in the suite.
//
//   node scripts/verify-derivation-sql.js [--pg-bin /path/to/postgres/bin]
//
// Provider calls are stubbed: receipts come back empty and no API key is read,
// so the run is deterministic and offline. Seeds go through the production
// normalizer (EthWalletService.normalizeFeeds) and model inserts.

const { startCluster, applyMigrations } = require('./lib/throwawayCluster');

const checks = [];
const ok = (name, condition, detail) => {
  checks.push([name, Boolean(condition)]);
  if (!condition && detail !== undefined) console.log(`  detail for "${name}":`, detail);
};

const tx = (c) => `0x${c.repeat(64)}`;
const addr = (c) => `0x${c.repeat(40)}`;
const ETH = (n) => (BigInt(Math.round(n * 1e6)) * 10n ** 12n).toString();
const day = (iso) => String(Math.floor(Date.parse(`${iso}T12:00:00Z`) / 1000));

const WALLET_A = addr('a');
const WALLET_B = addr('b');
const WALLET_C = addr('c');
const STRANGER = addr('d');
const OWN_COLD = addr('e');
const USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';
const SPAM = addr('f');
const OP_L1_BRIDGE = '0x99c9fc46f92e8a1c0dec1b1747d010903e884be1';
const OP_L2_BRIDGE = '0x4200000000000000000000000000000000000010';

function normal(hash, from, to, value, date, { block = 100, gasUsed = '21000', gasPrice = '1000000000', isError = '0', methodId = '0x', functionName = '' } = {}) {
  return { hash, from, to, value, blockNumber: String(block), timeStamp: day(date), gasUsed, gasPrice, isError, methodId, functionName };
}
function token(hash, from, to, value, date, { block = 100, contract = USDC, symbol = 'USDC', decimals = '6', logIndex = '1' } = {}) {
  return { hash, from, to, value, blockNumber: String(block), timeStamp: day(date), contractAddress: contract, tokenSymbol: symbol, tokenDecimal: decimals, logIndex };
}

(async () => {
  let cluster;
  try {
    cluster = await startCluster({ prefix: 'derivation-verify-' });
    applyMigrations(cluster.url, { passes: 1 });
  } catch (error) {
    console.error(error.message);
    process.exit(error.code === 'NO_PG_BIN' ? 2 : 1);
  }
  process.env.DATABASE_URL = cluster.url;
  process.env.NODE_ENV = 'test';
  process.env.LOG_LEVEL = process.env.LOG_LEVEL || 'silent';
  process.env.ETH_CHAINS = '1,10';

  const pool = require('../src/config/database');
  const advisoryLocks = require('../src/config/advisoryLocks');
  const EthTransfer = require('../src/models/EthTransfer');
  const EthWalletService = require('../src/services/EthWalletService');
  const EtherscanService = require('../src/services/EtherscanService');
  const SecretsService = require('../src/services/SecretsService');
  const EthDerivedPipeline = require('../src/services/EthDerivedPipeline');
  const { computeDigest } = require('./lib/derivedDigest');

  // Offline: no key, and every receipt fetch fails as unsupported, which is
  // the provider-down shape the pipeline must already tolerate.
  SecretsService.getUserKey = async () => null;
  const receiptCalls = [];
  EtherscanService.getTransactionEvidence = async (hash, apiKey, chainId) => {
    receiptCalls.push(`${chainId}:${hash}`);
    const error = new Error('offline harness');
    error.code = 'ETHERSCAN_NOT_CONFIGURED';
    throw error;
  };

  // A hang is a failure with evidence: after the budget, print what every
  // backend is waiting on and exit nonzero instead of stalling CI.
  const watchdog = setTimeout(async () => {
    const { Client } = require('pg');
    const probe = new Client({ connectionString: cluster.url });
    try {
      await probe.connect();
      const { rows } = await probe.query(
        `SELECT pid, state, wait_event_type, wait_event, LEFT(query, 160) AS query
           FROM pg_stat_activity WHERE datname = current_database() AND pid <> pg_backend_pid()`
      );
      console.error('WATCHDOG: harness exceeded its time budget; backends:', rows);
    } finally {
      cluster.stop();
      process.exit(1);
    }
  }, Number(process.env.HARNESS_TIMEOUT_MS || 240000));
  watchdog.unref();

  const q = (sql, params) => pool.query(sql, params);
  await q("INSERT INTO users (id, username) VALUES (1, 'verify'), (2, 'other') ON CONFLICT (id) DO NOTHING");

  async function addWallet(userId, address, label) {
    const { rows: [wallet] } = await q(
      'INSERT INTO eth_wallets (user_id, address, label) VALUES ($1, $2, $3) RETURNING id',
      [userId, address, label]
    );
    await q(
      "INSERT INTO accounts (name, type, display_name, eth_wallet_id, user_id) VALUES ($1, 'crypto', $2, $3, $4)",
      [`ETH Wallet (${address.slice(0, 8)})`, label, wallet.id, userId]
    );
    for (const chainId of [1, 10]) {
      await q('INSERT INTO eth_wallet_chains (wallet_id, chain_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [wallet.id, chainId]);
    }
    return wallet.id;
  }
  async function ingest(walletId, address, chainId, feeds) {
    const rows = EthWalletService.normalizeFeeds(address, feeds).map((row) => ({ ...row, wallet_id: walletId, chain_id: chainId }));
    await EthTransfer.bulkInsert(rows);
    return rows.length;
  }

  const walletA = await addWallet(1, WALLET_A, 'Main');
  const walletB = await addWallet(1, WALLET_B, 'Savings');
  const walletC = await addWallet(2, WALLET_C, 'Other user');

  const { rows: [exchangeHot] } = await q(
    "SELECT address FROM eth_address_labels WHERE user_id IS NULL AND kind = 'exchange' AND source = 'builtin' ORDER BY address LIMIT 1"
  );

  // Wallet A, mainnet: exchange withdrawal in, self transfer to B, an
  // unlabeled send, a send to an own-labeled cold address, a token swap leg
  // pair, a reverted call, a spam airdrop, and a canonical bridge deposit.
  await ingest(walletA, WALLET_A, 1, {
    normal: [
      normal(tx('1'), exchangeHot.address, WALLET_A, ETH(2), '2021-01-04', { block: 101 }),
      normal(tx('2'), WALLET_A, WALLET_B, ETH(1), '2021-01-05', { block: 102 }),
      normal(tx('3'), WALLET_A, STRANGER, ETH(0.25), '2021-01-06', { block: 103 }),
      normal(tx('4'), WALLET_A, OWN_COLD, ETH(0.1), '2021-01-07', { block: 104 }),
      normal(tx('5'), WALLET_A, STRANGER, ETH(0.05), '2021-01-08', { block: 105 }),
      normal(tx('6'), WALLET_A, STRANGER, '0', '2021-01-09', { block: 106, isError: '1', methodId: '0x095ea7b3' }),
      normal(tx('7'), WALLET_A, OP_L1_BRIDGE, ETH(0.3), '2021-01-10', { block: 107, methodId: '0xb1a1a882' }),
    ],
    token: [
      token(tx('5'), STRANGER, WALLET_A, '150000000', '2021-01-08', { block: 105 }),
      token(tx('8'), SPAM, WALLET_A, '1000000000000000000000', '2021-01-11', { block: 108, contract: SPAM, symbol: 'SCAM', decimals: '18' }),
    ],
  });
  // Wallet A, OP Mainnet: the far side of the bridge.
  await ingest(walletA, WALLET_A, 10, {
    normal: [normal(tx('9'), OP_L2_BRIDGE, WALLET_A, ETH(0.3), '2021-01-10', { block: 9001, gasUsed: '0' })],
  });
  // Wallet B receives the self transfer; wallet C belongs to another user.
  await ingest(walletB, WALLET_B, 1, {
    normal: [normal(tx('2'), WALLET_A, WALLET_B, ETH(1), '2021-01-05', { block: 102 })],
  });
  await ingest(walletC, WALLET_C, 1, {
    normal: [normal(tx('c'), exchangeHot.address, WALLET_C, ETH(5), '2021-02-01', { block: 200 })],
  });

  // Inputs the user decided: an own label, a category override with a note,
  // an ignored token, a confirmed bridge pairing, dated ETH prices.
  await q("INSERT INTO eth_address_labels (user_id, address, name, kind, source) VALUES (1, $1, 'Cold storage', 'own', 'user')", [OWN_COLD]);
  await q("INSERT INTO eth_activity_overrides (wallet_id, chain_id, tx_hash, category, note) VALUES ($1, 1, $2, 'spend', 'coffee')", [walletA, tx('3')]);
  await q("INSERT INTO eth_ignored_tokens (user_id, contract_address, symbol) VALUES (1, $1, 'SCAM')", [SPAM]);
  await q(
    `INSERT INTO eth_bridge_verdicts (user_id, out_wallet_id, out_chain_id, out_tx_hash, in_wallet_id, in_chain_id, in_tx_hash, verdict, note)
     VALUES (1, $1, 1, $2, $1, 10, $3, 'confirmed', 'harness')`,
    [walletA, tx('7'), tx('9')]
  );
  for (const [date, price] of [['2021-01-04', '1000'], ['2021-01-05', '1100'], ['2021-01-06', '1200'], ['2021-01-07', '1150'],
    ['2021-01-08', '1225'], ['2021-01-09', '1250'], ['2021-01-10', '1300'], ['2021-01-11', '1280'], ['2021-02-01', '1400']]) {
    await q("INSERT INTO asset_price_history (asset_key, price_date, price_usd, source) VALUES ($1, $2, $3, 'coinbase') ON CONFLICT DO NOTHING", ['ETH', date, price]);
  }

  // Venue side: a Coinbase withdrawal that IS the on-chain tx 1.
  const { rows: [venue] } = await q("INSERT INTO exchange_accounts (user_id, name, exchange) VALUES (1, 'Coinbase', 'coinbase') RETURNING id");
  await q(
    `INSERT INTO exchange_records (exchange_account_id, record_type, occurred_at, base_asset, base_amount, tx_hash, address, external_id, needs_review, network, chain_id)
     VALUES ($1, 'withdrawal', '2021-01-04T11:59:00Z', 'ETH', -2, $2, $3, 'cb:harness-1', FALSE, 'ethereum', 1)`,
    [venue.id, tx('1'), WALLET_A]
  );

  const snapshot = async (userId) => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const digest = await computeDigest(client, userId, { keepLines: true });
      await client.query('ROLLBACK');
      return digest;
    } finally {
      client.release();
    }
  };

  // --- scenario: two consecutive full rebuilds are identical ----------------
  const otherBefore = await snapshot(2);
  await EthDerivedPipeline.runForUser(1, { reclassify: true, context: 'harness pass 1' });
  const first = await snapshot(1);
  await EthDerivedPipeline.runForUser(1, { reclassify: true, context: 'harness pass 2' });
  const second = await snapshot(1);

  ok('two consecutive full rebuilds give identical derived digests',
    first.derived_sha256 === second.derived_sha256,
    require('./lib/derivedDigest').diffDigests(first, second).derived);
  ok('rebuilds do not change their inputs', first.input_sha256 === second.input_sha256);
  ok('rebuilding user 1 leaves user 2 untouched', (await snapshot(2)).derived_sha256 === otherBefore.derived_sha256);

  const activity = async (hash, walletId = walletA, chainId = 1) => (await q(
    `SELECT a.category, a.needs_review, a.spam, COALESCE(o.category, a.category) AS resolved
       FROM eth_activity a
       LEFT JOIN eth_activity_overrides o ON o.wallet_id = a.wallet_id AND o.chain_id = a.chain_id AND o.tx_hash = a.tx_hash
      WHERE a.wallet_id = $1 AND a.chain_id = $2 AND a.tx_hash = $3`,
    [walletId, chainId, hash]
  )).rows[0];

  ok('ladder: exchange label -> exchange_withdrawal', (await activity(tx('1')))?.category === 'exchange_withdrawal', await activity(tx('1')));
  ok('ladder: tracked wallet -> self_transfer on both sides',
    (await activity(tx('2')))?.category === 'self_transfer' && (await activity(tx('2'), walletB))?.category === 'self_transfer');
  ok('ladder: unlabeled send is flagged', (await activity(tx('3')))?.needs_review === true);
  ok('override resolves over the derived category', (await activity(tx('3')))?.resolved === 'spend');
  ok('ladder: own label -> self_transfer', (await activity(tx('4')))?.category === 'self_transfer', await activity(tx('4')));
  ok('ladder: fungible out + different fungible in -> swap', (await activity(tx('5')))?.category === 'swap', await activity(tx('5')));
  ok('ladder: reverted call -> failed', (await activity(tx('6')))?.category === 'failed', await activity(tx('6')));
  ok('ladder: bridge endpoint -> bridge_out / bridge_in',
    (await activity(tx('7')))?.category === 'bridge_out' && (await activity(tx('9'), walletA, 10))?.category === 'bridge_in',
    [await activity(tx('7')), await activity(tx('9'), walletA, 10)]);

  const matches = (await q(
    `SELECT m.match_method FROM exchange_matches m JOIN exchange_records er ON er.id = m.exchange_record_id
      WHERE er.external_id = 'cb:harness-1'`
  )).rows;
  ok('exchange match folds the venue withdrawal into tx 1 by hash', matches.length === 1, matches);

  const links = (await q(
    `SELECT l.evidence_method FROM eth_activity_links l JOIN eth_activity a ON a.id = l.out_activity_id
      WHERE a.tx_hash = $1`, [tx('7')]
  )).rows;
  ok('confirmed bridge verdict projects one link', links.length === 1 && links[0].evidence_method != null, links);

  const mirror = (await q(
    `SELECT COUNT(*)::int AS n FROM transactions t JOIN accounts a ON a.id = t.account_id
      WHERE a.user_id = 1 AND t.eth_transfer_id IS NOT NULL`
  )).rows[0].n;
  ok('mirror publishes priced legs for user 1', mirror > 0, mirror);

  const valued = (await q(
    `SELECT COUNT(*) FILTER (WHERE usd_basis = 'exact')::int AS exact, COUNT(*)::int AS total
       FROM eth_transfers WHERE wallet_id = $1 AND chain_id = 1 AND transfer_type IN ('native', 'gas')`, [walletA]
  )).rows[0];
  ok('valuation prices native and gas legs from the dated series', valued.exact === valued.total && valued.total > 0, valued);

  ok('derived digest is non-trivial',
    first.derived.eth_activity.rows >= 9 && first.derived.eth_activity_links.rows === 1, first.derived);

  ok('label/ignore-style refreshes (runForUser) fetch no receipts', receiptCalls.length === 0, receiptCalls);
  await EthDerivedPipeline.serializedForUser(1, () => EthDerivedPipeline.finishUser(1, { context: 'harness sync tail' }));
  ok('a sync tail acquires receipts for unsettled bridge candidates', receiptCalls.length === 2, receiptCalls);
  ok('a sync tail over the same inputs keeps the digest', (await snapshot(1)).derived_sha256 === first.derived_sha256);

  // --- scenario: the EVM audit derives tokens like the ledger does ---------
  const EvmAudit = require('../src/models/EvmAudit');
  const { rows: [subject] } = await q(
    'INSERT INTO evm_subjects (user_id, address) VALUES (1, $1) RETURNING id', [WALLET_A]
  );
  const auditTokens = await EvmAudit.tokenDerivedAt(1, subject.id, 1, 1000000);
  ok('audit token derivation keeps held ERC-20s and leaves ignored tokens out',
    auditTokens.some((row) => row.token_contract === USDC && row.balance_units === '150000000')
      && !auditTokens.some((row) => row.token_contract === SPAM), auditTokens);
  const observed = await EvmAudit.observedErc20Contracts(1, 0, subject.id, 1, 1000000);
  ok('audit observed-token query runs against the real schema', Array.isArray(observed));

  // --- scenario: an unchanged reclassify writes nothing ----------------------
  // xmin moves on every row an UPDATE rewrites, even to the same value.
  const xmins = async () => (await q('SELECT id, xmin::text AS x FROM eth_transfers ORDER BY id')).rows.map((r) => `${r.id}:${r.x}`).join(',');
  const xminBefore = await xmins();
  await EthTransfer.reclassifyCounterparties(1);
  ok('a reclassify that changes no verdict rewrites no transfer row', (await xmins()) === xminBefore);

  // --- scenario: a replace that fails mid-write keeps the previous rows -----
  const EthActivity = require('../src/models/EthActivity');
  const EthTransactionMirrorService = require('../src/services/EthTransactionMirrorService');
  const countActivity = async () => Number((await q('SELECT COUNT(*) AS n FROM eth_activity WHERE wallet_id = $1', [walletA])).rows[0].n);
  const countMirror = async () => Number((await q(
    `SELECT COUNT(*) AS n FROM transactions t JOIN accounts a ON a.id = t.account_id
      WHERE a.eth_wallet_id = $1 AND t.eth_transfer_id IS NOT NULL`, [walletA]
  )).rows[0].n);
  const activityBefore = await countActivity();
  const mirrorBefore = await countMirror();
  const goodRow = { chain_id: 1, tx_hash: tx('1'), block_number: 1, block_time: new Date(), category: 'receive', legs: [] };
  let activityFailed = false;
  try {
    // The second row violates eth_activity's category CHECK after the DELETE
    // and the first insert chunk have run inside the transaction.
    await EthActivity.replaceForWallet(walletA, [goodRow, ...Array.from({ length: 250 }, (_, i) => ({
      ...goodRow, tx_hash: `0x${i.toString(16).padStart(64, '0')}`, category: i === 249 ? 'not_a_category' : 'receive',
    }))]);
  } catch {
    activityFailed = true;
  }
  ok('a failed activity replace keeps every previous row',
    activityFailed && (await countActivity()) === activityBefore, { activityFailed, before: activityBefore, after: await countActivity() });

  const realConnect = pool.connect.bind(pool);
  // pool.query() checks out clients through the callback form; only the
  // promise form (an explicit transaction client) gets the failing insert.
  pool.connect = async (callback) => {
    if (typeof callback === 'function') return realConnect(callback);
    const client = await realConnect();
    const realQuery = client.query.bind(client);
    client.query = (text, params) => (/INSERT INTO transactions/.test(String(text))
      ? Promise.reject(new Error('injected mirror insert failure')) : realQuery(text, params));
    const realRelease = client.release.bind(client);
    client.release = (...args) => { client.query = realQuery; return realRelease(...args); };
    return client;
  };
  let mirrorFailed = false;
  try {
    await EthTransactionMirrorService.rebuildForWallet(walletA, { includeBridgeLinks: true });
  } catch {
    mirrorFailed = true;
  } finally {
    pool.connect = realConnect;
  }
  ok('a failed mirror replace keeps every previous row',
    mirrorFailed && (await countMirror()) === mirrorBefore && mirrorBefore > 0, { mirrorFailed, before: mirrorBefore, after: await countMirror() });
  ok('failed replaces leave the derived digest unchanged', (await snapshot(1)).derived_sha256 === second.derived_sha256);

  // --- scenario: concurrent rebuilds and match passes, production locking ---
  // Session lane lock + transaction EXM1/BRID locks, as production takes them.
  // Every combination must finish (no 40P01) and land on the same answer.
  const ExchangeMatchService = require('../src/services/ExchangeMatchService');
  process.env.NODE_ENV = 'production';
  let concurrencyError = null;
  try {
    await Promise.all([
      EthDerivedPipeline.runForUser(1, { reclassify: true, context: 'harness concurrent 1' }),
      ExchangeMatchService.rebuildForUser(1),
      EthDerivedPipeline.runForUser(1, { context: 'harness concurrent 2' }),
      ExchangeMatchService.rebuildForUser(1),
      EthDerivedPipeline.runForUser(2, { context: 'harness concurrent other user' }),
    ]);
  } catch (error) {
    concurrencyError = error;
  } finally {
    process.env.NODE_ENV = 'test';
  }
  ok('concurrent rebuilds and match passes finish without deadlock', !concurrencyError, concurrencyError && { message: concurrencyError.message, detail: concurrencyError.detail, where: concurrencyError.where, stack: concurrencyError.stack?.split('\n').slice(0, 8) });
  const afterConcurrency = await snapshot(1);
  ok('concurrent rebuilds land on the sequential answer',
    afterConcurrency.derived_sha256 === first.derived_sha256,
    require('./lib/derivedDigest').diffDigests(first, afterConcurrency).derived);

  // --- scenario: protocol identity survives a user label (S1.8) -------------
  // Last-section scenarios add rows the earlier digest comparisons never had.
  const { rows: [etherDelta] } = await q(
    "SELECT address FROM eth_address_labels WHERE user_id IS NULL AND source = 'builtin-etherdelta' LIMIT 1"
  );
  await ingest(walletA, WALLET_A, 1, {
    normal: [normal(tx('e'), WALLET_A, etherDelta.address, ETH(0.2), '2021-01-11', { block: 110 })],
  });
  const edActivity = async () => (await q(
    `SELECT category, protocol_interpretation->>'protocol' AS protocol, counterparty_name
       FROM eth_activity WHERE wallet_id = $1 AND tx_hash = $2`, [walletA, tx('e')]
  )).rows[0];
  const relabel = async (kind, name) => {
    await q(
      `INSERT INTO eth_address_labels (user_id, address, name, kind, source) VALUES (1, $1, $2, $3, 'user')
       ON CONFLICT (user_id, address) WHERE user_id IS NOT NULL DO UPDATE SET name = EXCLUDED.name, kind = EXCLUDED.kind`,
      [etherDelta.address, name, kind]
    );
    await EthDerivedPipeline.runForUser(1, { reclassify: true, revalue: false, context: 'harness relabel' });
    return edActivity();
  };
  await EthDerivedPipeline.runForUser(1, { reclassify: true, context: 'harness etherdelta' });
  const unlabeled = await edActivity();
  ok('builtin EtherDelta custody: exchange_deposit with the protocol explanation',
    unlabeled?.category === 'exchange_deposit' && unlabeled?.protocol === 'EtherDelta', unlabeled);
  const renamed = await relabel('external', 'Old DEX custody');
  ok('a rename keeps the custody verdict, the explanation, and the user\'s name',
    renamed?.category === 'exchange_deposit' && renamed?.protocol === 'EtherDelta' && renamed?.counterparty_name === 'Old DEX custody', renamed);
  const owned = await relabel('own', 'Actually mine');
  ok("an 'own' verdict removes protocol identity", owned?.category === 'self_transfer' && owned?.protocol == null, owned);
  await q('DELETE FROM eth_address_labels WHERE user_id = 1 AND address = $1', [etherDelta.address]);

  // --- scenario: the ignore toggle refreshes holdings from the database ------
  // Last: it adds token holdings the earlier digest comparisons never had.
  let balanceCalls = 0;
  const realBalance = EtherscanService.getEthBalance;
  EtherscanService.getEthBalance = async () => { balanceCalls += 1; throw new Error('no network in the ignore path'); };
  try {
    await EthWalletService.refreshDerivedForUser(1);
  } finally {
    EtherscanService.getEthBalance = realBalance;
  }
  const tokenHoldings = (await q(
    `SELECT h.name, h.manual_value FROM holdings h JOIN accounts a ON a.id = h.account_id
      WHERE a.eth_wallet_id = $1 AND h.ticker IS NULL ORDER BY h.name`, [walletA]
  )).rows;
  ok('the ignore toggle reads no live balance', balanceCalls === 0, balanceCalls);
  ok('ledger holdings keep a held token and drop the ignored one',
    tokenHoldings.some((h) => /USDC/.test(h.name)) && !tokenHoldings.some((h) => /SCAM/.test(h.name)), tokenHoldings);

  // LEDGER_DUMP=<path> writes the unified ledger's page, summary and export
  // rows for user 1, so two versions of CryptoLedger can be diffed byte for byte.
  if (process.env.LEDGER_DUMP) {
    const CryptoLedger = require('../src/models/CryptoLedger');
    const dump = {};
    for (const spam of ['exclude', 'all']) {
      dump[`page:${spam}`] = await CryptoLedger.findForUser(1, { spam, limit: 500, offset: 0 });
      dump[`summary:${spam}`] = await CryptoLedger.summaryForUser(1, { spam });
      dump[`export:${spam}`] = await CryptoLedger.findAllForUser(1, { spam });
      dump[`wallet-b:${spam}`] = await CryptoLedger.findForUser(1, { spam, walletId: walletB, limit: 500, offset: 0 });
    }
    require('fs').writeFileSync(process.env.LEDGER_DUMP, JSON.stringify(dump, null, 1));
  }

  await pool.end();
  await advisoryLocks.end();

  console.log('\n--- checks ---');
  let failed = 0;
  for (const [name, passed] of checks) {
    console.log(`${passed ? 'PASS  ' : 'FAIL  '}${name}`);
    if (!passed) failed += 1;
  }
  console.log(failed ? `\n${failed} CHECK(S) FAILED` : `\nALL ${checks.length} CHECKS PASSED`);
  cluster.stop();
  process.exit(failed ? 1 : 0);
})().catch((error) => {
  console.error(error);
  process.exit(1);
});

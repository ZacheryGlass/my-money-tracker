'use strict';

// Runs ExchangeRecord.bulkInsert -- the venue-agnostic store every CSV import
// and API sync writes through -- against a throwaway Postgres. The fake-pool
// suite can only assert its SQL as text; this proves the identity rules
// against real constraints and real ON CONFLICT behavior:
//   replay, the one-directional upgrade guard, cross-source fingerprint merge,
//   the Binance.US fill fold and capital-overlap block, the Kraken fee-parent
//   rule, and backfillChainDetails.
//
//   node scripts/verify-exchange-sql.js [--pg-bin /path/to/postgres/bin]

const fs = require('fs');
const path = require('path');
const { startCluster, applyMigrations } = require('./lib/throwawayCluster');

const checks = [];
const ok = (name, condition, detail) => {
  checks.push([name, Boolean(condition)]);
  if (!condition && detail !== undefined) console.log(`  detail for "${name}":`, detail);
};
const FIXTURES = path.join(__dirname, '..', 'tests', 'fixtures', 'exchanges');

(async () => {
  let cluster;
  try {
    cluster = await startCluster({ prefix: 'exchange-verify-' });
    applyMigrations(cluster.url, { passes: 1 });
  } catch (error) {
    console.error(error.message);
    process.exit(error.code === 'NO_PG_BIN' ? 2 : 1);
  }
  process.env.DATABASE_URL = cluster.url;
  process.env.NODE_ENV = 'test';
  process.env.LOG_LEVEL = process.env.LOG_LEVEL || 'silent';

  const pool = require('../src/config/database');
  const ExchangeRecord = require('../src/models/ExchangeRecord');
  const { parseExchangeCsv } = require('../src/services/exchangeImport');
  const { annotateRecords } = require('../src/services/exchangeImport/canonicalFingerprint');
  const binance = require('../src/services/exchangeSync/binanceus')._internals;
  const q = (sql, params) => pool.query(sql, params);

  await q("INSERT INTO users (id, username) VALUES (1, 'verify') ON CONFLICT (id) DO NOTHING");
  const account = async (exchange, name) => (await q(
    'INSERT INTO exchange_accounts (user_id, name, exchange) VALUES (1, $1, $2) RETURNING id', [name, exchange]
  )).rows[0].id;
  const csv = (file, exchange) => {
    const parsed = parseExchangeCsv(fs.readFileSync(path.join(FIXTURES, file), 'utf8'));
    return annotateRecords(exchange, parsed.records.map((record) => ({ ...record, source: 'csv' })));
  };
  const count = async (accountId) => Number((await q('SELECT COUNT(*) AS n FROM exchange_records WHERE exchange_account_id = $1', [accountId])).rows[0].n);

  // --- replay and the one-directional upgrade guard -----------------------
  const coinbase = await account('coinbase', 'Coinbase');
  const retail = csv('coinbase-retail.csv', 'coinbase');
  const first = await ExchangeRecord.bulkInsert(coinbase, retail);
  const replay = await ExchangeRecord.bulkInsert(coinbase, retail);
  ok('a first import inserts every record', first.inserted === retail.length, first);
  ok('re-importing the same file is pure duplicates', replay.inserted === 0 && replay.upgraded === 0
    && (await count(coinbase)) === retail.length, replay);

  const complete = retail.find((record) => !record.needs_review && !record.duplicate_candidate);
  const placeholderId = `${complete.external_id}-placeholder`;
  await ExchangeRecord.bulkInsert(coinbase, [{ ...complete, external_id: placeholderId, fingerprint: null, needs_review: true, base_amount: null }]);
  const up = await ExchangeRecord.bulkInsert(coinbase, [{ ...complete, external_id: placeholderId, fingerprint: null }]);
  const upgradedRow = (await q('SELECT needs_review, base_amount FROM exchange_records WHERE exchange_account_id = $1 AND external_id = $2', [coinbase, placeholderId])).rows[0];
  ok('a complete record upgrades the flagged placeholder in place', up.upgraded === 1 && upgradedRow.needs_review === false && upgradedRow.base_amount !== null, { up, upgradedRow });
  const down = await ExchangeRecord.bulkInsert(coinbase, [{ ...complete, external_id: placeholderId, fingerprint: null, needs_review: true, base_amount: null }]);
  const stillComplete = (await q('SELECT needs_review, base_amount FROM exchange_records WHERE exchange_account_id = $1 AND external_id = $2', [coinbase, placeholderId])).rows[0];
  ok('a flagged record never downgrades a complete one', down.upgraded === 0 && stillComplete.needs_review === false && stillComplete.base_amount !== null, { down, stillComplete });

  // --- cross-source fingerprint merge --------------------------------------
  const kraken = await account('kraken', 'Kraken');
  const krakenCsv = csv('kraken-ledgers.csv', 'kraken');
  await ExchangeRecord.bulkInsert(kraken, krakenCsv);
  const deposit = krakenCsv.find((record) => record.record_type === 'deposit' && !record.needs_review && record.fingerprint);
  const apiTwin = { ...deposit, external_id: `api-${deposit.external_id}`, source: 'api', raw: { ...deposit.raw, _source: 'api' } };
  const merged = await ExchangeRecord.bulkInsert(kraken, [apiTwin]);
  const dedupeEvents = Number((await q('SELECT COUNT(*) AS n FROM exchange_record_dedupe_events WHERE exchange_account_id = $1', [kraken])).rows[0].n);
  ok('one high-confidence API twin of a CSV record merges instead of inserting',
    merged.inserted === 0 && (await count(kraken)) === krakenCsv.length && dedupeEvents === 1, { merged, dedupeEvents });

  // --- Kraken fee parent ----------------------------------------------------
  const orphanFee = {
    ...deposit, record_type: 'fee', external_id: 'fee-orphan', fingerprint: null,
    raw: { _format: 'kraken', _source: 'csv', parent_external_id: 'missing-parent' },
  };
  let feeError = null;
  try { await ExchangeRecord.bulkInsert(kraken, [orphanFee]); } catch (error) { feeError = error.code; }
  ok('a Kraken secondary fee without its trade is refused', feeError === 'EXCHANGE_FEE_PARENT_CONFLICT', feeError);

  // --- Binance.US: fill fold and capital overlap -----------------------------
  const bus = await account('binance_us', 'Binance.US');
  const busCsv = csv('binance-us.csv', 'binance_us');
  await ExchangeRecord.bulkInsert(bus, busCsv);
  const csvTrade = busCsv.find((record) => record.record_type === 'trade' && record.raw?.['Order ID']);
  const apiTrade = annotateRecords('binance_us', [binance.tradeRecord({
    symbol: `${csvTrade.base_asset}${csvTrade.quote_asset}`, id: 777001, orderId: csvTrade.raw['Order ID'],
    price: '140', qty: String(Math.abs(Number(csvTrade.base_amount))), quoteQty: String(Math.abs(Number(csvTrade.quote_amount))),
    commission: '0', commissionAsset: csvTrade.quote_asset, time: new Date(csvTrade.occurred_at).getTime() + 250,
    isBuyer: Number(csvTrade.base_amount) > 0,
  }, new Map([[`${csvTrade.base_asset}${csvTrade.quote_asset}`, { baseAsset: csvTrade.base_asset, quoteAsset: csvTrade.quote_asset }]]))]
    .map((record) => ({ ...record, source: 'api' })));
  const busBefore = await count(bus);
  const fold = await ExchangeRecord.bulkInsert(bus, apiTrade);
  ok('an API fill folds into its CSV twin by order id, base leg and second',
    fold.inserted === 0 && (await count(bus)) === busBefore, { fold, before: busBefore, after: await count(bus) });

  const csvDeposit = busCsv.find((record) => record.record_type === 'deposit');
  const apiDeposit = annotateRecords('binance_us', [binance.capitalRecord({
    id: 'api-dep-1', coin: csvDeposit.base_asset, amount: String(csvDeposit.base_amount), network: 'ETH', status: 1,
    insertTime: new Date(csvDeposit.occurred_at).getTime() + 3600 * 1000,
  }, 'deposit')].map((record) => ({ ...record, source: 'api' })));
  let overlapError = null;
  try { await ExchangeRecord.bulkInsert(bus, apiDeposit); } catch (error) { overlapError = error.code; }
  ok('an API capital record resembling a CSV record blocks the batch for review', overlapError === 'BINANCE_US_CAPITAL_OVERLAP', overlapError);

  // --- backfillChainDetails --------------------------------------------------
  const withoutHash = retail.find((record) => ['deposit', 'withdrawal'].includes(record.record_type) && !record.tx_hash);
  if (withoutHash) {
    const hash = `0x${'9'.repeat(64)}`;
    const filled = await ExchangeRecord.backfillChainDetails(coinbase, [{ external_id: withoutHash.external_id, tx_hash: hash }]);
    const row = (await q('SELECT tx_hash, needs_review FROM exchange_records WHERE exchange_account_id = $1 AND external_id = $2', [coinbase, withoutHash.external_id])).rows[0];
    ok('backfillChainDetails fills a missing tx hash without touching review state',
      filled.filled === 1 && row.tx_hash === hash && row.needs_review === withoutHash.needs_review, { filled, row });
    const again = await ExchangeRecord.backfillChainDetails(coinbase, [{ external_id: withoutHash.external_id, tx_hash: `0x${'8'.repeat(64)}` }]);
    const unchanged = (await q('SELECT tx_hash FROM exchange_records WHERE exchange_account_id = $1 AND external_id = $2', [coinbase, withoutHash.external_id])).rows[0];
    ok('backfillChainDetails is strictly additive', again.filled === 0 && unchanged.tx_hash === hash, { again, unchanged });
  } else {
    ok('the retail fixture has a transfer without a tx hash to backfill', false);
  }

  // A stable digest of everything stored, so a refactor of the identity rules
  // can be diffed against this run (EXCHANGE_DUMP=<path>).
  if (process.env.EXCHANGE_DUMP) {
    const { rows } = await q(
      `SELECT ea.exchange, er.external_id, er.record_type, er.occurred_at, er.base_asset, er.base_amount::text,
              er.quote_asset, er.quote_amount::text, er.fee_asset, er.fee_amount::text, er.tx_hash, er.address,
              er.network, er.chain_id, er.needs_review, er.duplicate_candidate, er.fingerprint, er.source,
              er.raw - '_dedupe' AS raw, er.raw->'_dedupe' AS dedupe
         FROM exchange_records er JOIN exchange_accounts ea ON ea.id = er.exchange_account_id
        ORDER BY ea.exchange, er.external_id`
    );
    fs.writeFileSync(process.env.EXCHANGE_DUMP, JSON.stringify(rows, null, 1));
  }

  await pool.end();
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

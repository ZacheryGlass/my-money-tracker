'use strict';

// Golden identity for every exchange fixture: what each CSV reader and each
// API record builder produces -- external_id (the replay key), canonical
// fingerprint, record type, legs, network/chain and review flag. Moving the
// venues into their own folders (S5) must not change one byte of this.
// Regenerate deliberately with UPDATE_SNAPSHOTS=1 and review the diff.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = 'postgresql://test:test@localhost/test';
delete process.env.ETH_CHAINS;

const FIXTURES = path.join(__dirname, 'fixtures', 'exchanges');
const SNAPSHOT = path.join(__dirname, 'fixtures', 'snapshots', 'exchange-goldens.json');
const { parseExchangeCsv } = require('../src/services/exchangeImport');
const { annotateRecords } = require('../src/services/exchangeImport/canonicalFingerprint');

// The exchange whose fingerprint rules apply to a CSV format.
const EXCHANGE_FOR_FORMAT = {
  coinbase_retail: 'coinbase', coinbase_pro: 'coinbase', kraken: 'kraken', binance_us: 'binance_us', generic: 'other',
};

function project(record) {
  const iso = (value) => (value instanceof Date ? value.toISOString() : value ?? null);
  return {
    external_id: record.external_id,
    record_type: record.record_type,
    occurred_at: iso(record.occurred_at),
    base: [record.base_asset ?? null, record.base_amount ?? null],
    quote: [record.quote_asset ?? null, record.quote_amount ?? null],
    fee: [record.fee_asset ?? null, record.fee_amount ?? null],
    tx_hash: record.tx_hash ?? null,
    address: record.address ?? null,
    network: record.network ?? null,
    chain_id: record.chain_id ?? null,
    needs_review: Boolean(record.needs_review),
    fingerprint: record.fingerprint ?? null,
    fingerprint_version: record.fingerprint_version ?? null,
  };
}

function csvGoldens() {
  const out = {};
  for (const file of fs.readdirSync(FIXTURES).filter((name) => name.endsWith('.csv')).sort()) {
    const text = fs.readFileSync(path.join(FIXTURES, file), 'utf8');
    try {
      const parsed = parseExchangeCsv(text);
      const records = annotateRecords(EXCHANGE_FOR_FORMAT[parsed.format], parsed.records);
      out[file] = { format: parsed.format, records: records.map(project) };
    } catch (error) {
      out[file] = { error: error.name, message: error.message };
    }
  }
  return out;
}

function apiGoldens() {
  const kraken = require('../src/services/exchangeSync/kraken')._internals;
  const { buildRecords } = require('../src/services/exchangeImport/krakenLedger');
  const ledgers = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'kraken-ledgers-api.json'), 'utf8'));
  const funding = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'kraken-funding-api.json'), 'utf8'));
  const byRefid = new Map();
  for (const endpoint of ['WithdrawStatus', 'DepositStatus']) {
    for (const row of kraken.fundingRows(funding[endpoint]?.result ?? funding[endpoint])) {
      if (row?.refid) {
        byRefid.set(row.refid, {
          txHash: row.txid ? String(row.txid) : null, address: row.info ? String(row.info) : null,
          method: row.method ?? null, network: row.network ?? null, status: row.status ?? null,
        });
      }
    }
  }
  const krakenRecords = buildRecords(kraken.toRecordRows(Object.values(ledgers.result.ledger), byRefid)).records;

  const coinbase = require('../src/services/exchangeSync/coinbase')._internals;
  const cb = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'coinbase-api.json'), 'utf8'));
  const transactions = cb.transactions?.data || [];
  const { byOrder: fillsByOrder } = coinbase.summarizeFills(cb.fills?.fills || []);
  const { pairs, singles } = coinbase.foldConversions(transactions);
  const coinbaseRecords = [];
  let line = 0;
  for (const pair of pairs) coinbaseRecords.push(coinbase.recordFromConversion(pair, { line: (line += 1) }));
  for (const tx of singles) {
    const record = coinbase.recordFromTransaction(tx, { line: (line += 1), fillsByOrder });
    if (record) coinbaseRecords.push(record);
  }
  const binance = require('../src/services/exchangeSync/binanceus')._internals;
  const bus = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'binanceus-api.json'), 'utf8'));
  const symbolMap = new Map(bus.symbols.map((entry) => [entry.symbol, entry]));
  const binanceRecords = [
    ...bus.trades.map((row) => binance.tradeRecord(row, symbolMap)),
    ...bus.deposits.map((row) => binance.capitalRecord(row, 'deposit')),
    ...bus.withdrawals.map((row) => binance.capitalRecord(row, 'withdrawal')),
    ...bus.distributions.map((row) => binance.distributionRecord(row)),
    ...bus.fiat.map((row) => binance.fiatRecord(row, 'deposit')),
  ].filter(Boolean);
  return {
    'kraken-ledgers-api.json': annotateRecords('kraken', krakenRecords).map(project),
    'coinbase-api.json': annotateRecords('coinbase', coinbaseRecords).map(project),
    'binanceus-api.json': annotateRecords('binance_us', binanceRecords).map(project),
  };
}

test('every exchange fixture keeps its golden identity', () => {
  const actual = JSON.parse(JSON.stringify({ csv: csvGoldens(), api: apiGoldens() }));
  if (process.env.UPDATE_SNAPSHOTS === '1') {
    fs.mkdirSync(path.dirname(SNAPSHOT), { recursive: true });
    fs.writeFileSync(SNAPSHOT, `${JSON.stringify(actual, null, 2)}\n`);
  }
  assert.deepEqual(actual, JSON.parse(fs.readFileSync(SNAPSHOT, 'utf8')));
});

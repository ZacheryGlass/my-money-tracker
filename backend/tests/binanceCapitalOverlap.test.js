'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const ExchangeRecord = require('../src/models/ExchangeRecord');
const { annotateRecord } = require('../src/services/exchangeImport/canonicalFingerprint');

const incoming = annotateRecord('binance_us', {
  external_id: 'binanceus:withdrawal:synthetic-api-id', source: 'api',
  record_type: 'withdrawal', base_asset: 'ETH', base_amount: '-2',
  occurred_at: '2020-01-01T23:59:00Z', fee_asset: 'ETH', fee_amount: '0.01',
  raw: { _format: 'binance_us', _source: 'api' },
});
const csv = { ...incoming, id: 999, source: 'csv', fingerprint: null,
  external_id: 'binanceus:withdrawal:synthetic-csv-id',
  occurred_at: '2020-01-02T00:03:00Z', base_amount: '-2.000000000000000000',
  raw: { _format: 'binance_us', _source: 'csv' } };

function clientFor(rows, replay = false) {
  const writes = [];
  return { writes, async query(sql) {
    if (sql.includes('SELECT incoming_external_id')) return { rows: replay ? [{ incoming_external_id: incoming.external_id }] : [] };
    if (sql.includes("er.source = 'csv'")) return { rows };
    if (/^\s*(INSERT|UPDATE|DELETE)/.test(sql)) writes.push(sql);
    return { rows: [], rowCount: 0 };
  } };
}

test('Binance capital overlap guard catches legacy CSV and midnight differences before writing', async () => {
  const client = clientFor([csv]);
  await assert.rejects(ExchangeRecord.bulkInsert(9, [incoming], { client }), error => {
    assert.equal(error.code, 'BINANCE_US_CAPITAL_OVERLAP');
    assert.deepEqual(error.candidates, [{ record_id: 999, incoming_external_id: incoming.external_id }]);
    return true;
  });
  assert.deepEqual(client.writes, []);
});

test('Binance reviewed dedupe replays are not blocked again', async () => {
  const client = clientFor([csv], true);
  const result = await ExchangeRecord.bulkInsert(9, [incoming], { client });
  assert.equal(result.duplicates, 1);
  assert.ok(!client.writes.some(sql => sql.includes('INSERT')));
});

test('Binance capital guard does not block different assets, amounts, dates, or proven different hashes', async () => {
  for (const row of [
    { ...csv, base_asset: 'BTC' }, { ...csv, base_amount: '-3' },
    { ...csv, occurred_at: '2020-01-04T00:00:00Z' },
    { ...csv, tx_hash: '0x222' },
  ]) {
    const client = clientFor([row]);
    await ExchangeRecord.bulkInsert(9, [{ ...incoming, tx_hash: '0x111' }], { client });
    assert.ok(client.writes.some(sql => sql.includes('INSERT')));
  }
});

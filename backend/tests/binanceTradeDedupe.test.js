'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const ExchangeRecord = require('../src/models/ExchangeRecord');
const { annotateRecord, canonicalBalances } = require('../src/services/exchangeImport/canonicalFingerprint');

// Synthetic shapes of one Binance.US fill seen by both sources: same order id,
// different native ids, USD4 vs USD, API milliseconds and a rounded quoteQty.
const api = annotateRecord('binance_us', {
  external_id: 'binanceus:trade:NANOUSD:1001', source: 'api', record_type: 'trade',
  occurred_at: '2021-02-18T15:37:36.796Z', base_asset: 'NANO', base_amount: '-111.75',
  quote_asset: 'USD4', quote_amount: '774.8074', fee_asset: 'USD4', fee_amount: '0.7748',
  raw: { _format: 'binance_us', _source: 'api', id: 1001, orderId: 5005 },
});
const csv = {
  id: 77, external_id: 'binanceus:trade:NANOUSD:9009', source: 'csv', record_type: 'trade',
  occurred_at: '2021-02-18T15:37:36Z', base_asset: 'NANO', base_amount: '-111.750000000000000000',
  quote_asset: 'USD', quote_amount: '774.80745', fee_asset: 'USD', fee_amount: '0.7748',
  needs_review: false, duplicate_candidate: false, fingerprint: 'csv-fp', dedupe_provenance: null,
  raw: { _format: 'binance_us', _source: 'csv', 'Order ID': '5005', 'Transaction ID': '9009' },
};

function clientFor(fills) {
  const writes = [];
  return { writes, async query(sql, params) {
    if (sql.includes("COALESCE(er.raw->>'Order ID'")) return { rows: fills };
    if (/^\s*(INSERT|UPDATE|DELETE)/.test(sql)) writes.push({ sql, params });
    return { rows: [], rowCount: 0 };
  } };
}

test('Binance.US USD4 is stored as USD and folded into USD balances', () => {
  assert.equal(api.quote_asset, 'USD');
  assert.equal(api.fee_asset, 'USD');
  assert.equal(api.dedupe_provenance.at(-1).original_assets.quote_asset, 'USD4');
  assert.deepEqual(canonicalBalances('binance_us', { USD: '1', USD4: '2' }), { USD: '3' });
});

test('an API fill merges into its CSV twin by order id instead of inserting', async () => {
  const client = clientFor([csv]);
  const result = await ExchangeRecord.bulkInsert(3, [api], { client });
  assert.equal(result.inserted, 0);
  assert.ok(!client.writes.some(({ sql }) => sql.includes('INSERT INTO exchange_records')));
  const audit = client.writes.find(({ sql }) => sql.includes('INSERT INTO exchange_record_dedupe_events'));
  assert.equal(audit.params[1], 77);
  assert.equal(audit.params[2], api.external_id);
});

test('same-second fills of one size are flagged, never merged silently', async () => {
  const client = clientFor([csv, { ...csv, id: 78, external_id: 'binanceus:trade:NANOUSD:9010' }]);
  await ExchangeRecord.bulkInsert(3, [api], { client });
  const insert = client.writes.find(({ sql }) => sql.includes('INSERT INTO exchange_records'));
  assert.ok(insert);
  assert.ok(!client.writes.some(({ sql }) => sql.includes('exchange_record_dedupe_events')));
});

test('a fill at a different second or size is its own event', async () => {
  for (const twin of [{ ...csv, occurred_at: '2021-02-18T15:37:37Z' }, { ...csv, base_amount: '-111.7' }]) {
    const client = clientFor([twin]);
    await ExchangeRecord.bulkInsert(3, [api], { client });
    assert.ok(client.writes.some(({ sql }) => sql.includes('INSERT INTO exchange_records')));
    assert.ok(!client.writes.some(({ sql }) => sql.includes('exchange_record_dedupe_events')));
  }
});

test('a capital-overlap refusal keeps its pairs for review and still fails the sync', async () => {
  const ExchangeSyncService = require('../src/services/ExchangeSyncService');
  const ExchangeOverlapReview = require('../src/models/ExchangeOverlapReview');
  const ExchangeAccount = require('../src/models/ExchangeAccount');
  const original = {
    write: ExchangeSyncService._writeSyncTransaction,
    record: ExchangeOverlapReview.recordCandidates,
    save: ExchangeAccount.saveSyncState,
  };
  const overlap = Object.assign(new Error('overlap'), {
    code: 'BINANCE_US_CAPITAL_OVERLAP',
    candidates: [{ record_id: 5, incoming_external_id: 'binanceus:deposit:x', incoming: { external_id: 'binanceus:deposit:x' } }],
  });
  const recorded = [];
  const saved = [];
  ExchangeSyncService._writeSyncTransaction = async () => { throw overlap; };
  ExchangeOverlapReview.recordCandidates = async (accountId, candidates) => { recorded.push([accountId, candidates]); return 1; };
  ExchangeAccount.saveSyncState = async (accountId, state) => { saved.push([accountId, state]); return {}; };
  try {
    await assert.rejects(
      ExchangeSyncService._writeSyncBatch({ id: 3 }, [], {}, { syncLockToken: 'token' }),
      (error) => error === overlap
    );
    assert.deepEqual(recorded, [[3, overlap.candidates]]);
    assert.equal(saved[0][1].status, 'error');
    assert.match(saved[0][1].error, /1 incoming record\(s\) await review/);
  } finally {
    ExchangeSyncService._writeSyncTransaction = original.write;
    ExchangeOverlapReview.recordCandidates = original.record;
    ExchangeAccount.saveSyncState = original.save;
  }
});

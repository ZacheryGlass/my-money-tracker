'use strict';

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = 'postgresql://test:test@localhost/test';

const rows = new Map();
const audit = [];
let nextId = 1;

const COLUMNS = [
  'record_type', 'occurred_at', 'base_asset', 'base_amount', 'quote_asset', 'quote_amount',
  'fee_asset', 'fee_amount', 'tx_hash', 'address', 'external_id', 'needs_review', 'raw',
  'source', 'network', 'chain_id', 'fingerprint', 'fingerprint_version',
  'dedupe_provenance', 'duplicate_candidate',
];
const PARAMS_PER_ROW = COLUMNS.length + 1;

function parseJson(value) {
  return typeof value === 'string' ? JSON.parse(value) : value;
}

function decodeInsertRow(params, offset) {
  const row = { id: nextId++, exchange_account_id: params[offset] };
  COLUMNS.forEach((column, index) => {
    const value = params[offset + index + 1];
    row[column] = ['raw', 'dedupe_provenance'].includes(column) ? parseJson(value) : value;
  });
  return row;
}

function fakeQuery(text, params = []) {
  const sql = String(text).replace(/\s+/g, ' ').trim();
  if (['BEGIN', 'COMMIT', 'ROLLBACK'].includes(sql)) return { rows: [] };
  if (/^SELECT id FROM exchange_accounts WHERE id = \$1 FOR UPDATE/.test(sql)) {
    return { rows: [{ id: params[0] }] };
  }
  if (/^SELECT er\.\*/.test(sql)) {
    const externalIds = params[1] || [];
    const fingerprints = params[2] || [];
    return {
      rows: [...rows.values()].filter((row) => row.exchange_account_id === params[0]
        && (externalIds.includes(row.external_id) || fingerprints.includes(row.fingerprint))),
    };
  }
  if (/^SELECT incoming_external_id FROM exchange_record_dedupe_events/.test(sql)) {
    return { rows: audit.map((entry) => ({ incoming_external_id: entry.incoming_external_id })) };
  }
  if (/^UPDATE exchange_records SET duplicate_candidate = TRUE/.test(sql)) {
    const row = rows.get(params[0]);
    if (row) {
      row.duplicate_candidate = true;
      row.needs_review = true;
      row.dedupe_provenance = parseJson(params[1]);
    }
    return { rows: [] };
  }
  if (/^UPDATE exchange_records\n? SET|^UPDATE exchange_records SET/.test(sql)) {
    const row = rows.get(params[0]);
    if (row) {
      COLUMNS.forEach((column, index) => {
        const value = params[index + 2];
        row[column] = ['raw', 'dedupe_provenance'].includes(column) ? parseJson(value) : value;
      });
    }
    return { rows: [] };
  }
  if (/^INSERT INTO exchange_record_dedupe_events/.test(sql)) {
    audit.push({ survivor_record_id: params[1], incoming_external_id: params[2], snapshot: parseJson(params[6]) });
    return { rows: [] };
  }
  if (/^INSERT INTO exchange_records/.test(sql)) {
    const result = [];
    for (let offset = 0; offset < params.length; offset += PARAMS_PER_ROW) {
      const incoming = decodeInsertRow(params, offset);
      assert.notEqual(incoming.duplicate_candidate, null,
        'INSERT must not bypass the database default with duplicate_candidate=NULL');
      const key = [...rows.values()].find((row) => row.exchange_account_id === incoming.exchange_account_id
        && row.external_id === incoming.external_id);
      if (!key) {
        rows.set(incoming.id, incoming);
        result.push({ inserted: true });
      } else if (key.needs_review && !incoming.needs_review) {
        COLUMNS.filter((column) => column !== 'external_id').forEach((column) => {
          key[column] = incoming[column];
        });
        result.push({ inserted: false });
      }
    }
    return { rows: result, rowCount: result.length };
  }
  if (/^UPDATE exchange_records er/.test(sql)) return { rows: [], rowCount: 0 };
  throw new Error(`Unexpected fake SQL: ${sql}`);
}

const pgModulePath = require.resolve('pg');
require.cache[pgModulePath] = {
  id: pgModulePath,
  filename: pgModulePath,
  loaded: true,
  exports: {
    Pool: class FakePool {
      async query(text, params) { return fakeQuery(text, params); }
      async connect() {
        return { query: async (text, params) => fakeQuery(text, params), release() {} };
      }
      on() {}
    },
    types: { setTypeParser() {} },
  },
};

const ExchangeRecord = require('../src/models/ExchangeRecord');
const { annotateRecord } = require('../src/services/exchangeImport/canonicalFingerprint');

function record(source, externalId, overrides = {}) {
  return annotateRecord('coinbase', {
    record_type: 'trade',
    occurred_at: '2026-07-30T12:34:56.000Z',
    base_asset: 'ETH',
    base_amount: '1',
    quote_asset: 'USD',
    quote_amount: '-3000',
    fee_asset: 'USD',
    fee_amount: '12.5',
    tx_hash: source === 'api' ? '0xabc' : null,
    address: null,
    external_id: externalId,
    needs_review: false,
    raw: { source, externalId },
    source,
    network: null,
    chain_id: null,
    ...overrides,
  });
}

beforeEach(() => {
  rows.clear();
  audit.length = 0;
  nextId = 1;
});

test('a matching API and CSV event collapses into one audited record', async () => {
  const first = await ExchangeRecord.bulkInsert(7, [record('api', 'api-event-1')]);
  const second = await ExchangeRecord.bulkInsert(7, [record('csv', 'csv-event-1')]);

  assert.equal(first.inserted, 1);
  assert.equal(second.deduplicated, 1);
  assert.equal(second.inserted, 0);
  assert.equal(rows.size, 1);
  assert.equal(audit.length, 1);
  assert.equal([...rows.values()][0].source, 'api');
  assert.equal([...rows.values()][0].tx_hash, '0xabc');
  assert.equal([...rows.values()][0].dedupe_provenance.length, 2);

  const replay = await ExchangeRecord.bulkInsert(7, [record('csv', 'csv-event-1')]);
  assert.equal(replay.deduplicated, 0);
  assert.equal(replay.duplicates, 1);
  assert.equal(audit.length, 1);
});

test('same-day same-amount events from one source remain separate review candidates', async () => {
  await ExchangeRecord.bulkInsert(7, [record('api', 'api-event-1')]);
  const result = await ExchangeRecord.bulkInsert(7, [record('api', 'api-event-2')]);

  assert.equal(result.duplicateCandidates, 1);
  assert.equal(result.duplicateConflicts, 0);
  assert.equal(result.inserted, 1);
  assert.equal(rows.size, 2);
  assert.deepEqual([...rows.values()].map((row) => row.duplicate_candidate), [true, true]);
  assert.deepEqual([...rows.values()].map((row) => row.needs_review), [true, true]);
});

test('same-source events with distinct provider ids and full timestamps are not duplicate candidates', async () => {
  const result = await ExchangeRecord.bulkInsert(7, [
    record('csv', 'provider-event-1', { occurred_at: '2026-07-30T12:34:56.000Z' }),
    record('csv', 'provider-event-2', { occurred_at: '2026-07-30T12:35:56.000Z' }),
  ]);

  assert.equal(result.duplicateCandidates, 0);
  assert.equal(result.inserted, 2);
  assert.deepEqual([...rows.values()].map((row) => row.duplicate_candidate), [false, false]);
  assert.deepEqual([...rows.values()].map((row) => row.needs_review), [false, false]);
});

test('a later same-source event at a distinct full timestamp is not a duplicate candidate', async () => {
  await ExchangeRecord.bulkInsert(7, [
    record('csv', 'provider-event-1', { occurred_at: '2026-07-30T12:34:56.000Z' }),
  ]);
  const result = await ExchangeRecord.bulkInsert(7, [
    record('csv', 'provider-event-2', { occurred_at: '2026-07-30T12:35:56.000Z' }),
  ]);

  assert.equal(result.duplicateCandidates, 0);
  assert.equal(result.inserted, 1);
  assert.deepEqual([...rows.values()].map((row) => row.duplicate_candidate), [false, false]);
});

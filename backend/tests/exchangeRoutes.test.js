'use strict';

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = 'postgresql://test:test@localhost/test';

// The user's own account. Anything else is somebody else's and must 404.
const OWNED_ACCOUNT_ID = 7;
const OWNER_ID = 1;

// Stands in for the UNIQUE (exchange_account_id, external_id) index: keyed by
// the same pair, so "already imported" behaves the way Postgres would.
const stored = new Set();
let failNextInsertWithDuplicateName = false;

function accountRow(overrides = {}) {
  return {
    id: OWNED_ACCOUNT_ID,
    user_id: OWNER_ID,
    name: 'Kraken',
    exchange: 'kraken',
    last_import_at: null,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

// The INSERT built by ExchangeRecord.bulkInsert binds one account id followed
// by the 13 record columns per row, with external_id eleventh among them.
const PARAMS_PER_ROW = 14;
const EXTERNAL_ID_OFFSET = 11;

function fakeQuery(text, params) {
  const sql = String(text).replace(/\s+/g, ' ').trim();

  if (/^SELECT \* FROM exchange_accounts WHERE id = \$1 AND user_id = \$2/.test(sql)) {
    const [id, userId] = params;
    return { rows: (id === OWNED_ACCOUNT_ID && userId === OWNER_ID) ? [accountRow()] : [] };
  }
  if (/FROM exchange_accounts ea/.test(sql)) {
    return { rows: [{ ...accountRow(), record_count: 3, needs_review_count: 1 }] };
  }
  if (/^INSERT INTO exchange_accounts/.test(sql)) {
    if (failNextInsertWithDuplicateName) {
      const error = new Error('duplicate key value violates unique constraint');
      error.code = '23505';
      throw error;
    }
    return { rows: [accountRow({ id: 12, name: params[1], exchange: params[2] })] };
  }
  if (/^UPDATE exchange_accounts/.test(sql)) {
    const [id, userId] = params;
    return { rows: (id === OWNED_ACCOUNT_ID && userId === OWNER_ID) ? [accountRow()] : [] };
  }
  if (/^DELETE FROM exchange_accounts/.test(sql)) {
    return { rows: [accountRow()] };
  }
  if (/^INSERT INTO exchange_records/.test(sql)) {
    let inserted = 0;
    for (let i = 0; i < params.length; i += PARAMS_PER_ROW) {
      const key = `${params[i]}|${params[i + EXTERNAL_ID_OFFSET]}`;
      if (stored.has(key)) continue;
      stored.add(key);
      inserted += 1;
    }
    return { rows: Array.from({ length: inserted }, (_, i) => ({ id: i })), rowCount: inserted };
  }
  if (/FROM exchange_records er/.test(sql)) {
    return { rows: /COUNT\(\*\)/.test(sql) ? [{ total: 0 }] : [] };
  }
  return { rows: [] };
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
        return {
          query: async (text, params) => fakeQuery(text, params),
          release() {},
        };
      }
      on() {}
    },
    types: { setTypeParser() {} },
  },
};

const request = require('supertest');
const app = require('../src/server');
const ExchangeAccount = require('../src/models/ExchangeAccount');

const FIXTURES = path.join(__dirname, 'fixtures', 'exchanges');
const fixture = (name) => fs.readFileSync(path.join(FIXTURES, name), 'utf8');

function asUser(id) {
  if (id === undefined) delete process.env.DEV_AUTH_USER_ID;
  else process.env.DEV_AUTH_USER_ID = String(id);
}

beforeEach(() => {
  stored.clear();
  failNextInsertWithDuplicateName = false;
  asUser(undefined);
});

test('GET /api/exchanges lists the caller\'s accounts', async () => {
  const response = await request(app).get('/api/exchanges');

  assert.equal(response.status, 200);
  assert.equal(response.body.accounts.length, 1);
  assert.equal(response.body.accounts[0].record_count, 3);
});

test('POST /api/exchanges validates name and exchange', async () => {
  const noName = await request(app).post('/api/exchanges').send({ exchange: 'kraken' });
  assert.equal(noName.status, 400);
  assert.match(noName.body.error, /name is required/);

  const badExchange = await request(app).post('/api/exchanges').send({ name: 'Binance', exchange: 'binance' });
  assert.equal(badExchange.status, 400);
  assert.match(badExchange.body.error, /exchange must be one of/);

  const created = await request(app).post('/api/exchanges').send({ name: 'Kraken Spot', exchange: 'kraken' });
  assert.equal(created.status, 201);
  assert.equal(created.body.account.name, 'Kraken Spot');
});

test('POST /api/exchanges reports a duplicate name as a conflict, not a server error', async () => {
  failNextInsertWithDuplicateName = true;
  const response = await request(app).post('/api/exchanges').send({ name: 'Kraken', exchange: 'kraken' });

  assert.equal(response.status, 409);
  assert.match(response.body.error, /already exists/);
});

// Ownership: the account id is resolved against the caller before anything is
// read or written, so another user's id is indistinguishable from a made-up one.
for (const [method, url] of [
  ['get', `/api/exchanges/999/records`],
  ['patch', `/api/exchanges/999`],
  ['delete', `/api/exchanges/999`],
  ['post', `/api/exchanges/999/import`],
]) {
  test(`${method.toUpperCase()} ${url} with a foreign account id is a 404`, async () => {
    const response = await request(app)[method](url).send({ name: 'x' });
    assert.equal(response.status, 404);
    assert.match(response.body.error, /not found/i);
  });
}

test('a second user cannot reach the first user\'s exchange account', async () => {
  asUser(2);
  const response = await request(app)
    .post(`/api/exchanges/${OWNED_ACCOUNT_ID}/import`)
    .set('Content-Type', 'text/csv')
    .send(fixture('kraken-ledgers.csv'));

  assert.equal(response.status, 404);
  assert.equal(stored.size, 0, 'nothing may be written for a foreign account');
});

test('uploading the same ledger twice yields one set of records', async () => {
  const csv = fixture('kraken-ledgers.csv');

  const first = await request(app)
    .post(`/api/exchanges/${OWNED_ACCOUNT_ID}/import`)
    .set('Content-Type', 'text/csv')
    .send(csv);

  assert.equal(first.status, 200);
  assert.equal(first.body.format, 'kraken');
  assert.equal(first.body.parsed, 10);
  assert.equal(first.body.imported, 10);
  assert.equal(first.body.duplicates, 0);
  // The unrecognized ledger type imported rather than vanishing.
  assert.equal(first.body.needs_review, 1);
  assert.equal(stored.size, 10);

  const second = await request(app)
    .post(`/api/exchanges/${OWNED_ACCOUNT_ID}/import`)
    .set('Content-Type', 'text/csv')
    .send(csv);

  assert.equal(second.status, 200);
  assert.equal(second.body.imported, 0);
  assert.equal(second.body.duplicates, 10);
  assert.equal(stored.size, 10, 're-import must not add a second copy');
});

test('a fuller re-export adds only its new rows', async () => {
  const full = fixture('generic.csv');
  const lines = full.trim().split('\n');
  const partial = [lines[0], ...lines.slice(1, 4)].join('\n');

  const first = await request(app)
    .post(`/api/exchanges/${OWNED_ACCOUNT_ID}/import`)
    .set('Content-Type', 'text/csv')
    .send(partial);
  assert.equal(first.body.imported, 3);

  const second = await request(app)
    .post(`/api/exchanges/${OWNED_ACCOUNT_ID}/import`)
    .set('Content-Type', 'text/csv')
    .send(full);
  assert.equal(second.body.imported, 3);
  assert.equal(second.body.duplicates, 3);
  assert.equal(stored.size, 6);
});

test('a JSON body may carry the CSV alongside an explicit format', async () => {
  const response = await request(app)
    .post(`/api/exchanges/${OWNED_ACCOUNT_ID}/import`)
    .send({ csv: fixture('coinbase-retail.csv'), format: 'coinbase_retail' });

  assert.equal(response.status, 200);
  assert.equal(response.body.format, 'coinbase_retail');
  assert.equal(response.body.imported, 20);
  assert.equal(response.body.skipped_header_rows, 2);
});

test('an unreadable CSV is a 400 that says so, and writes nothing', async () => {
  const response = await request(app)
    .post(`/api/exchanges/${OWNED_ACCOUNT_ID}/import`)
    .set('Content-Type', 'text/csv')
    .send(fixture('unrecognized.csv'));

  assert.equal(response.status, 400);
  assert.equal(response.body.code, 'UNRECOGNIZED_CSV_FORMAT');
  assert.match(response.body.error, /Unrecognized CSV layout/);
  assert.equal(stored.size, 0);
});

test('an empty upload is a 400', async () => {
  const response = await request(app)
    .post(`/api/exchanges/${OWNED_ACCOUNT_ID}/import`)
    .set('Content-Type', 'text/csv')
    .send('   ');

  assert.equal(response.status, 400);
  assert.match(response.body.error, /No CSV data/);
});

test('scoped reads fail closed when no user is supplied', async () => {
  await assert.rejects(() => ExchangeAccount.findAllByUser(undefined), /requires a userId/);
  await assert.rejects(() => ExchangeAccount.findByIdForUser(1, null), /requires a userId/);
  await assert.rejects(() => ExchangeAccount.delete(1, undefined), /requires a userId/);
});

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
// A flagged record of that account, for the review-resolving route.
const FLAGGED_RECORD_ID = 4242;

// Stands in for the UNIQUE (exchange_account_id, external_id) index: keyed by
// the same pair, so "already imported" behaves the way Postgres would. The
// value is the row's needs_review, which is what the upgrade guard tests.
const stored = new Map();
let failNextInsertWithDuplicateName = false;
let failNextRecordInsertWith = null;

function accountRow(overrides = {}) {
  return {
    id: OWNED_ACCOUNT_ID,
    user_id: OWNER_ID,
    name: 'Kraken',
    exchange: 'kraken',
    last_import_at: null,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    api_key_last4: null,
    api_secret_last4: null,
    api_configured: false,
    last_sync_at: null,
    last_sync_status: null,
    last_sync_error: null,
    balance_report: null,
    ...overrides,
  };
}

// The INSERT built by ExchangeRecord.bulkInsert binds one account id followed
// by the 20 record columns per row, with external_id eleventh among them and
// needs_review twelfth. `source` (migration 040) is the fourteenth, network and
// chain_id are the fifteenth and sixteenth, and the fingerprint metadata fills
// the final four positions. The fingerprint is deliberately non-unique, which
// is what lets ambiguous same-event candidates remain reviewable.
const PARAMS_PER_ROW = 21;
const EXTERNAL_ID_OFFSET = 11;
const NEEDS_REVIEW_OFFSET = 12;

function fakeQuery(text, params) {
  const sql = String(text).replace(/\s+/g, ' ').trim();

  // Since migration 040 the table holds ciphertext, so the route-facing read
  // projects an explicit column list and only the credential-resolving read
  // uses SELECT *. Both are matched here, and the SELECT * one is the only
  // place the encrypted columns appear.
  if (/^SELECT id, user_id, name, .* FROM exchange_accounts WHERE id = \$1 AND user_id = \$2/.test(sql)) {
    const [id, userId] = params;
    return { rows: (id === OWNED_ACCOUNT_ID && userId === OWNER_ID) ? [accountRow()] : [] };
  }
  if (/^SELECT \* FROM exchange_accounts WHERE id = \$1 AND user_id = \$2/.test(sql)) {
    const [id, userId] = params;
    return { rows: (id === OWNED_ACCOUNT_ID && userId === OWNER_ID) ? [accountRow()] : [] };
  }
  // Clearing a review flag joins exchange_records to exchange_accounts, so it
  // has to be recognized before the plain account queries below.
  if (/^UPDATE exchange_records er/.test(sql)) {
    const [recordId, accountId, userId] = params;
    const owned = recordId === FLAGGED_RECORD_ID
      && accountId === OWNED_ACCOUNT_ID
      && userId === OWNER_ID;
    return { rows: owned ? [{ id: recordId, exchange_account_id: accountId, needs_review: false }] : [] };
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
    if (failNextRecordInsertWith) {
      const error = new Error('numeric field overflow');
      error.code = failNextRecordInsertWith;
      failNextRecordInsertWith = null;
      throw error;
    }
    // Mirrors ON CONFLICT ... DO UPDATE ... WHERE existing.needs_review AND NOT
    // EXCLUDED.needs_review, and the (xmax = 0) flag that separates a fresh
    // insert from an upgrade. A conflict that fails the guard returns no row.
    const rows = [];
    for (let i = 0; i < params.length; i += PARAMS_PER_ROW) {
      const key = `${params[i]}|${params[i + EXTERNAL_ID_OFFSET]}`;
      const needsReview = Boolean(params[i + NEEDS_REVIEW_OFFSET]);
      if (!stored.has(key)) {
        stored.set(key, needsReview);
        rows.push({ inserted: true });
      } else if (stored.get(key) && !needsReview) {
        stored.set(key, needsReview);
        rows.push({ inserted: false });
      }
    }
    return { rows, rowCount: rows.length };
  }
  if (/FROM exchange_records er/.test(sql)) {
    if (/COUNT\(\*\)/.test(sql)) return { rows: [{ total: 1 }] };
    return {
      rows: [{
        id: FLAGGED_RECORD_ID,
        exchange_account_id: OWNED_ACCOUNT_ID,
        record_type: 'trade',
        needs_review: /AND er\.needs_review/.test(sql),
      }],
    };
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
  failNextRecordInsertWith = null;
  asUser(undefined);
});

// Drops the lines a shorter export would not have carried.
const withoutLines = (text, predicate) => text
  .split('\n')
  .filter((line, index) => index === 0 || !predicate(line))
  .join('\n');

const upload = (csv) => request(app)
  .post(`/api/exchanges/${OWNED_ACCOUNT_ID}/import`)
  .set('Content-Type', 'text/csv')
  .send(csv);

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

  const first = await upload(csv);

  assert.equal(first.status, 200);
  assert.equal(first.body.format, 'kraken');
  assert.equal(first.body.parsed, 11);
  assert.equal(first.body.imported, 11);
  assert.equal(first.body.upgraded, 0);
  assert.equal(first.body.duplicates, 0);
  // The unrecognized ledger type and the widowed trade leg imported rather
  // than vanishing.
  assert.equal(first.body.needs_review, 2);
  assert.equal(first.body.reconciliation_status, 'unknown');
  assert.equal(stored.size, 11);

  const second = await upload(csv);

  assert.equal(second.status, 200);
  assert.equal(second.body.imported, 0);
  // Identical twice over: nothing new, and nothing was rewritten either. An
  // upgrade here would mean the guard is not actually guarding.
  assert.equal(second.body.upgraded, 0);
  assert.equal(second.body.duplicates, 11);
  assert.equal(second.body.reconciliation_status, 'unknown');
  assert.equal(stored.size, 11, 're-import must not add a second copy');
});

test('a fuller re-export adds only its new rows', async () => {
  const full = fixture('generic.csv');
  const lines = full.trim().split('\n');
  const partial = [lines[0], ...lines.slice(1, 4)].join('\n');

  const first = await upload(partial);
  assert.equal(first.body.imported, 3);

  const second = await upload(full);
  assert.equal(second.body.imported, 3);
  assert.equal(second.body.duplicates, 3);
  assert.equal(stored.size, 6);
});

// --- Half a record, then the whole one -------------------------------------
//
// A date-limited export splits a trade down the middle, and the leg that made
// it into the file is not the trade. The complete export keys the same event
// the same way, so it lands on the half record: it has to replace it, or the
// correct record is discarded and can never be imported again.

test('kraken: the full ledger repairs the half record the partial one left', async () => {
  const full = fixture('kraken-ledgers.csv');
  // The earlier export began after the ETH leg of TTRD00.
  const partial = withoutLines(full, (line) => line.includes('"LCCCCC-33333-CCCCCC"'));

  const first = await upload(partial);
  assert.equal(first.body.imported, 11);
  assert.equal(first.body.needs_review, 3, 'the widowed trade leg is flagged');

  const second = await upload(full);
  assert.equal(second.body.imported, 0, 'the trade was already known, half-way');
  assert.equal(second.body.upgraded, 1, 'the half trade became the whole trade');
  assert.equal(second.body.duplicates, 10);
  // One record for that trade, not two: the id did not change when the
  // counter-leg arrived.
  assert.equal(stored.size, 11);
  assert.equal(stored.get(`${OWNED_ACCOUNT_ID}|kraken:TTRD00-11111-TTTTTT`), false);
});

test('coinbase pro: the full statement repairs the half fill and the half conversion', async () => {
  const full = fixture('coinbase-pro.csv');
  const partial = withoutLines(full, (line) => (
    /^default,match,.*,-500\.0+,/.test(line) || /^default,conversion,.*,USD,/.test(line)
  ));

  const first = await upload(partial);
  assert.equal(first.body.upgraded, 0);

  const second = await upload(full);
  assert.equal(second.body.imported, 0, 'both events were already known, half-way');
  assert.equal(second.body.upgraded, 2);
  assert.equal(stored.get(`${OWNED_ACCOUNT_ID}|cbp:trade:22222222-2222-2222-2222-222222222222:900001`), false);
});

test('a shorter export never downgrades a record the fuller one completed', async () => {
  const full = fixture('kraken-ledgers.csv');
  const partial = withoutLines(full, (line) => line.includes('"LCCCCC-33333-CCCCCC"'));

  const first = await upload(full);
  assert.equal(first.body.imported, 11);

  // The user uploads last year's export by mistake. The half record must not
  // overwrite the whole one -- that would lose the counter-leg for good.
  const second = await upload(partial);
  assert.equal(second.body.imported, 0);
  assert.equal(second.body.upgraded, 0);
  assert.equal(second.body.duplicates, 11);
  assert.equal(stored.get(`${OWNED_ACCOUNT_ID}|kraken:TTRD00-11111-TTTTTT`), false, 'still the complete record');
});

test('a value the column cannot hold is a 400 that names the record, not a 500', async () => {
  failNextRecordInsertWith = '22003';

  const response = await upload(fixture('kraken-ledgers.csv'));

  assert.equal(response.status, 400);
  assert.equal(response.body.code, 'UNSTORABLE_VALUE');
  assert.match(response.body.error, /cannot be stored/);
  assert.match(response.body.error, /Nothing was imported/);
});

// --- The review queue ------------------------------------------------------

test('GET /records can ask for only the flagged rows', async () => {
  const response = await request(app)
    .get(`/api/exchanges/${OWNED_ACCOUNT_ID}/records?needs_review=true`);

  assert.equal(response.status, 200);
  assert.equal(response.body.data.length, 1);
  assert.equal(response.body.data[0].needs_review, true);
});

test('a flagged record can be resolved, which is what empties the queue', async () => {
  const response = await request(app)
    .patch(`/api/exchanges/${OWNED_ACCOUNT_ID}/records/${FLAGGED_RECORD_ID}/resolve`);

  assert.equal(response.status, 200);
  assert.equal(response.body.record.needs_review, false);
});

test('resolving a record that is not the caller\'s is a 404', async () => {
  const foreignAccount = await request(app)
    .patch(`/api/exchanges/999/records/${FLAGGED_RECORD_ID}/resolve`);
  assert.equal(foreignAccount.status, 404);

  const foreignRecord = await request(app)
    .patch(`/api/exchanges/${OWNED_ACCOUNT_ID}/records/999999/resolve`);
  assert.equal(foreignRecord.status, 404);
  assert.match(foreignRecord.body.error, /not found/i);

  asUser(2);
  const otherUser = await request(app)
    .patch(`/api/exchanges/${OWNED_ACCOUNT_ID}/records/${FLAGGED_RECORD_ID}/resolve`);
  assert.equal(otherUser.status, 404);
});

test('a JSON body may carry the CSV alongside an explicit format', async () => {
  const response = await request(app)
    .post(`/api/exchanges/${OWNED_ACCOUNT_ID}/import`)
    .send({ csv: fixture('coinbase-retail.csv'), format: 'coinbase_retail' });

  assert.equal(response.status, 200);
  assert.equal(response.body.format, 'coinbase_retail');
  assert.equal(response.body.imported, 23);
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

test('PATCH /api/exchanges/:id renames an owned account', async () => {
  const response = await request(app)
    .patch(`/api/exchanges/${OWNED_ACCOUNT_ID}`)
    .send({ name: 'Kraken Main' });

  assert.equal(response.status, 200);
  assert.equal(response.body.account.id, OWNED_ACCOUNT_ID);
});

test('importCsv itself refuses an account the caller does not own', async () => {
  // The route's loadAccount is the first gate, but the service must be its
  // own: bulkInsert keys on the raw account id, so a caller that skipped the
  // route would otherwise write records into someone else's account and only
  // the after-the-fact timestamp would fail.
  const ExchangeImportService = require('../src/services/ExchangeImportService');
  await assert.rejects(
    () => ExchangeImportService.importCsv(2, OWNED_ACCOUNT_ID, 'a,b\n1,2'),
    /not found/i
  );
});

'use strict';

// The contract every exchange venue folder meets, checked over all of them so
// a new venue inherits the checks without writing them:
//   - its CSV readers' detectors are disjoint (one file, one reader);
//   - an unknown row type imports as a reviewable transfer, never income;
//   - an unknown layout throws instead of importing a subset;
//   - an API connector names its read-only permissions and syncs;
//   - its client refuses a non-read endpoint before any network I/O.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = 'postgresql://test:test@localhost/test';

const { parseCsv } = require('../src/utils/csv');
const { VENUE_MODULES } = require('../src/crypto/exchanges/venues');
const { parseExchangeCsv } = require('../src/services/exchangeImport');

const FIXTURES = path.join(__dirname, 'fixtures', 'exchanges');
const readers = VENUE_MODULES.filter((venue) => !venue.csvFallback).flatMap((venue) => venue.csv
  .map((reader) => ({ venue: venue.id, reader })));

test('every CSV fixture is claimed by at most one venue reader', () => {
  for (const file of fs.readdirSync(FIXTURES).filter((name) => name.endsWith('.csv'))) {
    const rows = parseCsv(fs.readFileSync(path.join(FIXTURES, file), 'utf8'));
    const claims = readers.filter(({ reader }) => reader.detect(rows)).map(({ reader }) => reader.FORMAT);
    assert.ok(claims.length <= 1, `${file} is claimed by ${claims.join(', ')}`);
  }
});

test('an unknown layout throws rather than importing a subset', () => {
  assert.throws(
    () => parseExchangeCsv(fs.readFileSync(path.join(FIXTURES, 'unrecognized.csv'), 'utf8')),
    (error) => error.name === 'ImportFormatError'
  );
});

test('an unknown row type in a venue export is a reviewable transfer, never income', () => {
  const kraken = 'txid,refid,time,type,subtype,aclass,asset,amount,fee,balance\n'
    + 'L1,R1,2024-03-01 09:00:00,mysterytype,,currency,XETH,0.5,0,0.5\n';
  const record = parseExchangeCsv(kraken).records[0];
  assert.equal(record.record_type, 'transfer');
  assert.equal(record.needs_review, true);
});

test('every API connector declares read-only permissions and a sync()', () => {
  for (const venue of VENUE_MODULES.filter((entry) => entry.hasConnector)) {
    const connector = venue.connector;
    assert.equal(typeof connector.sync, 'function', venue.id);
    assert.ok(Array.isArray(connector.REQUIRED_PERMISSIONS) && connector.REQUIRED_PERMISSIONS.length > 0, venue.id);
    assert.ok(connector.REQUIRED_PERMISSIONS.every((permission) => !/trade|withdraw|transfer/i.test(permission)
      || /read|query|view/i.test(permission)), `${venue.id} asks only for read permissions`);
    assert.deepEqual(Object.keys(venue.credentials).sort(), ['help', 'keyLabel', 'permissions', 'secretLabel'], venue.id);
  }
});

test('venue clients refuse a non-read endpoint before any network call', async (t) => {
  const axios = require('axios');
  const calls = [];
  const originalGet = axios.get;
  const originalPost = axios.post;
  axios.get = async (...args) => { calls.push(args[0]); throw new Error('no network'); };
  axios.post = async (...args) => { calls.push(args[0]); throw new Error('no network'); };
  t.after(() => { axios.get = originalGet; axios.post = originalPost; });

  const KrakenClient = require('../src/crypto/exchanges/venues/kraken/client');
  await assert.rejects(new KrakenClient({ apiKey: 'k', apiSecret: Buffer.from('s').toString('base64') }).request('Withdraw', {}));
  const CoinbaseClient = require('../src/crypto/exchanges/venues/coinbase/client');
  const { privateKey } = require('crypto').generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const pem = privateKey.export({ type: 'sec1', format: 'pem' });
  await assert.rejects(new CoinbaseClient({ apiKey: 'organizations/x/apiKeys/y', apiSecret: pem }).get('/api/v3/brokerage/orders'));
  const BinanceClient = require('../src/crypto/exchanges/venues/binance_us/client');
  await assert.rejects(new BinanceClient({ apiKey: 'k', apiSecret: 's' }).get('/api/v3/order', {}));
  assert.deepEqual(calls, [], 'no request left the process');
});

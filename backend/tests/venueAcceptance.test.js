'use strict';

// Extensibility acceptance: an exchange is ONE venue folder (plus the
// CHECK-widening migration admitting its id). A synthetic CSV-only venue and
// a synthetic API venue in an extra venues directory must be recognized by
// the CSV import, the venue registry, the connector and credential maps, the
// error-code sets and the client meta -- with no core file edited.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'synthetic-venue-'));
fs.mkdirSync(path.join(dir, 'synthx'));
fs.writeFileSync(path.join(dir, 'synthx', 'csv.js'), `'use strict';
const { finalizeRecord } = require(${JSON.stringify(path.join(__dirname, '..', 'src', 'crypto', 'exchanges', 'core', 'shared'))});
const FORMAT = 'synthx';
const detect = (rows) => String(rows[0]?.[0] || '').trim() === 'SynthX Ledger Id';
function parse(rows) {
  const records = rows.slice(1).filter((row) => row.length > 1).map((row, index) => finalizeRecord({
    record_type: row[2] === 'deposit' ? 'deposit' : 'transfer', occurred_at: new Date(row[1]).toISOString(),
    base_asset: row[3], base_amount: row[4], external_id: 'synthx:' + row[0],
    needs_review: row[2] !== 'deposit', raw: { _format: FORMAT, _source_line: index + 2 },
  }, { amountCell: row[4], line: index + 2 }));
  return { records, stats: { rows: records.length } };
}
module.exports = { FORMAT, detect, parse };
`);
fs.writeFileSync(path.join(dir, 'synthx', 'index.js'), `'use strict';
module.exports = {
  id: 'synthx', order: 40,
  metadata: { label: 'SynthX', errorPrefix: 'SYNTHX', extraAuthCodes: [], bankDescriptors: ['synthx exchange'] },
  hasConnector: true,
  credentials: { keyLabel: 'API key', secretLabel: 'Secret', permissions: ['Read'], help: 'Read-only key.' },
  get csv() { return [require('./csv')]; },
  connector: { EXCHANGE: 'synthx', REQUIRED_PERMISSIONS: ['Read'], async sync() { return { records: [], cursor: null }; } },
  assets: { VERSION: 1, canonical: (raw) => String(raw || '').toUpperCase() || null, stored: (raw) => raw, STORED_ALIASES: {} },
};
`);
process.env.CRYPTO_EXTRA_VENUES_DIR = dir;
process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = 'postgresql://test:test@localhost/test';

test.after(() => fs.rmSync(dir, { recursive: true, force: true }));

test("the CSV import recognizes the new venue's export", () => {
  const { parseExchangeCsv, FORMATS } = require('../src/services/exchangeImport');
  const parsed = parseExchangeCsv('SynthX Ledger Id,Time,Type,Asset,Amount\nA1,2026-01-02T03:04:05Z,deposit,ETH,1.5\nA2,2026-01-03T00:00:00Z,mystery,ETH,2\n');
  assert.equal(parsed.format, 'synthx');
  assert.deepEqual(parsed.records.map((record) => [record.external_id, record.record_type, record.needs_review]),
    [['synthx:A1', 'deposit', false], ['synthx:A2', 'transfer', true]]);
  assert.ok(FORMATS.includes('synthx'));
});

test('the venue registry, connector map and error codes include it', () => {
  const { VENUE_IDS, venue, venueErrorCodes } = require('../src/crypto/registry/venues');
  assert.ok(VENUE_IDS.includes('synthx'));
  assert.equal(venue('synthx').label, 'SynthX');
  assert.ok(venueErrorCodes('RATE_LIMITED').has('SYNTHX_RATE_LIMITED'));
  const { connectorFor, CREDENTIAL_FIELDS } = require('../src/services/exchangeSync');
  assert.equal(connectorFor('synthx').EXCHANGE, 'synthx');
  assert.equal(CREDENTIAL_FIELDS.synthx.secretLabel, 'Secret');
  assert.ok(require('../src/models/ExchangeAccount').EXCHANGES.has('synthx'));
});

test('the client meta lists it, so the account form needs no frontend edit', () => {
  const meta = require('../src/crypto/meta').buildCryptoMeta();
  assert.deepEqual(meta.venues.find((entry) => entry.id === 'synthx'), { id: 'synthx', label: 'SynthX', apiSync: true });
});

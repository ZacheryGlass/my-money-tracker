'use strict';

// Modules moved into crypto/ keep a shim at their old path. The shim must
// return the very same module object: the suite (and callers) stub functions
// by property assignment, and a copy would let a stub miss the real caller.

const { test } = require('node:test');
const assert = require('node:assert/strict');

process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = 'postgresql://test:test@localhost/test';

const SHIMS = {
  '../src/utils/ethActivityVocabulary': '../src/crypto/registry/vocabulary',
  '../src/services/exchangeImport/shared': '../src/crypto/exchanges/core/shared',
  '../src/services/exchangeImport/canonicalFingerprint': '../src/crypto/exchanges/core/fingerprint',
  '../src/services/exchangeImport/kraken': '../src/crypto/exchanges/venues/kraken/csv',
  '../src/services/exchangeImport/krakenLedger': '../src/crypto/exchanges/venues/kraken/ledger',
  '../src/services/exchangeSync/kraken': '../src/crypto/exchanges/venues/kraken/connector',
  '../src/services/exchangeSync/krakenClient': '../src/crypto/exchanges/venues/kraken/client',
  '../src/services/exchangeImport/coinbaseRetail': '../src/crypto/exchanges/venues/coinbase/csvRetail',
  '../src/services/exchangeImport/coinbasePro': '../src/crypto/exchanges/venues/coinbase/csvPro',
  '../src/services/exchangeImport/coinbaseFunding': '../src/crypto/exchanges/venues/coinbase/funding',
  '../src/services/exchangeSync/coinbase': '../src/crypto/exchanges/venues/coinbase/connector',
  '../src/services/exchangeSync/coinbaseClient': '../src/crypto/exchanges/venues/coinbase/client',
  '../src/services/exchangeImport/binanceUs': '../src/crypto/exchanges/venues/binance_us/csv',
  '../src/services/exchangeSync/binanceus': '../src/crypto/exchanges/venues/binance_us/connector',
  '../src/services/exchangeSync/binanceusClient': '../src/crypto/exchanges/venues/binance_us/client',
  '../src/services/exchangeImport/generic': '../src/crypto/exchanges/venues/other/csv',
};

test('every old module path is the moved module itself', () => {
  for (const [oldPath, newPath] of Object.entries(SHIMS)) {
    assert.equal(require(oldPath), require(newPath), oldPath);
  }
});

test('the venue folders feed the connector, credential and CSV registries', () => {
  const { CONNECTORS, CREDENTIAL_FIELDS } = require('../src/services/exchangeSync');
  assert.equal(CONNECTORS.get('kraken'), require('../src/crypto/exchanges/venues/kraken/connector'));
  assert.deepEqual(Object.keys(CREDENTIAL_FIELDS).sort(), ['binance_us', 'coinbase', 'kraken']);
  assert.ok(Array.isArray(CREDENTIAL_FIELDS.kraken.permissions));
  const { FORMATS } = require('../src/services/exchangeImport');
  assert.deepEqual(FORMATS, ['coinbase_retail', 'coinbase_pro', 'kraken', 'binance_us', 'generic']);
});

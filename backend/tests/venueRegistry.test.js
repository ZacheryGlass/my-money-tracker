'use strict';

// The venue registry replaces the per-service code lists. These pin that the
// derived sets are exactly the lists they replaced.

const { test } = require('node:test');
const assert = require('node:assert/strict');

process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = 'postgresql://test:test@localhost/test';

const { venueErrorCodes, VENUE_IDS, venue } = require('../src/crypto/registry/venues');

test('derived venue error codes equal the lists they replaced', () => {
  assert.deepEqual([...venueErrorCodes('RATE_LIMITED')].sort(),
    ['BINANCE_US_RATE_LIMITED', 'COINBASE_RATE_LIMITED', 'KRAKEN_RATE_LIMITED']);
  assert.deepEqual([...venueErrorCodes('API_ERROR')].sort(),
    ['BINANCE_US_API_ERROR', 'COINBASE_API_ERROR', 'KRAKEN_API_ERROR']);
  assert.deepEqual([...venueErrorCodes('AUTH_FAILED')].sort(),
    ['BINANCE_US_AUTH_FAILED', 'COINBASE_AUTH_FAILED', 'COINBASE_KEY_FORMAT', 'KRAKEN_AUTH_FAILED']);
});

test('every API connector is a registry venue marked apiSync, and only those', () => {
  const { CONNECTORS } = require('../src/services/exchangeSync');
  assert.deepEqual([...CONNECTORS.keys()].sort(), VENUE_IDS.filter((id) => venue(id).apiSync).sort());
  assert.deepEqual([...require('../src/models/ExchangeAccount').EXCHANGES].sort(), [...VENUE_IDS].sort());
});

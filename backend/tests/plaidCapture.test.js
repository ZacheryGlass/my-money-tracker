'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = 'postgresql://test:test@localhost/test';

const pgModulePath = require.resolve('pg');
require.cache[pgModulePath] = {
  id: pgModulePath,
  filename: pgModulePath,
  loaded: true,
  exports: {
    Pool: class FakePool {
      query() { throw new Error('Unexpected query'); }
      connect() { throw new Error('Unexpected connect'); }
      on() {}
    },
    types: { setTypeParser() {} },
  },
};

const { deriveTaxTreatment } = require('../src/services/PlaidService');

test('deriveTaxTreatment maps Roth subtypes to roth', () => {
  assert.equal(deriveTaxTreatment('roth', 'investment'), 'roth');
  assert.equal(deriveTaxTreatment('roth 401k', 'investment'), 'roth');
  assert.equal(deriveTaxTreatment('ROTH', 'investment'), 'roth');
});

test('deriveTaxTreatment maps pre-tax retirement subtypes to traditional', () => {
  for (const subtype of ['401k', '403b', '457b', 'ira', 'sep ira', 'simple ira', 'pension']) {
    assert.equal(deriveTaxTreatment(subtype, 'investment'), 'traditional', subtype);
  }
});

test('deriveTaxTreatment maps hsa to hsa', () => {
  assert.equal(deriveTaxTreatment('hsa', 'investment'), 'hsa');
});

// A subtype Plaid adds later is far more likely to be another brokerage flavor
// than another retirement wrapper, and taxable is the conservative default.
test('deriveTaxTreatment defaults unknown investment subtypes to taxable', () => {
  assert.equal(deriveTaxTreatment('brokerage', 'investment'), 'taxable');
  assert.equal(deriveTaxTreatment('some new wrapper', 'investment'), 'taxable');
  assert.equal(deriveTaxTreatment(null, 'investment'), 'taxable');
});

// Checking accounts have no tax treatment at all; forcing them to 'taxable'
// would make them look like brokerage accounts to the analysis layer.
test('deriveTaxTreatment returns null for non-investment accounts', () => {
  assert.equal(deriveTaxTreatment('checking', 'depository'), null);
  assert.equal(deriveTaxTreatment('credit card', 'credit'), null);
  assert.equal(deriveTaxTreatment('401k', 'depository'), null);
});

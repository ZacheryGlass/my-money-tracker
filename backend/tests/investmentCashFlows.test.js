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

const { deriveFlow } = require('../src/services/InvestmentCashFlowService');

test('deriveFlow ignores security trades, which belong in `trades`', () => {
  assert.equal(deriveFlow({ category: 'buy', amount: 500 }), null);
  assert.equal(deriveFlow({ category: 'sell', amount: -500 }), null);
});

test('deriveFlow ignores categories that are not cash events', () => {
  assert.equal(deriveFlow({ category: 'FOOD_AND_DRINK', amount: 12 }), null);
  assert.equal(deriveFlow({ category: null, amount: 12 }), null);
});

test('deriveFlow marks only boundary-crossing money as external', () => {
  assert.equal(deriveFlow({ category: 'contribution', amount: 1532.12 }).isExternal, true);
  assert.equal(deriveFlow({ category: 'withdrawal', amount: 5.41 }).isExternal, true);
  assert.equal(deriveFlow({ category: 'dividend', amount: -20 }).isExternal, false);
  assert.equal(deriveFlow({ category: 'interest', amount: -0.84 }).isExternal, false);
  assert.equal(deriveFlow({ category: 'margin expense', amount: 128.12 }).isExternal, false);
  assert.equal(deriveFlow({ category: 'transfer', amount: -30000 }).isExternal, false);
});

// The production data has `contribution` rows stored positive, which is the
// opposite of Plaid's documented convention. Direction has to come from the
// category or every 401k contribution inverts and XIRR silently breaks.
test('deriveFlow takes direction from the category, not the stored sign', () => {
  const positive = deriveFlow({ category: 'contribution', amount: 1532.12 });
  const negative = deriveFlow({ category: 'contribution', amount: -1532.12 });

  assert.equal(positive.amount, 1532.12);
  assert.equal(negative.amount, 1532.12);
  assert.equal(positive.flowType, 'contribution');
  assert.equal(negative.flowType, 'contribution');
});

test('deriveFlow signs money out negative regardless of stored sign', () => {
  assert.equal(deriveFlow({ category: 'withdrawal', amount: 3.24 }).amount, -3.24);
  assert.equal(deriveFlow({ category: 'withdrawal', amount: -3.24 }).amount, -3.24);
  assert.equal(deriveFlow({ category: 'miscellaneous fee', amount: 9.35 }).amount, -9.35);
});

test('deriveFlow maps money in as positive', () => {
  assert.equal(deriveFlow({ category: 'dividend', amount: -209.29 }).amount, 209.29);
  assert.equal(deriveFlow({ category: 'deposit', amount: -204.96 }).amount, 204.96);
});

// Transfers carry no directional category, so the Plaid sign is the only hint:
// negative means cash was credited to the account.
test('deriveFlow resolves transfer direction from the sign', () => {
  const inbound = deriveFlow({ category: 'transfer', amount: -30000 });
  const outbound = deriveFlow({ category: 'transfer', amount: 39000 });

  assert.equal(inbound.flowType, 'transfer_in');
  assert.equal(inbound.amount, 30000);
  assert.equal(outbound.flowType, 'transfer_out');
  assert.equal(outbound.amount, -39000);
});

test('deriveFlow handles string amounts as returned by pg', () => {
  assert.equal(deriveFlow({ category: 'contribution', amount: '1532.12' }).amount, 1532.12);
});

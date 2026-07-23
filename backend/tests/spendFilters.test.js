'use strict';

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = 'postgresql://test:test@localhost/test';

let queries = [];
const pgModulePath = require.resolve('pg');
require.cache[pgModulePath] = {
  id: pgModulePath,
  filename: pgModulePath,
  loaded: true,
  exports: {
    Pool: class FakePool {
      async query(text, params) {
        queries.push({ text, params });
        return { rows: [] };
      }
      connect() { throw new Error('Unexpected connect'); }
      on() {}
    },
    types: { setTypeParser() {} },
  },
};

const { SPEND_ELIGIBILITY_SQL } = require('../src/utils/spendFilters');
const MerchantSpend = require('../src/models/MerchantSpend');
const RecurringExpense = require('../src/models/RecurringExpense');
const ExpenseSyncService = require('../src/services/ExpenseSyncService');

beforeEach(() => {
  queries = [];
});

const CARD_PAYMENT_CLAUSE = "COALESCE(t.detailed_category, '') <> 'LOAN_PAYMENTS_CREDIT_CARD_PAYMENT'";

test('the shared spend filter excludes credit-card payments', () => {
  assert.ok(SPEND_ELIGIBILITY_SQL.includes(CARD_PAYMENT_CLAUSE));
});

// Each of these fed the merchant-facing lists with its own copy of the
// eligibility filter before they were unified. Asserting on the query text
// catches a re-inlined copy that drifts back to including card payments.
test('Top Merchants applies the shared spend filter', async () => {
  await MerchantSpend.topForWindow(90);
  assert.equal(queries.length, 1);
  assert.ok(queries[0].text.includes(CARD_PAYMENT_CLAUSE));
});

test('tracked-expense charge list applies the shared spend filter', async () => {
  await RecurringExpense.chargesForMerchant('Netflix');
  assert.equal(queries.length, 1);
  assert.ok(queries[0].text.includes(CARD_PAYMENT_CLAUSE));
});

test('expense sync applies the shared spend filter when gathering charges', async () => {
  await ExpenseSyncService.run();
  const chargeQuery = queries.find((q) => q.text.includes('merchant_key'));
  assert.ok(chargeQuery, 'expected the eligible-charge query');
  assert.ok(chargeQuery.text.includes(CARD_PAYMENT_CLAUSE));
});

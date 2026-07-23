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

const { SPEND_ELIGIBILITY_SQL, CREDIT_CARD_PAYMENT_CATEGORY } = require('../src/utils/spendFilters');
const MerchantSpend = require('../src/models/MerchantSpend');
const RecurringExpense = require('../src/models/RecurringExpense');
const ExpenseSyncService = require('../src/services/ExpenseSyncService');
const { DETAILED_DIRECTIONS } = require('../src/services/TransactionClassificationService');

beforeEach(() => {
  queries = [];
});

const CARD_PAYMENT_CLAUSE =
  `UPPER(COALESCE(t.detailed_category, '')) <> '${CREDIT_CARD_PAYMENT_CATEGORY}'`;

test('the shared spend filter excludes credit-card payments', () => {
  assert.ok(SPEND_ELIGIBILITY_SQL.includes(CARD_PAYMENT_CLAUSE));
});

// The fragment is spliced into three WHERE clauses. Self-parenthesizing is what
// keeps a future OR clause inside it from rewriting the callers' precedence.
test('the shared spend filter is self-parenthesized', () => {
  const trimmed = SPEND_ELIGIBILITY_SQL.trim();
  assert.ok(trimmed.startsWith('('), 'fragment must open with a paren');
  assert.ok(trimmed.endsWith(')'), 'fragment must close with a paren');
});

// The Spending pages filter card payments in SQL; the MCP layer reaches the
// same result by classifying them 'internal_transfer'. Both must name the same
// Plaid category or the two surfaces disagree about what counts as spend.
test('classification and the spend filter agree on the card-payment category', () => {
  assert.equal(DETAILED_DIRECTIONS[CREDIT_CARD_PAYMENT_CATEGORY], 'internal_transfer');
});

// Each of these fed the merchant-facing lists with its own copy of the
// eligibility filter before they were unified. Asserting on the query text
// catches a re-inlined copy that drifts back to including card payments.
// It cannot catch a fragment spliced somewhere inert -- the fake pool never
// executes SQL, so only a live database can prove the rows are actually gone.
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
  // Matched on the FROM clause: run() issues several queries and two of them
  // mention merchant_key, so that substring would not identify this one.
  const chargeQueries = queries.filter((q) => q.text.includes('FROM transactions t'));
  assert.equal(chargeQueries.length, 1, 'expected exactly one eligible-charge query');
  assert.ok(chargeQueries[0].text.includes(CARD_PAYMENT_CLAUSE));
});

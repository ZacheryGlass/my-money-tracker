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

const { classify } = require('../src/services/TransactionClassificationService');

// LOAN_PAYMENTS alone cannot tell a mortgage payment (spending) from paying off
// a card from checking (moving your own money). The detailed category can.
test('classify treats a credit card payment as an internal transfer', () => {
  const result = classify({
    category: 'LOAN_PAYMENTS',
    detailed_category: 'LOAN_PAYMENTS_CREDIT_CARD_PAYMENT',
    category_confidence: 'VERY_HIGH',
    amount: 500,
  });

  assert.equal(result.direction, 'internal_transfer');
  assert.equal(result.isInternalTransfer, true);
});

test('classify still treats other loan payments as debt payments', () => {
  const result = classify({
    category: 'LOAN_PAYMENTS',
    detailed_category: 'LOAN_PAYMENTS_MORTGAGE_PAYMENT',
    category_confidence: 'HIGH',
    amount: 2200,
  });

  assert.equal(result.direction, 'debt_payment');
  assert.equal(result.isInternalTransfer, false);
});

test('classify splits INCOME into dividends and interest by detailed category', () => {
  assert.equal(classify({
    category: 'INCOME', detailed_category: 'INCOME_DIVIDENDS', amount: -42,
  }).direction, 'dividend');

  assert.equal(classify({
    category: 'INCOME', detailed_category: 'INCOME_INTEREST_EARNED', amount: -3,
  }).direction, 'interest');

  assert.equal(classify({
    category: 'INCOME', detailed_category: 'INCOME_WAGES', amount: -4000,
  }).direction, 'income');
});

// Investment-feed rows have lowercase primary categories and no detailed
// category at all. Their existing mapping must be untouched by the override.
test('classify leaves investment-feed categories alone', () => {
  const cases = {
    buy: 'investment_contribution',
    sell: 'investment_withdrawal',
    contribution: 'investment_contribution',
    dividend: 'dividend',
    interest: 'interest',
    transfer: 'internal_transfer',
    'miscellaneous fee': 'fee',
  };
  for (const [category, expected] of Object.entries(cases)) {
    const result = classify({ category, detailed_category: null, amount: 100 });
    assert.equal(result.direction, expected, category);
  }
});

test('classify converts Plaid confidence levels to numbers', () => {
  const at = (level) => classify({
    category: 'INCOME', detailed_category: 'INCOME_WAGES', category_confidence: level, amount: -1,
  }).confidence;

  assert.equal(at('VERY_HIGH'), 0.95);
  assert.equal(at('HIGH'), 0.85);
  assert.equal(at('MEDIUM'), 0.6);
  assert.equal(at('LOW'), 0.4);
  assert.equal(at('UNKNOWN'), 0.5);
  assert.equal(at(null), 0.9);
});

// The sign fallback does not use Plaid's category, so Plaid's grade of that
// category says nothing about it.
test('classify keeps the flat fallback confidence for unmapped categories', () => {
  const result = classify({
    category: 'FOOD_AND_DRINK',
    detailed_category: 'FOOD_AND_DRINK_RESTAURANT',
    category_confidence: 'VERY_HIGH',
    amount: 24.5,
  });

  assert.equal(result.direction, 'spending');
  assert.equal(result.confidence, 0.5);
});

test('classify falls back to the amount sign when there is no category', () => {
  assert.equal(classify({ amount: 30 }).direction, 'spending');
  assert.equal(classify({ amount: -30 }).direction, 'income');
});

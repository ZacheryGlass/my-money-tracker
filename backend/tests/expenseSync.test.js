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

const {
  scoreMatch,
  matchExpenses,
  deriveFields,
  isMonthlyCadence,
  buildGroups,
} = require('../src/services/ExpenseSyncService');
const { classify } = require('../src/services/TransactionClassificationService');

test('scoreMatch: exact company match wins regardless of amount gap', () => {
  const score = scoreMatch(
    { name: 'Car Insurance', company: 'State Farm', cost: 90 },
    { merchantKey: 'State Farm', category: 'GENERAL_SERVICES', avgAmount: 55.92 }
  );
  assert.equal(score, 3);
});

test('scoreMatch: containment match links company substring merchants', () => {
  const score = scoreMatch(
    { name: 'Internet', company: 'Google Fiber', cost: 55 },
    { merchantKey: 'Fiber', category: 'RENT_AND_UTILITIES', avgAmount: 56.1 }
  );
  assert.equal(score, 2.5);
});

test('scoreMatch: category-token match requires tight amount agreement', () => {
  const rent = { name: 'Rent', company: null, cost: 2200 };
  const evernest = { merchantKey: 'Evernest', category: 'RENT_AND_UTILITIES', avgAmount: 2160.99 };
  const smallUtility = { merchantKey: 'S & T', category: 'RENT_AND_UTILITIES', avgAmount: 40 };
  assert.ok(scoreMatch(rent, evernest) > 0);
  assert.equal(scoreMatch(rent, smallUtility), null);
});

test('scoreMatch: no text evidence yields no match', () => {
  const score = scoreMatch(
    { name: 'Google Storage', company: null, cost: 2 },
    { merchantKey: 'Proton Ag', category: 'GENERAL_SERVICES', avgAmount: 12.99 }
  );
  assert.equal(score, null);
});

test('matchExpenses: exact name beats containment and links greedily', () => {
  const links = matchExpenses(
    [{ id: 13, name: 'Amazon Prime', company: null, cost: 15 }],
    [
      { merchantKey: 'Amazon Prime Video', category: 'ENTERTAINMENT', avgAmount: 7.93 },
      { merchantKey: 'Amazon Prime', category: 'GENERAL_MERCHANDISE', avgAmount: 6.99 },
    ]
  );
  assert.equal(links.length, 1);
  assert.equal(links[0].merchantKey, 'Amazon Prime');
});

test('deriveFields: stable amounts derive a fixed cost from the last charge', () => {
  const charges = ['2026-03-01', '2026-04-01', '2026-05-01', '2026-06-01', '2026-07-01'].map((date) => ({
    date, amount: 2160.99, account_id: 64, merchant_name: 'Evernest', account_display: 'Ally Checking',
  }));
  const derived = deriveFields(charges, '2026-07-19');
  assert.equal(derived.cost, 2160.99);
  assert.equal(derived.isFixed, true);
  assert.equal(derived.dueDay, 1);
  assert.equal(derived.intervalDays, 31);
  assert.equal(derived.lastChargeDate, '2026-07-01');
  assert.equal(derived.accountId, 64);
  assert.equal(derived.payAccount, 'Ally Checking');
});

test('deriveFields: variable amounts derive a recent average', () => {
  const charges = [
    { date: '2026-05-15', amount: 50, account_id: 65, merchant_name: 'Evergy', account_display: 'Chase' },
    { date: '2026-06-15', amount: 90, account_id: 65, merchant_name: 'Evergy', account_display: 'Chase' },
    { date: '2026-07-15', amount: 130, account_id: 65, merchant_name: 'Evergy', account_display: 'Chase' },
  ];
  const derived = deriveFields(charges, '2026-07-19');
  assert.equal(derived.isFixed, false);
  assert.equal(derived.cost, 90);
  assert.equal(derived.dueDay, 15);
});

test('deriveFields: returns null when no charges fall in the window', () => {
  const charges = [{ date: '2025-01-01', amount: 10, account_id: 1, merchant_name: 'Old', account_display: 'X' }];
  assert.equal(deriveFields(charges, '2026-07-19'), null);
});

test('isMonthlyCadence: accepts monthly gaps, rejects frequent and unknown', () => {
  assert.equal(isMonthlyCadence(30), true);
  assert.equal(isMonthlyCadence(2), false);
  assert.equal(isMonthlyCadence(90), false);
  assert.equal(isMonthlyCadence(null), false);
});

test('buildGroups: requires 3+ charges spanning more than 60 days', () => {
  const mk = (key, dates) => dates.map((date) => ({ merchant_key: key, date, amount: 10, category: 'ENTERTAINMENT' }));
  const groups = buildGroups([
    ...mk('Keeper', ['2026-04-01', '2026-05-01', '2026-06-05']),
    ...mk('TooFew', ['2026-04-01', '2026-05-01']),
    ...mk('TooShort', ['2026-06-01', '2026-06-10', '2026-06-20']),
  ]);
  assert.deepEqual(groups.map((g) => g.merchantKey), ['Keeper']);
});

test('deriveFields: a high-variance monthly utility still derives a valid entry', () => {
  // Variance no longer gates auto-create; a variable monthly bill (e.g. Evergy)
  // must still yield a monthly-cadence entry with an averaged cost.
  const charges = [
    { date: '2026-04-19', amount: 60, account_id: 65, merchant_name: 'Evergy', account_display: 'Chase' },
    { date: '2026-05-19', amount: 120, account_id: 65, merchant_name: 'Evergy', account_display: 'Chase' },
    { date: '2026-06-19', amount: 180, account_id: 65, merchant_name: 'Evergy', account_display: 'Chase' },
    { date: '2026-07-19', amount: 240, account_id: 65, merchant_name: 'Evergy', account_display: 'Chase' },
  ];
  const derived = deriveFields(charges, '2026-07-20');
  assert.equal(derived.isFixed, false);
  assert.ok(isMonthlyCadence(derived.intervalDays), 'monthly cadence recognized despite variance');
  assert.ok(derived.cost > 0);
});

test('buildGroups: keeps a group regardless of amount variance', () => {
  // Loan/utility charges vary in amount but must still form a group so the
  // auto-create loop (which no longer checks variance) can consider them.
  const charges = ['2026-04-01', '2026-05-01', '2026-06-05', '2026-07-05'].map((date, i) => ({
    merchant_key: 'Lightstream', date, amount: 100 + i * 50, category: 'LOAN_PAYMENTS',
  }));
  const groups = buildGroups(charges);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].merchantKey, 'Lightstream');
  assert.ok(groups[0].sd >= 5, 'high variance group is retained');
});

test('classify: maps categories to directions with transfer flag', () => {
  assert.deepEqual(classify({ category: 'transfer', amount: 3000 }), {
    direction: 'internal_transfer', isInternalTransfer: true, confidence: 0.9,
  });
  assert.equal(classify({ category: 'TRANSFER_OUT', amount: 50 }).isInternalTransfer, true);
  assert.equal(classify({ category: 'LOAN_PAYMENTS', amount: 118 }).direction, 'debt_payment');
  assert.equal(classify({ category: 'buy', amount: 500 }).direction, 'investment_contribution');
  assert.equal(classify({ category: 'dividend', amount: 12 }).direction, 'dividend');
});

test('classify: falls back on amount sign for unmapped categories', () => {
  assert.equal(classify({ category: 'FOOD_AND_DRINK', amount: 20 }).direction, 'spending');
  assert.equal(classify({ category: null, amount: -1500 }).direction, 'income');
});

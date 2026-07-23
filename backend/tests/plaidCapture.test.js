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

const { deriveTaxTreatment, mapLiabilityToDebtTerms } = require('../src/services/PlaidService');

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

const creditLiability = {
  account_id: 'acct_1',
  aprs: [
    { apr_type: 'balance_transfer_apr', apr_percentage: 0 },
    { apr_type: 'purchase_apr', apr_percentage: 23.49 },
    { apr_type: 'cash_apr', apr_percentage: 29.99 },
  ],
  is_overdue: false,
  last_payment_amount: 412.75,
  last_payment_date: '2026-06-18',
  last_statement_balance: 1204.11,
  last_statement_issue_date: '2026-06-30',
  minimum_payment_amount: 40,
  next_payment_due_date: '2026-07-25',
};

// debt_terms.apr is consumed as a growth rate and rendered as apr * 100. Storing
// Plaid's 23.49 verbatim would model a 2349% card and blow up every projection.
test('mapLiabilityToDebtTerms converts APR percentage to a fraction', () => {
  const terms = mapLiabilityToDebtTerms(creditLiability, 'credit');
  assert.equal(terms.apr, 0.2349);
});

test('mapLiabilityToDebtTerms picks the purchase APR over the other card APRs', () => {
  const terms = mapLiabilityToDebtTerms(creditLiability, 'credit');
  assert.equal(terms.apr, 0.2349);

  const noPurchase = mapLiabilityToDebtTerms(
    { ...creditLiability, aprs: [{ apr_type: 'cash_apr', apr_percentage: 29.99 }] },
    'credit'
  );
  assert.equal(noPurchase.apr, 0.2999);

  const noAprs = mapLiabilityToDebtTerms({ ...creditLiability, aprs: [] }, 'credit');
  assert.equal(noAprs.apr, null);
});

test('mapLiabilityToDebtTerms derives due_day from the next due date', () => {
  assert.equal(mapLiabilityToDebtTerms(creditLiability, 'credit').dueDay, 25);
  assert.equal(mapLiabilityToDebtTerms({}, 'credit').dueDay, null);
});

test('mapLiabilityToDebtTerms carries the statement and payment detail', () => {
  const terms = mapLiabilityToDebtTerms(creditLiability, 'credit');
  assert.equal(terms.minimumPayment, 40);
  assert.equal(terms.lastStatementBalance, 1204.11);
  assert.equal(terms.lastStatementDate, '2026-06-30');
  assert.equal(terms.lastPaymentAmount, 412.75);
  assert.equal(terms.lastPaymentDate, '2026-06-18');
  assert.equal(terms.isOverdue, false);
  assert.equal(terms.nextPaymentDueDate, '2026-07-25');
});

// Cards never report a maturity date; the upsert only COALESCEs it in, so a null
// here is what lets a hand-entered payoff date survive the next sync.
test('mapLiabilityToDebtTerms leaves maturity_date null for credit cards', () => {
  assert.equal(mapLiabilityToDebtTerms(creditLiability, 'credit').maturityDate, null);
});

test('mapLiabilityToDebtTerms reads the mortgage rate and monthly payment', () => {
  const terms = mapLiabilityToDebtTerms({
    interest_rate: { percentage: 6.125, type: 'fixed' },
    next_monthly_payment: 2210.55,
    maturity_date: '2055-04-01',
    next_payment_due_date: '2026-08-01',
  }, 'mortgage');

  assert.equal(terms.apr, 0.06125);
  assert.equal(terms.minimumPayment, 2210.55);
  assert.equal(terms.maturityDate, '2055-04-01');
  assert.equal(terms.dueDay, 1);
});

test('mapLiabilityToDebtTerms reads the student loan rate and payoff date', () => {
  const terms = mapLiabilityToDebtTerms({
    interest_rate_percentage: 5.25,
    minimum_payment_amount: 175,
    expected_payoff_date: '2032-09-15',
    next_payment_due_date: '2026-08-09',
  }, 'student');

  assert.equal(terms.apr, 0.0525);
  assert.equal(terms.minimumPayment, 175);
  assert.equal(terms.maturityDate, '2032-09-15');
  assert.equal(terms.dueDay, 9);
});

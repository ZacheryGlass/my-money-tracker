'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  futureValue,
  percentChange,
  summarizeSeries,
  timeWeightedReturn,
  xirr,
} = require('../src/utils/financialMath');

test('percentChange uses the magnitude of the starting value', () => {
  assert.equal(percentChange(125, 100), 25);
  assert.equal(percentChange(-75, -100), 25);
  assert.equal(percentChange(10, 0), null);
});

test('summarizeSeries reports change, extrema, and maximum drawdown', () => {
  const result = summarizeSeries([
    { date: '2025-01-01', value: 100 },
    { date: '2025-01-02', value: 120 },
    { date: '2025-01-03', value: 90 },
    { date: '2025-01-04', value: 110 },
  ]);

  assert.deepEqual(result, {
    startValue: 100,
    endValue: 110,
    change: 10,
    changePercent: 10,
    high: 120,
    low: 90,
    maxDrawdownPercent: -25,
  });
});

test('timeWeightedReturn compounds subperiod returns', () => {
  const result = timeWeightedReturn([
    { date: '2025-01-01', value: 100 },
    { date: '2025-01-02', value: 110 },
    { date: '2025-01-03', value: 121 },
  ]);

  assert.equal(result, 21);
});

test('xirr returns an annualized money-weighted return', () => {
  const result = xirr([
    { date: '2025-01-01', amount: -1000 },
    { date: '2026-01-01', amount: 1100 },
  ]);

  assert.ok(result > 9.9 && result < 10.1, `expected about 10%, received ${result}`);
});

test('futureValue returns a year-by-year scenario series', () => {
  const result = futureValue({
    principal: 0,
    monthlyContribution: 100,
    annualReturn: 0,
    years: 2,
  });

  assert.equal(result.endingValue, 2400);
  assert.deepEqual(result.series, [
    { year: 1, value: 1200 },
    { year: 2, value: 2400 },
  ]);
});

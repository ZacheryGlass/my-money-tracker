'use strict';

function toNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function round(value, places = 2) {
  if (!Number.isFinite(value)) return null;
  const factor = 10 ** places;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

function percentChange(current, previous) {
  if (!Number.isFinite(current) || !Number.isFinite(previous) || previous === 0) return null;
  return round(((current - previous) / Math.abs(previous)) * 100, 4);
}

function summarizeSeries(points) {
  if (!points.length) {
    return {
      startValue: null,
      endValue: null,
      change: null,
      changePercent: null,
      high: null,
      low: null,
      maxDrawdownPercent: null,
    };
  }

  const values = points.map((point) => toNumber(point.value));
  const startValue = values[0];
  const endValue = values[values.length - 1];
  let runningHigh = -Infinity;
  let maxDrawdown = 0;

  for (const value of values) {
    runningHigh = Math.max(runningHigh, value);
    if (runningHigh > 0) {
      maxDrawdown = Math.min(maxDrawdown, (value - runningHigh) / runningHigh);
    }
  }

  return {
    startValue: round(startValue),
    endValue: round(endValue),
    change: round(endValue - startValue),
    changePercent: percentChange(endValue, startValue),
    high: round(Math.max(...values)),
    low: round(Math.min(...values)),
    maxDrawdownPercent: round(maxDrawdown * 100, 4),
  };
}

function calculateReturns(points, flowsByDate = new Map()) {
  const returns = [];
  for (let index = 1; index < points.length; index += 1) {
    const previous = toNumber(points[index - 1].value);
    const current = toNumber(points[index].value);
    const flow = toNumber(flowsByDate.get(points[index].date));
    if (previous === 0) continue;
    returns.push({
      date: points[index].date,
      value: (current - flow) / previous - 1,
    });
  }
  return returns;
}

function timeWeightedReturn(points, flowsByDate = new Map()) {
  const returns = calculateReturns(points, flowsByDate);
  if (!returns.length) return null;
  return round((returns.reduce((product, item) => product * (1 + item.value), 1) - 1) * 100, 6);
}

function standardDeviation(values) {
  if (values.length < 2) return null;
  const average = values.reduce((sum, value) => sum + value, 0) / values.length;
  const variance = values.reduce((sum, value) => sum + ((value - average) ** 2), 0) / (values.length - 1);
  return Math.sqrt(variance);
}

function riskMetrics(points, flowsByDate = new Map(), periodsPerYear = 252) {
  const returns = calculateReturns(points, flowsByDate).map((item) => item.value);
  const deviation = standardDeviation(returns);
  return {
    observations: returns.length,
    annualizedVolatilityPercent: deviation === null ? null : round(deviation * Math.sqrt(periodsPerYear) * 100, 4),
    ...summarizeSeries(points),
  };
}

function correlationAndBeta(primary, benchmark) {
  const benchmarkMap = new Map(benchmark.map((point) => [point.date, toNumber(point.value)]));
  const pairs = primary
    .filter((point) => benchmarkMap.has(point.date))
    .map((point) => [toNumber(point.value), benchmarkMap.get(point.date)]);

  if (pairs.length < 3) return { observations: pairs.length, correlation: null, beta: null };
  const primaryValues = pairs.map((pair) => pair[0]);
  const benchmarkValues = pairs.map((pair) => pair[1]);
  const primaryMean = primaryValues.reduce((sum, value) => sum + value, 0) / primaryValues.length;
  const benchmarkMean = benchmarkValues.reduce((sum, value) => sum + value, 0) / benchmarkValues.length;
  let covariance = 0;
  let primaryVariance = 0;
  let benchmarkVariance = 0;

  for (let index = 0; index < pairs.length; index += 1) {
    const primaryDelta = primaryValues[index] - primaryMean;
    const benchmarkDelta = benchmarkValues[index] - benchmarkMean;
    covariance += primaryDelta * benchmarkDelta;
    primaryVariance += primaryDelta ** 2;
    benchmarkVariance += benchmarkDelta ** 2;
  }

  return {
    observations: pairs.length,
    correlation: primaryVariance && benchmarkVariance
      ? round(covariance / Math.sqrt(primaryVariance * benchmarkVariance), 6)
      : null,
    beta: benchmarkVariance ? round(covariance / benchmarkVariance, 6) : null,
  };
}

function xnpv(rate, cashFlows) {
  const start = new Date(cashFlows[0].date).getTime();
  return cashFlows.reduce((total, cashFlow) => {
    const years = (new Date(cashFlow.date).getTime() - start) / (365.25 * 24 * 60 * 60 * 1000);
    return total + (cashFlow.amount / ((1 + rate) ** years));
  }, 0);
}

function xirr(cashFlows) {
  if (cashFlows.length < 2) return null;
  const hasPositive = cashFlows.some((flow) => flow.amount > 0);
  const hasNegative = cashFlows.some((flow) => flow.amount < 0);
  if (!hasPositive || !hasNegative) return null;

  let low = -0.9999;
  let high = 10;
  let lowValue = xnpv(low, cashFlows);
  let highValue = xnpv(high, cashFlows);

  for (let attempt = 0; attempt < 12 && Math.sign(lowValue) === Math.sign(highValue); attempt += 1) {
    high *= 2;
    highValue = xnpv(high, cashFlows);
  }
  if (Math.sign(lowValue) === Math.sign(highValue)) return null;

  for (let iteration = 0; iteration < 160; iteration += 1) {
    const midpoint = (low + high) / 2;
    const midpointValue = xnpv(midpoint, cashFlows);
    if (Math.abs(midpointValue) < 0.0001) return round(midpoint * 100, 6);
    if (Math.sign(midpointValue) === Math.sign(lowValue)) {
      low = midpoint;
      lowValue = midpointValue;
    } else {
      high = midpoint;
      highValue = midpointValue;
    }
  }
  return round(((low + high) / 2) * 100, 6);
}

function futureValue({ principal, monthlyContribution, annualReturn, years }) {
  const months = Math.max(0, Math.round(years * 12));
  const monthlyRate = annualReturn / 12;
  let value = principal;
  const series = [];

  for (let month = 1; month <= months; month += 1) {
    value = value * (1 + monthlyRate) + monthlyContribution;
    if (month % 12 === 0 || month === months) {
      series.push({ year: round(month / 12, 2), value: round(value) });
    }
  }
  return { endingValue: round(value), series };
}

module.exports = {
  calculateReturns,
  correlationAndBeta,
  futureValue,
  percentChange,
  riskMetrics,
  round,
  summarizeSeries,
  timeWeightedReturn,
  toNumber,
  xirr,
};

'use strict';

// The exchange balance reconciliation policy, stated once: the dust band, the
// per-asset verdict, the report statuses, and which accepted exceptions still
// block. Used by the account report (ExchangeReconciliationService), the
// per-asset audit (ExchangeBalanceReconciliationService), the exceptions
// model, and -- through GET /api/crypto/meta -- the exception queue UI.
//
// Exact decimal strings throughout; never floats.

const {
  absAmount, compareAmounts, subtractAmounts, scaleByPowerOfTen,
} = require('./shared');

// Below 1e-8 of a unit, or within 1ppm of the live balance, a delta is dust:
// rebasing, staking accrual and display rounding drift with no record to
// import.
const ABSOLUTE_TOLERANCE = '0.00000001';
const RELATIVE_TOLERANCE_EXPONENT = 6;

// The account report's status vocabulary.
const STATUS = Object.freeze({
  CURRENT: 'current',
  MISMATCH: 'mismatch',
  STALE: 'stale',
  UNKNOWN: 'unknown',
});

// Explanations a reviewer can attach to a per-asset exception. Accepted
// parser defects and missing activity still block: the ledger is wrong.
const EXCEPTION_CATEGORY_DEFINITIONS = Object.freeze([
  Object.freeze({ value: 'opening_balance_gap', label: 'Opening balance gap', blocking: false }),
  Object.freeze({ value: 'provider_migration', label: 'Provider migration', blocking: false }),
  Object.freeze({ value: 'rounding_dust', label: 'Rounding dust', blocking: false }),
  Object.freeze({ value: 'parser_defect', label: 'Parser defect', blocking: true }),
  Object.freeze({ value: 'missing_activity', label: 'Missing activity', blocking: true }),
]);
const EXCEPTION_CATEGORIES = new Set(EXCEPTION_CATEGORY_DEFINITIONS.map((entry) => entry.value));
const BLOCKING_CATEGORIES = new Set(EXCEPTION_CATEGORY_DEFINITIONS
  .filter((entry) => entry.blocking).map((entry) => entry.value));
const NON_BLOCKING_CATEGORIES = new Set(EXCEPTION_CATEGORY_DEFINITIONS
  .filter((entry) => !entry.blocking).map((entry) => entry.value));

// Within the dust band: at or under the absolute floor, or within 1ppm of live.
function withinDustBand(magnitude, live) {
  if (compareAmounts(magnitude, ABSOLUTE_TOLERANCE) <= 0) return true;
  return compareAmounts(scaleByPowerOfTen(magnitude, RELATIVE_TOLERANCE_EXPONENT), absAmount(live) || '0') <= 0;
}

// A nonzero delta inside the dust band.
function isDust(delta, live) {
  const magnitude = absAmount(delta) || '0';
  if (compareAmounts(magnitude, '0') === 0) return false;
  return withinDustBand(magnitude, live);
}

// Per-asset verdict: match (exactly equal), dust, or mismatch.
function classify(derived, live) {
  const delta = subtractAmounts(derived ?? '0', live ?? '0');
  if (compareAmounts(delta, '0') === 0) return { status: 'match', delta };
  return { status: isDust(delta, live) ? 'dust' : 'mismatch', delta };
}

// An open exception blocks; an accepted one blocks only if its category does.
function isBlocking(exception) {
  if (exception.status === 'open') return true;
  return exception.status === 'accepted' && BLOCKING_CATEGORIES.has(exception.category);
}

module.exports = {
  ABSOLUTE_TOLERANCE,
  RELATIVE_TOLERANCE_EXPONENT,
  STATUS,
  EXCEPTION_CATEGORY_DEFINITIONS,
  EXCEPTION_CATEGORIES,
  BLOCKING_CATEGORIES,
  NON_BLOCKING_CATEGORIES,
  withinDustBand,
  isDust,
  classify,
  isBlocking,
};

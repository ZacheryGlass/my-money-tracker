'use strict';

const ExchangeAccount = require('../models/ExchangeAccount');
const ExchangeRecord = require('../models/ExchangeRecord');
const {
  absAmount, subtractAmounts, compareAmounts, scaleByPowerOfTen,
} = require('./exchangeImport/shared');

const ABSOLUTE_TOLERANCE = '0.00000001';
const RELATIVE_TOLERANCE_EXPONENT = 6;
const MAX_REPORTED_MISMATCHES = 25;
const FRESHNESS_MS = 24 * 60 * 60 * 1000;

const STATUS = Object.freeze({
  CURRENT: 'current',
  MISMATCH: 'mismatch',
  STALE: 'stale',
  UNKNOWN: 'unknown',
});

function iso(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function isSameInstant(left, right) {
  return Boolean(left && right && new Date(left).getTime() === new Date(right).getTime());
}

function snapshotInvalidReason(snapshot, account) {
  if (!snapshot) return 'no_complete_snapshot';
  if (snapshot.complete !== true || !snapshot.balances
    || typeof snapshot.balances !== 'object' || Array.isArray(snapshot.balances)) return 'snapshot_incomplete';
  if (!snapshot.provider || !account?.exchange) return 'snapshot_provider_missing';
  if (snapshot.provider !== account.exchange) return 'provider_changed';
  const currentGeneration = iso(account?.credentials_updated_at);
  const snapshotGeneration = iso(snapshot.credential_generation);
  if (currentGeneration && !snapshotGeneration) return 'credential_generation_missing';
  if (currentGeneration && !isSameInstant(currentGeneration, snapshotGeneration)) {
    return 'credential_generation_changed';
  }
  if (!iso(snapshot.observed_at)) return 'missing_observed_at';
  return null;
}

function completeSnapshot(snapshot, account) {
  return snapshotInvalidReason(snapshot, account) === null;
}

/**
 * Compare exact decimal-string balances. This is kept byte-compatible with
 * the former ExchangeSyncService.reconcile export so existing callers and
 * tests do not need to know where the policy now lives.
 */
function reconcile(derived = {}, live = {}) {
  const assets = [...new Set([...Object.keys(derived), ...Object.keys(live)])].sort();
  const mismatches = [];

  for (const asset of assets) {
    const derivedAmount = derived[asset] ?? '0';
    const liveAmount = live[asset] ?? '0';
    const difference = subtractAmounts(derivedAmount, liveAmount);
    const magnitude = absAmount(difference) ?? '0';
    if (compareAmounts(magnitude, ABSOLUTE_TOLERANCE) <= 0) continue;
    const scaled = scaleByPowerOfTen(magnitude, RELATIVE_TOLERANCE_EXPONENT);
    if (compareAmounts(scaled, absAmount(liveAmount) ?? '0') <= 0) continue;
    mismatches.push({ asset, derived: derivedAmount, live: liveAmount, difference });
  }

  return {
    assets_checked: assets.length,
    mismatch_count: mismatches.length,
    mismatches: mismatches.slice(0, MAX_REPORTED_MISMATCHES),
    truncated: mismatches.length > MAX_REPORTED_MISMATCHES,
  };
}

function snapshotEnvelope(account, balances, observedAt) {
  return {
    provider: account.exchange,
    credential_generation: iso(account.credentials_updated_at),
    observed_at: iso(observedAt) || new Date().toISOString(),
    complete: true,
    balances: Object.fromEntries(Object.entries(balances || {}).map(([asset, amount]) => [asset, String(amount)])),
  };
}

function buildReconciliation({
  account,
  derived,
  snapshot,
  latestRecordAt,
  existingReport = null,
  backfillPending = false,
  balancesIncomplete = false,
  coverageLimitations = [],
  now = new Date(),
}) {
  const checkedAt = iso(now) || new Date().toISOString();
  const snapshotAt = iso(snapshot?.observed_at);
  const latestAt = iso(latestRecordAt);
  const usable = completeSnapshot(snapshot, account);
  const invalidReason = snapshotInvalidReason(snapshot, account);
  const staleReasons = [];
  const previousMismatches = Array.isArray(existingReport?.mismatches)
    ? existingReport.mismatches : [];
  const previousMismatchCount = Number.isInteger(existingReport?.mismatch_count)
    ? existingReport.mismatch_count : previousMismatches.length;

  if (!usable) {
    staleReasons.push(invalidReason || 'no_complete_snapshot');
    if (balancesIncomplete) staleReasons.push('balances_incomplete');
    const report = {
      checked_at: checkedAt,
      snapshot_at: snapshotAt,
      latest_record_at: latestAt,
      snapshot_predates_ledger: false,
      stale_reasons: staleReasons,
      assets_checked: 0,
      mismatch_count: 0,
      mismatches: [],
      truncated: false,
      mismatch_is_current: false,
      last_known_mismatch_count: previousMismatchCount,
      last_known_mismatches: previousMismatches,
      backfill_pending: Boolean(backfillPending),
      balances_incomplete: Boolean(balancesIncomplete),
      coverage_limitations: coverageLimitations,
      ...(balancesIncomplete ? { skipped: 'live_balances_incomplete' } : {}),
    };
    return { status: STATUS.UNKNOWN, report };
  }

  const comparison = reconcile(derived, snapshot.balances);
  const snapshotTime = new Date(snapshotAt).getTime();
  const nowTime = new Date(checkedAt).getTime();
  const latestTime = latestAt ? new Date(latestAt).getTime() : null;
  const snapshotExpired = nowTime - snapshotTime > FRESHNESS_MS;
  const snapshotPredatesLedger = latestTime !== null && latestTime > snapshotTime;

  if (snapshotExpired) staleReasons.push('snapshot_expired');
  if (snapshotPredatesLedger) staleReasons.push('snapshot_predates_ledger');
  if (backfillPending) staleReasons.push('backfill_pending');
  if (balancesIncomplete) staleReasons.push('balances_incomplete');
  if (coverageLimitations.length > 0) staleReasons.push('coverage_limited');

  const status = staleReasons.length > 0
    ? STATUS.STALE
    : (comparison.mismatch_count > 0 ? STATUS.MISMATCH : STATUS.CURRENT);
  return {
    status,
    report: {
      checked_at: checkedAt,
      snapshot_at: snapshotAt,
      latest_record_at: latestAt,
      snapshot_predates_ledger: snapshotPredatesLedger,
      stale_reasons: staleReasons,
      ...comparison,
      mismatch_is_current: status === STATUS.MISMATCH,
      last_known_mismatch_count: previousMismatchCount,
      last_known_mismatches: previousMismatches,
      backfill_pending: Boolean(backfillPending),
      balances_incomplete: Boolean(balancesIncomplete),
      coverage_limitations: coverageLimitations,
      ...(balancesIncomplete ? { skipped: 'live_balances_incomplete' } : {}),
    },
  };
}

class ExchangeReconciliationService {
  static get STATUS() { return STATUS; }
  static get FRESHNESS_MS() { return FRESHNESS_MS; }
  static reconcile(derived, live) { return reconcile(derived, live); }
  static snapshotEnvelope(account, balances, observedAt) {
    return snapshotEnvelope(account, balances, observedAt);
  }
  static buildReconciliation(options) { return buildReconciliation(options); }

  static async recomputeForAccount(userId, exchangeAccountId, { client = null, account = null } = {}) {
    if (!userId) throw new Error('ExchangeReconciliationService.recomputeForAccount requires a userId');
    const resolved = account || await ExchangeAccount.findForReconciliation(exchangeAccountId, userId, { client });
    if (!resolved || Number(resolved.user_id) !== Number(userId)) {
      const error = new Error('Exchange account not found');
      error.code = 'EXCHANGE_ACCOUNT_NOT_FOUND';
      throw error;
    }

    const { derived, latestRecordAt } = await ExchangeRecord.reconciliationInputs(
      exchangeAccountId, userId, { client }
    );
    const existing = resolved.balance_report || {};
    const state = buildReconciliation({
      account: resolved,
      derived,
      snapshot: resolved.provider_balance_snapshot,
      latestRecordAt,
      existingReport: existing,
      backfillPending: Boolean(existing.backfill_pending),
      balancesIncomplete: Boolean(existing.balances_incomplete),
      coverageLimitations: Array.isArray(existing.coverage_limitations)
        ? existing.coverage_limitations : [],
    });
    const saved = await ExchangeAccount.saveReconciliation(exchangeAccountId, userId, {
      status: state.status,
      report: state.report,
      client,
    });
    if (!saved) {
      const error = new Error('Exchange account not found');
      error.code = 'EXCHANGE_ACCOUNT_NOT_FOUND';
      throw error;
    }
    return { ...state, account: saved };
  }
}

module.exports = ExchangeReconciliationService;
module.exports.snapshotEnvelope = snapshotEnvelope;

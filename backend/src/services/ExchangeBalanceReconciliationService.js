'use strict';

const ExchangeBalanceReconciliation = require('../models/ExchangeBalanceReconciliation');
const pool = require('../config/database');
const {
  absAmount, addAmounts, compareAmounts, subtractAmounts, scaleByPowerOfTen,
} = require('./exchangeImport/shared');
const logger = require('../config/logger');

const ABSOLUTE_TOLERANCE = '0.00000001';
const RELATIVE_TOLERANCE_EXPONENT = 6;
const BLOCKING_CATEGORIES = new Set(['parser_defect', 'missing_activity']);
const NON_BLOCKING_CATEGORIES = new Set([
  'opening_balance_gap', 'provider_migration', 'rounding_dust',
]);

function sameJson(left, right) {
  const normalize = (value) => {
    if (Array.isArray(value)) return value.map(normalize);
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.keys(value).sort().map((key) => [key, normalize(value[key])]));
    }
    return value;
  };
  return JSON.stringify(normalize(left)) === JSON.stringify(normalize(right));
}

function isDust(delta, live) {
  const magnitude = absAmount(delta) || '0';
  if (compareAmounts(magnitude, '0') === 0) return false;
  if (compareAmounts(magnitude, ABSOLUTE_TOLERANCE) <= 0) return true;
  return compareAmounts(
    scaleByPowerOfTen(magnitude, RELATIVE_TOLERANCE_EXPONENT),
    absAmount(live) || '0'
  ) <= 0;
}

function classify(derived, live) {
  const delta = subtractAmounts(derived ?? '0', live ?? '0');
  if (compareAmounts(delta, '0') === 0) return { status: 'match', delta };
  return { status: isDust(delta, live) ? 'dust' : 'mismatch', delta };
}

function detailsForAsset(asset, live, balanceDetails = {}) {
  const detail = balanceDetails?.[asset] || {};
  const codes = Array.isArray(detail.provider_asset_codes)
    ? detail.provider_asset_codes.filter(Boolean).map(String)
    : [];
  const rawBalances = detail.provider_balances && typeof detail.provider_balances === 'object'
    ? detail.provider_balances
    : {};
  if (!codes.length && live !== undefined && live !== null) codes.push(asset);
  if (!Object.keys(rawBalances).length && live !== undefined && live !== null) rawBalances[asset] = live;
  return {
    provider_asset_codes: [...new Set(codes)].sort(),
    provider_balances: rawBalances,
  };
}

function snapshotsFor(derived, live, balanceDetails, calculatedAt) {
  const assets = [...new Set([
    ...Object.keys(derived || {}),
    ...Object.keys(live || {}),
    ...Object.keys(balanceDetails || {}),
  ])].sort();
  return assets.map((canonicalAsset) => {
    const derivedBalance = derived?.[canonicalAsset] ?? '0';
    const liveBalance = live?.[canonicalAsset] ?? '0';
    const result = classify(derivedBalance, liveBalance);
    const details = detailsForAsset(canonicalAsset, live?.[canonicalAsset], balanceDetails);
    return {
      canonical_asset: canonicalAsset,
      provider_asset_codes: details.provider_asset_codes,
      provider_balances: details.provider_balances,
      derived_balance: derivedBalance,
      live_balance: liveBalance,
      delta: result.delta,
      comparison_status: result.status,
      calculated_at: calculatedAt,
      adjusted_delta: result.delta,
    };
  });
}

function changedSnapshot(previous, snapshot) {
  if (!previous) return true;
  return previous.previous_derived_balance !== snapshot.derived_balance
    || previous.previous_live_balance !== snapshot.live_balance
    || previous.previous_delta !== snapshot.delta
    || !sameJson(previous.previous_provider_asset_codes, snapshot.provider_asset_codes)
    || !sameJson(previous.previous_provider_balances, snapshot.provider_balances);
}

function currentState(previous, snapshot) {
  const changed = changedSnapshot(previous, snapshot);
  if (!previous || changed) {
    return {
      status: 'open', category: null, evidence: null, adjustment: '0',
      reviewerId: null, reviewedAt: null,
    };
  }
  return {
    status: previous.status === 'accepted' ? 'accepted' : 'open',
    category: previous.category,
    evidence: previous.evidence,
    adjustment: previous.adjustment || '0',
    reviewerId: previous.reviewer_id,
    reviewedAt: previous.reviewed_at,
  };
}

function isBlocking(exception) {
  if (exception.status === 'open') return true;
  return exception.status === 'accepted' && BLOCKING_CATEGORIES.has(exception.category);
}

class ExchangeBalanceReconciliationService {
  static get CATEGORIES() { return ExchangeBalanceReconciliation.CATEGORIES; }

  static classify(derived, live) { return classify(derived, live); }

  static snapshotsFor(derived, live, balanceDetails, calculatedAt = new Date().toISOString()) {
    return snapshotsFor(derived, live, balanceDetails, calculatedAt);
  }

  static async auditAccount(exchangeAccountId, {
    syncJobId = null,
    derived = {},
    live = {},
    balanceDetails = {},
    backfillPending = false,
    balancesIncomplete = false,
    coverageLimitations = [],
    calculatedAt = new Date().toISOString(),
  } = {}) {
    const authoritative = !backfillPending && !balancesIncomplete && coverageLimitations.length === 0;
    const db = await pool.connect();
    let committed = false;
    try {
      await db.query('BEGIN');
      const run = await ExchangeBalanceReconciliation.createAuditRun(exchangeAccountId, {
        syncJobId,
        runStatus: authoritative ? 'authoritative' : 'coverage_limited',
        backfillPending,
        balancesIncomplete,
        coverageLimitations,
        calculatedAt,
      }, db);
      // The fake pools used by the pre-062 sync tests do not implement the new
      // tables. Treat an empty RETURNING row as unavailable there; a real
      // database always returns the inserted run and therefore never loses an
      // audit silently.
      if (!run) {
        await db.query('ROLLBACK');
        return { available: false, authoritative: false };
      }

      if (!authoritative) {
        await db.query('COMMIT');
        committed = true;
        return {
          available: true,
          authoritative: false,
          audit_id: run.id,
          run_status: run.run_status,
          report: null,
          exception_count: null,
          blocking_exception_count: null,
        };
      }

      const snapshots = snapshotsFor(derived, live, balanceDetails, calculatedAt);
      const seenAssets = new Set(snapshots.map((snapshot) => snapshot.canonical_asset));
      // Zero-valued assets usually disappear from both normalized maps. Keep
      // an explicit matching snapshot for an older exception so a complete
      // clean sync can clear it instead of leaving a stale queue row forever.
      const previousExceptions = await ExchangeBalanceReconciliation.findActiveForAccount(
        exchangeAccountId, db
      );
      for (const previous of previousExceptions) {
        if (seenAssets.has(previous.canonical_asset)) continue;
        snapshots.push({
          canonical_asset: previous.canonical_asset,
          provider_asset_codes: [],
          provider_balances: {},
          derived_balance: '0',
          live_balance: '0',
          delta: '0',
          comparison_status: 'match',
          calculated_at: calculatedAt,
          adjusted_delta: '0',
        });
      }
      snapshots.sort((left, right) => left.canonical_asset.localeCompare(right.canonical_asset));
      const exceptionRows = [];
      for (const snapshot of snapshots) {
        const storedSnapshot = await ExchangeBalanceReconciliation.insertSnapshot(
          run.id, exchangeAccountId, snapshot, db
        );
        if (!storedSnapshot) throw new Error('Exchange balance snapshot insert returned no row');
        const previous = await ExchangeBalanceReconciliation.findCurrentForUpdate(
          exchangeAccountId, snapshot.canonical_asset, db
        );
        const material = snapshot.comparison_status !== 'match';
        if (material) {
          const state = currentState(previous, snapshot);
          const adjustedSnapshot = {
            ...snapshot,
            adjusted_delta: addAmounts(snapshot.delta, state.adjustment || '0'),
          };
          const exception = await ExchangeBalanceReconciliation.createOrUpdateException(
            exchangeAccountId, storedSnapshot.id, adjustedSnapshot, state, db
          );
          if (exception) exceptionRows.push(exception);
        } else if (previous) {
          await ExchangeBalanceReconciliation.clearException(
            exchangeAccountId, snapshot.canonical_asset, storedSnapshot.id, db
          );
        }
      }

      // A material exception can disappear from the current asset union only
      // when the next complete live response and derived ledger both say zero;
      // the zero snapshot above has already cleared that asset. This query is
      // intentionally absent: no authoritative run should delete evidence.
      await db.query('COMMIT');
      committed = true;
      const blocking = exceptionRows.filter(isBlocking).length;
      const reconciled = exceptionRows.filter((row) => (
        row.status === 'accepted' && NON_BLOCKING_CATEGORIES.has(row.category)
      )).length;
      return {
        available: true,
        authoritative: true,
        audit_id: run.id,
        run_status: run.run_status,
        snapshots,
        exception_count: exceptionRows.length,
        blocking_exception_count: blocking,
        reconciled_exception_count: reconciled,
        report: {
          assets_checked: snapshots.length,
          mismatch_count: snapshots.filter((row) => row.comparison_status === 'mismatch').length,
          dust_count: snapshots.filter((row) => row.comparison_status === 'dust').length,
          checked_at: calculatedAt,
        },
      };
    } catch (error) {
      if (!committed) {
        try { await db.query('ROLLBACK'); } catch (rollbackError) { void rollbackError; }
      }
      if (error.code === '42P01' || error.code === '42703') {
        logger.warn({ err: error, exchangeAccountId }, 'Exchange balance audit tables are unavailable');
        return { available: false, authoritative: false };
      }
      throw error;
    } finally {
      db.release();
    }
  }
}

module.exports = ExchangeBalanceReconciliationService;

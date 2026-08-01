'use strict';

const pool = require('../config/database');

const CATEGORIES = new Set([
  'opening_balance_gap', 'provider_migration', 'rounding_dust',
  'parser_defect', 'missing_activity',
]);

function requireUserId(method, userId) {
  if (!userId) throw new Error(`ExchangeBalanceReconciliation.${method} requires a userId`);
}

function json(value, fallback) {
  return JSON.stringify(value === undefined || value === null ? fallback : value);
}

class ExchangeBalanceReconciliation {
  static get CATEGORIES() { return CATEGORIES; }

  static async createAuditRun(exchangeAccountId, {
    syncJobId = null,
    runStatus,
    backfillPending = false,
    balancesIncomplete = false,
    coverageLimitations = [],
    calculatedAt = null,
  }, db = pool) {
    const result = await db.query(
      `INSERT INTO exchange_balance_audit_runs (
         exchange_account_id, sync_job_id, run_status, backfill_pending,
         balances_incomplete, coverage_limitations, calculated_at
       ) VALUES ($1, $2, $3, $4, $5, $6::jsonb, COALESCE($7::timestamp, CURRENT_TIMESTAMP))
       RETURNING *`,
      [exchangeAccountId, syncJobId, runStatus, backfillPending, balancesIncomplete,
        json(coverageLimitations, []), calculatedAt]
    );
    return result.rows[0] || null;
  }

  static async insertSnapshot(auditRunId, exchangeAccountId, snapshot, db = pool) {
    const result = await db.query(
      `INSERT INTO exchange_balance_audit_snapshots (
         audit_run_id, exchange_account_id, canonical_asset, provider_asset_codes,
         provider_balances, derived_balance, live_balance, delta, comparison_status,
         calculated_at
       ) VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6, $7, $8, $9, $10::timestamp)
       RETURNING *`,
      [
        auditRunId, exchangeAccountId, snapshot.canonical_asset,
        json(snapshot.provider_asset_codes, []), json(snapshot.provider_balances, {}),
        snapshot.derived_balance, snapshot.live_balance, snapshot.delta,
        snapshot.comparison_status, snapshot.calculated_at,
      ]
    );
    return result.rows[0] || null;
  }

  static async findCurrentForUpdate(exchangeAccountId, canonicalAsset, db = pool) {
    const result = await db.query(
      `SELECT e.*, s.derived_balance AS previous_derived_balance,
              s.live_balance AS previous_live_balance, s.delta AS previous_delta,
              s.provider_asset_codes AS previous_provider_asset_codes,
              s.provider_balances AS previous_provider_balances
       FROM exchange_balance_exceptions e
       LEFT JOIN exchange_balance_audit_snapshots s ON s.id = e.current_snapshot_id
       WHERE e.exchange_account_id = $1 AND e.canonical_asset = $2
       FOR UPDATE OF e`,
      [exchangeAccountId, canonicalAsset]
    );
    return result.rows[0] || null;
  }

  static async findActiveForAccount(exchangeAccountId, db = pool) {
    const result = await db.query(
      `SELECT e.*, s.derived_balance AS previous_derived_balance,
              s.live_balance AS previous_live_balance, s.delta AS previous_delta,
              s.provider_asset_codes AS previous_provider_asset_codes,
              s.provider_balances AS previous_provider_balances
       FROM exchange_balance_exceptions e
       LEFT JOIN exchange_balance_audit_snapshots s ON s.id = e.current_snapshot_id
       WHERE e.exchange_account_id = $1 AND e.status IN ('open', 'accepted')
       FOR UPDATE OF e`,
      [exchangeAccountId]
    );
    return result.rows;
  }

  static async createOrUpdateException(exchangeAccountId, snapshotId, snapshot, {
    status = 'open',
    category = null,
    evidence = null,
    adjustment = '0',
    reviewerId = null,
    reviewedAt = null,
  } = {}, db = pool) {
    const result = await db.query(
      `INSERT INTO exchange_balance_exceptions (
         exchange_account_id, canonical_asset, current_snapshot_id, status,
         category, evidence, adjustment, adjusted_delta, reviewer_id,
         reviewed_at, resolved_at, version
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NULL, 1)
       ON CONFLICT (exchange_account_id, canonical_asset) DO UPDATE
       SET current_snapshot_id = EXCLUDED.current_snapshot_id,
           status = EXCLUDED.status,
           category = EXCLUDED.category,
           evidence = EXCLUDED.evidence,
           adjustment = EXCLUDED.adjustment,
           adjusted_delta = EXCLUDED.adjusted_delta,
           reviewer_id = EXCLUDED.reviewer_id,
           reviewed_at = EXCLUDED.reviewed_at,
           resolved_at = NULL,
           version = exchange_balance_exceptions.version + 1,
           updated_at = CURRENT_TIMESTAMP
       RETURNING *`,
      [
        exchangeAccountId, snapshot.canonical_asset, snapshotId, status,
        category, evidence, adjustment, snapshot.adjusted_delta ?? snapshot.delta,
        reviewerId, reviewedAt,
      ]
    );
    return result.rows[0] || null;
  }

  static async clearException(exchangeAccountId, canonicalAsset, snapshotId, db = pool) {
    const result = await db.query(
      `UPDATE exchange_balance_exceptions
       SET current_snapshot_id = $3,
           status = 'cleared',
           adjusted_delta = $4,
           resolved_at = CURRENT_TIMESTAMP,
           updated_at = CURRENT_TIMESTAMP,
           version = version + 1
       WHERE exchange_account_id = $1 AND canonical_asset = $2
         AND status IN ('open', 'accepted')
       RETURNING *`,
      [exchangeAccountId, canonicalAsset, snapshotId, '0']
    );
    return result.rows[0] || null;
  }

  static async findForUser(userId, {
    exchangeAccountId = null,
    status = null,
    limit = 50,
    offset = 0,
  } = {}) {
    requireUserId('findForUser', userId);
    const params = [userId];
    let where = 'WHERE ea.user_id = $1';
    if (exchangeAccountId !== null && exchangeAccountId !== undefined) {
      params.push(exchangeAccountId);
      where += ` AND e.exchange_account_id = $${params.length}`;
    }
    if (status) {
      params.push(status);
      where += ` AND e.status = $${params.length}`;
    } else {
      where += ` AND e.status IN ('open', 'accepted')`;
    }
    params.push(Math.min(Math.max(Number(limit) || 50, 1), 500));
    params.push(Math.max(Number(offset) || 0, 0));
    const result = await pool.query(
      `SELECT e.id, e.exchange_account_id, ea.name AS account_name, ea.exchange,
              e.canonical_asset, e.status, e.category, e.evidence,
              e.adjustment::text, e.adjusted_delta::text, e.reviewer_id,
              e.reviewed_at, e.resolved_at, e.version, e.created_at, e.updated_at,
              s.id AS snapshot_id, s.provider_asset_codes, s.provider_balances,
              s.derived_balance::text, s.live_balance::text, s.delta::text,
              s.comparison_status, s.calculated_at,
              COUNT(*) OVER()::int AS total_count
       FROM exchange_balance_exceptions e
       JOIN exchange_accounts ea ON ea.id = e.exchange_account_id
       LEFT JOIN exchange_balance_audit_snapshots s ON s.id = e.current_snapshot_id
       ${where}
       ORDER BY CASE e.status WHEN 'open' THEN 0 ELSE 1 END,
                e.updated_at DESC, e.id DESC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );
    const total = result.rows.length ? Number(result.rows[0].total_count) || 0 : 0;
    return {
      rows: result.rows.map((row) => {
        const copy = { ...row };
        delete copy.total_count;
        return copy;
      }),
      total,
    };
  }

  static async summaryForUser(userId, { exchangeAccountId = null } = {}) {
    requireUserId('summaryForUser', userId);
    const params = [userId];
    let where = `WHERE ea.user_id = $1 AND e.status IN ('open', 'accepted')`;
    if (exchangeAccountId !== null && exchangeAccountId !== undefined) {
      params.push(exchangeAccountId);
      where += ` AND e.exchange_account_id = $${params.length}`;
    }
    const result = await pool.query(
      `SELECT COUNT(*)::int AS count,
              COUNT(*) FILTER (WHERE e.status = 'open')::int AS open_count,
              COUNT(*) FILTER (WHERE e.status = 'accepted')::int AS accepted_count,
              COUNT(*) FILTER (WHERE e.status = 'open'
                OR e.category IN ('parser_defect', 'missing_activity'))::int AS blocking_count,
              COUNT(*) FILTER (WHERE e.status = 'accepted'
                AND e.category IN ('opening_balance_gap', 'provider_migration', 'rounding_dust'))::int AS reconciled_count
       FROM exchange_balance_exceptions e
       JOIN exchange_accounts ea ON ea.id = e.exchange_account_id
       ${where}`,
      params
    );
    const row = result.rows[0] || {};
    return {
      count: Number(row.count) || 0,
      open: Number(row.open_count) || 0,
      accepted: Number(row.accepted_count) || 0,
      blocking: Number(row.blocking_count) || 0,
      reconciled: Number(row.reconciled_count) || 0,
    };
  }

  static async findByIdForUser(userId, exceptionId) {
    requireUserId('findByIdForUser', userId);
    const result = await pool.query(
      `SELECT e.id, e.exchange_account_id, ea.name AS account_name, ea.exchange,
              e.canonical_asset, e.status, e.category, e.evidence,
              e.adjustment::text, e.adjusted_delta::text, e.reviewer_id,
              e.reviewed_at, e.resolved_at, e.version, e.created_at, e.updated_at,
              s.id AS snapshot_id, s.provider_asset_codes, s.provider_balances,
              s.derived_balance::text, s.live_balance::text, s.delta::text,
              s.comparison_status, s.calculated_at
       FROM exchange_balance_exceptions e
       JOIN exchange_accounts ea ON ea.id = e.exchange_account_id
       LEFT JOIN exchange_balance_audit_snapshots s ON s.id = e.current_snapshot_id
       WHERE e.id = $1 AND ea.user_id = $2`,
      [exceptionId, userId]
    );
    return result.rows[0] || null;
  }

  static async updateForUser(userId, exceptionId, {
    version, status, category, evidence, adjustment,
  }) {
    requireUserId('updateForUser', userId);
    const result = await pool.query(
      `UPDATE exchange_balance_exceptions e
       SET status = $4,
           category = $5,
           evidence = $6,
           adjustment = $7,
           adjusted_delta = s.delta + $7,
           reviewer_id = $3,
           reviewed_at = CURRENT_TIMESTAMP,
           resolved_at = CASE WHEN $4 = 'open' THEN NULL ELSE e.resolved_at END,
           updated_at = CURRENT_TIMESTAMP,
           version = e.version + 1
       FROM exchange_accounts ea, exchange_balance_audit_snapshots s
       WHERE e.id = $1 AND ea.id = e.exchange_account_id AND ea.user_id = $2
         AND s.id = e.current_snapshot_id
         AND e.version = $8
       RETURNING e.id, e.exchange_account_id, e.canonical_asset, e.status,
                 e.category, e.evidence, e.adjustment::text, e.adjusted_delta::text,
                 e.reviewer_id, e.reviewed_at, e.resolved_at, e.version,
                 e.updated_at`,
      [exceptionId, userId, userId, status, category, evidence, adjustment, version]
    );
    if (result.rows[0]) return { row: result.rows[0], stale: false };
    const exists = await pool.query(
      `SELECT e.id, e.version
       FROM exchange_balance_exceptions e
       JOIN exchange_accounts ea ON ea.id = e.exchange_account_id
       WHERE e.id = $1 AND ea.user_id = $2`,
      [exceptionId, userId]
    );
    if (!exists.rows[0]) return { row: null, stale: false };
    return { row: null, stale: true, currentVersion: exists.rows[0].version };
  }

  static async accountAuditSummary(userId, accountIds) {
    requireUserId('accountAuditSummary', userId);
    if (!accountIds.length) return new Map();
    const result = await pool.query(
      `SELECT ea.id AS exchange_account_id,
              COUNT(e.id) FILTER (WHERE e.status IN ('open', 'accepted'))::int AS balance_exception_count,
              COUNT(e.id) FILTER (WHERE e.status = 'open'
                OR (e.status = 'accepted'
                  AND e.category IN ('parser_defect', 'missing_activity')))::int AS balance_blocking_count,
              MAX(r.calculated_at) FILTER (WHERE r.run_status = 'authoritative') AS balance_audited_at,
              (SELECT ar.run_status FROM exchange_balance_audit_runs ar
               WHERE ar.exchange_account_id = ea.id
               ORDER BY ar.calculated_at DESC, ar.id DESC LIMIT 1) AS balance_audit_status
       FROM exchange_accounts ea
       LEFT JOIN exchange_balance_exceptions e ON e.exchange_account_id = ea.id
       LEFT JOIN exchange_balance_audit_runs r ON r.exchange_account_id = ea.id
       WHERE ea.user_id = $1 AND ea.id = ANY($2::int[])
       GROUP BY ea.id`,
      [userId, accountIds]
    );
    return new Map(result.rows.map((row) => [row.exchange_account_id, row]));
  }

  // Review decisions are immediate: once the user accepts a non-blocking
  // explanation, the account badge should not remain red until the next API
  // sync. A coverage-limited latest run deliberately prevents this refresh;
  // an old authoritative comparison must not be relabeled as current.
  static async refreshAccountStatusForUser(userId, exchangeAccountId) {
    requireUserId('refreshAccountStatusForUser', userId);
    const latest = await pool.query(
      `SELECT ea.last_sync_status,
              (SELECT ar.run_status FROM exchange_balance_audit_runs ar
               WHERE ar.exchange_account_id = ea.id
               ORDER BY ar.calculated_at DESC, ar.id DESC LIMIT 1) AS audit_status
       FROM exchange_accounts ea
       WHERE ea.id = $1 AND ea.user_id = $2`,
      [exchangeAccountId, userId]
    );
    const account = latest.rows[0];
    if (!account || account.audit_status !== 'authoritative') return null;
    const summary = await this.summaryForUser(userId, { exchangeAccountId });
    const status = summary.blocking > 0
      ? 'balance_mismatch'
      : (summary.count > 0 ? 'reconciled_with_exceptions' : 'ok');
    const result = await pool.query(
      `UPDATE exchange_accounts
       SET last_sync_status = $3, updated_at = CURRENT_TIMESTAMP
       WHERE id = $1 AND user_id = $2
       RETURNING id, last_sync_status`,
      [exchangeAccountId, userId, status]
    );
    return result.rows[0] || null;
  }
}

module.exports = ExchangeBalanceReconciliation;

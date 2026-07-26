'use strict';

const pool = require('../config/database');

// The stored verdict of the on-chain balance audit (#62): one row per
// (wallet, chain, asset), rewritten by every sync that manages to check it.
//
// Scope note: this is a CHILD table, exactly like eth_transfers and
// eth_wallet_chains. Ownership lives on eth_wallets, so the writers take a
// walletId whose ownership the caller has already established, and every READ
// that can reach a response joins eth_wallets and filters on user_id -- a feed
// keyed on a wallet id alone would serve another user's audit to anyone who
// could guess an id.
//
// Statuses are ordered by how much they demand of the reader, and that order is
// single-sourced here because three callers sort by it (the detail feed, the
// per-wallet summary embedded in the wallets API, and data-health).
const STATUS_RANK = `CASE r.status
  WHEN 'mismatch' THEN 0
  WHEN 'unavailable' THEN 1
  WHEN 'skipped' THEN 2
  WHEN 'dust' THEN 3
  ELSE 4 END`;

// Native drift outranks token drift at equal status: a nonzero ETH delta is a
// hard signal of a missed movement, while a token's has benign explanations
// (rebasing, fee-on-transfer). See the issue and EthReconciliationService.
const ASSET_RANK = "CASE r.asset_type WHEN 'native' THEN 0 ELSE 1 END";

// Rows for tokens the user has since ignored are filtered out of every read
// rather than deleted on ignore. Ignoring a token is a display decision that
// takes effect immediately everywhere else (holdings, the mirror, the triage
// queue), and the audit must not be the one surface that keeps arguing about a
// spam contract until the next nightly sync happens to prune it.
const NOT_IGNORED = `NOT EXISTS (
  SELECT 1 FROM eth_ignored_tokens it
  WHERE it.user_id = w.user_id AND it.contract_address = r.asset_key
)`;

class EthReconciliation {
  // Replaces this run's verdicts. One statement per asset: the set is small
  // (one native row plus the tokens the wallet actually holds on that chain),
  // and a multi-row upsert would have to reconcile conflicting rows within a
  // single statement -- which Postgres refuses outright when two rows share the
  // conflict target.
  static async upsert(walletId, row) {
    const result = await pool.query(
      `INSERT INTO eth_reconciliation (
         wallet_id, chain_id, asset_key, asset_type, token_symbol, token_decimals,
         derived_units, live_units, delta_units, status, skip_reason, checked_at, updated_at
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
       ON CONFLICT (wallet_id, chain_id, asset_key) DO UPDATE
         SET asset_type = EXCLUDED.asset_type,
             token_symbol = EXCLUDED.token_symbol,
             token_decimals = EXCLUDED.token_decimals,
             derived_units = EXCLUDED.derived_units,
             -- Unconditional, including back to NULL. A run that could not read
             -- the live figure must not leave last night's number sitting beside
             -- tonight's derived one: the pair would be compared by eye and the
             -- stale half would read as current.
             live_units = EXCLUDED.live_units,
             delta_units = EXCLUDED.delta_units,
             status = EXCLUDED.status,
             skip_reason = EXCLUDED.skip_reason,
             checked_at = CURRENT_TIMESTAMP,
             updated_at = CURRENT_TIMESTAMP
       RETURNING *`,
      [
        walletId, row.chain_id, row.asset_key, row.asset_type,
        row.token_symbol ?? null, row.token_decimals ?? null,
        row.derived_units ?? null, row.live_units ?? null, row.delta_units ?? null,
        row.status, row.skip_reason ?? null,
      ]
    );
    return result.rows[0];
  }

  // Drops verdicts for assets this run no longer tracks -- a token sold to zero,
  // or one added to the ignore list.
  //
  // Scoped to the chains the run actually walked, for the same reason
  // refreshHoldings' cleanup is: a chain switched off (or one whose feeds failed
  // this run) keeps its last verdict rather than having it silently deleted, so
  // "turning a chain off stops the audit" never reads as "the audit passed".
  // `keptKeys` are 'chainId:assetKey' pairs, not bare asset keys. The same
  // contract address routinely appears on several chains and is a different
  // asset on each (039), so a bare-key list would let a token still held on
  // mainnet protect a stale Arbitrum verdict for the same address from ever
  // being cleaned up.
  static async pruneMissing(walletId, chainIds, keptKeys) {
    if (!chainIds.length) return 0;
    const result = await pool.query(
      `DELETE FROM eth_reconciliation
       WHERE wallet_id = $1
         AND chain_id = ANY($2::int[])
         AND (chain_id::text || ':' || asset_key) <> ALL($3::text[])`,
      [walletId, chainIds, keptKeys]
    );
    return result.rowCount;
  }

  // The detail feed. Covers every wallet the user owns; walletId narrows within
  // that set and never widens it.
  static async findForUser(userId, { walletId = null, status = null, limit = 200, offset = 0 } = {}) {
    if (!userId) throw new Error('EthReconciliation.findForUser requires a userId');
    const params = [userId];
    let where = `WHERE w.user_id = $1 AND ${NOT_IGNORED}`;
    if (walletId != null) {
      params.push(walletId);
      where += ` AND r.wallet_id = $${params.length}`;
    }
    if (status != null) {
      params.push(status);
      where += ` AND r.status = $${params.length}`;
    }
    params.push(limit, offset);
    const result = await pool.query(
      `SELECT r.*, w.address AS wallet_address, COUNT(*) OVER() AS total_count
       FROM eth_reconciliation r
       JOIN eth_wallets w ON w.id = r.wallet_id
       ${where}
       ORDER BY ${STATUS_RANK}, ${ASSET_RANK}, r.chain_id, r.asset_key
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );
    const total = result.rows.length ? Number(result.rows[0].total_count) : 0;
    return {
      rows: result.rows.map((row) => {
        const rest = { ...row };
        delete rest.total_count;
        return rest;
      }),
      total,
    };
  }

  // Per-wallet counts for the wallets API, batched: the wallets route already
  // does one query for every wallet's chain rows, and a per-wallet summary query
  // inside its map would put the audit back on the N+1 path it avoids.
  //
  // native_mismatches is broken out because it, alone, is the wallet-level
  // needs-review signal. A token delta has benign causes; an ETH delta does not.
  static async summaryForWallets(userId, walletIds) {
    if (!userId) throw new Error('EthReconciliation.summaryForWallets requires a userId');
    if (!walletIds.length) return new Map();
    const result = await pool.query(
      `SELECT r.wallet_id,
              COUNT(*)::int AS assets_checked,
              (COUNT(*) FILTER (WHERE r.status = 'match'))::int AS matched,
              (COUNT(*) FILTER (WHERE r.status = 'dust'))::int AS dust,
              (COUNT(*) FILTER (WHERE r.status = 'mismatch'))::int AS mismatched,
              (COUNT(*) FILTER (WHERE r.status = 'mismatch' AND r.asset_type = 'native'))::int AS native_mismatches,
              (COUNT(*) FILTER (WHERE r.status = 'skipped'))::int AS skipped,
              (COUNT(*) FILTER (WHERE r.status = 'unavailable'))::int AS unavailable,
              MAX(r.checked_at) AS checked_at
       FROM eth_reconciliation r
       JOIN eth_wallets w ON w.id = r.wallet_id
       WHERE w.user_id = $1 AND r.wallet_id = ANY($2::int[]) AND ${NOT_IGNORED}
       GROUP BY r.wallet_id`,
      [userId, walletIds]
    );
    return new Map(result.rows.map((row) => [row.wallet_id, row]));
  }

  // The rows worth showing beside a wallet, worst first and capped: an audit
  // that dumps 300 matched tokens into the wallets response is one nobody reads.
  // Matched and dust rows are omitted entirely -- their whole content is "fine",
  // which the counts already say.
  static async openIssuesForWallets(userId, walletIds, { perWallet = 12 } = {}) {
    if (!userId) throw new Error('EthReconciliation.openIssuesForWallets requires a userId');
    if (!walletIds.length) return new Map();
    const result = await pool.query(
      `SELECT * FROM (
         SELECT r.id, r.wallet_id, r.chain_id, r.asset_key, r.asset_type,
                r.token_symbol, r.token_decimals,
                r.derived_units::text AS derived_units,
                r.live_units::text AS live_units,
                r.delta_units::text AS delta_units,
                r.status, r.skip_reason, r.checked_at,
                ROW_NUMBER() OVER (
                  PARTITION BY r.wallet_id
                  ORDER BY ${STATUS_RANK}, ${ASSET_RANK}, r.chain_id, r.asset_key
                ) AS rank
         FROM eth_reconciliation r
         JOIN eth_wallets w ON w.id = r.wallet_id
         WHERE w.user_id = $1 AND r.wallet_id = ANY($2::int[])
           AND r.status IN ('mismatch', 'unavailable', 'skipped')
           AND ${NOT_IGNORED}
       ) ranked
       WHERE rank <= $3
       ORDER BY wallet_id, rank`,
      [userId, walletIds, perWallet]
    );
    const byWallet = new Map();
    for (const row of result.rows) {
      const list = byWallet.get(row.wallet_id) || [];
      const rest = { ...row };
      delete rest.rank;
      list.push(rest);
      byWallet.set(row.wallet_id, list);
    }
    return byWallet;
  }

  // Scalar counts for data-health, across every wallet the user owns.
  static async summaryForUser(userId) {
    if (!userId) throw new Error('EthReconciliation.summaryForUser requires a userId');
    const result = await pool.query(
      `SELECT (COUNT(*) FILTER (WHERE r.status = 'mismatch' AND r.asset_type = 'native'))::int AS native_mismatches,
              (COUNT(*) FILTER (WHERE r.status = 'mismatch' AND r.asset_type = 'token'))::int AS token_mismatches,
              (COUNT(*) FILTER (WHERE r.status IN ('skipped', 'unavailable')))::int AS unchecked,
              COUNT(*)::int AS assets_checked,
              MAX(r.checked_at) AS checked_at
       FROM eth_reconciliation r
       JOIN eth_wallets w ON w.id = r.wallet_id
       WHERE w.user_id = $1 AND ${NOT_IGNORED}`,
      [userId]
    );
    const row = result.rows[0] || {};
    return {
      nativeMismatches: Number(row.native_mismatches) || 0,
      tokenMismatches: Number(row.token_mismatches) || 0,
      unchecked: Number(row.unchecked) || 0,
      assetsChecked: Number(row.assets_checked) || 0,
      checkedAt: row.checked_at || null,
    };
  }

  // The rotation order for live-balance lookups when a wallet holds more tokens
  // than one sync's budget can check. Least-recently-checked first, so a large
  // token set is covered across successive syncs instead of the same head of the
  // list being re-checked nightly while the tail is never checked at all.
  // Never-checked assets have no row and sort first via the caller's default.
  static async lastCheckedByAsset(walletId) {
    const result = await pool.query(
      `SELECT chain_id, asset_key, checked_at
       FROM eth_reconciliation
       WHERE wallet_id = $1`,
      [walletId]
    );
    return new Map(result.rows.map((row) => [`${row.chain_id}:${row.asset_key}`, row.checked_at]));
  }
}

module.exports = EthReconciliation;

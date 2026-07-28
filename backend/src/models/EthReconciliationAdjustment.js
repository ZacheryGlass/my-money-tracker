'use strict';

const pool = require('../config/database');
const { toBigIntOrNull } = require('../utils/units');

// Documented audit-side corrections to the balance audit (048): signed base
// units, summed per (wallet, chain, asset) into the derived figure before the
// delta and status are decided. See the migration for why they exist and the
// scope they must never leave -- reconciliation only, never holdings, the
// mirror, activity, or Spending.
//
// Child table, exactly like eth_reconciliation: ownership lives on
// eth_wallets. The WRITERS here verify the wallet against the caller inside
// the statement (an unowned wallet inserts/deletes nothing, which the route
// turns into a 404 indistinguishable from a made-up id), and every READ that
// can reach a response joins eth_wallets and filters on user_id.
// `sumsForWallet` is the one wallet-keyed read, mirroring
// EthReconciliation.lastCheckedByAsset: it feeds the audit itself, whose
// caller has already established ownership.

class EthReconciliationAdjustment {
  // The audit's input: total adjustment per (chain, asset), as BigInt --
  // exact, like every base-unit figure in the audit. A row whose stored value
  // will not parse is skipped rather than read as zero... which cannot happen
  // through the writers below, but a guess here would silently reshape a
  // verdict.
  static async sumsForWallet(walletId) {
    const result = await pool.query(
      `SELECT chain_id, asset_key, SUM(amount_wei)::text AS total_units
       FROM eth_reconciliation_adjustments
       WHERE wallet_id = $1
       GROUP BY chain_id, asset_key`,
      [walletId]
    );
    const sums = new Map();
    for (const row of result.rows) {
      const total = toBigIntOrNull(row.total_units);
      if (total != null) sums.set(`${row.chain_id}:${row.asset_key}`, total);
    }
    return sums;
  }

  // Ownership is checked inside the INSERT: a foreign or vanished wallet
  // selects no source row, inserts nothing, and returns null for the route to
  // 404 -- the same fail-closed shape as every scoped mutation in the app.
  static async create(userId, { walletId, chainId, assetKey, amountWei, note }) {
    if (!userId) throw new Error('EthReconciliationAdjustment.create requires a userId');
    const result = await pool.query(
      `INSERT INTO eth_reconciliation_adjustments (wallet_id, chain_id, asset_key, amount_wei, note)
       SELECT w.id, $3, $4, $5, $6
       FROM eth_wallets w
       WHERE w.id = $1 AND w.user_id = $2
       RETURNING id, wallet_id, chain_id, asset_key, amount_wei::text, note, created_at`,
      [walletId, userId, chainId, assetKey, amountWei, note]
    );
    return result.rows[0] || null;
  }

  static async deleteForUser(userId, adjustmentId) {
    if (!userId) throw new Error('EthReconciliationAdjustment.deleteForUser requires a userId');
    const result = await pool.query(
      `DELETE FROM eth_reconciliation_adjustments a
       USING eth_wallets w
       WHERE a.id = $1 AND w.id = a.wallet_id AND w.user_id = $2
       RETURNING a.id, a.wallet_id, a.chain_id, a.asset_key, a.amount_wei::text, a.note, a.created_at`,
      [adjustmentId, userId]
    );
    return result.rows[0] || null;
  }

  // Every adjustment on the user's wallets, newest first; walletId narrows
  // within that set and never widens it. Feeds both the reconciliation route
  // (merged onto the verdict rows it explains) and, batched by the caller,
  // the wallets API -- adjustments are hand-entered and rare, so the full
  // list per wallet is a handful of rows, not a feed.
  static async findForUser(userId, { walletId = null } = {}) {
    if (!userId) throw new Error('EthReconciliationAdjustment.findForUser requires a userId');
    const params = [userId];
    let where = 'WHERE w.user_id = $1';
    if (walletId != null) {
      params.push(walletId);
      where += ` AND a.wallet_id = $${params.length}`;
    }
    const result = await pool.query(
      `SELECT a.id, a.wallet_id, a.chain_id, a.asset_key, a.amount_wei::text, a.note, a.created_at
       FROM eth_reconciliation_adjustments a
       JOIN eth_wallets w ON w.id = a.wallet_id
       ${where}
       ORDER BY a.created_at DESC, a.id DESC`,
      params
    );
    return result.rows;
  }
}

module.exports = EthReconciliationAdjustment;

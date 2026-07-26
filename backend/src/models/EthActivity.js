'use strict';

const pool = require('../config/database');
const { DEFAULT_CHAIN_ID } = require('../config/chains');

// Every read resolves the manual override over the derived verdict in ONE
// place. An override is the user's own explanation of a transaction, so it also
// clears needs_review and its reason -- the row has been reviewed, by hand, and
// leaving it in the queue would make the queue undrainable.
//
// The join is on the full key (wallet, chain, tx_hash), which both tables carry
// a UNIQUE index on, so it can never fan one activity row into two.
const RESOLVED_COLUMNS = `
    a.id, a.wallet_id, a.chain_id, a.tx_hash, a.block_number, a.block_time,
    COALESCE(o.category, a.category) AS category,
    a.category AS derived_category,
    o.category AS override_category,
    o.note AS override_note,
    (o.category IS NOT NULL) AS is_overridden,
    a.counterparty_address, a.counterparty_name,
    a.method_id, a.method_name,
    a.legs, a.fee_wei, a.confidence, a.classified_at,
    CASE WHEN o.category IS NOT NULL THEN FALSE ELSE a.needs_review END AS needs_review,
    CASE WHEN o.category IS NOT NULL THEN NULL ELSE a.review_reason END AS review_reason,
    w.address AS wallet_address,
    -- The cross-chain pairing (#59). A matched pair IS one movement of the
    -- user's own money, so each leg carries the other's coordinates and the
    -- fee the bridge took, and the two render as a single self-transfer.
    -- Both link columns are UNIQUE, so neither join can fan a row out.
    COALESCE(lo.id, li.id) AS bridge_link_id,
    COALESCE(lo.asset, li.asset) AS bridge_asset,
    COALESCE(lo.out_amount, li.out_amount) AS bridge_out_amount,
    COALESCE(lo.in_amount, li.in_amount) AS bridge_in_amount,
    COALESCE(lo.fee_amount, li.fee_amount) AS bridge_fee_amount,
    pair.chain_id AS bridge_counterpart_chain_id,
    pair.tx_hash AS bridge_counterpart_tx_hash,
    pair.category AS bridge_counterpart_category`;

const RESOLVED_FROM = `
    FROM eth_activity a
    JOIN eth_wallets w ON w.id = a.wallet_id
    LEFT JOIN eth_activity_overrides o
      ON o.wallet_id = a.wallet_id AND o.chain_id = a.chain_id AND o.tx_hash = a.tx_hash
    LEFT JOIN eth_activity_links lo ON lo.out_activity_id = a.id
    LEFT JOIN eth_activity_links li ON li.in_activity_id = a.id
    LEFT JOIN eth_activity pair ON pair.id = COALESCE(lo.in_activity_id, li.out_activity_id)`;

const INSERT_COLUMNS = [
  'wallet_id', 'chain_id', 'tx_hash', 'block_number', 'block_time', 'category',
  'counterparty_address', 'counterparty_name', 'method_id', 'method_name',
  'legs', 'fee_wei', 'needs_review', 'review_reason', 'confidence',
];

class EthActivity {
  // Delete-then-insert, like the ledger mirror. Scoped to eth_activity ONLY:
  // eth_activity_overrides is never touched here, which is what makes a manual
  // correction survive every resync and every relabel.
  static async replaceForWallet(walletId, rows) {
    await pool.query('DELETE FROM eth_activity WHERE wallet_id = $1', [walletId]);
    if (!rows.length) return 0;

    const CHUNK = 200;
    let inserted = 0;
    for (let start = 0; start < rows.length; start += CHUNK) {
      const chunk = rows.slice(start, start + CHUNK);
      const values = [];
      const placeholders = chunk.map((row, i) => {
        const base = i * INSERT_COLUMNS.length;
        values.push(
          walletId,
          row.chain_id ?? DEFAULT_CHAIN_ID,
          row.tx_hash,
          row.block_number,
          row.block_time,
          row.category,
          row.counterparty_address ?? null,
          row.counterparty_name ?? null,
          row.method_id ?? null,
          row.method_name ?? null,
          JSON.stringify(row.legs ?? []),
          row.fee_wei ?? '0',
          row.needs_review === true,
          row.review_reason ?? null,
          row.confidence || 'high'
        );
        // legs is the eleventh column and needs its jsonb cast.
        return `(${INSERT_COLUMNS.map((_, j) => (j === 10 ? `$${base + j + 1}::jsonb` : `$${base + j + 1}`)).join(', ')})`;
      });
      const result = await pool.query(
        `INSERT INTO eth_activity (${INSERT_COLUMNS.join(', ')})
         VALUES ${placeholders.join(', ')}
         ON CONFLICT (wallet_id, chain_id, tx_hash) DO NOTHING`,
        values
      );
      inserted += result.rowCount;
    }
    return inserted;
  }

  // The activity feed. Covers every wallet the user owns; walletId narrows
  // within that set and never widens it. Fail-closed: an unscoped read throws
  // rather than serving one user's chain history to another.
  static async findForUser(userId, { walletId = null, category = null, needsReview = null, limit = 100, offset = 0 } = {}) {
    if (!userId) throw new Error('EthActivity.findForUser requires a userId');
    const params = [userId];
    // Filters apply to the RESOLVED values, not the derived ones: a
    // transaction the user re-categorized has to answer to the category they
    // chose, and must not still show up under needs_review.
    let where = 'WHERE TRUE';
    if (walletId != null) {
      params.push(walletId);
      where += ` AND r.wallet_id = $${params.length}`;
    }
    if (category) {
      params.push(category);
      where += ` AND r.category = $${params.length}`;
    }
    if (needsReview !== null) {
      params.push(needsReview);
      where += ` AND r.needs_review = $${params.length}`;
    }
    params.push(limit, offset);

    const result = await pool.query(
      `WITH resolved AS (
         SELECT ${RESOLVED_COLUMNS}
         ${RESOLVED_FROM}
         WHERE w.user_id = $1
       )
       SELECT r.*, COUNT(*) OVER() AS total_count
       FROM resolved r
       ${where}
       -- block_number is a PER-CHAIN sequence since 039, so time is the only
       -- order that interleaves a multi-chain feed correctly. tx_hash then id
       -- close the ordering -- none of the leading keys is unique in a merged
       -- feed (two of the user's own wallets both see an A->B self-send, same
       -- time, same hash), and a non-total ORDER BY lets LIMIT/OFFSET repeat
       -- one row on page 2 and drop the other entirely.
       ORDER BY r.block_time DESC, r.block_number DESC, r.tx_hash DESC, r.id DESC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );

    const total = result.rows.length ? Number(result.rows[0].total_count) : 0;
    return {
      activity: result.rows.map((row) => {
        const rest = { ...row };
        delete rest.total_count;
        return rest;
      }),
      total,
    };
  }

  // Scalar counts for the "no transaction unexplained" badge (#63 renders it).
  static async summaryForUser(userId) {
    if (!userId) throw new Error('EthActivity.summaryForUser requires a userId');
    const result = await pool.query(
      `SELECT COUNT(*)::int AS total,
              (COUNT(*) FILTER (WHERE needs_review))::int AS needs_review_count
       FROM (SELECT ${RESOLVED_COLUMNS} ${RESOLVED_FROM} WHERE w.user_id = $1) resolved`,
      [userId]
    );
    const row = result.rows[0] || {};
    return { total: Number(row.total) || 0, needsReviewCount: Number(row.needs_review_count) || 0 };
  }

  // Does the user own an activity row for this exact key? An override that
  // targets nothing is invisible forever -- every reader joins activity ->
  // override, so a correction written against a hash this wallet never saw is
  // stored and never rendered. Fail-closed like every other scoped read.
  static async overrideTargetExists(userId, walletId, txHash, { chainId = DEFAULT_CHAIN_ID } = {}) {
    if (!userId) throw new Error('EthActivity.overrideTargetExists requires a userId');
    const result = await pool.query(
      `SELECT 1 FROM eth_activity a
       JOIN eth_wallets w ON w.id = a.wallet_id
       WHERE a.wallet_id = $1 AND a.chain_id = $2 AND a.tx_hash = $3 AND w.user_id = $4
       LIMIT 1`,
      [walletId, chainId, txHash, userId]
    );
    return result.rows.length > 0;
  }

  // The wallet join IS the ownership check: a foreign wallet id selects no row,
  // so the INSERT writes nothing and the caller gets null. The route checks
  // ownership too -- this is the half that holds if anything ever calls the
  // model directly.
  static async upsertOverride(userId, walletId, txHash, { category, note = null, chainId = DEFAULT_CHAIN_ID } = {}) {
    if (!userId) throw new Error('EthActivity.upsertOverride requires a userId');
    const result = await pool.query(
      `INSERT INTO eth_activity_overrides (wallet_id, chain_id, tx_hash, category, note)
       SELECT w.id, $2, $3, $4, $5
       FROM eth_wallets w
       WHERE w.id = $1 AND w.user_id = $6
       ON CONFLICT (wallet_id, chain_id, tx_hash)
       DO UPDATE SET category = EXCLUDED.category,
                     note = EXCLUDED.note,
                     updated_at = CURRENT_TIMESTAMP
       RETURNING *`,
      [walletId, chainId, txHash, category, note, userId]
    );
    return result.rows[0] || null;
  }

  // A correction the user regrets has to be undoable, or the override is the
  // one-way door the derived table was designed not to be. Deleting it simply
  // uncovers the derived verdict again.
  static async deleteOverride(userId, walletId, txHash, { chainId = DEFAULT_CHAIN_ID } = {}) {
    if (!userId) throw new Error('EthActivity.deleteOverride requires a userId');
    const result = await pool.query(
      `DELETE FROM eth_activity_overrides o
       USING eth_wallets w
       WHERE o.wallet_id = w.id
         AND w.user_id = $4
         AND o.wallet_id = $1
         AND o.chain_id = $2
         AND o.tx_hash = $3
       RETURNING o.*`,
      [walletId, chainId, txHash, userId]
    );
    return result.rows[0] || null;
  }
}

module.exports = EthActivity;
module.exports.DEFAULT_CHAIN_ID = DEFAULT_CHAIN_ID;

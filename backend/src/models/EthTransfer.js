'use strict';

const pool = require('../config/database');

// One row per distinct address the user has transacted with that carries NO
// label row of any kind -- the triage queue's population. Shared verbatim by
// the paginated list and the badge summary so the two can never disagree about
// what "unreviewed" or "material" means.
//
// Params: $1 userId, $2 minUsd.
//
// USD comes from the mirrored ledger row rather than being recomputed from
// value_wei. Two reasons: token prices are fetched from CoinGecko at mirror
// rebuild time and never persisted, so SQL *cannot* recompute them; and
// sourcing from `transactions` guarantees the queue's dollar figure equals the
// number the user sees in the ledger, which is the whole point of triage.
// transactions.eth_transfer_id carries a UNIQUE partial index, so the LEFT
// JOIN can never fan a transfer out into two rows.
const UNREVIEWED_COUNTERPARTIES_CTE = `
  WITH legs AS (
    SELECT
      CASE WHEN t.from_address = w.address THEN t.to_address ELSE t.from_address END AS counterparty,
      t.id, t.tx_hash, t.block_time, t.token_symbol, t.token_contract,
      w.address AS wallet_address,
      (t.from_address = w.address) AS outgoing,
      tx.amount
    FROM eth_transfers t
    JOIN eth_wallets w ON w.id = t.wallet_id
    LEFT JOIN transactions tx ON tx.eth_transfer_id = t.id
    WHERE w.user_id = $1
      -- A gas row's "counterparty" is whatever contract was called, never a payee.
      AND t.transfer_type <> 'gas'
      -- Failed transfers moved no value and have no mirror row, so labeling
      -- them could not change any classification.
      AND t.is_error = FALSE
      AND t.counterparty_is_own = FALSE
      -- Contract creations have a NULL to_address.
      AND (CASE WHEN t.from_address = w.address THEN t.to_address ELSE t.from_address END) IS NOT NULL
      -- Ignored tokens produce no mirror row and the user has already declared
      -- them noise; reusing that signal is free spam suppression. The IS NULL
      -- arm keeps native/internal rows (NULL contract) out of the NOT IN.
      AND (t.token_contract IS NULL
           OR t.token_contract NOT IN (SELECT contract_address FROM eth_ignored_tokens WHERE user_id = $1))
  ),
  unlabeled AS (
    SELECT l.* FROM legs l
    WHERE NOT EXISTS (
      -- ANY kind counts as reviewed -- deliberately no kind predicate here.
      -- counterparty_exchange IS NULL is NOT a substitute: it also matches
      -- reviewed-external rows, so the queue would never drain.
      SELECT 1 FROM eth_address_labels lab
      WHERE lab.address = l.counterparty
        AND (lab.user_id = $1 OR lab.user_id IS NULL)
    )
  ),
  grouped AS (
    SELECT
      counterparty AS address,
      COUNT(*)::int AS transfer_count,
      (COUNT(*) FILTER (WHERE outgoing))::int AS sent_count,
      (COUNT(*) FILTER (WHERE NOT outgoing))::int AS received_count,
      COALESCE(SUM(ABS(amount)), 0)::float8 AS usd_volume,
      COALESCE(SUM(amount), 0)::float8 AS net_usd,
      MIN(block_time) AS first_seen,
      MAX(block_time) AS last_seen,
      ARRAY_AGG(DISTINCT wallet_address) AS wallet_addresses,
      ARRAY_AGG(DISTINCT token_symbol) FILTER (WHERE token_symbol IS NOT NULL) AS token_symbols,
      -- Non-null only when every transfer with this counterparty is the same
      -- token, which is what makes "ignore this token" a safe one-click action.
      (CASE WHEN COUNT(DISTINCT token_contract) = 1 AND COUNT(*) FILTER (WHERE token_contract IS NULL) = 0
            THEN MIN(token_contract) END) AS sole_token_contract,
      (ARRAY_AGG(tx_hash ORDER BY block_time DESC, id DESC))[1] AS last_tx_hash
    FROM unlabeled
    GROUP BY counterparty
  ),
  ranked AS (
    -- Materiality. You cannot receive a scam airdrop that you SENT, so any
    -- outbound transfer was a deliberate act and deserves a verdict regardless
    -- of dollar value (an unpriced token you genuinely own still needs one).
    -- Receive-only AND sub-threshold is the airdrop-spam signature.
    SELECT g.*, (g.usd_volume >= $2::float8 OR g.sent_count > 0) AS material
    FROM grouped g
  )
`;

class EthTransfer {
  // Sync resumes from an overlap block and re-inserts everything from there,
  // so each feed's stale rows must be cleared first to keep ordinals unique.
  static async deleteFromBlock(walletId, transferTypes, block) {
    await pool.query(
      `DELETE FROM eth_transfers
       WHERE wallet_id = $1 AND transfer_type = ANY($2) AND block_number >= $3`,
      [walletId, transferTypes, block]
    );
  }

  static async bulkInsert(rows) {
    if (!rows.length) return 0;
    const cols = [
      'wallet_id', 'tx_hash', 'ordinal', 'transfer_type', 'block_number',
      'block_time', 'from_address', 'to_address', 'value_wei',
      'token_contract', 'token_symbol', 'token_decimals', 'is_error',
    ];
    // Chunked to stay far under Postgres' 65535-parameter cap on first syncs
    // of busy wallets.
    const CHUNK = 500;
    let inserted = 0;
    for (let start = 0; start < rows.length; start += CHUNK) {
      const chunk = rows.slice(start, start + CHUNK);
      const values = [];
      const placeholders = chunk.map((row, i) => {
        const base = i * cols.length;
        values.push(
          row.wallet_id, row.tx_hash, row.ordinal, row.transfer_type,
          row.block_number, row.block_time, row.from_address, row.to_address,
          row.value_wei, row.token_contract, row.token_symbol,
          row.token_decimals, row.is_error
        );
        return `(${cols.map((_, j) => `$${base + j + 1}`).join(', ')})`;
      });
      const result = await pool.query(
        `INSERT INTO eth_transfers (${cols.join(', ')})
         VALUES ${placeholders.join(', ')}
         ON CONFLICT (wallet_id, transfer_type, tx_hash, ordinal) DO NOTHING`,
        values
      );
      inserted += result.rowCount;
    }
    return inserted;
  }

  static async findByWallet(walletId, { type, limit = 100, offset = 0 } = {}) {
    const params = [walletId];
    let where = 'WHERE t.wallet_id = $1';
    if (type === 'self') {
      where += " AND t.transfer_type <> 'gas' AND t.counterparty_is_own = TRUE";
    } else if (type === 'external') {
      where += " AND t.transfer_type <> 'gas' AND t.counterparty_is_own = FALSE AND t.counterparty_exchange IS NULL";
    } else if (type === 'exchange') {
      where += " AND t.transfer_type <> 'gas' AND t.counterparty_exchange IS NOT NULL";
    } else if (type === 'gas') {
      where += " AND t.transfer_type = 'gas'";
    } else if (type === 'token') {
      where += " AND t.transfer_type = 'token'";
    }
    params.push(limit, offset);
    const result = await pool.query(
      `SELECT t.*,
              COUNT(*) OVER() AS total_count
       FROM eth_transfers t
       ${where}
       ORDER BY t.block_number DESC, t.id DESC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );
    const total = result.rows.length ? Number(result.rows[0].total_count) : 0;
    return {
      transfers: result.rows.map((row) => {
        const rest = { ...row };
        delete rest.total_count;
        return rest;
      }),
      total,
    };
  }

  // Net token balance per contract from transfer deltas. Failed transfers
  // moved nothing, and gas rows never carry a token contract.
  static async tokenBalanceDeltas(walletId) {
    const result = await pool.query(
      `SELECT t.token_contract,
              MAX(t.token_symbol) AS token_symbol,
              MAX(t.token_decimals) AS token_decimals,
              SUM(CASE WHEN t.to_address = w.address THEN t.value_wei ELSE 0 END) -
              SUM(CASE WHEN t.from_address = w.address THEN t.value_wei ELSE 0 END) AS balance_units
       FROM eth_transfers t
       JOIN eth_wallets w ON w.id = t.wallet_id
       WHERE t.wallet_id = $1
         AND t.transfer_type = 'token'
         AND t.is_error = FALSE
         AND t.token_contract IS NOT NULL
         AND t.token_contract NOT IN (SELECT contract_address FROM eth_ignored_tokens WHERE user_id = w.user_id)
       GROUP BY t.token_contract`,
      [walletId]
    );
    return result.rows;
  }

  // The triage queue: counterparties the user has never given a verdict on.
  // Ordered by unclassified dollars first -- the biggest number is literally
  // the most misclassified money -- with a deterministic address tiebreak so
  // pagination is stable.
  static async unreviewedCounterparties(userId, { limit = 50, offset = 0, minUsd = 1, includeDust = false } = {}) {
    const result = await pool.query(
      `${UNREVIEWED_COUNTERPARTIES_CTE}
       SELECT r.*,
              (COUNT(*) OVER ())::int AS total_count,
              (SELECT COUNT(*) FROM ranked WHERE material)::int AS material_count,
              (SELECT COUNT(*) FROM ranked WHERE NOT material)::int AS dust_count,
              (SELECT COALESCE(SUM(usd_volume), 0) FROM ranked WHERE material)::float8 AS material_usd
       FROM ranked r
       WHERE $3::boolean OR r.material
       ORDER BY r.usd_volume DESC, r.transfer_count DESC, r.last_seen DESC, r.address ASC
       LIMIT $4 OFFSET $5`,
      [userId, minUsd, includeDust, limit, offset]
    );

    // The four aggregate columns repeat on every row; lift them out once and
    // strip them, the same way findByWallet handles total_count.
    const first = result.rows[0];
    const counterparties = result.rows.map((row) => {
      const rest = { ...row };
      delete rest.total_count;
      delete rest.material_count;
      delete rest.dust_count;
      delete rest.material_usd;
      return rest;
    });

    if (first) {
      return {
        counterparties,
        total: Number(first.total_count),
        materialCount: Number(first.material_count),
        dustCount: Number(first.dust_count),
        materialUsd: Number(first.material_usd),
      };
    }
    // Empty page: the window function produced no row to read counts off, so
    // the totals still have to come from a summary pass (offset past the end
    // must not report zero unreviewed counterparties).
    const summary = await this.unreviewedCounterpartySummary(userId, { minUsd });
    return { counterparties, total: summary.materialCount + (includeDust ? summary.dustCount : 0), ...summary };
  }

  // Scalar counts for the attention badge and data-health, without pagination.
  static async unreviewedCounterpartySummary(userId, { minUsd = 1 } = {}) {
    const result = await pool.query(
      `${UNREVIEWED_COUNTERPARTIES_CTE}
       SELECT (COUNT(*) FILTER (WHERE material))::int AS material_count,
              (COUNT(*) FILTER (WHERE NOT material))::int AS dust_count,
              COALESCE(SUM(usd_volume) FILTER (WHERE material), 0)::float8 AS material_usd
       FROM ranked`,
      [userId, minUsd]
    );
    const row = result.rows[0] || {};
    return {
      materialCount: Number(row.material_count) || 0,
      dustCount: Number(row.dust_count) || 0,
      materialUsd: Number(row.material_usd) || 0,
    };
  }

  // Counterparty classification depends on the wallet owner's wallet and
  // label sets, so it is recomputed wholesale on every sync, wallet
  // add/remove, and label change. Everything is scoped to the OWNER of the
  // transfer's wallet: user A's address must never classify as "own" on user
  // B's transfers, and labels apply per user (builtins, user_id NULL, apply
  // to everyone, with the user's own label winning). Two sequential
  // statements: own first, then exchange reading the fresh
  // counterparty_is_own so own-precedence is explicit. COALESCE guards NULL
  // to_address (contract creations): NULL IN (...) is NULL, which would
  // violate the NOT NULL column and abort the statement.
  //
  // The three label kinds hook into DIFFERENT statements. 'own' joins the own
  // set below; only 'exchange' reaches the second statement. 'external' is
  // deliberately inert in both -- it exists to record that an address was
  // reviewed (draining it from the triage queue) without changing any
  // classification.
  //
  // A userId restricts the rewrite to that owner's transfers. Classification
  // already only ever consults the wallet owner's own addresses and labels, so
  // scoping changes no result -- it just stops one user's wallet or label edit
  // from rewriting every other user's rows.
  static async reclassifyCounterparties(userId = null) {
    const params = userId == null ? [] : [userId];
    const ownerFilter = userId == null ? '' : ' AND w.user_id = $1';
    await pool.query(
      `UPDATE eth_transfers t SET counterparty_is_own =
         COALESCE(
           (CASE WHEN t.from_address = w.address THEN t.to_address ELSE t.from_address END)
             IN (
               SELECT w2.address FROM eth_wallets w2 WHERE w2.user_id = w.user_id
               UNION
               -- Own-labeled addresses the user chose NOT to track as wallets.
               -- Strictly user-scoped: no "OR l.user_id IS NULL" fallback here,
               -- because a global "this address is yours" row would be nonsense
               -- -- unlike the builtin exchange labels, which are global by design.
               SELECT l.address FROM eth_address_labels l
               WHERE l.user_id = w.user_id AND l.kind = 'own'
             ),
           FALSE
         )
       FROM eth_wallets w
       WHERE t.wallet_id = w.id${ownerFilter}`,
      params
    );
    await pool.query(
      `UPDATE eth_transfers t SET counterparty_exchange =
         CASE WHEN t.counterparty_is_own THEN NULL
              ELSE (
                -- Resolve the winning label row FIRST (a user row shadows a
                -- builtin via ORDER BY user_id NULLS LAST), THEN ask whether
                -- that winner is an exchange. Moving the kind test into the
                -- WHERE would filter a user's 'external' override out of the
                -- candidate set and let the builtin 'exchange' row resurface
                -- underneath it -- precisely the case this column exists to
                -- express, silently inverted.
                SELECT CASE WHEN l.kind = 'exchange' THEN l.name ELSE NULL END
                FROM eth_address_labels l
                WHERE l.address = CASE WHEN t.from_address = w.address
                                       THEN t.to_address ELSE t.from_address END
                  AND (l.user_id = w.user_id OR l.user_id IS NULL)
                ORDER BY l.user_id NULLS LAST
                LIMIT 1
              )
         END
       FROM eth_wallets w
       WHERE t.wallet_id = w.id${ownerFilter}`,
      params
    );
  }
}

module.exports = EthTransfer;

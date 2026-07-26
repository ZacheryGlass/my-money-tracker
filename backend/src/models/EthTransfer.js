'use strict';

const pool = require('../config/database');
const { DEFAULT_CHAIN_ID } = require('../config/chains');

// Dollar floor below which a receive-only counterparty is treated as dust.
// Single-sourced because three callers default it -- the route, the badge, and
// the data-health issue -- and if they disagreed the warning count and the
// badge would silently differ.
const DEFAULT_MIN_USD = 1;

// The transfer-type facets the activity feed offers. Expects `eth_transfers`
// aliased `t`. A 'gas' row's counterparty is whatever contract was called, so
// every counterparty-based facet excludes it.
const TRANSFER_TYPE_FILTERS = {
  self: "t.transfer_type <> 'gas' AND t.counterparty_is_own = TRUE",
  external: "t.transfer_type <> 'gas' AND t.counterparty_is_own = FALSE AND t.counterparty_exchange IS NULL",
  exchange: "t.transfer_type <> 'gas' AND t.counterparty_exchange IS NOT NULL",
  gas: "t.transfer_type = 'gas'",
  token: "t.transfer_type = 'token'",
};

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
      t.transfer_type,
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
      -- Mint (from = 0x0) and burn (to = 0x0). The zero address is the ABSENCE
      -- of a counterparty, not one awaiting a verdict, and no label on it could
      -- ever change a classification. Without this every NFT mint would enqueue
      -- it, and a burn -- being outbound, hence material -- would pin the badge
      -- above zero permanently on a row the user cannot meaningfully review.
      AND (CASE WHEN t.from_address = w.address THEN t.to_address ELSE t.from_address END)
          <> '0x0000000000000000000000000000000000000000'
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
      -- Outbound legs that COULD carry a dollar value. NFT legs never can:
      -- they get no mirror row, so their amount is always NULL and their
      -- usd_volume always 0. Feeding them to materiality below made every
      -- one-time NFT buyer permanently material at $0.00 -- a badge an active
      -- seller can never clear, and a badge that cannot reach zero gets
      -- ignored, which would also destroy its value for wallet sync errors.
      -- sent_count above stays the TRUE outbound count, because that is what
      -- the queue displays and hiding the NFT sends would be its own lie.
      (COUNT(*) FILTER (WHERE outgoing AND transfer_type NOT IN ('nft', 'nft1155')))::int AS sent_count_valued,
      COALESCE(SUM(ABS(amount)), 0)::float8 AS usd_volume,
      MIN(block_time) AS first_seen,
      MAX(block_time) AS last_seen,
      ARRAY_AGG(DISTINCT token_symbol) FILTER (WHERE token_symbol IS NOT NULL) AS token_symbols,
      -- Non-null only when every transfer with this counterparty is the same
      -- token. Note this says nothing about whether the user holds that token
      -- elsewhere, so ignoring it is NOT safe without confirmation -- the ignore
      -- list is user-global and drops the position from every wallet.
      (CASE WHEN COUNT(DISTINCT token_contract) = 1 AND COUNT(*) FILTER (WHERE token_contract IS NULL) = 0
            THEN MIN(token_contract) END) AS sole_token_contract
    FROM unlabeled
    GROUP BY counterparty
  ),
  ranked AS (
    -- Materiality. You cannot receive a scam airdrop that you SENT, so any
    -- outbound transfer was a deliberate act and deserves a verdict regardless
    -- of dollar value (an unpriced token you genuinely own still needs one).
    -- Receive-only AND sub-threshold is the airdrop-spam signature.
    --
    -- NFT sends are excluded from that OR arm (sent_count_valued, not
    -- sent_count): the arm exists to rescue an outbound transfer whose dollar
    -- value merely FAILED to resolve, and an NFT leg's never resolves at all,
    -- so it is a permanent pass rather than a rescue. An NFT-only counterparty
    -- is still enqueued, still labelable, and still reachable with
    -- include_dust=true -- it just does not pin the badge. The transaction
    -- itself is not lost either: eth_activity explains it as nft_sale/send.
    SELECT g.*, (g.usd_volume >= $2::float8 OR g.sent_count_valued > 0) AS material
    FROM grouped g
  )
`;

class EthTransfer {
  // Sync resumes from an overlap block and re-inserts everything from there,
  // so each feed's stale rows must be cleared first to keep ordinals unique.
  //
  // Scoped to ONE chain. Block numbers are per-chain sequences that overlap
  // heavily -- Arbitrum block 500 has nothing to do with mainnet block 500 --
  // so a delete without the chain predicate would wipe another chain's rows
  // from a block window it never synced, and the reorg overlap makes that
  // happen on every single sync.
  static async deleteFromBlock(walletId, chainId, transferTypes, block) {
    await pool.query(
      `DELETE FROM eth_transfers
       WHERE wallet_id = $1 AND chain_id = $2 AND transfer_type = ANY($3) AND block_number >= $4`,
      [walletId, chainId, transferTypes, block]
    );
  }

  static async bulkInsert(rows) {
    if (!rows.length) return 0;
    const cols = [
      'wallet_id', 'chain_id', 'tx_hash', 'ordinal', 'transfer_type', 'block_number',
      'block_time', 'from_address', 'to_address', 'value_wei',
      'token_contract', 'token_symbol', 'token_decimals', 'token_standard',
      'token_id', 'is_error', 'tx_is_error', 'method_id', 'method_name',
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
          // A row with no chain_id is mainnet's -- the column's own default, and
          // what every pre-#58 caller means. Explicit here rather than left to
          // the column default because a NULL would reach a NOT NULL column.
          row.wallet_id, row.chain_id ?? DEFAULT_CHAIN_ID, row.tx_hash, row.ordinal, row.transfer_type,
          row.block_number, row.block_time, row.from_address, row.to_address,
          row.value_wei, row.token_contract, row.token_symbol,
          row.token_decimals, row.token_standard ?? null, row.token_id ?? null,
          row.is_error, row.tx_is_error ?? null,
          row.method_id ?? null, row.method_name ?? null
        );
        return `(${cols.map((_, j) => `$${base + j + 1}`).join(', ')})`;
      });
      const result = await pool.query(
        `INSERT INTO eth_transfers (${cols.join(', ')})
         VALUES ${placeholders.join(', ')}
         ON CONFLICT (wallet_id, chain_id, transfer_type, tx_hash, ordinal) DO NOTHING`,
        values
      );
      inserted += result.rowCount;
    }
    return inserted;
  }

  // Selectors this wallet has stored but cannot yet name -- the decode pass's
  // work list. Derived from stored rows rather than from the batch the sync
  // just inserted, so a selector deferred by the lookup budget or stranded by a
  // provider outage is still pending on the next sync instead of lost.
  //
  // Ordered by how often the selector appears so that when the budget does
  // bite, the methods the user sees most get names first.
  static async pendingMethodSelectors(walletId) {
    const result = await pool.query(
      `SELECT method_id
       FROM eth_transfers
       WHERE wallet_id = $1 AND method_id IS NOT NULL AND method_name IS NULL
       GROUP BY method_id
       ORDER BY COUNT(*) DESC, method_id`,
      [walletId]
    );
    return result.rows.map((row) => row.method_id);
  }

  // Copies cached signatures onto the wallet's rows. `s.name IS NOT NULL` skips
  // cached misses: they stay NULL so the UI (method display lands with the
  // #63 ledger view) can fall back to the raw selector, and
  // they stay in the pending set above, which costs one indexed scan per sync
  // and zero network because the cache already answers for them.
  static async applyMethodNames(walletId) {
    const result = await pool.query(
      `UPDATE eth_transfers t
          -- The cache column is TEXT and this one is VARCHAR(200); clamp here
          -- so an over-long signature can never abort a whole sync's decode.
          SET method_name = LEFT(s.name, 200)
         FROM eth_method_signatures s
        WHERE t.wallet_id = $1
          AND t.method_id = s.selector
          AND t.method_name IS NULL
          AND s.name IS NOT NULL`,
      [walletId]
    );
    return result.rowCount;
  }

  // One feed, whether it covers every wallet the user owns or just one, so the
  // two can never disagree about what a transfer type means.
  //
  // Always joined to eth_wallets and filtered on user_id -- a feed keyed on a
  // wallet id alone would serve another user's transfers to anyone who could
  // guess an id. walletId narrows within the user's own set; it never widens.
  //
  // Rows carry their own wallet_address because a merged feed spans addresses,
  // and direction (did I send or receive?) is meaningless without knowing which
  // of the user's addresses the row belongs to.
  //
  // Ignored tokens are filtered here as well as in tokenBalanceDeltas and the
  // ledger mirror: the feed is where the Ignore button lives, so leaving them in
  // means the row the user just ignored survives the refetch and the button
  // reads as broken. Gas and ETH rows carry no contract and always pass.
  //
  // t.* carries method_id and method_name out for the Transactions tab (the
  // UI renders them with #63; nothing reads them client-side yet). Reads
  // only: decoding happens during sync, so serving this feed never touches a
  // signature service.
  static async findForUser(userId, { walletId = null, type, limit = 100, offset = 0 } = {}) {
    if (!userId) throw new Error('EthTransfer.findForUser requires a userId');
    const params = [userId];
    let where = `WHERE w.user_id = $1
       AND (t.token_contract IS NULL
            OR t.token_contract NOT IN (SELECT contract_address FROM eth_ignored_tokens WHERE user_id = $1))`;
    if (walletId != null) {
      params.push(walletId);
      where += ` AND t.wallet_id = $${params.length}`;
    }
    if (TRANSFER_TYPE_FILTERS[type]) {
      where += ` AND ${TRANSFER_TYPE_FILTERS[type]}`;
    }
    params.push(limit, offset);
    const result = await pool.query(
      `SELECT t.*,
              w.address AS wallet_address,
              COUNT(*) OVER() AS total_count
       FROM eth_transfers t
       JOIN eth_wallets w ON w.id = t.wallet_id
       ${where}
       -- block_number is a PER-CHAIN sequence since 039 (Arbitrum is hundreds
       -- of millions of blocks past mainnet), so time is the only order that
       -- interleaves a multi-chain feed correctly; block_number and id break
       -- ties deterministically so paging is stable.
       ORDER BY t.block_time DESC, t.block_number DESC, t.id DESC
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
  //
  // ERC-20 only, filtered two ways on purpose. NFT feeds land under their own
  // transfer_types, so transfer_type = 'token' already excludes them; the
  // token_standard test is the fail-closed half, because this is the one query
  // that turns a contract into a priced holding. An NFT reaching here would
  // mint a holding whose "quantity" is a token id count and send its symbol
  // toward valuation -- exactly the leak the NULL-ticker rule exists to stop.
  // Grouped by (chain, contract), not contract alone. The same contract ADDRESS
  // exists on several chains and is a different asset on each -- USDC on Base
  // and USDC on Arbitrum are separate balances at separate addresses, and even
  // an identical address (deterministic deployment) is a separate position.
  // Summing across chains would net one chain's outflow against another's
  // holdings and could produce a negative balance that silently drops a real
  // position. It also matters for pricing: each chain has its own CoinGecko
  // asset platform, so the contract must arrive with its chain attached.
  static async tokenBalanceDeltas(walletId) {
    const result = await pool.query(
      `SELECT t.chain_id,
              t.token_contract,
              MAX(t.token_symbol) AS token_symbol,
              MAX(t.token_decimals) AS token_decimals,
              SUM(CASE WHEN t.to_address = w.address THEN t.value_wei ELSE 0 END) -
              SUM(CASE WHEN t.from_address = w.address THEN t.value_wei ELSE 0 END) AS balance_units
       FROM eth_transfers t
       JOIN eth_wallets w ON w.id = t.wallet_id
       WHERE t.wallet_id = $1
         AND t.transfer_type = 'token'
         AND t.token_standard = 'erc20'
         AND t.is_error = FALSE
         AND t.token_contract IS NOT NULL
         AND t.token_contract NOT IN (SELECT contract_address FROM eth_ignored_tokens WHERE user_id = w.user_id)
       GROUP BY t.chain_id, t.token_contract
       ORDER BY t.chain_id, t.token_contract`,
      [walletId]
    );
    return result.rows;
  }

  // The triage queue: counterparties the user has never given a verdict on.
  //
  // material DESC leads the sort and is NOT redundant with usd_volume DESC: a
  // counterparty is material when it is above the dollar threshold OR the user
  // sent to it, so an outbound transfer of an unpriced token is material at
  // $0.00 and would otherwise sort beneath every airdrop worth a cent. With a
  // page limit that pushes it off the page entirely, leaving a badge counting
  // rows the user cannot see or act on -- and outbound transfers are the
  // highest-stakes rows in the queue. Then dollars, then a deterministic
  // address tiebreak so paging is stable.
  static async unreviewedCounterparties(userId, { limit = 50, offset = 0, minUsd = DEFAULT_MIN_USD, includeDust = false } = {}) {
    const result = await pool.query(
      `${UNREVIEWED_COUNTERPARTIES_CTE}
       SELECT r.*,
              (COUNT(*) OVER ())::int AS total_count,
              (SELECT COUNT(*) FROM ranked WHERE material)::int AS material_count,
              (SELECT COUNT(*) FROM ranked WHERE NOT material)::int AS dust_count,
              (SELECT COALESCE(SUM(usd_volume), 0) FROM ranked WHERE material)::float8 AS material_usd
       FROM ranked r
       WHERE $3::boolean OR r.material
       ORDER BY r.material DESC, r.usd_volume DESC, r.transfer_count DESC, r.last_seen DESC, r.address ASC
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
    // An empty FIRST page genuinely means zero, so answer without a second
    // pass -- a drained queue is the steady state and re-running the whole CTE
    // on every Settings load to learn "still zero" is pure waste. Only a page
    // past the end needs the summary, since the window function has no row to
    // read the totals off and must not report zero unreviewed counterparties.
    if (offset === 0) {
      return { counterparties, total: 0, materialCount: 0, dustCount: 0, materialUsd: 0 };
    }
    const summary = await this.unreviewedCounterpartySummary(userId, { minUsd });
    return { counterparties, total: summary.materialCount + (includeDust ? summary.dustCount : 0), ...summary };
  }

  // Scalar counts for the attention badge and data-health, without pagination.
  static async unreviewedCounterpartySummary(userId, { minUsd = DEFAULT_MIN_USD } = {}) {
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
// Exported so the route and the data-health check share one threshold.
module.exports.DEFAULT_MIN_USD = DEFAULT_MIN_USD;

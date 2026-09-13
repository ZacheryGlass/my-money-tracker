'use strict';

const pool = require('../config/database');
const chains = require('../config/chains');

// Source entries, not folded activity: both sides of an owned transfer must
// contribute, and gas must survive token/spam/category filters. Exchange signs
// and fees match ExchangeRecord.derivedBalances; wallet math matches
// EthTransfer.nativeBalanceDeltas. No audit-only adjustments enter this sum.
const SQL = `WITH wallet_scopes AS (
  SELECT w.id AS wallet_id, w.address, w.label, c.chain_id
  FROM eth_wallets w
  JOIN (
    SELECT wallet_id, chain_id FROM eth_wallet_chains
    UNION SELECT wallet_id, chain_id FROM eth_transfers
  ) c ON c.wallet_id = w.id
  WHERE w.user_id = $1 AND c.chain_id = ANY($2::int[])
    AND ($3::int IS NULL OR w.id = $3)
), scopes AS (
  SELECT 'wallet:' || w.wallet_id || ':' || w.chain_id AS scope,
    COALESCE(NULLIF(w.label, ''), w.address) AS name, w.chain_id,
    COALESCE((SELECT jsonb_agg(jsonb_build_object(
      'feed', f.feed, 'status', f.status, 'from_block', f.covered_from_block::text,
      'through_block', f.covered_through_block::text, 'error', f.error_message
    ) ORDER BY f.feed) FROM eth_feed_coverage f
      WHERE f.wallet_id = w.wallet_id AND f.chain_id = w.chain_id), '[]') AS coverage,
    (SELECT jsonb_build_object('status', r.status, 'checked_at', r.checked_at,
      'delta_wei', r.delta_units::text, 'reason', r.skip_reason)
      FROM eth_reconciliation r WHERE r.wallet_id = w.wallet_id
        AND r.chain_id = w.chain_id AND r.asset_type = 'native') AS audit,
    (SELECT COALESCE(SUM(a.amount_wei), 0)::text
      FROM eth_reconciliation_adjustments a WHERE a.wallet_id = w.wallet_id
        AND a.chain_id = w.chain_id AND a.asset_key = 'ETH') AS adjustment_wei
  FROM wallet_scopes w
  UNION ALL
  SELECT 'exchange:' || ea.id, ea.name, NULL::int, '[]'::jsonb, NULL::jsonb, '0'
  FROM exchange_accounts ea WHERE ea.user_id = $1 AND $3::int IS NULL
), entries AS (
  SELECT 'wallet:' || t.wallet_id || ':' || t.chain_id AS scope,
    'onchain:' || t.wallet_id || ':' || t.chain_id || ':' || t.tx_hash || ':' || t.transfer_type || ':' || t.ordinal AS id,
    t.block_time AS occurred_at, t.chain_id, t.block_number,
    t.tx_hash AS reference, t.ordinal::bigint AS entry_order,
    t.transfer_type AS kind, t.method_name AS description,
    t.from_address, t.to_address,
    CASE WHEN t.transfer_type = 'gas' THEN -t.value_wei
      WHEN t.is_error THEN 0
      ELSE (CASE WHEN t.to_address = w.address THEN t.value_wei ELSE 0 END)
         - (CASE WHEN t.from_address = w.address THEN t.value_wei ELSE 0 END)
    END AS delta,
    (t.is_error OR COALESCE(t.tx_is_error, false)) AS failed,
    false AS needs_review
  FROM eth_transfers t JOIN wallet_scopes w
    ON w.wallet_id = t.wallet_id AND w.chain_id = t.chain_id
  WHERE t.transfer_type IN ('native', 'internal', 'gas')
  UNION ALL
  SELECT 'exchange:' || ea.id, 'exchange:' || er.id || ':' || leg.part,
    er.occurred_at, NULL::int, NULL::bigint,
    COALESCE(er.tx_hash, er.external_id), leg.part::bigint,
    CASE WHEN leg.part = 3 THEN 'exchange_fee' ELSE er.record_type END,
    er.record_type, NULL::text, er.address,
    leg.amount * 1000000000000000000::numeric, false, er.needs_review
  FROM exchange_records er JOIN exchange_accounts ea ON ea.id = er.exchange_account_id
  CROSS JOIN LATERAL (VALUES
    (1, er.base_asset, er.base_amount),
    (2, er.quote_asset, er.quote_amount),
    (3, er.fee_asset, -er.fee_amount)
  ) leg(part, asset, amount)
  WHERE ea.user_id = $1 AND $3::int IS NULL AND leg.asset = 'ETH'
), selected AS (
  SELECT e.*, s.name FROM entries e JOIN scopes s USING (scope)
  WHERE $4::text IS NULL OR e.scope = $4
), running AS (
  SELECT *, ROW_NUMBER() OVER chronology AS sequence,
    CASE WHEN COUNT(*) FILTER (WHERE delta IS NULL) OVER chronology = 0
      THEN SUM(delta) OVER chronology END AS balance,
    CASE WHEN COUNT(*) FILTER (WHERE delta IS NULL) OVER account_chronology = 0
      THEN SUM(delta) OVER account_chronology END AS account_balance
  FROM selected
  WINDOW chronology AS (ORDER BY occurred_at, chain_id NULLS LAST,
      block_number NULLS LAST, reference, scope, entry_order, id ROWS UNBOUNDED PRECEDING),
    account_chronology AS (PARTITION BY scope ORDER BY occurred_at, chain_id NULLS LAST,
      block_number NULLS LAST, reference, scope, entry_order, id ROWS UNBOUNDED PRECEDING)
), page AS (
  SELECT id, scope, name, occurred_at, chain_id, reference, kind, description,
    from_address, to_address, failed, needs_review, sequence::text,
    delta::numeric(100,0)::text AS delta_wei,
    balance::numeric(100,0)::text AS balance_wei,
    account_balance::numeric(100,0)::text AS account_balance_wei
  FROM running ORDER BY running.sequence LIMIT $5 OFFSET $6
)
SELECT (SELECT COALESCE(jsonb_agg(p ORDER BY p.sequence::bigint), '[]') FROM page p) AS data,
  (SELECT COUNT(*)::int FROM selected) AS total,
  (SELECT CASE WHEN COUNT(*) FILTER (WHERE delta IS NULL) = 0
      THEN COALESCE(SUM(delta), 0)::numeric(100,0)::text END FROM selected) AS closing_balance_wei,
  (SELECT COUNT(*)::int FROM selected WHERE delta IS NULL) AS unknown_amounts,
  (SELECT COALESCE(jsonb_agg(s ORDER BY s.name, s.chain_id), '[]') FROM scopes s) AS scopes`;

class EthLedger {
  static async findForUser(userId, { walletId = null, scope = null, limit = 100, offset = 0 } = {}) {
    if (!userId) throw new Error('EthLedger.findForUser requires a userId');
    const ethChains = chains.allChains().filter((c) => c.nativeAsset === 'ETH').map((c) => c.id);
    const result = await pool.query(SQL, [userId, ethChains, walletId, scope, limit, offset]);
    const ledger = result.rows[0];
    for (const row of [...ledger.data, ...ledger.scopes]) {
      row.chain_name = row.chain_id ? chains.chainLabel(row.chain_id) : null;
    }
    return ledger;
  }
}

module.exports = EthLedger;

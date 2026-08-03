#!/usr/bin/env node

'use strict';

// Private, read-only evidence index for the non-exchange side of the EVM
// completion audit.  Detailed rows contain hashes, addresses and quantities,
// so they are written only to an explicit 0600 path; stdout is aggregate-only.

require('dotenv').config();
const fs = require('fs');
const pool = require('../src/config/database');

function option(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? null : process.argv[index + 1] || null;
}

function requiredPositiveInteger(name) {
  const parsed = Number(option(name));
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error(`${name} must be a positive integer`);
  return parsed;
}

function unpricedReason(row) {
  if (row.ignored) return 'user_ignored_asset';
  if (row.quarantined) return 'quarantined_spam_evidence';
  if (row.price_coverage_status) return `price_coverage_${row.price_coverage_status}`;
  if (['nft', 'nft1155'].includes(row.transfer_type)) return 'non_fungible_not_priceable_by_amount';
  if (row.transfer_type === 'token' && !row.token_contract) return 'malformed_or_missing_contract';
  if (!row.token_contract) return 'native_price_missing_for_date';
  if (!row.token_symbol || row.token_symbol.length > 32 || /[^\x20-\x7e]/.test(row.token_symbol)) {
    return 'malformed_or_missing_symbol';
  }
  return 'no_stored_contract_price_for_date';
}

function reviewBlocker(row) {
  if (row.override_note && !row.override_category) return 'note_preserves_review_without_verdict';
  if (row.label_kind === 'external') return 'counterparty_known_but_intent_not_proven';
  if (row.counterparty_name) return 'named_counterparty_without_category_evidence';
  if (row.method_id) return 'selector_is_display_only';
  return 'ownership_or_intent_decision_required';
}

async function buildReport(userId) {
  const reviewRows = (await pool.query(`
    SELECT a.id, a.wallet_id, a.chain_id, a.tx_hash, a.block_time,
           a.category, a.review_reason, a.confidence, a.counterparty_address,
           a.counterparty_name, a.method_id, a.method_name, a.legs,
           o.category AS override_category, o.note AS override_note,
           n.note AS address_note,
           l.kind AS label_kind, l.source AS label_source, l.confidence AS label_confidence
      FROM eth_activity a
      JOIN eth_wallets w ON w.id = a.wallet_id
      LEFT JOIN eth_activity_overrides o
        ON o.wallet_id = a.wallet_id AND o.chain_id = a.chain_id AND o.tx_hash = a.tx_hash
      LEFT JOIN eth_address_notes n
        ON n.user_id = w.user_id AND n.address = a.counterparty_address
      LEFT JOIN LATERAL (
        SELECT x.kind, x.source, x.confidence
          FROM eth_address_labels x
         WHERE x.address = a.counterparty_address
           AND (x.user_id = w.user_id OR x.user_id IS NULL)
         ORDER BY x.user_id NULLS LAST
         LIMIT 1
      ) l ON TRUE
     WHERE w.user_id = $1
       AND a.needs_review
       AND o.category IS NULL
       AND NOT COALESCE(o.spam, a.spam)
     ORDER BY a.block_time, a.id`, [userId])).rows;
  for (const row of reviewRows) row.durable_blocker = reviewBlocker(row);

  const bridgeRows = (await pool.query(`
    SELECT a.id, a.wallet_id, a.chain_id, a.tx_hash, a.block_time,
           COALESCE(o.category, a.category) AS category, a.review_reason,
           a.counterparty_address, a.counterparty_name, a.legs
      FROM eth_activity a
      JOIN eth_wallets w ON w.id = a.wallet_id
      LEFT JOIN eth_activity_overrides o
        ON o.wallet_id = a.wallet_id AND o.chain_id = a.chain_id AND o.tx_hash = a.tx_hash
     WHERE w.user_id = $1
       AND COALESCE(o.category, a.category) IN ('bridge_out', 'bridge_in')
       AND NOT EXISTS (
         SELECT 1
           FROM eth_activity_links l
           JOIN eth_activity other
             ON other.id = CASE WHEN l.out_activity_id = a.id
                                THEN l.in_activity_id ELSE l.out_activity_id END
           JOIN eth_wallets other_w ON other_w.id = other.wallet_id
          WHERE (l.out_activity_id = a.id OR l.in_activity_id = a.id)
            AND other_w.user_id = $1
       )
     ORDER BY a.block_time, a.id`, [userId])).rows;

  const reconciliation = (await pool.query(`
    SELECT r.wallet_id, r.chain_id, r.asset_key, r.status, r.derived_units,
           r.live_units, r.delta_units, r.skip_reason, r.checked_at,
           c.status AS feed_status, c.provider, c.error_code, c.error_message,
           c.covered_through_block, c.indexed_head
      FROM eth_reconciliation r
      JOIN eth_wallets w ON w.id = r.wallet_id
      LEFT JOIN eth_feed_coverage c
        ON c.wallet_id = r.wallet_id AND c.chain_id = r.chain_id AND c.feed = 'normal'
     WHERE w.user_id = $1 AND r.status <> 'match'
     ORDER BY r.status, r.wallet_id, r.chain_id, r.asset_key`, [userId])).rows;

  const unpriced = (await pool.query(`
    SELECT t.id, t.wallet_id, t.chain_id, t.tx_hash, t.block_time,
           t.transfer_type, t.token_contract, t.token_symbol, t.token_standard,
           t.token_id, t.value_wei, t.usd_basis,
           (i.contract_address IS NOT NULL) AS ignored,
           COALESCE(a.spam, FALSE) AS quarantined,
           p.status AS price_coverage_status, p.detail AS price_coverage_detail
      FROM eth_transfers t
      JOIN eth_wallets w ON w.id = t.wallet_id
      LEFT JOIN eth_ignored_tokens i
        ON i.user_id = w.user_id AND i.contract_address = t.token_contract
      LEFT JOIN eth_activity a
        ON a.wallet_id = t.wallet_id AND a.chain_id = t.chain_id AND a.tx_hash = t.tx_hash
      LEFT JOIN asset_price_coverage p
        ON p.asset_key = CASE
          WHEN t.token_contract IS NULL THEN UPPER(COALESCE(t.token_symbol, 'ETH'))
          ELSE 'erc20:' || t.chain_id::text || ':' || LOWER(t.token_contract)
        END
     WHERE w.user_id = $1 AND t.usd_basis = 'unpriced'
     ORDER BY t.block_time, t.id`, [userId])).rows;
  for (const row of unpriced) row.durable_reason = unpricedReason(row);

  const exchangeExceptions = (await pool.query(`
    SELECT e.id, e.exchange_account_id, ea.exchange, e.canonical_asset, e.status,
           e.category, e.evidence, e.adjustment, e.adjusted_delta,
           e.created_at, e.updated_at,
           s.provider_asset_codes, s.derived_balance, s.live_balance,
           s.delta, s.comparison_status, s.calculated_at
      FROM exchange_balance_exceptions e
      JOIN exchange_accounts ea ON ea.id = e.exchange_account_id
      LEFT JOIN exchange_balance_audit_snapshots s ON s.id = e.current_snapshot_id
     WHERE ea.user_id = $1 AND e.status <> 'cleared'
     ORDER BY ea.exchange, e.canonical_asset, e.id`, [userId])).rows;

  const duplicateCandidates = (await pool.query(`
    SELECT er.id, er.exchange_account_id, ea.exchange, er.external_id,
           er.occurred_at, er.record_type, er.base_asset, er.base_amount,
           er.quote_asset, er.quote_amount, er.fee_asset, er.fee_amount,
           er.tx_hash, er.address, er.source, er.fingerprint,
           er.needs_review, er.duplicate_candidate
      FROM exchange_records er
      JOIN exchange_accounts ea ON ea.id = er.exchange_account_id
     WHERE ea.user_id = $1 AND er.duplicate_candidate
     ORDER BY ea.exchange, er.fingerprint, er.occurred_at, er.id`, [userId])).rows;

  const by = (items, key) => items.reduce((out, row) => {
    const value = row[key] == null ? 'unknown' : String(row[key]);
    out[value] = (out[value] || 0) + 1;
    return out;
  }, {});

  return {
    generated_at: new Date().toISOString(),
    user_id: userId,
    read_only: true,
    policy: 'Evidence index only: no ownership/intent inference, review clearing, public price query, or destructive merge.',
    summary: {
      review_rows: reviewRows.length,
      review_by_blocker: by(reviewRows, 'durable_blocker'),
      unmatched_bridge_rows: bridgeRows.length,
      reconciliation_rows: reconciliation.length,
      reconciliation_by_status: by(reconciliation, 'status'),
      unpriced_rows: unpriced.length,
      unpriced_by_reason: by(unpriced, 'durable_reason'),
      open_exchange_exceptions: exchangeExceptions.length,
      duplicate_candidate_rows: duplicateCandidates.length,
    },
    review_rows: reviewRows,
    unmatched_bridge_rows: bridgeRows,
    reconciliation,
    unpriced,
    exchange_exceptions: exchangeExceptions,
    duplicate_candidates: duplicateCandidates,
  };
}

async function main() {
  const userId = requiredPositiveInteger('--user-id');
  const outputPath = option('--output');
  if (!outputPath) throw new Error('--output is required; detailed rows are private');
  const report = await buildReport(userId);
  fs.writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  fs.chmodSync(outputPath, 0o600);
  process.stdout.write(`${JSON.stringify(report.summary)}\n`);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`EVM history gap report failed: ${error.message}`);
    process.exitCode = 1;
  }).finally(() => pool.end().catch(() => {}));
}

module.exports = { buildReport, reviewBlocker, unpricedReason };

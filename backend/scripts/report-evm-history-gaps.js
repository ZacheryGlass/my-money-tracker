#!/usr/bin/env node

'use strict';

// Private, read-only evidence index for the non-exchange side of the EVM
// completion audit.  Detailed rows contain hashes, addresses and quantities,
// so they are written only to an explicit 0600 path; stdout is aggregate-only.

require('dotenv').config();
const fs = require('fs');
const pool = require('../src/config/database');

async function tableExists(tableName) {
  const { rows } = await pool.query('SELECT to_regclass($1) IS NOT NULL AS exists', [tableName]);
  return rows[0]?.exists === true;
}

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

  const bridgeEvidenceModelAvailable = await tableExists('eth_bridge_movements');
  let bridgeMovements = [];
  let bridgeSuggestions = [];
  let bridgeVerdicts = [];
  let bridgeReceiptFailures = [];
  if (bridgeEvidenceModelAvailable) {
    bridgeMovements = (await pool.query(`
      SELECT m.id, m.protocol, m.family_version, m.status,
             m.verification_method, m.correlation_key, m.rule_version,
             m.evidence, m.invalidated_at, m.invalidation_reason,
             COALESCE(jsonb_agg(jsonb_build_object(
               'wallet_id', mm.wallet_id, 'chain_id', mm.chain_id,
               'tx_hash', mm.tx_hash, 'role', mm.role,
               'receipt_id', mm.receipt_id, 'log_index', mm.log_index,
               'asset_id', mm.asset_id, 'amount', mm.amount::text,
               'fee_amount', mm.fee_amount::text, 'evidence', mm.evidence
             ) ORDER BY mm.id) FILTER (WHERE mm.id IS NOT NULL), '[]'::jsonb) AS members
        FROM eth_bridge_movements m
        LEFT JOIN eth_bridge_movement_members mm ON mm.movement_id = m.id
        LEFT JOIN eth_wallets mw ON mw.id = mm.wallet_id AND mw.user_id = m.user_id
       WHERE m.user_id = $1 AND (mm.id IS NULL OR mw.id IS NOT NULL)
       GROUP BY m.id
       ORDER BY m.updated_at, m.id`, [userId])).rows;

    bridgeSuggestions = (await pool.query(`
      SELECT s.id, s.out_wallet_id, s.out_chain_id, s.out_tx_hash,
             s.in_wallet_id, s.in_chain_id, s.in_tx_hash,
             s.protocol, s.family_version, s.suggestion_reason,
             s.ambiguous, s.rule_version, s.evidence, s.created_at
        FROM eth_bridge_suggestions s
        JOIN eth_wallets ow ON ow.id = s.out_wallet_id AND ow.user_id = s.user_id
        JOIN eth_wallets iw ON iw.id = s.in_wallet_id AND iw.user_id = s.user_id
       WHERE s.user_id = $1
       ORDER BY s.ambiguous DESC, s.created_at, s.id`, [userId])).rows;

    bridgeVerdicts = (await pool.query(`
      SELECT v.id, v.out_wallet_id, v.out_chain_id, v.out_tx_hash,
             v.in_wallet_id, v.in_chain_id, v.in_tx_hash,
             v.verdict, v.note, v.created_at, v.updated_at
        FROM eth_bridge_verdicts v
        JOIN eth_wallets ow ON ow.id = v.out_wallet_id AND ow.user_id = v.user_id
        JOIN eth_wallets iw ON iw.id = v.in_wallet_id AND iw.user_id = v.user_id
       WHERE v.user_id = $1
       ORDER BY v.updated_at, v.id`, [userId])).rows;

    bridgeReceiptFailures = (await pool.query(`
      SELECT latest.*
        FROM (
          SELECT DISTINCT ON (a.wallet_id, a.chain_id, a.tx_hash)
                 a.id, a.wallet_id, a.chain_id, a.tx_hash, a.provider,
                 a.status, a.provider_boundary, a.error_code,
                 a.error_detail, a.attempted_at
            FROM eth_bridge_receipt_attempts a
            JOIN eth_wallets w ON w.id = a.wallet_id
           WHERE w.user_id = $1
           ORDER BY a.wallet_id, a.chain_id, a.tx_hash,
                    a.attempted_at DESC, a.id DESC
        ) latest
       WHERE latest.status IN ('failed', 'unsupported')
       ORDER BY latest.attempted_at, latest.id`, [userId])).rows;
  }

  // Keep the latest evidence-walk scopes beside the detailed gap rows. This
  // is the durable answer to "which feed is still open?" after a partial
  // provider run: a keyless primary explorer can be complete while one keyed
  // override remains deferred. Scope rows contain no wallet address, raw
  // response, or credential; those remain in the protected provider-page
  // tables and are intentionally not copied into this report.
  const auditScopesAvailable = await tableExists('evm_audit_scopes');
  const auditScopes = auditScopesAvailable
    ? (await pool.query(`
      WITH latest_jobs AS (
        SELECT DISTINCT ON (j.subject_id)
               j.id, j.subject_id, j.status AS job_status, j.mode, j.requested_at
          FROM evm_audit_jobs j
          JOIN evm_subjects s ON s.id = j.subject_id
         WHERE s.user_id = $1
         ORDER BY j.subject_id, j.requested_at DESC, j.id DESC
      )
      SELECT sc.job_id, sc.chain_id, sc.provider, sc.capability, sc.status,
             sc.pagination_exhausted, sc.requested_from_block,
             sc.requested_through_block, sc.provider_cursor,
             sc.provider_order, sc.coverage_basis, sc.error_code,
             sc.error_detail, j.job_status, j.mode, j.requested_at
        FROM latest_jobs j
        JOIN evm_audit_scopes sc ON sc.job_id = j.id
       ORDER BY sc.chain_id, sc.capability, sc.provider, sc.status`, [userId])).rows
    : [];

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
           COALESCE(ao.spam, a.spam, FALSE) AS quarantined,
           p.status AS price_coverage_status, p.detail AS price_coverage_detail
      FROM eth_transfers t
      JOIN eth_wallets w ON w.id = t.wallet_id
      LEFT JOIN eth_ignored_tokens i
        ON i.user_id = w.user_id AND i.contract_address = t.token_contract
      LEFT JOIN eth_activity a
        ON a.wallet_id = t.wallet_id AND a.chain_id = t.chain_id AND a.tx_hash = t.tx_hash
      LEFT JOIN eth_activity_overrides ao
        ON ao.wallet_id = t.wallet_id AND ao.chain_id = t.chain_id AND ao.tx_hash = t.tx_hash
      LEFT JOIN asset_price_coverage p
        ON p.asset_key = CASE
          WHEN t.token_contract IS NULL THEN UPPER(COALESCE(t.token_symbol, 'ETH'))
          ELSE 'erc20:' || t.chain_id::text || ':' || LOWER(t.token_contract)
        END
     WHERE w.user_id = $1 AND t.usd_basis = 'unpriced'
     ORDER BY t.block_time, t.id`, [userId])).rows;
  for (const row of unpriced) row.durable_reason = unpricedReason(row);

  const exchangeExceptions = (await pool.query(`
    SELECT e.id, e.exchange_account_id, ea.name AS exchange_account_name,
           ea.exchange, e.canonical_asset, e.status,
           e.category, e.evidence, e.adjustment, e.adjusted_delta,
           e.created_at, e.updated_at,
           s.provider_asset_codes, s.derived_balance, s.live_balance,
           s.delta, s.comparison_status, s.calculated_at
      FROM exchange_balance_exceptions e
      JOIN exchange_accounts ea ON ea.id = e.exchange_account_id
      LEFT JOIN exchange_balance_audit_snapshots s ON s.id = e.current_snapshot_id
     WHERE ea.user_id = $1 AND e.status <> 'cleared'
     ORDER BY ea.exchange, e.canonical_asset, e.id`, [userId])).rows;

  // Keep exchange review rows in the same private evidence index as on-chain
  // gaps.  The provider type, grouping id, preserved network/chain and raw
  // source are what distinguish a real unresolved event from a replay or a
  // provider representation; none is safe to infer from the ticker alone.
  const exchangeReviewRows = (await pool.query(`
    SELECT er.id, er.exchange_account_id, ea.name AS exchange_account_name,
           ea.exchange, er.external_id, er.occurred_at, er.record_type,
           er.base_asset, er.base_amount, er.quote_asset, er.quote_amount,
           er.fee_asset, er.fee_amount, er.tx_hash, er.address,
           er.network, er.chain_id, er.source, er.fingerprint,
           er.needs_review, er.duplicate_candidate,
           er.raw->>'type' AS provider_type,
           COALESCE(er.raw->>'_trade_id', er.raw->'trade'->>'id',
                    er.raw->'advanced_trade_fill'->>'order_id',
                    er.raw->'buy'->>'id', er.raw->'sell'->>'id') AS provider_group_id,
           er.raw, er.dedupe_provenance
      FROM exchange_records er
      JOIN exchange_accounts ea ON ea.id = er.exchange_account_id
     WHERE ea.user_id = $1 AND er.needs_review
     ORDER BY ea.exchange, er.occurred_at, er.id`, [userId])).rows;

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

  const dedupeEventsAvailable = await tableExists('exchange_record_dedupe_events');
  const exchangeDedupeEvents = dedupeEventsAvailable
    ? (await pool.query(`
      SELECT d.id, d.exchange_account_id, ea.name AS exchange_account_name,
             ea.exchange, d.survivor_record_id, survivor.external_id AS survivor_external_id,
             d.incoming_external_id, d.incoming_source, d.fingerprint,
             d.fingerprint_version, d.incoming_snapshot, d.created_at
        FROM exchange_record_dedupe_events d
        JOIN exchange_accounts ea ON ea.id = d.exchange_account_id
        LEFT JOIN exchange_records survivor ON survivor.id = d.survivor_record_id
       WHERE ea.user_id = $1
       ORDER BY d.created_at, d.id`, [userId])).rows
    : [];

  const crossAccountExternalIdOverlaps = (await pool.query(`
    SELECT left_record.id AS left_record_id,
           left_record.exchange_account_id AS left_account_id,
           left_account.name AS left_account_name,
           right_record.id AS right_record_id,
           right_record.exchange_account_id AS right_account_id,
           right_account.name AS right_account_name,
           left_account.exchange, left_record.external_id,
           left_record.occurred_at AS left_occurred_at,
           right_record.occurred_at AS right_occurred_at,
           left_record.source AS left_source, right_record.source AS right_source,
           left_record.needs_review AS left_needs_review,
           right_record.needs_review AS right_needs_review
      FROM exchange_records left_record
      JOIN exchange_accounts left_account ON left_account.id = left_record.exchange_account_id
      JOIN exchange_records right_record
        ON right_record.external_id = left_record.external_id
       AND right_record.id > left_record.id
       AND right_record.exchange_account_id <> left_record.exchange_account_id
      JOIN exchange_accounts right_account ON right_account.id = right_record.exchange_account_id
     WHERE left_account.user_id = $1
       AND right_account.user_id = $1
       AND right_account.exchange = left_account.exchange
     ORDER BY left_account.exchange, left_record.external_id`, [userId])).rows;

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
      bridge_evidence_model_available: bridgeEvidenceModelAvailable,
      bridge_movements: bridgeMovements.length,
      bridge_movements_by_status: by(bridgeMovements, 'status'),
      bridge_suggestions: bridgeSuggestions.length,
      bridge_ambiguous_suggestions: bridgeSuggestions.filter((row) => row.ambiguous).length,
      bridge_verdicts: bridgeVerdicts.length,
      bridge_receipt_failures: bridgeReceiptFailures.length,
      audit_scope_rows: auditScopes.length,
      audit_scope_by_status: by(auditScopes, 'status'),
      reconciliation_rows: reconciliation.length,
      reconciliation_by_status: by(reconciliation, 'status'),
      unpriced_rows: unpriced.length,
      unpriced_by_reason: by(unpriced, 'durable_reason'),
      open_exchange_exceptions: exchangeExceptions.length,
      exchange_review_rows: exchangeReviewRows.length,
      exchange_review_by_venue: by(exchangeReviewRows, 'exchange'),
      exchange_review_by_provider_type: by(exchangeReviewRows, 'provider_type'),
      duplicate_candidate_rows: duplicateCandidates.length,
      exchange_dedupe_events: exchangeDedupeEvents.length,
      cross_account_external_id_overlaps: crossAccountExternalIdOverlaps.length,
    },
    review_rows: reviewRows,
    unmatched_bridge_rows: bridgeRows,
    bridge_movements: bridgeMovements,
    bridge_suggestions: bridgeSuggestions,
    bridge_verdicts: bridgeVerdicts,
    bridge_receipt_failures: bridgeReceiptFailures,
    audit_scopes: auditScopes,
    reconciliation,
    unpriced,
    exchange_exceptions: exchangeExceptions,
    exchange_review_rows: exchangeReviewRows,
    duplicate_candidates: duplicateCandidates,
    exchange_dedupe_events: exchangeDedupeEvents,
    cross_account_external_id_overlaps: crossAccountExternalIdOverlaps,
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

module.exports = { buildReport, reviewBlocker, tableExists, unpricedReason };

#!/usr/bin/env node

'use strict';

// Private, read-only evidence report for the exchange matcher.  The aggregate
// history audit is intentionally safe to publish; this report is deliberately
// written to a caller-selected 0600 file because it contains transaction hashes,
// addresses and provider record identifiers needed for review.

require('dotenv').config();
const fs = require('fs');
const pool = require('../src/config/database');

function option(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? null : process.argv[index + 1] || null;
}

function requiredPositiveInteger(name) {
  const value = option(name);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error(`${name} must be a positive integer`);
  return parsed;
}

function valueKey(value) {
  return value === null || value === undefined || value === '' ? 'unknown' : String(value);
}

function countBy(rows, selector) {
  return rows.reduce((out, row) => {
    const key = valueKey(selector(row));
    out[key] = (out[key] || 0) + 1;
    return out;
  }, {});
}

function countByExchangeAndAsset(rows) {
  return rows.reduce((out, row) => {
    const exchange = valueKey(row.exchange);
    const asset = valueKey(row.base_asset).toUpperCase();
    if (!out[exchange]) out[exchange] = {};
    out[exchange][asset] = (out[exchange][asset] || 0) + 1;
    return out;
  }, {});
}

function summarizeUnmatched(rows) {
  return {
    unmatched_deposit_withdrawal_records: rows.length,
    unmatched_by_exchange: countBy(rows, (row) => row.exchange),
    unmatched_by_record_type: countBy(rows, (row) => row.record_type),
    unmatched_by_asset: countBy(rows, (row) => String(row.base_asset || 'unknown').toUpperCase()),
    unmatched_by_exchange_and_asset: countByExchangeAndAsset(rows),
    unmatched_by_source: countBy(rows, (row) => row.source),
    unmatched_by_provider_type: countBy(rows, (row) => row.provider_type),
    unmatched_by_network: countBy(rows, (row) => row.network),
    unmatched_by_chain: countBy(rows, (row) => row.chain_id),
    unmatched_by_year: countBy(rows, (row) => {
      const timestamp = new Date(row.occurred_at);
      return Number.isFinite(timestamp.getTime()) ? timestamp.getUTCFullYear() : 'unknown';
    }),
    evidence_availability: {
      with_tx_hash: rows.filter((row) => Boolean(row.tx_hash)).length,
      without_tx_hash: rows.filter((row) => !row.tx_hash).length,
      with_address: rows.filter((row) => Boolean(row.address)).length,
      without_address: rows.filter((row) => !row.address).length,
      with_proven_chain: rows.filter((row) => row.chain_id !== null && row.chain_id !== undefined).length,
      without_proven_chain: rows.filter((row) => row.chain_id === null || row.chain_id === undefined).length,
      needs_review: rows.filter((row) => Boolean(row.needs_review)).length,
      duplicate_candidates: rows.filter((row) => Boolean(row.duplicate_candidate)).length,
      with_suggestion: rows.filter((row) => Boolean(row.has_suggestion)).length,
    },
  };
}

async function buildReport(userId) {
  // These are ledger evidence windows, not provider-completeness claims. They
  // make API/CSV overlap and historical-account continuity visible without
  // assuming that either source enumerated everything the venue ever held.
  const accounts = (await pool.query(`
    SELECT ea.id AS exchange_account_id, ea.name AS exchange_account_name,
           ea.exchange, ea.records_unavailable, ea.reconciliation_status,
           ea.last_sync_status, ea.last_sync_at, ea.last_import_at,
           COUNT(er.id)::int AS record_count,
           MIN(er.occurred_at) AS earliest_record_at,
           MAX(er.occurred_at) AS latest_record_at,
           COUNT(er.id) FILTER (WHERE er.source = 'api')::int AS api_records,
           COUNT(er.id) FILTER (WHERE er.source = 'csv')::int AS csv_records,
           COUNT(er.id) FILTER (WHERE er.source IS NULL)::int AS records_without_source,
           COUNT(er.id) FILTER (WHERE er.fingerprint IS NULL)::int AS records_without_fingerprint,
           COUNT(er.id) FILTER (WHERE er.needs_review)::int AS review_records,
           COUNT(er.id) FILTER (WHERE er.duplicate_candidate)::int AS duplicate_candidates,
           COUNT(er.id) FILTER (WHERE er.record_type IN ('deposit', 'withdrawal'))::int
             AS transfer_records,
           COUNT(er.id) FILTER (WHERE er.record_type IN ('deposit', 'withdrawal')
                                  AND er.tx_hash IS NOT NULL)::int AS transfer_records_with_hash,
           COUNT(er.id) FILTER (WHERE er.record_type IN ('deposit', 'withdrawal')
                                  AND er.chain_id IS NOT NULL)::int AS transfer_records_with_chain
      FROM exchange_accounts ea
      LEFT JOIN exchange_records er ON er.exchange_account_id = ea.id
     WHERE ea.user_id = $1
     GROUP BY ea.id
     ORDER BY ea.exchange, ea.created_at, ea.id`, [userId])).rows;

  const sourceWindows = (await pool.query(`
    SELECT ea.id AS exchange_account_id, ea.name AS exchange_account_name,
           ea.exchange, COALESCE(er.source, 'unknown') AS source,
           COALESCE(er.raw->>'_format', 'unknown') AS provider_format,
           COUNT(*)::int AS record_count,
           MIN(er.occurred_at) AS earliest_record_at,
           MAX(er.occurred_at) AS latest_record_at,
           COUNT(*) FILTER (WHERE er.needs_review)::int AS review_records,
           COUNT(*) FILTER (WHERE er.duplicate_candidate)::int AS duplicate_candidates
      FROM exchange_records er
      JOIN exchange_accounts ea ON ea.id = er.exchange_account_id
     WHERE ea.user_id = $1
     GROUP BY ea.id, ea.name, ea.exchange, COALESCE(er.source, 'unknown'),
              COALESCE(er.raw->>'_format', 'unknown')
     ORDER BY ea.exchange, ea.id, source, provider_format`, [userId])).rows;

  const suggestions = (await pool.query(`
    SELECT s.id AS suggestion_id,
           s.exchange_record_id, s.counter_record_id, s.activity_id,
           s.match_method, s.confidence, s.suggestion_reason, s.rule_version,
           s.comparison_kind, s.comparison_left_amount, s.comparison_right_amount,
           s.fee_amount_applied, s.amount_delta, s.amount_tolerance,
           s.magnitude_ratio, s.address_match, s.time_delta_seconds,
           er.occurred_at AS exchange_occurred_at,
           er.record_type AS exchange_record_type,
           er.base_asset AS exchange_base_asset,
           er.base_amount AS exchange_base_amount,
           er.quote_asset AS exchange_quote_asset,
           er.quote_amount AS exchange_quote_amount,
           er.fee_asset AS exchange_fee_asset,
           er.fee_amount AS exchange_fee_amount,
           er.tx_hash AS exchange_tx_hash,
           er.address AS exchange_address,
           ea.id AS exchange_account_id,
           ea.name AS exchange_account_name,
           ea.exchange,
           cr.occurred_at AS counter_occurred_at,
           cr.record_type AS counter_record_type,
           cr.base_asset AS counter_base_asset,
           cr.base_amount AS counter_base_amount,
           cr.quote_asset AS counter_quote_asset,
           cr.quote_amount AS counter_quote_amount,
           cr.tx_hash AS counter_tx_hash,
           ca.id AS counter_account_id,
           ca.name AS counter_account_name,
           a.wallet_id, a.chain_id, a.tx_hash AS activity_tx_hash,
           a.block_time AS activity_block_time, a.category AS activity_category,
           a.counterparty_address, a.counterparty_name, a.legs
      FROM exchange_match_suggestions s
      JOIN exchange_records er ON er.id = s.exchange_record_id
      JOIN exchange_accounts ea ON ea.id = er.exchange_account_id
      LEFT JOIN exchange_records cr ON cr.id = s.counter_record_id
      LEFT JOIN exchange_accounts ca ON ca.id = cr.exchange_account_id
      LEFT JOIN eth_activity a ON a.id = s.activity_id
     WHERE ea.user_id = $1
     ORDER BY s.suggestion_reason, er.occurred_at, s.id`, [userId])).rows;

  const unmatched = (await pool.query(`
    WITH matched_records AS (
      SELECT m.exchange_record_id AS id
        FROM exchange_matches m
        JOIN exchange_records x ON x.id = m.exchange_record_id
        JOIN exchange_accounts xa ON xa.id = x.exchange_account_id
       WHERE xa.user_id = $1
      UNION
      SELECT m.counter_record_id AS id
        FROM exchange_matches m
        JOIN exchange_records x ON x.id = m.counter_record_id
        JOIN exchange_accounts xa ON xa.id = x.exchange_account_id
       WHERE xa.user_id = $1 AND m.counter_record_id IS NOT NULL
    )
    SELECT er.id AS exchange_record_id, ea.id AS exchange_account_id,
           ea.name AS exchange_account_name, ea.exchange,
           er.external_id, er.occurred_at, er.record_type,
           er.base_asset, er.base_amount, er.quote_asset, er.quote_amount,
           er.fee_asset, er.fee_amount, er.tx_hash, er.address,
           er.network, er.chain_id, er.source,
           er.needs_review, er.duplicate_candidate,
           COALESCE(er.raw->>'_source', er.raw->>'source') AS raw_source,
           er.raw->>'type' AS provider_type,
           EXISTS (
             SELECT 1 FROM exchange_match_suggestions s
              WHERE s.exchange_record_id = er.id OR s.counter_record_id = er.id
           ) AS has_suggestion
      FROM exchange_records er
      JOIN exchange_accounts ea ON ea.id = er.exchange_account_id
     WHERE ea.user_id = $1
       AND er.record_type IN ('deposit', 'withdrawal')
       AND NOT EXISTS (SELECT 1 FROM matched_records m WHERE m.id = er.id)
     ORDER BY er.occurred_at, er.id`, [userId])).rows;

  const byReason = suggestions.reduce((out, row) => {
    out[row.suggestion_reason] = (out[row.suggestion_reason] || 0) + 1;
    return out;
  }, {});
  const unmatchedSummary = summarizeUnmatched(unmatched);

  return {
    generated_at: new Date().toISOString(),
    user_id: userId,
    rule: 'v3: only tx-hash identity or confirmed verdict is automatic; fallback evidence is a suggestion',
    summary: {
      exchange_accounts: accounts.length,
      exchange_accounts_by_venue: countBy(accounts, (row) => row.exchange),
      exchange_accounts_with_review: accounts.filter((row) => Number(row.review_records) > 0).length,
      exchange_accounts_with_duplicate_candidates: accounts
        .filter((row) => Number(row.duplicate_candidates) > 0).length,
      exchange_accounts_with_unknown_reconciliation: accounts
        .filter((row) => row.reconciliation_status === 'unknown').length,
      exchange_accounts_declared_records_unavailable: accounts
        .filter((row) => Boolean(row.records_unavailable)).length,
      suggestions: suggestions.length,
      suggestions_by_reason: byReason,
      ...unmatchedSummary,
    },
    // No date window below is a claim that a source is lifetime-complete. The
    // manifest/export audit must independently establish that boundary.
    accounts,
    source_windows: sourceWindows,
    suggestions,
    unmatched,
  };
}

async function main() {
  const userId = requiredPositiveInteger('--user-id');
  const outputPath = option('--output');
  if (!outputPath) throw new Error('--output is required; detailed rows are private');
  const report = await buildReport(userId);
  fs.writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  process.stdout.write(JSON.stringify(report.summary) + '\n');
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`Exchange match gap report failed: ${error.message}`);
    process.exitCode = 1;
  }).finally(() => pool.end().catch(() => {}));
}

module.exports = { buildReport, summarizeUnmatched };

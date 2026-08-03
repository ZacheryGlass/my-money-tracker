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

async function buildReport(userId) {
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
           er.needs_review, er.duplicate_candidate,
           er.raw->>'source' AS raw_source,
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
  const unmatchedByVenue = unmatched.reduce((out, row) => {
    const key = row.exchange || 'unknown';
    out[key] = (out[key] || 0) + 1;
    return out;
  }, {});
  const unmatchedByType = unmatched.reduce((out, row) => {
    out[row.record_type] = (out[row.record_type] || 0) + 1;
    return out;
  }, {});

  return {
    generated_at: new Date().toISOString(),
    user_id: userId,
    rule: 'v3: only tx-hash identity or confirmed verdict is automatic; fallback evidence is a suggestion',
    summary: {
      suggestions: suggestions.length,
      suggestions_by_reason: byReason,
      unmatched_deposit_withdrawal_records: unmatched.length,
      unmatched_by_exchange: unmatchedByVenue,
      unmatched_by_record_type: unmatchedByType,
    },
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

module.exports = { buildReport };

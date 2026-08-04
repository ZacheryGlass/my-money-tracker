#!/usr/bin/env node
'use strict';

// Read-only, privacy-safe aggregate audit for one user's EVM and exchange
// history. It deliberately emits counts, dates, statuses and provider limits,
// never addresses, transaction hashes, names, raw payloads, balances, or
// provider snapshots. The detailed rows remain in the application and can be
// reviewed there without making this report suitable for publication.

require('dotenv').config();
const fs = require('fs');
const { execFileSync } = require('child_process');
const pool = require('../src/config/database');

function option(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? null : process.argv[index + 1] || null;
}

function requiredPositiveInteger(name) {
  const value = option(name);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

function gitRevision() {
  if (process.env.GIT_REVISION) return process.env.GIT_REVISION;
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim() || null;
  } catch {
    return null;
  }
}

function gitDirty() {
  try {
    return execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim().length > 0;
  } catch {
    return null;
  }
}

async function rows(sql, params) {
  const result = await pool.query(sql, params);
  return result.rows;
}

async function tableExists(tableName) {
  const result = await rows('SELECT to_regclass($1) IS NOT NULL AS exists', [tableName]);
  return result[0]?.exists === true;
}

async function buildReport(userId, archiveReportPath = null) {
  const wallets = (await rows(
    `SELECT COUNT(*)::int AS wallet_count,
            COUNT(DISTINCT wc.chain_id)::int AS chain_count,
            MIN(w.created_at) AS first_wallet_added,
            MAX(w.last_synced_at) AS last_wallet_sync
       FROM eth_wallets w
       LEFT JOIN eth_wallet_chains wc ON wc.wallet_id = w.id
      WHERE w.user_id = $1`,
    [userId]
  ))[0] || {};

  const feedCoverage = await rows(
    `SELECT c.chain_id, c.feed, c.status, c.provider,
            COUNT(*)::int AS rows,
            MIN(c.covered_from_block) AS min_covered_from_block,
            MAX(c.covered_through_block) AS max_covered_through_block,
            MAX(c.indexed_head) AS max_indexed_head,
            COUNT(*) FILTER (WHERE c.status IN ('failed', 'unsupported'))::int AS gap_rows,
            COUNT(*) FILTER (WHERE c.status = 'unverified')::int AS unverified_rows
       FROM eth_feed_coverage c
       JOIN eth_wallets w ON w.id = c.wallet_id
      WHERE w.user_id = $1
      GROUP BY c.chain_id, c.feed, c.status, c.provider
      ORDER BY c.chain_id, c.feed, c.status, c.provider`,
    [userId]
  );

  const activityByCategory = await rows(
    `SELECT COALESCE(o.category, a.category) AS category,
            COUNT(*)::int AS rows,
            COUNT(*) FILTER (WHERE a.needs_review)::int AS derived_review_rows,
            COUNT(*) FILTER (WHERE COALESCE(a.spam, FALSE))::int AS spam_rows,
            COUNT(*) FILTER (WHERE o.category IS NOT NULL)::int AS overridden_rows
       FROM eth_activity a
       JOIN eth_wallets w ON w.id = a.wallet_id
       LEFT JOIN eth_activity_overrides o
         ON o.wallet_id = a.wallet_id AND o.chain_id = a.chain_id AND o.tx_hash = a.tx_hash
      WHERE w.user_id = $1
      GROUP BY COALESCE(o.category, a.category)
      ORDER BY category`,
    [userId]
  );

  const exchangeAccounts = await rows(
    `SELECT ea.exchange, ea.reconciliation_status, ea.records_unavailable,
            COUNT(DISTINCT ea.id)::int AS accounts,
            COUNT(er.id)::int AS records,
            COUNT(er.id) FILTER (WHERE er.needs_review)::int AS review_records,
            COUNT(er.id) FILTER (WHERE er.duplicate_candidate)::int AS duplicate_candidates,
            MIN(er.occurred_at) AS earliest_record,
            MAX(er.occurred_at) AS latest_record
       FROM exchange_accounts ea
       LEFT JOIN exchange_records er ON er.exchange_account_id = ea.id
      WHERE ea.user_id = $1
      GROUP BY ea.exchange, ea.reconciliation_status, ea.records_unavailable
      ORDER BY ea.exchange, ea.reconciliation_status, ea.records_unavailable`,
    [userId]
  );

  const matching = (await rows(
    `WITH owned_records AS (
           SELECT er.id
             FROM exchange_records er
             JOIN exchange_accounts ea ON ea.id = er.exchange_account_id
            WHERE ea.user_id = $1
         ), matched_records AS (
           SELECT m.exchange_record_id AS id
             FROM exchange_matches m
             JOIN exchange_records er ON er.id = m.exchange_record_id
             JOIN exchange_accounts ea ON ea.id = er.exchange_account_id
            WHERE ea.user_id = $1
           UNION
           SELECT m.counter_record_id AS id
             FROM exchange_matches m
             JOIN exchange_records er ON er.id = m.counter_record_id
             JOIN exchange_accounts ea ON ea.id = er.exchange_account_id
            WHERE ea.user_id = $1 AND m.counter_record_id IS NOT NULL
         ), matchable AS (
           SELECT er.id
             FROM exchange_records er
             JOIN exchange_accounts ea ON ea.id = er.exchange_account_id
            WHERE ea.user_id = $1 AND er.record_type IN ('deposit', 'withdrawal')
         )
         SELECT (SELECT COUNT(*) FROM owned_records)::int AS exchange_records,
                (SELECT COUNT(*) FROM exchange_matches m
                   JOIN exchange_records er ON er.id = m.exchange_record_id
                   JOIN exchange_accounts ea ON ea.id = er.exchange_account_id
                  WHERE ea.user_id = $1)::int AS active_matches,
                (SELECT COUNT(*) FROM exchange_match_suggestions s
                   JOIN exchange_records er ON er.id = s.exchange_record_id
                   JOIN exchange_accounts ea ON ea.id = er.exchange_account_id
                  WHERE ea.user_id = $1)::int AS suggestions,
                (SELECT COUNT(*) FROM exchange_match_verdicts v
                   JOIN exchange_records er ON er.id = v.exchange_record_id
                   JOIN exchange_accounts ea ON ea.id = er.exchange_account_id
                  WHERE ea.user_id = $1)::int AS verdicts,
                (SELECT COUNT(*) FROM matchable m
                  WHERE NOT EXISTS (SELECT 1 FROM matched_records x WHERE x.id = m.id))::int AS unmatched_transfer_records`
    , [userId]
  ))[0] || {};

  const fiat = (await rows(
    `SELECT COUNT(*)::int AS links,
            COUNT(DISTINCT efm.exchange_record_id)::int AS linked_exchange_records,
            COUNT(DISTINCT efm.transaction_id)::int AS linked_bank_transactions,
            (SELECT COUNT(*)::int
               FROM exchange_records er
               JOIN exchange_accounts ea ON ea.id = er.exchange_account_id
              WHERE ea.user_id = $1
                AND er.record_type IN ('deposit', 'withdrawal')
                AND UPPER(er.base_asset) IN ('USD', 'USDC', 'EUR', 'GBP', 'CAD')
                AND er.needs_review) AS unmatched_fiat_records
       FROM exchange_fiat_matches efm
       JOIN exchange_records er ON er.id = efm.exchange_record_id
       JOIN exchange_accounts ea ON ea.id = er.exchange_account_id
      WHERE ea.user_id = $1`,
    [userId]
  ))[0] || {};

  const bridgeLegacy = (await rows(
    `SELECT COUNT(*)::int AS links,
            (SELECT COUNT(*)::int
               FROM eth_activity a
               JOIN eth_wallets w ON w.id = a.wallet_id
              WHERE w.user_id = $1
                AND COALESCE((SELECT o.category FROM eth_activity_overrides o
                               WHERE o.wallet_id = a.wallet_id AND o.chain_id = a.chain_id
                                 AND o.tx_hash = a.tx_hash), a.category)
                    IN ('bridge_out', 'bridge_in')
                AND NOT EXISTS (SELECT 1
                                  FROM eth_activity_links l
                                  JOIN eth_activity other
                                    ON other.id = CASE WHEN l.out_activity_id = a.id
                                                       THEN l.in_activity_id ELSE l.out_activity_id END
                                  JOIN eth_wallets other_w ON other_w.id = other.wallet_id
                                  WHERE (l.out_activity_id = a.id OR l.in_activity_id = a.id)
                                    AND other_w.user_id = $1))
              AS unmatched_bridge_legs
       FROM eth_activity_links l
       JOIN eth_activity a ON a.id = l.out_activity_id
       JOIN eth_wallets w ON w.id = a.wallet_id
       JOIN eth_activity other ON other.id = l.in_activity_id
       JOIN eth_wallets other_w ON other_w.id = other.wallet_id AND other_w.user_id = $1
      WHERE w.user_id = $1`,
    [userId]
  ))[0] || {};

  const bridgeEvidenceModelAvailable = await tableExists('eth_bridge_movements');
  let bridgeEvidence = {};
  if (bridgeEvidenceModelAvailable) {
    bridgeEvidence = (await rows(
      `SELECT
         (SELECT COUNT(*)::int FROM eth_bridge_movements
           WHERE user_id = $1 AND invalidated_at IS NULL) AS movements,
         (SELECT COUNT(*)::int FROM eth_bridge_movements
           WHERE user_id = $1 AND status = 'protocol_verified'
             AND invalidated_at IS NULL) AS protocol_verified,
         (SELECT COUNT(*)::int FROM eth_bridge_movements
           WHERE user_id = $1 AND status = 'user_confirmed'
             AND invalidated_at IS NULL) AS user_confirmed,
         (SELECT COUNT(*)::int FROM eth_bridge_movements
           WHERE user_id = $1 AND status = 'pending'
             AND invalidated_at IS NULL) AS pending,
         (SELECT COUNT(*)::int FROM eth_bridge_movements
           WHERE user_id = $1 AND status = 'refunded'
             AND invalidated_at IS NULL) AS refunded,
         (SELECT COUNT(*)::int FROM eth_bridge_movements
           WHERE user_id = $1 AND status = 'failed'
             AND invalidated_at IS NULL) AS failed,
         (SELECT COUNT(*)::int FROM eth_bridge_movements
           WHERE user_id = $1 AND status = 'unsupported'
             AND invalidated_at IS NULL) AS unsupported,
         (SELECT COUNT(*)::int FROM eth_bridge_suggestions
           WHERE user_id = $1) AS suggestions,
         (SELECT COUNT(*)::int FROM eth_bridge_suggestions
           WHERE user_id = $1 AND ambiguous) AS ambiguous_suggestions,
         (SELECT COUNT(*)::int FROM eth_bridge_verdicts
           WHERE user_id = $1) AS verdicts,
         (SELECT COUNT(*)::int
            FROM eth_bridge_receipts r
            JOIN eth_wallets w ON w.id = r.wallet_id
           WHERE w.user_id = $1 AND r.fetch_status = 'complete'
             AND r.invalidated_at IS NULL) AS complete_receipts,
         (SELECT COUNT(*)::int
            FROM eth_bridge_receipt_attempts a
            JOIN eth_wallets w ON w.id = a.wallet_id
           WHERE w.user_id = $1 AND a.status IN ('failed', 'unsupported'))
           AS failed_receipt_attempts`,
      [userId]
    ))[0] || {};
  }

  const reconciliation = await rows(
    `SELECT status, COUNT(*)::int AS rows
       FROM eth_reconciliation r
       JOIN eth_wallets w ON w.id = r.wallet_id
      WHERE w.user_id = $1
      GROUP BY status
      ORDER BY status`,
    [userId]
  );

  const exchangeExceptions = await rows(
    `SELECT e.category, e.status, COUNT(*)::int AS rows
       FROM exchange_balance_exceptions e
       JOIN exchange_accounts ea ON ea.id = e.exchange_account_id
      WHERE ea.user_id = $1
      GROUP BY e.category, e.status
      ORDER BY e.category, e.status`,
    [userId]
  );

  const prices = (await rows(
    `SELECT COUNT(*)::int AS transfers,
            COUNT(*) FILTER (WHERE et.usd_basis = 'unpriced')::int AS unpriced_transfers,
            COUNT(*) FILTER (WHERE et.usd_basis = 'not_applicable')::int AS not_applicable_transfers,
            COUNT(*) FILTER (WHERE et.usd_basis IN ('exact', 'carried'))::int AS priced_transfers
       FROM eth_transfers et
       JOIN eth_wallets w ON w.id = et.wallet_id
      WHERE w.user_id = $1`,
    [userId]
  ))[0] || {};

  const discovery = (await rows(
    `SELECT status, COUNT(*)::int AS rows
       FROM eth_discovery_candidates
      WHERE user_id = $1
      GROUP BY status
      ORDER BY status`,
    [userId]
  ));

  const fetchReceipts = await rows(
    `SELECT status, COUNT(*)::int AS rows,
            MAX(fetched_at) AS last_fetched
       FROM eth_discovery_fetches
      WHERE user_id = $1
      GROUP BY status
      ORDER BY status`,
    [userId]
  );

  let archiveAudit = null;
  if (archiveReportPath) {
    const report = JSON.parse(fs.readFileSync(archiveReportPath, 'utf8'));
    archiveAudit = {
      generated_at: report.generated_at || null,
      verdict: report.summary?.verdict || null,
      files: report.summary?.files || 0,
      unexplained_files: report.summary?.unexplained_files || 0,
      parsed_records: report.summary?.parsed_records || 0,
      matched_records: report.summary?.matched_records || 0,
    };
  }

  const number = (value) => (value == null ? 0 : Number(value));
  return {
    generated_at: new Date().toISOString(),
    code_revision: gitRevision(),
    code_dirty: gitDirty(),
    read_only: true,
    scope: { wallet_count: number(wallets.wallet_count), chain_count: number(wallets.chain_count) },
    wallet_sync: {
      first_wallet_added: wallets.first_wallet_added || null,
      last_wallet_sync: wallets.last_wallet_sync || null,
    },
    provider_coverage: feedCoverage,
    activity: {
      by_category: activityByCategory,
      totals: {
        rows: activityByCategory.reduce((sum, row) => sum + number(row.rows), 0),
        derived_review_rows: activityByCategory.reduce((sum, row) => sum + number(row.derived_review_rows), 0),
        spam_rows: activityByCategory.reduce((sum, row) => sum + number(row.spam_rows), 0),
        overridden_rows: activityByCategory.reduce((sum, row) => sum + number(row.overridden_rows), 0),
      },
    },
    exchanges: { accounts: exchangeAccounts },
    matching: {
      exchange_records: number(matching.exchange_records),
      active_matches: number(matching.active_matches),
      suggestions: number(matching.suggestions),
      verdicts: number(matching.verdicts),
      unmatched_transfer_records: number(matching.unmatched_transfer_records),
      fiat: Object.fromEntries(Object.entries(fiat).map(([key, value]) => [key, number(value)])),
    },
    bridges: {
      evidence_model_available: bridgeEvidenceModelAvailable,
      ...Object.fromEntries(Object.entries(bridgeLegacy).map(([key, value]) => [key, number(value)])),
      ...Object.fromEntries(Object.entries(bridgeEvidence).map(([key, value]) => [key, number(value)])),
    },
    reconciliation: { eth: reconciliation, exchange_exceptions: exchangeExceptions },
    prices: Object.fromEntries(Object.entries(prices).map(([key, value]) => [key, number(value)])),
    discovery: { candidates: discovery, fetch_receipts: fetchReceipts },
    archive_audit: archiveAudit,
  };
}

async function main() {
  const userId = requiredPositiveInteger('--user-id');
  const outputPath = option('--output');
  const archiveReportPath = option('--archive-report');
  const report = await buildReport(userId, archiveReportPath);
  const rendered = `${JSON.stringify(report, null, 2)}\n`;
  if (outputPath) fs.writeFileSync(outputPath, rendered, { mode: 0o600 });
  else process.stdout.write(rendered);
}

if (require.main === module) {
  main()
    .catch((error) => {
      console.error(`History audit failed: ${error.message}`);
      process.exitCode = 1;
    })
    .finally(() => pool.end().catch(() => {}));
}

module.exports = { buildReport };

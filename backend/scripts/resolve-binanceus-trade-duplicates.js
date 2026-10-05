#!/usr/bin/env node

'use strict';

// One-off resolver for Binance.US spot fills stored twice in one account: once
// from the CSV export and once from /api/v3/myTrades. The two sources share no
// replay id (the CSV keys a fill on its Transaction ID, the API on its trade
// id), the API rounds quoteQty to four places, and it names the legacy USD
// market USD4, so neither the external-id upsert nor the canonical fingerprint
// can see the overlap. The pairing leans only on what both sources state
// verbatim -- order id, base leg and the second the fill happened -- and is
// one-to-one. The single exception is a group of k API fills and k CSV fills
// (k >= 2) that share the pair key and are identical on every compared leg:
// any assignment then yields the same ledger, so they pair by ascending id.
// Every other shape -- no twin, unequal counts, a member that differs -- is
// reported and left alone.
//
// The CSV row survives with every economic column untouched; only its
// dedupe_provenance gains the API row's source snapshot. The dedupe audit row
// is what keeps every later API replay of that external id a plain duplicate
// instead of re-inserting the fill. Dry run unless --apply is explicit.
require('dotenv').config();
const pool = require('../src/config/database');
const ExchangeReconciliationService = require('../src/services/ExchangeReconciliationService');
const {
  FINGERPRINT_VERSION,
  fingerprintFor,
  sourceSnapshot,
} = require('../src/services/exchangeImport/canonicalFingerprint');

function option(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? null : process.argv[index + 1] || null;
}

function positiveInteger(value, name) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

function normalizeDecimal(value) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  if (!text) return null;
  const negative = text.startsWith('-');
  const unsigned = text.replace(/^[+-]/, '');
  const [whole = '0', fraction = ''] = unsigned.split('.');
  const normalizedWhole = whole.replace(/^0+(?=\d)/, '') || '0';
  const normalizedFraction = fraction.replace(/0+$/, '');
  const normalized = normalizedFraction
    ? `${normalizedWhole}.${normalizedFraction}`
    : normalizedWhole;
  return negative && normalized !== '0' ? `-${normalized}` : normalized;
}

function quoteIdent(name) {
  return `"${String(name).replace(/"/g, '""')}"`;
}

// Scope and pair rule live in one place so planning and the per-pair
// revalidation under lock cannot drift apart. $1 is always the account id.
const API_SCOPE = `api.exchange_account_id = $1
  AND api.source = 'api'
  AND api.record_type = 'trade'
  AND api.raw->>'_format' = 'binance_us'`;

const CSV_SCOPE = `csv.exchange_account_id = $1
  AND csv.source = 'csv'
  AND csv.record_type = 'trade'
  AND csv.raw->>'_format' = 'binance_us'`;

// Base amount and occurred_at compare as exact NUMERIC/TIMESTAMP in SQL: the
// CSV states the fill's second, the API its millisecond.
const PAIR_PREDICATE = `api.raw->>'orderId' IS NOT NULL
  AND csv.raw->>'Order ID' = api.raw->>'orderId'
  AND csv.base_asset = api.base_asset
  AND csv.base_amount = api.base_amount
  AND csv.occurred_at = date_trunc('second', api.occurred_at)`;

// Everything a pair decision reads. The quote/fee checks go beyond the pair
// rule on purpose: a twin is only collapsed when the legs the rule does not
// key on also agree, with USD4 accepted solely as the API's name for the CSV's
// USD and the quote allowed to differ only below quoteQty's 4dp precision.
const PAIR_COLUMNS = `api.id::text AS api_id,
  api.external_id AS api_external_id,
  api.raw->>'symbol' AS symbol,
  api.raw->>'orderId' AS order_id,
  api.base_asset,
  api.base_amount::text AS base_amount,
  api.quote_asset AS api_quote_asset,
  api.quote_amount::text AS api_quote_amount,
  api.fee_asset AS api_fee_asset,
  api.fee_amount::text AS api_fee_amount,
  api.needs_review AS api_needs_review,
  api.duplicate_candidate AS api_duplicate_candidate,
  (api.eth_rounding_adjustment_wei IS NOT NULL) AS api_rounding_disclosure,
  EXISTS (
    SELECT 1 FROM exchange_record_dedupe_events ev
    WHERE ev.exchange_account_id = api.exchange_account_id
      AND ev.incoming_external_id = api.external_id
  ) AS api_already_audited,
  csv.id::text AS csv_id,
  csv.external_id AS csv_external_id,
  csv.quote_asset AS csv_quote_asset,
  csv.quote_amount::text AS csv_quote_amount,
  csv.fee_asset AS csv_fee_asset,
  csv.fee_amount::text AS csv_fee_amount,
  csv.needs_review AS csv_needs_review,
  csv.duplicate_candidate AS csv_duplicate_candidate,
  (csv.eth_rounding_adjustment_wei IS NOT NULL) AS csv_rounding_disclosure,
  COALESCE(api.quote_asset IS NOT DISTINCT FROM csv.quote_asset
    OR (api.quote_asset = 'USD4' AND csv.quote_asset = 'USD'), FALSE) AS quote_asset_compatible,
  COALESCE(api.fee_asset IS NOT DISTINCT FROM csv.fee_asset
    OR (api.fee_asset = 'USD4' AND csv.fee_asset = 'USD'), FALSE) AS fee_asset_compatible,
  (api.fee_amount IS NOT DISTINCT FROM csv.fee_amount) AS fee_amount_equal,
  COALESCE(sign(api.quote_amount) = sign(csv.quote_amount)
    AND abs(api.quote_amount - csv.quote_amount) < 0.0001, FALSE) AS quote_within_rounding`;

const CANDIDATES_SQL = `SELECT ${PAIR_COLUMNS}
  FROM exchange_records api
  LEFT JOIN exchange_records csv ON ${CSV_SCOPE} AND ${PAIR_PREDICATE}
  WHERE ${API_SCOPE}
  ORDER BY api.id, csv.id`;

const REVALIDATE_SQL = `SELECT ${PAIR_COLUMNS},
    (SELECT COUNT(*) FROM exchange_records api
     JOIN exchange_records csv ON ${CSV_SCOPE} AND ${PAIR_PREDICATE}
     WHERE ${API_SCOPE} AND api.id = $2) AS api_candidates,
    (SELECT COUNT(*) FROM exchange_records api
     JOIN exchange_records csv ON ${CSV_SCOPE} AND ${PAIR_PREDICATE}
     WHERE ${API_SCOPE} AND csv.id = $3) AS csv_claims
  FROM exchange_records api
  JOIN exchange_records csv ON ${CSV_SCOPE} AND ${PAIR_PREDICATE}
  WHERE ${API_SCOPE} AND api.id = $2 AND csv.id = $3`;

// Every edge touching a group's members, one hop out: a fill that joined the
// group since planning shows up here and breaks the equal-count check.
const GROUP_SQL = `SELECT ${PAIR_COLUMNS}
  FROM exchange_records api
  JOIN exchange_records csv ON ${CSV_SCOPE} AND ${PAIR_PREDICATE}
  WHERE ${API_SCOPE} AND (api.id = ANY($2::bigint[]) OR csv.id = ANY($3::bigint[]))
  ORDER BY api.id, csv.id`;

// Every refusal is a reason code so the report can count them. A missing
// dependency map fails closed: an unchecked row is never merged.
function pairRefusals(row, dependencies) {
  const reasons = [];
  if (row.api_needs_review || row.csv_needs_review) reasons.push('needs_review');
  if (row.api_duplicate_candidate || row.csv_duplicate_candidate) reasons.push('duplicate_candidate');
  if (row.api_rounding_disclosure || row.csv_rounding_disclosure) reasons.push('manual_rounding_disclosure');
  if (row.api_already_audited) reasons.push('api_external_id_already_audited');
  if (row.quote_asset_compatible !== true) reasons.push('quote_asset_differs');
  if (row.fee_asset_compatible !== true) reasons.push('fee_asset_differs');
  if (row.fee_amount_equal !== true) reasons.push('fee_amount_differs');
  if (row.quote_within_rounding !== true) reasons.push('quote_amount_beyond_api_rounding');
  if (!dependencies) {
    reasons.push('dependencies_unchecked');
  } else {
    for (const [reference, count] of Object.entries(dependencies)) {
      if (count > 0) reasons.push(`api_referenced_by:${reference}`);
    }
  }
  return reasons;
}

function describePair(row, group = null) {
  return {
    api_id: row.api_id,
    csv_id: row.csv_id,
    symbol: row.symbol,
    base_amount: `${normalizeDecimal(row.base_amount)} ${row.base_asset}`,
    api_quote: normalizeDecimal(row.api_quote_amount),
    csv_quote: normalizeDecimal(row.csv_quote_amount),
    ...(group ? { group } : {}),
  };
}

function byNumericId(left, right) {
  const a = BigInt(left);
  const b = BigInt(right);
  return a < b ? -1 : a > b ? 1 : 0;
}

// Connected components of the API<->CSV candidate graph. The pair key is an
// equality join, so a component is normally complete; the group check below
// still verifies that instead of assuming it.
function components(candidateRows) {
  const apiEdges = new Map();
  const csvEdges = new Map();
  const firstRow = new Map();
  for (const row of candidateRows) {
    if (!apiEdges.has(row.api_id)) apiEdges.set(row.api_id, []);
    if (!firstRow.has(row.api_id)) firstRow.set(row.api_id, row);
    if (row.csv_id === null || row.csv_id === undefined) continue;
    apiEdges.get(row.api_id).push(row);
    if (!csvEdges.has(row.csv_id)) csvEdges.set(row.csv_id, []);
    csvEdges.get(row.csv_id).push(row);
  }
  const seen = new Set();
  const result = [];
  for (const start of apiEdges.keys()) {
    if (seen.has(start)) continue;
    const apiIds = new Set();
    const csvIds = new Set();
    const edges = [];
    const queue = [['api', start]];
    seen.add(start);
    while (queue.length) {
      const [side, id] = queue.shift();
      if (side === 'api') {
        apiIds.add(id);
        for (const edge of apiEdges.get(id) || []) {
          edges.push(edge);
          if (!csvIds.has(edge.csv_id)) {
            csvIds.add(edge.csv_id);
            queue.push(['csv', edge.csv_id]);
          }
        }
      } else {
        for (const edge of csvEdges.get(id) || []) {
          if (!seen.has(edge.api_id)) {
            seen.add(edge.api_id);
            queue.push(['api', edge.api_id]);
          }
        }
      }
    }
    result.push({
      apiIds: [...apiIds].sort(byNumericId),
      csvIds: [...csvIds].sort(byNumericId),
      // A fill with no twin keeps its LEFT JOIN row so it can still be named.
      rows: edges.length ? edges : [firstRow.get(start)],
    });
  }
  return result;
}

// Within one side, members must agree exactly on every leg (the pair key
// already fixes base asset/amount, order id and second); across sides each
// edge must pass pairRefusals, which applies the USD4 alias and quote
// tolerance. Text NUMERIC comparison is exact once normalized.
function sideIdentical(rows, side) {
  const fields = ['quote_asset', 'quote_amount', 'fee_asset', 'fee_amount'];
  const tuples = new Set(rows.map((row) => JSON.stringify(fields.map((field) => {
    const value = row[`${side}_${field}`];
    return field.endsWith('_amount') ? normalizeDecimal(value) : value ?? null;
  }))));
  return tuples.size === 1;
}

function groupDecision({ apiIds, csvIds, rows }, dependencies) {
  if (apiIds.length !== csvIds.length) return { reason: 'group_counts_unequal' };
  if (rows.length !== apiIds.length * csvIds.length) return { reason: 'group_not_fully_connected' };
  if (!sideIdentical(rows, 'api') || !sideIdentical(rows, 'csv')) return { reason: 'group_members_differ' };
  const memberReasons = [...new Set(rows.flatMap((row) => pairRefusals(row, dependencies.get(row.api_id))))];
  if (memberReasons.length) return { reason: 'group_member_refused', member_reasons: memberReasons };
  return null;
}

function planPairs(candidateRows, dependencies = new Map()) {
  const pairs = [];
  const ambiguous = [];
  const refused = [];
  for (const component of components(candidateRows)) {
    const { apiIds, csvIds, rows } = component;
    if (csvIds.length === 0) {
      const row = rows[0];
      ambiguous.push({
        api_id: row.api_id,
        api_external_id: row.api_external_id,
        symbol: row.symbol,
        order_id: row.order_id,
        base_amount: `${normalizeDecimal(row.base_amount)} ${row.base_asset}`,
        reason: 'no_csv_twin',
        csv_candidate_ids: [],
      });
      continue;
    }
    if (apiIds.length === 1 && csvIds.length === 1) {
      const pair = rows[0];
      const reasons = pairRefusals(pair, dependencies.get(pair.api_id));
      if (reasons.length) refused.push({ ...describePair(pair), reasons });
      else pairs.push(describePair(pair));
      continue;
    }
    const failure = groupDecision(component, dependencies);
    if (failure) {
      for (const apiId of apiIds) {
        const own = rows.filter((row) => row.api_id === apiId);
        ambiguous.push({
          api_id: apiId,
          api_external_id: own[0].api_external_id,
          symbol: own[0].symbol,
          order_id: own[0].order_id,
          base_amount: `${normalizeDecimal(own[0].base_amount)} ${own[0].base_asset}`,
          ...failure,
          csv_candidate_ids: own.map((row) => row.csv_id),
          group_api_ids: apiIds,
          group_csv_ids: csvIds,
        });
      }
      continue;
    }
    // Interchangeable: smallest API id with smallest CSV id, and so on.
    const group = `api ${apiIds.join('+')}`;
    apiIds.forEach((apiId, index) => {
      const row = rows.find((edge) => edge.api_id === apiId && edge.csv_id === csvIds[index]);
      pairs.push(describePair(row, group));
    });
  }
  return { pairs, ambiguous, refused };
}

// Discovered from the catalog rather than hardcoded: any table that can point
// at an exchange record is a reason not to delete it, including ones added
// after this script was written. Every one of them is ON DELETE CASCADE, so a
// missed reference would be silently destroyed, not merely orphaned.
async function referencingColumns(client) {
  const result = await client.query(
    `SELECT c.conrelid::regclass::text AS table_name,
            a.attname AS column_name,
            array_length(c.conkey, 1) AS width
     FROM pg_constraint c
     JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1]
     WHERE c.contype = 'f' AND c.confrelid = 'exchange_records'::regclass
     ORDER BY 1, 2`
  );
  if (!result.rows.length) {
    throw new Error('No foreign keys reference exchange_records; refusing to trust an empty dependency check');
  }
  for (const row of result.rows) {
    if (Number(row.width) !== 1) {
      throw new Error(`${row.table_name} references exchange_records through a multi-column key; extend the dependency check first`);
    }
  }
  return result.rows;
}

async function dependencyCounts(client, references, recordIds) {
  if (!recordIds.length) return new Map();
  const counts = references.map((reference, index) => (
    `(SELECT COUNT(*) FROM ${reference.table_name} WHERE ${quoteIdent(reference.column_name)} = r.id) AS d${index}`
  ));
  const result = await client.query(
    `SELECT r.id::text AS id, ${counts.join(', ')}
     FROM unnest($1::bigint[]) AS r(id)`,
    [recordIds]
  );
  return new Map(result.rows.map((row) => [
    String(row.id),
    Object.fromEntries(references.map((reference, index) => [
      `${reference.table_name}.${reference.column_name}`,
      Number(row[`d${index}`]) || 0,
    ])),
  ]));
}

async function loadAccount(client, accountId, userId, { lock }) {
  const result = await client.query(
    `SELECT id, user_id, name, exchange,
            (sync_lock_token IS NOT NULL AND sync_lock_until > CURRENT_TIMESTAMP) AS sync_in_progress
     FROM exchange_accounts
     WHERE id = $1 AND user_id = $2
     ${lock ? 'FOR UPDATE' : ''}`,
    [accountId, userId]
  );
  const account = result.rows[0];
  if (!account) throw new Error(`Exchange account ${accountId} does not belong to user ${userId}`);
  if (account.exchange !== 'binance_us') {
    throw new Error(`Exchange account ${accountId} is ${account.exchange}, not binance_us`);
  }
  if (lock && account.sync_in_progress) {
    throw new Error(`A sync for exchange account ${accountId} is running; retry after it finishes`);
  }
  return account;
}

// Same provenance shape as ExchangeRecord.mergeProvenance: a survivor with no
// history is seeded with its own snapshot before the incoming one is added.
function mergeProvenance(survivor, incoming) {
  const prior = Array.isArray(survivor.dedupe_provenance)
    ? survivor.dedupe_provenance
    : [sourceSnapshot(survivor)];
  return [...prior, sourceSnapshot(incoming)];
}

async function lockRecords(client, account, ids) {
  const locked = await client.query(
    `SELECT er.*
     FROM exchange_records er
     WHERE er.id = ANY($1::bigint[]) AND er.exchange_account_id = $2
     ORDER BY er.id
     FOR UPDATE`,
    [ids, account.id]
  );
  const byId = new Map(locked.rows.map((row) => [String(row.id), row]));
  const missing = ids.filter((id) => !byId.has(String(id)));
  if (missing.length) throw new Error(`Records ${missing.join(', ')} no longer exist in account ${account.id}`);
  return byId;
}

async function writeMerge(client, account, api, csv) {
  const fingerprint = api.fingerprint || fingerprintFor(account.exchange, api);
  if (!fingerprint) throw new Error(`API record ${api.id} has no usable fingerprint for the dedupe audit`);
  const fingerprintVersion = api.fingerprint ? (api.fingerprint_version || FINGERPRINT_VERSION) : FINGERPRINT_VERSION;

  const updated = await client.query(
    `UPDATE exchange_records
     SET dedupe_provenance = $2::jsonb
     WHERE id = $1 AND exchange_account_id = $3 AND source = 'csv'`,
    [csv.id, JSON.stringify(mergeProvenance(csv, api)), account.id]
  );
  if (updated.rowCount !== 1) throw new Error(`CSV survivor ${csv.id} was not updated`);
  await client.query(
    `INSERT INTO exchange_record_dedupe_events
       (exchange_account_id, survivor_record_id, incoming_external_id, incoming_source,
        fingerprint, fingerprint_version, incoming_snapshot)
     VALUES ($1, $2, $3, 'api', $4, $5, $6::jsonb)`,
    [account.id, csv.id, api.external_id, fingerprint, fingerprintVersion,
      JSON.stringify(sourceSnapshot(api))]
  );
  const deleted = await client.query(
    `DELETE FROM exchange_records
     WHERE id = $1 AND exchange_account_id = $2 AND source = 'api'`,
    [api.id, account.id]
  );
  if (deleted.rowCount !== 1) throw new Error(`API duplicate ${api.id} was not deleted`);
}

async function mergePair(client, account, references, pair) {
  const locked = await lockRecords(client, account, [pair.api_id, pair.csv_id]);
  const check = (await client.query(REVALIDATE_SQL, [account.id, pair.api_id, pair.csv_id])).rows[0];
  const dependencies = await dependencyCounts(client, references, [String(pair.api_id)]);
  const reasons = check ? pairRefusals(check, dependencies.get(String(pair.api_id))) : ['pair_rule_failed'];
  if (check && (Number(check.api_candidates) !== 1 || Number(check.csv_claims) !== 1)) reasons.push('not_one_to_one');
  if (reasons.length) {
    throw new Error(`Pair api ${pair.api_id} / csv ${pair.csv_id} failed revalidation: ${reasons.join(', ')}`);
  }
  await writeMerge(client, account, locked.get(String(pair.api_id)), locked.get(String(pair.csv_id)));
}

// A group is revalidated as a whole before any member is written: deleting
// the first API fill would otherwise change the counts the later ones see.
// Re-planning the locked edges must reproduce exactly the same assignment.
async function mergeGroup(client, account, references, groupPairs) {
  const apiIds = groupPairs.map((pair) => pair.api_id);
  const csvIds = groupPairs.map((pair) => pair.csv_id);
  const locked = await lockRecords(client, account, [...apiIds, ...csvIds]);
  const rows = (await client.query(GROUP_SQL, [account.id, apiIds, csvIds])).rows;
  const dependencies = await dependencyCounts(client, references, [...new Set(rows.map((row) => String(row.api_id)))]);
  const replanned = planPairs(rows, dependencies);
  const expected = JSON.stringify(groupPairs.map((pair) => [pair.api_id, pair.csv_id, pair.group]));
  const actual = JSON.stringify(replanned.pairs.map((pair) => [pair.api_id, pair.csv_id, pair.group]));
  if (replanned.ambiguous.length || replanned.refused.length || actual !== expected) {
    throw new Error(`Group ${groupPairs[0].group} failed revalidation`);
  }
  for (const pair of groupPairs) {
    await writeMerge(client, account, locked.get(String(pair.api_id)), locked.get(String(pair.csv_id)));
  }
}

function tally(items) {
  const counts = {};
  for (const item of items) {
    for (const reason of item.reasons) counts[reason] = (counts[reason] || 0) + 1;
  }
  return counts;
}

async function run({ userId, accountId, apply }, { database = pool } = {}) {
  const client = await database.connect();
  try {
    // A dry run is READ ONLY at the database level, so it can neither write
    // nor take row locks. Apply locks the account first: the CSV import and
    // the API sync both write records only while holding that row, so no new
    // twin can appear between planning and the writes.
    await client.query(apply ? 'BEGIN' : 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const account = await loadAccount(client, accountId, userId, { lock: apply });
    if (apply) {
      await client.query(
        `SELECT id FROM exchange_records
         WHERE exchange_account_id = $1 AND record_type = 'trade'
         ORDER BY id
         FOR UPDATE`,
        [account.id]
      );
    }
    const references = await referencingColumns(client);
    const csvCount = await client.query(
      `SELECT COUNT(*) AS count FROM exchange_records csv WHERE ${CSV_SCOPE}`,
      [account.id]
    );
    const candidates = (await client.query(CANDIDATES_SQL, [account.id])).rows;
    const apiIds = [...new Set(candidates.map((row) => String(row.api_id)))];
    const dependencies = await dependencyCounts(client, references, apiIds);
    const plan = planPairs(candidates, dependencies);

    if (apply) {
      const groups = new Map();
      for (const pair of plan.pairs) {
        if (!pair.group) {
          await mergePair(client, account, references, pair);
          continue;
        }
        if (!groups.has(pair.group)) groups.set(pair.group, []);
        groups.get(pair.group).push(pair);
      }
      for (const groupPairs of groups.values()) await mergeGroup(client, account, references, groupPairs);
    }
    // Deleting fills changes the derived balances, so the stored report is
    // recomputed in the same transaction, exactly as a CSV import does.
    const reconciliation = apply
      ? await ExchangeReconciliationService.recomputeForAccount(userId, account.id, { client })
      : null;
    await client.query(apply ? 'COMMIT' : 'ROLLBACK');

    const pairedCsv = new Set(candidates.filter((row) => row.csv_id != null).map((row) => String(row.csv_id)));
    return {
      apply,
      user_id: userId,
      exchange_account: { id: account.id, name: account.name, exchange: account.exchange },
      counts: {
        api_trades: apiIds.length,
        csv_trades: Number(csvCount.rows[0]?.count) || 0,
        csv_trades_without_api_twin: (Number(csvCount.rows[0]?.count) || 0) - pairedCsv.size,
        pairs: plan.pairs.length,
        group_pairs: plan.pairs.filter((pair) => pair.group).length,
        ambiguous: plan.ambiguous.length,
        refused: plan.refused.length,
        applied: apply ? plan.pairs.length : 0,
      },
      refusal_reasons: tally(plan.refused),
      ...(reconciliation ? { reconciliation_status: reconciliation.status } : {}),
      pairs: plan.pairs,
      ambiguous: plan.ambiguous,
      refused: plan.refused,
    };
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch (rollbackError) { void rollbackError; }
    throw error;
  } finally {
    client.release();
  }
}

// JSON like the sibling resolvers, but one line per pair so the list reads as
// a table and still parses.
function formatReport(report) {
  const { pairs, ambiguous, refused, ...summary } = report;
  const list = (items) => (items.length
    ? `[\n${items.map((item) => `    ${JSON.stringify(item)}`).join(',\n')}\n  ]`
    : '[]');
  const head = JSON.stringify(summary, null, 2).replace(/\n}$/, '');
  return `${head},\n  "pairs": ${list(pairs)},\n  "ambiguous": ${list(ambiguous)},\n  "refused": ${list(refused)}\n}\n`;
}

async function main() {
  const userId = positiveInteger(option('--user-id'), '--user-id');
  const accountId = positiveInteger(option('--account-id'), '--account-id');
  const apply = process.argv.includes('--apply');
  const report = await run({ userId, accountId, apply });
  process.stdout.write(formatReport(report));
}

if (require.main === module) {
  main()
    .catch((error) => {
      console.error(`Binance.US trade duplicate resolution failed: ${error.message}`);
      process.exitCode = 1;
    })
    .finally(() => pool.end().catch(() => {}));
}

module.exports = {
  planPairs,
  pairRefusals,
  mergeProvenance,
  formatReport,
  run,
};

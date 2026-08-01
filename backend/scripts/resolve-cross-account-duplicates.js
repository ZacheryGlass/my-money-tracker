#!/usr/bin/env node

'use strict';

// A narrowly-scoped resolver for exact provider replay rows that were imported
// into two separate accounts. It is intentionally separate from the ordinary
// API/CSV resolver: an account boundary is meaningful, so this path requires
// explicit survivor and duplicate account ids and refuses every non-exact or
// dependent row before it can write anything.
require('dotenv').config();
const pool = require('../src/config/database');
const ExchangeMatchService = require('../src/services/ExchangeMatchService');
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

function sameInstant(left, right) {
  const leftTime = new Date(left).getTime();
  const rightTime = new Date(right).getTime();
  return Number.isFinite(leftTime) && leftTime === rightTime;
}

function sameText(left, right) {
  if (left === null || left === undefined || left === '') return right === null || right === undefined || right === '';
  if (right === null || right === undefined || right === '') return false;
  return String(left).trim().toLowerCase() === String(right).trim().toLowerCase();
}

// Exact provider replay means the provider id and all economic/source-backed
// fields agree. Raw payloads are retained separately in provenance, so a
// harmless source-line difference between exports does not block a merge.
function recordsMatch(survivor, duplicate) {
  if (!survivor?.external_id || survivor.external_id !== duplicate?.external_id) return false;
  if (survivor.record_type !== duplicate.record_type || !sameInstant(survivor.occurred_at, duplicate.occurred_at)) return false;
  for (const field of ['base_asset', 'quote_asset', 'fee_asset', 'tx_hash', 'address', 'network']) {
    if (!sameText(survivor[field], duplicate[field])) return false;
  }
  for (const field of ['base_amount', 'quote_amount', 'fee_amount']) {
    if (normalizeDecimal(survivor[field]) !== normalizeDecimal(duplicate[field])) return false;
  }
  if (String(survivor.chain_id ?? '') !== String(duplicate.chain_id ?? '')) return false;

  const survivorFormat = survivor.raw?._format || null;
  const duplicateFormat = duplicate.raw?._format || null;
  return survivorFormat === duplicateFormat;
}

function provenanceSnapshot(record, account) {
  return {
    ...sourceSnapshot(record),
    exchange_account: {
      id: account.id,
      name: account.name,
      exchange: account.exchange,
    },
  };
}

function appendProvenance(record, snapshot) {
  const prior = Array.isArray(record.dedupe_provenance)
    ? record.dedupe_provenance
    : [snapshot];
  return [...prior, snapshot];
}

async function dependentCounts(client, recordId) {
  const result = await client.query(
    `SELECT
       (SELECT COUNT(*) FROM exchange_matches WHERE exchange_record_id = $1 OR counter_record_id = $1) AS matches,
       (SELECT COUNT(*) FROM exchange_match_verdicts WHERE exchange_record_id = $1 OR counter_record_id = $1) AS verdicts,
       (SELECT COUNT(*) FROM exchange_match_events WHERE exchange_record_id = $1 OR counter_record_id = $1) AS events,
       (SELECT COUNT(*) FROM exchange_match_suggestions WHERE exchange_record_id = $1 OR counter_record_id = $1) AS suggestions,
       (SELECT COUNT(*) FROM exchange_fiat_matches WHERE exchange_record_id = $1) AS fiat_matches,
       (SELECT COUNT(*) FROM exchange_record_dedupe_events WHERE survivor_record_id = $1) AS dedupe_events`,
    [recordId]
  );
  const row = result.rows[0] || {};
  return Object.fromEntries(Object.entries(row).map(([key, value]) => [key, Number(value) || 0]));
}

function dependencyTotal(counts) {
  return Object.values(counts).reduce((total, value) => total + value, 0);
}

async function loadAccounts(client, sourceAccountId, duplicateAccountId, userId) {
  const result = await client.query(
    `SELECT id, user_id, name, exchange
     FROM exchange_accounts
     WHERE id = ANY($1::int[]) AND user_id = $2
     ORDER BY id
     FOR UPDATE`,
    [[sourceAccountId, duplicateAccountId], userId]
  );
  if (result.rows.length !== 2) throw new Error('Both exchange accounts must belong to the requested user');
  const source = result.rows.find((row) => Number(row.id) === sourceAccountId);
  const duplicate = result.rows.find((row) => Number(row.id) === duplicateAccountId);
  if (!source || !duplicate) throw new Error('Could not identify both exchange accounts');
  if (source.exchange !== duplicate.exchange) {
    throw new Error('Cross-account merge requires the same exchange provider on both accounts');
  }
  return { source, duplicate };
}

async function loadPairs(client, sourceAccountId, duplicateAccountId, userId, accounts) {
  const result = await client.query(
    `SELECT er.*, ea.user_id, ea.name AS account_name, ea.exchange AS account_exchange
     FROM exchange_records er
     JOIN exchange_accounts ea ON ea.id = er.exchange_account_id
     WHERE er.exchange_account_id = ANY($1::int[]) AND ea.user_id = $2
     ORDER BY er.id
     FOR UPDATE`,
    [[sourceAccountId, duplicateAccountId], userId]
  );
  const sourceRows = result.rows.filter((row) => Number(row.exchange_account_id) === sourceAccountId);
  const duplicateRows = result.rows.filter((row) => Number(row.exchange_account_id) === duplicateAccountId);
  const duplicateByExternalId = new Map(duplicateRows.map((row) => [row.external_id, row]));
  const overlaps = [];
  for (const survivor of sourceRows) {
    const duplicate = duplicateByExternalId.get(survivor.external_id);
    if (!duplicate) continue;
    const reasons = [];
    if (!recordsMatch(survivor, duplicate)) reasons.push('record fields differ');
    if (survivor.needs_review || duplicate.needs_review) reasons.push('record needs review');
    if (survivor.duplicate_candidate || duplicate.duplicate_candidate) reasons.push('duplicate candidate flag is set');
    const [survivorDependencies, duplicateDependencies] = await Promise.all([
      dependentCounts(client, survivor.id),
      dependentCounts(client, duplicate.id),
    ]);
    if (dependencyTotal(survivorDependencies) > 0) reasons.push('survivor has dependencies');
    if (dependencyTotal(duplicateDependencies) > 0) reasons.push('duplicate has dependencies');
    overlaps.push({
      survivor,
      duplicate,
      reasons,
      survivorDependencies,
      duplicateDependencies,
      survivorAccount: accounts.source,
      duplicateAccount: accounts.duplicate,
    });
  }
  return overlaps;
}

async function mergePair(client, pair) {
  const { survivor, duplicate, survivorAccount, duplicateAccount } = pair;
  const fingerprint = survivor.fingerprint || duplicate.fingerprint || fingerprintFor(survivorAccount.exchange, survivor);
  if (!fingerprint) throw new Error(`Exact duplicate ${survivor.external_id} has no usable fingerprint`);
  const snapshot = provenanceSnapshot(duplicate, duplicateAccount);
  const provenance = appendProvenance(survivor, provenanceSnapshot(survivor, survivorAccount));
  provenance.push(snapshot);

  await client.query(
    `UPDATE exchange_records
     SET dedupe_provenance = $2::jsonb,
         fingerprint = COALESCE(fingerprint, $3),
         fingerprint_version = COALESCE(fingerprint_version, $4),
         needs_review = FALSE,
         duplicate_candidate = FALSE
     WHERE id = $1 AND exchange_account_id = $5`,
    [survivor.id, JSON.stringify(provenance), fingerprint, FINGERPRINT_VERSION, survivorAccount.id]
  );
  await client.query(
    `INSERT INTO exchange_record_dedupe_events
       (exchange_account_id, survivor_record_id, incoming_external_id, incoming_source,
        fingerprint, fingerprint_version, incoming_snapshot)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)`,
    [survivorAccount.id, survivor.id, duplicate.external_id, duplicate.source || null,
      fingerprint, duplicate.fingerprint_version || FINGERPRINT_VERSION, JSON.stringify(snapshot)]
  );
  await client.query(
    'DELETE FROM exchange_records WHERE id = $1 AND exchange_account_id = $2',
    [duplicate.id, duplicateAccount.id]
  );
}

async function run({ userId, sourceAccountId, duplicateAccountId, apply }) {
  if (sourceAccountId === duplicateAccountId) throw new Error('Source and duplicate accounts must differ');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const accounts = await loadAccounts(client, sourceAccountId, duplicateAccountId, userId);
    const overlaps = await loadPairs(client, sourceAccountId, duplicateAccountId, userId, accounts);
    const unsafe = overlaps.filter((pair) => pair.reasons.length > 0);
    if (unsafe.length > 0) {
      throw new Error(`${unsafe.length} exact-id overlap(s) failed the merge safety checks`);
    }
    if (!apply) {
      await client.query('ROLLBACK');
      return { apply: false, exact_overlaps: overlaps.length, eligible: overlaps.length, unsafe: 0 };
    }
    for (const pair of overlaps) await mergePair(client, pair);
    await client.query('COMMIT');
    const rebuild = await ExchangeMatchService.rebuildForUserSafely(userId, {
      exchangeAccountId: sourceAccountId,
    });
    return {
      apply: true,
      exact_overlaps: overlaps.length,
      merged: overlaps.length,
      rebuild: {
        matches: rebuild?.matches ?? null,
        suggestions: rebuild?.suggestions ?? null,
        fiat: rebuild?.fiat ?? null,
      },
    };
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch (rollbackError) { void rollbackError; }
    throw error;
  } finally {
    client.release();
  }
}

async function main() {
  const userId = positiveInteger(option('--user-id'), '--user-id');
  const sourceAccountId = positiveInteger(option('--source-account-id'), '--source-account-id');
  const duplicateAccountId = positiveInteger(option('--duplicate-account-id'), '--duplicate-account-id');
  const apply = process.argv.includes('--apply');
  const result = await run({ userId, sourceAccountId, duplicateAccountId, apply });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (require.main === module) {
  main()
    .catch((error) => {
      console.error(`Cross-account duplicate resolution failed: ${error.message}`);
      process.exitCode = 1;
    })
    .finally(() => pool.end().catch(() => {}));
}

module.exports = {
  recordsMatch,
  provenanceSnapshot,
  dependencyTotal,
  run,
};

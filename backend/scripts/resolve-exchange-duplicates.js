#!/usr/bin/env node

'use strict';

require('dotenv').config();
const fs = require('fs');
const pool = require('../src/config/database');
const {
  FINGERPRINT_VERSION,
  fingerprintFor,
  conflictingDetails,
  sourceSnapshot,
} = require('../src/services/exchangeImport/canonicalFingerprint');

function option(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? null : process.argv[index + 1] || null;
}

function positiveInteger(value, name) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error(`${name} must be a positive integer`);
  return parsed;
}

function eligibleGroups(report) {
  return (report.groups || []).filter((group) => group.ambiguous === false
    && group.conflicts?.length === 0
    && group.records?.length === 2
    && new Set(group.records.map((record) => record.source)).size === 2
    && group.records.some((record) => record.source === 'api')
    && group.records.some((record) => record.source === 'csv')
    && group.records.some((record) => String(record.id) === String(group.suggested_survivor_id)));
}

function mergeProvenance(survivor, duplicate) {
  const prior = Array.isArray(survivor.dedupe_provenance)
    ? survivor.dedupe_provenance
    : [sourceSnapshot(survivor)];
  return [...prior, sourceSnapshot(duplicate)];
}

async function dependentCount(client, recordId) {
  const result = await client.query(
    `SELECT
       (SELECT COUNT(*) FROM exchange_matches WHERE exchange_record_id = $1 OR counter_record_id = $1)
       + (SELECT COUNT(*) FROM exchange_match_verdicts WHERE exchange_record_id = $1 OR counter_record_id = $1)
       + (SELECT COUNT(*) FROM exchange_match_events WHERE exchange_record_id = $1 OR counter_record_id = $1)
       AS count`,
    [recordId]
  );
  return Number(result.rows[0].count);
}

async function resolveGroup(client, group, userId) {
  const ids = group.records.map((record) => record.id);
  const result = await client.query(
    `SELECT er.*, ea.user_id, ea.exchange
     FROM exchange_records er
     JOIN exchange_accounts ea ON ea.id = er.exchange_account_id
     WHERE er.id = ANY($1::bigint[]) AND ea.user_id = $2
     ORDER BY er.id
     FOR UPDATE OF er`,
    [ids, userId]
  );
  if (result.rows.length !== 2) throw new Error(`candidate group ${group.fingerprint} no longer has two owned rows`);
  const survivor = result.rows.find((row) => String(row.id) === String(group.suggested_survivor_id));
  const duplicate = result.rows.find((row) => row !== survivor);
  if (!survivor || !duplicate) throw new Error(`candidate group ${group.fingerprint} has no declared survivor`);
  const survivorFingerprint = survivor.fingerprint || fingerprintFor(survivor.exchange, survivor);
  const duplicateFingerprint = duplicate.fingerprint || fingerprintFor(duplicate.exchange, duplicate);
  if (survivor.exchange_account_id !== duplicate.exchange_account_id
      || survivorFingerprint !== group.fingerprint
      || duplicateFingerprint !== group.fingerprint) {
    throw new Error(`candidate group ${group.fingerprint} changed since the report`);
  }
  if (survivor.source === duplicate.source || !['api', 'csv'].includes(survivor.source)
      || !['api', 'csv'].includes(duplicate.source)) {
    throw new Error(`candidate group ${group.fingerprint} is not one API and one CSV row`);
  }
  const conflicts = conflictingDetails(survivor, duplicate);
  if (conflicts.length) throw new Error(`candidate group ${group.fingerprint} now conflicts on ${conflicts.join(', ')}`);
  if (await dependentCount(client, duplicate.id)) {
    throw new Error(`duplicate record ${duplicate.id} has matches or verdicts; adjudicate it separately`);
  }

  const provenance = mergeProvenance(survivor, duplicate);
  await client.query(
    `UPDATE exchange_records
     SET tx_hash = COALESCE(tx_hash, $2),
         address = COALESCE(address, $3),
         network = COALESCE(network, $4),
         chain_id = COALESCE(chain_id, $5),
         source = CASE WHEN source = 'api' OR $6 = 'api' THEN 'api' ELSE COALESCE(source, $6) END,
         needs_review = needs_review OR $7,
         dedupe_provenance = $8::jsonb,
         fingerprint = $9,
         fingerprint_version = COALESCE(fingerprint_version, $10),
         duplicate_candidate = FALSE
     WHERE id = $1`,
    [survivor.id, duplicate.tx_hash, duplicate.address, duplicate.network, duplicate.chain_id,
      duplicate.source, duplicate.needs_review, JSON.stringify(provenance), group.fingerprint,
      FINGERPRINT_VERSION]
  );
  await client.query(
    `INSERT INTO exchange_record_dedupe_events
       (exchange_account_id, survivor_record_id, incoming_external_id, incoming_source,
        fingerprint, fingerprint_version, incoming_snapshot)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)`,
    [survivor.exchange_account_id, survivor.id, duplicate.external_id, duplicate.source,
      group.fingerprint, duplicate.fingerprint_version || FINGERPRINT_VERSION,
      JSON.stringify(sourceSnapshot(duplicate))]
  );
  await client.query('DELETE FROM exchange_records WHERE id = $1', [duplicate.id]);
  return { survivor_id: survivor.id, removed_id: duplicate.id, fingerprint: group.fingerprint };
}

async function main() {
  const reportPath = option('--report');
  if (!reportPath) throw new Error('--report is required');
  const userId = positiveInteger(option('--user-id'), '--user-id');
  const apply = process.argv.includes('--apply');
  const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
  const groups = eligibleGroups(report);
  if (!groups.length) {
    process.stdout.write(`${JSON.stringify({ apply, eligible_groups: 0, resolved: [] }, null, 2)}\n`);
    return;
  }
  if (!apply) {
    process.stdout.write(`${JSON.stringify({
      apply: false,
      eligible_groups: groups.length,
      decisions: groups.map((group) => ({
        fingerprint: group.fingerprint,
        survivor_id: group.suggested_survivor_id,
        duplicate_ids: group.records.filter((record) => String(record.id) !== String(group.suggested_survivor_id)).map((record) => record.id),
      })),
    }, null, 2)}\n`);
    return;
  }

  const client = await pool.connect();
  const resolved = [];
  try {
    await client.query('BEGIN');
    for (const group of groups) resolved.push(await resolveGroup(client, group, userId));
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
  process.stdout.write(`${JSON.stringify({ apply: true, eligible_groups: groups.length, resolved }, null, 2)}\n`);
}

if (require.main === module) {
  main()
    .catch((error) => {
      console.error(`Duplicate resolution failed: ${error.message}`);
      process.exitCode = 1;
    })
    .finally(() => pool.end().catch(() => {}));
}

module.exports = { eligibleGroups };

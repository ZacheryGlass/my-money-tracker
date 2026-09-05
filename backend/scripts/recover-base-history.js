#!/usr/bin/env node

'use strict';

require('dotenv').config();
const { Client } = require('pg');

const CHAIN_ID = 8453;
const SOURCE_ENV = 'BASE_RECOVERY_SOURCE_DATABASE_URL';

const TABLE_SPECS = [
  {
    table: 'evm_audit_scopes',
    where: 'chain_id = $1',
    orderBy: 'id',
    batchSize: 250,
  },
  {
    table: 'evm_provider_pages',
    where: 'scope_id IN (SELECT id FROM evm_audit_scopes WHERE chain_id = $1)',
    orderBy: 'id',
    batchSize: 10,
  },
  {
    table: 'evm_provider_observations',
    where: 'chain_id = $1',
    orderBy: 'id',
    batchSize: 250,
  },
  {
    table: 'evm_job_observations',
    where: 'chain_id = $1',
    orderBy: 'job_id, observation_id',
    batchSize: 1000,
  },
  {
    table: 'evm_mined_transactions',
    where: 'chain_id = $1',
    orderBy: 'id',
    batchSize: 250,
  },
  {
    table: 'evm_transaction_evidence',
    where: 'chain_id = $1',
    orderBy: 'transaction_id, observation_id',
    batchSize: 1000,
  },
  {
    table: 'evm_canonical_effects',
    where: 'chain_id = $1',
    orderBy: 'id',
    batchSize: 250,
  },
  {
    table: 'evm_effect_evidence',
    where: 'chain_id = $1',
    orderBy: 'effect_id, observation_id',
    batchSize: 1000,
  },
  {
    table: 'evm_balance_audits',
    where: 'chain_id = $1',
    orderBy: 'id',
    batchSize: 500,
  },
  {
    table: 'evm_nonce_audits',
    where: 'chain_id = $1',
    orderBy: 'id',
    batchSize: 500,
  },
  {
    table: 'evm_source_coverage',
    where: 'chain_id = $1',
    orderBy: 'id',
    batchSize: 500,
  },
  {
    table: 'eth_wallet_chains',
    where: 'chain_id = $1',
    orderBy: 'wallet_id',
    batchSize: 250,
  },
  {
    table: 'eth_transfers',
    where: 'chain_id = $1',
    orderBy: 'id',
    batchSize: 250,
  },
  {
    // Preserve the last known projection without rebuilding unrelated chains.
    // The genesis recapture replaces it through the canonical pipeline after
    // live provider access has been authorized and measured.
    table: 'eth_activity',
    where: 'chain_id = $1',
    orderBy: 'id',
    batchSize: 250,
  },
  {
    table: 'eth_activity_overrides',
    where: 'chain_id = $1',
    orderBy: 'id',
    batchSize: 250,
  },
  {
    table: 'eth_reconciliation_adjustments',
    where: 'chain_id = $1',
    orderBy: 'id',
    batchSize: 250,
  },
];

const ID_TABLES = TABLE_SPECS
  .map((spec) => spec.table)
  .filter((table) => ![
    'evm_job_observations', 'evm_transaction_evidence', 'evm_effect_evidence',
    'eth_wallet_chains',
  ].includes(table));

const UNSUPPORTED_SOURCE_SURFACES = [
  ['eth_bridge_verdicts', 'out_chain_id = $1 OR in_chain_id = $1'],
  ['eth_bridge_suggestions', 'out_chain_id = $1 OR in_chain_id = $1'],
  [
    'eth_bridge_movements',
    "protocol = 'base' OR id IN (SELECT movement_id FROM eth_bridge_movement_members WHERE chain_id = $1)",
  ],
  ['eth_bridge_movement_members', 'chain_id = $1'],
  ['eth_bridge_receipt_attempts', 'chain_id = $1'],
  ['eth_bridge_receipts', 'chain_id = $1'],
  ['eth_discovery_fetches', 'chain_id = $1'],
  ['eth_discovery_candidates', 'chain_id = $1'],
  ['exchange_match_verdicts', 'chain_id = $1'],
  ['exchange_records', 'chain_id = $1'],
];

function quoteIdent(value) {
  if (!/^[a-z_][a-z0-9_]*$/i.test(value)) throw new Error(`Unsafe SQL identifier: ${value}`);
  return `"${value}"`;
}

function mergeChains(current, archived) {
  const result = [];
  for (const value of [...(current || []), ...(archived || [])]) {
    const normalized = Number(value);
    if (!Number.isSafeInteger(normalized) || normalized <= 0 || result.includes(normalized)) continue;
    result.push(normalized);
  }
  return result;
}

function sanitizeRecoveredJob(row, now = new Date()) {
  const copy = { ...row };
  if (['queued', 'running', 'deferred'].includes(copy.status)) {
    copy.status = 'cancelled';
    copy.finished_at = copy.finished_at || now;
  }
  copy.lease_owner = null;
  copy.lease_expires_at = null;
  copy.heartbeat_at = null;
  copy.superseded_by_job_id = null;
  delete copy.cdp_credential_generation;
  return copy;
}

function buildInsertStatement(table, columns, rowCount, conflictClause = 'DO NOTHING') {
  if (!Number.isSafeInteger(rowCount) || rowCount < 1) throw new Error('rowCount must be positive');
  const names = columns.map(quoteIdent).join(', ');
  let index = 1;
  const values = Array.from({ length: rowCount }, () => (
    `(${columns.map(() => `$${index++}`).join(', ')})`
  )).join(', ');
  return `INSERT INTO ${quoteIdent(table)} (${names}) VALUES ${values} ON CONFLICT ${conflictClause}`;
}

function encodeInsertParams(columns, rows, jsonColumns = new Set()) {
  return rows.flatMap((row) => columns.map((column) => {
    const value = row[column];
    if (!jsonColumns.has(column) || value == null || typeof value === 'string') return value;
    return JSON.stringify(value);
  }));
}

function sourceSelectList(columns, jsonColumns = new Set()) {
  return columns.map((column) => (
    jsonColumns.has(column)
      ? `${quoteIdent(column)}::text AS ${quoteIdent(column)}`
      : quoteIdent(column)
  )).join(', ');
}

async function columnsFor(client, table) {
  const result = await client.query(
    `SELECT column_name
       FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = $1
      ORDER BY ordinal_position`,
    [table]
  );
  return result.rows.map((row) => row.column_name);
}

async function jsonColumnsFor(client, table) {
  const result = await client.query(
    `SELECT column_name
       FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = $1
        AND data_type IN ('json', 'jsonb')`,
    [table]
  );
  return new Set(result.rows.map((row) => row.column_name));
}

async function commonColumns(source, target, table) {
  const [sourceColumns, targetColumns] = await Promise.all([
    columnsFor(source, table),
    columnsFor(target, table),
  ]);
  if (!sourceColumns.length) throw new Error(`Source table is missing: ${table}`);
  if (!targetColumns.length) throw new Error(`Destination table is missing: ${table}`);
  const targetSet = new Set(targetColumns);
  return sourceColumns.filter((column) => targetSet.has(column));
}

async function countRows(client, table, where) {
  const result = await client.query(
    `SELECT count(*)::text AS count FROM ${quoteIdent(table)} WHERE ${where}`,
    [CHAIN_ID]
  );
  return Number(result.rows[0].count);
}

async function insertRows(
  target,
  table,
  columns,
  rows,
  conflictClause = 'DO NOTHING',
  jsonColumns = new Set()
) {
  if (!rows.length) return 0;
  const params = encodeInsertParams(columns, rows, jsonColumns);
  const result = await target.query(
    buildInsertStatement(table, columns, rows.length, conflictClause),
    params
  );
  return result.rowCount;
}

async function copyTable(source, target, spec) {
  const columns = await commonColumns(source, target, spec.table);
  const jsonColumns = await jsonColumnsFor(target, spec.table);
  const sourceCount = await countRows(source, spec.table, spec.where);
  const beforeCount = await countRows(target, spec.table, spec.where);
  if (beforeCount !== 0 && beforeCount !== sourceCount) {
    throw new Error(
      `${spec.table}: destination has ${beforeCount} Base rows; expected 0 or the archive's ${sourceCount}`
    );
  }
  if (beforeCount === sourceCount) {
    return { source: sourceCount, before: beforeCount, inserted: 0, after: beforeCount };
  }

  let offset = 0;
  let inserted = 0;
  while (offset < sourceCount) {
    const result = await source.query(
      `SELECT ${sourceSelectList(columns, jsonColumns)}
         FROM ${quoteIdent(spec.table)}
        WHERE ${spec.where}
        ORDER BY ${spec.orderBy}
        LIMIT $2 OFFSET $3`,
      [CHAIN_ID, spec.batchSize, offset]
    );
    if (!result.rows.length) break;
    inserted += await insertRows(target, spec.table, columns, result.rows, 'DO NOTHING', jsonColumns);
    offset += result.rows.length;
  }

  const afterCount = await countRows(target, spec.table, spec.where);
  if (afterCount !== sourceCount) {
    throw new Error(`${spec.table}: restored ${afterCount} of ${sourceCount} archived Base rows`);
  }
  return { source: sourceCount, before: beforeCount, inserted, after: afterCount };
}

async function assertMatchingRoots(source, target, table, sourceSql) {
  const sourceRows = (await source.query(sourceSql, [CHAIN_ID])).rows;
  if (!sourceRows.length) throw new Error(`Archive has no Base-linked ${table} rows`);
  const ids = sourceRows.map((row) => row.id);
  const targetRows = (await target.query(
    `SELECT id, user_id, address FROM ${quoteIdent(table)} WHERE id = ANY($1::bigint[])`,
    [ids]
  )).rows;
  const targetById = new Map(targetRows.map((row) => [String(row.id), row]));
  for (const sourceRow of sourceRows) {
    const targetRow = targetById.get(String(sourceRow.id));
    if (!targetRow
      || Number(targetRow.user_id) !== Number(sourceRow.user_id)
      || targetRow.address !== sourceRow.address) {
      throw new Error(`${table} id ${sourceRow.id} does not identify the same owner/address in both databases`);
    }
  }
  return sourceRows.length;
}

async function preflight(source, target) {
  const [sourceIdentity, targetIdentity] = await Promise.all([
    source.query('SELECT current_database() AS database, inet_server_addr()::text AS host, inet_server_port() AS port'),
    target.query('SELECT current_database() AS database, inet_server_addr()::text AS host, inet_server_port() AS port'),
  ]);
  const sourceKey = JSON.stringify(sourceIdentity.rows[0]);
  const targetKey = JSON.stringify(targetIdentity.rows[0]);
  if (sourceKey === targetKey) throw new Error('Source and destination resolve to the same database');

  const wallets = await assertMatchingRoots(
    source,
    target,
    'eth_wallets',
    `SELECT DISTINCT w.id, w.user_id, w.address
       FROM eth_wallets w
       JOIN eth_wallet_chains wc ON wc.wallet_id = w.id
      WHERE wc.chain_id = $1
      ORDER BY w.id`
  );
  const subjects = await assertMatchingRoots(
    source,
    target,
    'evm_subjects',
    `SELECT DISTINCT s.id, s.user_id, s.address
       FROM evm_subjects s
      WHERE EXISTS (
        SELECT 1 FROM evm_provider_observations o
         WHERE o.subject_id = s.id AND o.chain_id = $1
      )
      ORDER BY s.id`
  );

  const unsupported = [];
  for (const [table, where] of UNSUPPORTED_SOURCE_SURFACES) {
    const count = await countRows(source, table, where);
    if (count) unsupported.push({ table, rows: count });
  }
  if (unsupported.length) {
    throw new Error(`Archive contains unsupported Base state: ${JSON.stringify(unsupported)}`);
  }

  return { wallets, subjects, unsupported_source_surfaces: unsupported };
}

async function recoverJobs(source, target) {
  const columns = (await commonColumns(source, target, 'evm_audit_jobs'))
    .filter((column) => column !== 'superseded_by_job_id');
  const jsonColumns = await jsonColumnsFor(target, 'evm_audit_jobs');
  const sourceResult = await source.query(
    `SELECT * FROM evm_audit_jobs
      WHERE requested_chains @> jsonb_build_array($1::bigint)
         OR discovered_chains @> jsonb_build_array($1::bigint)
      ORDER BY id`,
    [CHAIN_ID]
  );
  const sourceRows = sourceResult.rows;
  if (!sourceRows.length) throw new Error('Archive has no audit jobs linked to Base');

  const ids = sourceRows.map((row) => row.id);
  const targetRows = (await target.query(
    'SELECT * FROM evm_audit_jobs WHERE id = ANY($1::bigint[]) OR (user_id, idempotency_key) IN (SELECT user_id, idempotency_key FROM evm_audit_jobs WHERE id = ANY($1::bigint[]))',
    [ids]
  )).rows;
  const targetById = new Map(targetRows.map((row) => [String(row.id), row]));
  let inserted = 0;

  for (const sourceRow of sourceRows) {
    const existing = targetById.get(String(sourceRow.id));
    if (existing) {
      if (Number(existing.user_id) !== Number(sourceRow.user_id)
        || String(existing.subject_id) !== String(sourceRow.subject_id)
        || existing.idempotency_key !== sourceRow.idempotency_key) {
        throw new Error(`Audit job id ${sourceRow.id} conflicts with a different destination job`);
      }
    } else {
      const conflict = await target.query(
        'SELECT id FROM evm_audit_jobs WHERE user_id = $1 AND idempotency_key = $2',
        [sourceRow.user_id, sourceRow.idempotency_key]
      );
      if (conflict.rows.length) {
        throw new Error(`Audit job ${sourceRow.id} conflicts on idempotency key with job ${conflict.rows[0].id}`);
      }
      const recovered = sanitizeRecoveredJob(sourceRow);
      inserted += await insertRows(
        target, 'evm_audit_jobs', columns, [recovered], 'DO NOTHING', jsonColumns
      );
    }

    const current = existing || {};
    await target.query(
      `UPDATE evm_audit_jobs
          SET requested_chains = $2::jsonb,
              discovered_chains = $3::jsonb
        WHERE id = $1`,
      [
        sourceRow.id,
        JSON.stringify(mergeChains(current.requested_chains, sourceRow.requested_chains)),
        JSON.stringify(mergeChains(current.discovered_chains, sourceRow.discovered_chains)),
      ]
    );
  }

  for (const sourceRow of sourceRows) {
    if (sourceRow.superseded_by_job_id == null) continue;
    const reference = await target.query('SELECT 1 FROM evm_audit_jobs WHERE id = $1', [
      sourceRow.superseded_by_job_id,
    ]);
    if (reference.rows.length) {
      await target.query(
        'UPDATE evm_audit_jobs SET superseded_by_job_id = $2 WHERE id = $1',
        [sourceRow.id, sourceRow.superseded_by_job_id]
      );
    }
  }

  const restored = await target.query(
    `SELECT count(*)::text AS count FROM evm_audit_jobs
      WHERE requested_chains @> jsonb_build_array($1::bigint)
         OR discovered_chains @> jsonb_build_array($1::bigint)`,
    [CHAIN_ID]
  );
  const after = Number(restored.rows[0].count);
  if (after !== sourceRows.length) {
    throw new Error(`evm_audit_jobs: restored ${after} of ${sourceRows.length} archived Base jobs`);
  }
  return { source: sourceRows.length, inserted, after };
}

async function recoverAttempts(source, target) {
  const table = 'evm_provider_attempts';
  const columns = await commonColumns(source, target, table);
  const jsonColumns = await jsonColumnsFor(target, table);
  const where = 'scope_id IN (SELECT id FROM evm_audit_scopes WHERE chain_id = $1)';
  const sourceCount = await countRows(source, table, where);
  let offset = 0;
  let inserted = 0;
  while (offset < sourceCount) {
    const result = await source.query(
      `SELECT ${sourceSelectList(columns, jsonColumns)} FROM evm_provider_attempts
        WHERE ${where} ORDER BY id LIMIT $2 OFFSET $3`,
      [CHAIN_ID, 250, offset]
    );
    if (!result.rows.length) break;
    inserted += await insertRows(
      target,
      table,
      columns,
      result.rows,
      'DO NOTHING',
      jsonColumns
    );
    offset += result.rows.length;
  }
  const after = await countRows(target, table, where);
  if (after !== sourceCount) {
    throw new Error(`${table}: restored ${after} of ${sourceCount} archived Base attempts`);
  }
  return { source: sourceCount, inserted, after };
}

async function resetWalletCursors(target) {
  const result = await target.query(
    `UPDATE eth_wallet_chains
        SET last_block_normal = 0,
            last_block_internal = 0,
            last_block_token = 0,
            last_block_nft = 0,
            last_block_1155 = 0,
            last_block_statesync = 0,
            ingest_version = 2,
            error_code = NULL,
            error_message = NULL,
            unsupported_feeds = '{}',
            last_synced_at = NULL,
            updated_at = CURRENT_TIMESTAMP
      WHERE chain_id = $1`,
    [CHAIN_ID]
  );
  return result.rowCount;
}

async function advanceSequences(target) {
  for (const table of ['evm_audit_jobs', ...ID_TABLES]) {
    const sequenceResult = await target.query(
      'SELECT pg_get_serial_sequence($1, $2) AS sequence',
      [`public.${table}`, 'id']
    );
    const sequence = sequenceResult.rows[0]?.sequence;
    if (!sequence) continue;
    const [schema, name] = sequence.split('.');
    await target.query(
      `SELECT setval(
         $1::regclass,
         GREATEST(
           (SELECT last_value FROM ${quoteIdent(schema)}.${quoteIdent(name)}),
           (SELECT COALESCE(max(id), 1) FROM ${quoteIdent(table)})
         ),
         true
       )`,
      [sequence]
    );
  }
}

async function sourceCounts(source) {
  const counts = {};
  for (const spec of TABLE_SPECS) counts[spec.table] = await countRows(source, spec.table, spec.where);
  const jobs = await source.query(
    `SELECT count(*)::text AS count FROM evm_audit_jobs
      WHERE requested_chains @> jsonb_build_array($1::bigint)
         OR discovered_chains @> jsonb_build_array($1::bigint)`,
    [CHAIN_ID]
  );
  counts.evm_audit_jobs = Number(jobs.rows[0].count);
  counts.evm_provider_attempts = await countRows(
    source,
    'evm_provider_attempts',
    'scope_id IN (SELECT id FROM evm_audit_scopes WHERE chain_id = $1)'
  );
  return counts;
}

async function recover(source, target) {
  await target.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
  try {
    await target.query("SELECT pg_advisory_xact_lock(hashtextextended('recover-base-history-8453', 0))");
    const jobs = await recoverJobs(source, target);
    const tables = {};
    for (const spec of TABLE_SPECS) {
      tables[spec.table] = await copyTable(source, target, spec);
      if (spec.table === 'evm_audit_scopes') {
        tables.evm_provider_attempts = await recoverAttempts(source, target);
      }
    }
    const cursorsReset = await resetWalletCursors(target);
    await advanceSequences(target);
    await target.query('COMMIT');
    return { jobs, tables, wallet_cursors_reset: cursorsReset };
  } catch (error) {
    await target.query('ROLLBACK');
    throw error;
  }
}

async function main() {
  const apply = process.argv.includes('--apply');
  const sourceUrl = process.env[SOURCE_ENV];
  const targetUrl = process.env.DATABASE_URL;
  if (!sourceUrl) throw new Error(`${SOURCE_ENV} is required`);
  if (!targetUrl) throw new Error('DATABASE_URL is required');

  const source = new Client({ connectionString: sourceUrl, application_name: 'base-recovery-source' });
  const target = new Client({ connectionString: targetUrl, application_name: 'base-recovery-target' });
  await Promise.all([source.connect(), target.connect()]);
  let users;
  try {
    const preflightResult = await preflight(source, target);
    const counts = await sourceCounts(source);
    users = (await source.query(
      `SELECT DISTINCT w.user_id
         FROM eth_wallets w
         JOIN eth_wallet_chains wc ON wc.wallet_id = w.id
        WHERE wc.chain_id = $1
        ORDER BY w.user_id`,
      [CHAIN_ID]
    )).rows.map((row) => Number(row.user_id));
    if (!apply) {
      process.stdout.write(`${JSON.stringify({
        mode: 'dry-run',
        read_only: true,
        chain_id: CHAIN_ID,
        preflight: preflightResult,
        archived_rows: counts,
        affected_user_count: users.length,
      }, null, 2)}\n`);
      return;
    }
    const result = await recover(source, target);
    process.stdout.write(`${JSON.stringify({
      mode: 'apply',
      chain_id: CHAIN_ID,
      raw_recovery: result,
      affected_user_count: users.length,
    }, null, 2)}\n`);
  } finally {
    await Promise.allSettled([source.end(), target.end()]);
  }

}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  CHAIN_ID,
  TABLE_SPECS,
  UNSUPPORTED_SOURCE_SURFACES,
  quoteIdent,
  mergeChains,
  sanitizeRecoveredJob,
  buildInsertStatement,
  encodeInsertParams,
  sourceSelectList,
  preflight,
  sourceCounts,
  recover,
};

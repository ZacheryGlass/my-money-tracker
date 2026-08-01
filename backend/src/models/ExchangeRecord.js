'use strict';

const pool = require('../config/database');
const logger = require('../config/logger');
const {
  FINGERPRINT_VERSION,
  conflictingDetails,
  sourceSnapshot,
} = require('../services/exchangeImport/canonicalFingerprint');

const COLUMNS = [
  'record_type', 'occurred_at', 'base_asset', 'base_amount', 'quote_asset', 'quote_amount',
  'fee_asset', 'fee_amount', 'tx_hash', 'address', 'external_id', 'needs_review', 'raw',
  // 'csv' | 'api' | NULL for rows imported before migration 040. Provenance
  // only: the cross-source fingerprint is stored separately and the raw
  // provider spelling remains available in dedupe_provenance.
  'source',
  // Provider network spelling plus normalized EVM chain id when known. Both
  // are nullable for legacy rows and non-EVM records.
  'network', 'chain_id', 'fingerprint', 'fingerprint_version',
  'dedupe_provenance', 'duplicate_candidate',
];

// Everything the upgrade rewrites: the whole record except its identity
// (exchange_account_id, external_id) and when it first landed.
const UPGRADE_COLUMNS = COLUMNS.filter((column) => column !== 'external_id');

// Rows per INSERT. Postgres caps a statement at 65535 bind parameters, and at
// 16 columns per row that is ~3800 rows; 250 keeps each statement small enough
// to stay readable in a log without making a 1200-row ledger chatty.
const CHUNK_SIZE = 250;

// base_amount and friends are NUMERIC(38,18): 20 digits left of the point.
const MAX_INTEGER_DIGITS = 20;
const NUMERIC_COLUMNS = ['base_amount', 'quote_amount', 'fee_amount'];

// Postgres codes that mean "this particular value is unstorable", as opposed to
// a server or connection fault. They are the user's problem to see, not a 500:
// numeric overflow, an untranslatable character (a NUL arriving in text), and a
// value that is not a valid literal for its type.
const BAD_VALUE_CODES = new Set(['22003', '22P05', '22P02']);

// A NUL byte is legal in JSON and illegal in a Postgres text or jsonb value, so
// one character in a note aborts an otherwise good 1200-row import.
// eslint-disable-next-line no-control-regex
const NUL_BYTE = /\u0000/g;
const NUL_CHAR = '\u0000';

const IDENTITY_COLUMNS = new Set(['external_id']);

function stripNulls(value) {
  if (typeof value === 'string') return value.replace(NUL_BYTE, '');
  if (Array.isArray(value)) return value.map(stripNulls);
  if (value && typeof value === 'object') {
    const cleaned = {};
    for (const [key, nested] of Object.entries(value)) {
      cleaned[stripNulls(key)] = stripNulls(nested);
    }
    return cleaned;
  }
  return value;
}

function integerDigits(amount) {
  const text = String(amount).trim().replace(/^[+-]/, '');
  const [whole = ''] = text.split('.');
  return whole.replace(/^0+(?=\d)/, '').length;
}

// Which row Postgres choked on. The error itself names only the type and the
// value, never the record, and "one of these 250 rows is wrong" is not
// something a user can act on.
function describeBadRecord(chunk) {
  for (const record of chunk) {
    for (const column of NUMERIC_COLUMNS) {
      const amount = record[column];
      if (amount !== null && amount !== undefined && integerDigits(amount) > MAX_INTEGER_DIGITS) {
        return { externalId: record.external_id, detail: `${column} ${amount} is too large to store` };
      }
    }
    const withNulls = COLUMNS.find((column) => typeof record[column] === 'string' && record[column].includes(NUL_CHAR));
    if (withNulls) {
      return { externalId: record.external_id, detail: `${withNulls} contains a NUL character` };
    }
  }
  return { externalId: chunk[0]?.external_id ?? null, detail: null };
}

function jsonValue(value) {
  if (value === null || value === undefined) return null;
  return JSON.stringify(stripNulls(value));
}

function mergeProvenance(existing, incoming) {
  const prior = Array.isArray(existing?.dedupe_provenance)
    ? existing.dedupe_provenance
    : [sourceSnapshot(existing)];
  return [...prior, sourceSnapshot(incoming)];
}

function mergeCandidate(existing, incoming) {
  const merged = { ...existing };
  for (const field of ['tx_hash', 'address', 'network', 'chain_id']) {
    if ((merged[field] === null || merged[field] === undefined || merged[field] === '')
        && incoming[field] !== null && incoming[field] !== undefined && incoming[field] !== '') {
      merged[field] = incoming[field];
    }
  }
  merged.source = existing.source === 'api' || incoming.source === 'api'
    ? 'api' : (existing.source || incoming.source || null);
  merged.fingerprint = existing.fingerprint || incoming.fingerprint;
  merged.fingerprint_version = existing.fingerprint_version || incoming.fingerprint_version || FINGERPRINT_VERSION;
  merged.dedupe_provenance = mergeProvenance(existing, incoming);
  // A review decision is never silently downgraded by a second source.
  merged.needs_review = Boolean(existing.needs_review || incoming.needs_review);
  merged.duplicate_candidate = false;
  return merged;
}

function candidateMarker(record, candidates, conflicts = []) {
  const raw = record.raw && typeof record.raw === 'object' ? { ...record.raw } : {};
  raw._dedupe = {
    kind: 'candidate',
    fingerprint: record.fingerprint,
    candidate_external_ids: candidates.map((candidate) => candidate.external_id),
    conflicts,
  };
  return raw;
}

function candidateRowsByFingerprint(existingRows) {
  const byFingerprint = new Map();
  for (const row of existingRows) {
    if (!row.fingerprint) continue;
    const rows = byFingerprint.get(row.fingerprint) || [];
    rows.push(row);
    byFingerprint.set(row.fingerprint, rows);
  }
  return byFingerprint;
}

function candidateRowsByExternalId(existingRows) {
  return new Map(existingRows.map((row) => [row.external_id, row]));
}

function updateValues(record) {
  return COLUMNS.map((column) => {
    if (column === 'raw' || column === 'dedupe_provenance') return jsonValue(record[column]);
    return record[column] ?? null;
  });
}

class ExchangeRecord {
  // Idempotent by construction: UNIQUE (exchange_account_id, external_id) is
  // what makes re-uploading a longer export insert only the rows that are new.
  //
  // The conflict is an UPGRADE, not a no-op, but only in one direction: a
  // complete record replaces the review-flagged placeholder an earlier,
  // truncated export left behind, and never the reverse. Both files key the
  // same event the same way, so without this the fuller import would hit the
  // half record and be discarded -- silently, and permanently. An identical
  // re-import changes nothing: both rows carry the same needs_review, so the
  // guard fails and the row is counted as a duplicate.
  static async bulkInsert(exchangeAccountId, records, { syncLockToken = null } = {}) {
    if (!exchangeAccountId) throw new Error('ExchangeRecord.bulkInsert requires an exchangeAccountId');
    if (!records || records.length === 0) {
      return { inserted: 0, upgraded: 0, duplicates: 0, total: 0 };
    }

    // Two rows in one file can carry the same external_id only when the export
    // itself repeats an id. Collapsing them here keeps the counts honest, and
    // is also required: ON CONFLICT DO UPDATE refuses to touch the same row
    // twice in one statement. The better-known of the two wins, for the same
    // reason the cross-import upgrade exists.
    const byId = new Map();
    let duplicatesInFile = 0;
    for (const record of records) {
      const existing = byId.get(record.external_id);
      if (!existing) { byId.set(record.external_id, record); continue; }
      duplicatesInFile += 1;
      if (existing.needs_review && !record.needs_review) byId.set(record.external_id, record);
    }
    const unique = [...byId.values()];

    const client = await pool.connect();
    let inserted = 0;
    let upgraded = 0;
    let deduplicated = 0;
    let duplicateCandidates = 0;
    let duplicateConflicts = 0;
    let recordsToInsertCount = 0;
    let dedupeReplays = 0;
    try {
      await client.query('BEGIN');
      if (syncLockToken) {
        // Keep the account row locked for the whole insert transaction. A
        // credential clear either happens first (and this ownership check
        // fails) or waits for the transaction to commit; it cannot slip
        // between a separate SELECT and the INSERT statements.
        const owner = await client.query(
          `SELECT id
           FROM exchange_accounts
           WHERE id = $1 AND sync_lock_token = $2::uuid AND sync_lock_until > CURRENT_TIMESTAMP
           FOR UPDATE`,
          [exchangeAccountId, syncLockToken]
        );
        if (!owner.rows[0]) {
          const error = new Error('The exchange sync lost ownership before storing provider rows');
          error.code = 'EXCHANGE_SYNC_LOCK_LOST';
          throw error;
        }
      } else {
        // CSV imports do not carry a sync lease. Serializing writes per account
        // closes the candidate-check/insert race without widening ownership.
        await client.query(
          'SELECT id FROM exchange_accounts WHERE id = $1 FOR UPDATE',
          [exchangeAccountId]
        );
      }

      const externalIds = unique.map((record) => record.external_id);
      const fingerprints = unique.map((record) => record.fingerprint).filter(Boolean);
      const existingResult = await client.query(
        `SELECT er.*
         FROM exchange_records er
         WHERE er.exchange_account_id = $1
           AND (er.external_id = ANY($2::text[])
             OR er.fingerprint = ANY($3::text[]))
         FOR UPDATE`,
        [exchangeAccountId, externalIds, fingerprints]
      );
      const existingById = candidateRowsByExternalId(existingResult.rows);
      const existingByFingerprint = candidateRowsByFingerprint(existingResult.rows);
      const dedupeAuditResult = await client.query(
        `SELECT incoming_external_id
         FROM exchange_record_dedupe_events
         WHERE exchange_account_id = $1
           AND incoming_external_id = ANY($2::text[])`,
        [exchangeAccountId, externalIds]
      );
      const auditedIncomingIds = new Set(
        dedupeAuditResult.rows.map((row) => row.incoming_external_id)
      );
      const incomingByFingerprint = new Map();
      for (const record of unique) {
        if (!record.fingerprint) continue;
        const rows = incomingByFingerprint.get(record.fingerprint) || [];
        rows.push(record);
        incomingByFingerprint.set(record.fingerprint, rows);
      }

      const inserts = [];
      const merges = [];
      const ambiguousExisting = new Map();
      for (const record of unique) {
        if (!existingById.has(record.external_id) && auditedIncomingIds.has(record.external_id)) {
          // A high-confidence cross-source merge stores the incoming provider
          // id only in the audit table. A later replay must remain a plain
          // duplicate, not create another audit event or append provenance a
          // second time.
          dedupeReplays += 1;
          continue;
        }
        const exact = existingById.get(record.external_id);
        if (exact) {
          inserts.push(record);
          continue;
        }
        const sameBatch = record.fingerprint ? (incomingByFingerprint.get(record.fingerprint) || []) : [];
        const candidates = (existingByFingerprint.get(record.fingerprint) || [])
          .filter((candidate) => candidate.external_id !== record.external_id);
        const conflicts = candidates.length === 1 ? conflictingDetails(candidates[0], record) : [];
        const sourceCompatible = candidates.length === 1
          && candidates[0].source && record.source && candidates[0].source !== record.source;
        const exactCandidate = candidates.length === 1
          && sameBatch.length === 1
          && sourceCompatible
          && conflicts.length === 0
          && !candidates[0].duplicate_candidate
          && !candidates[0].needs_review
          && !record.needs_review;

        if (exactCandidate) {
          merges.push({ existing: candidates[0], incoming: record });
          continue;
        }

        const hasCandidate = candidates.length > 0 || sameBatch.length > 1;
        if (hasCandidate) {
          duplicateCandidates += 1;
          if (conflicts.length > 0 || candidates.length > 1) duplicateConflicts += 1;
          record.duplicate_candidate = true;
          record.needs_review = true;
          record.raw = candidateMarker(record, candidates, conflicts);
          for (const candidate of candidates) ambiguousExisting.set(candidate.id, {
            ...candidate,
            duplicate_candidate: true,
            needs_review: true,
            dedupe_provenance: [
              ...(Array.isArray(candidate.dedupe_provenance) ? candidate.dedupe_provenance : []),
              {
                kind: 'candidate',
                fingerprint: record.fingerprint,
                incoming_external_id: record.external_id,
                incoming_source: record.source || null,
                conflicts,
              },
            ],
          });
        }
        inserts.push(record);
      }

      // Apply ambiguous markers before inserts so a concurrent read cannot see
      // only one half of the candidate group after this transaction commits.
      for (const candidate of ambiguousExisting.values()) {
        await client.query(
          `UPDATE exchange_records
           SET duplicate_candidate = TRUE,
               needs_review = TRUE,
               dedupe_provenance = $2::jsonb
           WHERE id = $1 AND exchange_account_id = $3`,
          [candidate.id, jsonValue(candidate.dedupe_provenance), exchangeAccountId]
        );
      }

      for (const { existing, incoming } of merges) {
        const merged = mergeCandidate(existing, incoming);
        const values = updateValues(merged);
        const params = [existing.id, exchangeAccountId, ...values];
        const assignments = COLUMNS
          .filter((column) => !IDENTITY_COLUMNS.has(column))
          .map((column) => `${column} = $${COLUMNS.indexOf(column) + 3}`)
          .join(', ');
        await client.query(
          `UPDATE exchange_records
           SET ${assignments}
           WHERE id = $1 AND exchange_account_id = $2`,
          params
        );
        await client.query(
          `INSERT INTO exchange_record_dedupe_events
             (exchange_account_id, survivor_record_id, incoming_external_id,
              incoming_source, fingerprint, fingerprint_version, incoming_snapshot)
           VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)`,
          [exchangeAccountId, existing.id, incoming.external_id, incoming.source || null,
            incoming.fingerprint, incoming.fingerprint_version || FINGERPRINT_VERSION,
            jsonValue(sourceSnapshot(incoming))]
        );
        deduplicated += 1;
      }

      // The ordinary external-id upsert remains the idempotence boundary for
      // exact replays. Candidate merges above are removed from this batch.
      const recordsToInsert = inserts;
      recordsToInsertCount = recordsToInsert.length;
      for (let start = 0; start < recordsToInsert.length; start += CHUNK_SIZE) {
        const chunk = recordsToInsert.slice(start, start + CHUNK_SIZE);
        const values = [];
        const placeholders = chunk.map((record, rowIndex) => {
          const base = rowIndex * (COLUMNS.length + 1);
          values.push(exchangeAccountId);
          for (const column of COLUMNS) {
            values.push(column === 'raw'
              ? (record.raw === null || record.raw === undefined ? null : JSON.stringify(stripNulls(record.raw)))
              : column === 'dedupe_provenance'
                ? jsonValue(record.dedupe_provenance)
              : record[column] ?? null);
          }
          const slots = Array.from({ length: COLUMNS.length + 1 }, (_, i) => `$${base + i + 1}`);
          return `(${slots.join(', ')})`;
        });

        let result;
        try {
          result = await client.query(
            `INSERT INTO exchange_records (exchange_account_id, ${COLUMNS.join(', ')})
             VALUES ${placeholders.join(', ')}
             ON CONFLICT (exchange_account_id, external_id) DO UPDATE
               SET ${UPGRADE_COLUMNS.map((column) => column === 'duplicate_candidate'
                 ? `${column} = exchange_records.duplicate_candidate OR EXCLUDED.${column}`
                 : `${column} = EXCLUDED.${column}`).join(', ')}
               WHERE exchange_records.needs_review
                 AND NOT exchange_records.duplicate_candidate
                 AND NOT EXCLUDED.needs_review
             RETURNING (xmax = 0) AS inserted`,
            values
          );
        } catch (err) {
          // A value the column cannot hold is the user's file, not a fault.
          // Naming the record is the whole difference between a fixable report
          // and an opaque failure.
          if (BAD_VALUE_CODES.has(err.code)) {
            const { externalId, detail } = describeBadRecord(chunk);
            err.exchangeRecordExternalId = externalId;
            err.exchangeRecordDetail = detail;
          }
          throw err;
        }

        // A conflicting row that fails the guard returns nothing at all, so the
        // three counts come out of one statement: xmax is zero only on a fresh
        // insert.
        for (const row of result.rows) {
          if (row.inserted) inserted += 1; else upgraded += 1;
        }
      }

      // Migration 062 intentionally does not rewrite historical rows. Once
      // a legacy row is touched by a later import with a usable fingerprint,
      // fill only that metadata so future cross-source imports can find it.
      // This never changes the economic record, review state, or raw payload.
      const fingerprintRows = unique.filter((record) => record.external_id && record.fingerprint);
      for (let start = 0; start < fingerprintRows.length; start += CHUNK_SIZE) {
        const chunk = fingerprintRows.slice(start, start + CHUNK_SIZE);
        const values = [exchangeAccountId];
        const tuples = chunk.map((record) => {
          values.push(record.external_id, record.fingerprint, record.fingerprint_version || FINGERPRINT_VERSION);
          return `($${values.length - 2}::text, $${values.length - 1}::varchar(64), $${values.length}::smallint)`;
        });
        await client.query(
          `UPDATE exchange_records er
           SET fingerprint = incoming.fingerprint,
               fingerprint_version = incoming.fingerprint_version
           FROM (VALUES ${tuples.join(', ')}) AS incoming(external_id, fingerprint, fingerprint_version)
           WHERE er.exchange_account_id = $1
             AND er.external_id = incoming.external_id
             AND er.fingerprint IS NULL`,
          values
        );
      }
      await client.query('COMMIT');
    } catch (err) {
      // The rollback is best effort. If the connection is already gone its
      // failure must not replace the error that explains what happened.
      try {
        await client.query('ROLLBACK');
      } catch (rollbackError) {
        logger.warn({ err: rollbackError, exchangeAccountId }, 'Exchange record import rollback failed');
      }
      throw err;
    } finally {
      client.release();
    }

    return {
      inserted,
      upgraded,
      duplicates: (recordsToInsertCount - inserted - upgraded) + duplicatesInFile + dedupeReplays,
      deduplicated,
      duplicateCandidates,
      duplicateConflicts,
      total: records.length,
    };
  }

  // Scope is inherited: the join to exchange_accounts is what makes a foreign
  // account id return nothing rather than another user's records.
  static async findForAccount(exchangeAccountId, userId, { limit = 100, offset = 0, needsReview = null } = {}) {
    if (!userId) throw new Error('ExchangeRecord.findForAccount requires a userId');
    const filters = ['er.exchange_account_id = $1', 'ea.user_id = $2'];
    const params = [exchangeAccountId, userId];
    if (needsReview === true) filters.push('er.needs_review');
    if (needsReview === false) filters.push('NOT er.needs_review');

    const where = filters.join(' AND ');
    const countResult = await pool.query(
      `SELECT COUNT(*)::int AS total
       FROM exchange_records er
       JOIN exchange_accounts ea ON ea.id = er.exchange_account_id
       WHERE ${where}`,
      params
    );

    const result = await pool.query(
      `SELECT er.*
       FROM exchange_records er
       JOIN exchange_accounts ea ON ea.id = er.exchange_account_id
       WHERE ${where}
       ORDER BY er.occurred_at DESC, er.id DESC
       LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, limit, offset]
    );

    return { records: result.rows, total: countResult.rows[0]?.total ?? 0 };
  }

  // Fill in on-chain identity fields the stored row is missing.
  //
  // This exists because the ON CONFLICT upgrade above is deliberately
  // one-directional: it only fires on a review-flagged row, so a CSV import
  // that landed FIRST (complete, unflagged, and with no address -- the Kraken
  // ledgers export carries neither a txid nor a destination) can never be
  // completed by the API sync that later learns both. Without this, connecting
  // a key after a CSV upload would yield zero addresses for the entire back
  // history, and forgotten-wallet discovery reads exactly that column.
  //
  // Strictly additive by construction: COALESCE can only replace a NULL, the
  // WHERE only matches rows that have a hole, and needs_review is not in the
  // statement at all -- so this cannot downgrade, re-flag, or contradict
  // anything a previous import decided.
  static async backfillChainDetails(exchangeAccountId, rows, { syncLockToken = null } = {}) {
    if (!exchangeAccountId) throw new Error('ExchangeRecord.backfillChainDetails requires an exchangeAccountId');
    const fillable = (rows || []).filter((row) => row.external_id
      && (row.tx_hash || row.address || row.network || row.chain_id));
    if (fillable.length === 0) return { filled: 0 };

    const client = syncLockToken ? await pool.connect() : null;
    let filled = 0;
    try {
      if (client) {
        await client.query('BEGIN');
        const owner = await client.query(
          `SELECT id
           FROM exchange_accounts
           WHERE id = $1 AND sync_lock_token = $2::uuid AND sync_lock_until > CURRENT_TIMESTAMP
           FOR UPDATE`,
          [exchangeAccountId, syncLockToken]
        );
        if (!owner.rows[0]) {
          const error = new Error('The exchange sync lost ownership before filling chain details');
          error.code = 'EXCHANGE_SYNC_LOCK_LOST';
          throw error;
        }
      }
      const queryTarget = client || pool;
      for (let start = 0; start < fillable.length; start += CHUNK_SIZE) {
        const chunk = fillable.slice(start, start + CHUNK_SIZE);
        const values = [exchangeAccountId];
        const tuples = chunk.map((row) => {
          values.push(
            row.external_id,
            row.tx_hash ?? null,
            row.address ?? null,
            row.network ?? null,
            row.chain_id ?? null
          );
          return `($${values.length - 4}::text, $${values.length - 3}::text, $${values.length - 2}::text, $${values.length - 1}::varchar(80), $${values.length}::bigint)`;
        });
        const result = await queryTarget.query(
          `UPDATE exchange_records er
           SET tx_hash = COALESCE(er.tx_hash, incoming.tx_hash),
               address = COALESCE(er.address, incoming.address),
               network = COALESCE(er.network, incoming.network),
               chain_id = COALESCE(er.chain_id, incoming.chain_id)
           FROM (VALUES ${tuples.join(', ')}) AS incoming(external_id, tx_hash, address, network, chain_id)
           WHERE er.exchange_account_id = $1
             AND er.external_id = incoming.external_id
             AND ((er.tx_hash IS NULL AND incoming.tx_hash IS NOT NULL)
               OR (er.address IS NULL AND incoming.address IS NOT NULL)
               OR (er.network IS NULL AND incoming.network IS NOT NULL)
               OR (er.chain_id IS NULL AND incoming.chain_id IS NOT NULL))`,
          values
        );
        filled += result.rowCount || 0;
      }
      if (client) await client.query('COMMIT');
      return { filled };
    } catch (error) {
      if (client) {
        try { await client.query('ROLLBACK'); } catch (rollbackError) {
          logger.warn({ err: rollbackError, exchangeAccountId }, 'Exchange chain detail rollback failed');
        }
      }
      throw error;
    } finally {
      if (client) client.release();
    }
  }

  // Per-asset position implied by everything stored for this account, for the
  // post-sync reconciliation against the exchange's own balance endpoint.
  //
  // Summed in Postgres at NUMERIC(38,18) rather than in JS: these are
  // wei/satoshi-scale quantities and a float sum would invent a mismatch out of
  // rounding, flagging a healthy account for review every single night.
  //
  // The three legs mirror how a record is written: base and quote amounts are
  // stored SIGNED as the exchange wrote them, and the fee is stored positive
  // and was charged on top -- so it subtracts.
  static async derivedBalances(exchangeAccountId, userId) {
    if (!userId) throw new Error('ExchangeRecord.derivedBalances requires a userId');
    const result = await pool.query(
      `SELECT asset, SUM(delta)::text AS derived
       FROM (
         SELECT er.base_asset AS asset, er.base_amount AS delta
         FROM exchange_records er
         JOIN exchange_accounts ea ON ea.id = er.exchange_account_id
         WHERE er.exchange_account_id = $1 AND ea.user_id = $2
           AND er.base_asset IS NOT NULL AND er.base_amount IS NOT NULL
         UNION ALL
         SELECT er.quote_asset, er.quote_amount
         FROM exchange_records er
         JOIN exchange_accounts ea ON ea.id = er.exchange_account_id
         WHERE er.exchange_account_id = $1 AND ea.user_id = $2
           AND er.quote_asset IS NOT NULL AND er.quote_amount IS NOT NULL
         UNION ALL
         SELECT er.fee_asset, -er.fee_amount
         FROM exchange_records er
         JOIN exchange_accounts ea ON ea.id = er.exchange_account_id
         WHERE er.exchange_account_id = $1 AND ea.user_id = $2
           AND er.fee_asset IS NOT NULL AND er.fee_amount IS NOT NULL
       ) legs
       GROUP BY asset`,
      [exchangeAccountId, userId]
    );
    return Object.fromEntries(result.rows.map((row) => [row.asset, row.derived]));
  }

  // Clearing the flag is what lets the review queue reach zero. Ownership is
  // enforced in the statement itself, through the account: a record id that
  // belongs to someone else updates nothing and the route answers 404.
  static async resolveReview(recordId, exchangeAccountId, userId) {
    if (!userId) throw new Error('ExchangeRecord.resolveReview requires a userId');
    const result = await pool.query(
      `UPDATE exchange_records er
       SET needs_review = FALSE
       FROM exchange_accounts ea
       WHERE er.exchange_account_id = ea.id
         AND er.id = $1
         AND er.exchange_account_id = $2
         AND ea.user_id = $3
       RETURNING er.*`,
      [recordId, exchangeAccountId, userId]
    );
    return result.rows[0];
  }

}

module.exports = ExchangeRecord;
module.exports.BAD_VALUE_CODES = BAD_VALUE_CODES;

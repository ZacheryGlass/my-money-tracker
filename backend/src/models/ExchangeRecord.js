'use strict';

const pool = require('../config/database');
const logger = require('../config/logger');

const COLUMNS = [
  'record_type', 'occurred_at', 'base_asset', 'base_amount', 'quote_asset', 'quote_amount',
  'fee_asset', 'fee_amount', 'tx_hash', 'address', 'external_id', 'needs_review', 'raw',
  // 'csv' | 'api' | NULL for rows imported before migration 040. Provenance
  // only: nothing keys, dedupes or votes on it, so an API row and a CSV row
  // describing the same event still collapse onto one record.
  'source',
  // Provider network spelling plus normalized EVM chain id when known. Both
  // are nullable for legacy rows and non-EVM records.
  'network', 'chain_id',
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
  static async bulkInsert(exchangeAccountId, records) {
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
    try {
      await client.query('BEGIN');
      for (let start = 0; start < unique.length; start += CHUNK_SIZE) {
        const chunk = unique.slice(start, start + CHUNK_SIZE);
        const values = [];
        const placeholders = chunk.map((record, rowIndex) => {
          const base = rowIndex * (COLUMNS.length + 1);
          values.push(exchangeAccountId);
          for (const column of COLUMNS) {
            values.push(column === 'raw'
              ? (record.raw === null || record.raw === undefined ? null : JSON.stringify(stripNulls(record.raw)))
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
               SET ${UPGRADE_COLUMNS.map((column) => `${column} = EXCLUDED.${column}`).join(', ')}
               WHERE exchange_records.needs_review AND NOT EXCLUDED.needs_review
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
      duplicates: (unique.length - inserted - upgraded) + duplicatesInFile,
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
  static async backfillChainDetails(exchangeAccountId, rows) {
    if (!exchangeAccountId) throw new Error('ExchangeRecord.backfillChainDetails requires an exchangeAccountId');
    const fillable = (rows || []).filter((row) => row.external_id
      && (row.tx_hash || row.address || row.network || row.chain_id));
    if (fillable.length === 0) return { filled: 0 };

    let filled = 0;
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
      const result = await pool.query(
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
    return { filled };
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

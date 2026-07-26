'use strict';

const pool = require('../config/database');

const COLUMNS = [
  'record_type', 'occurred_at', 'base_asset', 'base_amount', 'quote_asset', 'quote_amount',
  'fee_asset', 'fee_amount', 'tx_hash', 'address', 'external_id', 'needs_review', 'raw',
];

// Rows per INSERT. Postgres caps a statement at 65535 bind parameters, and at
// 14 columns per row that is ~4600 rows; 250 keeps each statement small enough
// to stay readable in a log without making a 1200-row ledger chatty.
const CHUNK_SIZE = 250;

class ExchangeRecord {
  // Idempotent by construction: UNIQUE (exchange_account_id, external_id) plus
  // ON CONFLICT DO NOTHING means re-uploading a longer export inserts only the
  // rows that are new. The returned counts are what the UI reports, so they
  // have to distinguish "already had it" from "wrote it".
  static async bulkInsert(exchangeAccountId, records) {
    if (!exchangeAccountId) throw new Error('ExchangeRecord.bulkInsert requires an exchangeAccountId');
    if (!records || records.length === 0) {
      return { inserted: 0, duplicates: 0, total: 0 };
    }

    // Two rows in one file can carry the same external_id only when the export
    // itself repeats an id. Collapsing them here keeps the counts honest --
    // ON CONFLICT DO NOTHING would swallow the second silently.
    const seen = new Set();
    const unique = [];
    let duplicatesInFile = 0;
    for (const record of records) {
      if (seen.has(record.external_id)) { duplicatesInFile += 1; continue; }
      seen.add(record.external_id);
      unique.push(record);
    }

    const client = await pool.connect();
    let inserted = 0;
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
              ? (record.raw === null || record.raw === undefined ? null : JSON.stringify(record.raw))
              : record[column] ?? null);
          }
          const slots = Array.from({ length: COLUMNS.length + 1 }, (_, i) => `$${base + i + 1}`);
          return `(${slots.join(', ')})`;
        });

        const result = await client.query(
          `INSERT INTO exchange_records (exchange_account_id, ${COLUMNS.join(', ')})
           VALUES ${placeholders.join(', ')}
           ON CONFLICT (exchange_account_id, external_id) DO NOTHING
           RETURNING id`,
          values
        );
        inserted += result.rowCount;
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }

    return {
      inserted,
      duplicates: (unique.length - inserted) + duplicatesInFile,
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

  static async countForUser(userId) {
    if (!userId) throw new Error('ExchangeRecord.countForUser requires a userId');
    const result = await pool.query(
      `SELECT COUNT(*)::int AS total
       FROM exchange_records er
       JOIN exchange_accounts ea ON ea.id = er.exchange_account_id
       WHERE ea.user_id = $1`,
      [userId]
    );
    return result.rows[0]?.total ?? 0;
  }
}

module.exports = ExchangeRecord;

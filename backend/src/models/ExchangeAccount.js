'use strict';

const pool = require('../config/database');

// Root table: ownership lives here and exchange_records inherits it by joining
// through this table. Every read is scoped, and a missing userId throws rather
// than quietly widening to every user's accounts.
function requireUserId(method, userId) {
  if (!userId) {
    throw new Error(`ExchangeAccount.${method} requires a userId`);
  }
}

const EXCHANGES = new Set(['coinbase', 'kraken', 'other']);

class ExchangeAccount {
  static get EXCHANGES() {
    return EXCHANGES;
  }

  // The Settings list: each account with the two numbers that tell the user
  // whether an import worked -- how many records it holds and when it last ran.
  static async findAllByUser(userId) {
    requireUserId('findAllByUser', userId);
    const result = await pool.query(
      `SELECT ea.*,
              COUNT(er.id)::int AS record_count,
              COUNT(er.id) FILTER (WHERE er.needs_review)::int AS needs_review_count,
              MIN(er.occurred_at) AS first_record_at,
              MAX(er.occurred_at) AS last_record_at
       FROM exchange_accounts ea
       LEFT JOIN exchange_records er ON er.exchange_account_id = ea.id
       WHERE ea.user_id = $1
       GROUP BY ea.id
       ORDER BY ea.created_at DESC`,
      [userId]
    );
    return result.rows;
  }

  static async findByIdForUser(id, userId) {
    requireUserId('findByIdForUser', userId);
    const result = await pool.query(
      'SELECT * FROM exchange_accounts WHERE id = $1 AND user_id = $2',
      [id, userId]
    );
    return result.rows[0];
  }

  static async create(userId, { name, exchange }) {
    requireUserId('create', userId);
    const result = await pool.query(
      `INSERT INTO exchange_accounts (user_id, name, exchange)
       VALUES ($1, $2, $3)
       RETURNING *`,
      [userId, name, exchange]
    );
    return result.rows[0];
  }

  // Both filters on the same statement: a foreign id updates nothing and the
  // route turns the empty result into a 404.
  static async update(id, userId, { name, exchange }) {
    requireUserId('update', userId);
    const result = await pool.query(
      `UPDATE exchange_accounts
       SET name = COALESCE($3, name),
           exchange = COALESCE($4, exchange),
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $1 AND user_id = $2
       RETURNING *`,
      [id, userId, name ?? null, exchange ?? null]
    );
    return result.rows[0];
  }

  static async delete(id, userId) {
    requireUserId('delete', userId);
    const result = await pool.query(
      'DELETE FROM exchange_accounts WHERE id = $1 AND user_id = $2 RETURNING *',
      [id, userId]
    );
    return result.rows[0];
  }

  static async touchImport(id, userId) {
    requireUserId('touchImport', userId);
    const result = await pool.query(
      `UPDATE exchange_accounts
       SET last_import_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
       WHERE id = $1 AND user_id = $2
       RETURNING *`,
      [id, userId]
    );
    return result.rows[0];
  }
}

module.exports = ExchangeAccount;

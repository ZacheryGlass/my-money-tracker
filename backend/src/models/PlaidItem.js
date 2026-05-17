'use strict';

const pool = require('../config/database');

class PlaidItem {
  static async create(itemId, accessToken, institutionId, institutionName) {
    const result = await pool.query(
      `INSERT INTO plaid_items (item_id, access_token, institution_id, institution_name)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [itemId, accessToken, institutionId, institutionName]
    );
    return result.rows[0];
  }

  static async findAll() {
    const result = await pool.query(
      'SELECT * FROM plaid_items ORDER BY created_at DESC'
    );
    return result.rows;
  }

  static async findById(id) {
    const result = await pool.query(
      'SELECT * FROM plaid_items WHERE id = $1',
      [id]
    );
    return result.rows[0];
  }

  static async findByItemId(itemId) {
    const result = await pool.query(
      'SELECT * FROM plaid_items WHERE item_id = $1',
      [itemId]
    );
    return result.rows[0];
  }

  static async updateSyncTime(id) {
    const result = await pool.query(
      `UPDATE plaid_items
       SET last_synced_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
       WHERE id = $1
       RETURNING *`,
      [id]
    );
    return result.rows[0];
  }

  static async setError(id, errorCode, errorMessage) {
    const result = await pool.query(
      `UPDATE plaid_items
       SET error_code = $2, error_message = $3, updated_at = CURRENT_TIMESTAMP
       WHERE id = $1
       RETURNING *`,
      [id, errorCode, errorMessage]
    );
    return result.rows[0];
  }

  static async clearError(id) {
    const result = await pool.query(
      `UPDATE plaid_items
       SET error_code = NULL, error_message = NULL, updated_at = CURRENT_TIMESTAMP
       WHERE id = $1
       RETURNING *`,
      [id]
    );
    return result.rows[0];
  }

  static async delete(id, { removeData = false } = {}) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      if (removeData) {
        await client.query(
          'DELETE FROM ticker_snapshots WHERE account_id IN (SELECT id FROM accounts WHERE plaid_item_id = $1)',
          [id]
        );
        await client.query(
          'DELETE FROM account_snapshots WHERE account_id IN (SELECT id FROM accounts WHERE plaid_item_id = $1)',
          [id]
        );
        await client.query(
          'DELETE FROM holdings WHERE account_id IN (SELECT id FROM accounts WHERE plaid_item_id = $1)',
          [id]
        );
        await client.query(
          'DELETE FROM transactions WHERE account_id IN (SELECT id FROM accounts WHERE plaid_item_id = $1)',
          [id]
        );
        await client.query(
          'DELETE FROM accounts WHERE plaid_item_id = $1',
          [id]
        );
      } else {
        await client.query(
          `UPDATE holdings SET is_plaid_managed = FALSE
           WHERE account_id IN (SELECT id FROM accounts WHERE plaid_item_id = $1)`,
          [id]
        );
        await client.query(
          'UPDATE accounts SET plaid_item_id = NULL, plaid_account_id = NULL WHERE plaid_item_id = $1',
          [id]
        );
      }
      const result = await client.query(
        'DELETE FROM plaid_items WHERE id = $1 RETURNING *',
        [id]
      );
      await client.query('COMMIT');
      return result.rows[0];
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  static async getAccountsForItem(id) {
    const result = await pool.query(
      `SELECT *,
              COALESCE(NULLIF(TRIM(display_name), ''), name) AS effective_name
       FROM accounts
       WHERE plaid_item_id = $1
       ORDER BY is_hidden ASC, effective_name`,
      [id]
    );
    return result.rows;
  }
}

module.exports = PlaidItem;

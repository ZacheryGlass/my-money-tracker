'use strict';

const pool = require('../config/database');

class EthWallet {
  static async create(address, label) {
    const result = await pool.query(
      `INSERT INTO eth_wallets (address, label)
       VALUES ($1, $2)
       RETURNING *`,
      [address, label || null]
    );
    return result.rows[0];
  }

  static async findAll() {
    const result = await pool.query(
      'SELECT * FROM eth_wallets ORDER BY created_at DESC'
    );
    return result.rows;
  }

  static async findById(id) {
    const result = await pool.query(
      'SELECT * FROM eth_wallets WHERE id = $1',
      [id]
    );
    return result.rows[0];
  }

  static async findByAddress(address) {
    const result = await pool.query(
      'SELECT * FROM eth_wallets WHERE address = $1',
      [address.toLowerCase()]
    );
    return result.rows[0];
  }

  static async updateLabel(id, label) {
    const result = await pool.query(
      `UPDATE eth_wallets
       SET label = $2, updated_at = CURRENT_TIMESTAMP
       WHERE id = $1
       RETURNING *`,
      [id, label || null]
    );
    return result.rows[0];
  }

  static async updateCursors(id, { normal, internal, token }) {
    const result = await pool.query(
      `UPDATE eth_wallets
       SET last_block_normal = COALESCE($2, last_block_normal),
           last_block_internal = COALESCE($3, last_block_internal),
           last_block_token = COALESCE($4, last_block_token),
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $1
       RETURNING *`,
      [id, normal ?? null, internal ?? null, token ?? null]
    );
    return result.rows[0];
  }

  static async updateSyncTime(id) {
    const result = await pool.query(
      `UPDATE eth_wallets
       SET last_synced_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
       WHERE id = $1
       RETURNING *`,
      [id]
    );
    return result.rows[0];
  }

  static async setError(id, errorCode, errorMessage) {
    const result = await pool.query(
      `UPDATE eth_wallets
       SET error_code = $2, error_message = $3, updated_at = CURRENT_TIMESTAMP
       WHERE id = $1
       RETURNING *`,
      [id, errorCode, errorMessage]
    );
    return result.rows[0];
  }

  static async clearError(id) {
    const result = await pool.query(
      `UPDATE eth_wallets
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
          'DELETE FROM ticker_snapshots WHERE account_id IN (SELECT id FROM accounts WHERE eth_wallet_id = $1)',
          [id]
        );
        await client.query(
          'DELETE FROM account_snapshots WHERE account_id IN (SELECT id FROM accounts WHERE eth_wallet_id = $1)',
          [id]
        );
        await client.query(
          'DELETE FROM holdings WHERE account_id IN (SELECT id FROM accounts WHERE eth_wallet_id = $1)',
          [id]
        );
        await client.query(
          'DELETE FROM transactions WHERE account_id IN (SELECT id FROM accounts WHERE eth_wallet_id = $1)',
          [id]
        );
        await client.query(
          'DELETE FROM accounts WHERE eth_wallet_id = $1',
          [id]
        );
      }
      // Keep-data path: ON DELETE SET NULL on accounts.eth_wallet_id detaches
      // the account; eth_transfers rows go away either way via CASCADE.
      const result = await client.query(
        'DELETE FROM eth_wallets WHERE id = $1 RETURNING *',
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

  static async getEthQuantity(id) {
    const result = await pool.query(
      `SELECT h.quantity
       FROM holdings h
       JOIN accounts a ON a.id = h.account_id
       WHERE a.eth_wallet_id = $1 AND UPPER(h.ticker) = 'ETH'`,
      [id]
    );
    return result.rows[0]?.quantity ?? null;
  }

  static async getAccountForWallet(id) {
    const result = await pool.query(
      `SELECT *,
              COALESCE(NULLIF(TRIM(display_name), ''), name) AS effective_name
       FROM accounts
       WHERE eth_wallet_id = $1`,
      [id]
    );
    return result.rows[0];
  }
}

module.exports = EthWallet;

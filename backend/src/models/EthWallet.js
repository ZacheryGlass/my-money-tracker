'use strict';

const pool = require('../config/database');

class EthWallet {
  // Every user's wallets. Named for its only legitimate use so that a
  // per-user caller reaching for it is visible in review; use findAllByUser.
  static async findAllForJobs() {
    const result = await pool.query(
      'SELECT * FROM eth_wallets ORDER BY created_at DESC'
    );
    return result.rows;
  }

  static async findAllByUser(userId) {
    const result = await pool.query(
      'SELECT * FROM eth_wallets WHERE user_id = $1 ORDER BY created_at DESC',
      [userId]
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

  static async findByIdForUser(id, userId) {
    const result = await pool.query(
      'SELECT * FROM eth_wallets WHERE id = $1 AND user_id = $2',
      [id, userId]
    );
    return result.rows[0];
  }

  static async findByAddress(address, userId) {
    const result = await pool.query(
      'SELECT * FROM eth_wallets WHERE address = $1 AND user_id = $2',
      [address.toLowerCase(), userId]
    );
    return result.rows[0];
  }

  // Resume cursors moved to eth_wallet_chains in migration 039 -- they are
  // per (wallet, chain) now, and EthWalletChain.updateCursors writes them. The
  // eth_wallets.last_block_* columns survive only because 039's seed reads them
  // on every boot to bootstrap a not-yet-resynced wallet's chain-1 row; nothing
  // writes them any more, so do not add a writer here.

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

  // Total ETH the wallet holds, SUMMED across chains. Post-#58 the wallet's
  // account carries one ETH holding per synced chain, so reading a single row
  // here would report only whichever chain the planner happened to return
  // first -- an L2-heavy wallet would show a fraction of its real balance with
  // no error anywhere. NULL (not 0) when there is no ETH row at all, which is
  // what "never synced" looked like before and what callers still key on.
  static async getEthQuantity(id) {
    const result = await pool.query(
      `SELECT SUM(h.quantity) AS quantity
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

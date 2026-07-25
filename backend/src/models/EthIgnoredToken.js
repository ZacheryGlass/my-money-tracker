'use strict';

const pool = require('../config/database');

class EthIgnoredToken {
  static async findAll(userId) {
    const result = await pool.query(
      'SELECT * FROM eth_ignored_tokens WHERE user_id = $1 ORDER BY created_at DESC',
      [userId]
    );
    return result.rows;
  }

  static async upsert(userId, contractAddress, symbol, note) {
    const result = await pool.query(
      `INSERT INTO eth_ignored_tokens (user_id, contract_address, symbol, note)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (user_id, contract_address)
       DO UPDATE SET symbol = COALESCE(EXCLUDED.symbol, eth_ignored_tokens.symbol),
                     note = COALESCE(EXCLUDED.note, eth_ignored_tokens.note)
       RETURNING *`,
      [userId, contractAddress.toLowerCase(), symbol || null, note || null]
    );
    return result.rows[0];
  }

  static async delete(userId, contractAddress) {
    const result = await pool.query(
      'DELETE FROM eth_ignored_tokens WHERE user_id = $1 AND contract_address = $2 RETURNING *',
      [userId, contractAddress.toLowerCase()]
    );
    return result.rows[0];
  }
}

module.exports = EthIgnoredToken;

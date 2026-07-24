'use strict';

const pool = require('../config/database');

class EthIgnoredToken {
  static async findAll() {
    const result = await pool.query(
      'SELECT * FROM eth_ignored_tokens ORDER BY created_at DESC'
    );
    return result.rows;
  }

  static async upsert(contractAddress, symbol, note) {
    const result = await pool.query(
      `INSERT INTO eth_ignored_tokens (contract_address, symbol, note)
       VALUES ($1, $2, $3)
       ON CONFLICT (contract_address)
       DO UPDATE SET symbol = COALESCE(EXCLUDED.symbol, eth_ignored_tokens.symbol),
                     note = COALESCE(EXCLUDED.note, eth_ignored_tokens.note)
       RETURNING *`,
      [contractAddress.toLowerCase(), symbol || null, note || null]
    );
    return result.rows[0];
  }

  static async delete(contractAddress) {
    const result = await pool.query(
      'DELETE FROM eth_ignored_tokens WHERE contract_address = $1 RETURNING *',
      [contractAddress.toLowerCase()]
    );
    return result.rows[0];
  }
}

module.exports = EthIgnoredToken;

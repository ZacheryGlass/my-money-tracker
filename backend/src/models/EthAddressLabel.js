'use strict';

const pool = require('../config/database');

class EthAddressLabel {
  static async findAll() {
    const result = await pool.query(
      'SELECT * FROM eth_address_labels ORDER BY name, address'
    );
    return result.rows;
  }

  static async findByAddress(address) {
    const result = await pool.query(
      'SELECT * FROM eth_address_labels WHERE address = $1',
      [address.toLowerCase()]
    );
    return result.rows[0] || null;
  }

  // Upserting always yields a 'user' row, even over a builtin: the seed's
  // ON CONFLICT DO NOTHING then leaves the override alone on future boots.
  static async upsert(address, name, note) {
    const result = await pool.query(
      `INSERT INTO eth_address_labels (address, name, source, note)
       VALUES ($1, $2, 'user', $3)
       ON CONFLICT (address)
       DO UPDATE SET name = EXCLUDED.name,
                     note = COALESCE(EXCLUDED.note, eth_address_labels.note),
                     source = 'user'
       RETURNING *`,
      [address.toLowerCase(), name, note || null]
    );
    return result.rows[0];
  }

  // Builtins are not deletable: removing the row would only resurrect it on
  // the next boot when the seed migration re-runs. Callers 409 instead.
  static async delete(address) {
    const result = await pool.query(
      `DELETE FROM eth_address_labels
       WHERE address = $1 AND source = 'user'
       RETURNING *`,
      [address.toLowerCase()]
    );
    return result.rows[0] || null;
  }
}

module.exports = EthAddressLabel;

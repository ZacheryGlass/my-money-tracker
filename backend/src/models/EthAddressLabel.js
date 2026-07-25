'use strict';

const pool = require('../config/database');

class EthAddressLabel {
  // The user's own rows plus the shared builtins, with a user row shadowing
  // the builtin for the same address.
  static async findAllForUser(userId) {
    const result = await pool.query(
      `SELECT * FROM (
         SELECT DISTINCT ON (address) *
         FROM eth_address_labels
         WHERE user_id = $1 OR user_id IS NULL
         ORDER BY address, user_id NULLS LAST
       ) labels
       ORDER BY name, address`,
      [userId]
    );
    return result.rows;
  }

  static async findByAddress(userId, address) {
    const result = await pool.query(
      `SELECT * FROM eth_address_labels
       WHERE address = $1 AND (user_id = $2 OR user_id IS NULL)
       ORDER BY user_id NULLS LAST
       LIMIT 1`,
      [address.toLowerCase(), userId]
    );
    return result.rows[0] || null;
  }

  // A user's label is a separate row from any builtin for the same address
  // (the builtin keeps user_id NULL); reads shadow builtins with user rows.
  static async upsert(userId, address, name, note) {
    const result = await pool.query(
      `INSERT INTO eth_address_labels (user_id, address, name, source, note)
       VALUES ($1, $2, $3, 'user', $4)
       ON CONFLICT (user_id, address) WHERE user_id IS NOT NULL
       DO UPDATE SET name = EXCLUDED.name,
                     note = COALESCE(EXCLUDED.note, eth_address_labels.note)
       RETURNING *`,
      [userId, address.toLowerCase(), name, note || null]
    );
    return result.rows[0];
  }

  // Builtins (user_id NULL) are not deletable: removing the row would only
  // resurrect it on the next boot when the seed re-runs. Callers 409 instead.
  static async delete(userId, address) {
    const result = await pool.query(
      `DELETE FROM eth_address_labels
       WHERE user_id = $1 AND address = $2
       RETURNING *`,
      [userId, address.toLowerCase()]
    );
    return result.rows[0] || null;
  }
}

module.exports = EthAddressLabel;

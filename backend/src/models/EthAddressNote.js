'use strict';

const pool = require('../config/database');

class EthAddressNote {
  static async findAllForUser(userId) {
    if (!userId) throw new Error('EthAddressNote.findAllForUser requires a userId');
    const result = await pool.query(
      `SELECT id, address, note, created_at, updated_at
       FROM eth_address_notes
       WHERE user_id = $1
       ORDER BY updated_at DESC, address`,
      [userId]
    );
    return result.rows;
  }

  static async upsert(userId, address, note) {
    if (!userId) throw new Error('EthAddressNote.upsert requires a userId');
    const result = await pool.query(
      `INSERT INTO eth_address_notes (user_id, address, note)
       VALUES ($1, $2, $3)
       ON CONFLICT (user_id, address)
       DO UPDATE SET note = EXCLUDED.note, updated_at = CURRENT_TIMESTAMP
       RETURNING id, address, note, created_at, updated_at`,
      [userId, address.toLowerCase(), note]
    );
    return result.rows[0];
  }

  static async delete(userId, address) {
    if (!userId) throw new Error('EthAddressNote.delete requires a userId');
    const result = await pool.query(
      `DELETE FROM eth_address_notes
       WHERE user_id = $1 AND address = $2
       RETURNING id, address, note, created_at, updated_at`,
      [userId, address.toLowerCase()]
    );
    return result.rows[0] || null;
  }
}

module.exports = EthAddressNote;

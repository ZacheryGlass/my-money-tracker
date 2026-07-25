'use strict';

const pool = require('../config/database');

class User {
  static async findByEmail(email) {
    const result = await pool.query(
      `SELECT u.id, u.username, u.display_name
       FROM user_identities ui
       JOIN users u ON u.id = ui.user_id
       WHERE ui.email = $1`,
      [email.toLowerCase()]
    );
    return result.rows[0] || null;
  }

  // Race-safe provisioning: both inserts tolerate an identical concurrent
  // request, and the final re-select returns whichever row won.
  static async provisionByEmail(email) {
    const normalized = email.toLowerCase();
    await pool.query(
      'INSERT INTO users (username) VALUES ($1) ON CONFLICT (username) DO NOTHING',
      [normalized]
    );
    await pool.query(
      `INSERT INTO user_identities (email, user_id)
       SELECT $1, id FROM users WHERE username = $1
       ON CONFLICT (email) DO NOTHING`,
      [normalized]
    );
    return this.findByEmail(normalized);
  }
}

module.exports = User;

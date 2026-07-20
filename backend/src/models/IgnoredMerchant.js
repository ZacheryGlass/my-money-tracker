const pool = require('../config/database');

class IgnoredMerchant {
  static async add(merchantKey, { name = null, lastCost = null } = {}) {
    await pool.query(
      `INSERT INTO ignored_merchants (merchant_key, name, last_cost)
       VALUES ($1, $2, $3)
       ON CONFLICT (merchant_key) DO UPDATE SET name = EXCLUDED.name, last_cost = EXCLUDED.last_cost`,
      [merchantKey, name, lastCost]
    );
  }

  static async remove(merchantKey) {
    await pool.query('DELETE FROM ignored_merchants WHERE merchant_key = $1', [merchantKey]);
  }

  static async all() {
    const result = await pool.query(
      'SELECT merchant_key, name, last_cost, created_at FROM ignored_merchants ORDER BY created_at DESC'
    );
    return result.rows;
  }

  static async allKeys() {
    const result = await pool.query('SELECT merchant_key FROM ignored_merchants');
    return new Set(result.rows.map((row) => row.merchant_key));
  }
}

module.exports = IgnoredMerchant;

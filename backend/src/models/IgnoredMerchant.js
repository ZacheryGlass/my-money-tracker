const pool = require('../config/database');

class IgnoredMerchant {
  static async add(merchantKey) {
    await pool.query(
      'INSERT INTO ignored_merchants (merchant_key) VALUES ($1) ON CONFLICT (merchant_key) DO NOTHING',
      [merchantKey]
    );
  }

  static async remove(merchantKey) {
    await pool.query('DELETE FROM ignored_merchants WHERE merchant_key = $1', [merchantKey]);
  }

  static async allKeys() {
    const result = await pool.query('SELECT merchant_key FROM ignored_merchants');
    return new Set(result.rows.map((row) => row.merchant_key));
  }
}

module.exports = IgnoredMerchant;

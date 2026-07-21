const pool = require('../config/database');

// Scopes: 'expenses' blocks recurring-charge tracking (Monthly Expenses page);
// 'merchants' hides the merchant from the Top Merchants ranking. The lists are
// independent — ignoring on one page never affects the other.
const SCOPES = new Set(['expenses', 'merchants']);

class IgnoredMerchant {
  static isValidScope(scope) {
    return SCOPES.has(scope);
  }

  static async add(merchantKey, scope, { name = null, lastCost = null } = {}) {
    await pool.query(
      `INSERT INTO ignored_merchants (merchant_key, scope, name, last_cost)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (merchant_key, scope) DO UPDATE SET name = EXCLUDED.name, last_cost = EXCLUDED.last_cost`,
      [merchantKey, scope, name, lastCost]
    );
  }

  static async remove(merchantKey, scope) {
    await pool.query('DELETE FROM ignored_merchants WHERE merchant_key = $1 AND scope = $2', [merchantKey, scope]);
  }

  static async all(scope) {
    const result = await pool.query(
      'SELECT merchant_key, name, last_cost, created_at FROM ignored_merchants WHERE scope = $1 ORDER BY created_at DESC',
      [scope]
    );
    return result.rows;
  }

  static async allKeys(scope) {
    const result = await pool.query('SELECT merchant_key FROM ignored_merchants WHERE scope = $1', [scope]);
    return new Set(result.rows.map((row) => row.merchant_key));
  }
}

module.exports = IgnoredMerchant;

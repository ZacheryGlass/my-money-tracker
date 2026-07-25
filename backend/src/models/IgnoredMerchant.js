const pool = require('../config/database');

// Scopes: 'expenses' blocks recurring-charge tracking (Monthly Expenses page);
// 'merchants' hides the merchant from the Top Merchants ranking. The lists are
// independent — ignoring on one page never affects the other.
const SCOPES = new Set(['expenses', 'merchants']);

class IgnoredMerchant {
  static isValidScope(scope) {
    return SCOPES.has(scope);
  }

  static async add(userId, merchantKey, scope, { name = null, lastCost = null } = {}) {
    await pool.query(
      `INSERT INTO ignored_merchants (user_id, merchant_key, scope, name, last_cost)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (user_id, merchant_key, scope) DO UPDATE SET name = EXCLUDED.name, last_cost = EXCLUDED.last_cost`,
      [userId, merchantKey, scope, name, lastCost]
    );
  }

  static async remove(userId, merchantKey, scope) {
    await pool.query(
      'DELETE FROM ignored_merchants WHERE user_id = $1 AND merchant_key = $2 AND scope = $3',
      [userId, merchantKey, scope]
    );
  }

  static async all(userId, scope) {
    const result = await pool.query(
      'SELECT merchant_key, name, last_cost, created_at FROM ignored_merchants WHERE user_id = $1 AND scope = $2 ORDER BY created_at DESC',
      [userId, scope]
    );
    return result.rows;
  }

  static async allKeys(userId, scope) {
    const result = await pool.query(
      'SELECT merchant_key FROM ignored_merchants WHERE user_id = $1 AND scope = $2',
      [userId, scope]
    );
    return new Set(result.rows.map((row) => row.merchant_key));
  }
}

module.exports = IgnoredMerchant;

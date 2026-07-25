const pool = require('../config/database');
const { SPEND_ELIGIBILITY_SQL } = require('../utils/spendFilters');

// Aggregated card/bank spend by merchant over a trailing window, for the Top
// Merchants page. Merchant identity is COALESCE(merchant_name, name); which
// rows qualify comes from SPEND_ELIGIBILITY_SQL, shared with
// RecurringExpense.chargesForMerchant and the expense sync. Only
// merchants-scope ignores are excluded; the expenses-scope list is a separate
// concern (see IgnoredMerchant).
class MerchantSpend {
  static async topForWindow(userId, days, limit = 50) {
    const result = await pool.query(`
      SELECT COALESCE(t.merchant_name, t.name) AS merchant_key,
             SUM(t.amount)::float8 AS total,
             COUNT(*)::int AS charge_count,
             MAX(t.date)::text AS last_date,
             COUNT(DISTINCT t.account_id)::int AS account_count,
             MAX(COALESCE(a.display_name, a.name)) AS account
      FROM transactions t
      JOIN accounts a ON t.account_id = a.id
      WHERE t.date >= CURRENT_DATE - $1::int
        AND a.user_id = $3
        AND ${SPEND_ELIGIBILITY_SQL}
        AND COALESCE(t.merchant_name, t.name) NOT IN (SELECT merchant_key FROM ignored_merchants WHERE scope = 'merchants' AND user_id = $3)
      GROUP BY COALESCE(t.merchant_name, t.name)
      ORDER BY total DESC, merchant_key ASC
      LIMIT $2
    `, [days, limit, userId]);
    return result.rows;
  }
}

module.exports = MerchantSpend;

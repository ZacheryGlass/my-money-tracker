const pool = require('../config/database');

class RecurringExpense {
  static async findAll() {
    // is_stale: no charge seen within 1.5x the merchant's median charge
    // interval (default 30 days when cadence is unknown).
    // is_dropped: no charge within 2.0x that interval -- the page hides these
    // so lapsed/cancelled expenses fall off on their own. The row is kept, not
    // deleted: if the merchant charges again, sync refreshes last_charge_date
    // and it reappears automatically.
    const result = await pool.query(`SELECT *,
      (last_charge_date IS NOT NULL
        AND (CURRENT_DATE - last_charge_date) > CEIL(1.5 * COALESCE(charge_interval_days, 30)))::boolean AS is_stale,
      (last_charge_date IS NOT NULL
        AND (CURRENT_DATE - last_charge_date) > CEIL(2.0 * COALESCE(charge_interval_days, 30)))::boolean AS is_dropped
      FROM recurring_expenses ORDER BY cost DESC`);
    return result.rows;
  }

  static async findById(id) {
    const result = await pool.query('SELECT * FROM recurring_expenses WHERE id = $1', [id]);
    return result.rows[0];
  }

  static async setTag(id, tag) {
    const result = await pool.query(
      'UPDATE recurring_expenses SET tag = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2 RETURNING *',
      [tag, id]
    );
    return result.rows[0];
  }

  static async delete(id) {
    const result = await pool.query('DELETE FROM recurring_expenses WHERE id = $1 RETURNING id', [id]);
    return result.rows[0];
  }

  static async setMerchantKey(id, merchantKey) {
    const result = await pool.query(
      'UPDATE recurring_expenses SET merchant_key = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2 RETURNING *',
      [merchantKey, id]
    );
    return result.rows[0];
  }

  static async updateDerived(id, fields) {
    const allowed = ['cost', 'is_fixed_rate', 'pay_account', 'company', 'account_id',
      'due_day', 'last_charge_date', 'charge_interval_days'];
    const keys = allowed.filter((key) => fields[key] !== undefined);
    if (!keys.length) return null;
    const sets = keys.map((key, i) => `${key} = $${i + 1}`).join(', ');
    const result = await pool.query(
      `UPDATE recurring_expenses SET ${sets}, updated_at = CURRENT_TIMESTAMP WHERE id = $${keys.length + 1} RETURNING *`,
      [...keys.map((key) => fields[key]), id]
    );
    return result.rows[0];
  }

  // Returns undefined when a concurrent run already inserted this merchant
  // (ON CONFLICT DO NOTHING), so callers must null-check.
  static async createAutoTracked(data) {
    const result = await pool.query(
      `INSERT INTO recurring_expenses
        (name, cost, is_fixed_rate, pay_account, company, merchant_key, account_id,
         due_day, last_charge_date, charge_interval_days, is_auto_tracked)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, TRUE)
       ON CONFLICT (merchant_key) WHERE merchant_key IS NOT NULL DO NOTHING
       RETURNING *`,
      [data.name, data.cost, data.is_fixed_rate, data.pay_account, data.company,
        data.merchant_key, data.account_id, data.due_day, data.last_charge_date, data.charge_interval_days]
    );
    return result.rows[0];
  }

  static async appendHistory(id, cost) {
    await pool.query(
      `INSERT INTO recurring_expense_history (recurring_expense_id, effective_date, cost)
       VALUES ($1, CURRENT_DATE, $2)
       ON CONFLICT (recurring_expense_id, effective_date) DO UPDATE SET cost = EXCLUDED.cost`,
      [id, cost]
    );
  }
}

module.exports = RecurringExpense;

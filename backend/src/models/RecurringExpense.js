const pool = require('../config/database');

class RecurringExpense {
  static async findAll(type) {
    // is_stale: no charge seen within 1.5x the merchant's median charge
    // interval (default 30 days when cadence is unknown).
    let query = `SELECT *,
      (last_charge_date IS NOT NULL
        AND (CURRENT_DATE - last_charge_date) > CEIL(1.5 * COALESCE(charge_interval_days, 30)))::boolean AS is_stale
      FROM recurring_expenses`;
    const params = [];
    if (type) {
      query += ' WHERE type = $1';
      params.push(type);
    }
    query += ' ORDER BY cost DESC';
    const result = await pool.query(query, params);
    return result.rows;
  }

  static async findById(id) {
    const result = await pool.query('SELECT * FROM recurring_expenses WHERE id = $1', [id]);
    return result.rows[0];
  }

  static async create(data) {
    const { type, name, cost, is_fixed_rate, pay_account, company } = data;
    const result = await pool.query(
      `INSERT INTO recurring_expenses (type, name, cost, is_fixed_rate, pay_account, company)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [type, name, cost, is_fixed_rate ?? true, pay_account, company]
    );
    return result.rows[0];
  }

  static async update(id, data) {
    const { type, name, cost, is_fixed_rate, pay_account, company } = data;
    const result = await pool.query(
      `UPDATE recurring_expenses SET type = $1, name = $2, cost = $3, is_fixed_rate = $4,
       pay_account = $5, company = $6, updated_at = CURRENT_TIMESTAMP
       WHERE id = $7 RETURNING *`,
      [type, name, cost, is_fixed_rate, pay_account, company, id]
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

  static async createAutoTracked(data) {
    const result = await pool.query(
      `INSERT INTO recurring_expenses
        (type, name, cost, is_fixed_rate, pay_account, company, merchant_key, account_id,
         due_day, last_charge_date, charge_interval_days, is_auto_tracked)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, TRUE) RETURNING *`,
      [data.type, data.name, data.cost, data.is_fixed_rate, data.pay_account, data.company,
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

  static async getSummary() {
    const result = await pool.query(
      `SELECT type, COALESCE(SUM(cost), 0) as total
       FROM recurring_expenses GROUP BY type`
    );
    const summary = { bills: 0, subscriptions: 0, total: 0 };
    for (const row of result.rows) {
      if (row.type === 'bill') summary.bills = parseFloat(row.total);
      if (row.type === 'subscription') summary.subscriptions = parseFloat(row.total);
    }
    summary.total = summary.bills + summary.subscriptions;
    return summary;
  }
}

module.exports = RecurringExpense;

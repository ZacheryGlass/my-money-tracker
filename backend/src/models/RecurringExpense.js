const pool = require('../config/database');

class RecurringExpense {
  static async findAll(type) {
    let query = 'SELECT * FROM recurring_expenses';
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
    const { type, name, cost, is_fixed_rate, is_autopay, pay_account, company, who_uses, notes } = data;
    const result = await pool.query(
      `INSERT INTO recurring_expenses (type, name, cost, is_fixed_rate, is_autopay, pay_account, company, who_uses, notes)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
      [type, name, cost, is_fixed_rate ?? true, is_autopay ?? false, pay_account, company, who_uses, notes]
    );
    return result.rows[0];
  }

  static async update(id, data) {
    const { type, name, cost, is_fixed_rate, is_autopay, pay_account, company, who_uses, notes } = data;
    const result = await pool.query(
      `UPDATE recurring_expenses SET type = $1, name = $2, cost = $3, is_fixed_rate = $4, is_autopay = $5,
       pay_account = $6, company = $7, who_uses = $8, notes = $9, updated_at = CURRENT_TIMESTAMP
       WHERE id = $10 RETURNING *`,
      [type, name, cost, is_fixed_rate, is_autopay, pay_account, company, who_uses, notes, id]
    );
    return result.rows[0];
  }

  static async delete(id) {
    const result = await pool.query('DELETE FROM recurring_expenses WHERE id = $1 RETURNING id', [id]);
    return result.rows[0];
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

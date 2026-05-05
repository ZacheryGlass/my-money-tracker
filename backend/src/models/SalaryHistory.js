const pool = require('../config/database');

class SalaryHistory {
  static async findAll() {
    const result = await pool.query(
      'SELECT * FROM salary_history ORDER BY effective_date DESC'
    );
    return result.rows;
  }

  static async findById(id) {
    const result = await pool.query(
      'SELECT * FROM salary_history WHERE id = $1',
      [id]
    );
    return result.rows[0];
  }

  static async create(data) {
    const { effective_date, title, salary_amount, psu, rsu, total_comp, change_amount, change_percent } = data;
    const result = await pool.query(
      `INSERT INTO salary_history (effective_date, title, salary_amount, psu, rsu, total_comp, change_amount, change_percent)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
      [effective_date, title, salary_amount, psu || 0, rsu || 0, total_comp, change_amount, change_percent]
    );
    return result.rows[0];
  }

  static async update(id, data) {
    const { effective_date, title, salary_amount, psu, rsu, total_comp, change_amount, change_percent } = data;
    const result = await pool.query(
      `UPDATE salary_history SET effective_date = $1, title = $2, salary_amount = $3, psu = $4, rsu = $5,
       total_comp = $6, change_amount = $7, change_percent = $8 WHERE id = $9 RETURNING *`,
      [effective_date, title, salary_amount, psu || 0, rsu || 0, total_comp, change_amount, change_percent, id]
    );
    return result.rows[0];
  }

  static async delete(id) {
    const result = await pool.query(
      'DELETE FROM salary_history WHERE id = $1 RETURNING id',
      [id]
    );
    return result.rows[0];
  }
}

module.exports = SalaryHistory;

const pool = require('../config/database');

class SalaryHistory {
  static async findAll(userId) {
    const result = await pool.query(
      'SELECT * FROM salary_history WHERE user_id = $1 ORDER BY effective_date DESC',
      [userId]
    );
    return result.rows;
  }

  static async findById(id, userId) {
    const result = await pool.query(
      'SELECT * FROM salary_history WHERE id = $1 AND user_id = $2',
      [id, userId]
    );
    return result.rows[0];
  }

  static async create(userId, data) {
    const { effective_date, title, salary_amount, psu, rsu, total_comp, change_amount, change_percent } = data;
    const result = await pool.query(
      `INSERT INTO salary_history (user_id, effective_date, title, salary_amount, psu, rsu, total_comp, change_amount, change_percent)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
      [userId, effective_date, title, salary_amount, psu || 0, rsu || 0, total_comp, change_amount, change_percent]
    );
    return result.rows[0];
  }

  static async update(id, userId, data) {
    const { effective_date, title, salary_amount, psu, rsu, total_comp, change_amount, change_percent } = data;
    const result = await pool.query(
      `UPDATE salary_history SET effective_date = $1, title = $2, salary_amount = $3, psu = $4, rsu = $5,
       total_comp = $6, change_amount = $7, change_percent = $8 WHERE id = $9 AND user_id = $10 RETURNING *`,
      [effective_date, title, salary_amount, psu || 0, rsu || 0, total_comp, change_amount, change_percent, id, userId]
    );
    return result.rows[0];
  }

  static async delete(id, userId) {
    const result = await pool.query(
      'DELETE FROM salary_history WHERE id = $1 AND user_id = $2 RETURNING id',
      [id, userId]
    );
    return result.rows[0];
  }
}

module.exports = SalaryHistory;

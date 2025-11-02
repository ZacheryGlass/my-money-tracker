const pool = require('../config/database');

class Holding {
  static async findAll() {
    const result = await pool.query(
      'SELECT h.id, h.account_id, h.ticker, h.name, h.quantity, h.manual_value, h.category, h.notes, h.updated_at, a.name as account_name FROM holdings h JOIN accounts a ON h.account_id = a.id ORDER BY h.updated_at DESC'
    );
    return result.rows;
  }

  static async findById(id) {
    const result = await pool.query(
      'SELECT h.id, h.account_id, h.ticker, h.name, h.quantity, h.manual_value, h.category, h.notes, h.updated_at, a.name as account_name FROM holdings h JOIN accounts a ON h.account_id = a.id WHERE h.id = $1',
      [id]
    );
    return result.rows[0];
  }

  static async findByAccountId(accountId) {
    const result = await pool.query(
      'SELECT h.id, h.account_id, h.ticker, h.name, h.quantity, h.manual_value, h.category, h.notes, h.updated_at, a.name as account_name FROM holdings h JOIN accounts a ON h.account_id = a.id WHERE h.account_id = $1 ORDER BY h.updated_at DESC',
      [accountId]
    );
    return result.rows;
  }

  static async create(accountId, ticker, name, quantity, manualValue, category, notes) {
    const result = await pool.query(
      'INSERT INTO holdings (account_id, ticker, name, quantity, manual_value, category, notes) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *',
      [accountId, ticker, name, quantity, manualValue, category, notes]
    );
    return result.rows[0];
  }

  static async update(id, accountId, ticker, name, quantity, manualValue, category, notes) {
    const result = await pool.query(
      'UPDATE holdings SET account_id = $1, ticker = $2, name = $3, quantity = $4, manual_value = $5, category = $6, notes = $7, updated_at = CURRENT_TIMESTAMP WHERE id = $8 RETURNING *',
      [accountId, ticker, name, quantity, manualValue, category, notes, id]
    );
    return result.rows[0];
  }

  static async delete(id) {
    const result = await pool.query(
      'DELETE FROM holdings WHERE id = $1 RETURNING id',
      [id]
    );
    return result.rows[0];
  }
}

module.exports = Holding;

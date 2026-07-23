const pool = require('../config/database');

const ACCOUNT_DISPLAY_SELECT = "COALESCE(NULLIF(TRIM(a.display_name), ''), a.name) as account_name, a.name as account_source_name, a.display_name as account_display_name";

class Holding {
  // withPrices joins price_cache to compute current_value. Callers that recompute
  // value themselves (e.g. DashboardService) pass withPrices: false to skip the
  // join — the UPPER(...)=UPPER(...) predicate can't use the price_cache index.
  static async findAll({ includeHidden = true, withPrices = true } = {}) {
    const hiddenFilter = includeHidden ? '' : 'WHERE a.is_hidden = FALSE';
    const priceSelect = withPrices
      ? `,
        CASE
          WHEN h.ticker IS NOT NULL AND pc.price_usd IS NOT NULL AND h.quantity > 0 THEN h.quantity * pc.price_usd
          ELSE h.manual_value
        END as current_value`
      : '';
    const priceJoin = withPrices
      ? 'LEFT JOIN price_cache pc ON UPPER(h.ticker) = UPPER(pc.ticker)'
      : '';
    const result = await pool.query(
      `SELECT h.id, h.account_id, h.ticker, h.name, h.quantity, h.manual_value, h.category, h.notes, h.location, h.institution_cost_basis, h.institution_price, h.institution_price_as_of, h.is_plaid_managed, h.updated_at, ${ACCOUNT_DISPLAY_SELECT}, a.type as account_type${priceSelect}
      FROM holdings h
      JOIN accounts a ON h.account_id = a.id
      ${priceJoin}
      ${hiddenFilter}
      ORDER BY h.updated_at DESC`
    );
    return result.rows;
  }

  static async findById(id) {
    const result = await pool.query(
      `SELECT h.id, h.account_id, h.ticker, h.name, h.quantity, h.manual_value, h.category, h.notes, h.location, h.institution_cost_basis, h.institution_price, h.institution_price_as_of, h.is_plaid_managed, h.updated_at, ${ACCOUNT_DISPLAY_SELECT}, a.type as account_type FROM holdings h JOIN accounts a ON h.account_id = a.id WHERE h.id = $1`,
      [id]
    );
    return result.rows[0];
  }

  static async findByAccountId(accountId) {
    const result = await pool.query(
      `SELECT h.id, h.account_id, h.ticker, h.name, h.quantity, h.manual_value, h.category, h.notes, h.location, h.institution_cost_basis, h.institution_price, h.institution_price_as_of, h.is_plaid_managed, h.updated_at, ${ACCOUNT_DISPLAY_SELECT}, a.type as account_type FROM holdings h JOIN accounts a ON h.account_id = a.id WHERE h.account_id = $1 ORDER BY h.updated_at DESC`,
      [accountId]
    );
    return result.rows;
  }

  static async create(accountId, ticker, name, quantity, manualValue, category, notes, location) {
    const result = await pool.query(
      'INSERT INTO holdings (account_id, ticker, name, quantity, manual_value, category, notes, location) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *',
      [accountId, ticker, name, quantity, manualValue, category, notes, location]
    );
    return result.rows[0];
  }

  static async update(id, accountId, ticker, name, quantity, manualValue, category, notes, location) {
    const result = await pool.query(
      'UPDATE holdings SET account_id = $1, ticker = $2, name = $3, quantity = $4, manual_value = $5, category = $6, notes = $7, location = $8, updated_at = CURRENT_TIMESTAMP WHERE id = $9 RETURNING *',
      [accountId, ticker, name, quantity, manualValue, category, notes, location, id]
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

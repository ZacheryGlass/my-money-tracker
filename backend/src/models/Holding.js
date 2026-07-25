const pool = require('../config/database');

const ACCOUNT_DISPLAY_SELECT = "COALESCE(NULLIF(TRIM(a.display_name), ''), a.name) as account_name, a.name as account_source_name, a.display_name as account_display_name";

// Ownership scoping is fail-closed: a caller that forgets the userId gets an
// error, not every user's rows. The two legitimate cross-user callers (price
// updates and snapshots) say so at the call site via findAllForJobs.
function requireUserId(userId, method) {
  if (userId == null) {
    throw new Error(`Holding.${method} requires a userId; use findAllForJobs for cross-user reads`);
  }
}

class Holding {
  // withPrices joins price_cache to compute current_value. Callers that recompute
  // value themselves (e.g. DashboardService) pass withPrices: false to skip the
  // join — the UPPER(...)=UPPER(...) predicate can't use the price_cache index.
  static async findAll({ userId, includeHidden = true, withPrices = true } = {}) {
    requireUserId(userId, 'findAll');
    return this._selectAll({ userId, includeHidden, withPrices });
  }

  // Every user's holdings, for the global price-update and snapshot jobs only.
  static async findAllForJobs({ includeHidden = true, withPrices = true } = {}) {
    return this._selectAll({ userId: null, includeHidden, withPrices });
  }

  static async _selectAll({ userId, includeHidden, withPrices }) {
    const where = [];
    const params = [];
    if (userId != null) {
      params.push(userId);
      where.push(`a.user_id = $${params.length}`);
    }
    if (!includeHidden) where.push('a.is_hidden = FALSE');
    const whereClause = where.length ? `WHERE ${where.join(' AND ')}` : '';
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
      `SELECT h.id, h.account_id, h.ticker, h.name, h.quantity, h.manual_value, h.category, h.notes, h.location, h.institution_cost_basis, h.institution_price, h.institution_price_as_of, h.is_plaid_managed, a.eth_wallet_id AS account_eth_wallet_id, h.updated_at, ${ACCOUNT_DISPLAY_SELECT}, a.type as account_type${priceSelect}
      FROM holdings h
      JOIN accounts a ON h.account_id = a.id
      ${priceJoin}
      ${whereClause}
      ORDER BY h.updated_at DESC`,
      params
    );
    return result.rows;
  }

  static async findById(id, userId) {
    requireUserId(userId, 'findById');
    const params = [id, userId];
    const where = 'WHERE h.id = $1 AND a.user_id = $2';
    const result = await pool.query(
      `SELECT h.id, h.account_id, h.ticker, h.name, h.quantity, h.manual_value, h.category, h.notes, h.location, h.institution_cost_basis, h.institution_price, h.institution_price_as_of, h.is_plaid_managed, a.eth_wallet_id AS account_eth_wallet_id, h.updated_at, ${ACCOUNT_DISPLAY_SELECT}, a.type as account_type FROM holdings h JOIN accounts a ON h.account_id = a.id ${where}`,
      params
    );
    return result.rows[0];
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

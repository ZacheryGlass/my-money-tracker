const pool = require('../config/database');

class Trade {
  // Keyed on external_id (the Plaid investment_transaction_id) so re-syncing the
  // full history -- which _syncInvestmentTransactions does on every run -- updates
  // in place instead of duplicating.
  static async upsert({ accountId, tradeDate, symbol, side, quantity, price, fees, externalId, notes = null }) {
    const result = await pool.query(
      `INSERT INTO trades (account_id, trade_date, symbol, side, quantity, price, fees, external_id, notes)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (external_id) DO UPDATE
       SET account_id = EXCLUDED.account_id, trade_date = EXCLUDED.trade_date,
           symbol = EXCLUDED.symbol, side = EXCLUDED.side, quantity = EXCLUDED.quantity,
           price = EXCLUDED.price, fees = EXCLUDED.fees
       RETURNING *`,
      [accountId, tradeDate, symbol, side, quantity, price, fees, externalId, notes]
    );
    return result.rows[0];
  }

  // Ordered for FIFO lot construction: oldest first within each position, with id
  // as the tiebreaker so same-day trades replay in a stable order.
  static async findAllOrdered() {
    const result = await pool.query(
      `SELECT id, account_id, symbol, trade_date, side, quantity, price, fees
       FROM trades
       ORDER BY account_id, UPPER(symbol), trade_date, id`
    );
    return result.rows;
  }

  static async count() {
    const result = await pool.query('SELECT COUNT(*)::int AS count FROM trades');
    return result.rows[0].count;
  }
}

module.exports = Trade;

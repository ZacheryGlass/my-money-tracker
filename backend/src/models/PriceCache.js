const pool = require('../config/database');

class PriceCache {
  static async findByTicker(ticker) {
    const result = await pool.query(
      'SELECT * FROM price_cache WHERE ticker = $1',
      [ticker]
    );
    return result.rows[0];
  }

  static async getLatestPrices() {
    const result = await pool.query(
      'SELECT * FROM price_cache ORDER BY fetched_at DESC'
    );
    return result.rows;
  }

  static async upsert(ticker, priceUsd, source) {
    const result = await pool.query(
      `INSERT INTO price_cache (ticker, price_usd, source, fetched_at)
       VALUES ($1, $2, $3, CURRENT_TIMESTAMP)
       ON CONFLICT (ticker) DO UPDATE
       SET price_usd = $2, source = $3, fetched_at = CURRENT_TIMESTAMP
       RETURNING *`,
      [ticker, priceUsd, source]
    );
    return result.rows[0];
  }

  static async delete(ticker) {
    const result = await pool.query(
      'DELETE FROM price_cache WHERE ticker = $1 RETURNING ticker',
      [ticker]
    );
    return result.rows[0];
  }
}

module.exports = PriceCache;

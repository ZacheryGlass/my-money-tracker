const pool = require('../config/database');

class SecurityMaster {
  // Plaid is the only place security metadata is available, and it arrives as a
  // side effect of holdings and investment-transaction syncs. asset_class,
  // benchmark_symbol and is_liquid stay untouched so manual curation survives.
  static async upsert(symbol, name, securityType) {
    const result = await pool.query(
      `INSERT INTO security_master (symbol, name, security_type, updated_at)
       VALUES ($1, $2, $3, CURRENT_TIMESTAMP)
       ON CONFLICT (symbol) DO UPDATE
       SET name = COALESCE(EXCLUDED.name, security_master.name),
           security_type = COALESCE(EXCLUDED.security_type, security_master.security_type),
           updated_at = CURRENT_TIMESTAMP
       RETURNING *`,
      [symbol.toUpperCase(), name || null, securityType || null]
    );
    return result.rows[0];
  }
}

module.exports = SecurityMaster;

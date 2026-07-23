const pool = require('../config/database');

// Identifiers Plaid supplies that have no dedicated column. Merged into the
// existing metadata JSONB rather than replacing it, so hand-added keys survive.
const IDENTIFIER_FIELDS = ['figi', 'cusip', 'isin', 'sedol', 'market_identifier_code', 'cfi_code'];

class SecurityMaster {
  // Plaid is the only place security metadata is available, and it arrives as a
  // side effect of holdings and investment-transaction syncs. asset_class,
  // benchmark_symbol and is_liquid stay untouched so manual curation survives.
  static async upsert(security) {
    const symbol = security.ticker_symbol;
    const identifiers = {};
    for (const field of IDENTIFIER_FIELDS) {
      if (security[field] != null) identifiers[field] = security[field];
    }

    const result = await pool.query(
      `INSERT INTO security_master (symbol, name, security_type, sector, industry, is_cash_equivalent, metadata, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, CURRENT_TIMESTAMP)
       ON CONFLICT (symbol) DO UPDATE
       SET name = COALESCE(EXCLUDED.name, security_master.name),
           security_type = COALESCE(EXCLUDED.security_type, security_master.security_type),
           sector = COALESCE(EXCLUDED.sector, security_master.sector),
           industry = COALESCE(EXCLUDED.industry, security_master.industry),
           is_cash_equivalent = COALESCE(EXCLUDED.is_cash_equivalent, security_master.is_cash_equivalent),
           metadata = security_master.metadata || EXCLUDED.metadata,
           updated_at = CURRENT_TIMESTAMP
       RETURNING *`,
      [
        symbol.toUpperCase(),
        security.name || null,
        security.type || null,
        security.sector || null,
        security.industry || null,
        security.is_cash_equivalent ?? null,
        JSON.stringify(identifiers),
      ]
    );
    return result.rows[0];
  }
}

module.exports = SecurityMaster;

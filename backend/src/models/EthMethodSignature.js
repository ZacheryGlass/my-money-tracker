'use strict';

const pool = require('../config/database');

// The shared selector -> signature cache. Global by design (like price_cache):
// a 4-byte selector means the same thing on-chain for everyone, so there is no
// userId here and none of the fail-closed scoping the wallet tables carry.
class EthMethodSignature {
  // One round trip for the whole pending set. Returns a Map so callers can tell
  // "cached as a miss" (present, name null) from "never looked up" (absent) --
  // that distinction is the entire cache-once guarantee.
  static async findMany(selectors) {
    if (!selectors.length) return new Map();
    const result = await pool.query(
      'SELECT selector, name, source FROM eth_method_signatures WHERE selector = ANY($1)',
      [selectors]
    );
    return new Map(result.rows.map((row) => [row.selector, row]));
  }

  // DO NOTHING, not DO UPDATE: the first authoritative answer wins forever.
  // Re-answering would let a later miss overwrite a good name, and re-asking a
  // cached miss is exactly the repeated fetch this table exists to prevent.
  static async cache(selector, name, source) {
    await pool.query(
      `INSERT INTO eth_method_signatures (selector, name, source, fetched_at)
       VALUES ($1, $2, $3, CURRENT_TIMESTAMP)
       ON CONFLICT (selector) DO NOTHING`,
      [selector, name, source]
    );
  }
}

module.exports = EthMethodSignature;

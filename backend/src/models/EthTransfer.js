'use strict';

const pool = require('../config/database');

class EthTransfer {
  // Sync resumes from an overlap block and re-inserts everything from there,
  // so each feed's stale rows must be cleared first to keep ordinals unique.
  static async deleteFromBlock(walletId, transferTypes, block) {
    await pool.query(
      `DELETE FROM eth_transfers
       WHERE wallet_id = $1 AND transfer_type = ANY($2) AND block_number >= $3`,
      [walletId, transferTypes, block]
    );
  }

  static async bulkInsert(rows) {
    if (!rows.length) return 0;
    const cols = [
      'wallet_id', 'tx_hash', 'ordinal', 'transfer_type', 'block_number',
      'block_time', 'from_address', 'to_address', 'value_wei',
      'token_contract', 'token_symbol', 'token_decimals', 'is_error',
    ];
    // Chunked to stay far under Postgres' 65535-parameter cap on first syncs
    // of busy wallets.
    const CHUNK = 500;
    let inserted = 0;
    for (let start = 0; start < rows.length; start += CHUNK) {
      const chunk = rows.slice(start, start + CHUNK);
      const values = [];
      const placeholders = chunk.map((row, i) => {
        const base = i * cols.length;
        values.push(
          row.wallet_id, row.tx_hash, row.ordinal, row.transfer_type,
          row.block_number, row.block_time, row.from_address, row.to_address,
          row.value_wei, row.token_contract, row.token_symbol,
          row.token_decimals, row.is_error
        );
        return `(${cols.map((_, j) => `$${base + j + 1}`).join(', ')})`;
      });
      const result = await pool.query(
        `INSERT INTO eth_transfers (${cols.join(', ')})
         VALUES ${placeholders.join(', ')}
         ON CONFLICT (wallet_id, transfer_type, tx_hash, ordinal) DO NOTHING`,
        values
      );
      inserted += result.rowCount;
    }
    return inserted;
  }

  static async findByWallet(walletId, { type, limit = 100, offset = 0 } = {}) {
    const params = [walletId];
    let where = 'WHERE t.wallet_id = $1';
    if (type === 'self') {
      where += " AND t.transfer_type <> 'gas' AND t.counterparty_is_own = TRUE";
    } else if (type === 'external') {
      where += " AND t.transfer_type <> 'gas' AND t.counterparty_is_own = FALSE";
    } else if (type === 'gas') {
      where += " AND t.transfer_type = 'gas'";
    } else if (type === 'token') {
      where += " AND t.transfer_type = 'token'";
    }
    params.push(limit, offset);
    const result = await pool.query(
      `SELECT t.*,
              COUNT(*) OVER() AS total_count
       FROM eth_transfers t
       ${where}
       ORDER BY t.block_number DESC, t.transfer_type, t.ordinal
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );
    const total = result.rows.length ? Number(result.rows[0].total_count) : 0;
    return {
      transfers: result.rows.map((row) => {
        const rest = { ...row };
        delete rest.total_count;
        return rest;
      }),
      total,
    };
  }

  // Net token balance per contract from transfer deltas. Failed transfers
  // moved nothing, and gas rows never carry a token contract.
  static async tokenBalanceDeltas(walletId) {
    const result = await pool.query(
      `SELECT t.token_contract,
              MAX(t.token_symbol) AS token_symbol,
              MAX(t.token_decimals) AS token_decimals,
              SUM(CASE WHEN t.to_address = w.address THEN t.value_wei ELSE 0 END) -
              SUM(CASE WHEN t.from_address = w.address THEN t.value_wei ELSE 0 END) AS balance_units
       FROM eth_transfers t
       JOIN eth_wallets w ON w.id = t.wallet_id
       WHERE t.wallet_id = $1
         AND t.transfer_type = 'token'
         AND t.is_error = FALSE
         AND t.token_contract IS NOT NULL
         AND t.token_contract NOT IN (SELECT contract_address FROM eth_ignored_tokens)
       GROUP BY t.token_contract`,
      [walletId]
    );
    return result.rows;
  }

  // The self/external split depends on the current wallet set, so it is
  // recomputed wholesale on every sync and on wallet add/remove.
  static async reclassifyOwnCounterparties() {
    await pool.query(
      `UPDATE eth_transfers t SET counterparty_is_own =
         (CASE WHEN t.from_address = w.address THEN t.to_address ELSE t.from_address END)
           IN (SELECT address FROM eth_wallets)
       FROM eth_wallets w
       WHERE t.wallet_id = w.id`
    );
  }
}

module.exports = EthTransfer;

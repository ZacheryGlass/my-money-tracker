'use strict';

const pool = require('../config/database');

// Per-(wallet, chain) sync state: resume cursors, the error/degraded slot, and
// the record of which feeds this chain could not serve. Rows are created by
// migration 039 for existing wallets (as chain 1) and by ensure() for every
// chain a sync touches after that -- a wallet added post-039, or an operator
// enabling a new chain, must not have to wait for a reboot to get a row.
//
// Scope note: this is a CHILD table. Ownership lives on eth_wallets, and every
// caller here already holds a wallet the requesting user owns, so these methods
// take a walletId directly -- the same contract as EthTransfer's.
class EthWalletChain {
  static async ensure(walletId, chainId) {
    const inserted = await pool.query(
      `INSERT INTO eth_wallet_chains (wallet_id, chain_id)
       VALUES ($1, $2)
       -- DO NOTHING, not DO UPDATE: this runs at the top of every chain's sync,
       -- and an upsert that wrote anything would either clobber live cursors or
       -- make updated_at meaningless. RETURNING is empty on conflict, which is
       -- what the re-select below is for.
       ON CONFLICT (wallet_id, chain_id) DO NOTHING
       RETURNING *`,
      [walletId, chainId]
    );
    if (inserted.rows[0]) return inserted.rows[0];
    const existing = await pool.query(
      'SELECT * FROM eth_wallet_chains WHERE wallet_id = $1 AND chain_id = $2',
      [walletId, chainId]
    );
    return existing.rows[0];
  }

  // Every stored chain for the wallet, INCLUDING chains that are no longer
  // enabled. Callers that clean up derived data depend on seeing those: a
  // disabled chain's rows must be left alone, and they can only be left alone
  // if something still knows they exist.
  static async findForWallet(walletId) {
    const result = await pool.query(
      'SELECT * FROM eth_wallet_chains WHERE wallet_id = $1 ORDER BY chain_id',
      [walletId]
    );
    return result.rows;
  }

  static async findAllForWallets(walletIds) {
    if (!walletIds.length) return [];
    const result = await pool.query(
      'SELECT * FROM eth_wallet_chains WHERE wallet_id = ANY($1) ORDER BY wallet_id, chain_id',
      [walletIds]
    );
    return result.rows;
  }

  // One cursor per feed. A NULL means that feed produced nothing this run --
  // either genuinely empty or skipped -- which must leave its cursor where it
  // was rather than reset it to 0.
  static async updateCursors(walletId, chainId, { normal, internal, token, nft, nft1155 }) {
    const result = await pool.query(
      `UPDATE eth_wallet_chains
       SET last_block_normal = COALESCE($3, last_block_normal),
           last_block_internal = COALESCE($4, last_block_internal),
           last_block_token = COALESCE($5, last_block_token),
           last_block_nft = COALESCE($6, last_block_nft),
           last_block_1155 = COALESCE($7, last_block_1155),
           updated_at = CURRENT_TIMESTAMP
       WHERE wallet_id = $1 AND chain_id = $2
       RETURNING *`,
      [walletId, chainId, normal ?? null, internal ?? null, token ?? null, nft ?? null, nft1155 ?? null]
    );
    return result.rows[0];
  }

  static async updateSyncTime(walletId, chainId) {
    const result = await pool.query(
      `UPDATE eth_wallet_chains
       SET last_synced_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
       WHERE wallet_id = $1 AND chain_id = $2
       RETURNING *`,
      [walletId, chainId]
    );
    return result.rows[0];
  }

  // Written on every sync of the chain, including with an empty array, so a
  // feed that starts working again (a plan upgrade, an Etherscan rollout)
  // clears its gap instead of warning about drift forever.
  static async setUnsupportedFeeds(walletId, chainId, feeds) {
    const result = await pool.query(
      `UPDATE eth_wallet_chains
       SET unsupported_feeds = $3, updated_at = CURRENT_TIMESTAMP
       WHERE wallet_id = $1 AND chain_id = $2
       RETURNING *`,
      [walletId, chainId, feeds]
    );
    return result.rows[0];
  }

  static async setError(walletId, chainId, errorCode, errorMessage) {
    const result = await pool.query(
      `UPDATE eth_wallet_chains
       SET error_code = $3, error_message = $4, updated_at = CURRENT_TIMESTAMP
       WHERE wallet_id = $1 AND chain_id = $2
       RETURNING *`,
      [walletId, chainId, errorCode, errorMessage]
    );
    return result.rows[0];
  }

  static async clearError(walletId, chainId) {
    const result = await pool.query(
      `UPDATE eth_wallet_chains
       SET error_code = NULL, error_message = NULL, updated_at = CURRENT_TIMESTAMP
       WHERE wallet_id = $1 AND chain_id = $2
       RETURNING *`,
      [walletId, chainId]
    );
    return result.rows[0];
  }
}

module.exports = EthWalletChain;

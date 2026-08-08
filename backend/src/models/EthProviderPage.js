'use strict';

const crypto = require('node:crypto');
const pool = require('../config/database');

function stableJson(value) {
  if (Array.isArray(value)) return value.map(stableJson);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableJson(value[key])]));
  }
  return value;
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

// Ordinary Base Sync has its own raw-page journal. The audit evidence plane is
// intentionally not reused: a user-initiated sync and a full audit have
// different lifetimes and different restart cursors, but both must retain what
// the provider actually returned.
class EthProviderPage {
  static async record({
    walletId, chainId, provider, stream, scanId, cursorIn = null, cursorOut = null,
    requestParams = {}, responseSha256, responseRaw = null, responseJson = {}, itemCount = 0,
    owner = null,
  }) {
    if (!responseRaw || sha256(responseRaw) !== String(responseSha256 || '').toLowerCase()) {
      const error = new Error('Base CDP raw page is missing or its response hash does not match');
      error.code = 'CDP_INVALID_RAW_PAGE';
      throw error;
    }
    const transactional = Boolean(owner);
    const client = transactional ? await pool.connect() : pool;
    try {
      if (transactional) {
        await client.query('BEGIN');
        const owned = await client.query(
          `SELECT 1 FROM eth_wallet_chains
            WHERE wallet_id = $1 AND chain_id = $2
              AND provider_scan_id = $3::uuid AND provider_scan_owner = $4
              AND provider_scan_status = 'running'
              AND provider_scan_lease_expires_at > CURRENT_TIMESTAMP
            FOR UPDATE`,
          [walletId, chainId, scanId, owner]
        );
        if (!owned.rows[0]) {
          const error = new Error('Base CDP scan is no longer the active writer');
          error.code = 'CDP_SCAN_STALE';
          throw error;
        }
      }
      const inserted = await client.query(
        `INSERT INTO eth_provider_pages (
         wallet_id, chain_id, provider, stream, scan_id, cursor_in, cursor_out,
         request_params, response_sha256, response_raw, response_json, item_count
       ) VALUES ($1,$2,$3,$4,$5::uuid,$6,$7,$8::jsonb,$9,$10,$11::jsonb,$12)
       ON CONFLICT (wallet_id, chain_id, provider, stream, scan_id, response_sha256)
       DO NOTHING
       RETURNING *`,
      [
        walletId, chainId, provider, stream, scanId, cursorIn, cursorOut,
        JSON.stringify(requestParams), responseSha256, responseRaw,
        JSON.stringify(responseJson), itemCount,
      ]
      );
      let row = inserted.rows[0];
      if (!row) {
        const existing = await client.query(
          `SELECT * FROM eth_provider_pages
            WHERE wallet_id = $1 AND chain_id = $2 AND provider = $3
              AND stream = $4 AND scan_id = $5::uuid AND response_sha256 = $6`,
          [walletId, chainId, provider, stream, scanId, responseSha256]
        );
        row = existing.rows[0];
        if (!row || String(row.cursor_in || '') !== String(cursorIn || '')
            || String(row.cursor_out || '') !== String(cursorOut || '')
            || JSON.stringify(stableJson(row.request_params))
              !== JSON.stringify(stableJson(requestParams))
            || String(row.response_raw || '') !== String(responseRaw)) {
          const error = new Error('Coinbase CDP returned conflicting data for an already journaled page');
          error.code = 'CDP_CONFLICTING_PAGE';
          throw error;
        }
      }
      if (transactional) await client.query('COMMIT');
      return row;
    } catch (error) {
      if (transactional) await client.query('ROLLBACK');
      throw error;
    } finally {
      if (transactional) client.release();
    }
  }

  static async forScan(walletId, chainId, scanId) {
    const result = await pool.query(
      `SELECT * FROM eth_provider_pages
        WHERE wallet_id = $1 AND chain_id = $2 AND scan_id = $3::uuid
        ORDER BY id`,
      [walletId, chainId, scanId]
    );
    return result.rows;
  }

  static async forWalletChain(walletId, chainId, provider = 'coinbase-cdp') {
    const result = await pool.query(
      `SELECT * FROM eth_provider_pages
        WHERE wallet_id = $1 AND chain_id = $2 AND provider = $3
        ORDER BY id`,
      [walletId, chainId, provider]
    );
    return result.rows;
  }
}

module.exports = EthProviderPage;

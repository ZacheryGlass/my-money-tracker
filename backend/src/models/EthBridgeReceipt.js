'use strict';

const pool = require('../config/database');

const HASH_RE = /^0x[0-9a-f]{64}$/;
const ADDRESS_RE = /^0x[0-9a-f]{40}$/;
const HEX_RE = /^0x(?:[0-9a-f]{2})*$/;
const lower = (value) => String(value || '').toLowerCase();

function parseHexInteger(value) {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return value;
  if (typeof value === 'string' && /^0x[0-9a-f]+$/i.test(value)) {
    const parsed = Number.parseInt(value, 16);
    return Number.isSafeInteger(parsed) ? parsed : null;
  }
  if (typeof value === 'string' && /^\d+$/.test(value)) {
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) ? parsed : null;
  }
  return null;
}

function validateEvidence(txHash, transaction, receipt) {
  const hash = lower(txHash);
  if (!HASH_RE.test(hash)) throw new Error('Bridge receipt has an invalid transaction hash');
  if (!transaction || lower(transaction.hash) !== hash) {
    throw new Error('Bridge transaction response does not match the requested hash');
  }
  if (!receipt || lower(receipt.transactionHash) !== hash) {
    throw new Error('Bridge receipt response does not match the requested hash');
  }
  const blockNumber = parseHexInteger(receipt.blockNumber);
  const blockHash = lower(receipt.blockHash);
  const status = parseHexInteger(receipt.status);
  if (blockNumber == null || !HASH_RE.test(blockHash)) {
    throw new Error('Bridge receipt is missing a valid block boundary');
  }
  if (status !== 0 && status !== 1) {
    throw new Error('Bridge receipt is missing a valid execution status');
  }
  if (transaction.blockHash != null && lower(transaction.blockHash) !== blockHash) {
    throw new Error('Bridge transaction and receipt disagree on block hash');
  }
  if (!Array.isArray(receipt.logs)) throw new Error('Bridge receipt logs are not an array');
  const seen = new Set();
  for (const log of receipt.logs) {
    const index = parseHexInteger(log?.logIndex);
    if (!log || !ADDRESS_RE.test(lower(log.address)) || index == null
        || !Array.isArray(log.topics) || log.topics.some((topic) => !HASH_RE.test(lower(topic)))
        || !HEX_RE.test(lower(log.data)) || lower(log.transactionHash) !== hash
        || lower(log.blockHash) !== blockHash || seen.has(index)) {
      throw new Error('Bridge receipt contains a malformed or duplicate log');
    }
    seen.add(index);
  }
  return { hash, blockNumber, blockHash, status };
}

class EthBridgeReceipt {
  static async recordAttempt({
    walletId, chainId, txHash, provider, providerBoundary, status,
    errorCode = null, errorDetail = null,
  }) {
    await pool.query(
      `INSERT INTO eth_bridge_receipt_attempts
         (wallet_id, chain_id, tx_hash, provider, status, provider_boundary,
          error_code, error_detail)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8)`,
      [
        walletId, chainId, lower(txHash), provider, status,
        JSON.stringify(providerBoundary || {}), errorCode,
        errorDetail == null ? null : String(errorDetail).slice(0, 500),
      ]
    );
  }

  static async findForUser(userId, client = pool) {
    if (!userId) throw new Error('EthBridgeReceipt.findForUser requires a userId');
    const { rows } = await client.query(
      `SELECT r.*
         FROM eth_bridge_receipts r
         JOIN eth_wallets w ON w.id = r.wallet_id
        WHERE w.user_id = $1
        ORDER BY r.chain_id, r.tx_hash`,
      [userId]
    );
    return rows;
  }

  static async findOne(walletId, chainId, txHash) {
    const { rows } = await pool.query(
      `SELECT * FROM eth_bridge_receipts
        WHERE wallet_id = $1 AND chain_id = $2 AND tx_hash = $3`,
      [walletId, chainId, lower(txHash)]
    );
    return rows[0] || null;
  }

  static async upsertComplete({
    walletId, chainId, txHash, provider, providerBoundary, transaction, receipt,
  }) {
    const validated = validateEvidence(txHash, transaction, receipt);
    const previous = await this.findOne(walletId, chainId, validated.hash);
    const changedBlock = previous?.block_hash != null
      && previous.block_hash !== validated.blockHash;
    const priorReorgs = Array.isArray(previous?.provider_boundary?.reorg_history)
      ? previous.provider_boundary.reorg_history.slice(-4)
      : [];
    const durableBoundary = {
      ...(providerBoundary || {}),
      ...(changedBlock ? {
        reorg_history: [...priorReorgs, {
          previous_block_hash: previous.block_hash,
          replacement_block_hash: validated.blockHash,
          detected_at: new Date().toISOString(),
        }],
      } : (priorReorgs.length ? { reorg_history: priorReorgs } : {})),
    };
    const { rows } = await pool.query(
      `INSERT INTO eth_bridge_receipts
         (wallet_id, chain_id, tx_hash, fetch_status, provider, provider_boundary,
          block_number, block_hash, transaction_json, receipt_json,
          error_code, error_detail, fetched_at, invalidated_at, invalidation_reason)
       VALUES ($1, $2, $3, 'complete', $4, $5::jsonb, $6, $7, $8::jsonb, $9::jsonb,
               NULL, NULL, NOW(), NULL, NULL)
       ON CONFLICT (wallet_id, chain_id, tx_hash) DO UPDATE SET
         fetch_status = 'complete', provider = EXCLUDED.provider,
         provider_boundary = EXCLUDED.provider_boundary,
         block_number = EXCLUDED.block_number, block_hash = EXCLUDED.block_hash,
         transaction_json = EXCLUDED.transaction_json, receipt_json = EXCLUDED.receipt_json,
         error_code = NULL, error_detail = NULL, fetched_at = NOW(),
         invalidated_at = NULL, invalidation_reason = NULL
       RETURNING *`,
      [
        walletId, chainId, validated.hash, provider,
        JSON.stringify(durableBoundary), validated.blockNumber, validated.blockHash,
        JSON.stringify(transaction), JSON.stringify(receipt),
      ]
    );
    await this.recordAttempt({
      walletId, chainId, txHash: validated.hash, provider,
      providerBoundary: durableBoundary, status: 'complete',
    });
    return { receipt: rows[0], changedBlock };
  }

  static async upsertFailure({
    walletId, chainId, txHash, provider, providerBoundary, status = 'failed',
    errorCode, errorDetail,
  }) {
    const hash = lower(txHash);
    if (!HASH_RE.test(hash)) throw new Error('Bridge failure receipt has an invalid transaction hash');
    if (!['failed', 'unsupported', 'invalidated'].includes(status) || !errorCode) {
      throw new Error('Bridge failure receipt requires a bounded status and error code');
    }
    const detail = String(errorDetail || errorCode).slice(0, 500);
    const previous = await this.findOne(walletId, chainId, hash);
    const priorReorgs = Array.isArray(previous?.provider_boundary?.reorg_history)
      ? previous.provider_boundary.reorg_history.slice(-5)
      : [];
    const durableBoundary = {
      ...(providerBoundary || {}),
      ...(priorReorgs.length ? { reorg_history: priorReorgs } : {}),
      ...(previous?.block_hash ? {
        stale_evidence: {
          block_number: previous.block_number == null ? null : String(previous.block_number),
          block_hash: previous.block_hash,
          last_complete_at: previous.fetched_at,
        },
      } : {}),
    };
    const { rows } = await pool.query(
      `INSERT INTO eth_bridge_receipts
         (wallet_id, chain_id, tx_hash, fetch_status, provider, provider_boundary,
          error_code, error_detail, fetched_at,
          invalidated_at, invalidation_reason)
       VALUES ($1, $2, $3, $4::text, $5::text, $6::jsonb, $7::text, $8::text, NOW(),
               CASE WHEN $4::text = 'invalidated' THEN NOW() ELSE NULL END,
               CASE WHEN $4::text = 'invalidated' THEN $7::text ELSE NULL END)
       ON CONFLICT (wallet_id, chain_id, tx_hash) DO UPDATE SET
         fetch_status = EXCLUDED.fetch_status, provider = EXCLUDED.provider,
         provider_boundary = EXCLUDED.provider_boundary,
         error_code = EXCLUDED.error_code, error_detail = EXCLUDED.error_detail,
         fetched_at = NOW(), invalidated_at = EXCLUDED.invalidated_at,
         invalidation_reason = EXCLUDED.invalidation_reason
       RETURNING *`,
      [walletId, chainId, hash, status, provider, JSON.stringify(durableBoundary), errorCode, detail]
    );
    await this.recordAttempt({
      walletId, chainId, txHash: hash, provider, providerBoundary: durableBoundary,
      status: status === 'invalidated' ? 'failed' : status,
      errorCode, errorDetail: detail,
    });
    return rows[0];
  }
}

module.exports = EthBridgeReceipt;
module.exports.parseHexInteger = parseHexInteger;
module.exports.validateEvidence = validateEvidence;

'use strict';

const EtherscanService = require('./EtherscanService');
const EthWallet = require('../models/EthWallet');
const EthTransfer = require('../models/EthTransfer');
const logger = require('../config/logger');

const ADDRESS_RE = /^0x[0-9a-f]{40}$/i;

// Sync resumes this many blocks before the stored cursor so a chain reorg
// near the tip is healed by the delete-then-reinsert ingest.
const REORG_OVERLAP_BLOCKS = 12;

function toTimestamp(unixSeconds) {
  return new Date(Number(unixSeconds) * 1000);
}

function maxBlock(rows) {
  let max = null;
  for (const row of rows) {
    const block = Number(row.blockNumber);
    if (max === null || block > max) max = block;
  }
  return max;
}

class EthWalletService {
  // Pure: raw Etherscan feed rows -> eth_transfers rows (without wallet_id).
  // Gas rows are synthesized here, one per normal tx sent by the wallet --
  // including failed txs, which still burn gas. Zero-value normal/internal
  // rows (contract calls, approvals) are dropped as noise; their economic
  // content is the gas row and/or the token row from the token feed.
  static normalizeFeeds(walletAddress, { normal = [], internal = [], token = [] } = {}) {
    const wallet = walletAddress.toLowerCase();
    const rows = [];
    const ordinals = new Map();

    const nextOrdinal = (transferType, txHash) => {
      const key = `${transferType}:${txHash}`;
      const ordinal = ordinals.get(key) || 0;
      ordinals.set(key, ordinal + 1);
      return ordinal;
    };

    const baseRow = (raw, transferType) => ({
      tx_hash: raw.hash,
      ordinal: nextOrdinal(transferType, raw.hash),
      transfer_type: transferType,
      block_number: Number(raw.blockNumber),
      block_time: toTimestamp(raw.timeStamp),
      from_address: (raw.from || '').toLowerCase(),
      to_address: raw.to ? raw.to.toLowerCase() : null,
      value_wei: '0',
      token_contract: null,
      token_symbol: null,
      token_decimals: null,
      is_error: raw.isError === '1',
    });

    for (const raw of normal) {
      if (raw.value !== '0') {
        rows.push({ ...baseRow(raw, 'native'), value_wei: raw.value });
      }
      if ((raw.from || '').toLowerCase() === wallet) {
        const fee = BigInt(raw.gasUsed || 0) * BigInt(raw.gasPrice || 0);
        rows.push({
          ...baseRow(raw, 'gas'),
          value_wei: fee.toString(),
          is_error: false,
        });
      }
    }

    for (const raw of internal) {
      if (raw.value === '0') continue;
      rows.push({ ...baseRow(raw, 'internal'), value_wei: raw.value });
    }

    for (const raw of token) {
      rows.push({
        ...baseRow(raw, 'token'),
        value_wei: raw.value,
        token_contract: (raw.contractAddress || '').toLowerCase() || null,
        token_symbol: raw.tokenSymbol || null,
        token_decimals: raw.tokenDecimal != null ? Number(raw.tokenDecimal) : null,
        is_error: false,
      });
    }

    return rows;
  }

  static async syncWallet(walletId) {
    const wallet = await EthWallet.findById(walletId);
    if (!wallet) throw new Error(`EthWallet ${walletId} not found`);
    EtherscanService.ensureConfigured();

    try {
      const resume = {
        normal: Math.max(0, Number(wallet.last_block_normal) - REORG_OVERLAP_BLOCKS),
        internal: Math.max(0, Number(wallet.last_block_internal) - REORG_OVERLAP_BLOCKS),
        token: Math.max(0, Number(wallet.last_block_token) - REORG_OVERLAP_BLOCKS),
      };

      const normal = await EtherscanService.fetchNormalTxs(wallet.address, resume.normal);
      const internal = await EtherscanService.fetchInternalTxs(wallet.address, resume.internal);
      const token = await EtherscanService.fetchTokenTxs(wallet.address, resume.token);

      const rows = this.normalizeFeeds(wallet.address, { normal, internal, token })
        .map((row) => ({ ...row, wallet_id: walletId }));

      // Gas rows derive from the normal feed, so they share its resume block.
      await EthTransfer.deleteFromBlock(walletId, ['native', 'gas'], resume.normal);
      await EthTransfer.deleteFromBlock(walletId, ['internal'], resume.internal);
      await EthTransfer.deleteFromBlock(walletId, ['token'], resume.token);
      const inserted = await EthTransfer.bulkInsert(rows);

      await EthWallet.updateCursors(walletId, {
        normal: maxBlock(normal),
        internal: maxBlock(internal),
        token: maxBlock(token),
      });
      await EthTransfer.reclassifyOwnCounterparties();
      await EthWallet.clearError(walletId);
      await EthWallet.updateSyncTime(walletId);

      const results = {
        inserted,
        fetched: { normal: normal.length, internal: internal.length, token: token.length },
      };
      logger.info({ walletId, address: wallet.address, results }, 'ETH wallet sync completed');
      return results;
    } catch (err) {
      await EthWallet.setError(walletId, err.code || 'SYNC_ERROR', err.message);
      throw err;
    }
  }

  static async syncAllWallets() {
    const wallets = await EthWallet.findAll();
    const summary = { processed: 0, succeeded: 0, failed: 0, results: [] };

    for (const wallet of wallets) {
      summary.processed++;
      try {
        const result = await this.syncWallet(wallet.id);
        summary.succeeded++;
        summary.results.push({ walletId: wallet.id, address: wallet.address, ...result });
      } catch (err) {
        summary.failed++;
        summary.results.push({ walletId: wallet.id, address: wallet.address, error: err.message });
        logger.error({ walletId: wallet.id, err }, 'Failed to sync ETH wallet');
      }
    }

    return summary;
  }

  static async addWallet(address, label) {
    if (typeof address !== 'string' || !ADDRESS_RE.test(address.trim())) {
      const error = new Error('address must be a 0x-prefixed 40-hex-character Ethereum address');
      error.code = 'INVALID_ADDRESS';
      throw error;
    }
    const normalized = address.trim().toLowerCase();

    const existing = await EthWallet.findByAddress(normalized);
    if (existing) {
      const error = new Error('That address is already tracked');
      error.code = 'DUPLICATE_WALLET';
      throw error;
    }

    const wallet = await EthWallet.create(normalized, label);
    // A new own-address can turn previously-external transfers into
    // self-transfers on other wallets.
    await EthTransfer.reclassifyOwnCounterparties();
    logger.info({ walletId: wallet.id, address: normalized }, 'ETH wallet added');
    return wallet;
  }

  static async removeWallet(walletId, { removeData = false } = {}) {
    const wallet = await EthWallet.findById(walletId);
    if (!wallet) throw new Error(`EthWallet ${walletId} not found`);

    await EthWallet.delete(walletId, { removeData });
    await EthTransfer.reclassifyOwnCounterparties();
    logger.info({ walletId, removeData }, 'ETH wallet disconnected');
  }
}

module.exports = EthWalletService;
module.exports.REORG_OVERLAP_BLOCKS = REORG_OVERLAP_BLOCKS;

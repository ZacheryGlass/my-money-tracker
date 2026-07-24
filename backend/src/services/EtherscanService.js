'use strict';

const axios = require('axios');
const etherscan = require('../config/etherscan');
const logger = require('../config/logger');

// Etherscan caps any single query window at 10k results, so paged fetches
// walk a block cursor instead of page numbers (see _fetchPaged).
const PAGE_SIZE = 1000;

class EtherscanService {
  static ensureConfigured() {
    if (!etherscan.isConfigured()) {
      const error = new Error('Etherscan is not configured. Set ETHERSCAN_API_KEY.');
      error.code = 'ETHERSCAN_NOT_CONFIGURED';
      throw error;
    }
  }

  static async _request(params, { attempt = 0 } = {}) {
    this.ensureConfigured();
    const response = await etherscan.throttled(() =>
      axios.get(etherscan.BASE_URL, {
        timeout: 15000,
        params: {
          chainid: etherscan.CHAIN_ID,
          apikey: etherscan.apiKey(),
          ...params,
        },
      })
    );

    const { status, message, result } = response.data || {};
    if (status === '1') return result;

    // "No transactions found" is a normal empty feed, not an error.
    if (message === 'No transactions found' || (Array.isArray(result) && result.length === 0)) {
      return [];
    }
    if (typeof result === 'string' && result.includes('rate limit') && attempt === 0) {
      logger.warn({ params: { module: params.module, action: params.action } }, 'Etherscan rate limited, retrying once');
      await new Promise((resolve) => setTimeout(resolve, 1100));
      return this._request(params, { attempt: 1 });
    }

    const error = new Error(`Etherscan error: ${message || 'unknown'} ${typeof result === 'string' ? result : ''}`.trim());
    error.code = 'ETHERSCAN_API_ERROR';
    throw error;
  }

  // Current balance in wei, as a string (values exceed Number precision).
  static async getEthBalance(address) {
    const result = await this._request({
      module: 'account',
      action: 'balance',
      address,
      tag: 'latest',
    });
    // A malformed response must not silently zero the ETH holding.
    if (typeof result !== 'string' || !/^\d+$/.test(result)) {
      const error = new Error(`Etherscan returned an invalid balance: ${JSON.stringify(result)}`);
      error.code = 'ETHERSCAN_API_ERROR';
      throw error;
    }
    return result;
  }

  // Walks blocks in ascending order. The cursor advances to the last block of
  // each full page WITHOUT +1: a block can be split across the page boundary,
  // so that block is refetched whole and its partial rows are dropped first.
  static async _fetchPaged(action, address, startBlock) {
    const all = [];
    let cursor = startBlock;

    for (;;) {
      const rows = await this._request({
        module: 'account',
        action,
        address,
        startblock: cursor,
        endblock: 99999999,
        page: 1,
        offset: PAGE_SIZE,
        sort: 'asc',
      });
      if (!Array.isArray(rows) || rows.length === 0) break;
      // The dedupe logic depends on ascending order; do not trust the API.
      rows.sort((a, b) => Number(a.blockNumber) - Number(b.blockNumber));

      while (all.length && Number(all[all.length - 1].blockNumber) >= cursor) {
        all.pop();
      }

      const lastBlock = Number(rows[rows.length - 1].blockNumber);
      if (rows.length >= PAGE_SIZE && lastBlock === cursor) {
        // A single block with more rows than one page. Refetch just that
        // block at Etherscan's maximum window so its rows are not lost, then
        // step past it.
        const blockRows = await this._request({
          module: 'account',
          action,
          address,
          startblock: cursor,
          endblock: cursor,
          page: 1,
          offset: 10000,
          sort: 'asc',
        });
        all.push(...(Array.isArray(blockRows) ? blockRows : []));
        if (Array.isArray(blockRows) && blockRows.length >= 10000) {
          logger.warn({ action, address, block: cursor }, 'Etherscan block exceeds 10k rows; excess rows dropped');
        }
        cursor += 1;
        continue;
      }

      all.push(...rows);
      if (rows.length < PAGE_SIZE) break;
      cursor = lastBlock;
    }

    return all;
  }

  static fetchNormalTxs(address, startBlock = 0) {
    return this._fetchPaged('txlist', address, startBlock);
  }

  static fetchInternalTxs(address, startBlock = 0) {
    return this._fetchPaged('txlistinternal', address, startBlock);
  }

  static fetchTokenTxs(address, startBlock = 0) {
    return this._fetchPaged('tokentx', address, startBlock);
  }
}

module.exports = EtherscanService;

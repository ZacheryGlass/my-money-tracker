'use strict';

const axios = require('axios');
const etherscan = require('../config/etherscan');
const logger = require('../config/logger');

// Etherscan caps any single query window at 10k results, so paged fetches
// walk a block cursor instead of page numbers (see _fetchPaged).
const PAGE_SIZE = 1000;

// A chain this key cannot read AT ALL, as opposed to a request that failed.
// Both observed live: an id outside /v2/chainlist answers "Missing or
// unsupported chainid parameter", and a chainlist chain outside the key's plan
// (OP Mainnet, Base on the free tier) answers "Free API access is not supported
// for this chain". Separated from ETHERSCAN_API_ERROR because the two demand
// opposite handling: an API error is transient and must be retried next sync,
// while this is a standing condition, so retrying it nightly forever would
// burn throttle budget and log noise to learn the same answer. The caller
// records it as a gap on the chain instead.
const CHAIN_UNAVAILABLE_RE = /free api access is not supported for this chain|missing or unsupported chainid/i;

// ONE feed the chain cannot serve, with the other feeds fine. Etherscan answers
// an action it does not implement with "Error! Missing Or invalid Action name"
// (probed live). Distinct from CHAIN_UNAVAILABLE because that one is a verdict
// on the whole chain and lets the caller stop after a single request, while this
// one says nothing about its neighbours.
//
// Worth knowing: this was NOT observed on any chain in the registry -- all five
// account feeds answered on every served chain, txlistinternal included. It is
// handled anyway because the alternative, if Etherscan ever drops a feed on one
// chain, is a permanent transient-looking error that retries nightly forever and
// never records the gap that explains the drift.
const FEED_UNSUPPORTED_RE = /missing or invalid (action|module) name/i;

class EtherscanService {
  // Keys are per-user (Settings -> API Keys, env fallback), resolved by the
  // caller and threaded through every fetch. chainId defaults to mainnet so
  // every pre-#58 call site keeps its exact behavior.
  static async _request(params, { apiKey, chainId = etherscan.CHAIN_ID, attempt = 0 }) {
    if (!apiKey) {
      const error = new Error('Etherscan is not configured. Add your Etherscan key under Settings -> API Keys.');
      error.code = 'ETHERSCAN_NOT_CONFIGURED';
      throw error;
    }
    const response = await etherscan.throttled(() =>
      axios.get(etherscan.BASE_URL, {
        timeout: 15000,
        params: {
          chainid: chainId,
          apikey: apiKey,
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
      logger.warn({ chainId, params: { module: params.module, action: params.action } }, 'Etherscan rate limited, retrying once');
      await new Promise((resolve) => setTimeout(resolve, 1100));
      return this._request(params, { apiKey, chainId, attempt: 1 });
    }

    const detail = `${message || ''} ${typeof result === 'string' ? result : ''}`;
    if (CHAIN_UNAVAILABLE_RE.test(detail)) {
      const error = new Error(`Etherscan cannot serve chain ${chainId} with this API key: ${detail.trim()}`);
      error.code = 'ETHERSCAN_CHAIN_UNAVAILABLE';
      error.chainId = chainId;
      throw error;
    }
    if (FEED_UNSUPPORTED_RE.test(detail)) {
      const error = new Error(`Etherscan does not serve ${params.action} on chain ${chainId}: ${detail.trim()}`);
      error.code = 'ETHERSCAN_FEED_UNSUPPORTED';
      error.chainId = chainId;
      throw error;
    }

    const error = new Error(`Etherscan error: ${message || 'unknown'} ${typeof result === 'string' ? result : ''}`.trim());
    error.code = 'ETHERSCAN_API_ERROR';
    throw error;
  }

  // Current balance in wei, as a string (values exceed Number precision).
  // Per chain: the native asset is ETH on every chain in the registry, so this
  // is the chain's ETH balance, not a share of one global figure.
  static async getEthBalance(address, apiKey, chainId = etherscan.CHAIN_ID) {
    const result = await this._request({
      module: 'account',
      action: 'balance',
      address,
      tag: 'latest',
    }, { apiKey, chainId });
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
  static async _fetchPaged(action, address, startBlock, apiKey, chainId = etherscan.CHAIN_ID) {
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
      }, { apiKey, chainId });
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
        }, { apiKey, chainId });
        all.push(...(Array.isArray(blockRows) ? blockRows : []));
        if (Array.isArray(blockRows) && blockRows.length >= 10000) {
          logger.warn({ action, address, chainId, block: cursor }, 'Etherscan block exceeds 10k rows; excess rows dropped');
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

  // All five feeds take the chain as a trailing argument that defaults to
  // mainnet: the same five actions serve every chain in the registry (verified
  // live per chain), so the only thing that varies is the chainid param.
  static fetchNormalTxs(address, startBlock = 0, apiKey, chainId = etherscan.CHAIN_ID) {
    return this._fetchPaged('txlist', address, startBlock, apiKey, chainId);
  }

  static fetchInternalTxs(address, startBlock = 0, apiKey, chainId = etherscan.CHAIN_ID) {
    return this._fetchPaged('txlistinternal', address, startBlock, apiKey, chainId);
  }

  // ERC-20 only; ERC-721 and ERC-1155 have their own feeds below.
  static fetchTokenTxs(address, startBlock = 0, apiKey, chainId = etherscan.CHAIN_ID) {
    return this._fetchPaged('tokentx', address, startBlock, apiKey, chainId);
  }

  // ERC-721. Rows carry tokenID and tokenDecimal ("0"), but no value field --
  // one indivisible token moves per row.
  static fetchNftTxs(address, startBlock = 0, apiKey, chainId = etherscan.CHAIN_ID) {
    return this._fetchPaged('tokennfttx', address, startBlock, apiKey, chainId);
  }

  // ERC-1155. Rows carry tokenID and tokenValue (a count of units, not wei),
  // and Etherscan emits one row per id for a batch transfer.
  static fetch1155Txs(address, startBlock = 0, apiKey, chainId = etherscan.CHAIN_ID) {
    return this._fetchPaged('token1155tx', address, startBlock, apiKey, chainId);
  }
}

module.exports = EtherscanService;

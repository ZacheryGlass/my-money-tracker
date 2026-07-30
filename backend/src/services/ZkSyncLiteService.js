'use strict';

const axios = require('axios');
const etherscan = require('../config/etherscan');

// zkSync Lite was not an EVM chain and therefore never had an EIP-155 chain
// id. The app still needs a stable positive integer because chain_id is the
// identity used by the unified transfer/activity/holdings tables and APIs.
// 32401 is deliberately app-internal: 324 remains zkSync Era.
const CHAIN_ID = 32401;
const API_BASE_URL = 'https://api.zksync.io/api/v0.2';
const EXPLORER_BASE_URL = 'https://zkscan.io';
const BRIDGE_ADDRESS = '0xabea9132b05a70803a4e85094fd0e1800777fbef';
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
const PAGE_SIZE = 100;
const MAX_PAGES = 1000;
const MAX_FUNGIBLE_TOKEN_ID = 65535;

let tokenCache = null;
let tokenCacheAt = 0;
const TOKEN_CACHE_MS = 60 * 60 * 1000;

function address(value) {
  const normalized = String(value || '').toLowerCase();
  return /^0x[0-9a-f]{40}$/.test(normalized) ? normalized : null;
}

function uint(value, field) {
  const text = String(value ?? '');
  if (!/^\d+$/.test(text)) {
    throw new Error(`zkSync Lite returned an invalid ${field}: ${JSON.stringify(value)}`);
  }
  return text;
}

function tokenIdFrom(op, ...keys) {
  for (const key of keys) {
    if (op[key] != null && Number.isInteger(Number(op[key])) && Number(op[key]) >= 0) {
      return Number(op[key]);
    }
  }
  return null;
}

function blockTime(value) {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`zkSync Lite returned an invalid transaction timestamp: ${JSON.stringify(value)}`);
  }
  return parsed;
}

class ZkSyncLiteService {
  static get CHAIN_ID() { return CHAIN_ID; }
  static get API_BASE_URL() { return API_BASE_URL; }
  static get EXPLORER_BASE_URL() { return EXPLORER_BASE_URL; }
  static get BRIDGE_ADDRESS() { return BRIDGE_ADDRESS; }

  static async _request(path, params = {}, { allowNull = false } = {}) {
    const response = await etherscan.throttled(() =>
      axios.get(`${API_BASE_URL}${path}`, { timeout: 15000, params })
    );
    const payload = response.data || {};
    if (payload.status !== 'success' || payload.error
        || (!allowNull && payload.result == null)) {
      const detail = payload.error?.message || payload.status || 'invalid response';
      const error = new Error(`zkSync Lite API error: ${detail}`);
      error.code = 'ZKSYNC_LITE_API_ERROR';
      throw error;
    }
    return payload.result;
  }

  static async getAccount(addressValue) {
    const result = await this._request(`/accounts/${addressValue}`, {}, { allowNull: true });
    if (result == null) {
      return {
        depositing: { balances: {} },
        committed: {
          accountId: null,
          address: String(addressValue).toLowerCase(),
          lastUpdateInBlock: 0,
          balances: {},
          nfts: {},
        },
        finalized: null,
      };
    }
    if (!result.committed || typeof result.committed.balances !== 'object') {
      const error = new Error('zkSync Lite account response is missing committed balances');
      error.code = 'ZKSYNC_LITE_API_ERROR';
      throw error;
    }
    return result;
  }

  static async getTokens({ force = false } = {}) {
    if (!force && tokenCache && Date.now() - tokenCacheAt < TOKEN_CACHE_MS) {
      return tokenCache;
    }

    const byId = new Map();
    let from = 0;
    for (let page = 1; page <= MAX_PAGES; page++) {
      const result = await this._request('/tokens', {
        from,
        limit: PAGE_SIZE,
        direction: 'newer',
      });
      if (!Array.isArray(result.list)) {
        throw new Error('zkSync Lite token registry returned a non-array list');
      }
      for (const token of result.list) {
        const id = Number(token?.id);
        const contract = address(token?.address);
        const decimals = Number(token?.decimals);
        if (!Number.isInteger(id) || id < 0 || !contract
            || !Number.isInteger(decimals) || decimals < 0 || decimals > 255
            || typeof token.symbol !== 'string' || !token.symbol) {
          throw new Error('zkSync Lite token registry returned a malformed token');
        }
        byId.set(id, {
          id,
          address: contract,
          symbol: token.symbol.slice(0, 64),
          decimals,
        });
      }
      if (result.list.length < PAGE_SIZE) break;
      const next = Number(result.list.at(-1)?.id);
      if (!Number.isInteger(next) || next <= from) {
        throw new Error('zkSync Lite token pagination did not advance');
      }
      from = next;
      if (page === MAX_PAGES) {
        throw new Error(`zkSync Lite token pagination exceeded ${MAX_PAGES} pages`);
      }
    }
    if (!byId.has(0) || byId.get(0).symbol !== 'ETH') {
      throw new Error('zkSync Lite token registry is missing token 0 (ETH)');
    }
    tokenCache = byId;
    tokenCacheAt = Date.now();
    return byId;
  }

  // The archive paginates from a transaction hash, newest to oldest. Every
  // sync begins at latest and stops once it crosses the overlap block supplied
  // by the normal cursor. That makes an initial sync exhaustive and later
  // syncs incremental without introducing a second, provider-specific cursor
  // table. The boundary hash may be inclusive, so hashes are deduplicated.
  static async fetchHistory(addressValue, startBlock = 0) {
    const seen = new Set();
    const transactions = [];
    let from = 'latest';
    let scannedThroughBlock = 0;

    for (let page = 1; page <= MAX_PAGES; page++) {
      const result = await this._request(`/accounts/${addressValue}/transactions`, {
        from,
        limit: PAGE_SIZE,
        direction: 'older',
      }, { allowNull: true });
      if (result == null) break;
      if (!Array.isArray(result.list)) {
        throw new Error('zkSync Lite transaction history returned a non-array list');
      }
      let oldest = null;
      for (const tx of result.list) {
        if (!/^0x[0-9a-f]{64}$/i.test(String(tx?.txHash || ''))
            || !Number.isInteger(Number(tx?.blockNumber)) || Number(tx.blockNumber) < 0
            || !tx.op || typeof tx.op.type !== 'string') {
          throw new Error('zkSync Lite transaction history returned a malformed transaction');
        }
        const block = Number(tx.blockNumber);
        if (oldest == null || block < oldest) oldest = block;
        if (block > scannedThroughBlock) scannedThroughBlock = block;
        const hash = tx.txHash.toLowerCase();
        if (block >= startBlock && !seen.has(hash)) {
          seen.add(hash);
          transactions.push({ ...tx, txHash: hash });
        }
      }
      if (result.list.length < PAGE_SIZE || (oldest != null && oldest < startBlock)) break;
      const next = String(result.list.at(-1)?.txHash || '').toLowerCase();
      if (!/^0x[0-9a-f]{64}$/.test(next) || next === from) {
        throw new Error('zkSync Lite transaction pagination did not advance');
      }
      from = next;
      if (page === MAX_PAGES) {
        throw new Error(`zkSync Lite history exceeded ${MAX_PAGES} pages`);
      }
    }

    return { transactions, scannedThroughBlock };
  }

  static _tokenInfo(id, tokens, op) {
    const known = tokens.get(id);
    if (known) return { ...known, nft: false };
    if (id > MAX_FUNGIBLE_TOKEN_ID) {
      return {
        id,
        address: address(op.creatorAddress) || address(op.from) || ZERO_ADDRESS,
        symbol: `NFT-${id}`,
        decimals: 0,
        nft: true,
      };
    }
    throw new Error(`zkSync Lite transaction references unknown fungible token ${id}`);
  }

  // Archive transaction objects become ordinary eth_transfers legs. No second
  // ledger or UI-only records: activity grouping, notes, labels, bridge
  // matching, dated prices and holdings all consume these rows unchanged.
  static normalizeTransactions(walletAddress, transactions, tokens, { accountId = null } = {}) {
    const wallet = address(walletAddress);
    if (!wallet) throw new Error('Invalid wallet address for zkSync Lite normalization');

    const rows = [];
    const limitations = new Set();
    const ordinals = new Map();
    const nextOrdinal = (type, hash) => {
      const key = `${type}:${hash}`;
      const value = ordinals.get(key) || 0;
      ordinals.set(key, value + 1);
      return value;
    };

    const base = (tx, type) => ({
      tx_hash: tx.txHash.toLowerCase(),
      ordinal: nextOrdinal(type, tx.txHash.toLowerCase()),
      transfer_type: type,
      block_number: Number(tx.blockNumber),
      block_time: blockTime(tx.createdAt),
      from_address: wallet,
      to_address: BRIDGE_ADDRESS,
      value_wei: '0',
      token_contract: null,
      token_symbol: null,
      token_decimals: null,
      token_standard: null,
      token_id: null,
      is_error: tx.status === 'rejected' || Boolean(tx.failReason),
      tx_is_error: null,
      method_id: null,
      method_name: null,
    });

    const addAsset = (tx, id, fromValue, toValue, amountValue, methodName) => {
      const op = tx.op;
      const info = this._tokenInfo(id, tokens, op);
      const type = info.nft ? 'nft' : (id === 0 ? 'native' : 'token');
      const fromAddress = address(fromValue);
      const toAddress = address(toValue);
      if (!fromAddress || !toAddress) {
        throw new Error(`zkSync Lite ${op.type} has an invalid endpoint`);
      }
      rows.push({
        ...base(tx, type),
        from_address: fromAddress,
        to_address: toAddress,
        value_wei: info.nft ? '1' : uint(amountValue, `${op.type} amount`),
        token_contract: type === 'native' ? null : info.address,
        token_symbol: type === 'native' ? null : info.symbol,
        token_decimals: type === 'native' ? null : info.decimals,
        token_standard: info.nft ? 'erc721' : (type === 'token' ? 'erc20' : null),
        token_id: info.nft ? String(id) : null,
        method_name: methodName,
      });
    };

    const addFee = (tx, id, payerValue) => {
      const payer = address(payerValue);
      const fee = uint(tx.op.fee ?? 0, `${tx.op.type} fee`);
      if (!payer || payer !== wallet || fee === '0') return;
      const info = this._tokenInfo(id, tokens, tx.op);
      const type = id === 0 ? 'gas' : 'token';
      rows.push({
        ...base(tx, type),
        from_address: wallet,
        to_address: BRIDGE_ADDRESS,
        value_wei: fee,
        token_contract: type === 'token' ? info.address : null,
        token_symbol: type === 'token' ? info.symbol : null,
        token_decimals: type === 'token' ? info.decimals : null,
        token_standard: type === 'token' ? 'erc20' : null,
        // A failed Lite transaction does not execute its asset movement, but
        // its explicit fee is still the economic leg represented here.
        is_error: false,
        tx_is_error: tx.status === 'rejected' || Boolean(tx.failReason),
        method_name: `zkSync Lite ${tx.op.type}`,
      });
    };

    const addLimitation = (tx, text) => {
      limitations.add('legacy_amounts');
      rows.push({
        ...base(tx, 'native'),
        from_address: wallet,
        to_address: BRIDGE_ADDRESS,
        value_wei: '0',
        method_name: `zkSync Lite ${tx.op.type} (${text})`,
      });
    };

    for (const tx of transactions) {
      const op = tx.op;
      const method = `zkSync Lite ${op.type}`;
      switch (op.type) {
        case 'Deposit': {
          const id = tokenIdFrom(op, 'tokenId', 'token');
          addAsset(tx, id, BRIDGE_ADDRESS, op.to, op.amount, method);
          break;
        }
        case 'Transfer': {
          const id = tokenIdFrom(op, 'token', 'tokenId');
          addAsset(tx, id, op.from, op.to, op.amount, method);
          addFee(tx, id, op.from);
          break;
        }
        case 'Withdraw': {
          const id = tokenIdFrom(op, 'tokenId', 'token');
          addAsset(tx, id, op.from, BRIDGE_ADDRESS, op.amount, method);
          addFee(tx, id, op.from);
          break;
        }
        case 'ChangePubKey': {
          addFee(tx, tokenIdFrom(op, 'feeTokenId', 'feeToken'), op.account);
          break;
        }
        case 'Swap': {
          if (!Array.isArray(op.orders) || op.orders.length !== 2
              || !Array.isArray(op.amounts) || op.amounts.length !== 2) {
            addLimitation(tx, 'swap shape unavailable');
            break;
          }
          for (let i = 0; i < 2; i++) {
            const order = op.orders[i];
            const other = op.orders[1 - i];
            const ownsOrder = accountId != null && Number(order.accountId) === Number(accountId);
            if (ownsOrder) {
              addAsset(tx, Number(order.tokenSell), wallet, BRIDGE_ADDRESS, op.amounts[i], method);
            }
            if (address(order.recipient) === wallet) {
              addAsset(tx, Number(order.tokenBuy), BRIDGE_ADDRESS, wallet, op.amounts[1 - i], method);
            }
            // Referencing `other` is an intentional validation that both sides
            // name compatible numeric token ids before any rows are accepted.
            if (!Number.isInteger(Number(other.tokenSell)) || !Number.isInteger(Number(order.tokenBuy))) {
              throw new Error('zkSync Lite Swap contains invalid token ids');
            }
          }
          addFee(tx, tokenIdFrom(op, 'feeToken'), op.submitterAddress);
          break;
        }
        case 'WithdrawNFT': {
          const id = tokenIdFrom(op, 'token', 'tokenId');
          addAsset(tx, id, op.from, BRIDGE_ADDRESS, 1, method);
          addFee(tx, tokenIdFrom(op, 'feeToken'), op.from);
          break;
        }
        case 'MintNFT':
          // The archive operation carries contentHash but not the allocated NFT
          // token id. Preserve the transaction and fee, and surface the exact
          // limitation instead of inventing an asset identity.
          addFee(tx, tokenIdFrom(op, 'feeToken'), op.creatorAddress);
          addLimitation(tx, 'NFT id unavailable');
          break;
        case 'FullExit':
          if (op.amount != null && address(op.owner || wallet)) {
            addAsset(
              tx,
              tokenIdFrom(op, 'tokenId', 'token'),
              op.owner || wallet,
              BRIDGE_ADDRESS,
              op.amount,
              method
            );
          } else {
            addLimitation(tx, 'exit amount unavailable');
          }
          break;
        case 'ForcedExit':
          // The initiator pays only the explicit fee. The target's withdrawn
          // amount is absent from this archive shape, so retain a visible row
          // and mark reconciliation incomplete when this wallet is the target.
          addFee(
            tx,
            tokenIdFrom(op, 'tokenId', 'token'),
            accountId != null && Number(op.initiatorAccountId) === Number(accountId)
              ? wallet
              : op.initiator
          );
          if (address(op.target) === wallet) addLimitation(tx, 'forced-exit amount unavailable');
          break;
        default:
          addLimitation(tx, 'unsupported operation shape');
      }
    }

    return { rows, limitations: [...limitations] };
  }

  static async getBalance(addressValue, tokenContract = null) {
    const [account, tokens] = await Promise.all([this.getAccount(addressValue), this.getTokens()]);
    const balances = account.committed.balances || {};
    if (tokenContract == null) return uint(balances.ETH ?? '0', 'ETH balance');
    const contract = address(tokenContract);
    const token = [...tokens.values()].find((entry) => entry.address === contract);
    if (!token) return '0';
    return uint(balances[token.symbol] ?? '0', `${token.symbol} balance`);
  }
}

module.exports = ZkSyncLiteService;

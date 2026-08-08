'use strict';

const chains = require('../../config/chains');
const { sha256 } = require('./normalizer');

const hostQueues = new Map();

function rpcError(message, code, extra = {}) {
  const error = new Error(message);
  error.code = code;
  Object.assign(error, extra);
  return error;
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function quantity(value, label) {
  if (typeof value !== 'string' || !/^0x[0-9a-f]+$/i.test(value)) {
    throw rpcError(`Consensus RPC returned an invalid ${label}`, 'RPC_INVALID_RESPONSE');
  }
  return BigInt(value);
}

class RpcClient {
  constructor(chainId, { spacingMs = 200, onFailedAttempt = null } = {}) {
    const chain = chains.getChain(chainId);
    if (!chain?.rpcUrl) throw rpcError(`Chain ${chainId} has no configured consensus RPC`, 'RPC_UNSUPPORTED');
    this.chainId = Number(chainId);
    this.url = chain.rpcUrl;
    this.host = new URL(chain.rpcUrl).host;
    this.spacingMs = spacingMs;
    this.onFailedAttempt = onFailedAttempt;
  }

  async _scheduled(task) {
    const previous = hostQueues.get(this.host) || Promise.resolve();
    const run = previous.catch(() => {}).then(async () => {
      await wait(this.spacingMs);
      return task();
    });
    const queued = run.finally(() => {
      if (hostQueues.get(this.host) === queued) hostQueues.delete(this.host);
    });
    hostQueues.set(this.host, queued);
    return run;
  }

  async requestWithEvidence(method, params) {
    return this._scheduled(async () => {
      let response;
      try {
        response = await fetch(this.url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
          signal: AbortSignal.timeout(30_000),
        });
      } catch (cause) {
        await this.onFailedAttempt?.({
          provider: 'consensus-rpc', endpoint: method, method: 'POST', attemptNo: 1,
          requestParams: { method, params }, outcome: 'failed',
          errorCode: 'RPC_TRANSPORT_ERROR', errorDetail: 'Network request failed before a response.',
        });
        throw rpcError(`Consensus RPC ${method} request failed`, 'RPC_TRANSPORT_ERROR', { cause });
      }
      const text = await response.text();
      let body;
      try { body = JSON.parse(text); } catch { body = null; }
      if (!response.ok || body?.error || body?.result == null) {
        await this.onFailedAttempt?.({
          provider: 'consensus-rpc', endpoint: method, method: 'POST', attemptNo: 1,
          requestParams: { method, params }, outcome: response.status === 429 ? 'deferred' : 'failed',
          httpStatus: response.status,
          errorCode: response.status === 429 ? 'RPC_RATE_LIMITED' : 'RPC_API_ERROR',
          errorDetail: String(body?.error?.message || `HTTP ${response.status}`).slice(0, 500),
          requestId: response.headers.get('x-request-id') || null,
          responseSha256: sha256(text), responseRaw: text, responseJson: body,
        });
        throw rpcError(
          `Consensus RPC ${method} failed${body?.error?.message ? `: ${String(body.error.message).slice(0, 300)}` : ''}`,
          response.status === 429 ? 'RPC_RATE_LIMITED' : 'RPC_API_ERROR',
          { httpStatus: response.status }
        );
      }
      return {
        result: body.result,
        rawText: text,
        responseJson: body,
        responseSha256: sha256(text),
        requestId: response.headers.get('x-request-id') || null,
        httpStatus: response.status,
        method,
        params,
      };
    });
  }

  async request(method, params) {
    return (await this.requestWithEvidence(method, params)).result;
  }

  async finalizedBoundary() {
    const block = await this.request('eth_getBlockByNumber', ['finalized', false]);
    if (!block || !/^0x[0-9a-f]{64}$/i.test(String(block.hash || ''))) {
      throw rpcError('Consensus RPC returned an invalid finalized block', 'RPC_FINALITY_UNAVAILABLE');
    }
    return {
      number: Number(quantity(block.number, 'finalized block number')),
      numberHex: block.number,
      hash: String(block.hash).toLowerCase(),
      timestamp: new Date(Number(quantity(block.timestamp, 'finalized block timestamp')) * 1000).toISOString(),
    };
  }

  async transactionCount(address, blockTag) {
    return quantity(
      await this.request('eth_getTransactionCount', [address, blockTag]),
      'transaction count'
    );
  }

  async transactionCountWithEvidence(address, blockTag) {
    const response = await this.requestWithEvidence(
      'eth_getTransactionCount', [address, blockTag]
    );
    return {
      value: quantity(response.result, 'transaction count'),
      evidence: response,
    };
  }

  async balance(address, blockTag) {
    return quantity(await this.request('eth_getBalance', [address, blockTag]), 'native balance');
  }

  async balanceWithEvidence(address, blockTag) {
    const response = await this.requestWithEvidence('eth_getBalance', [address, blockTag]);
    return {
      value: quantity(response.result, 'native balance'),
      evidence: response,
    };
  }

  async code(address, blockTag) {
    const value = await this.request('eth_getCode', [address, blockTag]);
    if (typeof value !== 'string' || !/^0x[0-9a-f]*$/i.test(value)) {
      throw rpcError('Consensus RPC returned invalid account code', 'RPC_INVALID_RESPONSE');
    }
    return value.toLowerCase();
  }

  async codeWithEvidence(address, blockTag) {
    const response = await this.requestWithEvidence('eth_getCode', [address, blockTag]);
    if (typeof response.result !== 'string' || !/^0x[0-9a-f]*$/i.test(response.result)) {
      throw rpcError('Consensus RPC returned invalid account code', 'RPC_INVALID_RESPONSE');
    }
    return {
      value: response.result.toLowerCase(),
      evidence: response,
    };
  }

  async erc20Balance(contract, address, blockTag) {
    const data = `0x70a08231${address.toLowerCase().slice(2).padStart(64, '0')}`;
    return quantity(
      await this.request('eth_call', [{ to: contract, data }, blockTag]),
      'ERC-20 balance'
    );
  }

  async erc20BalanceWithEvidence(contract, address, blockTag) {
    const data = `0x70a08231${address.toLowerCase().slice(2).padStart(64, '0')}`;
    const response = await this.requestWithEvidence(
      'eth_call', [{ to: contract, data }, blockTag]
    );
    return {
      value: quantity(response.result, 'ERC-20 balance'),
      evidence: response,
    };
  }

  async transactionAndReceipt(hash) {
    const transactionResponse = await this.requestWithEvidence(
      'eth_getTransactionByHash', [hash]
    );
    const receiptResponse = await this.requestWithEvidence(
      'eth_getTransactionReceipt', [hash]
    );
    const transaction = transactionResponse.result;
    const receipt = receiptResponse.result;
    if (!transaction || !receipt) {
      throw rpcError('Consensus RPC could not find a mined transaction and receipt', 'RPC_TRANSACTION_NOT_FOUND');
    }
    const requested = String(hash).toLowerCase();
    const txHash = String(transaction.hash || '').toLowerCase();
    const receiptHash = String(receipt.transactionHash || '').toLowerCase();
    if (txHash !== requested || receiptHash !== requested
        || transaction.blockNumber == null || receipt.blockNumber == null
        || BigInt(transaction.blockNumber) !== BigInt(receipt.blockNumber)
        || String(transaction.blockHash || '').toLowerCase() !== String(receipt.blockHash || '').toLowerCase()) {
      throw rpcError('Consensus RPC returned conflicting transaction/receipt coordinates', 'RPC_IDENTITY_MISMATCH');
    }
    const blockResponse = await this.requestWithEvidence(
      'eth_getBlockByNumber', [transaction.blockNumber, false]
    );
    const block = blockResponse.result;
    if (String(block?.hash || '').toLowerCase() !== String(transaction.blockHash || '').toLowerCase()
        || BigInt(block?.number || '-1') !== BigInt(transaction.blockNumber)) {
      throw rpcError('Consensus RPC transaction is not in the canonical block at its height', 'RPC_CANONICALITY_MISMATCH');
    }
    return {
      transaction,
      receipt,
      block,
      evidence: [transactionResponse, receiptResponse, blockResponse],
    };
  }
}

module.exports = RpcClient;
module.exports.quantity = quantity;

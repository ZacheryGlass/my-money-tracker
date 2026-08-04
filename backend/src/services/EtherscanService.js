'use strict';

const axios = require('axios');
const etherscan = require('../config/etherscan');
const chains = require('../config/chains');
const logger = require('../config/logger');
const ZkSyncLiteService = require('./ZkSyncLiteService');

// Etherscan caps any single query window at 10k results, so paged fetches
// walk a block cursor instead of page numbers (see _fetchPaged).
const PAGE_SIZE = 1000;

// Bounds the account-feed walk for the same reason MAX_LOG_PAGES bounds
// getLogs below. A provider that ignores startblock can otherwise keep one
// wallet inside the global throttle forever. Two hundred full pages is
// 200,000 rows for ONE wallet/feed/chain; exceeding that is unusual enough to
// require a deliberate provider/export path rather than silently tying up the
// nightly job.
const MAX_ACCOUNT_PAGES = 200;

// The logs (getLogs) endpoint caps a single response at 1000 rows, so the
// state-sync fetch walks a block cursor the same way _fetchPaged does. A wallet
// has a handful of bridge deposits over its whole life, so this almost never
// pages -- but a correct paginator costs little and a wrong one drops credits.
const LOG_PAGE_SIZE = 1000;

// Bounds the state-sync log walk. Hitting it means the API is not honouring
// fromBlock (or pages that never advance) -- a walk that spins would sit
// INSIDE the per-user rebuild lane holding the global throttle, blocking every
// label write and sync for that user. Exhaustion is a transport failure: the
// feed is skipped, the cursor stays frozen, and the next sync retries.
const MAX_LOG_PAGES = 200;

// Coverage dates are block facts, not wallet facts. A nightly run walks many
// wallets over the same small chain set, so cache the genesis/head timestamp
// lookups rather than spending two provider requests per wallet. Bound the map
// because a new indexed head arrives every night in a long-running process.
const BLOCK_TIMESTAMP_CACHE_MAX = 500;
const blockTimestampCache = new Map();
const FINALIZED_BLOCK_CACHE_MS = 60 * 1000;
const finalizedBlockCache = new Map();

function rpcQuantity(value) {
  if (typeof value !== 'string' || !/^0x[0-9a-f]+$/i.test(value)) return null;
  try { return BigInt(value); } catch { return null; }
}

function buildFinalityBoundary(receipt, finalizedBlock, error = null) {
  const method = 'eth_getBlockByNumber(finalized)';
  if (error) {
    return {
      status: 'unknown', method,
      error_code: error.code || 'FINALIZED_BLOCK_UNAVAILABLE',
    };
  }
  const receiptNumber = rpcQuantity(receipt?.blockNumber);
  const finalizedNumber = rpcQuantity(finalizedBlock?.number);
  const finalizedHash = String(finalizedBlock?.hash || '').toLowerCase();
  if (receiptNumber == null || finalizedNumber == null
      || !/^0x[0-9a-f]{64}$/.test(finalizedHash)) {
    return { status: 'unknown', method, error_code: 'INVALID_FINALIZED_BLOCK' };
  }
  return {
    status: receiptNumber <= finalizedNumber ? 'finalized' : 'pending',
    method,
    receipt_block_number: receiptNumber.toString(),
    finalized_block_number: finalizedNumber.toString(),
    finalized_block_hash: finalizedHash,
  };
}

// An EVM address as a 32-byte indexed log topic: 12 zero bytes then the 20
// address bytes. This is how getLogs matches on an indexed `address` argument
// (the Deposit event's `from`/user in topic2).
function addressTopic(address) {
  return `0x${'0'.repeat(24)}${String(address).toLowerCase().replace(/^0x/, '')}`;
}

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
const FEED_UNSUPPORTED_RE = /missing or invalid (action|module) name|internal transactions .*not yet been processed/i;

// Public JSON-RPC providers rate-limit historical log walks independently of
// the Etherscan-shaped account-feed throttle. A 200 response may carry the
// limit in a single JSON-RPC error envelope, or one item in an otherwise valid
// batch may carry it. Retry the complete batch so no partial window can ever
// be accepted as coverage.
const RPC_RATE_LIMIT_RE = /rate limit|over rate|too many requests|429/i;
const RPC_BATCH_MAX_RETRIES = 3;
const EXPLORER_MAX_RETRIES = 4;

function explorerRetryDelay(error, attempt) {
  const header = error?.response?.headers?.['retry-after'];
  if (header != null && /^\d+(?:\.\d+)?$/.test(String(header))) {
    return Math.min(30000, Math.max(0, Number(header) * 1000));
  }
  return Math.min(30000, 1100 * (2 ** attempt));
}

class EtherscanService {
  // Preserve the public service contract while allowing a chain to route its
  // Etherscan-shaped account feeds through a different explorer. The caller
  // still passes one chain id and receives the same normalized raw rows; only
  // transport selection lives here.
  static _provider(chainId) {
    const custom = chains.getChain(chainId)?.accountApi;
    if (custom) {
      return {
        name: custom.provider || 'chain explorer',
        baseUrl: custom.baseUrl,
        requiresApiKey: custom.requiresApiKey !== false,
        params: {},
      };
    }
    return {
      name: 'Etherscan',
      baseUrl: etherscan.BASE_URL,
      requiresApiKey: true,
      params: { chainid: chainId },
    };
  }

  // Keys are per-user (Settings -> API Keys, env fallback), resolved by the
  // caller and threaded through every fetch. chainId defaults to mainnet so
  // every pre-#58 call site keeps its exact behavior.
  static async _request(params, { apiKey, chainId = etherscan.CHAIN_ID, attempt = 0 }) {
    const provider = this._provider(chainId);
    if (provider.requiresApiKey && !apiKey) {
      const error = new Error('Etherscan is not configured. Add your Etherscan key under Settings -> API Keys.');
      error.code = 'ETHERSCAN_NOT_CONFIGURED';
      throw error;
    }
    let response;
    try {
      response = await etherscan.throttled(() =>
        axios.get(provider.baseUrl, {
          timeout: 15000,
          params: {
            ...provider.params,
            ...(provider.requiresApiKey ? { apikey: apiKey } : {}),
            ...params,
          },
        })
      );
    } catch (error) {
      if (error?.response?.status === 429 && attempt < EXPLORER_MAX_RETRIES) {
        const delayMs = explorerRetryDelay(error, attempt);
        logger.warn({
          chainId, provider: provider.name, attempt: attempt + 1, delayMs,
          params: { module: params.module, action: params.action },
        }, 'Chain explorer returned HTTP 429, backing off before retry');
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        return this._request(params, { apiKey, chainId, attempt: attempt + 1 });
      }
      throw error;
    }

    const payload = response.data || {};
    const { status, message, result } = payload;

    // The proxy-style endpoints intentionally return an Ethereum JSON-RPC
    // envelope rather than Etherscan's {status,message,result} envelope. This
    // is how Etherscan V2 serves module=proxy/action=eth_blockNumber, and how
    // Blockscout serves module=block/action=eth_block_number. Reject errors and
    // nulls, but accept a well-formed result before applying the account/log
    // response rules below.
    if (payload.jsonrpc === '2.0') {
      if (!payload.error && payload.result != null) return payload.result;
      const detail = payload.error?.message || 'invalid JSON-RPC response';
      const error = new Error(`${provider.name} JSON-RPC error: ${detail}`);
      error.code = 'ETHERSCAN_API_ERROR';
      throw error;
    }

    if (status === '1') return result;

    const detail = `${message || ''} ${typeof result === 'string' ? result : ''}`;
    // Standing provider limitations must be classified BEFORE the empty-array
    // shortcut below. Blockscout can return status=2 + result=[] while an
    // internal range is only partially indexed; accepting that as an empty
    // successful feed authorizes destructive overlap deletion.
    if (CHAIN_UNAVAILABLE_RE.test(detail)) {
      const error = new Error(`${provider.name} cannot serve chain ${chainId} with this API key: ${detail.trim()}`);
      error.code = 'ETHERSCAN_CHAIN_UNAVAILABLE';
      error.chainId = chainId;
      throw error;
    }
    if (FEED_UNSUPPORTED_RE.test(detail)) {
      const error = new Error(`${provider.name} does not serve ${params.action} on chain ${chainId}: ${detail.trim()}`);
      error.code = 'ETHERSCAN_FEED_UNSUPPORTED';
      error.chainId = chainId;
      throw error;
    }

    // "No transactions found" is a normal empty feed, not an error. The logs
    // module (getLogs, #76) answers an empty match with "No records found"
    // instead; both mean the same thing -- nothing to ingest, not a failure.
    if (message === 'No transactions found' || message === 'No records found'
        || message === 'No logs found'
        || (Array.isArray(result) && result.length === 0)) {
      return [];
    }
    if (typeof result === 'string' && result.includes('rate limit') && attempt < EXPLORER_MAX_RETRIES) {
      const delayMs = explorerRetryDelay(null, attempt);
      logger.warn({
        chainId, provider: provider.name, attempt: attempt + 1, delayMs,
        params: { module: params.module, action: params.action },
      }, 'Chain explorer rate limited, backing off before retry');
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      return this._request(params, { apiKey, chainId, attempt: attempt + 1 });
    }

    const error = new Error(`${provider.name} error: ${message || 'unknown'} ${typeof result === 'string' ? result : ''}`.trim());
    error.code = 'ETHERSCAN_API_ERROR';
    throw error;
  }

  static async _rpcRequest(chainId, method, params) {
    const rpcUrl = chains.getChain(chainId)?.rpcUrl;
    if (!rpcUrl) return null;
    const response = await etherscan.throttled(() =>
      axios.post(rpcUrl, {
        jsonrpc: '2.0',
        id: 1,
        method,
        params,
      }, { timeout: 15000 })
    );
    const payload = response.data || {};
    if (payload.error || payload.result == null) {
      const error = new Error(`Chain RPC error: ${payload.error?.message || 'invalid response'}`);
      error.code = 'ETHERSCAN_API_ERROR';
      throw error;
    }
    return payload.result;
  }

  // A bounded, independently verifiable transaction envelope for bridge
  // adapters. Public JSON-RPC is preferred where the chain registry declares
  // it; otherwise Etherscan V2's proxy module supplies the same two methods.
  // Both halves are required. A provider returning null for either half is a
  // failed boundary, never an empty successful receipt.
  static async getTransactionEvidence(txHash, apiKey, chainId = etherscan.CHAIN_ID) {
    const hash = String(txHash || '').toLowerCase();
    if (!/^0x[0-9a-f]{64}$/.test(hash)) {
      throw new Error('Invalid transaction hash for bridge receipt lookup');
    }
    const chain = chains.getChain(chainId);
    let transaction;
    let receipt;
    let provider;
    if (chain?.rpcUrl) {
      provider = 'json-rpc';
      transaction = await this._rpcRequest(chainId, 'eth_getTransactionByHash', [hash]);
      receipt = await this._rpcRequest(chainId, 'eth_getTransactionReceipt', [hash]);
    } else {
      provider = this._provider(chainId).name;
      transaction = await this._request(
        { module: 'proxy', action: 'eth_getTransactionByHash', txhash: hash },
        { apiKey, chainId }
      );
      receipt = await this._request(
        { module: 'proxy', action: 'eth_getTransactionReceipt', txhash: hash },
        { apiKey, chainId }
      );
    }
    if (!transaction || !receipt) {
      const error = new Error(`Transaction evidence is unavailable on chain ${chainId}`);
      error.code = 'BRIDGE_RECEIPT_UNAVAILABLE';
      throw error;
    }
    let finalizedBlock;
    let finalityError = null;
    const cachedFinality = finalizedBlockCache.get(Number(chainId));
    if (cachedFinality && Date.now() - cachedFinality.checkedAt < FINALIZED_BLOCK_CACHE_MS) {
      finalizedBlock = cachedFinality.block;
      finalityError = cachedFinality.error;
    } else {
      try {
        finalizedBlock = chain?.rpcUrl
          ? await this._rpcRequest(chainId, 'eth_getBlockByNumber', ['finalized', false])
          : await this._request(
            { module: 'proxy', action: 'eth_getBlockByNumber', tag: 'finalized', boolean: 'false' },
            { apiKey, chainId }
          );
      } catch (error) {
        finalityError = { code: error.code || 'FINALIZED_BLOCK_UNAVAILABLE' };
      }
      finalizedBlockCache.set(Number(chainId), {
        block: finalizedBlock || null, error: finalityError, checkedAt: Date.now(),
      });
    }
    const finality = buildFinalityBoundary(receipt, finalizedBlock, finalityError);
    return {
      transaction,
      receipt,
      provider,
      providerBoundary: {
        chain_id: chainId,
        methods: [
          'eth_getTransactionByHash', 'eth_getTransactionReceipt',
          'eth_getBlockByNumber(finalized)',
        ],
        complete: true,
        finality,
      },
    };
  }

  // JSON-RPC batch transport for bounded historical log walks. IDs are local
  // to this POST and results may arrive in any order, so every item is matched
  // back by id and validated before its result is returned. This is used only
  // by the chain-declared public-RPC state-sync scanner; its caller bounds
  // concurrency per provider instead of putting a multi-minute historical
  // walk behind the Etherscan account-feed throttle.
  static async _rpcBatchRequest(chainId, calls, attempt = 0) {
    const rpcUrl = chains.getChain(chainId)?.rpcUrl;
    if (!rpcUrl) {
      const error = new Error(`Chain ${chainId} has no JSON-RPC endpoint configured`);
      error.code = 'ETHERSCAN_API_ERROR';
      throw error;
    }
    if (!Array.isArray(calls) || calls.length === 0) return [];
    const body = calls.map(({ method, params }, index) => ({
      jsonrpc: '2.0',
      id: index + 1,
      method,
      params,
    }));
    let response;
    try {
      response = await axios.post(rpcUrl, body, { timeout: 30000 });
    } catch (error) {
      const detail = error?.response?.data?.error?.message || error?.message || '';
      if (attempt < RPC_BATCH_MAX_RETRIES && RPC_RATE_LIMIT_RE.test(String(detail))) {
        const delayMs = 1100 * (attempt + 1);
        logger.warn({ chainId, attempt: attempt + 1, delayMs },
          'Chain RPC batch rate limited, retrying');
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        return this._rpcBatchRequest(chainId, calls, attempt + 1);
      }
      throw error;
    }
    if (!Array.isArray(response.data)) {
      const detail = response.data?.error?.message || response.data?.message || '';
      if (attempt < RPC_BATCH_MAX_RETRIES && RPC_RATE_LIMIT_RE.test(String(detail))) {
        const delayMs = 1100 * (attempt + 1);
        logger.warn({ chainId, attempt: attempt + 1, delayMs },
          'Chain RPC batch rate limited, retrying');
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        return this._rpcBatchRequest(chainId, calls, attempt + 1);
      }
      const suffix = detail ? `: ${detail}` : '';
      const error = new Error(`Chain RPC batch returned a non-array response${suffix}`);
      error.code = 'ETHERSCAN_API_ERROR';
      throw error;
    }
    const rateLimited = response.data.find((item) =>
      RPC_RATE_LIMIT_RE.test(String(item?.error?.message || item?.error || '')));
    if (rateLimited && attempt < RPC_BATCH_MAX_RETRIES) {
      const delayMs = 1100 * (attempt + 1);
      logger.warn({ chainId, attempt: attempt + 1, delayMs },
        'Chain RPC batch item rate limited, retrying');
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      return this._rpcBatchRequest(chainId, calls, attempt + 1);
    }
    const byId = new Map(response.data.map((item) => [item?.id, item]));
    return body.map(({ id, method }) => {
      const item = byId.get(id);
      if (!item || item.error || item.result == null) {
        const detail = item?.error?.message || 'missing or invalid batch item';
        const error = new Error(`Chain RPC ${method} error: ${detail}`);
        error.code = 'ETHERSCAN_API_ERROR';
        throw error;
      }
      return item.result;
    });
  }

  static async _latestBlockNumber(apiKey, chainId) {
    const chain = chains.getChain(chainId);
    let result;
    if (chain?.accountApi?.provider === 'Blockscout') {
      // Advance only through the explorer's indexed head, not the chain RPC
      // head. The indexer can lag; persisting an RPC block that getLogs has not
      // indexed yet would skip a late-arriving deposit forever.
      const blocksUrl = new URL('/api/v2/blocks?type=block', chain.accountApi.baseUrl).toString();
      try {
        const response = await etherscan.throttled(() =>
          axios.get(blocksUrl, { timeout: 15000 })
        );
        // `total_blocks` from /api/v2/stats is an aggregate count, not a block
        // height (Base's value was ~200k behind its newest indexed height).
        // Blockscout orders this endpoint newest-first; the first item is the
        // indexed coverage boundary shared by account and log APIs.
        result = response.data?.items?.[0]?.height;
        if (typeof result === 'number') result = String(result);
        if (typeof result !== 'string' || !/^(?:0x[0-9a-f]+|\d+)$/i.test(result)) {
          throw new Error('Blockscout v2 blocks response has no valid indexed height');
        }
      } catch (err) {
        // Some public instances intermittently disable or fail the v2 blocks
        // route while their documented legacy block module and account/log
        // APIs remain healthy. Querying eth_block_number on the SAME explorer
        // is a safe indexed-head fallback; unlike the chain RPC it cannot race
        // ahead of the explorer whose logs we are about to scan.
        logger.warn({ chainId, provider: chain.accountApi.baseUrl, err: err.message },
          'Blockscout v2 head failed; using legacy explorer block-number endpoint');
        result = await this._request(
          { module: 'block', action: 'eth_block_number' },
          { apiKey, chainId }
        );
      }
    } else {
      result = await this._request(
        { module: 'proxy', action: 'eth_blockNumber' },
        { apiKey, chainId }
      );
    }
    if (typeof result === 'string' && /^\d+$/.test(result)) {
      result = `0x${BigInt(result).toString(16)}`;
    }
    if (typeof result !== 'string' || !/^0x[0-9a-f]+$/i.test(result)) {
      const error = new Error(`Chain provider returned an invalid block number: ${JSON.stringify(result)}`);
      error.code = 'ETHERSCAN_API_ERROR';
      throw error;
    }
    const block = Number(BigInt(result));
    if (!Number.isSafeInteger(block) || block < 0) {
      const error = new Error(`Chain provider returned an unsafe block number: ${result}`);
      error.code = 'ETHERSCAN_API_ERROR';
      throw error;
    }
    return block;
  }

  static async _blockTimestamp(apiKey, chainId, blockNumber) {
    if (!Number.isSafeInteger(blockNumber) || blockNumber < 0) {
      const error = new Error(`Cannot read timestamp for invalid block ${blockNumber}`);
      error.code = 'ETHERSCAN_API_ERROR';
      throw error;
    }
    const cacheKey = `${chainId}:${blockNumber}`;
    if (blockTimestampCache.has(cacheKey)) return blockTimestampCache.get(cacheKey);
    const tag = `0x${blockNumber.toString(16)}`;
    const rpcResult = await this._rpcRequest(chainId, 'eth_getBlockByNumber', [tag, false]);
    const block = rpcResult === null
      ? await this._request({
        module: 'proxy',
        action: 'eth_getBlockByNumber',
        tag,
        boolean: 'false',
      }, { apiKey, chainId })
      : rpcResult;
    const timestamp = String(block?.timestamp || '');
    if (!/^0x[0-9a-f]+$/i.test(timestamp)) {
      const error = new Error(
        `Chain provider returned no valid timestamp for block ${blockNumber}`
      );
      error.code = 'ETHERSCAN_API_ERROR';
      throw error;
    }
    const milliseconds = Number(BigInt(timestamp)) * 1000;
    const date = new Date(milliseconds);
    if (!Number.isFinite(milliseconds) || Number.isNaN(date.getTime())) {
      const error = new Error(
        `Chain provider returned an unsafe timestamp for block ${blockNumber}`
      );
      error.code = 'ETHERSCAN_API_ERROR';
      throw error;
    }
    if (blockTimestampCache.size >= BLOCK_TIMESTAMP_CACHE_MAX) {
      blockTimestampCache.delete(blockTimestampCache.keys().next().value);
    }
    blockTimestampCache.set(cacheKey, date);
    return date;
  }

  // One authoritative explorer head and its exact chain timestamps. The head
  // is passed to every account/log feed, including Etherscan V2 feeds, so a
  // successful empty result has a durable upper boundary instead of leaving a
  // zero cursor that rescans genesis forever.
  static async coverageBoundary(apiKey, chainId, indexedHead = null) {
    const head = indexedHead ?? await this._latestBlockNumber(apiKey, chainId);
    const [fromAt, throughAt] = await Promise.all([
      this._blockTimestamp(apiKey, chainId, 0),
      this._blockTimestamp(apiKey, chainId, head),
    ]);
    return { fromBlock: 0, throughBlock: head, fromAt, throughAt };
  }

  // Blockscout's legacy txlist drops OP Stack's deposit-only fields. A zero
  // gas price is the narrow candidate gate; JSON-RPC is the authority for type,
  // sourceHash and mint. If a row really is type 0x7e but those fields cannot be
  // read, throw so the normal cursor freezes instead of committing a guessed
  // balance delta.
  static async _hydrateOpStackDeposits(rows, chainId) {
    if (!chains.getChain(chainId)?.opStackDeposits) return rows;
    const hydrated = [];
    for (const row of rows) {
      if (row.gasPrice !== '0' || typeof row.hash !== 'string') {
        hydrated.push(row);
        continue;
      }
      const tx = await this._rpcRequest(chainId, 'eth_getTransactionByHash', [row.hash]);
      if (!tx || typeof tx !== 'object' || String(tx.type).toLowerCase() !== '0x7e') {
        hydrated.push(row);
        continue;
      }
      if (!/^0x[0-9a-f]{64}$/i.test(String(tx.sourceHash || ''))
          || !/^0x[0-9a-f]+$/i.test(String(tx.mint || ''))
          || !/^0x[0-9a-f]+$/i.test(String(tx.value || ''))) {
        const error = new Error(`OP Stack deposit ${row.hash} is missing sourceHash, mint, or value`);
        error.code = 'ETHERSCAN_API_ERROR';
        throw error;
      }
      const rpcHash = String(tx.hash || '').toLowerCase();
      if (rpcHash !== row.hash.toLowerCase()) {
        const error = new Error(`OP Stack RPC returned the wrong transaction for ${row.hash}`);
        error.code = 'ETHERSCAN_API_ERROR';
        throw error;
      }
      const rpcValue = BigInt(tx.value).toString();
      if (rpcValue !== String(row.value)) {
        const error = new Error(`OP Stack RPC value disagrees with the account feed for ${row.hash}`);
        error.code = 'ETHERSCAN_API_ERROR';
        throw error;
      }
      hydrated.push({
        ...row,
        from: tx.from,
        to: tx.to,
        opStackType: '0x7e',
        opStackSourceHash: tx.sourceHash.toLowerCase(),
        opStackMintWei: BigInt(tx.mint).toString(),
      });
    }
    return hydrated;
  }

  // Current balance in wei, as a string (values exceed Number precision).
  // Per chain: the native asset is ETH on every chain in the registry, so this
  // is the chain's ETH balance, not a share of one global figure.
  static async getEthBalance(address, apiKey, chainId = etherscan.CHAIN_ID) {
    if (chains.getChain(chainId)?.historyProvider === 'zksync-lite') {
      return ZkSyncLiteService.getBalance(address);
    }
    const rpcResult = await this._rpcRequest(chainId, 'eth_getBalance', [address, 'latest']);
    const result = rpcResult === null
      ? await this._request({
        module: 'account',
        action: 'balance',
        address,
        tag: 'latest',
      }, { apiKey, chainId })
      : (/^0x[0-9a-f]+$/i.test(rpcResult) ? BigInt(rpcResult).toString() : rpcResult);
    // A malformed response must not silently zero the ETH holding.
    if (typeof result !== 'string' || !/^\d+$/.test(result)) {
      const error = new Error(`Etherscan returned an invalid balance: ${JSON.stringify(result)}`);
      error.code = 'ETHERSCAN_API_ERROR';
      throw error;
    }
    return result;
  }

  // Current ERC-20 balance in the token's own base units, as a string.
  //
  // One request per (chain, contract), which is why the balance audit budgets
  // these and rotates through a wallet's tokens rather than checking every one
  // every night: the Etherscan throttle is global across users AND chains
  // (the rate limit is per key), so a wallet holding fifty tokens on three
  // chains would otherwise monopolise it for minutes.
  static async getTokenBalance(address, contractAddress, apiKey, chainId = etherscan.CHAIN_ID) {
    if (chains.getChain(chainId)?.historyProvider === 'zksync-lite') {
      return ZkSyncLiteService.getBalance(address, contractAddress);
    }
    const paddedAddress = String(address).toLowerCase().replace(/^0x/, '').padStart(64, '0');
    const rpcResult = await this._rpcRequest(chainId, 'eth_call', [{
      to: contractAddress,
      data: `0x70a08231${paddedAddress}`,
    }, 'latest']);
    const result = rpcResult === null
      ? await this._request({
        module: 'account',
        action: 'tokenbalance',
        contractaddress: contractAddress,
        address,
        tag: 'latest',
      }, { apiKey, chainId })
      : (/^0x[0-9a-f]+$/i.test(rpcResult) ? BigInt(rpcResult).toString() : rpcResult);
    // Same fail-loud rule as getEthBalance: a malformed response must not be
    // read as a zero balance, which would report the whole position as drift.
    if (typeof result !== 'string' || !/^\d+$/.test(result)) {
      const error = new Error(`Etherscan returned an invalid token balance: ${JSON.stringify(result)}`);
      error.code = 'ETHERSCAN_API_ERROR';
      throw error;
    }
    return result;
  }

  // Walks blocks in ascending order. The cursor advances to the last block of
  // each full page WITHOUT +1: a block can be split across the page boundary,
  // so that block is refetched whole and its partial rows are dropped first.
  static async _fetchPaged(
    action,
    address,
    startBlock,
    apiKey,
    chainId = etherscan.CHAIN_ID,
    scannedThroughBlock = null
  ) {
    const all = [];
    let cursor = startBlock;
    const endBlock = scannedThroughBlock ?? 999999999;
    if (scannedThroughBlock != null && scannedThroughBlock < cursor) {
      const error = new Error(
        `account provider head ${scannedThroughBlock} is behind requested block ${cursor}; cursor frozen`
      );
      error.code = 'ETHERSCAN_API_ERROR';
      throw error;
    }

    let page = 0;
    for (;;) {
      if (cursor > endBlock) break;
      page += 1;
      if (page > MAX_ACCOUNT_PAGES) {
        const error = new Error(
          `${action} account walk exceeded ${MAX_ACCOUNT_PAGES} pages without completing; cursor frozen`
        );
        error.code = 'ETHERSCAN_API_ERROR';
        throw error;
      }
      const rows = await this._request({
        module: 'account',
        action,
        address,
        startblock: cursor,
        // OP Mainnet passed block 100,000,000 long ago. The old eight-digit
        // sentinel silently truncated every backfill there. Keep this numeric
        // for Etherscan-compatible providers that reject `latest`, but leave
        // ample headroom for all currently configured chains.
        endblock: endBlock,
        page: 1,
        offset: PAGE_SIZE,
        sort: 'asc',
      }, { apiKey, chainId });
      if (!Array.isArray(rows) || rows.length === 0) break;

      // Pagination is safe only when the explorer honours the requested
      // range. A repeated first page used to move the cursor one block at a
      // time (or loop forever), while accepting an out-of-range short page
      // could authorize destructive overlap deletion despite incomplete
      // coverage. Validate before mutating the accumulated result.
      for (const row of rows) {
        const block = Number(row?.blockNumber);
        if (!Number.isSafeInteger(block) || block < cursor || block > endBlock) {
          const error = new Error(
            `${action} returned block ${JSON.stringify(row?.blockNumber)} outside requested range ${cursor}-${endBlock}; cursor frozen`
          );
          error.code = 'ETHERSCAN_API_ERROR';
          throw error;
        }
      }
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
        const normalizedBlockRows = Array.isArray(blockRows) ? blockRows : [];
        for (const row of normalizedBlockRows) {
          const block = Number(row?.blockNumber);
          if (!Number.isSafeInteger(block) || block !== cursor) {
            const error = new Error(
              `${action} single-block fallback returned block ${JSON.stringify(row?.blockNumber)} for requested block ${cursor}; cursor frozen`
            );
            error.code = 'ETHERSCAN_API_ERROR';
            throw error;
          }
        }
        // At the provider's hard maximum there is no proof that the block is
        // complete. Dropping the unknown tail would make reconciliation
        // impossible, so retain the old rows/cursor and expose the feed gap.
        if (normalizedBlockRows.length >= 10000) {
          const error = new Error(
            `${action} block ${cursor} reached the 10000-row provider limit; cursor frozen`
          );
          error.code = 'ETHERSCAN_API_ERROR';
          throw error;
        }
        all.push(...normalizedBlockRows);
        cursor += 1;
        continue;
      }

      all.push(...rows);
      if (rows.length < PAGE_SIZE) break;
      cursor = lastBlock;
    }

    // Blockscout's Etherscan-compatible txlistinternal response calls this
    // field `transactionHash`; Etherscan and the rest of our ingestion path
    // call it `hash`. Normalize only that documented alias and preserve every
    // original field so pagination and ordinal construction stay unchanged.
    const result = all.map((row) => (
      action === 'txlistinternal' && !row.hash && row.transactionHash
        ? { ...row, hash: row.transactionHash }
        : row
    ));
    if (scannedThroughBlock != null) {
      Object.defineProperty(result, 'scannedThroughBlock', {
        value: scannedThroughBlock,
        enumerable: false,
      });
    }
    return result;
  }

  // The five ACCOUNT feeds take the chain and an optional indexed coverage
  // boundary as trailing arguments. Both preserve their old defaults, while
  // OP/Base pass one shared Blockscout head so every feed—including an empty
  // one—can report exactly how far it scanned. The sixth feed
  // (fetchStateSyncDeposits, below) is per-chain-declared and therefore takes
  // its feed config before that optional boundary.
  static async fetchNormalTxs(
    address,
    startBlock = 0,
    apiKey,
    chainId = etherscan.CHAIN_ID,
    scannedThroughBlock = null
  ) {
    const rows = await this._fetchPaged(
      'txlist', address, startBlock, apiKey, chainId, scannedThroughBlock
    );
    const result = await this._hydrateOpStackDeposits(rows, chainId);
    if (scannedThroughBlock != null) {
      Object.defineProperty(result, 'scannedThroughBlock', {
        value: scannedThroughBlock,
        enumerable: false,
      });
    }
    return result;
  }

  static fetchInternalTxs(
    address,
    startBlock = 0,
    apiKey,
    chainId = etherscan.CHAIN_ID,
    scannedThroughBlock = null
  ) {
    return this._fetchPaged(
      'txlistinternal', address, startBlock, apiKey, chainId, scannedThroughBlock
    );
  }

  // ERC-20 only; ERC-721 and ERC-1155 have their own feeds below.
  static fetchTokenTxs(
    address,
    startBlock = 0,
    apiKey,
    chainId = etherscan.CHAIN_ID,
    scannedThroughBlock = null
  ) {
    return this._fetchPaged(
      'tokentx', address, startBlock, apiKey, chainId, scannedThroughBlock
    );
  }

  // ERC-721. Rows carry tokenID and tokenDecimal ("0"), but no value field --
  // one indivisible token moves per row.
  static fetchNftTxs(
    address,
    startBlock = 0,
    apiKey,
    chainId = etherscan.CHAIN_ID,
    scannedThroughBlock = null
  ) {
    return this._fetchPaged(
      'tokennfttx', address, startBlock, apiKey, chainId, scannedThroughBlock
    );
  }

  // ERC-1155. Rows carry tokenID and tokenValue (a count of units, not wei),
  // and Etherscan emits one row per id for a batch transfer.
  static fetch1155Txs(
    address,
    startBlock = 0,
    apiKey,
    chainId = etherscan.CHAIN_ID,
    scannedThroughBlock = null
  ) {
    return this._fetchPaged(
      'token1155tx', address, startBlock, apiKey, chainId, scannedThroughBlock
    );
  }

  // The SIXTH feed (#76), declared per chain in config/chains.js rather than
  // hardcoded here: `feedConfig` is `chain.stateSyncDeposits` ({contract,
  // topic0}), so a chain that does not declare it never reaches this method.
  //
  // Native credits absent from account feeds are visible as one declared log:
  // Polygon's Bor Deposit, Gnosis' AddedReceiver, or an OP Stack
  // ETHBridgeFinalized event. This fetches those logs filtered to the WALLET
  // (at the configured indexed topic) and returns them shaped
  // exactly like an internal-trace row -- {hash, blockNumber, timeStamp, from,
  // to, value}, all decimal strings -- so normalizeFeeds ingests them through
  // the SAME path as txlistinternal, as transfer_type='internal'. That is what
  // makes nativeBalanceDeltas, the mirror, activity classification and dated
  // valuation all read the credit with no change of their own.
  //
  // Runs under the ONE global throttle like every other Etherscan call: five
  // chains and a sixth feed still share one key's rate limit.
  static async fetchStateSyncDeposits(
    address,
    startBlock = 0,
    apiKey,
    chainId = etherscan.CHAIN_ID,
    feedConfig = null,
    indexedHead = null
  ) {
    if (!feedConfig || !feedConfig.contract || !feedConfig.topic0) return [];
    if (feedConfig.rpcScan) {
      const rowsByAddress = await this.fetchStateSyncDepositsBatch(
        [{ address, startBlock }],
        chainId,
        feedConfig,
        indexedHead
      );
      return rowsByAddress.get(String(address).toLowerCase());
    }
    // Snapshot the head before the log walk and query only through that block.
    // The returned coverage cursor can then advance even when this wallet has
    // no matching logs; using "latest" with an empty result provides no block
    // from which the caller can resume.
    const scannedThroughBlock = indexedHead ?? await this._latestBlockNumber(apiKey, chainId);
    const userTopic = addressTopic(address);
    const userTopicIndex = Number(feedConfig.userTopicIndex ?? 2);
    if (![1, 2, 3].includes(userTopicIndex)) {
      throw new Error('statesync feed userTopicIndex must be 1, 2, or 3');
    }
    const userTopicParam = `topic${userTopicIndex}`;
    const topicOperatorParam = `topic0_${userTopicIndex}_opr`;
    const seen = new Set();
    const out = [];
    let cursor = Math.max(0, Number(startBlock) || 0);
    if (scannedThroughBlock < cursor) {
      const error = new Error(
        `statesync provider head ${scannedThroughBlock} is behind requested block ${cursor}; cursor frozen`
      );
      error.code = 'ETHERSCAN_API_ERROR';
      throw error;
    }

    for (let page = 1; ; page++) {
      if (cursor > scannedThroughBlock) break;
      if (page > MAX_LOG_PAGES) {
        throw new Error(`statesync getLogs walk exceeded ${MAX_LOG_PAGES} pages without completing; skipping the feed this sync`);
      }
      const rows = await this._request({
        module: 'logs',
        action: 'getLogs',
        address: feedConfig.contract,
        topic0: feedConfig.topic0,
        [userTopicParam]: userTopic,
        // topic0 AND the configured indexed receiver: Polygon's Deposit puts
        // the wallet in topic2; Gnosis' AddedReceiver puts it in topic1.
        [topicOperatorParam]: 'and',
        fromBlock: cursor,
        toBlock: scannedThroughBlock,
        page: 1,
        offset: LOG_PAGE_SIZE,
      }, { apiKey, chainId });
      // An off-shape 200 is a transport failure, never an empty feed. This is
      // the one feed whose rows exist nowhere else, and a successful return is
      // what authorizes the destructive delete of the resume window -- reading
      // garbage as "no deposits" would wipe stored credits and insert nothing.
      if (!Array.isArray(rows)) {
        throw new Error('statesync getLogs returned a non-array result; treated as a transport failure');
      }
      if (rows.length === 0) break;

      // _parseStateSyncLog THROWS on a malformed log rather than dropping it:
      // the cursor advances past everything this walk returns, so a silently
      // dropped deposit would sit behind the cursor, lost forever. Ascending by
      // (block, logIndex) matches the account feeds' contract and makes the
      // boundary refetch below deterministic.
      const parsed = rows
        .map((log) => this._parseStateSyncLog(log, address, feedConfig))
        .sort((a, b) => (a._block - b._block) || (a._logIndex - b._logIndex));

      let maxSeen = cursor;
      for (const row of parsed) {
        if (seen.has(row._key)) continue;
        seen.add(row._key);
        out.push(row);
        if (row._block > maxSeen) maxSeen = row._block;
      }

      if (rows.length < LOG_PAGE_SIZE) break;
      if (maxSeen > cursor) {
        // A full page means more may follow. Resume from the last block seen
        // (refetched whole, its already-taken rows dropped by `seen`).
        cursor = maxSeen;
      } else {
        // A full page that advanced nothing means either one block exceeds the
        // endpoint's 1,000-log ceiling or the provider ignored fromBlock.
        // Stepping past it drops an unknown tail and falsely certifies
        // coverage, so fail the feed and preserve both stored rows and cursor.
        const error = new Error(
          `statesync getLogs returned a full page without advancing past block ${cursor}; cursor frozen`
        );
        error.code = 'ETHERSCAN_API_ERROR';
        throw error;
      }
    }

    // The internal cursor fields (_block/_logIndex/_key) stay here; only the
    // account-feed-shaped columns leave, so normalizeFeeds sees an internal row.
    const result = out.map((row) => ({
      hash: row.hash,
      blockNumber: row.blockNumber,
      timeStamp: row.timeStamp,
      from: row.from,
      to: row.to,
      value: row.value,
    }));
    Object.defineProperty(result, 'scannedThroughBlock', {
      value: scannedThroughBlock,
      enumerable: false,
    });
    return result;
  }

  // Some public explorers cannot answer a whole-history getLogs query, while
  // Base's authoritative RPC explicitly caps each eth_getLogs filter at
  // 10,000 blocks. Scan those bounded windows in JSON-RPC batches and OR all
  // tracked receiver topics in each filter. The provider already sees the same
  // wallets through sequential balance/account requests; batching prevents a
  // 21x repeat of the identical public block walk.
  //
  // Returns one account-feed-shaped array per lower-cased address. Every array
  // carries the same non-enumerable scannedThroughBlock boundary, including
  // empty arrays, so callers can advance safely only after every batch passed.
  static async fetchStateSyncDepositsBatch(
    requests,
    chainId,
    feedConfig,
    indexedHead = null
  ) {
    if (!Array.isArray(requests) || requests.length === 0) return new Map();
    const scan = feedConfig?.rpcScan;
    const useBlockscout = scan?.provider === 'blockscout';
    const blockRange = Number(scan?.blockRange);
    const batchSize = Number(scan?.batchSize);
    const concurrency = Number(scan?.concurrency ?? 1);
    if (!Number.isSafeInteger(blockRange) || blockRange < 1
        || !Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 100
        || !Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 8) {
      const error = new Error('statesync rpcScan requires blockRange >= 1, batchSize between 1 and 100, and concurrency between 1 and 8');
      error.code = 'ETHERSCAN_API_ERROR';
      throw error;
    }
    const normalized = requests.map(({ address, startBlock }) => {
      const normalizedAddress = String(address).toLowerCase();
      if (!/^0x[0-9a-f]{40}$/.test(normalizedAddress)) {
        const error = new Error(`Invalid state-sync wallet address: ${address}`);
        error.code = 'ETHERSCAN_API_ERROR';
        throw error;
      }
      return {
        address: normalizedAddress,
        topic: addressTopic(normalizedAddress),
        startBlock: Math.max(0, Number(startBlock) || 0),
      };
    });
    const head = indexedHead ?? await this._latestBlockNumber(null, chainId);
    for (const request of normalized) {
      if (head < request.startBlock) {
        const error = new Error(
          `statesync provider head ${head} is behind requested block ${request.startBlock}; cursor frozen`
        );
        error.code = 'ETHERSCAN_API_ERROR';
        throw error;
      }
    }

    const userTopicIndex = Number(feedConfig.userTopicIndex ?? 2);
    if (![1, 2, 3].includes(userTopicIndex)) {
      const error = new Error('statesync feed userTopicIndex must be 1, 2, or 3');
      error.code = 'ETHERSCAN_API_ERROR';
      throw error;
    }
    const minStart = Math.min(...normalized.map((request) => request.startBlock));
    const topicToRequest = new Map(normalized.map((request) => [request.topic, request]));
    const topics = Array(userTopicIndex + 1).fill(null);
    topics[0] = feedConfig.topic0;
    topics[userTopicIndex] = [...topicToRequest.keys()];

    const filters = [];
    for (let from = minStart; from <= head; from += blockRange) {
      const to = Math.min(head, from + blockRange - 1);
      filters.push({
        method: 'eth_getLogs',
        params: [{
          fromBlock: `0x${from.toString(16)}`,
          toBlock: `0x${to.toString(16)}`,
          address: feedConfig.contract,
          topics,
        }],
      });
    }
    // A bad config or corrupt head must not allocate/run an unbounded scan.
    if (filters.length > 10000) {
      const error = new Error(`statesync RPC walk would require ${filters.length} windows; cursor frozen`);
      error.code = 'ETHERSCAN_API_ERROR';
      throw error;
    }

    const logs = [];
    if (useBlockscout) {
      // Blockscout's Etherscan-compatible logs endpoint returns the log
      // timestamp in the same hex shape as the RPC result, so it avoids one
      // extra eth_getBlockByNumber request per matched block. The receiver
      // topics are comma-separated OR terms, while topic0 + topicN must be
      // joined with the explicit `and` operator for Blockscout.
      const userTopicParam = `topic${userTopicIndex}`;
      const topicOperatorParam = `topic0_${userTopicIndex}_opr`;
      const topicParam = [...topicToRequest.keys()].join(',');
      const fetchBlockscoutWindow = async (fromBlock, toBlock, depth = 0) => {
        if (fromBlock > toBlock) return [];
        const rows = await this._request({
          module: 'logs',
          action: 'getLogs',
          address: feedConfig.contract,
          topic0: feedConfig.topic0,
          [userTopicParam]: topicParam,
          [topicOperatorParam]: 'and',
          fromBlock,
          toBlock,
          page: 1,
          offset: LOG_PAGE_SIZE,
        }, { apiKey: null, chainId });
        if (!Array.isArray(rows)) {
          const error = new Error('statesync Blockscout getLogs returned a non-array result');
          error.code = 'ETHERSCAN_API_ERROR';
          throw error;
        }
        // A full response is not proof that the range is complete. Split the
        // range rather than trusting page/offset, which this endpoint ignores.
        if (rows.length >= LOG_PAGE_SIZE) {
          if (fromBlock === toBlock || depth >= 12) {
            const error = new Error(
              `statesync Blockscout getLogs reached the ${LOG_PAGE_SIZE}-log window limit at ${fromBlock}; cursor frozen`
            );
            error.code = 'ETHERSCAN_API_ERROR';
            throw error;
          }
          const midpoint = Math.floor((fromBlock + toBlock) / 2);
          const [left, right] = await Promise.all([
            fetchBlockscoutWindow(fromBlock, midpoint, depth + 1),
            fetchBlockscoutWindow(midpoint + 1, toBlock, depth + 1),
          ]);
          return left.concat(right);
        }
        return rows;
      };
      for (let offset = 0; offset < filters.length; offset++) {
        const filter = filters[offset].params[0];
        logs.push(...await fetchBlockscoutWindow(
          parseInt(filter.fromBlock, 16),
          parseInt(filter.toBlock, 16)
        ));
      }
    } else for (let offset = 0; offset < filters.length; offset += batchSize * concurrency) {
      const chunks = [];
      for (let worker = 0; worker < concurrency && offset + worker * batchSize < filters.length; worker++) {
        chunks.push(filters.slice(offset + worker * batchSize, offset + (worker + 1) * batchSize));
      }
      const resultGroups = await Promise.all(
        chunks.map((chunk) => this._rpcBatchRequest(chainId, chunk))
      );
      for (const results of resultGroups) {
        for (const result of results) {
          if (!Array.isArray(result)) {
            const error = new Error('statesync eth_getLogs returned a non-array result');
            error.code = 'ETHERSCAN_API_ERROR';
            throw error;
          }
          logs.push(...result);
        }
      }
    }

    // eth_getLogs does not carry timestamps. Hydrate one block per distinct
    // matched block (normally only a handful) through the same batch transport.
    const uniqueBlocks = [...new Set(logs.map((log) => String(log?.blockNumber || '').toLowerCase()))];
    if (uniqueBlocks.some((block) => !/^0x[0-9a-f]+$/.test(block))) {
      const error = new Error('statesync RPC log returned an invalid blockNumber');
      error.code = 'ETHERSCAN_API_ERROR';
      throw error;
    }
    const timestamps = new Map();
    if (useBlockscout) {
      for (const log of logs) {
        const blockHex = String(log?.blockNumber || '').toLowerCase();
        if (!/^0x[0-9a-f]+$/.test(String(log?.timeStamp || ''))) {
          const error = new Error('statesync Blockscout log returned an invalid timeStamp');
          error.code = 'ETHERSCAN_API_ERROR';
          throw error;
        }
        timestamps.set(blockHex, log.timeStamp);
      }
    } else for (let offset = 0; offset < uniqueBlocks.length; offset += batchSize * concurrency) {
      const chunks = [];
      for (let worker = 0; worker < concurrency && offset + worker * batchSize < uniqueBlocks.length; worker++) {
        const blockChunk = uniqueBlocks.slice(offset + worker * batchSize, offset + (worker + 1) * batchSize);
        chunks.push({
          blockChunk,
          calls: blockChunk.map((block) => ({
            method: 'eth_getBlockByNumber',
            params: [block, false],
          })),
        });
      }
      const blockGroups = await Promise.all(
        chunks.map(({ calls }) => this._rpcBatchRequest(chainId, calls))
      );
      blockGroups.forEach((blocks, groupIndex) => {
        const { blockChunk } = chunks[groupIndex];
        blocks.forEach((block, index) => {
          if (!/^0x[0-9a-f]+$/i.test(String(block?.timestamp || ''))) {
            const error = new Error('statesync block timestamp hydration returned an invalid block');
            error.code = 'ETHERSCAN_API_ERROR';
            throw error;
          }
          timestamps.set(blockChunk[index], block.timestamp);
        });
      });
    }

    const parsedByAddress = new Map(normalized.map((request) => [request.address, []]));
    const seen = new Set();
    for (const log of logs) {
      const receiverTopic = String(log?.topics?.[userTopicIndex] || '').toLowerCase();
      const request = topicToRequest.get(receiverTopic);
      if (!request) {
        // A few public log endpoints return valid events outside a large OR
        // filter. They cannot belong to any requested wallet, so retaining
        // them would be wrong, but dropping them is safe once the event shape
        // is independently validated. Any malformed out-of-scope row still
        // freezes the cursor: completeness cannot be proven.
        const topic0 = String(log?.topics?.[0] || '').toLowerCase();
        const validReceiverTopic = /^0x[0-9a-f]{64}$/.test(receiverTopic);
        const validContract = String(log?.address || '').toLowerCase()
          === String(feedConfig.contract).toLowerCase();
        if (feedConfig.rpcScan?.allowExtraneousTopics
            && topic0 === String(feedConfig.topic0).toLowerCase()
            && validReceiverTopic && validContract) {
          continue;
        }
        const error = new Error('statesync RPC returned a receiver outside the requested topic set');
        error.code = 'ETHERSCAN_API_ERROR';
        throw error;
      }
      const blockHex = String(log.blockNumber).toLowerCase();
      const block = parseInt(blockHex, 16);
      if (block < request.startBlock) continue;
      const parsed = this._parseStateSyncLog({
        ...log,
        timeStamp: timestamps.get(blockHex),
      }, request.address, feedConfig);
      if (seen.has(parsed._key)) continue;
      seen.add(parsed._key);
      parsedByAddress.get(request.address).push(parsed);
    }

    for (const [address, parsed] of parsedByAddress) {
      parsed.sort((a, b) => (a._block - b._block) || (a._logIndex - b._logIndex));
      const result = parsed.map((row) => ({
        hash: row.hash,
        blockNumber: row.blockNumber,
        timeStamp: row.timeStamp,
        from: row.from,
        to: row.to,
        value: row.value,
      }));
      Object.defineProperty(result, 'scannedThroughBlock', {
        value: head,
        enumerable: false,
      });
      parsedByAddress.set(address, result);
    }
    return parsedByAddress;
  }

  // One getLogs Deposit log -> an internal-trace-shaped row. A log this cannot
  // read is a TRANSPORT FAILURE for the whole feed, never a row to drop: the
  // caller advances the cursor past everything the walk returns, so a silently
  // dropped deposit would be permanently lost (same rule as getEthBalance -- a
  // malformed response must not silently zero a balance). The amount is the
  // FIRST 32 bytes of `data` (the event's `amount`; `input1`/`output1` follow
  // and are ignored). from = the precompile that emitted the log; to = the
  // wallet. Cursor helpers (_block/_logIndex/_key) are stripped by the caller
  // before the row leaves.
  static _parseStateSyncLog(log, walletAddress, feedConfig) {
    const fail = (why) => {
      throw new Error(`statesync Deposit log is malformed (${why}); treated as a transport failure`);
    };
    const data = typeof log?.data === 'string' ? log.data : '';
    const contract = String(feedConfig.contract).toLowerCase();
    if (String(log?.address || '').toLowerCase() !== contract) fail('wrong emitting contract');
    const userTopicIndex = Number(feedConfig.userTopicIndex ?? 2);
    if (String(log?.topics?.[userTopicIndex] || '').toLowerCase() !== addressTopic(walletAddress)) {
      fail('wrong receiver topic');
    }
    const amountHex = data.slice(0, 66);
    if (!/^0x[0-9a-fA-F]{64}$/.test(amountHex)) fail('bad amount word');
    // getLogs returns these as HEX, unlike the account feeds' decimal strings.
    // The format is ENFORCED because a decimal still parses "successfully" --
    // parseInt('84421264', 16) is 2.2 billion, past any real tip -- which would
    // poison the cursor and stamp block_time centuries ahead.
    if (!/^0x[0-9a-fA-F]+$/.test(String(log.blockNumber || ''))) fail('non-hex blockNumber');
    if (!/^0x[0-9a-fA-F]+$/.test(String(log.timeStamp || ''))) fail('non-hex timeStamp');
    const block = parseInt(log.blockNumber, 16);
    const timeStamp = parseInt(log.timeStamp, 16);
    if (!Number.isFinite(block) || !Number.isFinite(timeStamp)) fail('unreadable blockNumber/timeStamp');
    const logIndex = /^0x[0-9a-fA-F]+$/.test(String(log.logIndex || '')) ? parseInt(log.logIndex, 16) : 0;
    if (!log.transactionHash) fail('missing transactionHash');
    return {
      hash: log.transactionHash,
      blockNumber: String(block),
      timeStamp: String(timeStamp),
      from: contract,
      to: String(walletAddress).toLowerCase(),
      value: BigInt(amountHex).toString(),
      _block: block,
      _logIndex: logIndex,
      _key: `${log.transactionHash}:${logIndex}`,
    };
  }
}

module.exports = EtherscanService;
module.exports.buildFinalityBoundary = buildFinalityBoundary;

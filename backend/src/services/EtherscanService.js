'use strict';

const axios = require('axios');
const etherscan = require('../config/etherscan');
const chains = require('../config/chains');
const logger = require('../config/logger');

// Etherscan caps any single query window at 10k results, so paged fetches
// walk a block cursor instead of page numbers (see _fetchPaged).
const PAGE_SIZE = 1000;

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
    const response = await etherscan.throttled(() =>
      axios.get(provider.baseUrl, {
        timeout: 15000,
        params: {
          ...provider.params,
          ...(provider.requiresApiKey ? { apikey: apiKey } : {}),
          ...params,
        },
      })
    );

    const { status, message, result } = response.data || {};
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
        || (Array.isArray(result) && result.length === 0)) {
      return [];
    }
    if (typeof result === 'string' && result.includes('rate limit') && attempt === 0) {
      logger.warn({ chainId, provider: provider.name, params: { module: params.module, action: params.action } },
        'Chain explorer rate limited, retrying once');
      await new Promise((resolve) => setTimeout(resolve, 1100));
      return this._request(params, { apiKey, chainId, attempt: 1 });
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
    if (payload.error || typeof payload.result !== 'string') {
      const error = new Error(`Chain RPC error: ${payload.error?.message || 'invalid response'}`);
      error.code = 'ETHERSCAN_API_ERROR';
      throw error;
    }
    return payload.result;
  }

  // Current balance in wei, as a string (values exceed Number precision).
  // Per chain: the native asset is ETH on every chain in the registry, so this
  // is the chain's ETH balance, not a share of one global figure.
  static async getEthBalance(address, apiKey, chainId = etherscan.CHAIN_ID) {
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
  static async _fetchPaged(action, address, startBlock, apiKey, chainId = etherscan.CHAIN_ID) {
    const all = [];
    let cursor = startBlock;

    for (;;) {
      const rows = await this._request({
        module: 'account',
        action,
        address,
        startblock: cursor,
        // OP Mainnet passed block 100,000,000 long ago. The old eight-digit
        // sentinel silently truncated every backfill there. Keep this numeric
        // for Etherscan-compatible providers that reject `latest`, but leave
        // ample headroom for all currently configured chains.
        endblock: 999999999,
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

    // Blockscout's Etherscan-compatible txlistinternal response calls this
    // field `transactionHash`; Etherscan and the rest of our ingestion path
    // call it `hash`. Normalize only that documented alias and preserve every
    // original field so pagination and ordinal construction stay unchanged.
    return all.map((row) => (
      action === 'txlistinternal' && !row.hash && row.transactionHash
        ? { ...row, hash: row.transactionHash }
        : row
    ));
  }

  // The five ACCOUNT feeds take the chain as a trailing argument that defaults
  // to mainnet: the same five actions serve every chain in the registry
  // (verified live per chain), so the only thing that varies is the chainid
  // param. The sixth feed (fetchStateSyncDeposits, below) is per-chain-declared
  // and does not share this shape.
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
  static async fetchStateSyncDeposits(address, startBlock = 0, apiKey, chainId = etherscan.CHAIN_ID, feedConfig = null) {
    if (!feedConfig || !feedConfig.contract || !feedConfig.topic0) return [];
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

    for (let page = 1; ; page++) {
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
        toBlock: 'latest',
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
        // A full page that advanced nothing: a single block saturating the page
        // (getLogs caps offset at 1000, so unlike _fetchPaged there is no
        // bigger-offset refetch to recover rows past the cap) or an API not
        // honouring fromBlock. Step one block so the walk cannot stall; the
        // page budget above bounds the pathological case.
        logger.warn({ chainId, block: cursor, feed: 'statesync' },
          'getLogs page advanced no blocks; stepping past it (rows beyond the page cap in this block, if any, are dropped)');
        cursor += 1;
      }
    }

    // The internal cursor fields (_block/_logIndex/_key) stay here; only the
    // account-feed-shaped columns leave, so normalizeFeeds sees an internal row.
    return out.map((row) => ({
      hash: row.hash,
      blockNumber: row.blockNumber,
      timeStamp: row.timeStamp,
      from: row.from,
      to: row.to,
      value: row.value,
    }));
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

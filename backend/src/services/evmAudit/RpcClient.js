'use strict';

const chains = require('../../config/chains');
const jsonRpc = require('../../utils/jsonRpc');
const { sha256, stableJson } = require('./normalizer');
const { TOPICS } = require('./effectDecoder');

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
  const parsed = jsonRpc.quantity(value);
  if (parsed == null) {
    throw rpcError(`Consensus RPC returned an invalid ${label}`, 'RPC_INVALID_RESPONSE');
  }
  return parsed;
}

function safeNumber(value, label) {
  const parsed = quantity(value, label);
  if (parsed > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw rpcError(`Consensus RPC returned an unsafe ${label}`, 'RPC_INVALID_RESPONSE');
  }
  return Number(parsed);
}

// Parity/Erigon trace responses use QUANTITY values in the wire format, but
// older OpenEthereum responses commonly encode blockNumber and
// transactionPosition as bare JSON integers. Accept both representations while
// keeping the same non-negative, safe-integer boundary.
function traceCoordinate(value, label) {
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw rpcError(`Consensus trace RPC returned an invalid ${label}`, 'RPC_INVALID_RESPONSE');
    }
    return value;
  }
  return safeNumber(value, label);
}

const HASH_RE = /^0x[0-9a-f]{64}$/i;
const ADDRESS_RE = /^0x[0-9a-f]{40}$/i;
const DEFAULT_LOG_RANGE = 50_000;
const DEFAULT_LOG_REQUEST_BUDGET = 512;
const DEFAULT_TRACE_RANGE = 10_000;
const DEFAULT_TRACE_REQUEST_BUDGET = 512;
const TRACE_RESULT_LIMIT = 10_000;

function logRangeLimited(error) {
  if (error?.code !== 'RPC_API_ERROR') return false;
  if (Number(error.rpcCode) === -32005) return true;
  return /too many|more than|response size|result limit|block range|range limit|query timeout/i
    .test(String(error.rpcMessage || error.message || ''));
}

function logEnumerationUnsupported(error) {
  if (error?.code !== 'RPC_API_ERROR') return false;
  return Number(error.rpcCode) === -32601
    || /method not found|unsupported method|eth_getlogs.*(?:disabled|unsupported)/i
      .test(String(error.rpcMessage || error.message || ''));
}

function traceRangeLimited(error) {
  if (error?.code !== 'RPC_API_ERROR') return false;
  if (Number(error.rpcCode) === -32005) return true;
  return /too many|more than|response size|result limit|block range|query timeout|timeout/i
    .test(String(error.rpcMessage || error.message || ''));
}

function traceEnumerationUnsupported(error) {
  if (error?.code !== 'RPC_API_ERROR') return false;
  return Number(error.rpcCode) === -32601
    || /method not found|unsupported method|trace_filter.*(?:disabled|unsupported)/i
      .test(String(error.rpcMessage || error.message || ''));
}

function logIdentity(log) {
  // A log coordinate is transaction hash + log index.  Keep blockHash in the
  // payload for canonicality evidence, but do not include it in the identity:
  // a provider that returns the same coordinate with a different block hash
  // must be surfaced as a conflicting payload instead of stored as a second
  // log.
  return `${String(log.transactionHash).toLowerCase()}:${String(log.logIndex).toLowerCase()}`;
}

function validateIndexedLog(log, fromBlock, throughBlock, walletTopic) {
  let blockNumber;
  let transactionIndex;
  let logIndex;
  try {
    blockNumber = safeNumber(log?.blockNumber, 'log block number');
    transactionIndex = safeNumber(log?.transactionIndex, 'log transaction index');
    logIndex = safeNumber(log?.logIndex, 'log index');
  } catch (cause) {
    throw rpcError('Consensus RPC returned an invalid indexed log coordinate', 'RPC_INVALID_RESPONSE', { cause });
  }
  const topics = Array.isArray(log?.topics)
    ? log.topics.map((topic) => String(topic).toLowerCase()) : [];
  const transferRelated = topics[0] === TOPICS.transfer
    && (topics[1] === walletTopic || topics[2] === walletTopic);
  const multiTokenRelated = [TOPICS.transferSingle, TOPICS.transferBatch].includes(topics[0])
    && (topics[2] === walletTopic || topics[3] === walletTopic);
  if (blockNumber < fromBlock || blockNumber > throughBlock
      || !HASH_RE.test(String(log?.blockHash || ''))
      || !HASH_RE.test(String(log?.transactionHash || ''))
      || !ADDRESS_RE.test(String(log?.address || ''))
      || !/^0x(?:[0-9a-f]{2})*$/i.test(String(log?.data || ''))
      || log?.removed === true
      || !Array.isArray(log?.topics)
      || !log.topics.every((topic) => HASH_RE.test(String(topic)))
      || (!transferRelated && !multiTokenRelated)) {
    throw rpcError('Consensus RPC returned a non-canonical or out-of-range indexed log', 'RPC_INVALID_RESPONSE');
  }
  return { blockNumber, transactionIndex, logIndex };
}

function tracePath(value) {
  if (!Array.isArray(value)) {
    throw rpcError('Consensus trace RPC returned an invalid trace path', 'RPC_INVALID_RESPONSE');
  }
  try {
    return value.map((part) => traceCoordinate(part, 'trace path entry'));
  } catch (cause) {
    throw rpcError('Consensus trace RPC returned an invalid trace path', 'RPC_INVALID_RESPONSE', { cause });
  }
}

function traceCursor(state) {
  if (state.rangeThrough == null && state.directionIndex === 0 && state.after === 0) {
    return String(state.nextBlock);
  }
  return JSON.stringify({
    version: 1,
    nextBlock: state.nextBlock,
    rangeThrough: state.rangeThrough,
    span: state.span,
    directionIndex: state.directionIndex,
    after: state.after,
    previousPageFingerprint: state.previousPageFingerprint || null,
  });
}

function parseTraceCursor(cursor, fromBlock, throughBlock, initialRange) {
  const defaults = {
    nextBlock: fromBlock,
    rangeThrough: null,
    span: initialRange,
    directionIndex: 0,
    after: 0,
    previousPageFingerprint: null,
  };
  if (cursor == null || cursor === '') return defaults;
  const text = String(cursor);
  if (/^(?:\d+|0x[0-9a-f]+)$/i.test(text)) {
    const nextBlock = Number(BigInt(text));
    if (!Number.isSafeInteger(nextBlock)) {
      throw rpcError('Trace RPC scan cursor is outside its requested range', 'RPC_INVALID_RESPONSE');
    }
    return { ...defaults, nextBlock };
  }
  let parsed;
  try { parsed = JSON.parse(text); } catch {
    throw rpcError('Trace RPC scan cursor is not valid JSON', 'RPC_INVALID_RESPONSE');
  }
  const nextBlock = parsed?.nextBlock;
  const rangeThrough = parsed?.rangeThrough == null ? null : parsed.rangeThrough;
  const span = parsed?.span;
  const directionIndex = parsed?.directionIndex;
  const after = parsed?.after;
  const previousPageFingerprint = parsed?.previousPageFingerprint == null
    ? null : String(parsed.previousPageFingerprint).toLowerCase();
  const validInteger = (value) => Number.isSafeInteger(value) && value >= 0;
  if (parsed?.version !== 1 || !validInteger(nextBlock) || !validInteger(span) || span < 1
      || ![0, 1].includes(directionIndex) || !validInteger(after)
      || (rangeThrough != null && !validInteger(rangeThrough))
      || (rangeThrough != null && rangeThrough < nextBlock)
      || (rangeThrough != null && rangeThrough > throughBlock)
      || (rangeThrough == null && (directionIndex !== 0 || after !== 0))
      || (previousPageFingerprint != null && !/^[0-9a-f]{64}$/.test(previousPageFingerprint))) {
    throw rpcError('Trace RPC scan cursor is outside its requested range', 'RPC_INVALID_RESPONSE');
  }
  if (nextBlock < fromBlock || nextBlock > throughBlock + 1) {
    throw rpcError('Trace RPC scan cursor is outside its requested range', 'RPC_INVALID_RESPONSE');
  }
  return {
    nextBlock, rangeThrough, span, directionIndex, after, previousPageFingerprint,
  };
}

function traceIdentity(trace) {
  return `${String(trace.transactionHash).toLowerCase()}:${stableJson(trace.traceAddress)}`;
}

function validateTrace(trace, fromBlock, throughBlock, wallet) {
  let blockNumber;
  let transactionPosition;
  try {
    blockNumber = traceCoordinate(trace?.blockNumber, 'trace block number');
    transactionPosition = traceCoordinate(
      trace?.transactionPosition ?? trace?.transactionIndex,
      'trace transaction position'
    );
  } catch (cause) {
    throw rpcError('Consensus trace RPC returned an invalid trace coordinate', 'RPC_INVALID_RESPONSE', { cause });
  }
  const txHash = String(trace?.transactionHash || '').toLowerCase();
  const blockHash = String(trace?.blockHash || '').toLowerCase();
  const action = trace?.action || {};
  const traceType = String(trace?.type || 'call').toLowerCase();
  let from = String(action.from || trace?.from || '').toLowerCase();
  let to = String(action.to || trace?.to || trace?.result?.address || '').toLowerCase();
  let value = action.value ?? trace?.value ?? '0x0';
  // Parity traces use a different action shape for SELFDESTRUCT. Preserve it
  // as the same economic internal effect rather than silently dropping a
  // contract's balance refund to an owned address.
  if (traceType === 'suicide') {
    from = String(action.address || '').toLowerCase();
    to = String(action.refundAddress || '').toLowerCase();
    value = action.balance ?? '0x0';
  }
  let valueBigInt;
  try {
    valueBigInt = quantity(value, 'trace value');
  } catch (cause) {
    throw rpcError('Consensus trace RPC returned an invalid trace value', 'RPC_INVALID_RESPONSE', { cause });
  }
  const path = tracePath(trace?.traceAddress);
  const error = trace?.error;
  if (blockNumber < fromBlock || blockNumber > throughBlock
      || !HASH_RE.test(txHash) || !HASH_RE.test(blockHash)
      || !ADDRESS_RE.test(from) || !ADDRESS_RE.test(to)
      || (from !== wallet && to !== wallet)
      || valueBigInt == null) {
    throw rpcError('Consensus trace RPC returned a non-canonical or out-of-range trace', 'RPC_INVALID_RESPONSE');
  }
  return {
    blockNumber,
    transactionPosition,
    traceAddress: path,
    txHash,
    blockHash,
    from,
    to,
    value: valueBigInt,
    traceType,
    isError: error != null,
  };
}

class RpcClient {
  constructor(chainId, { spacingMs = 200, onFailedAttempt = null, endpoint = 'consensus' } = {}) {
    const chain = chains.getChain(chainId);
    const rpcUrl = endpoint === 'trace'
      ? chain?.traceRpcUrl
      : chain?.consensusRpcUrl || chain?.rpcUrl;
    if (!rpcUrl) {
      throw rpcError(
        `Chain ${chainId} has no configured ${endpoint === 'trace' ? 'trace' : 'consensus'} RPC`,
        'RPC_UNSUPPORTED'
      );
    }
    this.chainId = Number(chainId);
    this.url = rpcUrl;
    this.host = new URL(rpcUrl).host;
    this.spacingMs = spacingMs;
    this.onFailedAttempt = onFailedAttempt;
    this.endpoint = endpoint;
    this.provider = endpoint === 'trace' ? 'trace-rpc' : 'consensus-rpc';
    this.label = endpoint === 'trace' ? 'Trace RPC' : 'Consensus RPC';
  }

  async _scheduled(task) {
    const previous = hostQueues.get(this.host) || Promise.resolve();
    const run = previous.catch(() => {}).then(async () => {
      await wait(this.spacingMs);
      return task();
    });
    const queued = run.catch(() => {}).finally(() => {
      if (hostQueues.get(this.host) === queued) hostQueues.delete(this.host);
    });
    hostQueues.set(this.host, queued);
    return run;
  }

  async requestWithEvidence(method, params) {
    return this._scheduled(async () => {
      let response;
      try {
        response = await jsonRpc.request(this.url, method, params, {
          timeoutMs: 30_000, validateStatus: () => true,
        });
      } catch (cause) {
        await this.onFailedAttempt?.({
          provider: this.provider, endpoint: method, method: 'POST', attemptNo: 1,
          requestParams: { method, params }, outcome: 'failed',
          errorCode: 'RPC_TRANSPORT_ERROR', errorDetail: 'Network request failed before a response.',
        });
        throw rpcError(`${this.label} ${method} request failed`, 'RPC_TRANSPORT_ERROR', { cause });
      }
      const { rawText: text, responseJson: body, httpStatus: status } = response;
      if ((status < 200 || status >= 300) || body?.error || body?.result == null) {
        await this.onFailedAttempt?.({
          provider: this.provider, endpoint: method, method: 'POST', attemptNo: 1,
          requestParams: { method, params }, outcome: status === 429 ? 'deferred' : 'failed',
          httpStatus: status,
          errorCode: status === 429 ? 'RPC_RATE_LIMITED' : 'RPC_API_ERROR',
          errorDetail: String(body?.error?.message || `HTTP ${status}`).slice(0, 500),
          requestId: response.requestId,
          responseSha256: sha256(text), responseRaw: text, responseJson: body,
        });
        throw rpcError(
          `${this.label} ${method} failed${body?.error?.message ? `: ${String(body.error.message).slice(0, 300)}` : ''}`,
          status === 429 ? 'RPC_RATE_LIMITED' : 'RPC_API_ERROR',
          {
            httpStatus: status,
            rpcCode: body?.error?.code ?? null,
            rpcMessage: body?.error?.message == null ? null : String(body.error.message).slice(0, 500),
          }
        );
      }
      return response;
    });
  }

  async request(method, params) {
    return (await this.requestWithEvidence(method, params)).result;
  }

  async finalizedBoundary() {
    const block = await this.request('eth_getBlockByNumber', ['finalized', false]);
    if (!block || !HASH_RE.test(String(block.hash || ''))) {
      throw rpcError('Consensus RPC returned an invalid finalized block', 'RPC_FINALITY_UNAVAILABLE');
    }
    const number = safeNumber(block.number, 'finalized block number');
    const timestamp = safeNumber(block.timestamp, 'finalized block timestamp');
    const date = new Date(timestamp * 1000);
    if (Number.isNaN(date.getTime())) {
      throw rpcError('Consensus RPC returned an invalid finalized block timestamp', 'RPC_FINALITY_UNAVAILABLE');
    }
    return {
      number,
      numberHex: block.number,
      hash: String(block.hash).toLowerCase(),
      timestamp: date.toISOString(),
    };
  }

  async blockByNumberWithEvidence(blockTag) {
    if (typeof blockTag !== 'string' || !/^0x[0-9a-f]+$/i.test(blockTag)) {
      throw rpcError('Consensus RPC archive probe requires a hexadecimal block tag', 'RPC_INVALID_RESPONSE');
    }
    const requested = quantity(blockTag, 'archive probe block number');
    const response = await this.requestWithEvidence(
      'eth_getBlockByNumber', [blockTag, false]
    );
    const block = response.result;
    let returned;
    try {
      returned = quantity(block?.number, 'archive probe block number');
    } catch (error) {
      throw rpcError('Consensus RPC returned an invalid archive probe block', 'RPC_ARCHIVE_UNAVAILABLE', {
        cause: error,
      });
    }
    if (!HASH_RE.test(String(block?.hash || '')) || returned !== requested) {
      throw rpcError('Consensus RPC archive probe block is not canonical at its requested height', 'RPC_ARCHIVE_UNAVAILABLE');
    }
    return {
      value: block,
      evidence: response,
    };
  }

  async transactionCount(address, blockTag) {
    return (await this.transactionCountWithEvidence(address, blockTag)).value;
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
    return (await this.balanceWithEvidence(address, blockTag)).value;
  }

  async balanceWithEvidence(address, blockTag) {
    const response = await this.requestWithEvidence('eth_getBalance', [address, blockTag]);
    return {
      value: quantity(response.result, 'native balance'),
      evidence: response,
    };
  }

  async code(address, blockTag) {
    return (await this.codeWithEvidence(address, blockTag)).value;
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
    return (await this.erc20BalanceWithEvidence(contract, address, blockTag)).value;
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

  // Enumerate token events independently from account-history providers.
  // Transfer covers ERC-20/ERC-721; TransferSingle/TransferBatch cover
  // ERC-1155. Each completed block range is a durable resume checkpoint.
  // This deliberately makes no claim about native value or internal calls,
  // which standard JSON-RPC cannot enumerate by account.
  async *addressIndexedTokenLogPages(address, {
    fromBlock = 0,
    throughBlock,
    cursor = null,
    initialRange = DEFAULT_LOG_RANGE,
    maxRequests = DEFAULT_LOG_REQUEST_BUDGET,
  } = {}) {
    const wallet = String(address || '').toLowerCase();
    if (!ADDRESS_RE.test(wallet)) {
      throw rpcError('Consensus RPC token-log scan requires a valid address', 'RPC_INVALID_RESPONSE');
    }
    if (!Number.isSafeInteger(fromBlock) || fromBlock < 0
        || !Number.isSafeInteger(throughBlock) || throughBlock < fromBlock
        || !Number.isSafeInteger(initialRange) || initialRange < 1
        || !Number.isSafeInteger(maxRequests) || maxRequests < 1) {
      throw rpcError('Consensus RPC token-log scan requires finite block and request bounds', 'RPC_INVALID_RESPONSE');
    }
    let nextBlock = cursor == null ? fromBlock : Number(cursor);
    if (!Number.isSafeInteger(nextBlock) || nextBlock < fromBlock || nextBlock > throughBlock + 1) {
      throw rpcError('Consensus RPC token-log scan cursor is outside its requested range', 'RPC_INVALID_RESPONSE');
    }
    if (nextBlock === throughBlock + 1) return;

    const walletTopic = `0x${wallet.slice(2).padStart(64, '0')}`;
    const topicGroups = [
      { topics: [TOPICS.transfer, walletTopic], direction: 'from' },
      { topics: [TOPICS.transfer, null, walletTopic], direction: 'to' },
      { topics: [[TOPICS.transferSingle, TOPICS.transferBatch], null, walletTopic], direction: 'from' },
      { topics: [[TOPICS.transferSingle, TOPICS.transferBatch], null, null, walletTopic], direction: 'to' },
    ];
    let span = initialRange;
    let requests = 0;
    while (nextBlock <= throughBlock) {
      let rangeThrough = Math.min(throughBlock, nextBlock + span - 1);
      const evidence = [];
      const logs = [];
      let retrySmaller = false;
      for (const group of topicGroups) {
        if (requests >= maxRequests) {
          throw rpcError(
            'Consensus RPC token-log scan reached its bounded request checkpoint',
            'RPC_LOG_SCAN_BUDGET_EXHAUSTED',
            {
              cursor: String(nextBlock),
              requests,
              retryAt: new Date(Date.now() + 60_000),
            }
          );
        }
        const filter = {
          fromBlock: `0x${nextBlock.toString(16)}`,
          toBlock: `0x${rangeThrough.toString(16)}`,
          topics: group.topics,
        };
        requests += 1;
        try {
          const response = await this.requestWithEvidence('eth_getLogs', [filter]);
          if (!Array.isArray(response.result)) {
            throw rpcError('Consensus RPC returned a non-array token-log page', 'RPC_INVALID_RESPONSE');
          }
          evidence.push(response);
          logs.push(...response.result);
        } catch (error) {
          if (logEnumerationUnsupported(error)) {
            throw rpcError(
              'Consensus RPC does not support address-indexed token-log enumeration',
              'RPC_LOG_ENUMERATION_UNSUPPORTED',
              { cause: error, cursor: String(nextBlock), rpcCode: error.rpcCode }
            );
          }
          if (logRangeLimited(error) && rangeThrough > nextBlock) {
            span = Math.max(1, Math.floor((rangeThrough - nextBlock + 1) / 2));
            retrySmaller = true;
            break;
          }
          if (logRangeLimited(error)) {
            throw rpcError(
              'Consensus RPC cannot enumerate address-indexed token logs for a single finalized block',
              'RPC_LOG_ENUMERATION_UNSUPPORTED',
              { cause: error, cursor: String(nextBlock), rpcCode: error.rpcCode }
            );
          }
          throw error;
        }
      }
      if (retrySmaller) continue;

      const unique = new Map();
      for (const log of logs) {
        const coordinate = validateIndexedLog(log, nextBlock, rangeThrough, walletTopic);
        const identity = logIdentity(log);
        const prior = unique.get(identity);
        if (prior && sha256(prior.log) !== sha256(log)) {
          throw rpcError(
            'Consensus RPC returned conflicting payloads for one indexed log coordinate',
            'RPC_CONFLICTING_LOG'
          );
        }
        unique.set(identity, { log, coordinate });
      }
      const ordered = [...unique.values()]
        .sort((left, right) => left.coordinate.blockNumber - right.coordinate.blockNumber
          || left.coordinate.transactionIndex - right.coordinate.transactionIndex
          || left.coordinate.logIndex - right.coordinate.logIndex)
        .map((entry) => entry.log);
      // Keep the terminal next-block cursor until the caller atomically marks
      // the scope exhausted. A crash after the last page commit can then
      // resume without replaying the entire finalized range.
      const cursorOut = String(rangeThrough + 1);
      yield {
        fromBlock: nextBlock,
        throughBlock: rangeThrough,
        cursorIn: String(nextBlock),
        cursorOut,
        logs: ordered,
        evidence,
        requests,
      };
      nextBlock = rangeThrough + 1;
      if (span < initialRange) span = Math.min(initialRange, span * 2);
    }
  }

  // Enumerate value-bearing execution traces independently from account
  // history providers. `trace_filter` is a parity-style extension, so it is
  // only attempted against an explicitly configured trace RPC endpoint. The
  // cursor includes the block range, filter direction and trace offset so
  // a bounded run can resume inside a provider-capped response page. A range
  // limit still causes the range to be retried at a smaller span.
  async *addressInternalTracePages(address, {
    fromBlock = 0,
    throughBlock,
    cursor = null,
    initialRange = DEFAULT_TRACE_RANGE,
    maxRequests = DEFAULT_TRACE_REQUEST_BUDGET,
  } = {}) {
    const wallet = String(address || '').toLowerCase();
    if (!ADDRESS_RE.test(wallet)) {
      throw rpcError('Trace RPC scan requires a valid address', 'RPC_INVALID_RESPONSE');
    }
    if (!Number.isSafeInteger(fromBlock) || fromBlock < 0
        || !Number.isSafeInteger(throughBlock) || throughBlock < fromBlock
        || !Number.isSafeInteger(initialRange) || initialRange < 1
        || !Number.isSafeInteger(maxRequests) || maxRequests < 1) {
      throw rpcError('Trace RPC scan requires finite block and request bounds', 'RPC_INVALID_RESPONSE');
    }
    let state = parseTraceCursor(cursor, fromBlock, throughBlock, initialRange);
    if (state.nextBlock === throughBlock + 1) return;

    const directionFilters = ['fromAddress', 'toAddress'];
    let requests = 0;
    let rangeIdentities = new Map();
    let emittedIdentities = new Set();
    while (state.nextBlock <= throughBlock) {
      const rangeThrough = state.rangeThrough == null
        ? Math.min(throughBlock, state.nextBlock + state.span - 1)
        : state.rangeThrough;
      let retrySmaller = false;
      for (let directionIndex = state.directionIndex; directionIndex < directionFilters.length;
        directionIndex += 1) {
        const direction = directionFilters[directionIndex];
        let after = directionIndex === state.directionIndex ? state.after : 0;
        let previousPageFingerprint = directionIndex === state.directionIndex
          ? state.previousPageFingerprint : null;
        const directionIdentities = new Set();
        const pageFingerprints = new Set();
        while (true) {
          if (requests >= maxRequests) {
            throw rpcError(
              'Trace RPC scan reached its bounded request checkpoint',
              'RPC_TRACE_SCAN_BUDGET_EXHAUSTED',
              {
                cursor: String(state.nextBlock), after: String(after), requests,
                retryAt: new Date(Date.now() + 60_000),
              }
            );
          }
          const filter = {
            fromBlock: `0x${state.nextBlock.toString(16)}`,
            toBlock: `0x${rangeThrough.toString(16)}`,
            [direction]: [wallet],
            // The parity trace API defines count/after as JSON integers. Some
            // Erigon-compatible endpoints reject QUANTITY-encoded hex here
            // even though block bounds remain hexadecimal quantities.
            count: TRACE_RESULT_LIMIT,
          };
          if (after > 0) filter.after = after;
          requests += 1;
          try {
            const response = await this.requestWithEvidence('trace_filter', [filter]);
            if (!Array.isArray(response.result)) {
              throw rpcError('Trace RPC returned a non-array trace page', 'RPC_INVALID_RESPONSE');
            }
            if (response.result.length > TRACE_RESULT_LIMIT) {
              throw rpcError(
                'Trace RPC returned more traces than its requested page limit',
                'RPC_TRACE_ENUMERATION_UNSUPPORTED',
                { cursor: String(state.nextBlock), after: String(after) }
              );
            }
            const pageFingerprint = sha256(response.result);
            if (response.result.length > 0
                && (pageFingerprints.has(pageFingerprint)
                  || pageFingerprint === previousPageFingerprint)) {
              throw rpcError(
                'Trace RPC pagination repeated an identical page',
                'RPC_TRACE_ENUMERATION_UNSUPPORTED',
                { cursor: String(state.nextBlock), after: String(after) }
              );
            }
            pageFingerprints.add(pageFingerprint);
            let pageAdvanced = false;
            const pageTraces = [];
            for (const trace of response.result) {
              // Consensus rewards have no transaction hash or transaction
              // position, so they cannot be represented by the
              // transaction-keyed audit ledger. Keep the scope explicitly
              // unsupported rather than dropping a possible payout or
              // inventing a synthetic hash.
              if (String(trace?.type || '').toLowerCase() === 'reward') {
                throw rpcError(
                  'Trace RPC returned a consensus reward that requires a separate reward ledger',
                  'RPC_TRACE_REWARD_UNSUPPORTED',
                  { cursor: String(state.nextBlock), after: String(after) }
                );
              }
              const coordinate = validateTrace(trace, state.nextBlock, rangeThrough, wallet);
              const identity = traceIdentity({
                transactionHash: coordinate.txHash,
                traceAddress: coordinate.traceAddress,
              });
              const payloadHash = sha256(trace);
              const priorPayloadHash = rangeIdentities.get(identity);
              if (priorPayloadHash && priorPayloadHash !== payloadHash) {
                throw rpcError(
                  'Trace RPC returned conflicting payloads for one trace coordinate',
                  'RPC_CONFLICTING_TRACE'
                );
              }
              rangeIdentities.set(identity, payloadHash);
              if (!directionIdentities.has(identity)) {
                directionIdentities.add(identity);
                pageAdvanced = true;
              }
              // The empty trace path is the top-level transaction call. Its
              // native value is already represented by the normal account feed
              // and adding it as an internal effect would double-count it.
              if (coordinate.traceAddress.length > 0 && !emittedIdentities.has(identity)) {
                emittedIdentities.add(identity);
                pageTraces.push(trace);
              }
            }
            if (response.result.length > 0 && !pageAdvanced) {
              throw rpcError(
                'Trace RPC pagination did not advance after its offset',
                'RPC_TRACE_ENUMERATION_UNSUPPORTED',
                { cursor: String(state.nextBlock), after: String(after) }
              );
            }
            const currentState = {
              nextBlock: state.nextBlock,
              rangeThrough,
              span: state.span,
              directionIndex,
              after,
              previousPageFingerprint,
            };
            const nextState = response.result.length === 0
              ? directionIndex + 1 < directionFilters.length
                ? {
                  nextBlock: state.nextBlock, rangeThrough, span: state.span,
                  directionIndex: directionIndex + 1, after: 0,
                  previousPageFingerprint: null,
                }
                : {
                  nextBlock: rangeThrough + 1, rangeThrough: null,
                  span: state.span < initialRange
                    ? Math.min(initialRange, state.span * 2) : state.span,
                  directionIndex: 0, after: 0, previousPageFingerprint: null,
                }
              : {
                nextBlock: state.nextBlock, rangeThrough, span: state.span,
                directionIndex, after: after + response.result.length,
                previousPageFingerprint: pageFingerprint,
              };
            yield {
              fromBlock: state.nextBlock,
              throughBlock: rangeThrough,
              direction,
              afterIn: after,
              cursorIn: traceCursor(currentState),
              cursorOut: traceCursor(nextState),
              traces: pageTraces,
              evidence: [response],
              requests,
            };
            state = nextState;
            previousPageFingerprint = nextState.previousPageFingerprint;
            if (response.result.length === 0) break;
            after = nextState.after;
          } catch (error) {
            if (traceEnumerationUnsupported(error)) {
              throw rpcError(
                'Configured trace RPC does not support trace_filter enumeration',
                'RPC_TRACE_ENUMERATION_UNSUPPORTED',
                { cause: error, cursor: String(state.nextBlock), after: String(after), rpcCode: error.rpcCode }
              );
            }
            if (traceRangeLimited(error) && rangeThrough > state.nextBlock) {
              state = {
                nextBlock: state.nextBlock, rangeThrough: null,
                span: Math.max(1, Math.floor((rangeThrough - state.nextBlock + 1) / 2)),
                directionIndex: 0, after: 0, previousPageFingerprint: null,
              };
              rangeIdentities = new Map();
              emittedIdentities = new Set();
              retrySmaller = true;
              break;
            }
            if (traceRangeLimited(error)) {
              throw rpcError(
                'Trace RPC cannot enumerate internal calls for a single finalized block',
                'RPC_TRACE_ENUMERATION_UNSUPPORTED',
                { cause: error, cursor: String(state.nextBlock), after: String(after), rpcCode: error.rpcCode }
              );
            }
            throw error;
          }
        }
        if (retrySmaller) break;
        // A completed range starts a fresh identity set. If the cursor is
        // still inside this range, it is a subsequent page and must retain it.
        if (state.nextBlock > rangeThrough) {
          rangeIdentities = new Map();
          emittedIdentities = new Set();
        }
      }
      if (retrySmaller) continue;
    }
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
    let transactionBlock;
    let receiptBlock;
    try {
      transactionBlock = quantity(transaction.blockNumber, 'transaction block number');
      receiptBlock = quantity(receipt.blockNumber, 'receipt block number');
    } catch (error) {
      throw rpcError('Consensus RPC returned an invalid transaction/receipt block number', 'RPC_IDENTITY_MISMATCH', {
        cause: error,
      });
    }
    const transactionBlockHash = String(transaction.blockHash || '').toLowerCase();
    const receiptBlockHash = String(receipt.blockHash || '').toLowerCase();
    if (!HASH_RE.test(txHash) || !HASH_RE.test(receiptHash)
        || txHash !== requested || receiptHash !== requested
        || transactionBlock !== receiptBlock
        || !HASH_RE.test(transactionBlockHash) || transactionBlockHash !== receiptBlockHash) {
      throw rpcError('Consensus RPC returned conflicting transaction/receipt coordinates', 'RPC_IDENTITY_MISMATCH');
    }
    const blockResponse = await this.requestWithEvidence(
      'eth_getBlockByNumber', [transaction.blockNumber, false]
    );
    const block = blockResponse.result;
    if (!jsonRpc.canonicalBlockMatches(receipt, block)) {
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
module.exports.logRangeLimited = logRangeLimited;
module.exports.traceRangeLimited = traceRangeLimited;
module.exports.traceEnumerationUnsupported = traceEnumerationUnsupported;
module.exports.validateTrace = validateTrace;

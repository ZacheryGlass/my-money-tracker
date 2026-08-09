'use strict';

const crypto = require('node:crypto');
const EvmAudit = require('../models/EvmAudit');
const EthWallet = require('../models/EthWallet');
const SecretsService = require('./SecretsService');
const EthDerivedPipeline = require('./EthDerivedPipeline');
const EtherscanService = require('./EtherscanService');
const chains = require('../config/chains');
const logger = require('../config/logger');
const MoralisClient = require('./evmAudit/MoralisClient');
const CdpClient = require('./evmAudit/CdpClient');
const CdpHistoryProvider = require('./evmAudit/CdpHistoryProvider');
const RpcClient = require('./evmAudit/RpcClient');
const normalizer = require('./evmAudit/normalizer');
const { effectsFromInternalObservations, effectsFromRpc } = require('./evmAudit/effectDecoder');

const AUDIT_CAPABILITIES = [
  'active_chain', 'wallet_history', 'normal', 'internal', 'erc20',
  'erc721', 'erc1155', 'native_credit', 'nonce', 'native_balance',
  'token_balance', 'bridge', 'receipt_verification',
];
const AUDIT_CHAINS = new Map([
  [1, { auditProvider: 'etherscan' }],
  [10, { auditProvider: 'blockscout' }],
  [100, {
    moralis: 'gnosis', fallbackProvider: 'blockscout',
    activeIds: new Set(['0x64', '100', 'gnosis']),
  }],
  [137, { auditProvider: 'etherscan' }],
  [324, {
    auditProvider: 'blockscout',
    errorDetail: 'Moralis does not enumerate zkSync Era; the configured Blockscout account feeds provide finite indexed coverage, while consensus RPC verifies mined transactions and effects.',
  }],
  [8453, {
    cdp: 'base',
    activeIds: new Set(['0x2105', '8453', 'base']),
  }],
  [42161, { auditProvider: 'etherscan' }],
  [59144, { auditProvider: 'etherscan' }],
  [32401, {
    unsupported: true,
    errorCode: 'NON_EVM_CHAIN',
    errorDetail: 'zkSync Lite is a legacy non-EVM history source and is outside the EVM audit contract.',
  }],
]);
const OVERLAP_BLOCKS = 64;
const CDP_COVERAGE_BASIS = 'cdp_address_history_exhausted_to_finalized_boundary_v1';
const EXPLORER_FEEDS = Object.freeze([
  { capability: 'normal', feed: 'normal', method: 'fetchNormalTxs' },
  { capability: 'internal', feed: 'internal', method: 'fetchInternalTxs' },
  { capability: 'erc20', feed: 'erc20', method: 'fetchTokenTxs' },
  { capability: 'erc721', feed: 'erc721', method: 'fetchNftTxs' },
  { capability: 'erc1155', feed: 'erc1155', method: 'fetch1155Txs' },
]);
const OWNER = `${process.pid}:${crypto.randomUUID()}`;
const queuedLocally = new Set();
let resumeTimer = null;

function pageRecord(provider, endpoint, requestParams, response, cursorIn = null, cursorOut = null,
  itemCount = 0, providerOrder = null) {
  return {
    provider,
    endpoint,
    requestParams,
    cursorIn,
    cursorOut,
    responseSha256: response.responseSha256 || normalizer.sha256(response.body),
    responseRaw: response.rawText || null,
    responseJson: response.body,
    requestId: response.requestId || null,
    itemCount,
    providerOrder,
  };
}

// Consensus RPC calls are authoritative point evidence, but a transaction
// verification combines several JSON-RPC responses. Persist the exact raw
// response text for every call inside one deterministic envelope so a later
// audit can inspect the receipt, transaction, block, nonce, code, and balance
// checks without relying on a provider replay.
function rpcPageRecord(endpoint, requestParams, body, evidence = [], itemCount = 0) {
  const rawText = JSON.stringify({
    jsonrpc: '2.0',
    requests: evidence.map((entry) => ({
      method: entry.method,
      params: entry.params,
      response_raw: entry.rawText,
    })),
  });
  const responseJson = {
    ...body,
    rpc_responses: evidence.map((entry) => ({
      method: entry.method,
      params: entry.params,
      response: entry.responseJson,
    })),
  };
  return pageRecord('consensus-rpc', endpoint, requestParams, {
    body: responseJson,
    rawText,
    responseSha256: normalizer.sha256(rawText),
    requestId: evidence.map((entry) => entry.requestId).filter(Boolean).join(',') || null,
  }, null, null, itemCount);
}

function cdpItemBlockNumber(item) {
  const value = item?.blockHeight
    ?? item?.content?.ethereum?.blockNumber
    ?? item?.ethereum?.blockNumber;
  try {
    const parsed = BigInt(value);
    if (parsed < 0n || parsed > BigInt(Number.MAX_SAFE_INTEGER)) return null;
    return Number(parsed);
  } catch {
    return null;
  }
}

function cdpItemsThroughBoundary(items, throughBlock) {
  const bounded = [];
  for (const item of items) {
    const block = cdpItemBlockNumber(item);
    if (block == null) {
      const error = new Error('Coinbase CDP returned a transaction without a safe block height');
      error.code = 'CDP_INVALID_RESPONSE';
      throw error;
    }
    if (block <= throughBlock) bounded.push(item);
  }
  return bounded;
}

function activeRowMatches(row, config) {
  const candidates = [row.chain_id, row.chain, row.chain_name, row.name]
    .filter((value) => value != null)
    .map((value) => String(value).toLowerCase());
  return candidates.some((value) => config.activeIds.has(value));
}

function configuredExplorerProvider(chainId) {
  return String(chains.getChain(chainId)?.accountApi?.provider || 'Etherscan').toLowerCase();
}

function explorerRequiresKey(chainId) {
  return chains.getChain(chainId)?.accountApi?.requiresApiKey !== false;
}

function moralisQuotaFallbackError(error) {
  if (!error) return null;
  if (!['MORALIS_NOT_CONFIGURED', 'MORALIS_QUOTA_EXHAUSTED'].includes(error.code)) return null;
  return {
    code: error.code,
    detail: error.message,
    retryAt: error.retryAt || new Date(Date.now() + 24 * 60 * 60 * 1000),
  };
}

function cdpUnavailableError(error) {
  if (!error) return null;
  if (!['CDP_NOT_CONFIGURED', 'CDP_QUOTA_EXHAUSTED', 'CDP_RATE_LIMITED', 'CDP_TRANSPORT_ERROR',
    'CDP_RESPONSE_TOO_LARGE']
    .includes(error.code)) return null;
  return {
    code: error.code,
    detail: error.message,
    retryAt: error.retryAt || (error.code === 'CDP_QUOTA_EXHAUSTED'
      ? nextCalendarMonth() : new Date(Date.now() + 60 * 60 * 1000)),
  };
}

function nextCalendarMonth() {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1, 0, 0, 0));
}

function missingRanges(nonces, nextNonce) {
  const present = [...new Set(nonces.map((value) => BigInt(value).toString()))]
    .map(BigInt)
    .filter((value) => value >= 0n && value < nextNonce)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const ranges = [];
  let expected = 0n;
  for (const nonce of present) {
    if (nonce > expected) {
      ranges.push({ from: expected.toString(), to: (nonce - 1n).toString() });
    }
    if (nonce >= expected) expected = nonce + 1n;
  }
  if (expected < nextNonce) {
    ranges.push({ from: expected.toString(), to: (nextNonce - 1n).toString() });
  }
  return ranges;
}

function conflictNonces(transactions) {
  const byNonce = new Map();
  for (const tx of transactions.filter((row) => row.signedness === 'user_signed')) {
    const list = byNonce.get(String(tx.nonce)) || [];
    list.push(tx.tx_hash);
    byNonce.set(String(tx.nonce), list);
  }
  return [...byNonce.entries()]
    .filter(([, hashes]) => new Set(hashes).size > 1)
    .map(([nonce, hashes]) => ({ nonce, transaction_hashes: [...new Set(hashes)] }));
}

function effectSignature(row, address, chain) {
  const wallet = address.toLowerCase();
  const from = String(row.from_address || '').toLowerCase();
  const to = String(row.to_address || '').toLowerCase();
  const direction = from === wallet && to === wallet ? 'self'
    : from === wallet ? 'out' : to === wallet ? 'in' : null;
  if (!direction) return null;
  let type = row.effect_type;
  if (!type) {
    if (row.is_error && row.transfer_type !== 'gas') return null;
    const mapping = { native: 'native', gas: 'gas', token: 'erc20', nft: 'erc721', nft1155: 'erc1155' };
    type = mapping[row.transfer_type] || null;
    if (row.transfer_type === 'native'
        && chain?.opStackDeposits?.creditSource?.toLowerCase() === from) type = 'native_credit';
    if (row.transfer_type === 'internal') {
      const nativeCredit = chain?.auditNativeCredits || chain?.stateSyncDeposits;
      type = nativeCredit?.contract?.toLowerCase() === from ? 'native_credit' : 'internal';
    }
  }
  if (!type) return null;
  const contract = String(row.token_contract || '').toLowerCase();
  const tokenId = row.token_id == null ? '' : String(row.token_id);
  const value = String(row.value_units ?? row.value_wei ?? '0');
  const hash = String(row.tx_hash).toLowerCase();
  // Receipt effects reconcile by their immutable log coordinate; internal
  // effects by trace path; native and gas are single deterministic tx-level
  // effects. Legacy explorer rows have only a feed ordinal, which is not a log
  // index. Never let economic equality hide a duplicated or substituted log.
  let coordinate;
  if (row.effect_key) coordinate = String(row.effect_key);
  else if (row.audit_effect_key) coordinate = String(row.audit_effect_key);
  else if (row.source_log_index != null && ['erc20', 'erc721', 'erc1155', 'native_credit'].includes(type)) {
    coordinate = `${type.replace('native_credit', 'native-credit')}:${hash}:${Number(row.source_log_index)}`;
  } else if (row.source_trace_address != null && type === 'internal') {
    coordinate = `internal:${hash}:${normalizer.stableJson(row.source_trace_address)}`;
  }
  else if (type === 'native' || type === 'gas') coordinate = `${type}:${hash}`;
  else if (type === 'native_credit' && row.ordinal === 0) coordinate = `native-credit:${hash}:unproven`;
  else coordinate = `legacy-unverified:${row.id ?? row.ordinal ?? 'unknown'}`;
  return [hash, coordinate, type, direction, from, to, value, contract, tokenId].join('|');
}

function economicSignature(row, address, chain) {
  const exact = effectSignature(row, address, chain);
  if (!exact) return null;
  const parts = exact.split('|');
  parts.splice(1, 1);
  return parts.join('|');
}

function reconcileEffects(canonical, legacy, address, chain) {
  const legacyByExact = new Map();
  const legacyByEconomic = new Map();
  for (const row of legacy) {
    const exact = effectSignature(row, address, chain);
    const economic = economicSignature(row, address, chain);
    if (exact) (legacyByExact.get(exact) || legacyByExact.set(exact, []).get(exact)).push(row);
    if (economic) (legacyByEconomic.get(economic) || legacyByEconomic.set(economic, []).get(economic)).push(row);
  }
  const matchedLegacy = new Set();
  const missing = [];
  let ambiguous = 0;
  for (const effect of canonical) {
    const exact = effectSignature(effect, address, chain);
    const exactRows = legacyByExact.get(exact) || [];
    const exactRow = exactRows.find((row) => !matchedLegacy.has(row.id));
    if (exactRow) {
      matchedLegacy.add(exactRow.id);
      continue;
    }
    const economicRows = (legacyByEconomic.get(economicSignature(effect, address, chain)) || [])
      .filter((row) => !matchedLegacy.has(row.id));
    if (economicRows.length) ambiguous += 1;
    else missing.push(effect);
  }
  const extraLegacy = legacy.filter((row) => effectSignature(row, address, chain)
    && !matchedLegacy.has(row.id)).length;
  return { missing, ambiguous, extraLegacy, gaps: missing.length + ambiguous + extraLegacy };
}

function unmatchedEffectCount(canonical, legacy, address, chain) {
  return reconcileEffects(canonical, legacy, address, chain).gaps;
}

function legacyCapability(row, chain) {
  const nativeCredit = chain?.auditNativeCredits || chain?.stateSyncDeposits;
  if (row.transfer_type === 'internal'
      && nativeCredit?.contract?.toLowerCase() === String(row.from_address || '').toLowerCase()) {
    return 'native_credit';
  }
  return ({
    native: 'normal', gas: 'normal', internal: 'internal', token: 'erc20',
    nft: 'erc721', nft1155: 'erc1155',
  })[row.transfer_type] || 'normal';
}

function publicErrorDetail(error) {
  return String(error?.message || 'Audit failed').slice(0, 500);
}

function isBlockscoutTransient(error) {
  const status = Number(error?.response?.status || error?.status);
  return [408, 425].includes(status)
    || (status >= 500 && status <= 599)
    || ['EXPLORER_RATE_LIMITED', 'ECONNABORTED', 'ETIMEDOUT', 'ECONNRESET', 'EAI_AGAIN', 'ERR_NETWORK']
      .includes(error?.code);
}

function explorerFailurePrefix(provider) {
  return provider === 'blockscout' ? 'BLOCKSCOUT' : 'ETHERSCAN';
}

function explorerDisplayName(provider) {
  return provider === 'blockscout' ? 'Blockscout' : 'Etherscan';
}

function isStandingExplorerLimitation(error) {
  const message = String(error?.message || '').toLowerCase();
  return ['ETHERSCAN_FEED_UNSUPPORTED', 'ETHERSCAN_CHAIN_UNAVAILABLE'].includes(error?.code)
    || (message.includes('does not serve') && message.includes('not yet been processed'));
}

function isStandingProviderLimitation(error) {
  const message = String(error?.message || '').toLowerCase();
  return [
    'BLOCKSCOUT_FEED_UNSUPPORTED', 'BLOCKSCOUT_CHAIN_UNAVAILABLE',
    'ETHERSCAN_FEED_UNSUPPORTED', 'ETHERSCAN_CHAIN_UNAVAILABLE',
  ].includes(error?.code)
    || (message.includes('does not serve') && message.includes('not yet been processed'));
}

function assertLease(leaseState) {
  if (!leaseState?.lost) return;
  const error = new Error('EVM audit lease ownership was lost; this worker stopped before further writes.');
  error.code = 'EVM_AUDIT_LEASE_LOST';
  throw error;
}

class EvmAuditService {
  static supportedChainIds() {
    return [...AUDIT_CHAINS.keys()];
  }

  static configuredChainIds() {
    const enabled = new Set(chains.enabledChainIds());
    return [...AUDIT_CHAINS.keys()].filter((chainId) => enabled.has(chainId));
  }

  static async request(userId, walletId, { mode = 'incremental', requestedChains = null } = {}) {
    const wallet = await EthWallet.findByIdForUser(walletId, userId);
    if (!wallet) return null;
    const selected = (requestedChains || this.configuredChainIds())
      .map(Number).filter((chainId) => AUDIT_CHAINS.has(chainId));
    const credentialGenerations = await EvmAudit.credentialGenerations(userId);
    const credentialGeneration = [credentialGenerations.moralis, credentialGenerations.cdp]
      .filter(Boolean)
      .sort((left, right) => new Date(right).getTime() - new Date(left).getTime())[0] || null;
    // Resolve without logging or returning credentials. This also detects a
    // newly entered indexed-provider key so a missing-key deferral can be
    // reopened without exposing either secret.
    const etherscanConfigured = Boolean(await SecretsService.getUserKey(userId, 'etherscan'));
    const cdpConfigured = Boolean(await SecretsService.getUserKey(userId, 'cdp'));
    const rpcConfigurationReady = selected
      .filter((chainId) => !AUDIT_CHAINS.get(chainId).unsupported)
      .every((chainId) => Boolean(chains.getChain(chainId)?.rpcUrl));
    const result = await EvmAudit.createOrFindActiveJob(userId, wallet, {
      mode,
      requestedChains: [...new Set(selected)],
      credentialGeneration,
      credentialGenerations,
      etherscanConfigured,
      cdpConfigured,
      rpcConfigurationReady,
    });
    if (result.job.status !== 'deferred') this.enqueue(result.job.id);
    return result;
  }

  static enqueue(jobId) {
    if (queuedLocally.has(jobId)) return;
    queuedLocally.add(jobId);
    setImmediate(async () => {
      let ran = false;
      try {
        ran = Boolean(await this.run(jobId));
      } catch (error) {
        logger.error({ err: error, auditJobId: jobId }, 'EVM history audit worker failed');
      } finally {
        // `run` returns a durable job row only when this process actually owned
        // and finished/deferred the lease. Chain the next queued job for that
        // user without making unclaimed sibling workers spin.
        queuedLocally.delete(jobId);
        if (ran) setImmediate(() => this.resumeDue().catch((error) => {
          logger.error({ err: error }, 'Failed to continue queued EVM audits');
        }));
      }
    });
  }

  static async resumeDue() {
    for (const jobId of await EvmAudit.dueJobs()) this.enqueue(jobId);
  }

  static start() {
    if (resumeTimer) return;
    this.resumeDue().catch((error) => logger.error({ err: error }, 'Failed to resume EVM audits'));
    resumeTimer = setInterval(() => {
      this.resumeDue().catch((error) => logger.error({ err: error }, 'Failed to resume EVM audits'));
    }, 30_000);
    resumeTimer.unref?.();
  }

  static stop() {
    if (resumeTimer) clearInterval(resumeTimer);
    resumeTimer = null;
  }

  static async run(jobId) {
    const runLock = await EvmAudit.acquireRunLock(jobId);
    if (!runLock) return null;
    let claimed;
    try {
      claimed = await EvmAudit.claim(jobId, OWNER);
    } catch (error) {
      await EvmAudit.releaseRunLock(runLock);
      throw error;
    }
    if (!claimed) {
      await EvmAudit.releaseRunLock(runLock);
      return null;
    }
    const job = await EvmAudit.findById(jobId);
    const leaseState = { lost: false };
    const heartbeatTimer = setInterval(() => {
      EvmAudit.heartbeat(jobId, OWNER).then((renewed) => {
        if (!renewed) leaseState.lost = true;
      }).catch((error) => {
        leaseState.lost = true;
        logger.warn({ err: error, auditJobId: jobId }, 'EVM audit lease heartbeat failed');
      });
    }, 30_000);
    heartbeatTimer.unref?.();
    try {
      const requested = (job.requested_chains || []).map(Number).filter((id) => AUDIT_CHAINS.has(id));
      const moralisRequested = requested.filter((chainId) => AUDIT_CHAINS.get(chainId).moralis);
      const cdpRequested = requested.filter((chainId) => AUDIT_CHAINS.get(chainId).cdp);
      const explorerRequested = requested.filter((chainId) => AUDIT_CHAINS.get(chainId).auditProvider);
      const unsupportedRequested = requested.filter((chainId) => AUDIT_CHAINS.get(chainId).unsupported);
      if (!requested.length) {
        return EvmAudit.finish(jobId, OWNER, 'unsupported', {
          errorCode: 'NO_SUPPORTED_CHAINS', errorDetail: 'No configured audit chains were requested.',
        });
      }

      let key = null;
      let moralisUnavailable = null;
      if (moralisRequested.length) {
        key = await SecretsService.getUserKey(job.user_id, 'moralis');
        if (!key) {
        moralisUnavailable = moralisQuotaFallbackError({
          code: 'MORALIS_NOT_CONFIGURED',
          message: 'Configure a Moralis API key in Settings to audit Gnosis Chain.',
          });
        }
      }
      const cdpKey = cdpRequested.length
        ? await SecretsService.getUserKey(job.user_id, 'cdp') : null;
      const cdpUnavailable = cdpRequested.length && !cdpKey
        ? cdpUnavailableError({
          code: 'CDP_NOT_CONFIGURED',
          message: 'Configure a separate Coinbase CDP Client API key in Settings to audit Base.',
        }) : null;
      const credentialGenerations = await EvmAudit.credentialGenerations(job.user_id);
      const providerCredentialChanged = [
        { name: 'moralis', requested: moralisRequested.length > 0 },
        { name: 'cdp', requested: cdpRequested.length > 0 },
      ].some(({ name, requested }) => {
        if (!requested) return false;
        const current = credentialGenerations[name] || null;
        const stored = job[`${name}_credential_generation`]
          || (moralisRequested.length + cdpRequested.length === 1
            ? job.credential_generation : null);
        return stored == null ? current != null
          : current == null || new Date(stored).getTime() !== new Date(current).getTime();
      });
      if (providerCredentialChanged) {
        return EvmAudit.finish(jobId, OWNER, 'failed', {
          errorCode: 'CREDENTIAL_GENERATION_CHANGED',
          errorDetail: 'An indexed-provider credential changed after this audit was requested. Start a new audit.',
        });
      }

      const retainAttempt = async (attempt) => {
        try {
          await EvmAudit.recordProviderAttempt({ jobId, ...attempt, owner: OWNER });
        } catch (error) {
          logger.warn({ err: error, auditJobId: jobId }, 'Failed to retain provider attempt evidence');
        }
      };
      let moralis = key && moralisRequested.length
        ? new MoralisClient(key, { onFailedAttempt: retainAttempt }) : null;
      let cdp = cdpKey && cdpRequested.length
        ? new CdpClient(cdpKey, { onFailedAttempt: retainAttempt }) : null;

      let activeResponse = { body: { active_chains: [] } };
      let activeRows = [];
      if (moralis) {
        await EvmAudit.heartbeat(jobId, OWNER, { stage: 'discovering' });
        try {
          const discoverableMoralisChains = moralisRequested
            .filter((chainId) => Boolean(chains.getChain(chainId)?.rpcUrl));
          activeResponse = discoverableMoralisChains.length
            ? await moralis.activeChains(
              job.address, discoverableMoralisChains.map((id) => AUDIT_CHAINS.get(id).moralis)
            )
            : { body: { active_chains: [] } };
          assertLease(leaseState);
          activeRows = Array.isArray(activeResponse.body.active_chains)
            ? activeResponse.body.active_chains : [];
        } catch (error) {
          moralisUnavailable = moralisQuotaFallbackError(error);
          if (!moralisUnavailable) throw error;
          // A quota exhaustion is a provider limitation, not evidence that the
          // wallet has no history. Preserve the failed discovery attempt and
          // let chains with a configured explorer fallback proceed.
          moralis = null;
        }
      }
      const discovered = requested.map((chainId) => {
        const config = AUDIT_CHAINS.get(chainId);
        if (config.unsupported) {
          return {
            chain_id: chainId, active_hint: false, bounded: false,
            status: 'unsupported', error_code: config.errorCode, error_detail: config.errorDetail,
          };
        }
        if (!chains.getChain(chainId)?.rpcUrl) {
          return {
            chain_id: chainId, active_hint: null, bounded: false,
            status: 'deferred', source: 'consensus-rpc',
            error_code: 'RPC_UNSUPPORTED',
            error_detail: 'Configure a consensus RPC for this chain to complete its mined-history audit.',
          };
        }
        if (config.moralis && moralisUnavailable) {
          return {
            chain_id: chainId, active_hint: null, bounded: false,
            status: 'deferred', source: 'moralis',
            error_code: moralisUnavailable.code,
            error_detail: moralisUnavailable.detail,
            fallback_source: config.fallbackProvider || null,
          };
        }
        if (config.cdp && cdpUnavailable) {
          return {
            chain_id: chainId, active_hint: null, bounded: false,
            status: 'deferred', source: 'coinbase-cdp',
            error_code: cdpUnavailable.code,
            error_detail: cdpUnavailable.detail,
          };
        }
        if (config.cdp) {
          return {
            chain_id: chainId, active_hint: null, bounded: false,
            status: 'configured', source: 'coinbase-cdp',
            detail: 'CDP address history is configured for Base; active-chain discovery is not universal.',
          };
        }
        if (config.auditProvider) {
          return {
            chain_id: chainId, active_hint: null, bounded: false,
            status: 'configured', source: configuredExplorerProvider(chainId),
            detail: config.errorDetail,
          };
        }
        const row = activeRows.find((candidate) => activeRowMatches(candidate, config));
        return {
          chain_id: chainId,
          active_hint: Boolean(row),
          first_transaction: row?.first_transaction || null,
          last_transaction: row?.last_transaction || null,
          bounded: Boolean(row?.first_transaction?.block_number && row?.last_transaction?.block_number),
        };
      });
      await EvmAudit.setDiscoveredChains(jobId, OWNER, discovered);

      let gaps = 0;
      let failed = false;
      let failedProviderError = null;
      for (const chainId of unsupportedRequested) {
        assertLease(leaseState);
        gaps += await this.runUnsupportedChain({ job, chainId, owner: OWNER });
      }
      const explorerApiKey = explorerRequested.some((chainId) => explorerRequiresKey(chainId))
        ? await SecretsService.getUserKey(job.user_id, 'etherscan') : null;
      const runnable = [];
      const unavailable = [];
      for (const chainId of requested.filter((id) => !unsupportedRequested.includes(id))) {
        const config = AUDIT_CHAINS.get(chainId);
        if (!chains.getChain(chainId)?.rpcUrl) {
          // Every runnable history provider still needs consensus RPC for
          // finalized boundaries, mined receipt/nonce checks, and balance
          // reconciliation. Defer only this chain when its RPC is absent so
          // an unrelated configuration gap cannot prevent CDP Base history
          // from being audited.
          unavailable.push({
            chainId,
            provider: 'consensus-rpc',
            error: {
              code: 'RPC_UNSUPPORTED',
              detail: 'Configure a consensus RPC for this chain to complete its mined-history audit.',
            },
          });
          continue;
        }
        if (config.moralis && moralis) {
          runnable.push(chainId);
          continue;
        }
        if (config.cdp && cdp) {
          runnable.push(chainId);
          continue;
        }
        const fallback = config.moralis ? config.fallbackProvider : config.auditProvider;
        if (!fallback) {
          unavailable.push({
            chainId,
            provider: config.cdp ? 'coinbase-cdp' : 'moralis',
            error: config.cdp ? cdpUnavailable : moralisUnavailable,
          });
        } else if (explorerRequiresKey(chainId) && !explorerApiKey) {
          unavailable.push({
            chainId, provider: configuredExplorerProvider(chainId),
            error: {
              code: 'ETHERSCAN_NOT_CONFIGURED',
              detail: 'Configure an Etherscan API key to audit this configured chain.',
            },
          });
        } else {
          runnable.push(chainId);
        }
      }
      for (const item of unavailable) {
        assertLease(leaseState);
        gaps += await this.runUnavailableChain({ job, chainId: item.chainId,
          provider: item.provider, error: item.error, owner: OWNER });
      }
      let providerDeferred = Boolean(moralisUnavailable || cdpUnavailable || unavailable.length);
      let deferredProviderError = moralisUnavailable || cdpUnavailable;
      let unsupportedProviderError = null;
      for (const chainId of runnable) {
        assertLease(leaseState);
        let result;
        try {
          result = await this.runChain({
            job, chainId, moralis, activeResponse, discovered, leaseState, retainAttempt,
            explorerApiKey, moralisUnavailable, cdp, cdpUnavailable,
          });
        } catch (error) {
          // A capability gap on one chain must not prevent the remaining
          // configured chains from running. Preserve the open scopes and
          // continue; the final job remains deferred/failed with the exact
          // chain-level reason so it cannot be mistaken for completion.
          assertLease(leaseState);
          const standing = isStandingProviderLimitation(error);
          const deferred = !standing && [
              'MORALIS_RATE_LIMITED', 'MORALIS_QUOTA_EXHAUSTED', 'MORALIS_TRANSPORT_ERROR',
              'CDP_RATE_LIMITED', 'CDP_QUOTA_EXHAUSTED', 'CDP_TRANSPORT_ERROR', 'CDP_RESPONSE_TOO_LARGE',
              'RPC_UNSUPPORTED', 'RPC_FINALITY_UNAVAILABLE', 'RPC_RATE_LIMITED',
              'RPC_TRANSPORT_ERROR', 'BLOCKSCOUT_RATE_LIMITED', 'BLOCKSCOUT_TRANSPORT_ERROR',
              'ETHERSCAN_RATE_LIMITED', 'ETHERSCAN_TRANSPORT_ERROR',
            ].includes(error.code);
          const chainDetail = publicErrorDetail(error);
          await EvmAudit.deferOpenScopes(job.id, chainId, {
            errorCode: error.code || 'EVM_CHAIN_AUDIT_FAILED',
            errorDetail: chainDetail,
            provider: AUDIT_CHAINS.get(chainId).auditProvider || 'consensus-rpc',
            scopeStatus: standing ? 'unsupported' : deferred ? 'deferred' : 'failed',
            capabilities: AUDIT_CAPABILITIES,
          }, { jobId: job.id, owner: OWNER });
          const discoveredChain = discovered.find((row) => row.chain_id === chainId);
          if (discoveredChain) {
            discoveredChain.bounded = false;
            discoveredChain.status = standing ? 'unsupported' : deferred ? 'deferred' : 'failed';
            discoveredChain.error_code = error.code || 'EVM_CHAIN_AUDIT_FAILED';
            discoveredChain.error_detail = chainDetail;
            await EvmAudit.setDiscoveredChains(job.id, OWNER, discovered);
          }
          result = {
            gaps: 1,
            deferred,
            unsupported: standing,
            deferredProviderError: deferred ? {
              code: error.code || 'EVM_CHAIN_AUDIT_DEFERRED', detail: chainDetail,
              retryAt: error.retryAt || null,
            } : null,
            unsupportedProviderError: standing ? {
              code: error.code || 'EVM_CHAIN_AUDIT_UNSUPPORTED', detail: chainDetail,
            } : null,
            failed: !deferred && !standing,
            failedProviderError: deferred || standing ? null : {
              code: error.code || 'EVM_CHAIN_AUDIT_FAILED', detail: chainDetail,
            },
          };
        }
        gaps += result.gaps;
        if (result.deferred) {
          providerDeferred = true;
          deferredProviderError ||= result.deferredProviderError;
        }
        if (result.unsupported) unsupportedProviderError ||= result.unsupportedProviderError;
        if (result.failed) {
          failed = true;
          failedProviderError ||= result.failedProviderError;
        }
      }
      const deferred = providerDeferred;
      return EvmAudit.finish(jobId, OWNER,
        failed ? 'failed' : deferred ? 'deferred' : (gaps ? 'complete_with_gaps' : 'complete'), {
        errorCode: failedProviderError?.code || deferredProviderError?.code
          || unsupportedProviderError?.code || unavailable[0]?.error?.code || null,
        errorDetail: failedProviderError?.detail || deferredProviderError?.detail
          || unsupportedProviderError?.detail || unavailable[0]?.error?.detail || null,
        retryAt: deferred ? (deferredProviderError?.retryAt || new Date(Date.now() + 24 * 60 * 60 * 1000)) : null,
        progress: { chains_finished: runnable.length + unavailable.length + unsupportedRequested.length, gaps },
      });
    } catch (error) {
      const deferred = [
        'MORALIS_RATE_LIMITED', 'MORALIS_QUOTA_EXHAUSTED', 'MORALIS_TRANSPORT_ERROR',
        'CDP_RATE_LIMITED', 'CDP_QUOTA_EXHAUSTED', 'CDP_TRANSPORT_ERROR', 'CDP_NOT_CONFIGURED',
        'CDP_RESPONSE_TOO_LARGE',
        'RPC_UNSUPPORTED', 'RPC_FINALITY_UNAVAILABLE', 'RPC_RATE_LIMITED', 'RPC_TRANSPORT_ERROR', 'BLOCKSCOUT_RATE_LIMITED',
        'BLOCKSCOUT_TRANSPORT_ERROR', 'ETHERSCAN_RATE_LIMITED',
        'ETHERSCAN_TRANSPORT_ERROR',
      ]
        .includes(error.code);
      const errorCode = String(error.code || '');
      const provider = errorCode.startsWith('MORALIS_') ? 'moralis'
        : errorCode.startsWith('CDP_') ? 'coinbase-cdp'
        : errorCode.startsWith('RPC_') ? 'consensus-rpc'
          : errorCode.startsWith('ETHERSCAN_') ? 'etherscan' : 'blockscout';
      if (errorCode.startsWith('MORALIS_') || errorCode.startsWith('CDP_') || errorCode.startsWith('RPC_')
          || errorCode.startsWith('BLOCKSCOUT_') || errorCode.startsWith('ETHERSCAN_')) {
        try {
          await EvmAudit.recordProviderAttempt({
            jobId, provider,
            endpoint: job.stage || 'audit-worker', requestParams: { requested_chains: job.requested_chains || [] },
            outcome: deferred ? 'deferred' : 'failed', httpStatus: error.httpStatus || null,
            errorCode: error.code || 'EVM_AUDIT_FAILED', errorDetail: publicErrorDetail(error),
            requestId: error.requestId || null,
            owner: OWNER,
          });
        } catch (attemptError) {
          logger.warn({ err: attemptError, auditJobId: jobId }, 'Failed to retain EVM provider attempt');
        }
      }
      return EvmAudit.finish(jobId, OWNER, deferred ? 'deferred' : 'failed', {
        errorCode: error.code || 'EVM_AUDIT_FAILED',
        errorDetail: publicErrorDetail(error),
        retryAt: deferred ? (error.retryAt || new Date(Date.now() + 60_000)) : null,
      });
    } finally {
      clearInterval(heartbeatTimer);
      await EvmAudit.releaseRunLock(runLock);
    }
  }

  static async runUnsupportedChain({ job, chainId, owner = null }) {
    const config = AUDIT_CHAINS.get(chainId);
    for (const capability of AUDIT_CAPABILITIES) {
      await EvmAudit.upsertScope(job.id, {
        chainId, provider: 'moralis', capability, status: 'unsupported',
        errorCode: config.errorCode, errorDetail: config.errorDetail,
      }, owner ? { jobId: job.id, owner } : {});
    }
    return 1;
  }

  static async runUnavailableChain({ job, chainId, provider, error, owner = null }) {
    for (const capability of AUDIT_CAPABILITIES) {
      await EvmAudit.upsertScope(job.id, {
        chainId, provider, capability, status: 'deferred',
        errorCode: error?.code || 'AUDIT_PROVIDER_UNAVAILABLE',
        errorDetail: error?.detail || 'No configured audit provider is available for this chain.',
      }, owner ? { jobId: job.id, owner } : {});
    }
    return 1;
  }

  static async runChain({
    job, chainId, moralis, cdp, activeResponse, discovered, leaseState, retainAttempt,
    explorerApiKey = null, moralisUnavailable = null, cdpUnavailable = null,
  }) {
    const chain = chains.getChain(chainId);
    const providerConfig = AUDIT_CHAINS.get(chainId);
    const useMoralis = Boolean(providerConfig.moralis && moralis);
    const useCdp = Boolean(providerConfig.cdp && cdp);
    const auditProvider = useCdp ? 'coinbase-cdp'
      : useMoralis ? 'moralis'
        : (providerConfig.moralis ? providerConfig.fallbackProvider : providerConfig.auditProvider);
    const rpc = new RpcClient(chainId, { onFailedAttempt: retainAttempt });
    const boundary = await rpc.finalizedBoundary();
    const context = {
      jobId: job.id, subjectId: job.subject_id, chainId,
      address: job.address, provider: auditProvider, chain,
    };
    const writeFence = { jobId: job.id, owner: OWNER };
    const upsertScope = (scope) => EvmAudit.upsertScope(job.id, scope, writeFence);
    const recordRawPage = (scopeId, page) => EvmAudit.recordRawPage(scopeId, page, writeFence);
    const commitPage = (scopeId, page, observations) =>
      EvmAudit.commitPage(scopeId, page, observations, writeFence);
    const completeScope = (scopeId, options) =>
      EvmAudit.completeScope(scopeId, options, writeFence);
    const acceptCoverage = (options) => EvmAudit.acceptCoverage({ ...options, owner: OWNER });
    const upsertMinedTransaction = (transaction) =>
      EvmAudit.upsertMinedTransaction(transaction, writeFence);
    const linkTransactionEvidence = (transactionId, evidence) =>
      EvmAudit.linkTransactionEvidence(transactionId, evidence, writeFence);
    const upsertCanonicalEffect = (effect) => EvmAudit.upsertCanonicalEffect(effect, writeFence);
    const linkEffectEvidence = (effectId, observations) =>
      EvmAudit.linkEffectEvidence(effectId, observations, writeFence);
    const storeNonceAudit = (row) => EvmAudit.storeNonceAudit(row, writeFence);
    const storeBalanceAudit = (row) => EvmAudit.storeBalanceAudit(row, writeFence);
    const recordProviderAttempt = (row) => EvmAudit.recordProviderAttempt({
      ...row, jobId: job.id, owner: OWNER,
    });
    await EvmAudit.heartbeat(job.id, OWNER, {
      stage: 'fetching', progress: { current_chain: chainId, boundary_block: boundary.number },
    });

    if (providerConfig.moralis && !useMoralis && moralisUnavailable) {
      await upsertScope({
        chainId, provider: 'moralis', capability: 'active_chain', status: 'deferred',
        errorCode: moralisUnavailable.code, errorDetail: moralisUnavailable.detail,
      });
    }
    if (providerConfig.cdp && !useCdp && cdpUnavailable) {
      await upsertScope({
        chainId, provider: 'coinbase-cdp', capability: 'active_chain', status: 'deferred',
        errorCode: cdpUnavailable.code, errorDetail: cdpUnavailable.detail,
      });
    }
    const activeScope = await upsertScope({
      chainId, provider: auditProvider, capability: 'active_chain', status: 'running',
      fromBlock: 0, throughBlock: boundary.number, throughHash: boundary.hash,
    });
    if (useMoralis) {
      const activeBody = {
        active_chains: (activeResponse.body.active_chains || [])
          .filter((row) => activeRowMatches(row, providerConfig)),
      };
      await commitPage(activeScope.id, pageRecord(
        'moralis', 'active-chain-discovery', {
          chains: (job.requested_chains || []).map((id) => AUDIT_CHAINS.get(Number(id))?.moralis).filter(Boolean),
        },
        activeResponse, null, null, activeBody.active_chains.length
      ), normalizer.activeChainObservations(context, activeBody));
      // Active-chain discovery is a hint, not proof of historical absence.
      await completeScope(activeScope.id, { status: 'unverified', paginationExhausted: false });
    } else {
      const activeBoundaryBody = {
        chain_id: chainId, boundary_block: boundary.number, active_discovery: 'not_supported',
      };
      await commitPage(activeScope.id, pageRecord(
        auditProvider, 'indexed-account-feed-boundary', {
          chain_id: chainId, boundary_block: boundary.number,
        },
        auditProvider === 'coinbase-cdp'
          ? {
            body: activeBoundaryBody,
            rawText: JSON.stringify(activeBoundaryBody),
            responseSha256: normalizer.sha256(JSON.stringify(activeBoundaryBody)),
          }
          : { body: activeBoundaryBody },
        null, null, 0
      ), []);
      await completeScope(activeScope.id, {
        status: 'unverified', paginationExhausted: false,
        errorCode: 'ACTIVE_DISCOVERY_UNSUPPORTED',
        errorDetail: moralisUnavailable
          ? 'Moralis active-chain discovery was deferred; this fallback exposes finite account-feed coverage only.'
          : 'This explorer exposes finite account-feed coverage but no active-chain discovery endpoint.',
      });
    }

    let indexedBoundary = null;
    if (!useMoralis && !useCdp) {
      try {
        indexedBoundary = await EtherscanService.coverageBoundary(explorerApiKey, chainId);
      } catch (error) {
        const transient = isBlockscoutTransient(error);
        const rateLimited = error.code === 'EXPLORER_RATE_LIMITED';
        const prefix = explorerFailurePrefix(auditProvider);
        const name = explorerDisplayName(auditProvider);
        const wrapped = new Error(`${name} indexed boundary failed: ${publicErrorDetail(error)}`);
        wrapped.code = rateLimited ? `${prefix}_RATE_LIMITED`
          : transient ? `${prefix}_TRANSPORT_ERROR`
            : isStandingExplorerLimitation(error) ? `${prefix}_CHAIN_UNAVAILABLE`
              : `${prefix}_BOUNDARY_FAILED`;
        wrapped.httpStatus = error.response?.status || error.httpStatus || null;
        wrapped.retryAt = transient ? new Date(Date.now() + (rateLimited ? 60 * 60 * 1000 : 60 * 1000)) : null;
        await recordProviderAttempt({
          jobId: job.id, scopeId: activeScope.id, provider: auditProvider,
          endpoint: 'indexed-boundary', requestParams: { chain_id: chainId },
          outcome: transient || isStandingExplorerLimitation(error) ? 'deferred' : 'failed', httpStatus: wrapped.httpStatus,
          errorCode: wrapped.code, errorDetail: publicErrorDetail(wrapped),
        });
        throw wrapped;
      }
    }
    const sourceThroughBlock = useMoralis || useCdp
      ? boundary.number : Math.min(boundary.number, indexedBoundary.throughBlock);
    const prior = job.mode === 'incremental'
      ? await EvmAudit.latestCoverage(job.subject_id, chainId, auditProvider, 'wallet_history')
      : null;
    const fromBlock = prior ? Math.max(0, Number(prior.through_block) - OVERLAP_BLOCKS) : 0;
    const priorProviderOrder = useCdp && job.mode === 'incremental'
      ? prior?.provider_order || null : null;
    const historyScope = await upsertScope({
      chainId, provider: auditProvider, capability: 'wallet_history', status: 'running',
      fromBlock, throughBlock: sourceThroughBlock,
      throughHash: useMoralis || useCdp ? boundary.hash : null,
      providerOrder: priorProviderOrder,
      coverageBasis: useCdp ? CDP_COVERAGE_BASIS : null,
    });
    const fallbackAfterMoralis = async (error, scopeId) => {
      const deferredError = moralisQuotaFallbackError(error);
      if (!useMoralis || !deferredError || !providerConfig.fallbackProvider) throw error;
      assertLease(leaseState);
      await completeScope(scopeId, {
        status: 'deferred', paginationExhausted: false,
        errorCode: deferredError.code, errorDetail: deferredError.detail,
      });
      const fallbackResult = await this.runChain({
        job, chainId, moralis: null, activeResponse: { body: { active_chains: [] } },
        discovered, leaseState, retainAttempt, explorerApiKey,
        moralisUnavailable: deferredError,
      });
      return {
        ...fallbackResult,
        deferred: true,
        deferredProviderError: deferredError,
      };
    };
    const hashes = new Set();
    const moralisLookupHashes = new Set();
    const seenCdpTransactions = new Map();
    const historicalCdpTransactions = new Map();
    // Rehydrate every durable observation before either provider path runs.
    // This is required when Moralis fails after committing pages and the
    // explorer fallback starts with a fresh in-memory hash set.
    const durableObservations = await EvmAudit.observationsForJob(job.id, { chainId });
    for (const observation of durableObservations) {
      if (observation.tx_hash) hashes.add(String(observation.tx_hash).toLowerCase());
      if (observation.tx_hash && !['consensus-rpc', 'moralis', 'coinbase-cdp'].includes(observation.provider)) {
        moralisLookupHashes.add(String(observation.tx_hash).toLowerCase());
      }
    }
    if (useCdp) {
      const priorCdpObservations = await EvmAudit.transactionObservationsForSubject(
        job.subject_id, chainId, 'coinbase-cdp', fromBlock
      );
      for (const observation of priorCdpObservations) {
        const identity = CdpHistoryProvider.itemIdentity(observation.payload_json);
        if (!identity.hash) continue;
        const previous = historicalCdpTransactions.get(identity.hash);
        if (previous && (previous.identity !== identity.identity
            || previous.fingerprint !== identity.fingerprint)) {
          const error = new Error(`Coinbase CDP retained conflicting data for ${identity.hash}`);
          error.code = 'CDP_CONFLICTING_TRANSACTION';
          throw error;
        }
        historicalCdpTransactions.set(identity.hash, identity);
      }
    }
    if (useMoralis) {
      let cursor = historyScope.provider_cursor || null;
      try {
        for await (const page of moralis.walletHistoryPages(job.address, {
          chain: providerConfig.moralis, fromBlock, throughBlock: boundary.number, cursor,
        })) {
          assertLease(leaseState);
          const observations = page.items.flatMap((item) => normalizer.historyObservations(context, item));
          for (const observation of observations) if (observation.txHash) hashes.add(observation.txHash);
          await commitPage(historyScope.id, pageRecord(
            'moralis', 'wallet-history', {
              chain: providerConfig.moralis, from_block: fromBlock, to_block: boundary.number,
            }, page, page.cursorIn, page.cursorOut, page.items.length
          ), observations);
          cursor = page.cursorOut;
          await EvmAudit.heartbeat(job.id, OWNER, { progress: { current_cursor: cursor, transactions_seen: hashes.size } });
        }
      } catch (error) {
        return fallbackAfterMoralis(error, historyScope.id);
      }
      await completeScope(historyScope.id, { status: 'complete', paginationExhausted: true });
      await acceptCoverage({
        subjectId: job.subject_id, chainId, provider: 'moralis', capability: 'wallet_history',
        fromBlock, throughBlock: boundary.number, throughHash: boundary.hash,
        paginationExhausted: true, status: 'complete', jobId: job.id,
      });
      // One exhausted Moralis history stream carries these six ordinary
      // capabilities. Keep their finite bounds explicit; RPC receipt lookups
      // remain a separate non-enumerating scope.
      for (const capability of ['normal', 'internal', 'erc20', 'erc721', 'erc1155', 'native_credit']) {
        const capabilityScope = await upsertScope({
          chainId, provider: 'moralis', capability, status: 'running',
          fromBlock, throughBlock: boundary.number, throughHash: boundary.hash,
        });
        await completeScope(capabilityScope.id, {
          status: 'complete', paginationExhausted: true,
        });
      }
    } else if (useCdp) {
      let cursor = historyScope.provider_cursor || null;
      let order = historyScope.provider_order && historyScope.provider_order !== 'unknown'
        ? historyScope.provider_order : (priorProviderOrder || 'unknown');
      let previousBlock = null;
      let orderDirection = null;
      const stopAtProvenOverlap = job.mode === 'incremental'
        && prior && priorProviderOrder === 'newest_first' && fromBlock > 0;
      try {
        for await (const page of cdp.addressTransactionPages(job.address, {
          cursor,
        })) {
          assertLease(leaseState);
          const blocks = page.items
            .map((item) => Number(item.blockHeight ?? item.content?.ethereum?.blockNumber
              ?? item.ethereum?.blockNumber))
            .filter(Number.isSafeInteger);
          for (const currentBlock of blocks) {
            if (previousBlock != null && currentBlock !== previousBlock) {
              const direction = currentBlock < previousBlock ? 'newest_first' : 'oldest_first';
              if (orderDirection && orderDirection !== direction) orderDirection = 'unknown';
              else if (!orderDirection) orderDirection = direction;
            }
            previousBlock = currentBlock;
          }
          if (orderDirection === 'unknown') order = 'unknown';
          else if (order === 'unknown' && orderDirection) order = orderDirection;
          else if (orderDirection && order !== orderDirection) order = 'unknown';
          const pageEvidence = pageRecord(
            'coinbase-cdp', 'address-history', {
              address: job.address.toLowerCase(), page_size: page.pageSize, page_token: page.cursorIn,
            }, page, page.cursorIn, page.cursorOut, page.items.length, order
          );
          await recordRawPage(historyScope.id, pageEvidence);
          // Validate the complete returned page after raw persistence, then
          // only canonicalize transactions at or below the RPC-finalized
          // boundary. Future-indexed rows remain evidence, but can never enter
          // the audit projection before consensus has finalized them.
          CdpHistoryProvider.normalizePage(job.address, page.items, {
            nativeCredit: chain?.auditNativeCredits || chain?.stateSyncDeposits || null,
          });
          CdpHistoryProvider.assertNoConflicts(page.items, historicalCdpTransactions);
          const uniqueItems = CdpHistoryProvider.dedupeItems(page.items, seenCdpTransactions);
          const boundedItems = cdpItemsThroughBoundary(uniqueItems, boundary.number);
          const boundedBlocks = boundedItems.map(cdpItemBlockNumber);
          const observations = boundedItems.flatMap((item) =>
            normalizer.cdpHistoryObservations(context, item)
          );
          for (const observation of observations) if (observation.txHash) hashes.add(observation.txHash);
          await commitPage(historyScope.id, pageEvidence, observations);
          cursor = page.cursorOut;
          await EvmAudit.heartbeat(job.id, OWNER, {
            progress: { current_cursor: cursor, transactions_seen: hashes.size },
          });
          if (stopAtProvenOverlap && orderDirection === 'newest_first'
              && boundedBlocks.some((block) => block <= fromBlock)) break;
        }
      } catch (error) {
        const deferredError = cdpUnavailableError(error);
        const failedChain = discovered.find((row) => row.chain_id === chainId);
        if (failedChain) {
          failedChain.active_hint = null;
          failedChain.bounded = false;
          failedChain.status = deferredError ? 'deferred' : 'failed';
          failedChain.source = 'coinbase-cdp';
          failedChain.error_code = error.code || 'CDP_HISTORY_FAILED';
          failedChain.error_detail = publicErrorDetail(error);
          await EvmAudit.setDiscoveredChains(job.id, OWNER, discovered);
        }
        await completeScope(historyScope.id, {
          status: deferredError ? 'deferred' : 'failed',
          paginationExhausted: false,
          providerOrder: order,
          errorCode: error.code || 'CDP_HISTORY_FAILED',
          errorDetail: publicErrorDetail(error),
        });
        return {
          gaps: 1,
          deferred: Boolean(deferredError),
          deferredProviderError: deferredError,
          failed: !deferredError,
          failedProviderError: deferredError ? null : {
            code: error.code || 'CDP_HISTORY_FAILED',
            detail: publicErrorDetail(error),
          },
          boundary,
          transactions: hashes.size,
          discovered,
        };
      }
      await completeScope(historyScope.id, {
        status: 'complete', paginationExhausted: true, providerOrder: order,
        coverageBasis: CDP_COVERAGE_BASIS,
      });
      await acceptCoverage({
        subjectId: job.subject_id, chainId, provider: 'coinbase-cdp', capability: 'wallet_history',
        fromBlock, throughBlock: boundary.number, throughHash: boundary.hash,
        providerOrder: order, coverageBasis: CDP_COVERAGE_BASIS,
        paginationExhausted: true, status: 'complete', jobId: job.id,
      });
      for (const capability of ['normal', 'internal', 'erc20', 'erc721', 'erc1155', 'native_credit']) {
        const capabilityScope = await upsertScope({
          chainId, provider: 'coinbase-cdp', capability, status: 'running',
          fromBlock, throughBlock: boundary.number, throughHash: boundary.hash,
          providerOrder: order,
          coverageBasis: CDP_COVERAGE_BASIS,
        });
        await completeScope(capabilityScope.id, {
          status: 'complete', paginationExhausted: true,
          coverageBasis: CDP_COVERAGE_BASIS,
        });
      }
      // CDP does not offer Moralis-style active-chain discovery. A completed
      // address-history walk still proves a finite configured Base boundary,
      // so expose that bounded fact without turning it into a universal
      // absence claim across every EVM or every future provider.
      const discoveredChain = discovered.find((row) => row.chain_id === chainId);
      if (discoveredChain) {
        const providerObservations = await EvmAudit.observationsForJob(job.id, { chainId });
        const foundBlocks = providerObservations
          .filter((row) => row.provider === 'coinbase-cdp' && row.block_number != null)
          .map((row) => Number(row.block_number))
          .filter(Number.isSafeInteger);
        discoveredChain.active_hint = hashes.size > 0;
        discoveredChain.active_hint_proven = false;
        discoveredChain.bounded = true;
        discoveredChain.status = 'bounded';
        discoveredChain.source = 'coinbase-cdp';
        discoveredChain.first_block = foundBlocks.length ? Math.min(...foundBlocks) : null;
        discoveredChain.last_block = foundBlocks.length ? Math.max(...foundBlocks) : null;
        await EvmAudit.setDiscoveredChains(job.id, OWNER, discovered);
      }
    } else {
      for (const feedSpec of EXPLORER_FEEDS) {
        assertLease(leaseState);
        const feedPrior = job.mode === 'incremental'
          ? await EvmAudit.latestCoverage(job.subject_id, chainId, auditProvider, feedSpec.capability)
          : null;
        const feedFromBlock = feedPrior
          ? Math.max(0, Number(feedPrior.through_block) - OVERLAP_BLOCKS) : 0;
        const feedScope = await upsertScope({
          chainId, provider: auditProvider, capability: feedSpec.capability, status: 'running',
          fromBlock: feedFromBlock, throughBlock: sourceThroughBlock, throughHash: null,
        });
        let rows;
        try {
          rows = await EtherscanService[feedSpec.method](
            job.address, feedFromBlock, explorerApiKey, chainId, sourceThroughBlock
          );
        } catch (error) {
          const transient = isBlockscoutTransient(error);
          const rateLimited = error.code === 'EXPLORER_RATE_LIMITED';
          const prefix = explorerFailurePrefix(auditProvider);
          const name = explorerDisplayName(auditProvider);
          const wrapped = new Error(`${name} ${feedSpec.feed} audit feed failed: ${publicErrorDetail(error)}`);
          wrapped.code = rateLimited ? `${prefix}_RATE_LIMITED`
            : transient ? `${prefix}_TRANSPORT_ERROR`
              : isStandingExplorerLimitation(error) ? `${prefix}_FEED_UNSUPPORTED`
                : `${prefix}_FEED_FAILED`;
          wrapped.httpStatus = error.response?.status || error.httpStatus || null;
          wrapped.retryAt = transient ? new Date(Date.now() + (rateLimited ? 60 * 60 * 1000 : 60 * 1000)) : null;
          await recordProviderAttempt({
            jobId: job.id, scopeId: feedScope.id, provider: auditProvider,
            endpoint: `account-${feedSpec.feed}`,
            requestParams: { address: job.address, from_block: feedFromBlock, to_block: sourceThroughBlock },
            outcome: transient || isStandingExplorerLimitation(error) ? 'deferred' : 'failed',
            httpStatus: wrapped.httpStatus, errorCode: wrapped.code,
            errorDetail: publicErrorDetail(wrapped),
          });
          throw wrapped;
        }
        if (!Array.isArray(rows)) {
          const prefix = explorerFailurePrefix(auditProvider);
          const name = explorerDisplayName(auditProvider);
          const error = new Error(`${name} ${feedSpec.feed} audit feed returned a non-array response`);
          error.code = `${prefix}_FEED_FAILED`;
          throw error;
        }
        const pageSize = 500;
        for (let offset = 0; offset < Math.max(rows.length, 1); offset += pageSize) {
          assertLease(leaseState);
          const pageRows = rows.slice(offset, offset + pageSize);
          const observations = normalizer.explorerFeedObservations(
            context, feedSpec.feed, pageRows
          );
          for (const observation of observations) if (observation.txHash) hashes.add(observation.txHash);
          await commitPage(feedScope.id, pageRecord(
            auditProvider, `account-${feedSpec.feed}`,
            { address: job.address, from_block: feedFromBlock, to_block: sourceThroughBlock },
            { body: { feed: feedSpec.feed, rows: pageRows } },
            String(offset), offset + pageRows.length >= rows.length ? null : String(offset + pageRows.length),
            pageRows.length
          ), observations);
          await EvmAudit.heartbeat(job.id, OWNER, {
            progress: { current_feed: feedSpec.feed, transactions_seen: hashes.size },
          });
        }
          await completeScope(feedScope.id, {
          status: 'complete', paginationExhausted: true,
        });
          await acceptCoverage({
          subjectId: job.subject_id, chainId, provider: auditProvider,
          capability: feedSpec.capability, fromBlock: feedFromBlock,
          throughBlock: sourceThroughBlock, throughHash: null,
          paginationExhausted: true, status: 'complete', jobId: job.id,
        });
      }
      const nativeCreditScope = await upsertScope({
        chainId, provider: auditProvider, capability: 'native_credit', status: 'running',
        fromBlock: 0, throughBlock: sourceThroughBlock, throughHash: null,
      });
      const nativeCreditConfig = chain?.stateSyncDeposits;
      if (nativeCreditConfig) {
        let nativeCreditRows;
        try {
          nativeCreditRows = await EtherscanService.fetchStateSyncDeposits(
            job.address, 0, explorerApiKey, chainId, nativeCreditConfig, sourceThroughBlock
          );
        } catch (error) {
          const transient = isBlockscoutTransient(error);
          const rateLimited = error.code === 'EXPLORER_RATE_LIMITED';
          const prefix = explorerFailurePrefix(auditProvider);
          const wrapped = new Error(`Explorer native-credit audit feed failed: ${publicErrorDetail(error)}`);
          wrapped.code = rateLimited ? `${prefix}_RATE_LIMITED`
            : transient ? `${prefix}_TRANSPORT_ERROR`
              : isStandingExplorerLimitation(error) ? `${prefix}_FEED_UNSUPPORTED`
                : `${prefix}_FEED_FAILED`;
          wrapped.httpStatus = error.response?.status || error.httpStatus || null;
          wrapped.retryAt = transient ? new Date(Date.now() + (rateLimited ? 60 * 60 * 1000 : 60 * 1000)) : null;
          await recordProviderAttempt({
            jobId: job.id, scopeId: nativeCreditScope.id, provider: auditProvider,
            endpoint: 'native-credit', requestParams: {
              address: job.address, from_block: 0, to_block: sourceThroughBlock,
            }, outcome: transient || isStandingExplorerLimitation(error) ? 'deferred' : 'failed', httpStatus: wrapped.httpStatus,
            errorCode: wrapped.code, errorDetail: publicErrorDetail(wrapped),
          });
          throw wrapped;
        }
        const observations = normalizer.explorerFeedObservations(
          { ...context, provider: auditProvider }, 'internal', nativeCreditRows
        );
        for (const observation of observations) if (observation.txHash) hashes.add(observation.txHash);
        await commitPage(nativeCreditScope.id, pageRecord(
          auditProvider, 'native-credit', {
            address: job.address, from_block: 0, to_block: sourceThroughBlock,
          }, { body: { rows: nativeCreditRows } }, null, null, nativeCreditRows.length
        ), observations);
        await completeScope(nativeCreditScope.id, {
          status: 'complete', paginationExhausted: true,
        });
        await acceptCoverage({
          subjectId: job.subject_id, chainId, provider: auditProvider,
          capability: 'native_credit', fromBlock: 0, throughBlock: sourceThroughBlock,
          throughHash: null, paginationExhausted: true, status: 'complete', jobId: job.id,
        });
      } else {
        await commitPage(nativeCreditScope.id, pageRecord(
          auditProvider, 'native-credit-not-applicable', { chain_id: chainId },
          { body: { chain_id: chainId, status: 'not_applicable' } }, null, null, 0
        ), []);
        await completeScope(nativeCreditScope.id, {
          status: 'complete', paginationExhausted: true,
          errorCode: 'NOT_APPLICABLE',
          errorDetail: 'This chain has no configured account-independent native-credit feed; receipt logs remain canonical evidence.',
        });
      }
      const foundBlocks = [...hashes].length
        ? [...(await EvmAudit.observationsForJob(job.id, { chainId }))]
          .filter((row) => row.provider === auditProvider && row.block_number != null)
          .map((row) => Number(row.block_number)).filter(Number.isSafeInteger)
        : [];
      const discoveredChain = discovered.find((row) => row.chain_id === chainId);
      if (discoveredChain) {
        discoveredChain.active_hint = hashes.size > 0;
        discoveredChain.active_hint_proven = false;
        discoveredChain.bounded = true;
        discoveredChain.status = 'bounded';
        discoveredChain.source = auditProvider;
        if (moralisUnavailable) {
          discoveredChain.active_discovery = {
            status: 'deferred', source: 'moralis',
            error_code: moralisUnavailable.code,
            error_detail: moralisUnavailable.detail,
          };
          discoveredChain.fallback_source = auditProvider;
        }
        discoveredChain.first_block = foundBlocks.length ? Math.min(...foundBlocks) : null;
        discoveredChain.last_block = foundBlocks.length ? Math.max(...foundBlocks) : null;
      }
      await EvmAudit.setDiscoveredChains(job.id, OWNER, discovered);
      await completeScope(historyScope.id, { status: 'complete', paginationExhausted: true });
      await acceptCoverage({
        subjectId: job.subject_id, chainId, provider: auditProvider, capability: 'wallet_history',
        fromBlock, throughBlock: sourceThroughBlock, throughHash: null,
        paginationExhausted: true, status: 'complete', jobId: job.id,
      });
    }
    let cdpBalanceEvidenceFailed = false;
    const cdpBalances = [];
    if (useCdp) {
      // CDP balances are retained as supplemental provider evidence. Consensus
      // RPC remains authoritative for the native balance and the existing
      // token-by-token RPC checks remain the completion gate.
      const balanceScope = await upsertScope({
        chainId, provider: 'coinbase-cdp', capability: 'token_balance', status: 'running',
        fromBlock: null, throughBlock: boundary.number, throughHash: boundary.hash,
        coverageBasis: 'cdp_list_balances_current_asset_index_v1',
      });
      try {
        let cursor = balanceScope.provider_cursor || null;
        for await (const page of cdp.balancePages(job.address, { cursor, pageSize: 100 })) {
          assertLease(leaseState);
          cdpBalances.push(...page.items);
          const pageEvidence = pageRecord(
            'coinbase-cdp', 'balance-history', {
              address: job.address.toLowerCase(), page_size: 100, page_token: page.cursorIn,
            }, page, page.cursorIn, page.cursorOut, page.items.length
          );
          await recordRawPage(balanceScope.id, pageEvidence);
          const observations = normalizer.cdpBalanceObservations(context, page.items);
          await commitPage(balanceScope.id, pageEvidence, observations);
          cursor = page.cursorOut;
        }
        await completeScope(balanceScope.id, {
          status: 'complete', paginationExhausted: true,
          coverageBasis: 'cdp_list_balances_current_asset_index_v1',
        });
      } catch (error) {
        cdpBalanceEvidenceFailed = true;
        await completeScope(balanceScope.id, {
          status: 'unverified', paginationExhausted: false,
          errorCode: error.code || 'CDP_BALANCE_EVIDENCE_FAILED',
          errorDetail: publicErrorDetail(error),
        });
      }
    }
    let legacyRows = await EvmAudit.storedTransferRows(job.user_id, job.subject_id, chainId, boundary.number);
    const coverageByFeed = new Map((await EvmAudit.storedFeedCoverage(
      job.user_id, job.subject_id, chainId
    )).map((row) => [row.feed, row]));
    const capabilityFeeds = new Map([
      ['normal', 'normal'], ['internal', 'internal'], ['erc20', 'token'],
      ['erc721', 'nft'], ['erc1155', 'nft1155'], ['native_credit', 'statesync'],
    ]);
    for (const [capability, feed] of capabilityFeeds) {
      const rows = legacyRows.filter((row) => legacyCapability(row, chain) === capability);
      const coverage = coverageByFeed.get(feed);
      const coverageComplete = coverage?.status === 'complete'
        && coverage.covered_from_block != null && coverage.covered_through_block != null;
      const scope = await upsertScope({
        chainId, provider: 'existing-ledger', capability, status: 'running',
        fromBlock: coverage?.covered_from_block ?? 0,
        throughBlock: coverage?.covered_through_block ?? boundary.number,
        throughHash: null,
      });
      // The page and its raw evidence are already durable for this job. A
      // restarted worker must not replay even an empty/unsupported feed page;
      // only restore the same finite coverage verdict and continue.
      if (scope.pages_committed > 0) {
        await completeScope(scope.id, {
          status: coverageComplete ? 'complete' : 'unverified',
          paginationExhausted: coverageComplete,
          errorCode: coverageComplete ? null : (coverage?.error_code || 'LEDGER_COVERAGE_UNPROVEN'),
          errorDetail: coverageComplete ? null : (coverage?.error_message || `Stored ${feed} coverage is not proven complete.`),
        });
        continue;
      }
      const observations = normalizer.legacyTransferObservations(
        { ...context, provider: 'existing-ledger' }, rows
      );
      await commitPage(scope.id, pageRecord(
        'existing-ledger', 'stored-transfer-evidence', {
          feed, through_block: coverage?.covered_through_block ?? null,
        }, { body: { rows } }, null, null, rows.length
      ), observations);
      await completeScope(scope.id, {
        status: coverageComplete ? 'complete' : 'unverified',
        paginationExhausted: coverageComplete,
        errorCode: coverageComplete ? null : (coverage?.error_code || 'LEDGER_COVERAGE_UNPROVEN'),
        errorDetail: coverageComplete ? null : (coverage?.error_message || `Stored ${feed} coverage is not proven complete.`),
      });
    }
    for (const row of legacyRows) {
      const hash = String(row.tx_hash).toLowerCase();
      hashes.add(hash);
      moralisLookupHashes.add(hash);
    }

    const providerTransactionHashes = new Set((await EvmAudit.observationsForJob(
      job.id, { chainId }
    ))
      .filter((row) => row.provider === auditProvider && row.tx_hash)
      .map((row) => row.tx_hash));
    // A restart may resume at a later provider cursor or overlap boundary.
    // Rehydrate every hash already linked to this durable job so previously
    // committed pages can never disappear from canonicalization.
    for (const hash of providerTransactionHashes) hashes.add(hash);
    let providerLookupGaps = 0;
    if (useMoralis) {
      try {
        for (const hash of moralisLookupHashes) {
          if (providerTransactionHashes.has(hash)) continue;
          try {
            const lookup = await moralis.transactionByHash(hash, providerConfig.moralis);
            assertLease(leaseState);
            const item = lookup.body;
            const observations = normalizer.historyObservations(context, item);
            await commitPage(historyScope.id, pageRecord(
              'moralis', 'transaction-lookup', { chain: providerConfig.moralis, transaction_hash: hash },
              lookup, null, null, 1
            ), observations);
          } catch (error) {
            providerLookupGaps += 1;
            await recordProviderAttempt({
              jobId: job.id, scopeId: historyScope.id, provider: 'moralis',
              endpoint: 'transaction-lookup',
              requestParams: { chain: providerConfig.moralis, transaction_hash: hash },
              outcome: ['MORALIS_RATE_LIMITED', 'MORALIS_QUOTA_EXHAUSTED'].includes(error.code)
                ? 'deferred' : 'failed',
              httpStatus: error.httpStatus || null, errorCode: error.code || 'MORALIS_LOOKUP_FAILED',
              errorDetail: publicErrorDetail(error), requestId: error.requestId || null,
            });
            if (['MORALIS_RATE_LIMITED', 'MORALIS_QUOTA_EXHAUSTED', 'MORALIS_AUTH_FAILED'].includes(error.code)) throw error;
          }
        }
      } catch (error) {
        return fallbackAfterMoralis(error, historyScope.id);
      }
    }
    // Transaction lookups use the same durable scope as the paginated history
    // stream. commitPage() correctly reopens a scope when it appends evidence,
    // so close it again after the lookup pass; otherwise a finite, exhausted
    // history can be reported as still running even though all pages committed.
    await completeScope(historyScope.id, { status: 'complete', paginationExhausted: true });

    await EvmAudit.heartbeat(job.id, OWNER, { stage: 'canonicalizing' });
    const rpcScope = await upsertScope({
      chainId, provider: 'consensus-rpc', capability: 'receipt_verification', status: 'running',
      fromBlock: null, throughBlock: boundary.number, throughHash: boundary.hash,
    });
    const verifiedReceiptHashes = await EvmAudit.verifiedConsensusReceiptHashes(
      job.subject_id, chainId
    );
    for (const hash of hashes) {
      if (verifiedReceiptHashes.has(hash)) continue;
      const renewedBeforeLookup = await EvmAudit.heartbeat(job.id, OWNER, {
        stage: 'canonicalizing',
        progress: { current_tx_hash: hash },
      });
      if (!renewedBeforeLookup) leaseState.lost = true;
      assertLease(leaseState);
      const { transaction, receipt, block, evidence } = await rpc.transactionAndReceipt(hash);
      assertLease(leaseState);
      if (Number(BigInt(transaction.blockNumber)) > boundary.number) continue;
      const observations = normalizer.rpcTransactionObservations(
        { ...context, provider: 'consensus-rpc' }, transaction, receipt
      );
      const committed = await commitPage(rpcScope.id, rpcPageRecord(
        'transaction-and-receipt', { transaction_hash: hash, boundary_block: boundary.number },
        { transaction, receipt, block }, evidence || [], 1
      ), observations);
      const observationIds = new Map(observations.map((observation, index) => [
        observation.providerObjectKey, committed.observationIds[index],
      ]));
      const tx = normalizer.transactionFromRpc(
        context, transaction, receipt, observationIds.get(`transaction:${hash}`)
      );
      const canonical = await upsertMinedTransaction(tx);
      await linkTransactionEvidence(canonical.id, [
        { observationId: observationIds.get(`transaction:${hash}`), role: 'transaction' },
        { observationId: observationIds.get(`receipt:${hash}`), role: 'receipt' },
      ].filter((entry) => entry.observationId));
      const rpcEffects = effectsFromRpc(context, transaction, receipt, observationIds);
      for (const effect of rpcEffects) {
        const stored = await upsertCanonicalEffect(effect);
        await linkEffectEvidence(stored.id, effect.evidenceObservationIds);
      }
      await EvmAudit.invalidateMissingRpcEffects(
        job.subject_id, chainId, hash, rpcEffects.map((effect) => effect.effectKey),
        observationIds.get(`receipt:${hash}`) || null, writeFence
      );
      const renewedAfterCommit = await EvmAudit.heartbeat(job.id, OWNER, {
        stage: 'canonicalizing',
      });
      if (!renewedAfterCommit) leaseState.lost = true;
      assertLease(leaseState);
    }
    await completeScope(rpcScope.id, {
      status: 'unverified', paginationExhausted: false,
      errorCode: 'POINT_LOOKUPS_ONLY',
      errorDetail: 'Consensus RPC verified known transaction receipts but did not enumerate account history.',
    });

    const pointCheckBasis = 'consensus_rpc_point_checks_at_finalized_boundary_v1';
    const nonceScope = await upsertScope({
      chainId, provider: 'consensus-rpc', capability: 'nonce', status: 'running',
      fromBlock: 0, throughBlock: boundary.number, throughHash: boundary.hash,
      coverageBasis: pointCheckBasis,
    });
    const nativeBalanceScope = await upsertScope({
      chainId, provider: 'consensus-rpc', capability: 'native_balance', status: 'running',
      fromBlock: 0, throughBlock: boundary.number, throughHash: boundary.hash,
      coverageBasis: pointCheckBasis,
    });
    const tokenBalanceScope = await upsertScope({
      chainId, provider: 'consensus-rpc', capability: 'token_balance', status: 'running',
      fromBlock: 0, throughBlock: boundary.number, throughHash: boundary.hash,
      coverageBasis: pointCheckBasis,
    });

    const internalObservations = [
      ...(await EvmAudit.observationsForJob(job.id, {
        chainId, evidenceKind: 'internal_trace',
      })),
      ...(await EvmAudit.observationsForJob(job.id, {
        chainId, evidenceKind: 'native_credit',
      })),
    ];
    for (const effect of effectsFromInternalObservations(context, internalObservations)) {
      const stored = await upsertCanonicalEffect(effect);
      await linkEffectEvidence(stored.id, effect.evidenceObservationIds);
    }

    // Legacy rows may have the right economics but no immutable log index.
    // Upgrade only the independently corroborated receipt effects before the
    // strict reconciliation pass; unresolved economic matches remain gaps.
    const identityRepair = await EvmAudit.repairCorroboratedTransferIdentities(
      job.id, job.user_id, job.subject_id, chainId, boundary.number, writeFence
    );
    legacyRows = await EvmAudit.storedTransferRows(
      job.user_id, job.subject_id, chainId, boundary.number
    );
    let canonicalEffects = await EvmAudit.canonicalEffects(job.subject_id, chainId, boundary.number);
    let effectReconciliation = reconcileEffects(canonicalEffects, legacyRows, job.address, chain);
    if (effectReconciliation.missing.length) {
      const inserted = await EvmAudit.backfillVerifiedEffects(
        job.user_id, job.subject_id, chainId,
        effectReconciliation.missing.map((effect) => effect.id), writeFence
      );
      if (inserted) {
        await EthDerivedPipeline.serializedForUser(job.user_id, async () => {
          await EthDerivedPipeline.rebuildWallet(job.requested_wallet_id, { rebuildMatches: false });
          await EthDerivedPipeline.finishUser(job.user_id);
        });
        legacyRows = await EvmAudit.storedTransferRows(
          job.user_id, job.subject_id, chainId, boundary.number
        );
        canonicalEffects = await EvmAudit.canonicalEffects(job.subject_id, chainId, boundary.number);
        effectReconciliation = reconcileEffects(canonicalEffects, legacyRows, job.address, chain);
      }
    }

    const transactions = await EvmAudit.canonicalTransactions(job.subject_id, chainId);
    const transactionConflicts = await EvmAudit.transactionConflictCount(job.subject_id, chainId);
    await EvmAudit.heartbeat(job.id, OWNER, { stage: 'nonce_verification' });
    const codeEvidence = await rpc.codeWithEvidence(job.address, boundary.numberHex);
    await commitPage(nonceScope.id, rpcPageRecord(
      'account-code', { address: job.address, block_tag: boundary.numberHex },
      { address: job.address, block_tag: boundary.numberHex, code: codeEvidence.value },
      [codeEvidence.evidence]
    ), []);
    const code = codeEvidence.value;
    let nonceGapCount = 0;
    if (code !== '0x') {
      await storeNonceAudit({
        jobId: job.id, subjectId: job.subject_id, chainId,
        boundaryBlock: boundary.number, boundaryBlockHash: boundary.hash,
        nextMinedNonce: null, observedOutgoingCount: 0, status: 'unsupported',
        errorCode: 'SUBJECT_IS_CONTRACT', errorDetail: 'Nonce completeness applies only to EOAs.',
      });
    } else {
      const nonceEvidence = await rpc.transactionCountWithEvidence(job.address, boundary.numberHex);
      await commitPage(nonceScope.id, rpcPageRecord(
        'account-nonce', { address: job.address, block_tag: boundary.numberHex },
        { address: job.address, block_tag: boundary.numberHex, next_mined_nonce: nonceEvidence.value.toString() },
        [nonceEvidence.evidence]
      ), []);
      const nextNonce = nonceEvidence.value;
      const outgoing = transactions.filter((row) => row.signedness === 'user_signed' && BigInt(row.nonce) < nextNonce);
      const missing = missingRanges(outgoing.map((row) => row.nonce), nextNonce);
      const conflicts = conflictNonces(outgoing);
      const unknown = transactions.filter((row) => row.signedness === 'unknown').length;
      nonceGapCount = missing.length + conflicts.length + unknown;
      await storeNonceAudit({
        jobId: job.id, subjectId: job.subject_id, chainId,
        boundaryBlock: boundary.number, boundaryBlockHash: boundary.hash,
        nextMinedNonce: nextNonce.toString(), observedOutgoingCount: outgoing.length,
        missingNonces: missing, conflictingNonces: conflicts, unknownSignednessCount: unknown,
        status: nonceGapCount ? 'unverified' : 'complete',
      });
    }
    await completeScope(nonceScope.id, {
      status: 'complete', paginationExhausted: true, coverageBasis: pointCheckBasis,
    });

    await EvmAudit.heartbeat(job.id, OWNER, { stage: 'balance_reconciliation' });
    const [liveBalanceEvidence, derivedBalance] = await Promise.all([
      rpc.balanceWithEvidence(job.address, boundary.numberHex),
      EvmAudit.nativeDerivedAt(job.user_id, job.subject_id, chainId, boundary.number),
    ]);
    await commitPage(nativeBalanceScope.id, rpcPageRecord(
      'native-balance', { address: job.address, block_tag: boundary.numberHex },
      { address: job.address, block_tag: boundary.numberHex,
        balance_wei: liveBalanceEvidence.value.toString() },
      [liveBalanceEvidence.evidence]
    ), []);
    const liveBalance = liveBalanceEvidence.value;
    const delta = liveBalance - BigInt(derivedBalance);
    await storeBalanceAudit({
      jobId: job.id, subjectId: job.subject_id, chainId,
      assetKey: 'native', assetType: 'native', boundaryBlock: boundary.number,
      derivedUnits: derivedBalance, liveUnits: liveBalance.toString(), deltaUnits: delta.toString(),
      status: delta === 0n ? 'match' : 'mismatch',
      detail: { boundary_hash: boundary.hash },
    });
    await completeScope(nativeBalanceScope.id, {
      status: 'complete', paginationExhausted: true, coverageBasis: pointCheckBasis,
    });

    let tokenMismatches = 0;
    let tokenEvidenceFailures = 0;
    const tokenBalances = await EvmAudit.tokenDerivedAt(
      job.user_id, job.subject_id, chainId, boundary.number
    );
    const tokensByContract = new Map(tokenBalances.map((token) => [
      String(token.token_contract).toLowerCase(), token,
    ]));
    // CDP's balance index is used to discover ERC-20 contracts that the
    // derived ledger does not contain. Consensus RPC, not CDP's delayed
    // balance value, is authoritative for the actual comparison.
    for (const balance of cdpBalances) {
      if (String(balance?.asset?.type || '').toLowerCase() !== 'erc20') continue;
      const contract = String(balance.asset.groupId || '').toLowerCase();
      if (!tokensByContract.has(contract)) {
        tokensByContract.set(contract, {
          token_contract: contract, token_decimals: balance.decimals, balance_units: '0',
        });
      }
    }
    for (const token of tokensByContract.values()) {
      try {
        const liveEvidence = await rpc.erc20BalanceWithEvidence(
          token.token_contract, job.address, boundary.numberHex
        );
        await commitPage(tokenBalanceScope.id, rpcPageRecord(
          'erc20-balance', {
            contract: token.token_contract, address: job.address, block_tag: boundary.numberHex,
          },
          {
            contract: token.token_contract, address: job.address,
            block_tag: boundary.numberHex, balance_units: liveEvidence.value.toString(),
          },
          [liveEvidence.evidence]
        ), []);
        const live = liveEvidence.value;
        const tokenDelta = live - BigInt(token.balance_units);
        if (tokenDelta !== 0n) tokenMismatches += 1;
        await storeBalanceAudit({
          jobId: job.id, subjectId: job.subject_id, chainId,
          assetKey: token.token_contract, assetType: 'erc20', boundaryBlock: boundary.number,
          derivedUnits: token.balance_units, liveUnits: live.toString(), deltaUnits: tokenDelta.toString(),
          status: tokenDelta === 0n ? 'match' : 'mismatch',
          detail: { boundary_hash: boundary.hash, token_decimals: Number(token.token_decimals) },
        });
      } catch (error) {
        tokenEvidenceFailures += 1;
        await storeBalanceAudit({
          jobId: job.id, subjectId: job.subject_id, chainId,
          assetKey: token.token_contract, assetType: 'erc20', boundaryBlock: boundary.number,
          derivedUnits: token.balance_units, liveUnits: null, deltaUnits: null,
          status: error.code === 'RPC_UNSUPPORTED' ? 'unsupported' : 'failed',
          detail: { error_code: error.code || 'TOKEN_BALANCE_FAILED' },
        });
        tokenMismatches += 1;
      }
    }
    await completeScope(tokenBalanceScope.id, {
      status: tokenEvidenceFailures ? 'failed' : 'complete',
      paginationExhausted: !tokenEvidenceFailures,
      coverageBasis: pointCheckBasis,
      errorCode: tokenEvidenceFailures ? 'TOKEN_BALANCE_EVIDENCE_FAILED' : null,
      errorDetail: tokenEvidenceFailures
        ? `${tokenEvidenceFailures} consensus token balance point check(s) failed.` : null,
    });

    let activityHashes = await EvmAudit.activityTxHashes(job.user_id, job.subject_id, chainId, boundary.number);
    let missingActivity = transactions.filter((row) => !activityHashes.has(row.tx_hash)).length;
    // Canonical transactions can be discovered without any wallet leg (for
    // example, an externally signed zero-value contract call). In that case no
    // effect backfill runs, but the derived activity table still needs one
    // serialized rebuild before the audit can claim every mined transaction is
    // explained.
    if (missingActivity > 0) {
      await EthDerivedPipeline.serializedForUser(job.user_id, async () => {
        await EthDerivedPipeline.rebuildWallet(job.requested_wallet_id, { rebuildMatches: false });
        await EthDerivedPipeline.finishUser(job.user_id);
      });
      activityHashes = await EvmAudit.activityTxHashes(job.user_id, job.subject_id, chainId, boundary.number);
      missingActivity = transactions.filter((row) => !activityHashes.has(row.tx_hash)).length;
    }
    await EvmAudit.heartbeat(job.id, OWNER, { stage: 'bridge_reconciliation' });
    const bridgeAudit = await EvmAudit.bridgeAudit(
      job.user_id, job.subject_id, chainId, boundary.number
    );
    const unresolvedBridges = bridgeAudit.unresolved.length;
    const provisionalEffects = await EvmAudit.provisionalEffectCount(job.subject_id, chainId);
    const unmatchedEffects = effectReconciliation.gaps;
    const capabilityGaps = await EvmAudit.requiredScopeGapCount(job.id, chainId);
    const gaps = providerLookupGaps + nonceGapCount + transactionConflicts + capabilityGaps
      + (cdpBalanceEvidenceFailed ? 1 : 0) + (delta === 0n ? 0 : 1)
      + tokenMismatches + missingActivity + unresolvedBridges + provisionalEffects
      + unmatchedEffects;
    await EvmAudit.heartbeat(job.id, OWNER, {
      progress: {
        [`chain_${chainId}`]: {
          boundary_block: boundary.number,
          transactions: transactions.length,
          provider_lookup_gaps: providerLookupGaps,
          transaction_conflicts: transactionConflicts,
          capability_gaps: capabilityGaps,
          nonce_gaps: nonceGapCount,
          native_balance_match: delta === 0n,
          token_balance_gaps: tokenMismatches,
          balance_evidence_gap: cdpBalanceEvidenceFailed,
          corroborated_identity_repairs: identityRepair.repaired,
          missing_activity: missingActivity,
          unresolved_bridges: bridgeAudit.unresolved,
          provisional_effects: provisionalEffects,
          unmatched_effects: unmatchedEffects,
          unsupported_capabilities: [],
        },
      },
    });
    return { gaps, boundary, transactions: transactions.length, discovered };
  }
}

module.exports = EvmAuditService;
module.exports._missingRanges = missingRanges;
module.exports._unmatchedEffectCount = unmatchedEffectCount;
module.exports._isBlockscoutTransient = isBlockscoutTransient;
module.exports._isStandingExplorerLimitation = isStandingExplorerLimitation;

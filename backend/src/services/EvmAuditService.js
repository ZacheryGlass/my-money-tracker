'use strict';

const crypto = require('node:crypto');
const EvmAudit = require('../models/EvmAudit');
const EthWallet = require('../models/EthWallet');
const SecretsService = require('./SecretsService');
const EthDerivedPipeline = require('./EthDerivedPipeline');
const chains = require('../config/chains');
const logger = require('../config/logger');
const MoralisClient = require('./evmAudit/MoralisClient');
const RpcClient = require('./evmAudit/RpcClient');
const normalizer = require('./evmAudit/normalizer');
const { effectsFromInternalObservations, effectsFromRpc } = require('./evmAudit/effectDecoder');

const AUDIT_CHAINS = new Map([
  [100, { moralis: 'gnosis', activeIds: new Set(['0x64', '100', 'gnosis']) }],
  [8453, { moralis: 'base', activeIds: new Set(['0x2105', '8453', 'base']) }],
]);
const OVERLAP_BLOCKS = 64;
const OWNER = `${process.pid}:${crypto.randomUUID()}`;
const queuedLocally = new Set();
let resumeTimer = null;

function pageRecord(provider, endpoint, requestParams, response, cursorIn = null, cursorOut = null, itemCount = 0) {
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
  };
}

function activeRowMatches(row, config) {
  const candidates = [row.chain_id, row.chain, row.chain_name, row.name]
    .filter((value) => value != null)
    .map((value) => String(value).toLowerCase());
  return candidates.some((value) => config.activeIds.has(value));
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
      type = chain?.auditNativeCredits?.contract?.toLowerCase() === from ? 'native_credit' : 'internal';
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

  static async request(userId, walletId, { mode = 'incremental', requestedChains = null } = {}) {
    const wallet = await EthWallet.findByIdForUser(walletId, userId);
    if (!wallet) return null;
    const selected = (requestedChains || this.supportedChainIds())
      .map(Number).filter((chainId) => AUDIT_CHAINS.has(chainId));
    const credentialGeneration = await EvmAudit.credentialGeneration(userId);
    const result = await EvmAudit.createOrFindActiveJob(userId, wallet, {
      mode,
      requestedChains: [...new Set(selected)],
      credentialGeneration,
    });
    this.enqueue(result.job.id);
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
      const key = await SecretsService.getUserKey(job.user_id, 'moralis');
      if (!key) {
        return EvmAudit.finish(jobId, OWNER, 'deferred', {
          errorCode: 'MORALIS_NOT_CONFIGURED',
          errorDetail: 'Configure a Moralis API key in Settings to run this optional audit.',
          // Do not wake this job every 30 seconds while configuration is
          // absent. A user request still enqueues the active job immediately,
          // so saving a key and pressing Audit resumes without waiting.
          retryAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
        });
      }
      const credentialGeneration = await EvmAudit.credentialGeneration(job.user_id);
      if (job.credential_generation
          && credentialGeneration
          && new Date(job.credential_generation).getTime() !== new Date(credentialGeneration).getTime()) {
        return EvmAudit.finish(jobId, OWNER, 'failed', {
          errorCode: 'CREDENTIAL_GENERATION_CHANGED',
          errorDetail: 'The Moralis credential changed after this audit was requested. Start a new audit.',
        });
      }

      const retainAttempt = async (attempt) => {
        try {
          await EvmAudit.recordProviderAttempt({ jobId, ...attempt });
        } catch (error) {
          logger.warn({ err: error, auditJobId: jobId }, 'Failed to retain provider attempt evidence');
        }
      };
      const moralis = new MoralisClient(key, { onFailedAttempt: retainAttempt });
      const requested = (job.requested_chains || []).map(Number).filter((id) => AUDIT_CHAINS.has(id));
      if (!requested.length) {
        return EvmAudit.finish(jobId, OWNER, 'unsupported', {
          errorCode: 'NO_SUPPORTED_CHAINS', errorDetail: 'No supported audit chains were requested.',
        });
      }

      await EvmAudit.heartbeat(jobId, OWNER, { stage: 'discovering' });
      const activeResponse = await moralis.activeChains(job.address, requested.map((id) => AUDIT_CHAINS.get(id).moralis));
      assertLease(leaseState);
      const activeRows = Array.isArray(activeResponse.body.active_chains) ? activeResponse.body.active_chains : [];
      const discovered = requested.map((chainId) => {
        const row = activeRows.find((candidate) => activeRowMatches(candidate, AUDIT_CHAINS.get(chainId)));
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
      for (const chainId of requested) {
        assertLease(leaseState);
        const result = await this.runChain({
          job, chainId, moralis, activeResponse, discovered, leaseState, retainAttempt,
        });
        gaps += result.gaps;
      }
      return EvmAudit.finish(jobId, OWNER, gaps ? 'complete_with_gaps' : 'complete', {
        progress: { chains_finished: requested.length, gaps },
      });
    } catch (error) {
      const deferred = ['MORALIS_RATE_LIMITED', 'MORALIS_TRANSPORT_ERROR', 'RPC_RATE_LIMITED', 'RPC_TRANSPORT_ERROR']
        .includes(error.code);
      if (String(error.code || '').startsWith('MORALIS_') || String(error.code || '').startsWith('RPC_')) {
        try {
          await EvmAudit.recordProviderAttempt({
            jobId, provider: String(error.code).startsWith('MORALIS_') ? 'moralis' : 'consensus-rpc',
            endpoint: job.stage || 'audit-worker', requestParams: { requested_chains: job.requested_chains || [] },
            outcome: deferred ? 'deferred' : 'failed', httpStatus: error.httpStatus || null,
            errorCode: error.code || 'EVM_AUDIT_FAILED', errorDetail: publicErrorDetail(error),
            requestId: error.requestId || null,
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

  static async runChain({ job, chainId, moralis, activeResponse, discovered, leaseState, retainAttempt }) {
    const chain = chains.getChain(chainId);
    const providerConfig = AUDIT_CHAINS.get(chainId);
    const rpc = new RpcClient(chainId, { onFailedAttempt: retainAttempt });
    const boundary = await rpc.finalizedBoundary();
    const context = {
      jobId: job.id, subjectId: job.subject_id, chainId,
      address: job.address, provider: 'moralis', chain,
    };
    await EvmAudit.heartbeat(job.id, OWNER, {
      stage: 'fetching', progress: { current_chain: chainId, boundary_block: boundary.number },
    });

    const activeScope = await EvmAudit.upsertScope(job.id, {
      chainId, provider: 'moralis', capability: 'active_chain', status: 'running',
      fromBlock: 0, throughBlock: boundary.number, throughHash: boundary.hash,
    });
    const activeBody = {
      active_chains: (activeResponse.body.active_chains || [])
        .filter((row) => activeRowMatches(row, providerConfig)),
    };
    await EvmAudit.commitPage(activeScope.id, pageRecord(
      'moralis', 'active-chain-discovery', {
        chains: (job.requested_chains || []).map((id) => AUDIT_CHAINS.get(Number(id))?.moralis).filter(Boolean),
      },
      activeResponse, null, null, activeBody.active_chains.length
    ), normalizer.activeChainObservations(context, activeBody));
    // Active-chain discovery is a hint, not proof of historical absence.
    await EvmAudit.completeScope(activeScope.id, { status: 'unverified', paginationExhausted: false });

    const prior = job.mode === 'incremental'
      ? await EvmAudit.latestCoverage(job.subject_id, chainId, 'moralis', 'wallet_history')
      : null;
    const fromBlock = prior ? Math.max(0, Number(prior.through_block) - OVERLAP_BLOCKS) : 0;
    const historyScope = await EvmAudit.upsertScope(job.id, {
      chainId, provider: 'moralis', capability: 'wallet_history', status: 'running',
      fromBlock, throughBlock: boundary.number, throughHash: boundary.hash,
    });
    const hashes = new Set();
    let cursor = historyScope.provider_cursor || null;
    for await (const page of moralis.walletHistoryPages(job.address, {
      chain: providerConfig.moralis, fromBlock, throughBlock: boundary.number, cursor,
    })) {
      assertLease(leaseState);
      const observations = page.items.flatMap((item) => normalizer.historyObservations(context, item));
      for (const observation of observations) if (observation.txHash) hashes.add(observation.txHash);
      await EvmAudit.commitPage(historyScope.id, pageRecord(
        'moralis', 'wallet-history', {
          chain: providerConfig.moralis, from_block: fromBlock, to_block: boundary.number,
        }, page, page.cursorIn, page.cursorOut, page.items.length
      ), observations);
      cursor = page.cursorOut;
      await EvmAudit.heartbeat(job.id, OWNER, { progress: { current_cursor: cursor, transactions_seen: hashes.size } });
    }
    await EvmAudit.completeScope(historyScope.id, { status: 'complete', paginationExhausted: true });
    await EvmAudit.acceptCoverage({
      subjectId: job.subject_id, chainId, provider: 'moralis', capability: 'wallet_history',
      fromBlock, throughBlock: boundary.number, throughHash: boundary.hash,
      paginationExhausted: true, status: 'complete', jobId: job.id,
    });
    // One exhausted Moralis history stream carries these six ordinary
    // capabilities. Keep their finite bounds explicit; RPC receipt lookups
    // remain a separate non-enumerating scope.
    for (const capability of ['normal', 'internal', 'erc20', 'erc721', 'erc1155', 'native_credit']) {
      const capabilityScope = await EvmAudit.upsertScope(job.id, {
        chainId, provider: 'moralis', capability, status: 'running',
        fromBlock, throughBlock: boundary.number, throughHash: boundary.hash,
      });
      await EvmAudit.completeScope(capabilityScope.id, {
        status: 'complete', paginationExhausted: true,
      });
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
      const scope = await EvmAudit.upsertScope(job.id, {
        chainId, provider: 'existing-ledger', capability, status: 'running',
        fromBlock: coverage?.covered_from_block ?? 0,
        throughBlock: coverage?.covered_through_block ?? boundary.number,
        throughHash: null,
      });
      // The page and its raw evidence are already durable for this job. A
      // restarted worker must not replay even an empty/unsupported feed page;
      // only restore the same finite coverage verdict and continue.
      if (scope.pages_committed > 0) {
        await EvmAudit.completeScope(scope.id, {
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
      await EvmAudit.commitPage(scope.id, pageRecord(
        'existing-ledger', 'stored-transfer-evidence', {
          feed, through_block: coverage?.covered_through_block ?? null,
        }, { body: { rows } }, null, null, rows.length
      ), observations);
      await EvmAudit.completeScope(scope.id, {
        status: coverageComplete ? 'complete' : 'unverified',
        paginationExhausted: coverageComplete,
        errorCode: coverageComplete ? null : (coverage?.error_code || 'LEDGER_COVERAGE_UNPROVEN'),
        errorDetail: coverageComplete ? null : (coverage?.error_message || `Stored ${feed} coverage is not proven complete.`),
      });
    }
    for (const row of legacyRows) hashes.add(String(row.tx_hash).toLowerCase());

    const moralisHashes = new Set((await EvmAudit.observationsForJob(job.id, { chainId, evidenceKind: 'transaction' }))
      .filter((row) => row.provider === 'moralis').map((row) => row.tx_hash));
    // A restart may resume at a later provider cursor or overlap boundary.
    // Rehydrate every hash already linked to this durable job so previously
    // committed pages can never disappear from canonicalization.
    for (const hash of moralisHashes) hashes.add(hash);
    let providerLookupGaps = 0;
    for (const hash of hashes) {
      if (moralisHashes.has(hash)) continue;
      try {
        const lookup = await moralis.transactionByHash(hash, providerConfig.moralis);
        assertLease(leaseState);
        const item = lookup.body;
        const observations = normalizer.historyObservations(context, item);
        await EvmAudit.commitPage(historyScope.id, pageRecord(
          'moralis', 'transaction-lookup', { chain: providerConfig.moralis, transaction_hash: hash },
          lookup, null, null, 1
        ), observations);
      } catch (error) {
        providerLookupGaps += 1;
        await EvmAudit.recordProviderAttempt({
          jobId: job.id, scopeId: historyScope.id, provider: 'moralis',
          endpoint: 'transaction-lookup',
          requestParams: { chain: providerConfig.moralis, transaction_hash: hash },
          outcome: error.code === 'MORALIS_RATE_LIMITED' ? 'deferred' : 'failed',
          httpStatus: error.httpStatus || null, errorCode: error.code || 'MORALIS_LOOKUP_FAILED',
          errorDetail: publicErrorDetail(error), requestId: error.requestId || null,
        });
        if (error.code === 'MORALIS_RATE_LIMITED' || error.code === 'MORALIS_AUTH_FAILED') throw error;
      }
    }

    await EvmAudit.heartbeat(job.id, OWNER, { stage: 'canonicalizing' });
    const rpcScope = await EvmAudit.upsertScope(job.id, {
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
      const { transaction, receipt } = await rpc.transactionAndReceipt(hash);
      assertLease(leaseState);
      if (Number(BigInt(transaction.blockNumber)) > boundary.number) continue;
      const observations = normalizer.rpcTransactionObservations(
        { ...context, provider: 'consensus-rpc' }, transaction, receipt
      );
      const committed = await EvmAudit.commitPage(rpcScope.id, pageRecord(
        'consensus-rpc', 'transaction-and-receipt', { transaction_hash: hash, boundary_block: boundary.number },
        { body: { transaction, receipt } }, null, null, 1
      ), observations);
      const observationIds = new Map(observations.map((observation, index) => [
        observation.providerObjectKey, committed.observationIds[index],
      ]));
      const tx = normalizer.transactionFromRpc(
        context, transaction, receipt, observationIds.get(`transaction:${hash}`)
      );
      const canonical = await EvmAudit.upsertMinedTransaction(tx);
      await EvmAudit.linkTransactionEvidence(canonical.id, [
        { observationId: observationIds.get(`transaction:${hash}`), role: 'transaction' },
        { observationId: observationIds.get(`receipt:${hash}`), role: 'receipt' },
      ].filter((entry) => entry.observationId));
      const rpcEffects = effectsFromRpc(context, transaction, receipt, observationIds);
      for (const effect of rpcEffects) {
        const stored = await EvmAudit.upsertCanonicalEffect(effect);
        await EvmAudit.linkEffectEvidence(stored.id, effect.evidenceObservationIds);
      }
      await EvmAudit.invalidateMissingRpcEffects(
        job.subject_id, chainId, hash, rpcEffects.map((effect) => effect.effectKey),
        observationIds.get(`receipt:${hash}`) || null
      );
      const renewedAfterCommit = await EvmAudit.heartbeat(job.id, OWNER, {
        stage: 'canonicalizing',
      });
      if (!renewedAfterCommit) leaseState.lost = true;
      assertLease(leaseState);
    }
    await EvmAudit.completeScope(rpcScope.id, {
      status: 'unverified', paginationExhausted: false,
      errorCode: 'POINT_LOOKUPS_ONLY',
      errorDetail: 'Consensus RPC verified known transaction receipts but did not enumerate account history.',
    });

    const internalObservations = await EvmAudit.observationsForJob(job.id, {
      chainId, evidenceKind: 'internal_trace',
    });
    for (const effect of effectsFromInternalObservations(context, internalObservations)) {
      const stored = await EvmAudit.upsertCanonicalEffect(effect);
      await EvmAudit.linkEffectEvidence(stored.id, effect.evidenceObservationIds);
    }

    let canonicalEffects = await EvmAudit.canonicalEffects(job.subject_id, chainId, boundary.number);
    let effectReconciliation = reconcileEffects(canonicalEffects, legacyRows, job.address, chain);
    if (effectReconciliation.missing.length) {
      const inserted = await EvmAudit.backfillVerifiedEffects(
        job.user_id, job.subject_id, chainId,
        effectReconciliation.missing.map((effect) => effect.id)
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
    const code = await rpc.code(job.address, boundary.numberHex);
    let nonceGapCount = 0;
    if (code !== '0x') {
      await EvmAudit.storeNonceAudit({
        jobId: job.id, subjectId: job.subject_id, chainId,
        boundaryBlock: boundary.number, boundaryBlockHash: boundary.hash,
        nextMinedNonce: null, observedOutgoingCount: 0, status: 'unsupported',
        errorCode: 'SUBJECT_IS_CONTRACT', errorDetail: 'Nonce completeness applies only to EOAs.',
      });
    } else {
      const nextNonce = await rpc.transactionCount(job.address, boundary.numberHex);
      const outgoing = transactions.filter((row) => row.signedness === 'user_signed' && BigInt(row.nonce) < nextNonce);
      const missing = missingRanges(outgoing.map((row) => row.nonce), nextNonce);
      const conflicts = conflictNonces(outgoing);
      const unknown = transactions.filter((row) => row.signedness === 'unknown').length;
      nonceGapCount = missing.length + conflicts.length + unknown;
      await EvmAudit.storeNonceAudit({
        jobId: job.id, subjectId: job.subject_id, chainId,
        boundaryBlock: boundary.number, boundaryBlockHash: boundary.hash,
        nextMinedNonce: nextNonce.toString(), observedOutgoingCount: outgoing.length,
        missingNonces: missing, conflictingNonces: conflicts, unknownSignednessCount: unknown,
        status: nonceGapCount ? 'unverified' : 'complete',
      });
    }

    await EvmAudit.heartbeat(job.id, OWNER, { stage: 'balance_reconciliation' });
    const [liveBalance, derivedBalance] = await Promise.all([
      rpc.balance(job.address, boundary.numberHex),
      EvmAudit.nativeDerivedAt(job.user_id, job.subject_id, chainId, boundary.number),
    ]);
    const delta = liveBalance - BigInt(derivedBalance);
    await EvmAudit.storeBalanceAudit({
      jobId: job.id, subjectId: job.subject_id, chainId,
      assetKey: 'native', assetType: 'native', boundaryBlock: boundary.number,
      derivedUnits: derivedBalance, liveUnits: liveBalance.toString(), deltaUnits: delta.toString(),
      status: delta === 0n ? 'match' : 'mismatch',
      detail: { boundary_hash: boundary.hash },
    });

    let tokenMismatches = 0;
    const tokenBalances = await EvmAudit.tokenDerivedAt(
      job.user_id, job.subject_id, chainId, boundary.number
    );
    for (const token of tokenBalances) {
      try {
        const live = await rpc.erc20Balance(token.token_contract, job.address, boundary.numberHex);
        const tokenDelta = live - BigInt(token.balance_units);
        if (tokenDelta !== 0n) tokenMismatches += 1;
        await EvmAudit.storeBalanceAudit({
          jobId: job.id, subjectId: job.subject_id, chainId,
          assetKey: token.token_contract, assetType: 'erc20', boundaryBlock: boundary.number,
          derivedUnits: token.balance_units, liveUnits: live.toString(), deltaUnits: tokenDelta.toString(),
          status: tokenDelta === 0n ? 'match' : 'mismatch',
          detail: { boundary_hash: boundary.hash, token_decimals: Number(token.token_decimals) },
        });
      } catch (error) {
        await EvmAudit.storeBalanceAudit({
          jobId: job.id, subjectId: job.subject_id, chainId,
          assetKey: token.token_contract, assetType: 'erc20', boundaryBlock: boundary.number,
          derivedUnits: token.balance_units, liveUnits: null, deltaUnits: null,
          status: error.code === 'RPC_UNSUPPORTED' ? 'unsupported' : 'failed',
          detail: { error_code: error.code || 'TOKEN_BALANCE_FAILED' },
        });
        tokenMismatches += 1;
      }
    }

    const activityHashes = await EvmAudit.activityTxHashes(job.user_id, job.subject_id, chainId, boundary.number);
    const missingActivity = transactions.filter((row) => !activityHashes.has(row.tx_hash)).length;
    await EvmAudit.heartbeat(job.id, OWNER, { stage: 'bridge_reconciliation' });
    const bridgeAudit = await EvmAudit.bridgeAudit(
      job.user_id, job.subject_id, chainId, boundary.number
    );
    const unresolvedBridges = bridgeAudit.unresolved.length;
    const provisionalEffects = await EvmAudit.provisionalEffectCount(job.subject_id, chainId);
    const unmatchedEffects = effectReconciliation.gaps;
    const capabilityGaps = await EvmAudit.requiredScopeGapCount(job.id, chainId);
    const gaps = providerLookupGaps + nonceGapCount + transactionConflicts + capabilityGaps + (delta === 0n ? 0 : 1)
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

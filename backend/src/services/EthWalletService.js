'use strict';

const crypto = require('node:crypto');
const pool = require('../config/database');
const EtherscanService = require('./EtherscanService');
const ZkSyncLiteService = require('./ZkSyncLiteService');
const SecretsService = require('./SecretsService');
const EthDerivedPipeline = require('./EthDerivedPipeline');
const EthReconciliationService = require('./EthReconciliationService');
const MethodSignatureService = require('./MethodSignatureService');
const PriceService = require('./PriceService');
const EthWallet = require('../models/EthWallet');
const EthWalletChain = require('../models/EthWalletChain');
const EthFeedCoverage = require('../models/EthFeedCoverage');
const EthTransfer = require('../models/EthTransfer');
const EthProviderPage = require('../models/EthProviderPage');
const chains = require('../config/chains');
const logger = require('../config/logger');
const { shortAddress } = require('../utils/ethAddress');
const CdpClient = require('./evmAudit/CdpClient');
const CdpHistoryProvider = require('./evmAudit/CdpHistoryProvider');
const CdpRecoveryProvider = require('./evmAudit/CdpRecoveryProvider');
const normalizer = require('./evmAudit/normalizer');
const RpcClient = require('./evmAudit/RpcClient');

const cdpAddressTransactionItems = CdpClient.addressTransactionItems;
const CDP_HISTORY_PAGE_SIZE = CdpClient.DEFAULT_HISTORY_PAGE_SIZE;

const ADDRESS_RE = /^0x[0-9a-f]{40}$/i;

// The Etherscan feeds, each with the cursor it resumes from and the
// transfer_types it owns. `normal` owns two: gas rows are synthesized from
// txlist, so they share its resume window.
//
// The first five are the account feeds and run on every chain. The sixth,
// `statesync` (#76), is declared PER CHAIN: it runs only where the chain object
// carries the config named by `chainFeed` (config/chains.js
// `stateSyncDeposits`). It stores transfer_type='internal' rows -- the same type the
// `internal` feed owns -- so native balance math, the mirror, activity and
// valuation read it unchanged; the two feeds are kept from clearing each other's
// rows by from_address (see the delete loop in _syncWalletChain).
//
// Order matters only for throttle fairness -- the feeds are independent, and
// each one's failure is isolated from the others (see _syncWalletChain).
const FEED_SPECS = [
  { key: 'normal', fetch: 'fetchNormalTxs', types: ['native', 'gas'] },
  { key: 'internal', fetch: 'fetchInternalTxs', types: ['internal'] },
  { key: 'token', fetch: 'fetchTokenTxs', types: ['token'] },
  { key: 'nft', fetch: 'fetchNftTxs', types: ['nft'] },
  { key: 'nft1155', fetch: 'fetch1155Txs', types: ['nft1155'] },
  { key: 'statesync', fetch: 'fetchStateSyncDeposits', types: ['internal'], chainFeed: 'stateSyncDeposits' },
];

// The transfer_type the state-sync feed shares with the `internal` feed, and the
// feed whose config declares the precompile. Named once so the delete-scoping in
// _syncWalletChain reads as intent rather than string literals.
//
// Exactly ONE per-chain feed is assumed: the internal feed's insert filter and
// both delete-scoping arms are built around this single contract address, so a
// second chainFeed spec would silently take the wrong exclusion. Fail at load,
// where the spec is added, not later in production data.
const CHAIN_FEED_SPECS = FEED_SPECS.filter((spec) => spec.chainFeed);
if (CHAIN_FEED_SPECS.length !== 1) {
  throw new Error('FEED_SPECS declares more than one per-chain feed; generalize the internal/statesync insert and delete scoping first');
}
const STATE_SYNC_SPEC = CHAIN_FEED_SPECS[0];

// holdings.quantity is DECIMAL(20,8): 12 integer digits, 8 fractional.
// Scam-token airdrops mint absurd quantities that would overflow the column
// and break the whole sync, so quantities are clamped; the ignore list is the
// real remedy for those tokens.
const MAX_QUANTITY = '999999999999.99999999';

function unitsToDecimalString(value, decimals) {
  const v = BigInt(value);
  if (v <= 0n) return '0';
  const base = 10n ** BigInt(decimals);
  const whole = v / base;
  if (whole.toString().length > 12) return MAX_QUANTITY;
  const frac = (v % base).toString().padStart(Number(decimals), '0').slice(0, 8);
  return frac ? `${whole}.${frac}` : whole.toString();
}

// Sync resumes this many blocks before the stored cursor so a chain reorg
// near the tip is healed by the delete-then-reinsert ingest. Sized past
// Ethereum's finality window (~2 epochs = 64 blocks).
const REORG_OVERLAP_BLOCKS = 64;

const DEFAULT_DEFERRED_RETRY_MS = 1100;
const MAX_PROVIDER_RETRY_WAIT_MS = 5 * 60 * 1000;

function boundedEnvInteger(name, fallback, maximum) {
  const value = Number(process.env[name]);
  if (!Number.isInteger(value) || value < 0) return fallback;
  return Math.min(value, maximum);
}

const SYNC_DEFERRED_RETRY_ATTEMPTS = boundedEnvInteger(
  'ETH_SYNC_DEFERRED_RETRY_ATTEMPTS', 2, 5
);
const SYNC_DEFERRED_RETRY_MAX_MS = boundedEnvInteger(
  'ETH_SYNC_DEFERRED_RETRY_MAX_MS', MAX_PROVIDER_RETRY_WAIT_MS,
  MAX_PROVIDER_RETRY_WAIT_MS
);

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

// A full-history replay is expensive. The derived pipeline already serializes
// all wallet work for one user, but without this guard two clicks would still
// queue two complete replays. This map covers one running process; after a
// restart the reset cursors remain durable and the next normal sync resumes the
// unfinished recapture from genesis.
const recaptureRuns = new Map();
const PROVIDER_SCAN_OWNER = `${process.pid}:${crypto.randomUUID()}`;

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

// A successful provider walk can cover blocks even when it finds no rows.
// Account and native-credit feeds carry that non-enumerable boundary so an
// empty feed advances instead of rescanning from genesis forever.
function scannedThroughBlock(rows) {
  return rows.scannedThroughBlock ?? maxBlock(rows);
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

function providerName(chain) {
  if (chain.historyProvider === 'coinbase-cdp') {
    return 'Coinbase CDP address history (Base)';
  }
  if (chain.historyProvider === 'zksync-lite') {
    return 'Matter Labs zkSync Lite archive';
  }
  if (chain.accountApi) {
    const accountUrl = chain.accountApi.v2BaseUrl || chain.accountApi.baseUrl;
    return `${chain.accountApi.provider || 'chain explorer'} (${accountUrl})`;
  }
  return 'Etherscan V2';
}

function coverageFailureStatus(error) {
  if (isExplorerRateLimited(error) || String(error?.code || '').startsWith('CDP_')
      && ['CDP_RATE_LIMITED', 'CDP_QUOTA_EXHAUSTED', 'CDP_TRANSPORT_ERROR', 'CDP_NOT_CONFIGURED',
        'CDP_SCAN_BUSY', 'CDP_RESPONSE_TOO_LARGE', 'CDP_ADDRESS_ENUMERATION_UNPROVEN',
        'CDP_RECOVERY_NOT_FOUND', 'CDP_RECOVERY_TRACE_UNAVAILABLE',
        'CDP_RECOVERY_BUDGET_EXHAUSTED'].includes(error.code)) {
    return 'deferred';
  }
  if (error?.code === 'CDP_RECOVERY_UNSUPPORTED') return 'unsupported';
  if (['RPC_RATE_LIMITED', 'RPC_TRANSPORT_ERROR'].includes(error?.code)) return 'deferred';
  return ['ETHERSCAN_CHAIN_UNAVAILABLE', 'ETHERSCAN_FEED_UNSUPPORTED'].includes(error?.code)
    ? 'unsupported' : 'failed';
}

function isExplorerRateLimited(error) {
  return error?.code === 'EXPLORER_RATE_LIMITED';
}

function retryAfterAt(error) {
  const explicitValue = error?.retryAfterAt ?? error?.retryAt;
  const explicit = explicitValue instanceof Date
    ? explicitValue
    : new Date(explicitValue || NaN);
  if (!Number.isNaN(explicit.getTime())) return explicit;
  const delay = Math.min(
    MAX_PROVIDER_RETRY_WAIT_MS,
    Math.max(1, Number(error?.retryAfterMs) || DEFAULT_DEFERRED_RETRY_MS)
  );
  return new Date(Date.now() + delay);
}

function retryAfterMsForResult(result) {
  const retryAt = new Date(result?.retryAfterAt || NaN);
  if (!Number.isNaN(retryAt.getTime())) {
    return Math.max(0, retryAt.getTime() - Date.now());
  }
  return Math.min(
    MAX_PROVIDER_RETRY_WAIT_MS,
    Math.max(1, Number(result?.retryAfterMs) || DEFAULT_DEFERRED_RETRY_MS)
  );
}

class EthWalletService {
  static async _recoverKnownCdpTransactions(
    wallet, chain, cdp, scanId, throughBlock, oversizedError, historicalRecoveryTransactions = new Map()
  ) {
    const allCandidates = await EthTransfer.cdpRecoveryCandidates(wallet.id, chain.id, throughBlock);
    // Keep the bounded recovery queue resumable across provider scan IDs. A
    // new finalized head starts a new ordinary scan, but already journaled
    // transaction-scoped evidence must not spend Core quota again.
    const journal = await EthProviderPage.forWalletChain(wallet.id, chain.id);
    const completedRecoveryHashes = new Set(journal
      .filter((page) => page.stream === 'transaction-recovery')
      .map((page) => String(page.request_params?.transaction_hash || '').toLowerCase())
      .filter(Boolean));
    const terminalFailureHashes = new Set(journal
      .filter((page) => page.stream === 'transaction-recovery-failure')
      .filter((page) => {
        const body = typeof page.response_json === 'string'
          ? JSON.parse(page.response_json) : page.response_json;
        return body?.retryable === false;
      })
      .map((page) => String(page.request_params?.transaction_hash || '').toLowerCase())
      .filter(Boolean));
    const recoveredItems = new Map();
    for (const page of journal.filter((entry) => entry.stream === 'transaction-recovery')) {
      const body = typeof page.response_json === 'string'
        ? JSON.parse(page.response_json) : page.response_json;
      const hash = String(body?.item?.hash || '').toLowerCase();
      if (hash && body?.item) recoveredItems.set(hash, body.item);
    }
    const pendingCandidates = allCandidates.filter((candidate) => (
      !completedRecoveryHashes.has(String(candidate.tx_hash).toLowerCase())
      && !terminalFailureHashes.has(String(candidate.tx_hash).toLowerCase())
    ));
    const candidates = pendingCandidates.slice(0, CdpRecoveryProvider.MAX_RECOVERY_CANDIDATES);
    let recovered = 0;
    let terminalFailure = null;
    let budgetFailure = null;
    const traceCache = new Map();
    const recoveryBudget = CdpRecoveryProvider.createBudget();
    for (const candidate of candidates) {
      const candidateHash = String(candidate.tx_hash).toLowerCase();
      let recovery;
      try {
        recovery = await CdpRecoveryProvider.recoverTransaction(cdp, {
          ...candidate,
          hash: candidateHash,
        }, {
          traceCache,
          budget: recoveryBudget,
          onEvidence: async (response, metadata = {}) => {
          await EthProviderPage.record({
            walletId: wallet.id,
            chainId: chain.id,
            provider: 'coinbase-cdp',
            stream: 'transaction-recovery-rpc',
            scanId,
            requestParams: {
              address: wallet.address.toLowerCase(),
              transaction_hash: candidateHash,
              method: response.method,
              params: response.params,
              ...(metadata.blockHash ? { block_hash: metadata.blockHash } : {}),
            },
            responseSha256: response.responseSha256,
            evidenceIdentitySha256: response.evidenceIdentitySha256,
            responseRaw: response.rawText,
            responseJson: response.body,
            itemCount: 0,
            owner: PROVIDER_SCAN_OWNER,
          });
          },
        });
      } catch (error) {
        if (['CDP_QUOTA_EXHAUSTED', 'CDP_RATE_LIMITED', 'CDP_TRANSPORT_ERROR'].includes(error.code)) throw error;
        if (error.code === 'CDP_RECOVERY_BUDGET_EXHAUSTED') {
          budgetFailure = error;
          break;
        }
        const terminal = !['CDP_RECOVERY_NOT_FOUND', 'CDP_RECOVERY_TRACE_UNAVAILABLE'].includes(error.code);
        const wrapped = CdpRecoveryProvider.recoveryError(
          `Base CDP transaction-scoped recovery failed for ${candidateHash}: ${error.message}`,
          error.code === 'CDP_API_ERROR' ? 'CDP_RECOVERY_UNSUPPORTED'
            : terminal ? 'CDP_RECOVERY_FAILED' : error.code,
          { retryAt: error.retryAt || new Date(Date.now() + 60 * 60 * 1000) }
        );
        if (terminal) terminalFailure ||= wrapped;
        const failure = {
          recovery: 'coinbase-cdp-core', transaction_hash: candidateHash,
          status: 'failed', retryable: !terminal, error_code: wrapped.code,
          error_detail: wrapped.message,
        };
        const failureRaw = JSON.stringify(failure);
        const failureParams = {
          address: wallet.address.toLowerCase(), transaction_hash: candidateHash,
          recovery: 'core-rpc-transaction-receipt-block-calltracer',
        };
        await EthProviderPage.record({
          walletId: wallet.id, chainId: chain.id, provider: 'coinbase-cdp',
          stream: 'transaction-recovery-failure', scanId,
          requestParams: failureParams, cursorIn: null, cursorOut: null,
          responseSha256: normalizer.sha256(failureRaw),
          evidenceIdentitySha256: normalizer.sha256(JSON.stringify({ request: failureParams, response: failureRaw })),
          responseRaw: failureRaw, responseJson: failure, itemCount: 0,
          owner: PROVIDER_SCAN_OWNER,
        });
        continue;
      }
      CdpHistoryProvider.assertNoCoordinateConflicts(
        [recovery.item], historicalRecoveryTransactions
      );
      await EthProviderPage.record({
        walletId: wallet.id,
        chainId: chain.id,
        provider: 'coinbase-cdp',
        stream: 'transaction-recovery',
        scanId,
        requestParams: {
          address: wallet.address.toLowerCase(),
          transaction_hash: candidateHash,
          recovery: 'core-rpc-transaction-receipt-block-calltracer',
        },
        responseSha256: recovery.response.responseSha256,
        evidenceIdentitySha256: recovery.response.evidenceIdentitySha256,
        responseRaw: recovery.response.rawText,
        responseJson: recovery.response.body,
        itemCount: 1,
        owner: PROVIDER_SCAN_OWNER,
      });
      recoveredItems.set(candidateHash, recovery.item);
      recovered += 1;
    }
    if (terminalFailure) {
      terminalFailure.recoveredItems = [...recoveredItems.values()];
      return terminalFailure;
    }
    const result = CdpRecoveryProvider.recoveryError(
      `Base CDP address history exceeded the provider response limit (${oversizedError.message}). Core RPC recovery preserved ${recovered} new transaction-scoped response(s) from a bounded ${candidates.length}/${pendingCandidates.length} pending queue (${completedRecoveryHashes.size} already journaled; ${allCandidates.length} known candidates total), but CDP exposes no documented address-history enumeration fallback to prove the failed page contained no additional transaction.`,
      budgetFailure ? 'CDP_RECOVERY_BUDGET_EXHAUSTED' : 'CDP_ADDRESS_ENUMERATION_UNPROVEN',
      { retryAt: new Date(Date.now() + 60 * 60 * 1000) }
    );
    result.recoveredItems = [...recoveredItems.values()];
    if (budgetFailure) result.message = `${result.message}; ${budgetFailure.message}`;
    return result;
  }

  static async _syncCdpWalletChain(wallet, chain) {
    const nativeCreditConfig = chain.auditNativeCredits || chain.stateSyncDeposits || null;
    const activeSpecs = [
      ...FEED_SPECS.filter((spec) => !spec.chainFeed),
      ...(nativeCreditConfig ? [STATE_SYNC_SPEC] : []),
    ];
    const provider = providerName(chain);
    let state = await EthWalletChain.ensure(wallet.id, chain.id, Number(chain.ingestVersion || 0));
    if (Number(state?.ingest_version || 0) < Number(chain.ingestVersion || 0)) {
      state = await EthWalletChain.resetForIngestVersion(
        wallet.id, chain.id, Number(chain.ingestVersion || 0)
      );
    }
    const resumeFrom = (cursor) => Math.max(0, Number(cursor ?? 0) - REORG_OVERLAP_BLOCKS);
    const resume = {
      normal: resumeFrom(state?.last_block_normal),
      internal: resumeFrom(state?.last_block_internal),
      token: resumeFrom(state?.last_block_token),
      nft: resumeFrom(state?.last_block_nft),
      nft1155: resumeFrom(state?.last_block_1155),
      statesync: resumeFrom(state?.last_block_statesync),
    };
    let scanId = null;
    const retryError = async (error, { scanStarted = false, persist = true } = {}) => {
      let canPersist = persist;
      const status = coverageFailureStatus(error);
      const retryAt = status === 'deferred' ? retryAfterAt(error) : null;
      if (canPersist) {
        const scanFence = scanStarted
          ? { scanId, owner: PROVIDER_SCAN_OWNER }
          : {};
        try {
          await EthFeedCoverage.recordAttempts(wallet.id, chain.id, [
            ...activeSpecs.map((spec) => ({
              feed: spec.key,
              provider,
              status,
              attemptedFromBlock: resume[spec.key],
              errorCode: error.code || 'CDP_SYNC_FAILED',
              errorMessage: error.message,
              retryAfterAt: retryAt,
            })),
          ], scanFence);
          const supportedState = await EthWalletChain.setUnsupportedFeeds(
            wallet.id, chain.id, [], scanFence
          );
          if (scanStarted && !supportedState) throw Object.assign(
            new Error('Base CDP scan lease was lost before failure metadata was written.'),
            { code: 'CDP_SCAN_STALE' }
          );
          const errorState = await EthWalletChain.setError(
            wallet.id,
            chain.id,
            status === 'deferred' ? 'SYNC_DEFERRED' : 'FEED_SKIPPED',
            `Base CDP history ${status}: ${error.message}`,
            scanFence
          );
          if (scanStarted && !errorState) throw Object.assign(
            new Error('Base CDP scan lease was lost before failure status was written.'),
            { code: 'CDP_SCAN_STALE' }
          );
          const timeState = await EthWalletChain.updateSyncTime(wallet.id, chain.id, scanFence);
          if (scanStarted && !timeState) throw Object.assign(
            new Error('Base CDP scan lease was lost before failure timestamp was written.'),
            { code: 'CDP_SCAN_STALE' }
          );
          if (scanStarted) {
            const failedState = await EthWalletChain.failProviderScan(
              wallet.id, chain.id, status === 'deferred' ? 'deferred' : 'failed',
              scanId, PROVIDER_SCAN_OWNER
            );
            // A stale worker must not overwrite the current worker's durable
            // status/error slot after the database lease has moved on.
            canPersist = failedState != null;
          }
        } catch {
          canPersist = false;
        }
      }
      return {
        chainId: chain.id,
        chainName: chain.name,
        inserted: 0,
        skippedFeeds: activeSpecs.map((spec) => spec.key),
        failedFeeds: status === 'failed' ? activeSpecs.map((spec) => spec.key) : [],
        deferredFeeds: status === 'deferred' ? activeSpecs.map((spec) => spec.key) : [],
        unsupportedFeeds: [],
        unavailable: false,
        rateLimited: [
          'CDP_RATE_LIMITED', 'RPC_RATE_LIMITED', 'EXPLORER_RATE_LIMITED',
        ].includes(error.code),
        retryAfterMs: retryAt ? Math.max(1, retryAt.getTime() - Date.now()) : null,
        retryAfterAt: retryAt?.toISOString() || null,
        fetched: Object.fromEntries(FEED_SPECS.map((spec) => [spec.key, 0])),
      };
    };

    const cdpKey = await SecretsService.getUserKey(wallet.user_id, 'cdp');
    if (!cdpKey) {
      return retryError(Object.assign(
        new Error('Configure a separate Coinbase CDP Client API key in Settings -> API Keys to sync Base.'),
        { code: 'CDP_NOT_CONFIGURED' }
      ));
    }

    let boundary;
    try {
      // The indexer enumerates history; consensus RPC supplies the immutable
      // finalized boundary used by cursors, reorg overlap and reconciliation.
      boundary = await new RpcClient(chain.id).finalizedBoundary();
    } catch (error) {
      return retryError(error);
    }

    const previousOrder = state?.provider_scan_order || 'unknown';
    const incrementalStop = state?.provider_scan_status === 'complete'
      && previousOrder === 'newest_first'
      && Math.min(...activeSpecs.map((spec) => resume[spec.key])) > 0;
    state = await EthWalletChain.startProviderScan(
      wallet.id, chain.id, boundary.number, boundary.hash, PROVIDER_SCAN_OWNER
    );
    if (!state) {
      return retryError(Object.assign(
        new Error('Another Base CDP sync currently owns this wallet-chain scan lease.'),
        { code: 'CDP_SCAN_BUSY' }
      ), { persist: false });
    }
    scanId = state.provider_scan_id;
    const cdp = new CdpClient(cdpKey, {
      onFailedAttempt: async (attempt) => {
        // Failed CDP responses are evidence too. Persist only the provider's
        // already-redacted raw body; transport failures have no body to
        // retain, but their durable feed status still records the failure.
        if (typeof attempt.responseRaw !== 'string') return;
        try {
          await EthProviderPage.record({
            walletId: wallet.id,
            chainId: chain.id,
            provider: 'coinbase-cdp',
            stream: attempt.endpoint === 'transaction-recovery'
              ? 'transaction-recovery-failure' : 'address-history-failure',
            scanId,
            cursorIn: state.provider_cursor || null,
            requestParams: attempt.requestParams || {},
            responseSha256: attempt.responseSha256,
            evidenceIdentitySha256: attempt.evidenceIdentitySha256,
            responseRaw: attempt.responseRaw,
            responseJson: attempt.responseJson || {},
            itemCount: 0,
            owner: PROVIDER_SCAN_OWNER,
          });
        } catch {
          const error = new Error('Base CDP provider failure evidence could not be durably retained');
          error.code = 'CDP_FAILURE_EVIDENCE_UNJOURNALED';
          throw error;
        }
      },
    });
    const feeds = { normal: [], internal: [], token: [], nft: [], nft1155: [], statesync: [] };
    const seenCdpTransactions = new Map();
    const historicalCdpTransactions = new Map();
    const historicalRecoveryTransactions = new Map();
    try {
      const journal = await EthProviderPage.forWalletChain(wallet.id, chain.id);
      for (const page of journal.filter((entry) => entry.stream === 'transaction-recovery')) {
        const body = typeof page.response_json === 'string'
          ? JSON.parse(page.response_json) : page.response_json;
        if (body?.item) CdpHistoryProvider.assertNoCoordinateConflicts(
          [body.item], historicalRecoveryTransactions
        );
      }
      for (const page of journal.filter((entry) => entry.stream === 'address-history')) {
        const body = typeof page.response_json === 'string'
          ? JSON.parse(page.response_json) : page.response_json;
        CdpHistoryProvider.assertNoCoordinateConflicts(
          cdpAddressTransactionItems(body), historicalRecoveryTransactions
        );
        CdpHistoryProvider.assertNoConflicts(
          cdpAddressTransactionItems(body), historicalCdpTransactions
        );
      }
    } catch (error) {
      return retryError(error, { scanStarted: true });
    }
    let completePagination = false;
    let order = previousOrder;
    let previousBlock = null;
    let orderDirection = null;
    let stoppedAtOverlap = false;

    const observeBlocks = (blocks) => {
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
    };

    const addPage = (items) => {
      const uniqueItems = CdpHistoryProvider.dedupeItems(items, seenCdpTransactions);
      const normalized = CdpHistoryProvider.normalizePage(wallet.address, uniqueItems, {
        nativeCredit: nativeCreditConfig,
      });
      for (const [feed, rows] of Object.entries(normalized.feeds)) {
        feeds[feed].push(...rows.filter((row) => Number(row.blockNumber) <= boundary.number));
      }
      observeBlocks(uniqueItems.map(cdpItemBlockNumber)
        .filter((block) => block != null && block <= boundary.number));
    };

    try {
      // The raw page is durable before its cursor advances. Rehydrate every
      // page through the last proven cursor before continuing a resumable
      // scan; a process death or later provider error must not resume with an
      // empty in-memory feed and delete the already-journaled prefix.
      if (state.provider_cursor && scanId) {
        const journal = await EthProviderPage.forScan(wallet.id, chain.id, scanId);
        const addressHistoryJournal = journal.filter((page) => page.stream === 'address-history');
        const checkpoint = addressHistoryJournal.findIndex((page) => (
          page.cursor_out != null && String(page.cursor_out) === String(state.provider_cursor)
        ));
        if (checkpoint < 0) {
          const error = new Error('Coinbase CDP checkpoint has no matching raw page; Base sync is frozen safely.');
          error.code = 'CDP_CHECKPOINT_MISSING';
          throw error;
        }
        for (const page of addressHistoryJournal.slice(0, checkpoint + 1)) {
          const body = typeof page.response_json === 'string'
            ? JSON.parse(page.response_json) : page.response_json;
          addPage(cdpAddressTransactionItems(body));
        }
      }
      for await (const page of cdp.addressTransactionPages(wallet.address, {
        cursor: state.provider_cursor || null,
        pageSize: CDP_HISTORY_PAGE_SIZE,
      })) {
        const blocks = page.items.map(cdpItemBlockNumber)
          .filter((block) => block != null && block <= boundary.number);
        CdpHistoryProvider.assertNoConflicts(page.items, historicalCdpTransactions);
        await EthProviderPage.record({
          walletId: wallet.id, chainId: chain.id, provider: 'coinbase-cdp',
          stream: 'address-history', scanId, cursorIn: page.cursorIn, cursorOut: page.cursorOut,
          requestParams: {
            address: wallet.address.toLowerCase(), page_size: page.pageSize, page_token: page.cursorIn,
          },
          responseSha256: page.responseSha256, evidenceIdentitySha256: page.evidenceIdentitySha256,
          responseRaw: page.rawText,
          responseJson: page.body, itemCount: page.items.length, owner: PROVIDER_SCAN_OWNER,
        });
        addPage(page.items);
        const checkpointed = await EthWalletChain.checkpointProviderScan(
          wallet.id, chain.id, scanId, page.cursorOut, PROVIDER_SCAN_OWNER
        );
        if (checkpointed == null) {
          const error = new Error('Base CDP scan lease was lost before its cursor checkpoint.');
          error.code = 'CDP_SCAN_STALE';
          throw error;
        }
        state = { ...state, provider_cursor: page.cursorOut };
        if (incrementalStop && orderDirection === 'newest_first'
            && blocks.length && Math.min(...blocks) <= Math.min(...Object.values(resume))) {
          stoppedAtOverlap = true;
          break;
        }
      }
      if (chain.opStackDeposits) {
      const rpc = new RpcClient(chain.id);
        for (const raw of feeds.normal.filter((row) => row.opStackType === '0x7e')) {
          const { transaction } = await rpc.transactionAndReceipt(raw.hash);
          if (String(transaction.type).toLowerCase() !== '0x7e'
              || !/^0x[0-9a-f]{64}$/i.test(String(transaction.sourceHash || ''))
              || !/^0x[0-9a-f]+$/i.test(String(transaction.mint || ''))
              || !/^0x[0-9a-f]+$/i.test(String(transaction.value || ''))) {
            const error = new Error(`OP Stack deposit ${raw.hash} is missing sourceHash, mint, or value`);
            error.code = 'RPC_INVALID_RESPONSE';
            throw error;
          }
          const rpcValue = BigInt(transaction.value).toString();
          const rpcSourceHash = String(transaction.sourceHash).toLowerCase();
          const rpcMint = BigInt(transaction.mint).toString();
          const cdpFrom = String(raw.from || '').toLowerCase();
          const cdpTo = String(raw.to || '').toLowerCase();
          if (rpcValue !== String(raw.value)
              || (raw.opStackSourceHash && rpcSourceHash !== String(raw.opStackSourceHash).toLowerCase())
              || (raw.opStackMintWei != null && rpcMint !== String(raw.opStackMintWei))
              || (cdpFrom && cdpFrom !== String(transaction.from || '').toLowerCase())
              || (cdpTo && cdpTo !== String(transaction.to || '').toLowerCase())) {
            const error = new Error(`OP Stack RPC value disagrees with CDP history for ${raw.hash}`);
            error.code = 'RPC_IDENTITY_MISMATCH';
            throw error;
          }
          raw.from = transaction.from;
          raw.to = transaction.to;
          raw.value = rpcValue;
          raw.opStackSourceHash = rpcSourceHash;
          raw.opStackMintWei = rpcMint;
        }
      }
      completePagination = !stoppedAtOverlap;
      if (orderDirection === 'unknown') order = 'unknown';
      else if (order === 'unknown' && orderDirection) order = orderDirection;
      else if (orderDirection && order !== orderDirection) order = 'unknown';
    } catch (error) {
      let effectiveError = error;
      if (error.code === 'CDP_RESPONSE_TOO_LARGE') {
        try {
          effectiveError = await this._recoverKnownCdpTransactions(
            wallet, chain, cdp, scanId, boundary.number, error,
            historicalRecoveryTransactions
          );
          const recoveredItems = Array.isArray(effectiveError?.recoveredItems)
            ? effectiveError.recoveredItems : [];
          if (recoveredItems.length) {
            const normalized = CdpHistoryProvider.normalizePage(wallet.address, recoveredItems, {
              nativeCredit: nativeCreditConfig,
            });
            const recoveredRows = this.normalizeFeeds(wallet.address, normalized.feeds, {
              preserveZeroValue: true,
              stateSyncContract: nativeCreditConfig?.contract || null,
              opStackDeposits: chain.opStackDeposits || null,
            })
              .map((row) => ({ ...row, wallet_id: wallet.id, chain_id: chain.id }));
            // Recovery is append-only: the failed address-history page has not
            // proven a replacement window, so never delete existing ordinary
            // rows here. The normal derived pipeline still runs after this
            // deferred result and can explain every recovered effect.
            await EthTransfer.bulkInsert(recoveredRows);
            effectiveError.recoveredRows = recoveredRows.length;
          }
        } catch (recoveryError) {
          effectiveError = recoveryError;
        }
      }
      return retryError(effectiveError, { scanStarted: true });
    }

    // Re-derive the ordinary feeds only after the raw provider walk has
    // completed or crossed a proven newest-first overlap. A failed page never
    // reaches this delete phase, so omission cannot erase existing evidence.
    let rows;
    try {
      rows = this.normalizeFeeds(wallet.address, feeds, {
        preserveZeroValue: true,
        stateSyncContract: nativeCreditConfig?.contract || null,
        opStackDeposits: chain.opStackDeposits || null,
      })
        .map((row) => ({ ...row, wallet_id: wallet.id, chain_id: chain.id }))
        .filter((row) => {
          const feed = row.transfer_type === 'gas' || row.transfer_type === 'native'
            ? 'normal' : row.transfer_type === 'internal' ? 'internal'
              : row.transfer_type === 'token' ? 'token'
                : row.transfer_type === 'nft' ? 'nft' : row.transfer_type === 'nft1155' ? 'nft1155' : null;
          const effectiveFeed = feed === 'internal' && nativeCreditConfig
            && row.from_address === nativeCreditConfig.contract.toLowerCase()
            ? 'statesync' : feed;
          return effectiveFeed && row.block_number >= resume[effectiveFeed];
        });
    } catch (error) {
      return retryError(error, { scanStarted: true });
    }
    const replacements = activeSpecs.map((spec) => {
      const deleteOpts = {};
      if (spec.chainFeed) {
        deleteOpts.fromAddress = nativeCreditConfig.contract;
      } else if (spec.key === 'internal' && nativeCreditConfig) {
        deleteOpts.excludeFromAddress = nativeCreditConfig.contract;
      }
      return { types: spec.types, block: resume[spec.key], options: deleteOpts };
    });
    const inserted = await EthTransfer.replaceFeeds(
      wallet.id, chain.id, replacements, rows,
      { scanId, owner: PROVIDER_SCAN_OWNER }
    );
    const throughBlock = boundary.number;
    await EthFeedCoverage.recordAttempts(wallet.id, chain.id, activeSpecs.map((spec) => ({
        feed: spec.key,
        provider,
        status: 'complete',
        coveredFromBlock: 0,
        coveredThroughBlock: throughBlock,
        indexedHead: throughBlock,
        attemptedFromBlock: resume[spec.key],
      })), { scanId, owner: PROVIDER_SCAN_OWNER });
    const cursorState = await EthWalletChain.updateCursors(wallet.id, chain.id, {
      normal: throughBlock, internal: throughBlock, token: throughBlock,
      nft: throughBlock, nft1155: throughBlock,
      statesync: nativeCreditConfig ? throughBlock : null,
    }, { scanId, owner: PROVIDER_SCAN_OWNER });
    if (cursorState == null) {
      const error = new Error('Base CDP scan lease was lost before cursor completion.');
      error.code = 'CDP_SCAN_STALE';
      throw error;
    }
    const supportedState = await EthWalletChain.setUnsupportedFeeds(
      wallet.id, chain.id, [], { scanId, owner: PROVIDER_SCAN_OWNER }
    );
    if (supportedState == null) {
      const error = new Error('Base CDP scan lease was lost before feed status completion.');
      error.code = 'CDP_SCAN_STALE';
      throw error;
    }
    const orderState = await EthWalletChain.setProviderScanOrder(
      wallet.id, chain.id, order, scanId, PROVIDER_SCAN_OWNER
    );
    if (orderState == null) {
      const error = new Error('Base CDP scan lease was lost before order completion.');
      error.code = 'CDP_SCAN_STALE';
      throw error;
    }
    const finished = await EthWalletChain.finishProviderScan(
      wallet.id, chain.id, scanId, PROVIDER_SCAN_OWNER
    );
    if (finished == null) {
      const error = new Error('Base CDP scan lease was lost before finalization.');
      error.code = 'CDP_SCAN_STALE';
      throw error;
    }
    const completedFence = { scanId, completed: true };
    await EthWalletChain.clearError(wallet.id, chain.id, completedFence);
    await EthWalletChain.updateSyncTime(wallet.id, chain.id, completedFence);
    return {
      chainId: chain.id,
      chainName: chain.name,
      inserted,
      skippedFeeds: [],
      failedFeeds: [],
      deferredFeeds: [],
      unsupportedFeeds: [],
      unavailable: false,
      rateLimited: false,
      retryAfterMs: null,
      retryAfterAt: null,
      fetched: Object.fromEntries(FEED_SPECS.map((spec) => [spec.key, feeds[spec.key].length])),
      cdp: { scanId, pagesComplete: completePagination, incremental: incrementalStop, order },
    };
  }

  static async _syncZkSyncLiteWalletChain(wallet, chain) {
    const ingestVersion = Number(chain.ingestVersion || 0);
    let state = await EthWalletChain.ensure(wallet.id, chain.id, ingestVersion);
    if (Number(state?.ingest_version || 0) < ingestVersion) {
      state = await EthWalletChain.resetForIngestVersion(wallet.id, chain.id, ingestVersion);
    }
    const resume = Math.max(
      0,
      Number(state?.last_block_normal ?? 0) - REORG_OVERLAP_BLOCKS
    );
    let history;
    let normalized;
    try {
      const [account, tokens] = await Promise.all([
        ZkSyncLiteService.getAccount(wallet.address),
        ZkSyncLiteService.getTokens(),
      ]);
      history = await ZkSyncLiteService.fetchHistory(wallet.address, resume);
      normalized = ZkSyncLiteService.normalizeTransactions(
        wallet.address,
        history.transactions,
        tokens,
        { accountId: account.committed.accountId }
      );
    } catch (error) {
      const failureStatus = coverageFailureStatus(error);
      const retryAt = failureStatus === 'deferred' ? retryAfterAt(error) : null;
      await EthFeedCoverage.recordAttempts(wallet.id, chain.id, FEED_SPECS.map((spec) => (
        spec.key === 'normal'
          ? {
            feed: spec.key,
            cursorKind: 'archive_serial',
            provider: providerName(chain),
            status: failureStatus,
            attemptedFromBlock: resume,
            errorCode: error.code || 'ZKSYNC_LITE_ARCHIVE_ERROR',
            errorMessage: error.message,
            retryAfterAt: retryAt,
          }
          : {
            feed: spec.key,
            cursorKind: 'archive_serial',
            provider: providerName(chain),
            status: 'not_applicable',
          }
      )));
      throw error;
    }

    const rows = normalized.rows.map((row) => ({
      ...row,
      wallet_id: wallet.id,
      chain_id: chain.id,
    }));

    // Lite's archive is one authoritative operation stream rather than five
    // Etherscan-shaped feeds. It owns all supported transfer types under the
    // normal cursor, so overlap replacement remains atomic and resumable.
    await EthTransfer.deleteFromBlock(
      wallet.id,
      chain.id,
      ['native', 'internal', 'token', 'gas', 'nft', 'nft1155'],
      resume
    );
    const inserted = await EthTransfer.bulkInsert(rows);
    const historyDates = history.transactions
      .map((row) => new Date(row.createdAt || Number(row.timeStamp) * 1000))
      .filter((date) => !Number.isNaN(date.getTime()));
    await EthFeedCoverage.recordAttempts(wallet.id, chain.id, FEED_SPECS.map((spec) => (
      spec.key === 'normal'
        ? {
          feed: spec.key,
          cursorKind: 'archive_serial',
          provider: providerName(chain),
          status: 'complete',
          coveredFromBlock: 0,
          coveredThroughBlock: history.scannedThroughBlock,
          coveredFromAt: historyDates.length
            ? new Date(Math.min(...historyDates.map((date) => date.getTime())))
            : null,
          coveredThroughAt: historyDates.length
            ? new Date(Math.max(...historyDates.map((date) => date.getTime())))
            : null,
          indexedHead: history.scannedThroughBlock,
          attemptedFromBlock: resume,
        }
        : {
          feed: spec.key,
          cursorKind: 'archive_serial',
          provider: providerName(chain),
          status: 'not_applicable',
        }
    )));
    await EthWalletChain.updateCursors(wallet.id, chain.id, {
      normal: history.scannedThroughBlock,
      internal: null,
      token: null,
      nft: null,
      nft1155: null,
      statesync: null,
    });
    await EthWalletChain.setUnsupportedFeeds(wallet.id, chain.id, normalized.limitations);
    if (normalized.limitations.length) {
      await EthWalletChain.setError(
        wallet.id,
        chain.id,
        'FEED_UNSUPPORTED',
        'Some zkSync Lite operations omit an amount or asset id; those transactions are retained with an explicit limitation'
      );
    } else {
      await EthWalletChain.clearError(wallet.id, chain.id);
    }
    await EthWalletChain.updateSyncTime(wallet.id, chain.id);

    return {
      chainId: chain.id,
      chainName: chain.name,
      inserted,
      skippedFeeds: [],
      failedFeeds: [],
      deferredFeeds: [],
      unsupportedFeeds: normalized.limitations,
      unavailable: false,
      fetched: {
        normal: history.transactions.length,
        internal: 0,
        token: 0,
        nft: 0,
        nft1155: 0,
        statesync: 0,
      },
    };
  }

  // Decides whether a txlist row is a mis-served classic-era Arbitrum bridge
  // deposit (config/chains.js classicRetryableDeposits), and if so, who the
  // deposit credited. Returns the calldata destination address, or null when
  // the row is not one -- every test below is a fail-safe: an off-shape row
  // simply ingests through the normal path, where rule 8 flags it, rather than
  // being guessed into a credit.
  //
  // The shape being matched: Etherscan serves a MIGRATED pre-Nitro L1->L2 ETH
  // deposit as an outbound call from the wallet to the ArbRetryableTx
  // precompile, methodId createRetryableTicket, with gasUsed and gasPrice both
  // zero (the wallet signed nothing on this chain and paid no L2 gas). The
  // money actually moved the OTHER way: the deposit credited
  // createRetryableTicket's first argument, `destAddr` -- the last 20 bytes of
  // calldata word 0.
  static classicRetryableDestination(raw, config) {
    if (!config) return null;
    if ((raw.to || '').toLowerCase() !== config.arbRetryableTx) return null;
    // Parse once and require an actual integer in the classic range. '' and
    // null coerce to 0 through Number(), which would pass the cutover gate and
    // store block_number 0 -- below every future resume window, so the row
    // could never be re-derived by its own feed's delete window.
    const block = raw.blockNumber == null || raw.blockNumber === '' ? NaN : Number(raw.blockNumber);
    if (!Number.isInteger(block) || block < 0 || block > config.lastClassicBlock) return null;
    if ((raw.methodId || '').toLowerCase() !== config.depositMethodId) return null;
    // The zero gas fields are part of the signature: a real (post-migration
    // shaped) call that spent gas is not this row, and reshaping it would
    // delete a genuine fee from the ledger.
    if (raw.gasUsed !== '0' || raw.gasPrice !== '0') return null;
    // A reverted ticket credited nothing; the normal path already handles it.
    // Success must be affirmative: Etherscan writes isError as a string, so
    // the NUMBER 1 (or any other unrecognized shape) slips past a strict '1'
    // comparison and must decline rather than reshape.
    if (String(raw.isError ?? '0') !== '0') return null;
    const input = typeof raw.input === 'string' ? raw.input.toLowerCase() : '';
    // Selector (4 bytes) + at least word 0. An ABI-encoded address is 12 zero
    // bytes then the 20 address bytes; anything else is off-shape calldata and
    // off-shape means "do not guess".
    if (!/^0x[0-9a-f]+$/.test(input) || input.length < 2 + 8 + 64) return null;
    const word0 = input.slice(10, 74);
    if (!/^0{24}[0-9a-f]{40}$/.test(word0)) return null;
    return `0x${word0.slice(24)}`;
  }

  // fetchNormalTxs enriches type-0x7e rows from JSON-RPC because Blockscout's
  // legacy txlist omits sourceHash and mint. Require every authoritative field
  // here: mint and value are independent balance effects, and mint survives a
  // failed execution, so inferring either from the legacy row would corrupt the
  // exact balance audit.
  static opStackDepositEffects(raw, config) {
    if (!config?.creditSource) return null;
    if (raw.opStackType !== '0x7e') return null;
    if (!/^0x[0-9a-f]{64}$/i.test(String(raw.opStackSourceHash || ''))) return null;
    if (!/^\d+$/.test(String(raw.opStackMintWei ?? ''))) return null;
    if (!/^\d+$/.test(String(raw.value ?? ''))) return null;
    if (raw.isError !== '0' && raw.isError !== '1') return null;
    const from = String(raw.from || '').toLowerCase();
    const to = raw.to == null || raw.to === '' ? null : String(raw.to).toLowerCase();
    if (!ADDRESS_RE.test(from) || (to !== null && !ADDRESS_RE.test(to))) return null;
    return {
      from,
      to,
      mint: BigInt(raw.opStackMintWei),
      value: BigInt(raw.value),
      succeeded: raw.isError === '0',
    };
  }

  // Pure: raw Etherscan feed rows -> eth_transfers rows (without wallet_id).
  // Gas rows are synthesized here, one per normal tx sent by the wallet --
  // including failed txs, which still burn gas. Zero-value normal/internal
  // rows (contract calls, approvals) are dropped as noise; their economic
  // content is the gas row and/or the token row from the token feed.
  static normalizeFeeds(walletAddress, { normal = [], internal = [], token = [], nft = [], nft1155 = [], statesync = [] } = {}, {
    stateSyncContract = null, classicDeposits = null, opStackDeposits = null, preserveZeroValue = false,
  } = {}) {
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
      token_standard: null,
      token_id: null,
      source_log_index: /^\d+$/.test(String(raw.logIndex ?? ''))
        ? Number(raw.logIndex) : null,
      source_trace_address: raw.traceAddress ?? (/^\d+(?:_\d+)*$/.test(String(raw.traceId ?? ''))
        ? String(raw.traceId).split('_').map(Number) : null),
      audit_effect_key: null,
      audit_observation_id: null,
      is_error: raw.isError === '1',
      // The transaction's own status, distinct from this leg's. Stamped only on
      // the gas leg below; NULL everywhere else. See the tx_is_error note in
      // 038 for why the gas leg cannot just use is_error.
      tx_is_error: null,
      // Only the top-level tx has calldata, so at most one leg names its
      // method: the native leg when ETH moved, else the gas leg (stamped in
      // the txlist loop below). Internal traces and token logs stay NULL.
      method_id: null,
      method_name: null,
    });

    // Shared by both NFT feeds. Neither reports isError -- an NFT log only
    // exists if the transfer succeeded. from = 0x0 (mint) and to = 0x0 (burn)
    // are deliberately preserved as-is: they are real, meaningful endpoints,
    // and the activity layer needs them to tell a mint from a purchase.
    const nftRow = (raw, transferType, tokenStandard, valueUnits) => ({
      ...baseRow(raw, transferType),
      // Units, not wei. See 033_nft_transfers.sql.
      value_wei: valueUnits,
      token_contract: (raw.contractAddress || '').toLowerCase() || null,
      // Spam contracts use symbols as ad space; VARCHAR(64) is a hard limit
      // and one oversized symbol would abort the whole insert chunk.
      token_symbol: raw.tokenSymbol ? String(raw.tokenSymbol).slice(0, 64) : null,
      // Whole units. NULL would default to 18 in the shared unit helpers.
      token_decimals: 0,
      token_standard: tokenStandard,
      // uint256, past Number precision -- keep it a string end to end. A
      // malformed id must not reach NUMERIC(78,0) and abort the chunk.
      token_id: raw.tokenID != null && /^\d+$/.test(String(raw.tokenID)) ? String(raw.tokenID) : null,
      is_error: raw.isError === '1',
    });

    for (const raw of normal) {
      // Free at ingest: txlist already carries both. functionName is a full
      // signature ("swapExactETHForTokens(uint256,address[],...)") when
      // Etherscan can decode the contract and empty otherwise, which is what
      // leaves work for the decode pass.
      const methodId = MethodSignatureService.normalizeSelector(raw.methodId);
      const methodName = MethodSignatureService.normalizeMethodName(raw.functionName);

      // A classic-era Arbitrum bridge deposit served BACKWARDS (config/chains.js
      // classicRetryableDeposits): reshape it into the ONE inbound native credit
      // it actually was -- from the precompile, to the wallet, full value, real
      // hash, and NO gas leg (the zero gas fields are part of the matched shape;
      // the wallet paid nothing on this chain). Only when the calldata says this
      // wallet is the deposit's destination: a ticket that credited someone else
      // stays untouched and flags through rule 8 -- flag, never guess.
      //
      // transfer_type is 'native', NOT 'internal', deliberately: the row comes
      // from txlist, and the normal feed's delete window covers ['native','gas']
      // -- so the reshaped credit is cleared and re-derived by exactly the feed
      // that produced it. Stored as 'internal' it would sit inside the internal
      // feed's delete window while never being in the internal feed's fetch, and
      // the first internal resync over its block would delete it forever.
      //
      // FORWARD-ONLY like 034's method capture and 038's tx_is_error: an
      // existing wallet's normal cursor already sits past every classic block,
      // so stored backwards rows stay as ingested. Healing them is remove +
      // re-add the wallet, which restarts ingest from block 0.
      const classicDest = classicDeposits ? this.classicRetryableDestination(raw, classicDeposits) : null;
      if (classicDest === wallet && raw.value !== '0') {
        rows.push({
          ...baseRow(raw, 'native'),
          from_address: classicDeposits.arbRetryableTx,
          to_address: wallet,
          value_wei: raw.value,
          method_id: methodId,
          method_name: methodName,
        });
        continue;
      }

      // An OP Stack deposit has two independent effects: `mint` credits from
      // the protocol to `from` unconditionally, then a successful execution
      // moves `value` from `from` to `to`. Store both effects that touch this
      // wallet. A self-execution cancels itself and needs no second row; the
      // mint credit remains. Deposit transactions charge no L2 gas.
      const opStack = opStackDeposits
        ? this.opStackDepositEffects(raw, opStackDeposits)
        : null;
      if (opStackDeposits && raw.opStackType === '0x7e' && !opStack) {
        throw new Error(`Enriched OP Stack deposit ${raw.hash || '(unknown hash)'} is malformed`);
      }
      if (opStack) {
        if (opStack.from === wallet && opStack.mint > 0n) {
          rows.push({
            ...baseRow(raw, 'native'),
            from_address: opStackDeposits.creditSource,
            to_address: wallet,
            value_wei: opStack.mint.toString(),
            // Mint is unconditional and succeeded even when the execution
            // status is failed; native balance math must keep this credit.
            is_error: false,
          });
        }
        if (opStack.succeeded && opStack.value > 0n
            && !(opStack.from === wallet && opStack.to === wallet)
            && (opStack.from === wallet || opStack.to === wallet)) {
          rows.push({
            ...baseRow(raw, 'native'),
            from_address: opStack.from,
            to_address: opStack.to,
            value_wei: opStack.value.toString(),
          });
        }
        continue;
      }

      const hasNativeLeg = raw.value !== '0';
      if (hasNativeLeg || preserveZeroValue) {
        rows.push({
          ...baseRow(raw, 'native'),
          value_wei: raw.value,
          method_id: hasNativeLeg || (raw.from || '').toLowerCase() !== wallet ? methodId : null,
          method_name: hasNativeLeg || (raw.from || '').toLowerCase() !== wallet ? methodName : null,
        });
      }
      if ((raw.from || '').toLowerCase() === wallet) {
        // Blockscout v2 exposes the exact OP Stack fee, including the L1-data
        // component that gasUsed * gasPrice omits. Other providers retain the
        // original multiplication contract.
        const fee = raw.feeWei != null
          ? BigInt(raw.feeWei)
          : BigInt(raw.gasUsed || 0) * BigInt(raw.gasPrice || 0);
        rows.push({
          ...baseRow(raw, 'gas'),
          value_wei: fee.toString(),
          is_error: false,
          // is_error stays FALSE (the fee did not fail) and consumers depend on
          // that; the transaction's status rides alongside it. A reverted
          // zero-value call emits nothing BUT this leg, so without it the most
          // common revert shape on chain is invisible to the activity layer.
          tx_is_error: raw.isError === '1',
          // Zero-value calls -- every approve, token->token swap, ERC-20
          // transfer -- emit no native leg, and they are the majority of the
          // "contract interaction" population this feature names. The gas leg
          // exists exactly once per tx the wallet SENT, which is exactly when
          // the calldata originated here, so it carries the method instead.
          // Invariant kept: at most one leg per tx has a method. Reverted
          // zero-value calls get NO method: the gas leg keeps is_error false
          // (the fee itself did not fail), so a method stamped here would
          // render a reverted approve as a successful one. A reverted
          // value-bearing call keeps its method on the native leg, which
          // does carry is_error.
          method_id: hasNativeLeg || raw.isError === '1' ? null : methodId,
          method_name: hasNativeLeg || raw.isError === '1' ? null : methodName,
        });
      }
    }

    for (const raw of internal) {
      if (raw.value === '0' && !preserveZeroValue) continue;
      // A trace FROM the precompile belongs to the STATE-SYNC feed. Today
      // txlistinternal does not serve such traces (that absence is the sixth
      // feed's whole premise), but the internal feed's delete already excludes
      // the precompile -- so if Etherscan ever starts returning them, an
      // unfiltered insert here would double-count every deposit under a second
      // ordinal its own delete can never remove. Insert and delete must stay
      // symmetric, and this filter is also what keeps the two feeds' ordinal
      // namespaces from ever colliding on a shared tx hash.
      if (stateSyncContract && (raw.from || '').toLowerCase() === stateSyncContract) continue;
      // The symmetric filter for the classic-deposit precompile (chains.js
      // classicRetryableDeposits): the reshape stores that credit as a NATIVE
      // leg from the precompile, owned by the normal feed's delete window.
      // txlistinternal serves no trace from the precompile today, but if
      // Etherscan ever starts, an unfiltered insert here would double-count
      // every reshaped deposit -- native and internal are the same inbound arm
      // of the balance derivation, in ordinal namespaces no UNIQUE ties
      // together.
      if (classicDeposits && (raw.from || '').toLowerCase() === classicDeposits.arbRetryableTx) continue;
      rows.push({ ...baseRow(raw, 'internal'), value_wei: raw.value });
    }

    // State-sync native deposits (#76). EtherscanService.fetchStateSyncDeposits
    // has already shaped these getLogs rows exactly like an internal trace
    // ({hash, blockNumber, timeStamp, from = the precompile, to = the wallet,
    // value}), so they ingest as transfer_type='internal' through the identical
    // path -- which is what lets nativeBalanceDeltas count them and every derived
    // reader treat the credit like any other inbound native movement. The
    // ordinal map keys on (transfer_type, tx_hash), which the two feeds SHARE --
    // the internal loop above filters out precompile-from traces precisely so
    // they can never emit rows for the same hash and their ordinals stay
    // independent.
    for (const raw of statesync) {
      if (raw.value === '0') continue;
      rows.push({ ...baseRow(raw, 'internal'), value_wei: raw.value });
    }

    for (const raw of token) {
      rows.push({
        ...baseRow(raw, 'token'),
        value_wei: raw.value,
        token_contract: (raw.contractAddress || '').toLowerCase() || null,
        token_symbol: raw.tokenSymbol ? String(raw.tokenSymbol).slice(0, 64) : null,
        token_decimals: raw.tokenDecimal != null ? Number(raw.tokenDecimal) : null,
        // tokentx is ERC-20 only; the NFT standards have their own feeds.
        token_standard: 'erc20',
        is_error: raw.isError === '1',
      });
    }

    // An ERC-721 is indivisible and tokennfttx carries no value field, so
    // every row is exactly one unit.
    for (const raw of nft) {
      rows.push(nftRow(raw, 'nft', 'erc721', '1'));
    }

    // tokenValue is how many copies of that id moved. Etherscan already emits
    // one row per id for a batch transfer, so a batch arrives pre-unbundled and
    // each row gets its own ordinal for free.
    for (const raw of nft1155) {
      const units = raw.tokenValue != null && /^\d+$/.test(String(raw.tokenValue)) ? String(raw.tokenValue) : '1';
      rows.push(nftRow(raw, 'nft1155', 'erc1155', units));
    }

    return rows;
  }

  // `fillPrices` decides whether this sync also walks the price providers for
  // this wallet's assets. TRUE for a wallet add and a user-pressed Sync (a
  // freshly added wallet must not render a decade of "No USD value" while it
  // waits for tonight's job), FALSE for the nightly job -- which syncs at 7:50
  // and would spend a provider budget on exactly the assets the historical
  // price job re-walks at 8:10, twenty minutes later. Same series, same
  // providers, same rate limit, twice.
  static async syncWallet(walletId, {
    fillPrices = true,
    deferUserFinish = false,
    rebuildMatches = true,
  } = {}) {
    // The rebuild lane is keyed by OWNER (EthDerivedPipeline.serializedForUser),
    // so the wallet row is read before enqueueing just to pick the lane;
    // _syncWallet re-reads it inside the slot for fresh state.
    const wallet = await EthWallet.findById(walletId);
    if (!wallet) throw new Error(`EthWallet ${walletId} not found`);
    return EthDerivedPipeline.serializedForUser(wallet.user_id,
      () => this._syncWallet(walletId, {
        fillPrices, deferUserFinish, rebuildMatches,
      }));
  }

  // Safe replacement for the old remove-and-re-add workaround for forward-only
  // metadata (method selectors, historical transaction status and future
  // normalizer upgrades). Only source cursors are reset. Stored evidence stays
  // in place until each replacement feed succeeds, and all user-authored
  // annotations live outside the reset/rebuild path.
  static async recaptureWallet(walletId, { fillPrices = true } = {}) {
    const wallet = await EthWallet.findById(walletId);
    if (!wallet) throw new Error(`EthWallet ${walletId} not found`);
    return EthDerivedPipeline.serializedForUser(wallet.user_id, async () => {
      for (const chain of chains.enabledChains()) {
        await EthWalletChain.ensure(wallet.id, chain.id, Number(chain.ingestVersion || 0));
        await EthWalletChain.resetForRecapture(wallet.id, chain.id);
      }
      return this._syncWallet(walletId, { fillPrices });
    });
  }

  // The HTTP route returns before a genesis replay can hit a proxy timeout.
  // Returning `started=false` makes duplicate requests honest without exposing
  // or cancelling the in-flight promise.
  static queueRecaptureWallet(walletId, options = {}) {
    if (recaptureRuns.has(walletId)) return { started: false };
    const run = this.recaptureWallet(walletId, options)
      .catch((err) => {
        logger.error({ walletId, err }, 'Full ETH wallet recapture failed');
      })
      .finally(() => {
        if (recaptureRuns.get(walletId) === run) recaptureRuns.delete(walletId);
      });
    recaptureRuns.set(walletId, run);
    return { started: true };
  }

  // One chain's ingest for one wallet: fetch each feed, replace that feed's
  // resume window, advance that feed's cursor. Everything derived (holdings,
  // the ledger mirror, classification) spans chains and is rebuilt once by the
  // caller after all chains have landed.
  //
  // Failure is isolated per (chain, feed), in three flavours:
  //   * rate limit -> 'deferred'. Retried after the provider cooldown without
  //     a red wallet failure.
  //   * other transient/transport errors -> 'failed'. Retried next sync and
  //     badged as a real wallet failure.
  //   * ETHERSCAN_FEED_UNSUPPORTED -> 'unsupported', this feed only.
  //   * ETHERSCAN_CHAIN_UNAVAILABLE -> 'unsupported', and a verdict on the whole
  //     chain, so the remaining feeds are marked without being called.
  // The unsupported kinds are recorded as a gap on eth_wallet_chains so #62
  // knows derived figures there are INCOMPLETE rather than merely stale.
  //
  // All three do the same three things, which is the part that must not be got
  // wrong: contribute no rows, SKIP that feed's delete so its stored rows
  // survive, and leave its cursor untouched. Advancing a cursor past blocks
  // that were never fetched drops those rows silently and forever.
  static async _syncWalletChain(wallet, chain, apiKey) {
    if (chain.historyProvider === 'zksync-lite') {
      return this._syncZkSyncLiteWalletChain(wallet, chain);
    }
    if (chain.historyProvider === 'coinbase-cdp') {
      return this._syncCdpWalletChain(wallet, chain);
    }
    const ingestVersion = Number(chain.ingestVersion || 0);
    let state = await EthWalletChain.ensure(wallet.id, chain.id, ingestVersion);
    if (Number(state?.ingest_version || 0) < ingestVersion) {
      state = await EthWalletChain.resetForIngestVersion(wallet.id, chain.id, ingestVersion);
    }
    // Resume before the stored cursor so a reorg near the tip is healed by the
    // delete-then-reinsert ingest. Per chain: an L2's cursor has nothing to do
    // with mainnet's, and block numbers are independent sequences.
    const resumeFrom = (cursor) => Math.max(0, Number(cursor ?? 0) - REORG_OVERLAP_BLOCKS);
    const resume = {
      normal: resumeFrom(state?.last_block_normal),
      internal: resumeFrom(state?.last_block_internal),
      token: resumeFrom(state?.last_block_token),
      nft: resumeFrom(state?.last_block_nft),
      nft1155: resumeFrom(state?.last_block_1155),
      statesync: resumeFrom(state?.last_block_statesync),
    };

    // Which feeds this chain actually runs: the five account feeds always, plus
    // any per-chain feed the chain object declares (#76's state-sync deposits,
    // plus Gnosis and OP Stack native-credit events). A feed a chain does not declare is never fetched, never
    // cursor-advanced, and never a gap -- so `activeCount` (not FEED_SPECS.length)
    // is what "every feed came back unreadable" is measured against below.
    const feedActive = (spec) => !spec.chainFeed || Boolean(chain[spec.chainFeed]);
    const activeCount = FEED_SPECS.filter(feedActive).length;
    // The from_address that marks state-sync rows, so the internal feed can
    // exclude them and the state-sync feed can scope its own delete to them.
    // Null on every chain that does not declare the feed.
    const stateSyncContract = chain[STATE_SYNC_SPEC.chainFeed]?.contract || null;
    // Classic-era Arbitrum deposits Etherscan serves backwards; read off the
    // chain object like stateSyncDeposits, never a chain-id branch. Unlike the
    // state-sync feed this is not a feed of its own: it RESHAPES txlist rows in
    // place, so it needs no cursor, no delete scoping, and no gap accounting.
    const classicDeposits = chain.classicRetryableDeposits || null;
    const opStackDeposits = chain.opStackDeposits || null;
    // Snapshot the explorer's indexed head once and use it as the common end
    // block for all active feeds:
    // successful empty feeds then have durable coverage, while a failed head
    // lookup aborts this chain before any destructive overlap delete.
    let boundary;
    try {
      boundary = await EtherscanService.coverageBoundary(apiKey, chain.id);
    } catch (error) {
      const failureStatus = coverageFailureStatus(error);
      const retryAt = failureStatus === 'deferred' ? retryAfterAt(error) : null;
      await EthFeedCoverage.recordAttempts(wallet.id, chain.id, FEED_SPECS.map((spec) => (
        feedActive(spec)
          ? {
            feed: spec.key,
            provider: providerName(chain, spec),
            status: failureStatus,
            attemptedFromBlock: resume[spec.key],
            errorCode: error.code || 'ETHERSCAN_API_ERROR',
            errorMessage: error.message,
            retryAfterAt: retryAt,
          }
          : {
            feed: spec.key,
            provider: providerName(chain, spec),
            status: 'not_applicable',
          }
      )));
      if (isExplorerRateLimited(error)) {
        const skippedFeeds = FEED_SPECS.filter(feedActive).map((spec) => spec.key);
        await EthWalletChain.setError(
          wallet.id,
          chain.id,
          'SYNC_DEFERRED',
          `Partial sync: ${chain.name} explorer rate limited; feeds deferred; automatic retry pending (${error.message})`
        );
        await EthWalletChain.updateSyncTime(wallet.id, chain.id);
        return {
          chainId: chain.id,
          chainName: chain.name,
          inserted: 0,
          skippedFeeds,
          failedFeeds: [],
          deferredFeeds: skippedFeeds,
          unsupportedFeeds: state?.unsupported_feeds || [],
          unavailable: false,
          rateLimited: true,
          retryAfterMs: Math.max(1, Number(error.retryAfterMs) || DEFAULT_DEFERRED_RETRY_MS),
          retryAfterAt: retryAt.toISOString(),
          fetched: Object.fromEntries(FEED_SPECS.map((spec) => [spec.key, 0])),
        };
      }
      throw error;
    }
    const indexedHead = boundary.throughBlock;

    const feeds = {};
    const fetchedOk = {};
    const feedErrors = {};
    const failed = [];
    const deferred = [];
    const unsupported = [];

    // Set by the first feed that reports the CHAIN as unreadable. The remaining
    // feeds are then marked unsupported WITHOUT being called: they would answer
    // identically, and the provider queue they would spend is shared across
    // wallets, so proving the same point five times delays everyone else's sync.
    // They still land in unsupported_feeds, so the gap record stays complete
    // and the whole-chain verdict below can still recognise itself.
    let chainUnreadable = false;
    let rateLimited = null;

    for (const spec of FEED_SPECS) {
      feeds[spec.key] = [];
      // A per-chain feed this chain does not declare: not fetched, not a gap,
      // not counted toward the whole-chain unavailable verdict. Placed before
      // the chainUnreadable cascade so an unavailable chain does not mark an
      // inactive feed as unsupported.
      if (!feedActive(spec)) {
        fetchedOk[spec.key] = false;
        continue;
      }
      if (chainUnreadable) {
        fetchedOk[spec.key] = false;
        unsupported.push(spec.key);
        feedErrors[spec.key] = chainUnreadable;
        continue;
      }
      if (rateLimited) {
        fetchedOk[spec.key] = false;
        deferred.push(spec.key);
        feedErrors[spec.key] = rateLimited;
        continue;
      }
      try {
        if (spec.chainFeed) {
          feeds[spec.key] = await EtherscanService[spec.fetch](
            wallet.address,
            resume[spec.key],
            apiKey,
            chain.id,
            chain[spec.chainFeed],
            indexedHead
          );
        } else {
          feeds[spec.key] = await EtherscanService[spec.fetch](
            wallet.address,
            resume[spec.key],
            apiKey,
            chain.id,
            indexedHead
          );
        }
        fetchedOk[spec.key] = true;
      } catch (err) {
        fetchedOk[spec.key] = false;
        feedErrors[spec.key] = err;
        if (isExplorerRateLimited(err)) {
          rateLimited = err;
          deferred.push(spec.key);
          logger.warn({
            walletId: wallet.id,
            chainId: chain.id,
            feed: spec.key,
            provider: providerName(chain, spec),
            retryAfterMs: err.retryAfterMs,
          }, 'Explorer rate limited; remaining feeds deferred for this chain');
        } else if (err.code === 'ETHERSCAN_CHAIN_UNAVAILABLE' || err.code === 'ETHERSCAN_FEED_UNSUPPORTED') {
          // Only the whole-chain verdict cascades. A single missing feed says
          // nothing about its neighbours, and assuming otherwise would freeze
          // four healthy cursors and report four gaps that do not exist.
          chainUnreadable = err.code === 'ETHERSCAN_CHAIN_UNAVAILABLE' ? err : false;
          unsupported.push(spec.key);
          logger.warn({ walletId: wallet.id, chainId: chain.id, feed: spec.key, code: err.code, err: err.message },
            'Etherscan cannot serve this feed; cursor frozen and gap recorded');
        } else {
          failed.push(spec.key);
          logger.warn({ walletId: wallet.id, chainId: chain.id, feed: spec.key, err },
            'Feed fetch failed; feed skipped this sync and its cursor left unchanged');
        }
      }
    }

    const rows = this.normalizeFeeds(wallet.address, feeds, {
      stateSyncContract,
      classicDeposits,
      opStackDeposits,
    })
      .map((row) => ({ ...row, wallet_id: wallet.id, chain_id: chain.id }));

    for (const spec of FEED_SPECS) {
      if (!fetchedOk[spec.key]) continue;
      // The state-sync feed shares transfer_type='internal' with the internal
      // feed but has its own cursor, so their delete windows are separated by
      // from_address: the state-sync feed clears only its own precompile rows,
      // and the internal feed clears everything except them (so a state-sync
      // credit survives an internal resync even when the state-sync feed itself
      // was skipped this run). On every other feed and chain both are null.
      const deleteOpts = {};
      if (spec.chainFeed) {
        deleteOpts.fromAddress = chain[spec.chainFeed].contract;
      } else if (spec.key === 'internal' && stateSyncContract) {
        deleteOpts.excludeFromAddress = stateSyncContract;
      }
      await EthTransfer.deleteFromBlock(wallet.id, chain.id, spec.types, resume[spec.key], deleteOpts);
    }
    const inserted = await EthTransfer.bulkInsert(rows);

    await EthFeedCoverage.recordAttempts(wallet.id, chain.id, FEED_SPECS.map((spec) => {
      if (!feedActive(spec)) {
        return {
          feed: spec.key,
          provider: providerName(chain, spec),
          status: 'not_applicable',
        };
      }
      if (fetchedOk[spec.key]) {
        return {
          feed: spec.key,
          provider: providerName(chain, spec),
          status: 'complete',
          coveredFromBlock: boundary.fromBlock,
          coveredThroughBlock: scannedThroughBlock(feeds[spec.key]),
          coveredFromAt: boundary.fromAt,
          coveredThroughAt: boundary.throughAt,
          indexedHead,
          attemptedFromBlock: resume[spec.key],
        };
      }
      const error = feedErrors[spec.key];
      const status = coverageFailureStatus(error);
      return {
        feed: spec.key,
        provider: providerName(chain, spec),
        status,
        indexedHead,
        attemptedFromBlock: resume[spec.key],
        errorCode: error?.code || 'ETHERSCAN_API_ERROR',
        errorMessage: error?.message || 'Feed was not attempted after the chain provider became unavailable',
        retryAfterAt: status === 'deferred' ? retryAfterAt(error) : null,
      };
    }));
    // Coverage lands before the resume cursor. If that audit write fails, the
    // cursor remains at its old boundary and the next sync safely refetches the
    // source window instead of advancing past an unrecorded proof.
    await EthWalletChain.updateCursors(wallet.id, chain.id, {
      normal: fetchedOk.normal ? scannedThroughBlock(feeds.normal) : null,
      internal: fetchedOk.internal ? scannedThroughBlock(feeds.internal) : null,
      token: fetchedOk.token ? scannedThroughBlock(feeds.token) : null,
      nft: fetchedOk.nft ? scannedThroughBlock(feeds.nft) : null,
      nft1155: fetchedOk.nft1155 ? scannedThroughBlock(feeds.nft1155) : null,
      statesync: fetchedOk.statesync ? scannedThroughBlock(feeds.statesync) : null,
    });
    // Written every time, empty array included, so a feed that starts working
    // again (a plan upgrade) stops being reported as a gap.
    await EthWalletChain.setUnsupportedFeeds(wallet.id, chain.id, unsupported);

    if (unsupported.length === activeCount) {
      await EthWalletChain.setError(wallet.id, chain.id, 'CHAIN_UNAVAILABLE',
        `${chain.name} is not readable with this Etherscan key. Upgrade the plan or remove ${chain.id} from ETH_CHAINS.`);
    } else if (failed.length) {
      await EthWalletChain.setError(
        wallet.id,
        chain.id,
        'FEED_SKIPPED',
        `Partial sync: ${failed.join(', ')} feed failed; will retry next sync`
      );
    } else if (deferred.length) {
      await EthWalletChain.setError(
        wallet.id,
        chain.id,
        'SYNC_DEFERRED',
        `Partial sync: ${chain.name} explorer rate limited; ${deferred.join(', ')} feeds deferred; automatic retry pending`
      );
    } else if (unsupported.length) {
      await EthWalletChain.setError(wallet.id, chain.id, 'FEED_UNSUPPORTED',
        `${unsupported.join(', ')} unavailable on ${chain.name}; derived balances there may drift`);
    } else {
      await EthWalletChain.clearError(wallet.id, chain.id);
    }
    await EthWalletChain.updateSyncTime(wallet.id, chain.id);

    return {
      chainId: chain.id,
      chainName: chain.name,
      inserted,
      skippedFeeds: [...failed, ...deferred],
      failedFeeds: failed,
      deferredFeeds: deferred,
      unsupportedFeeds: unsupported,
      unavailable: unsupported.length === activeCount,
      rateLimited: Boolean(rateLimited),
      retryAfterMs: rateLimited
        ? Math.max(1, Number(rateLimited.retryAfterMs) || DEFAULT_DEFERRED_RETRY_MS)
        : null,
      retryAfterAt: rateLimited ? retryAfterAt(rateLimited).toISOString() : null,
      fetched: Object.fromEntries(FEED_SPECS.map((spec) => [spec.key, feeds[spec.key].length])),
    };
  }

  static async _syncWallet(walletId, {
    fillPrices = true,
    deferUserFinish = false,
    rebuildMatches = true,
  } = {}) {
    const wallet = await EthWallet.findById(walletId);
    if (!wallet) throw new Error(`EthWallet ${walletId} not found`);
    // Credentials belong to the wallet's owner (the nightly job has no
    // request context). A key is required only when at least one enabled chain
    // uses the default keyed provider; a keyless-only set such as
    // ETH_CHAINS=100 must remain fully usable.
    const apiKey = await SecretsService.getUserKey(wallet.user_id, 'etherscan');
    if (!apiKey && chains.enabledChainsRequireApiKey()) {
      const error = new Error('Etherscan is not configured. Add your Etherscan key under Settings -> API Keys.');
      error.code = 'ETHERSCAN_NOT_CONFIGURED';
      throw error;
    }

    try {
      // Only enabled chains are touched. A chain switched off keeps its
      // eth_wallet_chains row, its cursors and every transfer it ever ingested
      // -- disabling stops syncing, it does not delete history, so switching it
      // back on resumes from where it left off instead of refetching years.
      const enabled = chains.enabledChains();
      const perChain = [];
      // Isolation is per CHAIN, not merely per feed. _syncWalletChain already
      // absorbs Etherscan's own failures, but everything else it does can throw
      // too -- a DB blip in bulkInsert, a cursor write timing out -- and an
      // escaping throw would abandon the whole wallet: every chain that DID
      // land would go without reclassification, holdings and mirror rows, so a
      // transient error on the fifth chain would silently roll the wallet's
      // derived state back to the previous sync.
      //
      // A failed chain's cursors are untouched by construction (nothing past
      // the throw runs), so it resumes exactly where it left off next sync.
      for (const chain of enabled) {
        try {
          perChain.push(await this._syncWalletChain(wallet, chain, apiKey));
        } catch (err) {
          logger.error({ walletId, chainId: chain.id, err },
            'Chain sync failed; other chains continue and this chain retries next sync');
          // Same error slot and convention as the feed-level states, so the
          // chain badge reads identically whatever failed.
          try {
            await EthWalletChain.ensure(wallet.id, chain.id);
            await EthWalletChain.setError(wallet.id, chain.id, err.code || 'SYNC_ERROR', err.message);
          } catch (recordErr) {
            logger.error({ walletId, chainId: chain.id, err: recordErr },
              'Could not record the chain sync error');
          }
          perChain.push({
            chainId: chain.id,
            chainName: chain.name,
            inserted: 0,
            skippedFeeds: [],
            failedFeeds: [],
            deferredFeeds: [],
            unsupportedFeeds: [],
            unavailable: false,
            error: err.message,
            errorCode: err.code || 'SYNC_ERROR',
            fetched: Object.fromEntries(FEED_SPECS.map((spec) => [spec.key, 0])),
          });
        }
      }

      const failedChains = perChain.filter((result) => result.error);
      // A wallet where NOTHING landed fails exactly as it did before per-chain
      // isolation: nothing was ingested, so there is nothing to rebuild derived
      // data from, and the caller (and the nightly job's failure count) must
      // still see a thrown error rather than a clean-looking empty sync.
      if (failedChains.length === perChain.length && perChain.length > 0) {
        const [first] = failedChains;
        const error = new Error(first.error);
        error.code = first.errorCode;
        throw error;
      }

      // Naming the selectors Etherscan could not decode. Sync-time only: the
      // transfers route must never wait on Sourcify or 4byte. Non-fatal by
      // design -- method_name is a cosmetic hint, so a signature service being
      // down must not fail a sync that already has every balance and transfer.
      // Chain-agnostic: a 4-byte selector means the same thing everywhere, and
      // eth_method_signatures is global, so one pass covers every chain.
      let methods = null;
      try {
        methods = await MethodSignatureService.decodePendingForWallet(walletId);
      } catch (err) {
        logger.warn({ walletId, err }, 'Method signature decode failed; selectors stay unnamed');
      }

      // Everything derived from these transfers is rebuilt ONCE for the whole
      // wallet, after every chain has landed. Counterparty labels are
      // address-keyed with no chain dimension, and holdings/mirror rows span
      // chains, so doing this per chain would rebuild the same rows N times
      // and briefly publish a wallet whose holdings reflect only the chains
      // synced so far. The step list and its ordering live in
      // EthDerivedPipeline; any step throwing lands in the outer catch below,
      // which badges the wallet.
      //
      // A single-wallet sync keeps the exchange-match pass embedded in the
      // activity rebuild so its result rides on the sync response. The nightly
      // all-wallet caller defers both the match pass and the user-wide tail
      // until every wallet owned by this user has landed.
      const derived = await EthDerivedPipeline.rebuildWallet(walletId, {
        reclassifyUserId: wallet.user_id,
        fillPrices,
        holdings: true,
        rebuildMatches,
      });
      if (!deferUserFinish) {
        await EthDerivedPipeline.finishUser(wallet.user_id, { match: false, walletId });
      }

      // The balance audit (#62): does the ledger we just stored reproduce the
      // balance the chain reports? Runs last, and non-fatally, because it is a
      // VERDICT ON the sync rather than a step of it -- everything above has
      // already landed, and an audit that could fail a completed sync would
      // trade a real balance for an opinion about it. It reuses the live ETH
      // figures refreshHoldings already fetched, so ETH costs no extra request.
      let reconciliation = null;
      try {
        reconciliation = await EthReconciliationService.reconcileWallet(wallet, {
          liveWeiByChain: derived.holdings?.liveWeiByChain || {},
          chainResults: perChain,
          apiKey,
        });
      } catch (err) {
        logger.warn({ walletId, err }, 'Balance reconciliation failed; the sync itself is unaffected');
      }

      // Feed labels carry their chain: "nft failed" is not actionable when five
      // chains ran, and the same feed can be healthy on one chain and skipped
      // on another.
      const skippedFeeds = perChain.flatMap((result) =>
        result.skippedFeeds.map((feed) => `${result.chainName}/${feed}`));
      const failedFeeds = perChain.flatMap((result) =>
        (result.failedFeeds || []).map((feed) => `${result.chainName}/${feed}`));
      const deferredFeeds = perChain.flatMap((result) =>
        (result.deferredFeeds || []).map((feed) => `${result.chainName}/${feed}`));
      const unsupportedFeeds = perChain.flatMap((result) =>
        result.unsupportedFeeds.map((feed) => `${result.chainName}/${feed}`));

      // A partial sync must not report clean: the error slot doubles as the
      // degraded-feed badge until a sync fetches every feed.
      //
      // Only real failures reach the red wallet badge. An unsupported feed is
      // a standing property of the chain and the key, so badging it would pin the
      // wallet's attention count above zero permanently -- and a badge that
      // cannot reach zero gets ignored, which would cost us the real sync
      // errors too. Those gaps live on the chain row, which the wallets API
      // returns, and are what #62 reconciles against.
      //
      // A chain that threw outright badges the wallet for the same reason a
      // failed feed does: it is transient by assumption and it retries, so the
      // badge can still reach zero.
      const failures = [
        ...failedFeeds.map((feed) => `${feed} feed`),
        ...failedChains.map((result) => `${result.chainName} chain`),
      ];
      if (failures.length > 0) {
        const message = `Partial sync: ${failures.join(', ')} failed; will retry next sync`;
        await EthWallet.setError(walletId, failedChains.length ? 'CHAIN_SYNC_FAILED' : 'FEED_SKIPPED', message);
      } else if (deferredFeeds.length > 0) {
        await EthWallet.setError(
          walletId,
          'SYNC_DEFERRED',
          `Partial sync: ${deferredFeeds.map((feed) => `${feed} feed`).join(', ')} deferred by the provider; automatic retry pending`
        );
      } else {
        await EthWallet.clearError(walletId);
      }
      await EthWallet.updateSyncTime(walletId);

      const retryAtValues = perChain
        .map((result) => new Date(result.retryAfterAt || NaN))
        .filter((value) => !Number.isNaN(value.getTime()));
      const latestRetryAt = retryAtValues.length
        ? new Date(Math.max(...retryAtValues.map((value) => value.getTime())))
        : null;
      const status = failures.length > 0
        ? 'failed'
        : deferredFeeds.length > 0
          ? 'deferred'
          : unsupportedFeeds.length > 0
            ? 'unsupported'
            : 'complete';

      const results = {
        status,
        inserted: perChain.reduce((sum, result) => sum + result.inserted, 0),
        holdings: derived.holdings,
        mirror: derived.mirror,
        activity: derived.activity,
        reconciliation,
        prices: derived.priced,
        valued: derived.valued,
        methods,
        skippedFeeds,
        failedFeeds,
        deferredFeeds,
        unsupportedFeeds,
        retryAfterMs: latestRetryAt
          ? Math.max(0, latestRetryAt.getTime() - Date.now())
          : null,
        retryAfterAt: latestRetryAt?.toISOString() || null,
        chains: perChain,
        // Cross-chain totals, so the shape callers already read still means
        // "how much did this sync bring in".
        fetched: FEED_SPECS.reduce((totals, spec) => {
          totals[spec.key] = perChain.reduce((sum, result) => sum + result.fetched[spec.key], 0);
          return totals;
        }, {}),
      };
      logger.info({ walletId, address: wallet.address, results }, 'ETH wallet sync completed');
      return results;
    } catch (err) {
      await EthWallet.setError(walletId, err.code || 'SYNC_ERROR', err.message);
      throw err;
    }
  }

  // The nightly job's entry point. fillPrices defaults FALSE here and only
  // here: the historical price job at 8:10 owns the provider walk for every
  // wallet, so the 7:50 sync must not do it first. A caller that wants the
  // interactive behaviour passes it explicitly.
  static async syncAllWallets({
    fillPrices = false,
    deferredRetryAttempts = SYNC_DEFERRED_RETRY_ATTEMPTS,
    deferredRetryMaxMs = SYNC_DEFERRED_RETRY_MAX_MS,
  } = {}) {
    const wallets = await EthWallet.findAllForJobs();
    const outcomes = new Map();

    const runBatch = async (batch) => {
      const byUser = new Map();
      for (const wallet of batch) {
        const key = wallet.user_id ?? null;
        if (!byUser.has(key)) byUser.set(key, []);
        byUser.get(key).push(wallet);
      }

      // Keep one owner's raw and derived writes inside the established lane.
      // Retry waits happen outside this function, so a provider cooldown never
      // blocks that owner's label writes or unrelated wallet actions.
      for (const [userId, userWallets] of byUser) {
        await EthDerivedPipeline.serializedForUser(userId, async () => {
          const successful = [];
          for (const wallet of userWallets) {
            const attempts = Number(outcomes.get(wallet.id)?.attempts || 0) + 1;
            try {
              const result = await this._syncWallet(wallet.id, {
                fillPrices,
                deferUserFinish: true,
                rebuildMatches: false,
              });
              const entry = {
                walletId: wallet.id,
                address: wallet.address,
                attempts,
                ...result,
              };
              outcomes.set(wallet.id, entry);
              successful.push({ wallet, entry });
            } catch (err) {
              if (err.code === 'ETHERSCAN_NOT_CONFIGURED') {
                outcomes.set(wallet.id, {
                  walletId: wallet.id,
                  address: wallet.address,
                  attempts,
                  status: 'skipped',
                  skipped: 'not_configured',
                });
                logger.warn({ walletId: wallet.id, userId: wallet.user_id },
                  'Skipping ETH wallet: owner has no Etherscan key');
                continue;
              }
              outcomes.set(wallet.id, {
                walletId: wallet.id,
                address: wallet.address,
                attempts,
                status: 'failed',
                error: err.message,
              });
              logger.error({ walletId: wallet.id, err }, 'Failed to sync ETH wallet');
            }
          }

          if (!successful.length) return;
          try {
            await EthDerivedPipeline.finishUser(userId, {
              match: userId != null,
              context: 'nightly ETH sync',
            });
          } catch (err) {
            // Match the old per-wallet failure semantics: a failed user-wide
            // tail invalidates every wallet whose ingest succeeded in this block.
            for (const { wallet, entry } of successful) {
              entry.status = 'failed';
              entry.error = err.message;
              try {
                await EthWallet.setError(wallet.id, err.code || 'SYNC_ERROR', err.message);
              } catch (recordErr) {
                logger.error({ walletId: wallet.id, err: recordErr },
                  'Could not record coalesced nightly ETH tail error');
              }
            }
            logger.error({ userId, err }, 'Nightly ETH user-wide tail failed');
          }
        });
      }
    };

    await runBatch(wallets);

    // A provider pause is shared across wallets. Wait once outside every user
    // lane, then retry only wallets that actually deferred. A fresh state-sync
    // prefetch is taken on each pass, so an RPC 429 is not replayed forever from
    // the first pass's cached error. The bounded attempts and wait budget keep
    // one unhealthy public endpoint from holding the nightly job indefinitely.
    const retryLimit = Math.min(5, Math.max(0, Number(deferredRetryAttempts) || 0));
    const waitLimit = Math.min(
      MAX_PROVIDER_RETRY_WAIT_MS,
      Math.max(0, Number(deferredRetryMaxMs) || 0)
    );
    let waitedMs = 0;
    for (let retry = 0; retry < retryLimit; retry++) {
      const pending = wallets.filter((wallet) => (
        outcomes.get(wallet.id)?.deferredFeeds?.length > 0
      ));
      if (!pending.length) break;
      const delayMs = Math.max(...pending.map((wallet) =>
        retryAfterMsForResult(outcomes.get(wallet.id))));
      if (waitedMs + delayMs > waitLimit) {
        logger.warn({ pending: pending.length, delayMs, waitedMs, waitLimit },
          'Deferred ETH wallet retry exceeds the bounded job wait budget');
        break;
      }
      logger.warn({ pending: pending.length, delayMs, attempt: retry + 1 },
        'Waiting for explorer cooldown before retrying deferred wallets');
      await sleep(delayMs);
      waitedMs += delayMs;
      await runBatch(pending);
    }

    const summary = {
      processed: wallets.length,
      succeeded: 0,
      failed: 0,
      deferred: 0,
      unsupported: 0,
      unverified: 0,
      skipped: 0,
      results: wallets.map((wallet) => outcomes.get(wallet.id)),
    };
    for (const entry of summary.results) {
      if (entry?.status === 'skipped') summary.skipped += 1;
      else if (entry?.status === 'failed') summary.failed += 1;
      else if (entry?.status === 'deferred') summary.deferred += 1;
      else {
        summary.succeeded += 1;
        if (entry?.status === 'unsupported') summary.unsupported += 1;
        if (entry?.status === 'unverified') summary.unverified += 1;
      }
    }
    return summary;
  }

  static async addWallet(userId, address, label) {
    if (typeof address !== 'string' || !ADDRESS_RE.test(address.trim())) {
      const error = new Error('address must be a 0x-prefixed 40-hex-character EVM address');
      error.code = 'INVALID_ADDRESS';
      throw error;
    }
    // Fail fast only when the enabled provider set needs a key. A keyless-only
    // chain set can create and sync the wallet without Etherscan credentials.
    const apiKey = await SecretsService.getUserKey(userId, 'etherscan');
    if (!apiKey && chains.enabledChainsRequireApiKey()) {
      const error = new Error('Etherscan is not configured. Add your Etherscan key under Settings -> API Keys.');
      error.code = 'ETHERSCAN_NOT_CONFIGURED';
      throw error;
    }
    const normalized = address.trim().toLowerCase();

    const existing = await EthWallet.findByAddress(normalized, userId);
    if (existing) {
      const error = new Error('That address is already tracked');
      error.code = 'DUPLICATE_WALLET';
      throw error;
    }

    // Wallet and account are created atomically: a wallet without its account
    // would make every holdings/mirror refresh silently skip it. The account's
    // stable name is derived from the address (unique by construction); the
    // user-facing label rides on display_name like every other renamed account.
    const client = await pool.connect();
    const accountName = `Ethereum ${shortAddress(normalized)}`;
    const trimmedLabel = label?.trim() || null;
    let wallet;
    let account;
    try {
      await client.query('BEGIN');
      const walletResult = await client.query(
        'INSERT INTO eth_wallets (address, label, user_id) VALUES ($1, $2, $3) RETURNING *',
        [normalized, trimmedLabel, userId]
      );
      wallet = walletResult.rows[0];

      // Disconnecting a wallet with removeData=false detaches its account
      // (eth_wallet_id -> NULL) but keeps the row, name included. Re-adding the
      // same address must re-attach that account rather than insert a second
      // one: the name is unique per user, so inserting would violate
      // accounts_user_id_name_key, and re-attaching is what "keep data" was for
      // -- the account's snapshots, history, and display_name all survive.
      // Matching on name is exactly as precise as the constraint being avoided.
      const reattached = await client.query(
        `UPDATE accounts
            SET eth_wallet_id = $1,
                display_name = COALESCE($2, display_name),
                type = 'crypto',
                -- Un-hide deliberately. Hiding the leftover account is the
                -- natural response to a disconnect, and adopting it while
                -- hidden would exclude the wallet from net worth, holdings,
                -- history and exports -- every consumer filters
                -- is_hidden = FALSE -- with no error anywhere. Re-adding an
                -- address is an explicit "track this again"; a reappearing row
                -- is trivially re-hidden, a silently missing balance is not.
                is_hidden = FALSE
          WHERE user_id = $3 AND name = $4 AND eth_wallet_id IS NULL
          RETURNING *`,
        [wallet.id, trimmedLabel, userId, accountName]
      );
      if (reattached.rows.length) {
        account = reattached.rows[0];
      } else {
        const accountResult = await client.query(
          `INSERT INTO accounts (name, type, display_name, eth_wallet_id, user_id)
           VALUES ($1, 'crypto', $2, $3, $4)
           RETURNING *`,
          [accountName, trimmedLabel, wallet.id, userId]
        );
        account = accountResult.rows[0];
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      // Branch on the constraint, not just the code: the transaction's FIRST
      // statement inserts into eth_wallets, and the duplicate-address
      // pre-check above runs outside the transaction, so a double-submit or an
      // interceptor retry can race it. Reporting that as a name conflict would
      // send the user chasing an account rename for what is really "you
      // already track this address".
      if (err.code === '23505' && err.constraint === 'eth_wallets_user_id_address_key') {
        const duplicate = new Error('That address is already tracked');
        duplicate.code = 'DUPLICATE_WALLET';
        throw duplicate;
      }
      if (err.code === '23505') {
        // A live account already holds this name -- two distinct addresses
        // sharing a 6-and-4 abbreviation. Vanishingly rare, and there is no
        // API that renames an account, so the message must not tell the user
        // to go rename one; only display_name is editable.
        const conflict = new Error(`Another account is already named "${accountName}", so this address can't be added automatically.`);
        conflict.code = 'ACCOUNT_NAME_CONFLICT';
        throw conflict;
      }
      throw err;
    } finally {
      client.release();
    }

    // A new own-address can turn previously-external transfers into
    // self-transfers on other wallets, so their mirrored ledger rows must be
    // rebuilt too. Non-fatal: the wallet exists either way, and the first
    // sync re-derives all of this.
    try {
      await this.refreshClassificationsForUser(userId);
    } catch (err) {
      logger.warn({ walletId: wallet.id, err }, 'Derived-data refresh after wallet add failed');
    }

    logger.info({ walletId: wallet.id, address: normalized }, 'ETH wallet added');
    return { wallet, account };
  }

  // Rebuilds the wallet account's holdings: one NATIVE position PER CHAIN,
  // priced later by the regular price job (each carries its chain's native
  // ticker, so every ETH-native chain reads the one shared price_cache 'ETH'
  // row and Polygon reads 'POL'), plus one row per non-ignored token per chain.
  // Token symbols never become tickers -- a scam token named "AAPL" must not
  // inherit Apple's stock price -- so tokens are NULL-ticker holdings valued
  // via manual_value at sync time.
  //
  // Rows are matched by NAME rather than by ticker. Post-#58 one account holds
  // several ticker='ETH' rows, so the old ticker matcher would return them all
  // and every chain would fight over whichever row came back first, overwriting
  // the previous chain's balance. Names are unique per account by construction:
  // 'Ethereum', 'ETH (Arbitrum)', 'USDC 0x1234…5678', 'USDC 0x1234…5678 (Base)'.
  static async refreshHoldings(walletId) {
    const wallet = await EthWallet.findById(walletId);
    if (!wallet) throw new Error(`EthWallet ${walletId} not found`);
    const account = await EthWallet.getAccountForWallet(walletId);
    if (!account) return { skipped: true };

    const apiKey = await SecretsService.getUserKey(wallet.user_id, 'etherscan');
    if (!apiKey && chains.enabledChainsRequireApiKey()) {
      const error = new Error('Etherscan is not configured. Add your Etherscan key under Settings -> API Keys.');
      error.code = 'ETHERSCAN_NOT_CONFIGURED';
      throw error;
    }

    const existingResult = await pool.query(
      'SELECT id, name FROM holdings WHERE account_id = $1',
      [account.id]
    );
    const existingByName = new Map(existingResult.rows.map((row) => [row.name, row.id]));

    const chainStates = await EthWalletChain.findForWallet(walletId);
    // A chain the key provably cannot read: skip the balance call rather than
    // spend a throttle slot learning the same thing nightly. Self-healing --
    // the sync still probes its feeds every run, so the moment the plan is
    // upgraded the error clears and this resumes.
    const unreadable = new Set(
      chainStates
        .filter((state) => state.error_code === 'CHAIN_UNAVAILABLE')
        .map((state) => Number(state.chain_id))
    );

    const desired = [];
    // Only chains actually re-derived this run may have their stale rows
    // reaped. This is what makes "disabling a chain leaves its stored rows
    // untouched" true, and it also protects a chain whose balance call failed
    // transiently from having last night's positions deleted.
    const refreshedChainIds = [];
    // Raw wei per chain, kept for the balance audit (#62). Passing this on is
    // what makes reconciliation cost ZERO extra Etherscan requests for ETH: a
    // second action=balance per chain would double the audit's price against a
    // globally throttled key to re-read a number this function already has.
    // Unscaled on purpose -- `desired` carries an 8-decimal clamped string, and
    // comparing that against the chain would invent drift below 1e-8 ETH.
    //
    // A chain gets an entry ONLY when its balance call actually came back: both
    // paths below (`unreadable`, and a failed fetch) `continue` without writing
    // one. The audit reads that absence as "this key could not reach this chain
    // this run" and spends no token lookups there, so an unreachable chain
    // cannot burn the whole per-wallet budget on calls destined to fail.
    const liveWeiByChain = {};

    for (const chain of chains.enabledChains()) {
      if (unreadable.has(chain.id)) {
        logger.warn({ walletId, chainId: chain.id }, 'Skipping balance: chain unreadable with this key');
        continue;
      }
      let wei;
      try {
        wei = await EtherscanService.getEthBalance(wallet.address, apiKey, chain.id);
      } catch (err) {
        // A provider-wide 429 is transient and must not turn a safe partial
        // history sync into the generic "Failed to sync wallet" error. Keep
        // this chain's previous holding and let reconciliation mark its live
        // figure unavailable until the next attempt.
        if (isExplorerRateLimited(err)) {
          logger.warn({ walletId, chainId: chain.id, retryAfterMs: err.retryAfterMs },
            'ETH balance provider rate limited; chain keeps its previous holdings');
          continue;
        }
        // Mainnet keeps its pre-#58 fail-loud behavior: an unreadable mainnet
        // balance means the whole sync is untrustworthy. An L2 failing must not
        // take the wallet down with it, and must not delete the position it
        // wrote last night either.
        if (chain.id === chains.DEFAULT_CHAIN_ID) throw err;
        logger.warn({ walletId, chainId: chain.id, err },
          'ETH balance fetch failed; that chain keeps its previous holdings');
        continue;
      }
      refreshedChainIds.push(chain.id);
      liveWeiByChain[chain.id] = wei;
      const name = chains.ethHoldingName(chain.id);
      // Mainnet always keeps its ETH row, at zero if need be, so a mainnet-only
      // wallet looks exactly as it did before #58. An L2 earns a row once it
      // holds ETH or already has one -- otherwise enabling four chains would
      // decorate every existing wallet with four permanent 0.00000000 rows.
      if (chain.id === chains.DEFAULT_CHAIN_ID || BigInt(wei) > 0n || existingByName.has(name)) {
        desired.push({
          chain_id: chain.id,
          ticker: chain.nativeAsset,
          name,
          quantity: unitsToDecimalString(wei, 18),
          manual_value: null,
        });
      }
    }

    const refreshable = new Set(refreshedChainIds);
    const deltas = await EthTransfer.tokenBalanceDeltas(walletId);
    const held = deltas.filter((d) => BigInt(d.balance_units) > 0n && refreshable.has(Number(d.chain_id)));

    // Prices are fetched per chain: CoinGecko's token_price endpoint is keyed by
    // asset PLATFORM, and an Arbitrum contract queried against the ethereum
    // platform simply returns nothing -- which reads as "unpriced" rather than
    // as a mistake, so it would silently zero every L2 token's value.
    const prices = new Map();
    const byChain = new Map();
    for (const delta of held) {
      const chainId = Number(delta.chain_id);
      if (!byChain.has(chainId)) byChain.set(chainId, []);
      byChain.get(chainId).push(delta);
    }
    for (const [chainId, chainDeltas] of byChain) {
      const platform = chains.getChain(chainId)?.coingeckoPlatform;
      if (!platform) continue;
      try {
        const contracts = chainDeltas.map((d) => d.token_contract).join(',');
        const json = await PriceService.fetchCoinGeckoJson(
          `https://api.coingecko.com/api/v3/simple/token_price/${platform}?contract_addresses=${encodeURIComponent(contracts)}&vs_currencies=usd`
        );
        for (const [contract, value] of Object.entries(json || {})) {
          prices.set(`${chainId}:${contract.toLowerCase()}`, value);
        }
      } catch (err) {
        logger.warn({ walletId, chainId, err }, 'Token price lookup failed; token holdings stay unvalued');
      }
    }

    for (const delta of held) {
      const chainId = Number(delta.chain_id);
      const decimals = delta.token_decimals != null ? Number(delta.token_decimals) : 18;
      const quantity = unitsToDecimalString(delta.balance_units, decimals);
      const usd = Number(prices.get(`${chainId}:${delta.token_contract}`)?.usd);
      // Clamped like the mirror's toAmount: manual_value is DECIMAL(15,2) and
      // one absurd scam-token valuation must not abort the whole sync.
      const manualValue = Number.isFinite(usd)
        ? Math.min(Math.round(usd * Number(quantity) * 100) / 100, 9999999999999.99)
        : null;
      desired.push({
        chain_id: chainId,
        ticker: null,
        // Same contract address can exist on several chains as different
        // assets, so the chain has to be in the name -- it is the match key.
        name: `${delta.token_symbol || 'TOKEN'} ${shortAddress(delta.token_contract)}${chains.holdingSuffix(chainId)}`,
        quantity,
        manual_value: manualValue,
      });
    }

    for (const holding of desired) {
      const existingId = existingByName.get(holding.name);
      if (existingId) {
        await pool.query(
          `UPDATE holdings SET ticker = $1, quantity = $2, manual_value = $3, chain_id = $4,
                               updated_at = CURRENT_TIMESTAMP
           WHERE id = $5`,
          [holding.ticker, holding.quantity, holding.manual_value, holding.chain_id, existingId]
        );
      } else {
        await pool.query(
          `INSERT INTO holdings (account_id, ticker, name, quantity, manual_value, chain_id)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [account.id, holding.ticker, holding.name, holding.quantity, holding.manual_value, holding.chain_id]
        );
      }
    }

    // The account exists solely for this wallet, so anything this run did not
    // produce (sold-out positions, newly-ignored tokens) is stale -- but only
    // on the chains this run actually re-derived. COALESCE(chain_id, 1) covers
    // rows written before 039 added the column, which are all mainnet's.
    await pool.query(
      `DELETE FROM holdings
       WHERE account_id = $1
         AND COALESCE(chain_id, $2) = ANY($3::int[])
         AND name <> ALL($4::text[])`,
      [account.id, chains.DEFAULT_CHAIN_ID, refreshedChainIds, desired.map((h) => h.name)]
    );

    // ETH-only by design, not by oversight: these two report the ETH figure the
    // UI shows under an ETH heading, and a chain with a different native asset
    // has no business being summed into it. Reconciliation reads
    // liveWeiByChain, which is chain-keyed and covers every chain.
    return {
      eth: desired.find((h) => h.chain_id === chains.DEFAULT_CHAIN_ID && h.ticker === 'ETH')?.quantity ?? null,
      ethByChain: Object.fromEntries(
        desired.filter((h) => h.ticker === 'ETH').map((h) => [h.chain_id, h.quantity])
      ),
      liveWeiByChain,
      tokens: held.length,
      chains: refreshedChainIds,
    };
  }

  static async removeWallet(walletId, { removeData = false } = {}) {
    const wallet = await EthWallet.findById(walletId);
    if (!wallet) throw new Error(`EthWallet ${walletId} not found`);

    await EthWallet.delete(walletId, { removeData });

    // Non-fatal: the wallet is already gone; a failure here must not report
    // the disconnect itself as failed.
    try {
      await this.refreshClassificationsForUser(wallet.user_id);
    } catch (err) {
      logger.warn({ walletId, err }, 'Derived-data refresh after wallet removal failed');
    }
    logger.info({ walletId, removeData }, 'ETH wallet disconnected');
  }

  // Classification changes (wallet add/remove, address-label change) flip
  // self/exchange/external on existing rows and their mirrored ledger rows.
  // Unlike refreshDerivedForUser this never touches Etherscan or holdings --
  // labels affect classification only.
  //
  // Scoped to the owner: wallets and labels only ever classify against their
  // own user's addresses, so rebuilding every user's rows was wasted work on an
  // edit they never made. The final backfill stays global -- it is an
  // account-keyed derivation over transactions, not an eth-wallet read.
  static refreshClassificationsForUser(userId) {
    return EthDerivedPipeline.serializedForUser(userId, () => EthDerivedPipeline.runForUser(userId, {
      reclassify: true,
      context: 'classification refresh',
      matchReason: 'classification-refresh',
    }));
  }

  // Ignore lists are per-user, so this re-derives only the owner's wallets.
  // Fanning out over every wallet would spend other owners' Etherscan and
  // CoinGecko quota (refreshHoldings resolves the wallet owner's key) and
  // rewrite their holdings rows on an edit they never made.
  static refreshDerivedForUser(userId) {
    return EthDerivedPipeline.serializedForUser(userId, () => EthDerivedPipeline.runForUser(userId, {
      holdings: true,
      context: 'derived-data refresh',
      matchReason: 'derived-refresh',
    }));
  }
}

module.exports = EthWalletService;
module.exports.REORG_OVERLAP_BLOCKS = REORG_OVERLAP_BLOCKS;

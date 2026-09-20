#!/usr/bin/env node

'use strict';

// Private, read-only completion evidence for one user's EVM history. Detailed
// output contains wallet addresses, transaction hashes, exact base-unit
// balances, and provider evidence. It is therefore written only to a new,
// explicitly named 0600 file. Stdout receives aggregate counts only.

require('dotenv').config({ quiet: true });
const pool = require('../src/config/database');
const chains = require('../src/config/chains');
const { LATEST_JOB_BY_CHAIN_CTE } = require('../src/models/evmAuditReportSql');
const { writePrivateReport } = require('../src/utils/privateReport');
const {
  AUDIT_PROGRESS_CONTRACT,
  INDEPENDENT_ENUMERATION_PROVIDERS,
  isVerifiedExcludedBaseMovement,
} = require('../src/services/evmAudit/completionPolicy');

const FEEDS = Object.freeze(['normal', 'internal', 'token', 'nft', 'nft1155', 'statesync']);
const TERMINAL_JOB_STATUSES = new Set([
  'complete', 'complete_with_gaps', 'failed', 'unsupported', 'cancelled',
]);

// This is deliberately a column-level contract. A table-name check alone let
// an older deployment reach a SELECT that omitted newer evidence fields, or
// worse, encouraged a compatibility fallback that looked complete.
const REQUIRED_SCHEMA = Object.freeze({
  eth_wallets: [
    'id', 'user_id', 'address', 'label', 'last_synced_at', 'error_code', 'error_message',
    'created_at', 'updated_at',
  ],
  eth_wallet_chains: [
    'wallet_id', 'chain_id', 'last_block_normal', 'last_block_internal',
    'last_block_token', 'last_block_nft', 'last_block_1155', 'last_block_statesync',
    'unsupported_feeds', 'error_code', 'error_message', 'last_synced_at',
    'ingest_version', 'coverage_recapture_version',
  ],
  eth_feed_coverage: [
    'wallet_id', 'chain_id', 'feed', 'cursor_kind', 'provider', 'status',
    'covered_from_block', 'covered_through_block', 'covered_from_at',
    'covered_through_at', 'indexed_head', 'attempted_from_block', 'error_code',
    'error_message', 'retry_after_at', 'last_attempt_at', 'last_success_at',
    'created_at', 'updated_at',
  ],
  eth_reconciliation: [
    'id', 'wallet_id', 'chain_id', 'asset_key', 'asset_type', 'token_symbol',
    'token_decimals', 'derived_units', 'live_units', 'delta_units', 'status',
    'skip_reason', 'checked_at', 'created_at', 'updated_at',
  ],
  eth_reconciliation_adjustments: [
    'id', 'wallet_id', 'chain_id', 'asset_key', 'amount_wei', 'note', 'created_at',
  ],
  eth_transfers: [
    'id', 'wallet_id', 'chain_id', 'tx_hash', 'transfer_type', 'block_number',
    'block_time', 'value_wei',
  ],
  evm_subjects: ['id', 'user_id', 'address', 'created_at', 'updated_at'],
  evm_audit_jobs: [
    'id', 'user_id', 'subject_id', 'requested_wallet_id', 'mode', 'status', 'stage',
    'requested_chains', 'discovered_chains', 'progress', 'lease_expires_at',
    'heartbeat_at', 'retry_after_at', 'requested_at', 'started_at', 'finished_at',
    'error_code', 'error_detail', 'updated_at', 'superseded_by_job_id',
  ],
  evm_audit_scopes: [
    'id', 'job_id', 'chain_id', 'provider', 'capability', 'status',
    'requested_from_block', 'requested_through_block', 'requested_through_hash',
    'provider_cursor', 'provider_order', 'coverage_basis', 'pagination_exhausted',
    'pages_committed', 'items_committed', 'last_checkpoint_at', 'error_code',
    'error_detail', 'created_at', 'updated_at',
  ],
  evm_source_coverage: [
    'id', 'subject_id', 'chain_id', 'provider', 'capability', 'from_block',
    'through_block', 'through_block_hash', 'provider_order', 'coverage_basis',
    'pagination_exhausted', 'status', 'source_job_id', 'accepted_at',
  ],
  evm_nonce_audits: [
    'id', 'job_id', 'subject_id', 'chain_id', 'boundary_block',
    'boundary_block_hash', 'next_mined_nonce', 'observed_outgoing_count',
    'missing_nonces', 'conflicting_nonces', 'unknown_signedness_count', 'status',
    'error_code', 'error_detail', 'checked_at',
  ],
  evm_balance_audits: [
    'id', 'job_id', 'subject_id', 'chain_id', 'asset_key', 'asset_type',
    'boundary_block', 'derived_units', 'live_units', 'delta_units', 'status',
    'detail', 'checked_at',
  ],
  eth_bridge_movements: [
    'id', 'user_id', 'protocol', 'family_version', 'status', 'verification_method',
    'correlation_key', 'rule_version', 'evidence', 'created_at', 'updated_at',
    'invalidated_at', 'invalidation_reason',
  ],
  eth_bridge_movement_members: [
    'id', 'movement_id', 'wallet_id', 'chain_id', 'tx_hash', 'role', 'receipt_id',
    'log_index', 'asset_id', 'amount', 'fee_amount', 'evidence', 'created_at',
  ],
  eth_bridge_receipts: [
    'id', 'wallet_id', 'chain_id', 'tx_hash', 'fetch_status', 'provider',
    'provider_boundary', 'block_number', 'block_hash', 'error_code', 'error_detail',
    'decoder_version', 'fetched_at', 'invalidated_at', 'invalidation_reason',
  ],
  eth_bridge_receipt_attempts: [
    'id', 'wallet_id', 'chain_id', 'tx_hash', 'provider', 'status',
    'provider_boundary', 'error_code', 'error_detail', 'attempted_at',
  ],
  eth_bridge_suggestions: [
    'id', 'user_id', 'out_wallet_id', 'out_chain_id', 'out_tx_hash',
    'in_wallet_id', 'in_chain_id', 'in_tx_hash', 'protocol', 'family_version',
    'suggestion_reason', 'ambiguous', 'rule_version', 'evidence', 'source', 'created_at',
  ],
  eth_bridge_verdicts: [
    'id', 'user_id', 'out_wallet_id', 'out_chain_id', 'out_tx_hash',
    'in_wallet_id', 'in_chain_id', 'in_tx_hash', 'verdict', 'note',
    'created_at', 'updated_at',
  ],
  eth_activity: ['id', 'wallet_id', 'chain_id', 'tx_hash', 'block_time', 'category', 'review_reason'],
  eth_activity_overrides: ['wallet_id', 'chain_id', 'tx_hash', 'category'],
  eth_activity_links: [
    'id', 'out_activity_id', 'in_activity_id', 'movement_id', 'evidence_method',
    'asset', 'out_amount', 'in_amount', 'fee_amount', 'matched_at',
  ],
  eth_address_labels: [
    'id', 'user_id', 'address', 'name', 'source', 'note', 'kind', 'created_at',
  ],
  eth_discovery_candidates: [
    'id', 'user_id', 'address', 'chain_id', 'status', 'score', 'source',
    'evidence', 'created_at', 'updated_at',
  ],
  eth_discovery_fetches: [
    'id', 'user_id', 'address', 'chain_id', 'depth', 'status', 'rows_fetched',
    'error_message', 'fetched_at',
  ],
});

function option(name, argv = process.argv) {
  const index = argv.indexOf(name);
  return index === -1 ? null : argv[index + 1] || null;
}

function requiredPositiveInteger(name, argv = process.argv) {
  const parsed = Number(option(name, argv));
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

async function inspectSchema(db) {
  const tables = Object.keys(REQUIRED_SCHEMA);
  const { rows } = await db.query(`
    /* evm-completion:schema */
    SELECT table_name, column_name
      FROM information_schema.columns
     WHERE table_schema = current_schema()
       AND table_name = ANY($1::text[])
     ORDER BY table_name, ordinal_position`, [tables]);
  const observed = new Map();
  for (const row of rows) {
    if (!observed.has(row.table_name)) observed.set(row.table_name, []);
    observed.get(row.table_name).push(row.column_name);
  }
  const manifest = {};
  const missingTables = [];
  const missingColumns = [];
  for (const [table, required] of Object.entries(REQUIRED_SCHEMA)) {
    const found = observed.get(table) || [];
    const missing = required.filter((column) => !found.includes(column));
    if (!observed.has(table)) missingTables.push(table);
    for (const column of missing) missingColumns.push({ table, column });
    manifest[table] = { required, observed: found, missing };
  }
  return {
    compatible: missingTables.length === 0 && missingColumns.length === 0,
    required_version_basis: 'migrations 024, 032, 039, 042, 044, 047, 048, 050, 055, 057, 066, 072, 075, 077, 079, 081, 083, 088, 092, and 093',
    missing_tables: missingTables,
    missing_columns: missingColumns,
    manifest,
  };
}

function rowsFor(result) {
  return result.rows || [];
}

function key(walletId, chainId) {
  return `${walletId}:${chainId}`;
}

function groupBy(rows, selector) {
  const grouped = new Map();
  for (const row of rows) {
    const groupKey = selector(row);
    if (!grouped.has(groupKey)) grouped.set(groupKey, []);
    grouped.get(groupKey).push(row);
  }
  return grouped;
}

function countBy(rows, selector) {
  const counts = {};
  for (const row of rows) {
    const value = String(selector(row) ?? 'unknown');
    counts[value] = (counts[value] || 0) + 1;
  }
  return counts;
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function numericZero(value) {
  return value != null && /^-?0+$/.test(String(value));
}

function integerValue(value) {
  if (value == null || !/^-?\d+$/.test(String(value))) return null;
  try {
    return BigInt(value);
  } catch {
    return null;
  }
}

function exactDeltaEvidence(row) {
  const derived = integerValue(row?.derived_units);
  const live = integerValue(row?.live_units);
  const delta = integerValue(row?.delta_units);
  return derived != null && live != null && delta != null && live - derived === delta;
}

function blockNumber(value) {
  if (value == null || !/^\d+$/.test(String(value))) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function timestampMillis(value) {
  if (value == null) return null;
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : null;
}

function isBlockHash(value) {
  return /^0x[0-9a-f]{64}$/i.test(String(value || ''));
}

function hasGapValue(value) {
  if (Array.isArray(value)) return value.length > 0;
  if (value && typeof value === 'object') return Object.keys(value).length > 0;
  if (typeof value === 'boolean') return value;
  if (value == null || value === '') return false;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric > 0 : true;
}

function chainProgress(job, chainId) {
  const progress = job?.progress;
  if (!progress || typeof progress !== 'object' || Array.isArray(progress)) return {};
  const value = progress[`chain_${chainId}`];
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function nonnegativeInteger(value) {
  if (typeof value === 'number') return Number.isSafeInteger(value) && value >= 0;
  if (typeof value !== 'string' || !/^\d+$/.test(value)) return false;
  try {
    return BigInt(value) >= 0n;
  } catch {
    return false;
  }
}

function auditProgressContractFailures(progress) {
  const missingFields = [];
  const malformedFields = [];
  const requiredFields = [
    'contract_version',
    ...AUDIT_PROGRESS_CONTRACT.nonnegative_integer_fields,
    ...AUDIT_PROGRESS_CONTRACT.array_fields,
    ...AUDIT_PROGRESS_CONTRACT.boolean_fields,
    ...AUDIT_PROGRESS_CONTRACT.nonempty_string_fields,
    ...AUDIT_PROGRESS_CONTRACT.nullable_string_fields,
    'archive_probe_status',
  ];
  for (const field of requiredFields) {
    if (!Object.hasOwn(progress, field)) missingFields.push(field);
  }
  if (Object.hasOwn(progress, 'contract_version')
    && progress.contract_version !== AUDIT_PROGRESS_CONTRACT.version) {
    malformedFields.push({
      field: 'contract_version',
      expected: `exact_version_${AUDIT_PROGRESS_CONTRACT.version}`,
    });
  }
  for (const field of AUDIT_PROGRESS_CONTRACT.nonnegative_integer_fields) {
    if (Object.hasOwn(progress, field) && !nonnegativeInteger(progress[field])) {
      malformedFields.push({ field, expected: 'nonnegative_safe_integer_or_decimal_string' });
    }
  }
  for (const field of AUDIT_PROGRESS_CONTRACT.array_fields) {
    if (Object.hasOwn(progress, field) && !Array.isArray(progress[field])) {
      malformedFields.push({ field, expected: 'array' });
    }
  }
  for (const field of AUDIT_PROGRESS_CONTRACT.boolean_fields) {
    if (Object.hasOwn(progress, field) && typeof progress[field] !== 'boolean') {
      malformedFields.push({ field, expected: 'boolean' });
    }
  }
  for (const field of AUDIT_PROGRESS_CONTRACT.nonempty_string_fields) {
    if (Object.hasOwn(progress, field)
      && (typeof progress[field] !== 'string' || !progress[field].trim())) {
      malformedFields.push({ field, expected: 'nonempty_string' });
    }
  }
  for (const field of AUDIT_PROGRESS_CONTRACT.nullable_string_fields) {
    if (Object.hasOwn(progress, field)
      && progress[field] != null && typeof progress[field] !== 'string') {
      malformedFields.push({ field, expected: 'string_or_null' });
    }
  }
  if (Object.hasOwn(progress, 'archive_probe_status')
    && !AUDIT_PROGRESS_CONTRACT.archive_statuses.includes(progress.archive_probe_status)) {
    malformedFields.push({
      field: 'archive_probe_status',
      expected: AUDIT_PROGRESS_CONTRACT.archive_statuses.join('|'),
    });
  }
  return { missingFields, malformedFields };
}

function canonicalBlockTag(block) {
  return `0x${BigInt(block).toString(16)}`;
}

function chainMetadata(chainId) {
  if (Number(chainId) === 8453) {
    return {
      id: 8453, name: 'Base', registry_supported: false, enabled: false,
      native_asset: 'ETH', account_history_providers: [],
      account_history_provider_by_capability: {},
      account_api_requires_key: null, consensus_rpc_configured: false,
      trace_rpc_configured: false, scope_excluded: true,
      scope_exclusion_reason: 'Base is deliberately outside this application history.',
    };
  }
  const configured = chains.getChain(chainId);
  if (!configured) {
    return {
      id: Number(chainId), name: `Chain ${chainId}`, registry_supported: false,
      enabled: false, native_asset: null, account_history_providers: [],
      account_history_provider_by_capability: {},
      account_api_requires_key: null, consensus_rpc_configured: false,
      trace_rpc_configured: false,
      scope_excluded: false,
    };
  }
  const providerManifest = chains.accountApiProviderManifest(configured.id);
  const providers = [...chains.accountApiProviders(configured.id)];
  return {
    id: configured.id,
    name: configured.name,
    registry_supported: true,
    enabled: chains.isEnabled(configured.id),
    native_asset: configured.nativeAsset,
    account_history_providers: providers,
    account_history_provider_by_capability: {
      normal: providerManifest.normal,
      internal: providerManifest.internal,
      token: providerManifest.erc20,
      nft: providerManifest.erc721,
      nft1155: providerManifest.erc1155,
    },
    account_api_requires_key: chains.accountApiRequiresKey(configured.id),
    consensus_rpc_configured: Boolean(configured.consensusRpcUrl),
    trace_rpc_configured: Boolean(configured.traceRpcUrl),
    cursor_kind: configured.historyProvider === 'zksync-lite' ? 'archive_serial' : 'evm_block',
    scope_excluded: false,
  };
}

function addBlocker(blockers, code, evidence, severity = 'unverified') {
  blockers.push({ code, severity, evidence });
}

function requiredNativeFeeds(chain) {
  if (chain.id === 32401) return ['normal'];
  const required = ['normal', 'internal'];
  if (chains.getChain(chain.id)?.stateSyncDeposits) required.push('statesync');
  return required;
}

function matchesNativeAsset(row, nativeAsset) {
  if (!nativeAsset || String(row?.asset_key || '').toUpperCase() !== nativeAsset) return false;
  return row.token_symbol == null || String(row.token_symbol).toUpperCase() === nativeAsset;
}

function matchesNativeBalanceAudit(row, nativeAsset) {
  if (row?.asset_type !== 'native') return false;
  const key = String(row.asset_key || '').toLowerCase();
  return key === 'native' || key === String(nativeAsset || '').toLowerCase();
}

const INDEPENDENT_ENUMERATION_PROVIDER_SET = new Set(INDEPENDENT_ENUMERATION_PROVIDERS);

function enumerationCoverageComplete(
  capability, scopes, sourceCoverage, boundaryBlock, boundaryHash
) {
  const boundary = blockNumber(boundaryBlock);
  const expectedHash = isBlockHash(boundaryHash) ? String(boundaryHash).toLowerCase() : null;
  const intervals = [
    ...scopes
      .filter((row) => row.capability === capability && row.status === 'complete'
        && row.pagination_exhausted
        && INDEPENDENT_ENUMERATION_PROVIDER_SET.has(String(row.provider).toLowerCase())),
    ...sourceCoverage
      .filter((row) => row.capability === capability && row.status === 'complete'
        && row.pagination_exhausted
        && INDEPENDENT_ENUMERATION_PROVIDER_SET.has(String(row.provider).toLowerCase())),
  ].map((row) => ({
    from: blockNumber(row.requested_from_block ?? row.from_block),
    through: blockNumber(row.requested_through_block ?? row.through_block),
    throughHash: row.requested_through_hash ?? row.through_block_hash,
  })).filter((row) => row.from != null && row.through != null);
  intervals.sort((left, right) => left.from - right.from || left.through - right.through);
  let coveredThrough = -1;
  let boundaryAnchored = false;
  for (const interval of intervals) {
    if (interval.from > coveredThrough + 1) break;
    coveredThrough = Math.max(coveredThrough, interval.through);
    if (boundary != null && interval.through === boundary
      && expectedHash != null
      && String(interval.throughHash || '').toLowerCase() === expectedHash) {
      boundaryAnchored = true;
    }
  }
  return boundary != null && coveredThrough >= boundary && boundaryAnchored;
}

function completionForCoordinate(context) {
  const {
    chain, chainState, activityStats = {}, feedCoverage, reconciliation, adjustments,
    latestJob, scopes,
    sourceCoverage, nonceAudits, balanceAudits, bridgeLegs, bridgeMovements,
    bridgeSuggestions, bridgeReceipts, bridgeReceiptAttempts,
  } = context;
  const blockers = [];
  const limitations = [];
  const progress = chainProgress(latestJob, chain.id);
  const progressBoundary = blockNumber(progress.boundary_block);
  const nativeBalanceAudits = balanceAudits.filter(
    (row) => matchesNativeBalanceAudit(row, chain.native_asset)
  );
  const auditBoundaryCandidates = [
    progressBoundary,
    ...nonceAudits.map((row) => blockNumber(row.boundary_block)),
    ...nativeBalanceAudits
      .map((row) => blockNumber(row.boundary_block)),
  ].filter((value) => value != null);
  const auditBoundary = Math.max(
    0,
    ...auditBoundaryCandidates
  );
  let auditBoundaryHash = null;

  const activityCountFields = [
    'total_leg_count', 'distinct_tx_count',
    'native_impact_leg_count', 'native_impact_distinct_tx_count',
    'native_impact_distinct_tx_count_through_audit_boundary',
  ];
  const activityCounts = Object.fromEntries(activityCountFields.map((field) => [
    field, integerValue(activityStats[field]),
  ]));
  const malformedActivityCounts = activityCountFields.filter((field) => (
    activityCounts[field] == null || activityCounts[field] < 0n
  ));
  if (!malformedActivityCounts.length && (
    activityCounts.distinct_tx_count > activityCounts.total_leg_count
    || activityCounts.native_impact_leg_count > activityCounts.total_leg_count
    || activityCounts.native_impact_distinct_tx_count > activityCounts.distinct_tx_count
    || activityCounts.native_impact_distinct_tx_count > activityCounts.native_impact_leg_count
    || activityCounts.native_impact_distinct_tx_count_through_audit_boundary
      > activityCounts.native_impact_distinct_tx_count
  )) {
    malformedActivityCounts.push('cross_field_relationships');
  }

  if (chain.scope_excluded) {
    return {
      verdict: 'excluded',
      blocker_count: 0,
      blockers: [],
      source_limitations: [{
        code: 'DELIBERATE_SCOPE_EXCLUSION',
        detail: chain.scope_exclusion_reason,
      }],
      evidence_boundary: {
        claim_scope: 'deliberate_scope_exclusion',
        audit_block: null,
        required_feeds: [],
        latest_comparison_at: null,
        wall_clock_currentness_inferred: false,
      },
    };
  }

  if (!chain.registry_supported) {
    addBlocker(blockers, 'CHAIN_NOT_IN_SUPPORTED_REGISTRY', { chain_id: chain.id });
  }
  if (!chainState) addBlocker(blockers, 'MISSING_WALLET_CHAIN_STATE', { chain_id: chain.id });
  const configuredChain = chains.getChain(chain.id);
  if (chainState && configuredChain) {
    const expectedIngestVersion = Number(configuredChain.ingestVersion || 0);
    const actualIngestVersion = Number(chainState.ingest_version);
    if (!Number.isInteger(actualIngestVersion) || actualIngestVersion < expectedIngestVersion) {
      addBlocker(blockers, 'STALE_CHAIN_INGEST_VERSION', {
        actual_version: chainState.ingest_version,
        required_version: expectedIngestVersion,
      });
    }
    const recaptureVersion = Number(chainState.coverage_recapture_version);
    if (!Number.isInteger(recaptureVersion) || recaptureVersion < 1) {
      addBlocker(blockers, 'COVERAGE_RECAPTURE_NOT_CURRENT', {
        actual_version: chainState.coverage_recapture_version,
        required_version: 1,
      });
    }
  }

  const feedsByName = new Map(feedCoverage.map((row) => [row.feed, row]));
  const requiredFeeds = new Set(requiredNativeFeeds(chain));
  const unsupportedFeeds = asArray(chainState?.unsupported_feeds).map(String);
  const unsupportedRequiredFeeds = unsupportedFeeds.filter((feed) => requiredFeeds.has(feed));
  const incompleteRequiredFeeds = [...requiredFeeds].filter((feed) => (
    feedsByName.get(feed)?.status !== 'complete'
  ));
  const incompleteOptionalFeeds = FEEDS.filter((feed) => !requiredFeeds.has(feed)).filter((feed) => {
    const status = feedsByName.get(feed)?.status;
    return status && !['complete', 'not_applicable'].includes(status);
  });
  const requiredFeedSuccessTimes = [];
  if (unsupportedRequiredFeeds.length) {
    addBlocker(blockers, 'REQUIRED_CHAIN_FEED_UNSUPPORTED', {
      feeds: unsupportedRequiredFeeds,
      chain_error_code: chainState?.chain_error_code || null,
    }, 'incomplete');
  }
  if (chainState?.chain_error_code) {
    const optionalOnly = ['FEED_UNSUPPORTED', 'FEED_SKIPPED', 'SYNC_DEFERRED']
      .includes(chainState.chain_error_code)
      && unsupportedRequiredFeeds.length === 0
      && incompleteRequiredFeeds.length === 0
      && incompleteOptionalFeeds.length > 0;
    const detail = {
      error_code: chainState.chain_error_code,
      error_message: chainState.chain_error_message,
      last_synced_at: chainState.chain_last_synced_at,
      unsupported_feeds: unsupportedFeeds,
    };
    if (optionalOnly) {
      limitations.push({ code: 'OPTIONAL_CHAIN_FEED_LIMITATION', detail });
    } else {
      addBlocker(
        blockers,
        'CHAIN_SYNC_ERROR',
        detail,
        chainState.chain_error_code === 'SYNC_DEFERRED' ? 'unverified' : 'incomplete'
      );
    }
  }
  for (const feed of requiredFeeds) {
    const row = feedsByName.get(feed);
    if (!row) {
      addBlocker(blockers, 'MISSING_FEED_COVERAGE', { feed });
      continue;
    }
    const expectedProvider = chains.accountHistoryProviderName(chain.id, feed);
    const expectedCursorKind = chain.id === 32401 ? 'archive_serial' : 'evm_block';
    if (expectedProvider && row.provider !== expectedProvider) {
      addBlocker(blockers, 'FEED_PROVIDER_MISMATCH', {
        feed, provider: row.provider, expected_provider: expectedProvider,
      });
    }
    if (row.cursor_kind !== expectedCursorKind) {
      addBlocker(blockers, 'FEED_CURSOR_KIND_MISMATCH', {
        feed, cursor_kind: row.cursor_kind, expected_cursor_kind: expectedCursorKind,
      });
    }
    if (row.status !== 'complete') {
      addBlocker(
        blockers,
        'FEED_NOT_COMPLETE',
        { feed, status: row.status, error_code: row.error_code, retry_after_at: row.retry_after_at },
        ['failed', 'unsupported'].includes(row.status) ? 'incomplete' : 'unverified'
      );
    } else if (row.status === 'complete') {
      const coveredThrough = blockNumber(row.covered_through_block);
      const indexedHead = blockNumber(row.indexed_head);
      const successTime = timestampMillis(row.last_success_at);
      if (successTime == null) {
        addBlocker(blockers, 'FEED_SUCCESS_TIMESTAMP_MISSING', {
          feed, last_success_at: row.last_success_at,
        });
      } else {
        requiredFeedSuccessTimes.push(successTime);
      }
      if (String(row.covered_from_block) !== '0'
          || coveredThrough == null) {
        addBlocker(blockers, 'FEED_NOT_PROVEN_FROM_GENESIS', {
          feed, covered_from_block: row.covered_from_block,
          covered_through_block: row.covered_through_block,
        });
      } else {
        if (chain.id !== 32401 && indexedHead == null) {
          addBlocker(blockers, 'FEED_INDEXED_HEAD_MISSING', {
            feed, covered_through_block: row.covered_through_block,
            indexed_head: row.indexed_head,
          });
        } else if (indexedHead != null && coveredThrough > indexedHead) {
          addBlocker(blockers, 'FEED_COVERAGE_EXCEEDS_INDEXED_HEAD', {
            feed, covered_through_block: row.covered_through_block,
            indexed_head: row.indexed_head,
          });
        } else if (indexedHead != null && coveredThrough < indexedHead) {
          addBlocker(blockers, 'FEED_BEHIND_INDEXED_HEAD', {
            feed, covered_through_block: row.covered_through_block,
            indexed_head: row.indexed_head,
          }, 'incomplete');
        }
        if (auditBoundary > coveredThrough) {
          addBlocker(blockers, 'FEED_BEHIND_AUDIT_BOUNDARY', {
            feed, covered_through_block: row.covered_through_block,
            audit_boundary: auditBoundary,
          }, 'incomplete');
        }
      }
    }
  }
  for (const feed of FEEDS.filter((name) => !requiredFeeds.has(name))) {
    const row = feedsByName.get(feed);
    if (!row) {
      limitations.push({ code: 'OPTIONAL_FEED_COVERAGE_MISSING', detail: { feed } });
    } else if (!['complete', 'not_applicable'].includes(row.status)) {
      limitations.push({
        code: 'OPTIONAL_FEED_NOT_COMPLETE',
        detail: { feed, status: row.status, error_code: row.error_code },
      });
    }
  }

  const allNativeReconciliation = reconciliation.filter((row) => row.asset_type === 'native');
  const nativeReconciliation = allNativeReconciliation.filter(
    (row) => matchesNativeAsset(row, chain.native_asset)
  );
  for (const row of allNativeReconciliation.filter(
    (candidate) => !matchesNativeAsset(candidate, chain.native_asset)
  )) {
    addBlocker(blockers, 'UNEXPECTED_NATIVE_RECONCILIATION_ASSET', {
      reconciliation_id: row.id,
      expected_asset: chain.native_asset,
      asset_key: row.asset_key,
      token_symbol: row.token_symbol,
    });
  }
  if (!nativeReconciliation.length) {
    addBlocker(blockers, 'MISSING_NATIVE_RECONCILIATION', {
      expected_asset: chain.native_asset,
    });
  }
  for (const row of nativeReconciliation) {
    if (row.status !== 'match' || !numericZero(row.delta_units)
      || !exactDeltaEvidence(row) || row.checked_at == null) {
      addBlocker(blockers, 'NATIVE_RECONCILIATION_NOT_EXACT', {
        reconciliation_id: row.id, status: row.status, delta_units: row.delta_units,
        skip_reason: row.skip_reason,
      }, row.status === 'mismatch' ? 'incomplete' : 'unverified');
    }
  }
  const latestRequiredFeedSuccess = requiredFeedSuccessTimes.length
    ? Math.max(...requiredFeedSuccessTimes) : null;
  for (const row of nativeReconciliation) {
    const checkedAt = timestampMillis(row.checked_at);
    if (latestRequiredFeedSuccess != null
      && (checkedAt == null || checkedAt < latestRequiredFeedSuccess)) {
      addBlocker(blockers, 'RECONCILIATION_PREDATES_FEED_COVERAGE', {
        reconciliation_id: row.id,
        reconciliation_checked_at: row.checked_at,
        latest_required_feed_success_at: new Date(latestRequiredFeedSuccess).toISOString(),
      });
    }
  }

  const liteArchive = chain.id === 32401;
  // Stored zero activity and an exact-zero current balance cannot prove that
  // history is empty: the same result occurs when an entire active chain was
  // never enumerated. Every EVM coordinate therefore needs the independent
  // account-history, nonce, and balance evidence below. zkSync Lite is handled
  // separately because it is a legacy non-EVM archive.
  const auditRequired = !liteArchive;
  if (!liteArchive && auditRequired) {
    const missingBoundaryEvidence = [];
    if (progressBoundary == null) missingBoundaryEvidence.push('job_progress');
    if (nonceAudits.some((row) => blockNumber(row.boundary_block) == null)) {
      missingBoundaryEvidence.push('nonce_audit');
    }
    if (nativeBalanceAudits.some((row) => blockNumber(row.boundary_block) == null)) {
      missingBoundaryEvidence.push('native_balance_audit');
    }
    if (missingBoundaryEvidence.length) {
      addBlocker(blockers, 'AUDIT_BOUNDARY_MISSING', {
        sources: [...new Set(missingBoundaryEvidence)],
      });
    }
    const boundaryValues = [
      progressBoundary,
      ...nonceAudits.map((row) => blockNumber(row.boundary_block)),
      ...nativeBalanceAudits.map((row) => blockNumber(row.boundary_block)),
    ].filter((value) => value != null);
    if (new Set(boundaryValues).size > 1) {
      addBlocker(blockers, 'AUDIT_BOUNDARY_MISMATCH', {
        progress_boundary: progress.boundary_block ?? null,
        nonce_boundaries: nonceAudits.map((row) => row.boundary_block),
        native_balance_boundaries: nativeBalanceAudits.map((row) => row.boundary_block),
      }, 'incomplete');
    }
    const nonceHashes = nonceAudits.map((row) => row.boundary_block_hash);
    const nativeBalanceHashes = nativeBalanceAudits.map((row) => row.detail?.boundary_hash);
    const invalidHashes = [
      ...nonceHashes.map((value, index) => ({ source: 'nonce_audit', index, value })),
      ...nativeBalanceHashes.map((value, index) => ({
        source: 'native_balance_audit', index, value,
      })),
    ].filter((row) => !isBlockHash(row.value));
    if (invalidHashes.length) {
      addBlocker(blockers, 'AUDIT_BOUNDARY_HASH_MISSING', {
        invalid_hashes: invalidHashes,
      });
    }
    const boundaryHashes = [...nonceHashes, ...nativeBalanceHashes]
      .filter(isBlockHash).map((value) => String(value).toLowerCase());
    if (boundaryHashes.length && new Set(boundaryHashes).size === 1) {
      [auditBoundaryHash] = boundaryHashes;
    }
    if (new Set(boundaryHashes).size > 1) {
      addBlocker(blockers, 'AUDIT_BOUNDARY_HASH_MISMATCH', {
        nonce_hashes: nonceHashes,
        native_balance_hashes: nativeBalanceHashes,
      }, 'incomplete');
    }
    if (latestJob && timestampMillis(latestJob.finished_at) == null) {
      addBlocker(blockers, 'AUDIT_COMPLETION_TIMESTAMP_MISSING', {
        job_id: latestJob.id, finished_at: latestJob.finished_at,
      });
    } else if (latestJob && latestRequiredFeedSuccess != null
      && timestampMillis(latestJob.finished_at) < latestRequiredFeedSuccess) {
      addBlocker(blockers, 'AUDIT_PREDATES_FEED_COVERAGE', {
        source: 'audit_job', job_id: latestJob.id,
        checked_at: latestJob.finished_at,
        latest_required_feed_success_at: new Date(latestRequiredFeedSuccess).toISOString(),
      });
    }
    for (const nonce of nonceAudits) {
      const checkedAt = timestampMillis(nonce.checked_at);
      if (checkedAt == null) {
        addBlocker(blockers, 'NONCE_AUDIT_TIMESTAMP_MISSING', {
          nonce_audit_id: nonce.id, checked_at: nonce.checked_at,
        });
      } else if (latestRequiredFeedSuccess != null && checkedAt < latestRequiredFeedSuccess) {
        addBlocker(blockers, 'AUDIT_PREDATES_FEED_COVERAGE', {
          source: 'nonce_audit', nonce_audit_id: nonce.id,
          checked_at: nonce.checked_at,
          latest_required_feed_success_at: new Date(latestRequiredFeedSuccess).toISOString(),
        });
      }
    }
    for (const balance of nativeBalanceAudits) {
      const checkedAt = timestampMillis(balance.checked_at);
      if (checkedAt == null) {
        addBlocker(blockers, 'NATIVE_BALANCE_AUDIT_TIMESTAMP_MISSING', {
          balance_audit_id: balance.id, checked_at: balance.checked_at,
        });
      } else if (latestRequiredFeedSuccess != null && checkedAt < latestRequiredFeedSuccess) {
        addBlocker(blockers, 'AUDIT_PREDATES_FEED_COVERAGE', {
          source: 'native_balance_audit', balance_audit_id: balance.id,
          checked_at: balance.checked_at,
          latest_required_feed_success_at: new Date(latestRequiredFeedSuccess).toISOString(),
        });
      }
    }
  }
  if (!latestJob && !liteArchive) {
    addBlocker(blockers, 'MISSING_EVM_AUDIT_JOB', {});
  } else if (latestJob && !liteArchive) {
    if (!TERMINAL_JOB_STATUSES.has(latestJob.status)) {
      addBlocker(blockers, 'EVM_AUDIT_JOB_NOT_TERMINAL', {
        job_id: latestJob.id, status: latestJob.status, stage: latestJob.stage,
      });
    } else if (['failed', 'unsupported', 'cancelled'].includes(latestJob.status)) {
      addBlocker(blockers, 'EVM_AUDIT_JOB_HAS_GAPS', {
        job_id: latestJob.id, status: latestJob.status,
        error_code: latestJob.error_code,
      }, 'incomplete');
    } else if (latestJob.status === 'complete_with_gaps') {
      limitations.push({
        code: 'AUDIT_JOB_RETAINED_LIMITATIONS',
        detail: { job_id: latestJob.id, status: latestJob.status },
      });
    }
    if (['complete', 'complete_with_gaps'].includes(latestJob.status)
      && latestJob.stage !== 'complete') {
      addBlocker(blockers, 'AUDIT_JOB_STAGE_NOT_COMPLETE', {
        job_id: latestJob.id, status: latestJob.status, stage: latestJob.stage,
      });
    }
  }

  if (latestJob && !liteArchive) {
    const contract = auditProgressContractFailures(progress);
    if (contract.missingFields.length || contract.malformedFields.length) {
      addBlocker(blockers, 'AUDIT_PROGRESS_CONTRACT_VIOLATION', {
        job_id: latestJob.id,
        contract_version: AUDIT_PROGRESS_CONTRACT.version,
        missing_fields: contract.missingFields,
        malformed_fields: contract.malformedFields,
      });
    }
    if (malformedActivityCounts.length) {
      addBlocker(blockers, 'MALFORMED_ACTIVITY_STATS', {
        fields: malformedActivityCounts,
        activity_stats: Object.fromEntries(activityCountFields.map((field) => [
          field, activityStats[field] ?? null,
        ])),
      });
    }
    const transactionCount = integerValue(progress.transactions);
    const nativeRelevantCount = integerValue(progress.native_relevant_transactions);
    if (transactionCount != null && nativeRelevantCount != null
      && nativeRelevantCount > transactionCount) {
      addBlocker(blockers, 'AUDIT_PROGRESS_COUNT_CONTRADICTION', {
        transactions: progress.transactions,
        native_relevant_transactions: progress.native_relevant_transactions,
      });
    }
    if (!malformedActivityCounts.length && nativeRelevantCount != null
      && activityCounts.native_impact_distinct_tx_count_through_audit_boundary
        < nativeRelevantCount) {
      addBlocker(blockers, 'STORED_NATIVE_ACTIVITY_BEHIND_AUDIT', {
        native_relevant_transactions: progress.native_relevant_transactions,
        stored_native_impact_distinct_tx_count_through_audit_boundary:
          activityStats.native_impact_distinct_tx_count_through_audit_boundary,
      }, 'incomplete');
    }
    if (progress.native_balance_match === false) {
      addBlocker(blockers, 'NATIVE_BALANCE_PROGRESS_MISMATCH', {
        job_id: latestJob.id, native_balance_match: false,
      }, 'incomplete');
    }
    if (typeof progress.native_balance_match === 'boolean' && nativeBalanceAudits.length) {
      const nativeAuditMatches = nativeBalanceAudits.every((row) => (
        row.status === 'match' && numericZero(row.delta_units) && exactDeltaEvidence(row)
      ));
      if (progress.native_balance_match !== nativeAuditMatches) {
        addBlocker(blockers, 'NATIVE_BALANCE_PROGRESS_EVIDENCE_CONFLICT', {
          job_id: latestJob.id,
          progress_native_balance_match: progress.native_balance_match,
          native_balance_audit_matches: nativeAuditMatches,
        }, 'incomplete');
      }
    }
  }

  if (!liteArchive && auditRequired) {
    if (!scopes.length) addBlocker(blockers, 'MISSING_AUDIT_SCOPES', {});
    const requiredCapabilities = ['normal', 'internal'];
    if (requiredFeeds.has('statesync')) requiredCapabilities.push('native_credit');
    for (const capability of requiredCapabilities) {
      if (!enumerationCoverageComplete(
        capability, scopes, sourceCoverage, auditBoundary, auditBoundaryHash
      )) {
        addBlocker(blockers, 'REQUIRED_AUDIT_CAPABILITY_NOT_COVERED', {
          capability, boundary_block: auditBoundary,
        });
      }
    }
    for (const scope of scopes.filter((row) => row.status !== 'complete')) {
      limitations.push({
        code: 'SECONDARY_AUDIT_SCOPE_NOT_COMPLETE',
        detail: {
          scope_id: scope.id, provider: scope.provider, capability: scope.capability,
          status: scope.status, error_code: scope.error_code,
        },
      });
    }
  } else if (liteArchive) {
    limitations.push({
      code: 'ZKSYNC_LITE_ARCHIVE_SCOPE',
      detail: 'zkSync Lite is a legacy non-EVM archive; EVM nonce and consensus-RPC audits do not apply.',
    });
  } else {
    for (const scope of scopes.filter((row) => row.status !== 'complete')) {
      limitations.push({
        code: 'OPTIONAL_ZERO_NATIVE_AUDIT_SCOPE',
        detail: {
          scope_id: scope.id, provider: scope.provider, capability: scope.capability,
          status: scope.status, error_code: scope.error_code,
        },
      });
    }
  }

  if (!liteArchive && auditRequired && !nonceAudits.length) {
    addBlocker(blockers, 'MISSING_NONCE_AUDIT', {});
  }
  for (const nonce of nonceAudits) {
    const missing = asArray(nonce.missing_nonces);
    const conflicting = asArray(nonce.conflicting_nonces);
    const contractSubject = nonce.status === 'unsupported'
      && nonce.error_code === 'SUBJECT_IS_CONTRACT';
    if (contractSubject) {
      limitations.push({
        code: 'EOA_NONCE_AUDIT_NOT_APPLICABLE',
        detail: { nonce_audit_id: nonce.id, error_code: nonce.error_code },
      });
      continue;
    }
    const nextNonce = integerValue(nonce.next_mined_nonce);
    const observedOutgoing = integerValue(nonce.observed_outgoing_count);
    const unknownSignedness = integerValue(nonce.unknown_signedness_count);
    const malformed = !Array.isArray(nonce.missing_nonces)
      || !Array.isArray(nonce.conflicting_nonces)
      || nextNonce == null || nextNonce < 0n
      || observedOutgoing == null || observedOutgoing < 0n
      || observedOutgoing !== nextNonce
      || unknownSignedness == null || unknownSignedness < 0n;
    if (malformed) {
      const detail = {
        nonce_audit_id: nonce.id,
        next_mined_nonce: nonce.next_mined_nonce,
        observed_outgoing_count: nonce.observed_outgoing_count,
        unknown_signedness_count: nonce.unknown_signedness_count,
      };
      if (auditRequired) addBlocker(blockers, 'MALFORMED_NONCE_AUDIT_EVIDENCE', detail);
      else limitations.push({ code: 'OPTIONAL_ZERO_NATIVE_MALFORMED_NONCE_AUDIT', detail });
    }
    const auditedTransactions = integerValue(progress.transactions);
    if (nonce.status === 'complete' && observedOutgoing != null
      && auditedTransactions != null && auditedTransactions < observedOutgoing) {
      addBlocker(blockers, 'AUDIT_TRANSACTION_COUNT_BELOW_NONCE_EVIDENCE', {
        nonce_audit_id: nonce.id,
        audited_transactions: progress.transactions,
        observed_outgoing_count: nonce.observed_outgoing_count,
      }, 'incomplete');
    }
    const nativeRelevantTransactions = integerValue(progress.native_relevant_transactions);
    if (nonce.status === 'complete' && observedOutgoing != null
      && nativeRelevantTransactions != null
      && nativeRelevantTransactions < observedOutgoing) {
      addBlocker(blockers, 'AUDIT_NATIVE_RELEVANCE_BELOW_NONCE_EVIDENCE', {
        nonce_audit_id: nonce.id,
        native_relevant_transactions: progress.native_relevant_transactions,
        observed_outgoing_count: nonce.observed_outgoing_count,
      }, 'incomplete');
    }
    if (nonce.status === 'complete' && observedOutgoing != null
      && !malformedActivityCounts.length
      && activityCounts.native_impact_distinct_tx_count_through_audit_boundary
        < observedOutgoing) {
      addBlocker(blockers, 'STORED_NATIVE_ACTIVITY_BELOW_NONCE_EVIDENCE', {
        nonce_audit_id: nonce.id,
        stored_native_impact_distinct_tx_count_through_audit_boundary:
          activityStats.native_impact_distinct_tx_count_through_audit_boundary,
        observed_outgoing_count: nonce.observed_outgoing_count,
      }, 'incomplete');
    }
    if (nonce.status !== 'complete' || missing.length || conflicting.length
      || Number(nonce.unknown_signedness_count) !== 0) {
      const detail = {
        nonce_audit_id: nonce.id, status: nonce.status,
        missing_nonces: missing, conflicting_nonces: conflicting,
        unknown_signedness_count: nonce.unknown_signedness_count,
      };
      if (auditRequired) {
        addBlocker(
          blockers, 'NONCE_AUDIT_NOT_COMPLETE', detail,
          missing.length || conflicting.length ? 'incomplete' : 'unverified'
        );
      } else {
        limitations.push({ code: 'OPTIONAL_ZERO_NATIVE_NONCE_AUDIT_GAP', detail });
      }
    }
  }

  if (!liteArchive && auditRequired && !nativeBalanceAudits.length) {
    addBlocker(blockers, 'MISSING_NATIVE_BALANCE_AUDIT', {});
  }
  for (const balance of nativeBalanceAudits) {
    if (!exactDeltaEvidence(balance)) {
      const detail = {
        balance_audit_id: balance.id, derived_units: balance.derived_units,
        live_units: balance.live_units, delta_units: balance.delta_units,
      };
      if (auditRequired) addBlocker(blockers, 'MALFORMED_NATIVE_BALANCE_AUDIT_EVIDENCE', detail);
      else limitations.push({ code: 'OPTIONAL_ZERO_NATIVE_MALFORMED_BALANCE_AUDIT', detail });
    }
    if (balance.status !== 'match' || !numericZero(balance.delta_units)) {
      const detail = {
        balance_audit_id: balance.id, status: balance.status,
        delta_units: balance.delta_units,
      };
      if (auditRequired) {
        addBlocker(
          blockers, 'NATIVE_BALANCE_AUDIT_NOT_EXACT', detail,
          balance.status === 'mismatch' ? 'incomplete' : 'unverified'
        );
      } else {
        limitations.push({ code: 'OPTIONAL_ZERO_NATIVE_BALANCE_AUDIT_GAP', detail });
      }
    }
    const archive = balance.detail?.archive_check;
    if (archive) {
      const archiveBlock = blockNumber(archive.block);
      const progressArchiveBlock = blockNumber(progress.archive_probe_block);
      const expectedBlockTag = archiveBlock == null ? null : canonicalBlockTag(archiveBlock);
      const coordinatesMatch = archiveBlock != null
        && progressArchiveBlock != null
        && archiveBlock === progressArchiveBlock
        && archiveBlock <= Number(balance.boundary_block)
        && archive.block_tag === expectedBlockTag
        && archive.status === progress.archive_probe_status;
      if (!coordinatesMatch) {
        addBlocker(blockers, 'ARCHIVE_PROBE_COORDINATE_MISMATCH', {
          balance_audit_id: balance.id,
          boundary_block: balance.boundary_block,
          progress_archive_probe_block: progress.archive_probe_block ?? null,
          progress_archive_probe_status: progress.archive_probe_status ?? null,
          archive_block: archive.block ?? null,
          archive_block_tag: archive.block_tag ?? null,
          expected_archive_block_tag: expectedBlockTag,
          archive_status: archive.status ?? null,
        });
      }
    }
    if (archive?.status === 'available' && !exactDeltaEvidence(archive)) {
      const detail = { balance_audit_id: balance.id, archive_check: archive };
      if (auditRequired) addBlocker(blockers, 'MALFORMED_ARCHIVE_BALANCE_EVIDENCE', detail);
      else limitations.push({ code: 'OPTIONAL_ZERO_NATIVE_MALFORMED_ARCHIVE_AUDIT', detail });
    }
    if (!archive || archive.status !== 'available' || !numericZero(archive.delta_units)) {
      const detail = {
        balance_audit_id: balance.id, archive_check: archive || null,
      };
      if (auditRequired) {
        addBlocker(
          blockers, 'ARCHIVE_CHECK_NOT_EXACT', detail,
          archive?.status === 'mismatch' ? 'incomplete' : 'unverified'
        );
      } else {
        limitations.push({ code: 'OPTIONAL_ZERO_NATIVE_ARCHIVE_CHECK_GAP', detail });
      }
    }
  }

  if (!liteArchive && auditRequired && latestJob
    && (!Object.hasOwn(progress, 'historical_state_gap')
    || !Object.hasOwn(progress, 'receipt_enumeration_gap'))) {
    addBlocker(blockers, 'AUDIT_PROGRESS_INSUFFICIENT', {
      job_id: latestJob.id,
      missing_fields: ['historical_state_gap', 'receipt_enumeration_gap']
        .filter((field) => !Object.hasOwn(progress, field)),
    });
  }
  const limitationProgress = [
    ['receipt_enumeration_gap', 'RECEIPT_ENUMERATION_POINT_LOOKUP_LIMIT'],
    ['indexed_token_log_enumeration_gap', 'INDEXED_TOKEN_LOG_ENUMERATION_LIMIT'],
    ['historical_state_gap', 'HISTORICAL_STATE_POINT_CHECK_LIMIT'],
    ['historical_token_balance_gap', 'HISTORICAL_TOKEN_BALANCE_LIMIT'],
    ['provider_lookup_gaps', 'SECONDARY_PROVIDER_LOOKUP_GAP'],
    ['token_balance_gaps', 'TOKEN_BALANCE_GAP'],
    ['capability_gaps', 'AGGREGATE_CAPABILITY_GAP'],
  ];
  for (const [field, code] of limitationProgress) {
    const value = progress[field];
    if (hasGapValue(value)) {
      limitations.push({ code, detail: { job_id: latestJob?.id || null, field, value } });
    }
  }
  const materialProgressGaps = [
    ['nonce_gaps', 'NONCE_GAP', 'incomplete'],
    ['unresolved_bridges', 'UNRESOLVED_BRIDGE', 'incomplete'],
    ['archive_depth_gap', 'ARCHIVE_DEPTH_GAP', 'unverified'],
    ['archive_balance_gap', 'ARCHIVE_BALANCE_GAP', 'incomplete'],
    ['credential_feed_gap', 'CREDENTIAL_FEED_GAP', 'unverified'],
  ];
  for (const [field, code, severity] of materialProgressGaps) {
    const value = progress[field];
    if (hasGapValue(value)) {
      const detail = { job_id: latestJob?.id || null, field, value };
      if (auditRequired) addBlocker(blockers, code, detail, severity);
      else limitations.push({ code: `OPTIONAL_ZERO_NATIVE_${code}`, detail });
    }
  }
  if (hasGapValue(progress.unsupported_capabilities)) {
    const detail = {
      job_id: latestJob?.id || null,
      field: 'unsupported_capabilities',
      value: progress.unsupported_capabilities,
    };
    if (auditRequired) addBlocker(blockers, 'UNSUPPORTED_AUDIT_CAPABILITY', detail);
    else limitations.push({ code: 'OPTIONAL_ZERO_NATIVE_UNSUPPORTED_CAPABILITY', detail });
  }
  const typedNativeRelevanceGaps = [
    {
      aggregate: 'transaction_conflicts', native: 'transaction_native_conflicts',
      optional: 'transaction_optional_conflicts', blocker: 'NATIVE_TRANSACTION_CONFLICT',
      limitation: 'OPTIONAL_ASSET_TRANSACTION_CONFLICT',
    },
    {
      aggregate: 'missing_activity', native: 'missing_native_activity',
      optional: 'missing_optional_activity', blocker: 'MISSING_NATIVE_ACTIVITY',
      limitation: 'OPTIONAL_ASSET_MISSING_ACTIVITY',
    },
    {
      aggregate: 'provisional_effects', native: 'provisional_native_effects',
      optional: 'provisional_optional_effects', blocker: 'PROVISIONAL_NATIVE_EFFECT',
      limitation: 'OPTIONAL_ASSET_PROVISIONAL_EFFECT',
    },
    {
      aggregate: 'unmatched_effects', native: 'unmatched_native_effects',
      optional: 'unmatched_optional_effects', blocker: 'UNMATCHED_NATIVE_EFFECT',
      limitation: 'OPTIONAL_ASSET_UNMATCHED_EFFECT',
    },
  ];
  for (const fields of typedNativeRelevanceGaps) {
    const aggregate = integerValue(progress[fields.aggregate]);
    const native = integerValue(progress[fields.native]);
    const optional = integerValue(progress[fields.optional]);
    if (hasGapValue(progress[fields.aggregate]) && (native == null || optional == null)) {
      addBlocker(blockers, 'UNCLASSIFIED_NATIVE_RELEVANCE_GAP', {
        job_id: latestJob?.id || null,
        aggregate_field: fields.aggregate,
        aggregate_value: progress[fields.aggregate],
        required_fields: [fields.native, fields.optional],
      });
      continue;
    }
    if (native != null && optional != null
      && (native < 0n || optional < 0n || aggregate == null || aggregate !== native + optional)) {
      addBlocker(blockers, 'MALFORMED_NATIVE_RELEVANCE_GAP_COUNTS', {
        job_id: latestJob?.id || null,
        aggregate_field: fields.aggregate,
        aggregate_value: progress[fields.aggregate],
        native_field: fields.native,
        native_value: progress[fields.native],
        optional_field: fields.optional,
        optional_value: progress[fields.optional],
      });
      continue;
    }
    if (native != null && native > 0n) {
      const detail = { job_id: latestJob?.id || null, field: fields.native, value: native.toString() };
      if (auditRequired) addBlocker(blockers, fields.blocker, detail, 'incomplete');
      else limitations.push({ code: `OPTIONAL_ZERO_NATIVE_${fields.blocker}`, detail });
    }
    if (optional != null && optional > 0n) {
      limitations.push({
        code: fields.limitation,
        detail: { job_id: latestJob?.id || null, field: fields.optional, value: optional.toString() },
      });
    }
  }
  const classifiedGapFields = new Set([
    ...limitationProgress.map(([field]) => field),
    ...materialProgressGaps.map(([field]) => field),
  ]);
  for (const [field, value] of Object.entries(progress)) {
    if (!/(?:_gap|_gaps)$/.test(field) || classifiedGapFields.has(field)
      || !hasGapValue(value)) continue;
    const detail = { job_id: latestJob?.id || null, field, value };
    if (auditRequired) addBlocker(blockers, 'UNCLASSIFIED_AUDIT_GAP', detail);
    else limitations.push({ code: 'OPTIONAL_ZERO_NATIVE_UNCLASSIFIED_AUDIT_GAP', detail });
  }
  if (progress.internal_trace_enumeration_complete === false) {
    limitations.push({
      code: 'SECONDARY_TRACE_ENUMERATION_INCOMPLETE',
      detail: { coverage_basis: progress.internal_trace_coverage_basis || null },
    });
  }

  for (const leg of bridgeLegs) {
    const activeMovementReferences = asArray(leg.movement_references)
      .filter((reference) => !reference.invalidated_at);
    const terminalWithoutPair = activeMovementReferences.length > 0
      && activeMovementReferences.every(
        (reference) => ['failed', 'refunded'].includes(reference.status)
          || isVerifiedExcludedBaseMovement(reference)
      );
    if (leg.link_id == null && !terminalWithoutPair) {
      addBlocker(blockers, 'UNRESOLVED_BRIDGE_LEG', {
        activity_id: leg.id, tx_hash: leg.tx_hash, category: leg.category,
        movement_references: leg.movement_references,
      }, 'incomplete');
    }
  }
  for (const movement of bridgeMovements) {
    if (!movement.invalidated_at && isVerifiedExcludedBaseMovement(movement)) {
      limitations.push({
        code: 'BRIDGE_COUNTERPARTY_BASE_SCOPE_EXCLUDED',
        detail: {
          movement_id: movement.id,
          status: movement.status,
          verification_method: movement.verification_method,
          reason: movement.evidence.reason,
          excluded_chain_id: movement.evidence.excluded_chain_id,
          member_references: asArray(movement.members).map((member) => ({
            member_id: member.id,
            wallet_id: member.wallet_id,
            chain_id: member.chain_id,
            tx_hash: member.tx_hash,
            role: member.role,
            receipt_id: member.receipt_id,
          })),
        },
      });
      continue;
    }
    if (!movement.invalidated_at
      && !['protocol_verified', 'user_confirmed', 'refunded', 'failed'].includes(movement.status)) {
      limitations.push({
        code: 'DIAGNOSTIC_BRIDGE_MOVEMENT_NOT_RESOLVED',
        detail: { movement_id: movement.id, status: movement.status },
      });
    }
  }
  for (const suggestion of bridgeSuggestions) {
    if (!suggestion.verdict) {
      limitations.push({
        code: 'UNRESOLVED_BRIDGE_CANDIDATE',
        detail: {
          suggestion_id: suggestion.id, suggestion_reason: suggestion.suggestion_reason,
          ambiguous: suggestion.ambiguous,
        },
      });
    }
  }
  const latestAttemptByTx = new Map();
  for (const attempt of bridgeReceiptAttempts) {
    const attemptKey = `${attempt.wallet_id}:${attempt.chain_id}:${String(attempt.tx_hash).toLowerCase()}`;
    if (!latestAttemptByTx.has(attemptKey)) latestAttemptByTx.set(attemptKey, attempt);
  }
  const validReceiptCoordinates = new Set(bridgeReceipts
    .filter((receipt) => receipt.fetch_status === 'complete' && !receipt.invalidated_at)
    .map((receipt) => (
      `${receipt.wallet_id}:${receipt.chain_id}:${String(receipt.tx_hash).toLowerCase()}`
    )));
  for (const attempt of latestAttemptByTx.values()) {
    const attemptCoordinate = `${attempt.wallet_id}:${attempt.chain_id}:${String(attempt.tx_hash).toLowerCase()}`;
    if (attempt.status !== 'complete' && !validReceiptCoordinates.has(attemptCoordinate)) {
      limitations.push({
        code: 'BRIDGE_RECEIPT_UNAVAILABLE',
        detail: {
          attempt_id: attempt.id, tx_hash: attempt.tx_hash,
          status: attempt.status, error_code: attempt.error_code,
        },
      });
    }
  }

  const nonzeroAdjustments = adjustments.filter(
    (adjustment) => String(adjustment.asset_key || '').toUpperCase() === chain.native_asset
      && !numericZero(adjustment.amount_wei)
  );
  if (nonzeroAdjustments.length) {
    addBlocker(blockers, 'RECONCILIATION_ADJUSTMENT_REQUIRED', {
      adjustments: nonzeroAdjustments.map((adjustment) => ({
        adjustment_id: adjustment.id,
        asset_key: adjustment.asset_key,
        amount_wei: adjustment.amount_wei,
        note: adjustment.note,
      })),
    }, 'incomplete');
  }

  if (!chain.trace_rpc_configured) {
    limitations.push({
      code: 'NO_DEDICATED_TRACE_RPC',
      detail: 'Independent generic internal-call enumeration depends on explorer evidence for this chain.',
    });
  }
  if (progress.balance_coverage_basis) {
    limitations.push({ code: 'BALANCE_COVERAGE_BASIS', detail: progress.balance_coverage_basis });
  }
  if (progress.internal_trace_coverage_basis) {
    limitations.push({ code: 'INTERNAL_TRACE_COVERAGE_BASIS', detail: progress.internal_trace_coverage_basis });
  }

  const hasIncomplete = blockers.some((blocker) => blocker.severity === 'incomplete');
  const requiredFeedBoundaries = [...requiredFeeds].map((feed) => {
    const row = feedsByName.get(feed);
    return {
      feed,
      covered_through_block: blockNumber(row?.covered_through_block),
      indexed_head: blockNumber(row?.indexed_head),
      last_success_at: row?.last_success_at || null,
    };
  });
  const comparisonTimes = [
    ...nativeReconciliation.map((row) => timestampMillis(row.checked_at)),
    ...nativeBalanceAudits.map((row) => timestampMillis(row.checked_at)),
    ...nonceAudits.map((row) => timestampMillis(row.checked_at)),
  ].filter((value) => value != null);
  return {
    verdict: blockers.length === 0
      ? limitations.length
        ? 'complete_through_boundary_with_limitations'
        : 'complete_through_boundary'
      : hasIncomplete ? 'incomplete' : 'unverified',
    blocker_count: blockers.length,
    blockers,
    source_limitations: limitations,
    evidence_boundary: {
      claim_scope: 'historical_evidence_through_boundary',
      audit_block: auditRequired && !liteArchive ? auditBoundary : null,
      required_feeds: requiredFeedBoundaries,
      latest_comparison_at: comparisonTimes.length
        ? new Date(Math.max(...comparisonTimes)).toISOString() : null,
      wall_clock_currentness_inferred: false,
    },
  };
}

async function readEvidence(db, userId) {
  const queries = [
    db.query(`
      /* evm-completion:wallets */
      SELECT w.id AS wallet_id, w.address, w.label,
             w.last_synced_at AS wallet_last_synced_at,
             w.error_code AS wallet_error_code,
             w.error_message AS wallet_error_message,
             w.created_at AS wallet_created_at, w.updated_at AS wallet_updated_at,
             s.id AS subject_id,
             wc.chain_id, wc.last_block_normal, wc.last_block_internal,
             wc.last_block_token, wc.last_block_nft, wc.last_block_1155,
             wc.last_block_statesync, wc.unsupported_feeds,
             wc.error_code AS chain_error_code, wc.error_message AS chain_error_message,
             wc.last_synced_at AS chain_last_synced_at,
             wc.ingest_version, wc.coverage_recapture_version
        FROM eth_wallets w
        LEFT JOIN evm_subjects s ON s.user_id = w.user_id AND s.address = w.address
        LEFT JOIN eth_wallet_chains wc ON wc.wallet_id = w.id
       WHERE w.user_id = $1
       ORDER BY w.id, wc.chain_id`, [userId]),
    db.query(`
      /* evm-completion:subjects */
      SELECT s.*, w.id AS mapped_wallet_id
        FROM evm_subjects s
        LEFT JOIN eth_wallets w ON w.user_id = s.user_id AND w.address = s.address
       WHERE s.user_id = $1
       ORDER BY s.id`, [userId]),
    db.query(`
      /* evm-completion:feeds */
      SELECT c.*
        FROM eth_feed_coverage c
        JOIN eth_wallets w ON w.id = c.wallet_id
       WHERE w.user_id = $1
       ORDER BY c.wallet_id, c.chain_id, c.feed`, [userId]),
    db.query(`
      /* evm-completion:reconciliation */
      SELECT r.*
        FROM eth_reconciliation r
        JOIN eth_wallets w ON w.id = r.wallet_id
       WHERE w.user_id = $1
       ORDER BY r.wallet_id, r.chain_id, r.asset_type, r.asset_key`, [userId]),
    db.query(`
      /* evm-completion:adjustments */
      SELECT a.*
        FROM eth_reconciliation_adjustments a
        JOIN eth_wallets w ON w.id = a.wallet_id
       WHERE w.user_id = $1
       ORDER BY a.wallet_id, a.chain_id, a.asset_key, a.id`, [userId]),
    db.query(`
      /* evm-completion:activity-stats */
      ${LATEST_JOB_BY_CHAIN_CTE},
      audit_boundaries AS (
        SELECT w.id AS wallet_id, latest.chain_id,
               CASE
                 WHEN (j.progress -> ('chain_' || latest.chain_id::text)
                       ->> 'boundary_block') ~ '^[0-9]+$'
                   THEN (j.progress -> ('chain_' || latest.chain_id::text)
                         ->> 'boundary_block')::bigint
                 ELSE NULL
               END AS boundary_block
          FROM latest_job_by_chain latest
          JOIN evm_audit_jobs j ON j.id = latest.job_id
          JOIN evm_subjects s
            ON s.id = latest.subject_id AND s.user_id = j.user_id
          JOIN eth_wallets w ON w.user_id = s.user_id AND w.address = s.address
      )
      SELECT t.wallet_id, t.chain_id,
             COUNT(*)::int AS total_leg_count,
             COUNT(DISTINCT t.tx_hash)::int AS distinct_tx_count,
             (COUNT(*) FILTER (
               WHERE t.transfer_type IN ('native', 'internal', 'gas')
             ))::int AS native_impact_leg_count,
             (COUNT(DISTINCT t.tx_hash) FILTER (
               WHERE t.transfer_type IN ('native', 'internal', 'gas')
             ))::int AS native_impact_distinct_tx_count,
             MAX(ab.boundary_block) AS audit_boundary_block,
             CASE WHEN MAX(ab.boundary_block) IS NULL THEN NULL ELSE
               (COUNT(DISTINCT t.tx_hash) FILTER (
                 WHERE t.transfer_type IN ('native', 'internal', 'gas')
                   AND t.block_number <= ab.boundary_block
               ))::int
             END AS native_impact_distinct_tx_count_through_audit_boundary,
             MIN(t.block_number) FILTER (
               WHERE t.transfer_type IN ('native', 'internal', 'gas')
             ) AS first_native_impact_block,
             MAX(t.block_number) FILTER (
               WHERE t.transfer_type IN ('native', 'internal', 'gas')
             ) AS last_native_impact_block,
             MIN(t.block_time) FILTER (
               WHERE t.transfer_type IN ('native', 'internal', 'gas')
             ) AS first_native_impact_at,
             MAX(t.block_time) FILTER (
               WHERE t.transfer_type IN ('native', 'internal', 'gas')
             ) AS last_native_impact_at
        FROM eth_transfers t
        JOIN eth_wallets w ON w.id = t.wallet_id
        LEFT JOIN audit_boundaries ab
          ON ab.wallet_id = t.wallet_id AND ab.chain_id = t.chain_id
       WHERE w.user_id = $1
       GROUP BY t.wallet_id, t.chain_id
       ORDER BY t.wallet_id, t.chain_id`, [userId]),
    db.query(`
      /* evm-completion:jobs */
      ${LATEST_JOB_BY_CHAIN_CTE}
      SELECT j.*, latest.chain_id AS evidence_chain_id,
             s.address AS subject_address, w.id AS mapped_wallet_id
        FROM latest_job_by_chain latest
        JOIN evm_audit_jobs j ON j.id = latest.job_id
        JOIN evm_subjects s ON s.id = j.subject_id AND s.user_id = j.user_id
        LEFT JOIN eth_wallets w ON w.user_id = j.user_id AND w.address = s.address
       ORDER BY j.subject_id, latest.chain_id`, [userId]),
    db.query(`
      /* evm-completion:scopes */
      ${LATEST_JOB_BY_CHAIN_CTE}
      SELECT sc.*, latest.subject_id
        FROM latest_job_by_chain latest
        JOIN evm_audit_scopes sc
          ON sc.job_id = latest.job_id AND sc.chain_id = latest.chain_id
       ORDER BY sc.job_id, sc.chain_id, sc.capability, sc.provider`, [userId]),
    db.query(`
      /* evm-completion:source-coverage */
      SELECT c.*
        FROM evm_source_coverage c
        JOIN evm_subjects s ON s.id = c.subject_id
       WHERE s.user_id = $1
       ORDER BY c.subject_id, c.chain_id, c.capability, c.provider,
                c.from_block, c.through_block`, [userId]),
    db.query(`
      /* evm-completion:nonce-audits */
      ${LATEST_JOB_BY_CHAIN_CTE}
      SELECT n.*
        FROM latest_job_by_chain latest
        JOIN evm_nonce_audits n
          ON n.job_id = latest.job_id AND n.chain_id = latest.chain_id
       ORDER BY n.job_id, n.chain_id`, [userId]),
    db.query(`
      /* evm-completion:balance-audits */
      ${LATEST_JOB_BY_CHAIN_CTE}
      SELECT b.*
        FROM latest_job_by_chain latest
        JOIN evm_balance_audits b
          ON b.job_id = latest.job_id AND b.chain_id = latest.chain_id
       ORDER BY b.job_id, b.chain_id, b.asset_type, b.asset_key`, [userId]),
    db.query(`
      /* evm-completion:bridge-movements */
      SELECT m.*,
             COALESCE(jsonb_agg(jsonb_build_object(
               'id', mm.id, 'wallet_id', mm.wallet_id, 'chain_id', mm.chain_id,
               'tx_hash', mm.tx_hash, 'role', mm.role, 'receipt_id', mm.receipt_id,
               'log_index', mm.log_index, 'asset_id', mm.asset_id,
               'amount', mm.amount::text, 'fee_amount', mm.fee_amount::text,
               'evidence', mm.evidence, 'created_at', mm.created_at
             ) ORDER BY mm.id) FILTER (WHERE mm.id IS NOT NULL), '[]'::jsonb) AS members
        FROM eth_bridge_movements m
        LEFT JOIN eth_bridge_movement_members mm ON mm.movement_id = m.id
       WHERE m.user_id = $1
       GROUP BY m.id
       ORDER BY m.id`, [userId]),
    db.query(`
      /* evm-completion:bridge-receipts */
      SELECT r.id, r.wallet_id, r.chain_id, r.tx_hash, r.fetch_status,
             r.provider, r.provider_boundary, r.block_number, r.block_hash,
             r.error_code, r.error_detail, r.decoder_version, r.fetched_at,
             r.invalidated_at, r.invalidation_reason
        FROM eth_bridge_receipts r
        JOIN eth_wallets w ON w.id = r.wallet_id
       WHERE w.user_id = $1
       ORDER BY r.wallet_id, r.chain_id, r.tx_hash, r.id`, [userId]),
    db.query(`
      /* evm-completion:bridge-attempts */
      SELECT a.*
        FROM eth_bridge_receipt_attempts a
        JOIN eth_wallets w ON w.id = a.wallet_id
       WHERE w.user_id = $1
       ORDER BY a.wallet_id, a.chain_id, a.tx_hash, a.attempted_at DESC, a.id DESC`, [userId]),
    db.query(`
      /* evm-completion:bridge-suggestions */
      SELECT s.*, v.id AS verdict_id, v.verdict, v.note AS verdict_note,
             v.updated_at AS verdict_updated_at
        FROM eth_bridge_suggestions s
        LEFT JOIN eth_bridge_verdicts v
          ON v.user_id = s.user_id
         AND v.out_wallet_id = s.out_wallet_id AND v.out_chain_id = s.out_chain_id
         AND v.out_tx_hash = s.out_tx_hash
         AND v.in_wallet_id = s.in_wallet_id AND v.in_chain_id = s.in_chain_id
         AND v.in_tx_hash = s.in_tx_hash
       WHERE s.user_id = $1
       ORDER BY s.created_at, s.id`, [userId]),
    db.query(`
      /* evm-completion:bridge-legs */
      SELECT a.id, a.wallet_id, a.chain_id, a.tx_hash, a.block_time,
             COALESCE(o.category, a.category) AS category, a.review_reason,
             l.id AS link_id, l.movement_id AS linked_movement_id,
             l.evidence_method, l.asset, l.out_amount::text,
             l.in_amount::text, l.fee_amount::text, l.matched_at
        FROM eth_activity a
        JOIN eth_wallets w ON w.id = a.wallet_id
        LEFT JOIN eth_activity_overrides o
          ON o.wallet_id = a.wallet_id AND o.chain_id = a.chain_id AND o.tx_hash = a.tx_hash
        LEFT JOIN eth_activity_links l
          ON l.out_activity_id = a.id OR l.in_activity_id = a.id
       WHERE w.user_id = $1
         AND COALESCE(o.category, a.category) IN ('bridge_out', 'bridge_in')
       ORDER BY a.wallet_id, a.chain_id, a.block_time, a.id`, [userId]),
    db.query(`
      /* evm-completion:own-labels */
      SELECT l.id, l.address, l.name, l.source, l.note, l.kind, l.created_at,
             w.id AS mapped_wallet_id
        FROM eth_address_labels l
        LEFT JOIN eth_wallets w ON w.user_id = l.user_id AND w.address = l.address
       WHERE l.user_id = $1 AND l.kind = 'own'
       ORDER BY l.created_at, l.id`, [userId]),
    db.query(`
      /* evm-completion:discovery-candidates */
      SELECT c.*, w.id AS mapped_wallet_id
        FROM eth_discovery_candidates c
        LEFT JOIN eth_wallets w ON w.user_id = c.user_id AND w.address = c.address
       WHERE c.user_id = $1
       ORDER BY c.status, c.score DESC NULLS LAST, c.updated_at, c.id`, [userId]),
    db.query(`
      /* evm-completion:discovery-fetches */
      SELECT f.*, c.id AS candidate_id, c.status AS candidate_status,
             c.source AS candidate_source, c.score AS candidate_score,
             w.id AS mapped_wallet_id
        FROM eth_discovery_fetches f
        LEFT JOIN eth_discovery_candidates c
          ON c.user_id = f.user_id AND c.address = f.address AND c.chain_id = f.chain_id
        LEFT JOIN eth_wallets w ON w.user_id = f.user_id AND w.address = f.address
       WHERE f.user_id = $1
       ORDER BY f.address, f.chain_id, f.depth, f.fetched_at, f.id`, [userId]),
  ];
  const results = await Promise.all(queries);
  const [
    wallets, subjects, feedCoverage, reconciliation, adjustments, activityStats,
    jobs, scopes, sourceCoverage, nonceAudits, balanceAudits, bridgeMovements,
    bridgeReceipts, bridgeReceiptAttempts, bridgeSuggestions, bridgeLegs,
    ownLabels, discoveryCandidates, discoveryFetches,
  ] = results.map(rowsFor);
  return {
    wallets, subjects, feedCoverage, reconciliation, adjustments, activityStats,
    jobs, scopes, sourceCoverage, nonceAudits, balanceAudits, bridgeMovements,
    bridgeReceipts, bridgeReceiptAttempts, bridgeSuggestions, bridgeLegs,
    ownLabels, discoveryCandidates, discoveryFetches,
  };
}

function assembleWallets(evidence, { registryChainIds = null } = {}) {
  const walletIdentity = new Map();
  const chainState = new Map();
  for (const row of evidence.wallets) {
    if (!walletIdentity.has(row.wallet_id)) {
      walletIdentity.set(row.wallet_id, {
        wallet_id: row.wallet_id,
        address: row.address,
        label: row.label,
        subject_id: row.subject_id,
        wallet_last_synced_at: row.wallet_last_synced_at,
        wallet_error_code: row.wallet_error_code,
        wallet_error_message: row.wallet_error_message,
        wallet_created_at: row.wallet_created_at,
        wallet_updated_at: row.wallet_updated_at,
      });
    }
    if (row.chain_id != null) chainState.set(key(row.wallet_id, row.chain_id), row);
  }

  const feeds = groupBy(evidence.feedCoverage, (row) => key(row.wallet_id, row.chain_id));
  const reconciliation = groupBy(evidence.reconciliation, (row) => key(row.wallet_id, row.chain_id));
  const adjustments = groupBy(evidence.adjustments, (row) => key(row.wallet_id, row.chain_id));
  const activityStats = new Map(evidence.activityStats.map((row) => [
    key(row.wallet_id, row.chain_id), row,
  ]));
  const jobsBySubjectChain = new Map(evidence.jobs.map((row) => [
    `${row.subject_id}:${row.evidence_chain_id}`, row,
  ]));
  const scopes = groupBy(evidence.scopes, (row) => `${row.subject_id}:${row.chain_id}`);
  const sourceCoverage = groupBy(
    evidence.sourceCoverage, (row) => `${row.subject_id}:${row.chain_id}`
  );
  const nonceAudits = groupBy(evidence.nonceAudits, (row) => `${row.subject_id}:${row.chain_id}`);
  const balanceAudits = groupBy(evidence.balanceAudits, (row) => `${row.subject_id}:${row.chain_id}`);
  const bridgeLegs = groupBy(evidence.bridgeLegs, (row) => key(row.wallet_id, row.chain_id));
  const bridgeReceipts = groupBy(evidence.bridgeReceipts, (row) => key(row.wallet_id, row.chain_id));
  const bridgeAttempts = groupBy(
    evidence.bridgeReceiptAttempts, (row) => key(row.wallet_id, row.chain_id)
  );

  // Attach every movement id to the corresponding bridge activity coordinate.
  for (const leg of evidence.bridgeLegs) leg.movement_references = [];
  const legByCoordinate = groupBy(
    evidence.bridgeLegs,
    (row) => `${row.wallet_id}:${row.chain_id}:${String(row.tx_hash).toLowerCase()}`
  );
  for (const movement of evidence.bridgeMovements) {
    for (const member of asArray(movement.members)) {
      const coordinate = `${member.wallet_id}:${member.chain_id}:${String(member.tx_hash).toLowerCase()}`;
      for (const leg of legByCoordinate.get(coordinate) || []) {
        leg.movement_references.push({
          movement_id: movement.id, member_id: member.id, role: member.role,
          status: movement.status, verification_method: movement.verification_method,
          evidence: movement.evidence,
          excluded_chain_id: movement.evidence?.excluded_chain_id ?? null,
          member_chain_id: member.chain_id,
          invalidated_at: movement.invalidated_at,
        });
      }
    }
  }

  const movementsByCoordinate = new Map();
  for (const movement of evidence.bridgeMovements) {
    const coordinates = new Set(asArray(movement.members).map(
      (member) => key(member.wallet_id, member.chain_id)
    ));
    for (const coordinate of coordinates) {
      if (!movementsByCoordinate.has(coordinate)) movementsByCoordinate.set(coordinate, []);
      movementsByCoordinate.get(coordinate).push(movement);
    }
  }
  const suggestionsByCoordinate = new Map();
  for (const suggestion of evidence.bridgeSuggestions) {
    const coordinates = new Set([
      key(suggestion.out_wallet_id, suggestion.out_chain_id),
      key(suggestion.in_wallet_id, suggestion.in_chain_id),
    ]);
    for (const coordinate of coordinates) {
      if (!suggestionsByCoordinate.has(coordinate)) suggestionsByCoordinate.set(coordinate, []);
      suggestionsByCoordinate.get(coordinate).push(suggestion);
    }
  }

  const inScopeRegistryChainIds = registryChainIds
    || chains.allChains().map((chain) => chain.id);
  const wallets = [];
  for (const wallet of walletIdentity.values()) {
    const chainIds = new Set(inScopeRegistryChainIds);
    // Base is a deliberate scope boundary. Migration 082 removes its ingested
    // rows, so retain one explicit excluded coordinate even when no historical
    // Base state remains to discover it implicitly.
    chainIds.add(8453);
    for (const row of evidence.wallets) {
      if (row.wallet_id === wallet.wallet_id && row.chain_id != null) chainIds.add(Number(row.chain_id));
    }
    for (const job of evidence.jobs) {
      if (String(job.subject_id) === String(wallet.subject_id)) {
        chainIds.add(Number(job.evidence_chain_id));
      }
    }
    for (const scope of evidence.scopes) {
      if (String(scope.subject_id) === String(wallet.subject_id)) chainIds.add(Number(scope.chain_id));
    }
    for (const rows of [
      evidence.feedCoverage, evidence.reconciliation, evidence.adjustments,
      evidence.activityStats, evidence.bridgeLegs, evidence.bridgeReceipts,
      evidence.bridgeReceiptAttempts,
    ]) {
      for (const row of rows) {
        if (String(row.wallet_id) === String(wallet.wallet_id) && row.chain_id != null) {
          chainIds.add(Number(row.chain_id));
        }
      }
    }
    for (const movement of evidence.bridgeMovements) {
      for (const member of asArray(movement.members)) {
        if (String(member.wallet_id) === String(wallet.wallet_id) && member.chain_id != null) {
          chainIds.add(Number(member.chain_id));
        }
      }
    }
    for (const rows of [
      evidence.sourceCoverage, evidence.nonceAudits, evidence.balanceAudits,
    ]) {
      for (const row of rows) {
        if (String(row.subject_id) === String(wallet.subject_id) && row.chain_id != null) {
          chainIds.add(Number(row.chain_id));
        }
      }
    }

    const networks = [...chainIds].filter(Number.isSafeInteger)
      .sort((left, right) => left - right).map((chainId) => {
      const coordinate = key(wallet.wallet_id, chainId);
      const subjectCoordinate = `${wallet.subject_id}:${chainId}`;
      const latestJob = jobsBySubjectChain.get(subjectCoordinate) || null;
      const network = {
        chain: chainMetadata(chainId),
        chain_state: chainState.get(coordinate) || null,
        activity_stats: activityStats.get(coordinate) || {
          wallet_id: wallet.wallet_id,
          chain_id: chainId,
          total_leg_count: 0,
          distinct_tx_count: 0,
          native_impact_leg_count: 0,
          native_impact_distinct_tx_count: 0,
          audit_boundary_block: null,
          native_impact_distinct_tx_count_through_audit_boundary: 0,
          first_native_impact_block: null,
          last_native_impact_block: null,
          first_native_impact_at: null,
          last_native_impact_at: null,
        },
        feed_coverage: feeds.get(coordinate) || [],
        reconciliation: reconciliation.get(coordinate) || [],
        reconciliation_adjustments: adjustments.get(coordinate) || [],
        latest_audit_job: latestJob,
        audit_scopes: scopes.get(subjectCoordinate) || [],
        source_coverage: sourceCoverage.get(subjectCoordinate) || [],
        nonce_audits: nonceAudits.get(subjectCoordinate) || [],
        balance_audits: balanceAudits.get(subjectCoordinate) || [],
        bridge_legs: bridgeLegs.get(coordinate) || [],
        bridge_movements: movementsByCoordinate.get(coordinate) || [],
        bridge_receipts: bridgeReceipts.get(coordinate) || [],
        bridge_receipt_attempts: bridgeAttempts.get(coordinate) || [],
        bridge_suggestions: suggestionsByCoordinate.get(coordinate) || [],
      };
      network.completion = completionForCoordinate({
        chain: network.chain,
        chainState: network.chain_state,
        activityStats: network.activity_stats,
        feedCoverage: network.feed_coverage,
        reconciliation: network.reconciliation,
        adjustments: network.reconciliation_adjustments,
        latestJob: network.latest_audit_job,
        scopes: network.audit_scopes,
        sourceCoverage: network.source_coverage,
        nonceAudits: network.nonce_audits,
        balanceAudits: network.balance_audits,
        bridgeLegs: network.bridge_legs,
        bridgeMovements: network.bridge_movements,
        bridgeSuggestions: network.bridge_suggestions,
        bridgeReceipts: network.bridge_receipts,
        bridgeReceiptAttempts: network.bridge_receipt_attempts,
      });
      return network;
      });
    wallets.push({ ...wallet, networks });
  }
  return wallets;
}

function discoveryAssessment(evidence) {
  const blockers = [];
  const limitations = [];
  const untracked = new Map();
  const addUntracked = (address, source) => {
    const normalized = String(address).toLowerCase();
    if (!untracked.has(normalized)) {
      untracked.set(normalized, { address: normalized, sources: [] });
    }
    untracked.get(normalized).sources.push(source);
  };

  for (const label of evidence.ownLabels) {
    if (label.mapped_wallet_id == null) {
      addUntracked(label.address, {
        type: 'own_label', label_id: label.id, name: label.name,
        source: label.source, created_at: label.created_at,
      });
    }
  }
  for (const candidate of evidence.discoveryCandidates) {
    if (candidate.mapped_wallet_id != null) continue;
    if (candidate.status === 'confirmed_own') {
      addUntracked(candidate.address, {
        type: 'confirmed_discovery', candidate_id: candidate.id,
        chain_id: candidate.chain_id, source: candidate.source,
        score: candidate.score, updated_at: candidate.updated_at,
      });
      if (Number(candidate.chain_id) === 8453) {
        limitations.push({
          code: 'BASE_DISCOVERY_SCOPE_EXCLUDED',
          detail: { candidate_id: candidate.id, address: candidate.address, chain_id: 8453 },
        });
      }
    } else if (candidate.status === 'pending') {
      const detail = {
        candidate_id: candidate.id, address: candidate.address,
        chain_id: candidate.chain_id, source: candidate.source,
        score: candidate.score, updated_at: candidate.updated_at,
      };
      if (Number(candidate.chain_id) === 8453) {
        limitations.push({ code: 'BASE_DISCOVERY_SCOPE_EXCLUDED', detail });
      } else {
        blockers.push({
          code: Number(candidate.chain_id) === 0
            ? 'DISCOVERY_CHAIN_UNKNOWN' : 'UNRESOLVED_DISCOVERY_CANDIDATE',
          severity: 'unverified',
          evidence: detail,
        });
      }
    }
  }
  for (const owned of untracked.values()) {
    blockers.push({
      code: 'UNTRACKED_OWN_ADDRESS',
      severity: 'incomplete',
      evidence: owned,
    });
  }
  for (const receipt of evidence.discoveryFetches) {
    if (receipt.mapped_wallet_id != null || receipt.candidate_status === 'dismissed'
      || Number(receipt.chain_id) === 8453) continue;
    const detail = {
      fetch_id: receipt.id, candidate_id: receipt.candidate_id,
      address: receipt.address, chain_id: receipt.chain_id, depth: receipt.depth,
      status: receipt.status, rows_fetched: receipt.rows_fetched,
      error_message: receipt.error_message, fetched_at: receipt.fetched_at,
    };
    if (['failed', 'truncated'].includes(receipt.status)) {
      blockers.push({
        code: 'DISCOVERY_FETCH_INCOMPLETE', severity: 'unverified', evidence: detail,
      });
    } else if (receipt.status === 'high_traffic') {
      limitations.push({ code: 'DISCOVERY_HIGH_TRAFFIC_STOP', detail });
    }
  }
  return {
    blockers,
    limitations,
    untracked_own_addresses: [...untracked.values()],
  };
}

function walletErrorIsOptionalOnly(wallet) {
  if (!['FEED_UNSUPPORTED', 'FEED_SKIPPED', 'SYNC_DEFERRED'].includes(wallet.wallet_error_code)) {
    return false;
  }
  const networks = wallet.networks.filter((network) => network.completion.verdict !== 'excluded');
  if (!networks.length) return false;
  let optionalGap = false;
  for (const network of networks) {
    const feeds = new Map(network.feed_coverage.map((row) => [row.feed, row]));
    const required = new Set(requiredNativeFeeds(network.chain));
    if ([...required].some((feed) => feeds.get(feed)?.status !== 'complete')) return false;
    if (FEEDS.some((feed) => !required.has(feed)
      && feeds.has(feed) && !['complete', 'not_applicable'].includes(feeds.get(feed).status))) {
      optionalGap = true;
    }
  }
  return optionalGap;
}

function aggregateSummary(
  schema, wallets, subjects, reportBlockers = [], reportLimitations = [], discovery = null
) {
  const networks = wallets.flatMap((wallet) => wallet.networks);
  const blockers = networks.flatMap((network) => network.completion.blockers);
  const limitations = networks.flatMap((network) => network.completion.source_limitations);
  return {
    schema_compatible: schema.compatible,
    schema_missing_tables: schema.missing_tables.length,
    schema_missing_columns: schema.missing_columns.length,
    wallets: wallets.length,
    subjects: subjects.length,
    unmapped_subjects: subjects.filter((subject) => subject.mapped_wallet_id == null).length,
    report_blockers: reportBlockers.length,
    report_blockers_by_code: countBy(reportBlockers, (blocker) => blocker.code),
    report_limitations: reportLimitations.length,
    report_limitations_by_code: countBy(reportLimitations, (limitation) => limitation.code),
    own_address_labels: discovery?.own_labels?.length || 0,
    discovery_candidates: discovery?.candidates?.length || 0,
    discovery_candidates_by_status: countBy(
      discovery?.candidates || [], (candidate) => candidate.status
    ),
    discovery_fetches: discovery?.fetches?.length || 0,
    discovery_fetches_by_status: countBy(discovery?.fetches || [], (receipt) => receipt.status),
    untracked_own_addresses: discovery?.untracked_own_addresses?.length || 0,
    wallet_networks: networks.length,
    wallet_networks_by_verdict: countBy(networks, (network) => network.completion.verdict),
    blockers: blockers.length,
    blockers_by_code: countBy(blockers, (blocker) => blocker.code),
    source_limitations: limitations.length,
    source_limitations_by_code: countBy(limitations, (limitation) => limitation.code),
  };
}

async function buildReport(userId, db = pool, options = {}) {
  if (!Number.isSafeInteger(Number(userId)) || Number(userId) < 1) {
    throw new Error('userId must be a positive integer');
  }
  const schema = await inspectSchema(db);
  if (!schema.compatible) {
    return {
      generated_at: new Date().toISOString(),
      user_id: Number(userId),
      read_only: true,
      report_type: 'private_evm_completion_evidence',
      policy: 'Schema incompatibility is terminal for this report; no compatibility fallback or completeness inference was used.',
      schema,
      summary: aggregateSummary(schema, [], [], []),
      overall_verdict: 'schema_incompatible',
      report_blockers: [],
      report_limitations: [],
      discovery_evidence: {
        own_labels: [], candidates: [], fetches: [], untracked_own_addresses: [],
      },
      subjects: [],
      wallets: [],
    };
  }
  const evidence = await readEvidence(db, Number(userId));
  const wallets = assembleWallets(evidence, options);
  const networks = wallets.flatMap((wallet) => wallet.networks);
  const inScopeNetworks = networks.filter((network) => network.completion.verdict !== 'excluded');
  const discoveryResult = discoveryAssessment(evidence);
  const discoveryEvidence = {
    own_labels: evidence.ownLabels,
    candidates: evidence.discoveryCandidates,
    fetches: evidence.discoveryFetches,
    untracked_own_addresses: discoveryResult.untracked_own_addresses,
  };
  const reportBlockers = [...evidence.subjects
    .filter((subject) => subject.mapped_wallet_id == null)
    .map((subject) => ({
      code: 'UNMAPPED_EVM_SUBJECT',
      severity: 'unverified',
      evidence: {
        subject_id: subject.id,
        address: subject.address,
        created_at: subject.created_at,
        updated_at: subject.updated_at,
      },
    })), ...discoveryResult.blockers];
  const reportLimitations = [
    ...discoveryResult.limitations,
    {
      code: 'FORGOTTEN_WALLET_DISCOVERY_NOT_EXHAUSTIVELY_PROVEN',
      detail: 'The current discovery model persists candidates and per-address fetches, but no run-level receipt proves that a zero-result address-universe scan occurred.',
    },
  ];
  for (const wallet of wallets) {
    if (!wallet.wallet_error_code) continue;
    if (walletErrorIsOptionalOnly(wallet)) {
      reportLimitations.push({
        code: 'OPTIONAL_WALLET_FEED_LIMITATION',
        detail: {
          wallet_id: wallet.wallet_id,
          address: wallet.address,
          error_code: wallet.wallet_error_code,
          error_message: wallet.wallet_error_message,
          last_synced_at: wallet.wallet_last_synced_at,
          updated_at: wallet.wallet_updated_at,
        },
      });
      continue;
    }
    reportBlockers.push({
      code: 'WALLET_SYNC_ERROR',
      severity: wallet.wallet_error_code === 'SYNC_DEFERRED' ? 'unverified' : 'incomplete',
      evidence: {
        wallet_id: wallet.wallet_id,
        address: wallet.address,
        error_code: wallet.wallet_error_code,
        error_message: wallet.wallet_error_message,
        last_synced_at: wallet.wallet_last_synced_at,
        updated_at: wallet.wallet_updated_at,
      },
    });
  }
  const networkVerdict = wallets.length === 0
    ? 'no_wallets'
    : inScopeNetworks.length === 0
      ? 'no_in_scope_networks'
      : inScopeNetworks.some((network) => network.completion.verdict === 'incomplete')
        ? 'incomplete'
        : inScopeNetworks.some((network) => network.completion.verdict === 'unverified')
          ? 'unverified'
          : inScopeNetworks.some((network) => (
            network.completion.verdict === 'complete_through_boundary_with_limitations'
          ))
            ? 'complete_through_boundary_with_limitations'
            : 'complete_through_boundary';
  const overallVerdict = reportBlockers.some((blocker) => blocker.severity === 'incomplete')
    || networkVerdict === 'incomplete'
    ? 'incomplete'
    : reportBlockers.length || networkVerdict === 'unverified'
      ? 'unverified'
      : reportLimitations.length && networkVerdict === 'complete_through_boundary'
        ? 'complete_through_boundary_with_limitations'
        : networkVerdict;
  return {
    generated_at: new Date().toISOString(),
    user_id: Number(userId),
    read_only: true,
    report_type: 'private_evm_completion_evidence',
    policy: 'Exact evidence through explicit block/time boundaries only; no wall-clock currentness inference, guessed movements, inferred adjustments, exchange raw data, public-safe detail, or compatibility fallback.',
    schema,
    summary: aggregateSummary(
      schema, wallets, evidence.subjects, reportBlockers, reportLimitations, discoveryEvidence
    ),
    overall_verdict: overallVerdict,
    report_blockers: reportBlockers,
    report_limitations: reportLimitations,
    discovery_evidence: discoveryEvidence,
    subjects: evidence.subjects,
    wallets,
  };
}

async function buildReportInSnapshot(userId) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const report = await buildReport(userId, client);
    await client.query('COMMIT');
    return report;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

function errorMessage(error) {
  if (error?.message) return error.message;
  if (Array.isArray(error?.errors) && error.errors.length) {
    return error.errors.map((nested) => (
      [nested.code, nested.message].filter(Boolean).join(': ') || nested.name || 'unknown error'
    )).join('; ');
  }
  return error?.code || error?.name || 'unknown error';
}

async function main(argv = process.argv) {
  const userId = requiredPositiveInteger('--user-id', argv);
  const outputPath = option('--output', argv);
  if (!outputPath) throw new Error('--output is required; detailed EVM evidence is private');
  const report = await buildReportInSnapshot(userId);
  writePrivateReport(outputPath, report);
  process.stdout.write(`${JSON.stringify(report.summary)}\n`);
  if (!report.schema.compatible) process.exitCode = 2;
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`EVM completion report failed: ${errorMessage(error)}`);
    process.exitCode = 1;
  }).finally(() => pool.end().catch(() => {}));
}

module.exports = {
  AUDIT_PROGRESS_CONTRACT,
  FEEDS,
  REQUIRED_SCHEMA,
  aggregateSummary,
  assembleWallets,
  buildReport,
  completionForCoordinate,
  errorMessage,
  inspectSchema,
  main,
  requiredPositiveInteger,
  writePrivateReport,
};

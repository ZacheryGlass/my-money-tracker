'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = 'postgresql://test:test@localhost/test';
process.env.ETH_CHAINS = '1';

const {
  FEEDS,
  REQUIRED_SCHEMA,
  buildReport: buildReportAllChains,
  completionForCoordinate,
  errorMessage,
  writePrivateReport,
} = require('../scripts/report-evm-completion');
const {
  BASE_EXCLUSION_ENDPOINTS,
} = require('../src/services/evmAudit/completionPolicy');

const buildReport = (userId, db) => buildReportAllChains(
  userId, db, { registryChainIds: [1] }
);

function schemaRows() {
  return Object.entries(REQUIRED_SCHEMA).flatMap(([table_name, columns]) => (
    columns.map((column_name) => ({ table_name, column_name }))
  ));
}

function currentAuditProgress(overrides = {}) {
  return {
    contract_version: 2,
    boundary_block: 100,
    transactions: 3,
    native_relevant_transactions: 3,
    provider_lookup_gaps: 0,
    transaction_conflicts: 0,
    transaction_native_conflicts: 0,
    transaction_optional_conflicts: 0,
    capability_gaps: 0,
    nonce_gaps: 0,
    native_balance_match: true,
    token_balance_gaps: 0,
    historical_token_balance_gap: 0,
    historical_token_checks: 0,
    historical_token_deferred: 0,
    historical_token_failures: 0,
    historical_token_mismatches: 0,
    asset_universe_contracts: 0,
    asset_universe_observed_only: 0,
    asset_universe_basis: 'derived_ledger_plus_durable_erc20_observations',
    indexed_token_log_enumeration_gap: 0,
    indexed_token_log_coverage_basis: 'consensus_rpc_address_indexed_token_logs_v1',
    internal_trace_enumeration_complete: true,
    internal_trace_coverage_basis: 'synthetic_complete_trace_walk',
    receipt_enumeration_gap: 1,
    historical_state_gap: 1,
    archive_depth_gap: 0,
    archive_balance_gap: 0,
    archive_probe_block: 25,
    archive_probe_status: 'available',
    balance_coverage_basis: 'consensus_rpc_point_checks_at_finalized_boundary_v1',
    credential_feed_gap: 0,
    credential_feed_error: null,
    corroborated_identity_repairs: 0,
    missing_activity: 0,
    missing_native_activity: 0,
    missing_optional_activity: 0,
    unresolved_bridges: [],
    provisional_effects: 0,
    provisional_native_effects: 0,
    provisional_optional_effects: 0,
    unmatched_effects: 0,
    unmatched_native_effects: 0,
    unmatched_optional_effects: 0,
    unsupported_capabilities: [],
    ...overrides,
  };
}

function completeFixture() {
  const job = {
    id: '90', subject_id: '70', requested_wallet_id: 10, mapped_wallet_id: 10,
    evidence_chain_id: 1,
    mode: 'full', status: 'complete_with_gaps', stage: 'complete', requested_chains: [1],
    discovered_chains: [1],
    progress: {
      chain_1: currentAuditProgress(),
    },
    requested_at: '2026-09-19T00:00:00Z',
    finished_at: '2026-09-19T00:05:00Z',
    error_code: null,
  };
  return {
    wallets: [{
      wallet_id: 10,
      address: '0x1111111111111111111111111111111111111111',
      label: 'Synthetic wallet',
      subject_id: '70',
      wallet_error_code: null,
      wallet_error_message: null,
      chain_id: 1,
      last_block_normal: '100',
      last_block_internal: '100',
      last_block_token: '100',
      last_block_nft: '100',
      last_block_1155: '100',
      last_block_statesync: '0',
      unsupported_feeds: [],
      chain_error_code: null,
      chain_error_message: null,
      chain_last_synced_at: '2026-09-19T00:00:00Z',
      ingest_version: 1,
      coverage_recapture_version: 1,
    }],
    subjects: [{
      id: '70', user_id: 7,
      address: '0x1111111111111111111111111111111111111111', mapped_wallet_id: 10,
    }],
    feeds: FEEDS.map((feed, index) => ({
      wallet_id: 10, chain_id: 1, feed,
      cursor_kind: 'evm_block', provider: 'Etherscan V2',
      status: feed === 'statesync' ? 'not_applicable'
        : ['token', 'nft'].includes(feed) ? 'failed' : 'complete',
      covered_from_block: ['statesync', 'token', 'nft'].includes(feed) ? null : '0',
      covered_through_block: ['statesync', 'token', 'nft'].includes(feed) ? null : '100',
      indexed_head: feed === 'statesync' ? null : '100',
      last_attempt_at: `2026-09-19T00:00:0${index}Z`,
      last_success_at: ['statesync', 'token', 'nft'].includes(feed)
        ? null : '2026-09-19T00:01:00Z',
      error_code: ['token', 'nft'].includes(feed) ? 'SYNTHETIC_OPTIONAL_FAILURE' : null,
    })),
    reconciliation: [{
      id: 20, wallet_id: 10, chain_id: 1, asset_key: 'ETH', asset_type: 'native',
      derived_units: '1230000000000000000', live_units: '1230000000000000000',
      delta_units: '0', status: 'match', skip_reason: null,
      checked_at: '2026-09-19T00:03:00Z',
    }],
    adjustments: [],
    activityStats: [{
      wallet_id: 10, chain_id: 1, total_leg_count: 4, distinct_tx_count: 3,
      native_impact_leg_count: 3, native_impact_distinct_tx_count: 3,
      audit_boundary_block: '100',
      native_impact_distinct_tx_count_through_audit_boundary: 3,
      first_native_impact_block: '1', last_native_impact_block: '100',
      first_native_impact_at: '2026-09-01T00:00:00Z',
      last_native_impact_at: '2026-09-19T00:00:00Z',
    }],
    jobs: [job],
    scopes: [
      {
        id: '91', job_id: '90', subject_id: '70', chain_id: 1,
        provider: 'etherscan', capability: 'normal', status: 'complete',
        requested_from_block: '0', requested_through_block: '100',
        requested_through_hash: `0x${'a'.repeat(64)}`,
        pagination_exhausted: true, pages_committed: 2, items_committed: 3,
        provider_order: 'oldest_first', coverage_basis: 'synthetic_complete_walk',
      },
      {
        id: '95', job_id: '90', subject_id: '70', chain_id: 1,
        provider: 'etherscan', capability: 'internal', status: 'complete',
        requested_from_block: '0', requested_through_block: '100',
        requested_through_hash: `0x${'a'.repeat(64)}`,
        pagination_exhausted: true, pages_committed: 1, items_committed: 1,
      },
      {
        id: '96', job_id: '90', subject_id: '70', chain_id: 1,
        provider: 'trace-rpc', capability: 'internal', status: 'unsupported',
        requested_from_block: '0', requested_through_block: '100',
        pagination_exhausted: false, error_code: 'RPC_TRACE_NOT_CONFIGURED',
      },
    ],
    sourceCoverage: [
      {
        id: '89', subject_id: '70', chain_id: 1, provider: 'old-provider',
        capability: 'normal', from_block: '0', through_block: '10',
        pagination_exhausted: false, status: 'failed', source_job_id: '80',
      },
      {
        id: '92', subject_id: '70', chain_id: 1, provider: 'etherscan',
        capability: 'normal', from_block: '0', through_block: '100',
        through_block_hash: `0x${'a'.repeat(64)}`,
        pagination_exhausted: true, status: 'complete', source_job_id: '90',
      },
      {
        id: '97', subject_id: '70', chain_id: 1, provider: 'etherscan',
        capability: 'internal', from_block: '0', through_block: '100',
        through_block_hash: `0x${'a'.repeat(64)}`,
        pagination_exhausted: true, status: 'complete', source_job_id: '90',
      },
    ],
    nonceAudits: [{
      id: '93', job_id: '90', subject_id: '70', chain_id: 1,
      boundary_block: '100', boundary_block_hash: `0x${'a'.repeat(64)}`,
      next_mined_nonce: '3', observed_outgoing_count: 3,
      missing_nonces: [], conflicting_nonces: [], unknown_signedness_count: 0,
      status: 'complete',
      checked_at: '2026-09-19T00:04:00Z',
    }],
    balanceAudits: [{
      id: '94', job_id: '90', subject_id: '70', chain_id: 1,
      asset_key: 'native', asset_type: 'native', boundary_block: '100',
      derived_units: '1230000000000000000', live_units: '1230000000000000000',
      delta_units: '0', status: 'match',
      checked_at: '2026-09-19T00:04:00Z',
      detail: {
        boundary_hash: `0x${'a'.repeat(64)}`,
        archive_check: {
          status: 'available', block: 25, block_tag: '0x19',
          derived_units: '1', live_units: '1', delta_units: '0',
        },
      },
    }],
    bridgeMovements: [{
      id: '120', status: 'unsupported', verification_method: 'protocol_identity',
      invalidated_at: null,
      members: [{
        id: '121', wallet_id: 10, chain_id: 1,
        tx_hash: `0x${'c'.repeat(64)}`, role: 'initiation',
      }],
    }],
    bridgeReceipts: [],
    bridgeAttempts: [{
      id: '122', wallet_id: 10, chain_id: 1, tx_hash: `0x${'c'.repeat(64)}`,
      status: 'unsupported', error_code: 'SYNTHETIC_RECEIPT_LIMIT',
    }],
    bridgeSuggestions: [{
      id: '123', out_wallet_id: 10, out_chain_id: 1,
      out_tx_hash: `0x${'c'.repeat(64)}`, in_wallet_id: 10, in_chain_id: 10,
      in_tx_hash: `0x${'d'.repeat(64)}`, suggestion_reason: 'unsupported_protocol_path',
      ambiguous: true, verdict: null,
    }],
    bridgeLegs: [{
      id: '124', wallet_id: 10, chain_id: 1, tx_hash: `0x${'c'.repeat(64)}`,
      category: 'bridge_out', link_id: '125', linked_movement_id: '126',
    }],
    ownLabels: [],
    discoveryCandidates: [],
    discoveryFetches: [],
  };
}

function fakeDatabase(fixture) {
  const tags = {
    wallets: 'wallets',
    subjects: 'subjects',
    feeds: 'feeds',
    reconciliation: 'reconciliation',
    adjustments: 'adjustments',
    'activity-stats': 'activityStats',
    jobs: 'jobs',
    scopes: 'scopes',
    'source-coverage': 'sourceCoverage',
    'nonce-audits': 'nonceAudits',
    'balance-audits': 'balanceAudits',
    'bridge-movements': 'bridgeMovements',
    'bridge-receipts': 'bridgeReceipts',
    'bridge-attempts': 'bridgeAttempts',
    'bridge-suggestions': 'bridgeSuggestions',
    'bridge-legs': 'bridgeLegs',
    'own-labels': 'ownLabels',
    'discovery-candidates': 'discoveryCandidates',
    'discovery-fetches': 'discoveryFetches',
  };
  return {
    calls: [],
    async query(sql) {
      this.calls.push(sql);
      if (/evm-completion:schema/.test(sql)) return { rows: schemaRows() };
      const match = sql.match(/evm-completion:([a-z-]+)/);
      const fixtureKey = match && tags[match[1]];
      if (!fixtureKey) throw new Error(`Unexpected query: ${sql}`);
      return { rows: fixture[fixtureKey] || [] };
    },
  };
}

test('completion report keeps exact matching evidence and produces an explicit verdict', async () => {
  const fixture = completeFixture();
  const db = fakeDatabase(fixture);
  const report = await buildReport(7, db);

  assert.equal(report.schema.compatible, true);
  assert.equal(report.overall_verdict, 'complete_through_boundary_with_limitations');
  assert.deepEqual(report.summary.wallet_networks_by_verdict, {
    complete_through_boundary_with_limitations: 1,
    excluded: 1,
  });
  const network = report.wallets[0].networks[0];
  assert.equal(network.chain.id, 1);
  assert.equal(network.feed_coverage.length, 6);
  assert.equal(network.activity_stats.native_impact_leg_count, 3);
  assert.equal(network.reconciliation[0].status, 'match');
  assert.equal(network.reconciliation[0].derived_units, '1230000000000000000');
  assert.equal(network.latest_audit_job.id, '90');
  assert.equal(network.audit_scopes[0].id, '91');
  assert.equal(network.nonce_audits[0].id, '93');
  assert.equal(network.balance_audits[0].detail.archive_check.status, 'available');
  assert.equal(network.completion.verdict, 'complete_through_boundary_with_limitations');
  assert.deepEqual(network.completion.blockers, []);
  const limitationCodes = new Set(network.completion.source_limitations.map((row) => row.code));
  assert.ok(limitationCodes.has('OPTIONAL_FEED_NOT_COMPLETE'));
  assert.ok(limitationCodes.has('SECONDARY_AUDIT_SCOPE_NOT_COMPLETE'));
  assert.ok(limitationCodes.has('HISTORICAL_STATE_POINT_CHECK_LIMIT'));
  assert.ok(limitationCodes.has('RECEIPT_ENUMERATION_POINT_LOOKUP_LIMIT'));
  assert.ok(limitationCodes.has('UNRESOLVED_BRIDGE_CANDIDATE'));
  assert.ok(limitationCodes.has('DIAGNOSTIC_BRIDGE_MOVEMENT_NOT_RESOLVED'));
  const aggregateOnly = JSON.stringify(report.summary);
  assert.doesNotMatch(aggregateOnly, /0x1111111111111111111111111111111111111111/);
  assert.doesNotMatch(aggregateOnly, /1230000000000000000/);
  assert.ok(report.report_limitations.some(
    (row) => row.code === 'FORGOTTEN_WALLET_DISCOVERY_NOT_EXHAUSTIVELY_PROVEN'
  ));
});

test('completion report fails the coordinate closed on balance and bridge gaps', async () => {
  const fixture = completeFixture();
  fixture.reconciliation[0] = {
    ...fixture.reconciliation[0], status: 'mismatch', delta_units: '9',
  };
  fixture.bridgeLegs = [{
    id: '110', wallet_id: 10, chain_id: 1, tx_hash: `0x${'b'.repeat(64)}`,
    category: 'bridge_out', link_id: null,
  }];
  fixture.bridgeAttempts = [{
    id: '111', wallet_id: 10, chain_id: 1, tx_hash: `0x${'b'.repeat(64)}`,
    status: 'unsupported', error_code: 'NO_RECEIPT_PROVIDER',
  }];
  const report = await buildReport(7, fakeDatabase(fixture));
  const completion = report.wallets[0].networks[0].completion;

  assert.equal(report.overall_verdict, 'incomplete');
  assert.equal(completion.verdict, 'incomplete');
  assert.ok(completion.blockers.some((row) => row.code === 'NATIVE_RECONCILIATION_NOT_EXACT'));
  assert.ok(completion.blockers.some((row) => row.code === 'UNRESOLVED_BRIDGE_LEG'));
  assert.ok(completion.source_limitations.some((row) => row.code === 'BRIDGE_RECEIPT_UNAVAILABLE'));
});

test('the stored ledger projection cannot satisfy independent enumeration coverage', async () => {
  const fixture = completeFixture();
  fixture.scopes = fixture.scopes.map((row) => (
    ['normal', 'internal'].includes(row.capability)
      ? { ...row, provider: 'existing-ledger' } : row
  ));
  fixture.sourceCoverage = [];
  const report = await buildReport(7, fakeDatabase(fixture));
  const blockers = report.wallets[0].networks[0].completion.blockers;

  assert.ok(blockers.some((row) => row.code === 'REQUIRED_AUDIT_CAPABILITY_NOT_COVERED'
    && row.evidence.capability === 'normal'));
  assert.ok(blockers.some((row) => row.code === 'REQUIRED_AUDIT_CAPABILITY_NOT_COVERED'
    && row.evidence.capability === 'internal'));
});

test('native balance audits use the producer asset key rather than the chain ticker', async () => {
  const fixture = completeFixture();
  assert.equal(fixture.balanceAudits[0].asset_key, 'native');
  const report = await buildReport(7, fakeDatabase(fixture));
  const blockers = report.wallets[0].networks[0].completion.blockers;

  assert.ok(!blockers.some((row) => row.code === 'MISSING_NATIVE_BALANCE_AUDIT'));
});

test('stale chain ingest versions cannot certify current history', async () => {
  const fixture = completeFixture();
  fixture.wallets[0] = {
    ...fixture.wallets[0], chain_id: 10, ingest_version: 0,
  };
  const report = await buildReport(7, fakeDatabase(fixture));
  const optimism = report.wallets[0].networks.find((row) => row.chain.id === 10);

  assert.ok(optimism.completion.blockers.some(
    (row) => row.code === 'STALE_CHAIN_INGEST_VERSION'
  ));
});

test('required feed provenance and recapture versions must match current routing', async () => {
  const fixture = completeFixture();
  fixture.wallets[0].coverage_recapture_version = 0;
  fixture.feeds.find((row) => row.feed === 'normal').provider = 'retired fixture provider';
  fixture.feeds.find((row) => row.feed === 'internal').cursor_kind = 'archive_serial';
  const report = await buildReport(7, fakeDatabase(fixture));
  const blockers = report.wallets[0].networks[0].completion.blockers;

  assert.ok(blockers.some((row) => row.code === 'COVERAGE_RECAPTURE_NOT_CURRENT'));
  assert.ok(blockers.some((row) => row.code === 'FEED_PROVIDER_MISMATCH'));
  assert.ok(blockers.some((row) => row.code === 'FEED_CURSOR_KIND_MISMATCH'));
});

test('malformed nonce and balance evidence cannot produce a complete verdict', async () => {
  const fixture = completeFixture();
  Object.assign(fixture.nonceAudits[0], {
    next_mined_nonce: null,
    observed_outgoing_count: 0,
  });
  Object.assign(fixture.balanceAudits[0], {
    derived_units: null,
    live_units: null,
    delta_units: '0',
  });
  Object.assign(fixture.balanceAudits[0].detail.archive_check, {
    derived_units: null,
    live_units: null,
    delta_units: '0',
  });
  const report = await buildReport(7, fakeDatabase(fixture));
  const blockers = report.wallets[0].networks[0].completion.blockers;

  assert.ok(blockers.some((row) => row.code === 'MALFORMED_NONCE_AUDIT_EVIDENCE'));
  assert.ok(blockers.some((row) => row.code === 'MALFORMED_NATIVE_BALANCE_AUDIT_EVIDENCE'));
  assert.ok(blockers.some((row) => row.code === 'MALFORMED_ARCHIVE_BALANCE_EVIDENCE'));
});

test('audit progress balance mismatch and an unfinished successful stage block completion', async () => {
  const fixture = completeFixture();
  fixture.jobs[0].progress.chain_1.native_balance_match = false;
  fixture.jobs[0].stage = 'balance_reconciliation';
  const report = await buildReport(7, fakeDatabase(fixture));
  const blockers = report.wallets[0].networks[0].completion.blockers;

  assert.ok(blockers.some((row) => row.code === 'NATIVE_BALANCE_PROGRESS_MISMATCH'));
  assert.ok(blockers.some(
    (row) => row.code === 'NATIVE_BALANCE_PROGRESS_EVIDENCE_CONFLICT'
  ));
  assert.ok(blockers.some((row) => row.code === 'AUDIT_JOB_STAGE_NOT_COMPLETE'));
});

test('audit transaction and stored native activity counts must cover complete nonce evidence', async () => {
  const fixture = completeFixture();
  fixture.jobs[0].progress.chain_1.transactions = 2;
  fixture.jobs[0].progress.chain_1.native_relevant_transactions = 2;
  fixture.activityStats[0].native_impact_leg_count = 2;
  fixture.activityStats[0].native_impact_distinct_tx_count = 2;
  fixture.activityStats[0].native_impact_distinct_tx_count_through_audit_boundary = 2;
  const report = await buildReport(7, fakeDatabase(fixture));
  const blockers = report.wallets[0].networks[0].completion.blockers;

  assert.ok(blockers.some(
    (row) => row.code === 'AUDIT_TRANSACTION_COUNT_BELOW_NONCE_EVIDENCE'
  ));
  assert.ok(blockers.some(
    (row) => row.code === 'STORED_NATIVE_ACTIVITY_BELOW_NONCE_EVIDENCE'
  ));
});

test('native relevance cannot fall below complete EOA nonce evidence', async () => {
  const fixture = completeFixture();
  fixture.jobs[0].progress.chain_1.native_relevant_transactions = 0;
  const report = await buildReport(7, fakeDatabase(fixture));
  const blockers = report.wallets[0].networks[0].completion.blockers;

  assert.ok(blockers.some(
    (row) => row.code === 'AUDIT_NATIVE_RELEVANCE_BELOW_NONCE_EVIDENCE'
  ));
});

test('post-boundary native activity cannot mask missing audited activity', async () => {
  const fixture = completeFixture();
  fixture.activityStats[0].native_impact_distinct_tx_count_through_audit_boundary = 0;
  const report = await buildReport(7, fakeDatabase(fixture));
  const blockers = report.wallets[0].networks[0].completion.blockers;

  assert.ok(blockers.some((row) => row.code === 'STORED_NATIVE_ACTIVITY_BEHIND_AUDIT'));
  assert.ok(blockers.some(
    (row) => row.code === 'STORED_NATIVE_ACTIVITY_BELOW_NONCE_EVIDENCE'
  ));
});

test('stored native activity must cover the producer native-relevance manifest', async () => {
  const fixture = completeFixture();
  fixture.activityStats = [];
  const report = await buildReport(7, fakeDatabase(fixture));
  const blockers = report.wallets[0].networks[0].completion.blockers;

  assert.ok(blockers.some((row) => row.code === 'STORED_NATIVE_ACTIVITY_BEHIND_AUDIT'));
  assert.ok(blockers.some(
    (row) => row.code === 'STORED_NATIVE_ACTIVITY_BELOW_NONCE_EVIDENCE'
  ));
});

test('malformed stored activity counters cannot certify completion', async () => {
  const fixture = completeFixture();
  fixture.activityStats[0].native_impact_distinct_tx_count = -1;
  const report = await buildReport(7, fakeDatabase(fixture));
  const blocker = report.wallets[0].networks[0].completion.blockers.find(
    (row) => row.code === 'MALFORMED_ACTIVITY_STATS'
  );

  assert.ok(blocker);
  assert.ok(blocker.evidence.fields.includes('native_impact_distinct_tx_count'));
});

test('audit progress requires the full current payload and nonnegative typed counters', async () => {
  const fixture = completeFixture();
  delete fixture.jobs[0].progress.chain_1.transactions;
  fixture.jobs[0].progress.chain_1.provider_lookup_gaps = -1;
  fixture.jobs[0].progress.chain_1.unresolved_bridges = 0;
  fixture.jobs[0].progress.chain_1.unsupported_capabilities = {};
  const report = await buildReport(7, fakeDatabase(fixture));
  const blocker = report.wallets[0].networks[0].completion.blockers.find(
    (row) => row.code === 'AUDIT_PROGRESS_CONTRACT_VIOLATION'
  );

  assert.ok(blocker);
  assert.equal(blocker.evidence.contract_version, 2);
  assert.ok(blocker.evidence.missing_fields.includes('transactions'));
  assert.deepEqual(new Set(blocker.evidence.malformed_fields.map((row) => row.field)), new Set([
    'provider_lookup_gaps', 'unresolved_bridges', 'unsupported_capabilities',
  ]));
});

test('audit progress rejects absent and stale contract versions', async () => {
  for (const contractVersion of [undefined, 1]) {
    const fixture = completeFixture();
    if (contractVersion === undefined) {
      delete fixture.jobs[0].progress.chain_1.contract_version;
    } else {
      fixture.jobs[0].progress.chain_1.contract_version = contractVersion;
    }
    const report = await buildReport(7, fakeDatabase(fixture));
    const blocker = report.wallets[0].networks[0].completion.blockers.find(
      (row) => row.code === 'AUDIT_PROGRESS_CONTRACT_VIOLATION'
    );

    assert.ok(blocker);
    if (contractVersion === undefined) {
      assert.ok(blocker.evidence.missing_fields.includes('contract_version'));
    } else {
      assert.deepEqual(blocker.evidence.malformed_fields.find(
        (row) => row.field === 'contract_version'
      ), { field: 'contract_version', expected: 'exact_version_2' });
    }
  }
});

test('archive probe evidence must use the progress block, canonical tag, and status', async () => {
  const fixture = completeFixture();
  Object.assign(fixture.balanceAudits[0].detail.archive_check, {
    block: 26, block_tag: '0x019', status: 'mismatch',
  });
  const report = await buildReport(7, fakeDatabase(fixture));
  const blocker = report.wallets[0].networks[0].completion.blockers.find(
    (row) => row.code === 'ARCHIVE_PROBE_COORDINATE_MISMATCH'
  );

  assert.ok(blocker);
  assert.equal(blocker.evidence.progress_archive_probe_block, 25);
  assert.equal(blocker.evidence.archive_block, 26);
  assert.equal(blocker.evidence.expected_archive_block_tag, '0x1a');
});

test('EOA nonce completeness is explicitly not applicable to a contract wallet', async () => {
  const fixture = completeFixture();
  Object.assign(fixture.nonceAudits[0], {
    status: 'unsupported',
    error_code: 'SUBJECT_IS_CONTRACT',
    error_detail: 'Nonce completeness applies only to EOAs.',
    next_mined_nonce: null,
    observed_outgoing_count: 0,
  });
  const report = await buildReport(7, fakeDatabase(fixture));
  const completion = report.wallets[0].networks[0].completion;

  assert.ok(!completion.blockers.some((row) => row.code === 'NONCE_AUDIT_NOT_COMPLETE'));
  assert.ok(!completion.blockers.some((row) => row.code === 'MALFORMED_NONCE_AUDIT_EVIDENCE'));
  assert.ok(completion.source_limitations.some(
    (row) => row.code === 'EOA_NONCE_AUDIT_NOT_APPLICABLE'
  ));
});

test('aggregate optional capability and token effect gaps remain explicit limitations', async () => {
  const fixture = completeFixture();
  Object.assign(fixture.jobs[0].progress.chain_1, {
    capability_gaps: 3,
    transaction_conflicts: 1,
    transaction_native_conflicts: 0,
    transaction_optional_conflicts: 1,
    missing_activity: 1,
    missing_native_activity: 0,
    missing_optional_activity: 1,
    provisional_effects: 1,
    provisional_native_effects: 0,
    provisional_optional_effects: 1,
    unmatched_effects: 2,
    unmatched_native_effects: 0,
    unmatched_optional_effects: 2,
  });
  const report = await buildReport(7, fakeDatabase(fixture));
  const completion = report.wallets[0].networks[0].completion;

  assert.ok(!completion.blockers.some((row) => [
    'NATIVE_TRANSACTION_CONFLICT', 'MISSING_NATIVE_ACTIVITY',
    'PROVISIONAL_NATIVE_EFFECT', 'UNMATCHED_NATIVE_EFFECT', 'REQUIRED_CAPABILITY_GAP',
  ].includes(row.code)));
  const limitations = new Set(completion.source_limitations.map((row) => row.code));
  assert.ok(limitations.has('AGGREGATE_CAPABILITY_GAP'));
  assert.ok(limitations.has('OPTIONAL_ASSET_TRANSACTION_CONFLICT'));
  assert.ok(limitations.has('OPTIONAL_ASSET_MISSING_ACTIVITY'));
  assert.ok(limitations.has('OPTIONAL_ASSET_PROVISIONAL_EFFECT'));
  assert.ok(limitations.has('OPTIONAL_ASSET_UNMATCHED_EFFECT'));
});

test('legacy aggregate effect gaps without typed evidence fail closed', async () => {
  const fixture = completeFixture();
  fixture.jobs[0].progress.chain_1.unmatched_effects = 1;
  delete fixture.jobs[0].progress.chain_1.unmatched_native_effects;
  delete fixture.jobs[0].progress.chain_1.unmatched_optional_effects;
  const report = await buildReport(7, fakeDatabase(fixture));
  const completion = report.wallets[0].networks[0].completion;

  assert.ok(completion.blockers.some(
    (row) => row.code === 'UNCLASSIFIED_NATIVE_RELEVANCE_GAP'
  ));
});

test('a reconciliation adjustment blocks raw-ledger completeness', async () => {
  const fixture = completeFixture();
  fixture.adjustments = [{
    id: 21, wallet_id: 10, chain_id: 1, asset_key: 'ETH', amount_wei: '-3',
    note: 'Synthetic documented adjustment',
  }];
  const report = await buildReport(7, fakeDatabase(fixture));
  const completion = report.wallets[0].networks.find((row) => row.chain.id === 1).completion;

  assert.equal(completion.verdict, 'incomplete');
  assert.ok(completion.blockers.some(
    (row) => row.code === 'RECONCILIATION_ADJUSTMENT_REQUIRED'
  ));
});

test('an unmapped audited subject blocks a complete overall verdict', async () => {
  const fixture = completeFixture();
  fixture.subjects.push({
    id: '71', user_id: 7,
    address: '0x2222222222222222222222222222222222222222', mapped_wallet_id: null,
    created_at: '2026-09-18T00:00:00Z', updated_at: '2026-09-19T00:00:00Z',
  });
  const report = await buildReport(7, fakeDatabase(fixture));

  assert.equal(report.overall_verdict, 'unverified');
  assert.equal(report.summary.unmapped_subjects, 1);
  assert.equal(report.summary.report_blockers, 1);
  assert.equal(report.report_blockers[0].code, 'UNMAPPED_EVM_SUBJECT');
});

test('Base evidence is retained as a deliberate scope exclusion', async () => {
  const fixture = completeFixture();
  const report = await buildReport(7, fakeDatabase(fixture));
  const base = report.wallets[0].networks.find((network) => network.chain.id === 8453);

  assert.equal(base.completion.verdict, 'excluded');
  assert.equal(base.completion.blocker_count, 0);
  assert.equal(base.completion.source_limitations[0].code, 'DELIBERATE_SCOPE_EXCLUSION');
  assert.equal(report.overall_verdict, 'complete_through_boundary_with_limitations');
});

test('an exact excluded-Base bridge movement is an explicit referenced limitation', async () => {
  const fixture = completeFixture();
  const txHash = `0x${'e'.repeat(64)}`;
  const endpoint = BASE_EXCLUSION_ENDPOINTS[1];
  fixture.bridgeMovements = [{
    id: '130', status: 'unsupported', verification_method: 'protocol_identity',
    invalidated_at: null,
    evidence: {
      reason: 'excluded_counterparty_chain', excluded_chain_id: 8453,
      source: {
        type: 'source_backed_endpoint', chain_id: 1,
        address: endpoint.address, name: endpoint.name, role: endpoint.role,
        source_url: endpoint.source_url,
      },
    },
    members: [{
      id: '131', wallet_id: 10, chain_id: 1, tx_hash: txHash,
      role: 'initiation', receipt_id: '132',
    }],
  }];
  fixture.bridgeLegs = [{
    id: '133', wallet_id: 10, chain_id: 1, tx_hash: txHash,
    category: 'bridge_out', link_id: null,
  }];

  const report = await buildReport(7, fakeDatabase(fixture));
  const network = report.wallets[0].networks.find((row) => row.chain.id === 1);
  const limitation = network.completion.source_limitations.find(
    (row) => row.code === 'BRIDGE_COUNTERPARTY_BASE_SCOPE_EXCLUDED'
  );

  assert.ok(!network.completion.blockers.some((row) => row.code === 'UNRESOLVED_BRIDGE_LEG'));
  assert.equal(limitation.detail.movement_id, '130');
  assert.equal(limitation.detail.excluded_chain_id, 8453);
  assert.deepEqual(limitation.detail.member_references, [{
    member_id: '131', wallet_id: 10, chain_id: 1, tx_hash: txHash,
    role: 'initiation', receipt_id: '132',
  }]);
  assert.deepEqual(network.bridge_legs[0].movement_references[0].evidence, {
    reason: 'excluded_counterparty_chain', excluded_chain_id: 8453,
    source: {
      type: 'source_backed_endpoint', chain_id: 1,
      address: endpoint.address, name: endpoint.name, role: endpoint.role,
      source_url: endpoint.source_url,
    },
  });
  assert.equal(network.bridge_legs[0].movement_references[0].member_chain_id, 1);
});

test('near-miss Base bridge evidence remains unresolved', async (t) => {
  const endpoint = BASE_EXCLUSION_ENDPOINTS[1];
  const endpointSource = {
    type: 'source_backed_endpoint', chain_id: 1,
    address: endpoint.address, name: endpoint.name, role: endpoint.role,
    source_url: endpoint.source_url,
  };
  const source = { source: endpointSource };
  const variants = [
    ['generic unsupported', 'unsupported', 'protocol_identity', {}],
    ['wrong reason', 'unsupported', 'protocol_identity', {
      reason: 'unsupported_protocol_path', excluded_chain_id: 8453, ...source,
    }],
    ['wrong chain', 'unsupported', 'protocol_identity', {
      reason: 'excluded_counterparty_chain', excluded_chain_id: 10, ...source,
    }],
    ['non-canonical chain type', 'unsupported', 'protocol_identity', {
      reason: 'excluded_counterparty_chain', excluded_chain_id: '8453', ...source,
    }],
    ['wrong status', 'pending', 'protocol_identity', {
      reason: 'excluded_counterparty_chain', excluded_chain_id: 8453, ...source,
    }],
    ['wrong verification method', 'unsupported', 'user_verdict', {
      reason: 'excluded_counterparty_chain', excluded_chain_id: 8453, ...source,
    }],
    ['missing source', 'unsupported', 'protocol_identity', {
      reason: 'excluded_counterparty_chain', excluded_chain_id: 8453,
    }],
    ['unsupported source type', 'unsupported', 'protocol_identity', {
      reason: 'excluded_counterparty_chain', excluded_chain_id: 8453,
      source: { type: 'manual_assertion' },
    }],
    ['malformed endpoint source', 'unsupported', 'protocol_identity', {
      reason: 'excluded_counterparty_chain', excluded_chain_id: 8453,
      source: { ...endpointSource, address: '0xfeed' },
    }],
    ['endpoint source missing URL', 'unsupported', 'protocol_identity', {
      reason: 'excluded_counterparty_chain', excluded_chain_id: 8453,
      source: { ...endpointSource, source_url: null },
    }],
    ['arbitrary well-formed endpoint', 'unsupported', 'protocol_identity', {
      reason: 'excluded_counterparty_chain', excluded_chain_id: 8453,
      source: {
        ...endpointSource, address: `0x${'1'.repeat(40)}`,
        name: 'Invented Base endpoint', source_url: 'https://example.com/base',
      },
    }],
    ['decoded identity does not mention Base', 'unsupported', 'protocol_identity', {
      reason: 'excluded_counterparty_chain', excluded_chain_id: 8453,
      source: {
        type: 'decoded_protocol_identity', protocol: 'across', family_version: 'v3',
        correlation_key: 'across:fixture', identity_fields: { destination_chain_id: 10 },
      },
      decoder_event: {
        protocol: 'across', family_version: 'v3', correlation_key: 'across:fixture',
        evidence: { identity_fields: { destination_chain_id: 10 } },
      },
    }],
    ['decoded source does not match decoder event', 'unsupported', 'protocol_identity', {
      reason: 'excluded_counterparty_chain', excluded_chain_id: 8453,
      source: {
        type: 'decoded_protocol_identity', protocol: 'across', family_version: 'v3',
        correlation_key: 'across:fixture', identity_fields: { destination_chain_id: '8453' },
      },
      decoder_event: {
        protocol: 'across', family_version: 'v3', correlation_key: 'across:other',
        evidence: { identity_fields: { destination_chain_id: '8453' } },
      },
    }],
  ];
  for (const [name, status, verificationMethod, evidence] of variants) {
    await t.test(name, async () => {
      const fixture = completeFixture();
      const txHash = `0x${'f'.repeat(64)}`;
      fixture.bridgeMovements = [{
        id: '140', status, verification_method: verificationMethod,
        invalidated_at: null, evidence,
        members: [{
          id: '141', wallet_id: 10, chain_id: 1, tx_hash: txHash, role: 'initiation',
        }],
      }];
      fixture.bridgeLegs = [{
        id: '142', wallet_id: 10, chain_id: 1, tx_hash: txHash,
        category: 'bridge_out', link_id: null,
      }];

      const report = await buildReport(7, fakeDatabase(fixture));
      const completion = report.wallets[0].networks.find((row) => row.chain.id === 1).completion;

      assert.ok(completion.blockers.some((row) => row.code === 'UNRESOLVED_BRIDGE_LEG'));
      assert.ok(!completion.source_limitations.some(
        (row) => row.code === 'BRIDGE_COUNTERPARTY_BASE_SCOPE_EXCLUDED'
      ));
      assert.ok(completion.source_limitations.some(
        (row) => row.code === 'DIAGNOSTIC_BRIDGE_MOVEMENT_NOT_RESOLVED'
      ));
    });
  }
});

test('known indexed and audit boundaries cannot outrun a complete feed', async () => {
  const fixture = completeFixture();
  for (const feed of fixture.feeds.filter((row) => ['normal', 'internal'].includes(row.feed))) {
    feed.covered_through_block = '100';
    feed.indexed_head = '200';
  }
  fixture.jobs[0].progress.chain_1.boundary_block = 200;
  fixture.nonceAudits[0].boundary_block = '200';
  fixture.balanceAudits[0].boundary_block = '200';
  for (const row of [...fixture.scopes, ...fixture.sourceCoverage]) {
    if (['normal', 'internal'].includes(row.capability)) {
      row.requested_through_block = '200';
      row.through_block = '200';
    }
  }
  const report = await buildReport(7, fakeDatabase(fixture));
  const completion = report.wallets[0].networks.find((row) => row.chain.id === 1).completion;

  assert.equal(completion.verdict, 'incomplete');
  assert.ok(completion.blockers.some((row) => row.code === 'FEED_BEHIND_INDEXED_HEAD'));
  assert.ok(completion.blockers.some((row) => row.code === 'FEED_BEHIND_AUDIT_BOUNDARY'));
});

test('complete feed coverage cannot claim blocks above the provider indexed head', async () => {
  const fixture = completeFixture();
  const normal = fixture.feeds.find((row) => row.feed === 'normal');
  normal.covered_through_block = '101';
  normal.indexed_head = '100';
  const report = await buildReport(7, fakeDatabase(fixture));
  const blocker = report.wallets[0].networks[0].completion.blockers.find(
    (row) => row.code === 'FEED_COVERAGE_EXCEEDS_INDEXED_HEAD'
  );

  assert.ok(blocker);
  assert.equal(blocker.evidence.covered_through_block, '101');
  assert.equal(blocker.evidence.indexed_head, '100');
});

test('audit-reported unresolved bridges remain material blockers', async () => {
  const fixture = completeFixture();
  fixture.jobs[0].progress.chain_1.unresolved_bridges = [{ activity_id: 124 }];
  const report = await buildReport(7, fakeDatabase(fixture));
  const completion = report.wallets[0].networks.find((row) => row.chain.id === 1).completion;

  assert.equal(completion.verdict, 'incomplete');
  assert.ok(completion.blockers.some((row) => row.code === 'UNRESOLVED_BRIDGE'));
});

test('invalidated failed movements cannot suppress an unresolved bridge leg', async () => {
  const fixture = completeFixture();
  fixture.bridgeMovements = [{
    id: '130', status: 'failed', verification_method: 'synthetic',
    invalidated_at: '2026-09-19T01:00:00Z',
    members: [{
      id: '131', wallet_id: 10, chain_id: 1,
      tx_hash: `0x${'c'.repeat(64)}`, role: 'initiation',
    }],
  }];
  fixture.bridgeLegs[0].link_id = null;
  const report = await buildReport(7, fakeDatabase(fixture));
  const completion = report.wallets[0].networks.find((row) => row.chain.id === 1).completion;

  assert.equal(completion.verdict, 'incomplete');
  assert.ok(completion.blockers.some((row) => row.code === 'UNRESOLVED_BRIDGE_LEG'));
});

test('one terminal movement cannot hide another active unresolved bridge movement', async () => {
  const fixture = completeFixture();
  fixture.bridgeMovements = [
    {
      id: '130', status: 'failed', verification_method: 'synthetic', invalidated_at: null,
      members: [{
        id: '131', wallet_id: 10, chain_id: 1,
        tx_hash: `0x${'c'.repeat(64)}`, role: 'initiation',
      }],
    },
    {
      id: '132', status: 'pending', verification_method: 'synthetic', invalidated_at: null,
      members: [{
        id: '133', wallet_id: 10, chain_id: 1,
        tx_hash: `0x${'c'.repeat(64)}`, role: 'initiation',
      }],
    },
  ];
  fixture.bridgeLegs[0].link_id = null;
  const report = await buildReport(7, fakeDatabase(fixture));
  const completion = report.wallets[0].networks.find((row) => row.chain.id === 1).completion;

  assert.equal(completion.verdict, 'incomplete');
  assert.ok(completion.blockers.some((row) => row.code === 'UNRESOLVED_BRIDGE_LEG'));
});

test('empty exact-zero coordinates remain unverified without independent enumeration', async () => {
  const fixture = completeFixture();
  fixture.reconciliation[0] = {
    ...fixture.reconciliation[0], derived_units: '0', live_units: '0', delta_units: '0',
  };
  fixture.activityStats = [];
  fixture.jobs = [];
  fixture.scopes = [];
  fixture.sourceCoverage = [];
  fixture.nonceAudits = [];
  fixture.balanceAudits = [];
  const report = await buildReport(7, fakeDatabase(fixture));
  const network = report.wallets[0].networks[0];

  assert.equal(network.activity_stats.native_impact_leg_count, 0);
  assert.equal(network.completion.verdict, 'unverified');
  assert.ok(network.completion.blockers.some((row) => row.code === 'MISSING_EVM_AUDIT_JOB'));
  assert.ok(network.completion.blockers.some((row) => row.code === 'MISSING_AUDIT_SCOPES'));
  assert.ok(network.completion.blockers.some((row) => row.code === 'MISSING_NONCE_AUDIT'));
  assert.ok(network.completion.blockers.some(
    (row) => row.code === 'MISSING_NATIVE_BALANCE_AUDIT'
  ));
});

test('failed audits cannot certify an otherwise exact-zero coordinate', async () => {
  const fixture = completeFixture();
  Object.assign(fixture.reconciliation[0], {
    derived_units: '0', live_units: '0', delta_units: '0',
  });
  fixture.activityStats = [];
  Object.assign(fixture.jobs[0], {
    status: 'failed', stage: 'provider_enumeration', error_code: 'SYNTHETIC_FAILURE',
  });
  const report = await buildReport(7, fakeDatabase(fixture));
  const completion = report.wallets[0].networks[0].completion;

  assert.equal(completion.verdict, 'incomplete');
  assert.ok(completion.blockers.some((row) => row.code === 'EVM_AUDIT_JOB_HAS_GAPS'));
});

test('native-impact activity still fails closed without independent audit evidence', async () => {
  const fixture = completeFixture();
  fixture.reconciliation[0] = {
    ...fixture.reconciliation[0], derived_units: '0', live_units: '0', delta_units: '0',
  };
  fixture.activityStats = [{
    wallet_id: 10, chain_id: 1, total_leg_count: 1, distinct_tx_count: 1,
    native_impact_leg_count: 1, native_impact_distinct_tx_count: 1,
    first_native_impact_block: '25', last_native_impact_block: '25',
  }];
  fixture.jobs = [];
  fixture.scopes = [];
  fixture.sourceCoverage = [];
  fixture.nonceAudits = [];
  fixture.balanceAudits = [];
  const report = await buildReport(7, fakeDatabase(fixture));
  const network = report.wallets[0].networks[0];

  assert.equal(network.completion.verdict, 'unverified');
  assert.ok(network.completion.blockers.some((row) => row.code === 'MISSING_EVM_AUDIT_JOB'));
  assert.ok(network.completion.blockers.some((row) => row.code === 'MISSING_NONCE_AUDIT'));
  assert.ok(network.completion.blockers.some((row) => row.code === 'MISSING_NATIVE_BALANCE_AUDIT'));
});

test('current chain and wallet errors cannot hide behind older complete evidence', async () => {
  const fixture = completeFixture();
  fixture.wallets[0].chain_error_code = 'SYNC_DEFERRED';
  fixture.wallets[0].chain_error_message = 'Synthetic provider deferred';
  fixture.wallets[0].wallet_error_code = 'SYNC_DEFERRED';
  fixture.wallets[0].wallet_error_message = 'Synthetic wallet deferred';
  const internal = fixture.feeds.find((row) => row.feed === 'internal');
  internal.status = 'deferred';
  internal.error_code = 'SYNTHETIC_REQUIRED_FAILURE';
  const report = await buildReport(7, fakeDatabase(fixture));
  const completion = report.wallets[0].networks.find((row) => row.chain.id === 1).completion;

  assert.equal(report.overall_verdict, 'unverified');
  assert.ok(completion.blockers.some((row) => row.code === 'CHAIN_SYNC_ERROR'));
  assert.ok(report.report_blockers.some((row) => row.code === 'WALLET_SYNC_ERROR'));
});

test('optional-feed-only chain and wallet errors remain explicit limitations', async () => {
  const fixture = completeFixture();
  fixture.wallets[0].chain_error_code = 'FEED_SKIPPED';
  fixture.wallets[0].chain_error_message = 'Synthetic optional token feed skipped';
  fixture.wallets[0].wallet_error_code = 'FEED_SKIPPED';
  fixture.wallets[0].wallet_error_message = 'Synthetic optional token feed skipped';
  const report = await buildReport(7, fakeDatabase(fixture));
  const completion = report.wallets[0].networks.find((row) => row.chain.id === 1).completion;

  assert.equal(report.overall_verdict, 'complete_through_boundary_with_limitations');
  assert.ok(!completion.blockers.some((row) => row.code === 'CHAIN_SYNC_ERROR'));
  assert.ok(completion.source_limitations.some(
    (row) => row.code === 'OPTIONAL_CHAIN_FEED_LIMITATION'
  ));
  assert.ok(!report.report_blockers.some((row) => row.code === 'WALLET_SYNC_ERROR'));
  assert.ok(report.report_limitations.some(
    (row) => row.code === 'OPTIONAL_WALLET_FEED_LIMITATION'
  ));
});

test('newer targeted audit jobs do not replace older evidence for other chains', async () => {
  const fixture = completeFixture();
  const mainJob = {
    ...fixture.jobs[0], id: '80', evidence_chain_id: 1,
    requested_chains: [1, 100], requested_at: '2026-09-18T00:00:00Z',
  };
  const gnosisJob = {
    ...fixture.jobs[0], id: '90', evidence_chain_id: 100,
    requested_chains: [100], discovered_chains: [100],
    progress: { chain_100: currentAuditProgress({ boundary_block: 200 }) },
    requested_at: '2026-09-19T00:00:00Z',
  };
  fixture.jobs = [mainJob, gnosisJob];
  fixture.scopes = fixture.scopes.map((scope) => ({ ...scope, job_id: '80' }));
  fixture.sourceCoverage = fixture.sourceCoverage.map((coverage) => ({
    ...coverage,
    source_job_id: coverage.source_job_id === '80' ? '70' : '80',
  }));
  fixture.nonceAudits = fixture.nonceAudits.map((row) => ({ ...row, job_id: '80' }));
  fixture.balanceAudits = fixture.balanceAudits.map((row) => ({ ...row, job_id: '80' }));

  fixture.wallets.push({
    ...fixture.wallets[0], chain_id: 100,
    last_block_normal: '200', last_block_internal: '200', last_block_token: '200',
    last_block_nft: '200', last_block_1155: '200', last_block_statesync: '200',
  });
  fixture.feeds.push(...FEEDS.map((feed) => ({
    wallet_id: 10, chain_id: 100, feed, cursor_kind: 'evm_block',
    provider: 'Synthetic Gnosis provider',
    status: ['normal', 'internal', 'statesync'].includes(feed) ? 'complete' : 'not_applicable',
    covered_from_block: ['normal', 'internal', 'statesync'].includes(feed) ? '0' : null,
    covered_through_block: ['normal', 'internal', 'statesync'].includes(feed) ? '200' : null,
    indexed_head: ['normal', 'internal', 'statesync'].includes(feed) ? '200' : null,
  })));
  fixture.reconciliation.push({
    id: 30, wallet_id: 10, chain_id: 100, asset_key: 'XDAI', asset_type: 'native',
    derived_units: '8', live_units: '8', delta_units: '0', status: 'match',
    checked_at: '2026-09-19T00:00:00Z',
  });
  fixture.scopes.push(...['normal', 'internal', 'native_credit'].map((capability, index) => ({
    id: String(130 + index), job_id: '90', subject_id: '70', chain_id: 100,
    provider: 'blockscout', capability, status: 'complete',
    requested_from_block: '0', requested_through_block: '200', pagination_exhausted: true,
  })));
  fixture.sourceCoverage.push(...['normal', 'internal', 'native_credit'].map((capability, index) => ({
    id: String(140 + index), subject_id: '70', chain_id: 100,
    provider: 'blockscout', capability, from_block: '0', through_block: '200',
    pagination_exhausted: true, status: 'complete', source_job_id: '90',
  })));
  fixture.nonceAudits.push({
    id: '150', job_id: '90', subject_id: '70', chain_id: 100,
    boundary_block: '200', boundary_block_hash: `0x${'e'.repeat(64)}`,
    next_mined_nonce: '2', observed_outgoing_count: 2,
    missing_nonces: [], conflicting_nonces: [], unknown_signedness_count: 0,
    status: 'complete',
  });
  fixture.balanceAudits.push({
    id: '151', job_id: '90', subject_id: '70', chain_id: 100,
    asset_key: 'native', asset_type: 'native', boundary_block: '200',
    derived_units: '8', live_units: '8', delta_units: '0', status: 'match',
    detail: {
      boundary_hash: `0x${'e'.repeat(64)}`,
      archive_check: {
        status: 'available', block: 25, block_tag: '0x19',
        derived_units: '0', live_units: '0', delta_units: '0',
      },
    },
  });

  const db = fakeDatabase(fixture);
  const report = await buildReport(7, db);
  const mainnet = report.wallets[0].networks.find((network) => network.chain.id === 1);
  const gnosis = report.wallets[0].networks.find((network) => network.chain.id === 100);

  assert.equal(mainnet.latest_audit_job.id, '80');
  assert.equal(gnosis.latest_audit_job.id, '90');
  assert.ok(db.calls.some((sql) => /DISTINCT ON \(j\.subject_id, jc\.chain_id\)/.test(sql)));
  assert.ok(db.calls.some((sql) => /sc\.chain_id = latest\.chain_id/.test(sql)));
});

test('zkSync Lite uses its single archive feed without requiring EVM nonce evidence', () => {
  const context = {
    chain: {
      id: 32401, name: 'zkSync Lite (legacy)', registry_supported: true,
      native_asset: 'ETH', scope_excluded: false, trace_rpc_configured: false,
    },
    chainState: { chain_id: 32401, ingest_version: 0, coverage_recapture_version: 1 },
    feedCoverage: FEEDS.map((feed) => ({
      feed,
      cursor_kind: 'archive_serial',
      provider: 'Matter Labs zkSync Lite archive',
      status: feed === 'normal' ? 'complete' : 'not_applicable',
      covered_from_block: feed === 'normal' ? '0' : null,
      covered_through_block: feed === 'normal' ? '50' : null,
      last_success_at: feed === 'normal' ? '2026-09-19T00:00:00Z' : null,
    })),
    reconciliation: [{
      id: 1, asset_key: 'ETH', asset_type: 'native', status: 'match', derived_units: '4',
      live_units: '4', delta_units: '0', checked_at: '2026-09-19T00:00:00Z',
    }],
    adjustments: [],
    latestJob: null,
    scopes: [],
    sourceCoverage: [],
    nonceAudits: [],
    balanceAudits: [],
    bridgeLegs: [],
    bridgeMovements: [],
    bridgeSuggestions: [],
    bridgeReceipts: [],
    bridgeReceiptAttempts: [],
  };
  const completion = completionForCoordinate(context);

  assert.equal(completion.verdict, 'complete_through_boundary_with_limitations');
  assert.deepEqual(completion.blockers, []);
  assert.ok(completion.source_limitations.some((row) => row.code === 'ZKSYNC_LITE_ARCHIVE_SCOPE'));

  const wrongCursor = completionForCoordinate({
    ...context,
    feedCoverage: context.feedCoverage.map((row) => (
      row.feed === 'normal' ? { ...row, cursor_kind: 'evm_block' } : row
    )),
  });
  assert.ok(wrongCursor.blockers.some((row) => row.code === 'FEED_CURSOR_KIND_MISMATCH'));
});

test('null feed boundaries cannot be coerced into block zero coverage', async () => {
  const fixture = completeFixture();
  const normal = fixture.feeds.find((row) => row.feed === 'normal');
  const internal = fixture.feeds.find((row) => row.feed === 'internal');
  normal.covered_through_block = null;
  normal.indexed_head = null;
  internal.covered_through_block = '100';
  internal.indexed_head = null;

  const report = await buildReport(7, fakeDatabase(fixture));
  const blockers = report.wallets[0].networks[0].completion.blockers;
  assert.ok(blockers.some((row) => row.code === 'FEED_NOT_PROVEN_FROM_GENESIS'
    && row.evidence.feed === 'normal'));
  assert.ok(blockers.some((row) => row.code === 'FEED_INDEXED_HEAD_MISSING'
    && row.evidence.feed === 'internal'));
});

test('native evidence must use the chain native asset and token adjustments do not block it', async () => {
  const fixture = completeFixture();
  fixture.reconciliation.unshift({
    id: 19, wallet_id: 10, chain_id: 1, asset_key: 'USDC', asset_type: 'native',
    derived_units: '1', live_units: '1', delta_units: '0', status: 'match',
    checked_at: '2026-09-19T00:03:00Z',
  });
  fixture.adjustments = [{
    id: 21, wallet_id: 10, chain_id: 1,
    asset_key: '0x2222222222222222222222222222222222222222',
    amount_wei: '5', note: 'Synthetic token-only adjustment',
  }];

  const report = await buildReport(7, fakeDatabase(fixture));
  const completion = report.wallets[0].networks[0].completion;
  assert.ok(completion.blockers.some(
    (row) => row.code === 'UNEXPECTED_NATIVE_RECONCILIATION_ASSET'
  ));
  assert.ok(!completion.blockers.some(
    (row) => row.code === 'RECONCILIATION_ADJUSTMENT_REQUIRED'
  ));
});

test('independent evidence must share one block and block hash', async () => {
  const fixture = completeFixture();
  fixture.jobs[0].progress.chain_1.boundary_block = 200;
  fixture.nonceAudits[0].boundary_block = '200';
  fixture.balanceAudits[0].boundary_block = '100';
  fixture.balanceAudits[0].detail.boundary_hash = `0x${'b'.repeat(64)}`;
  for (const feed of fixture.feeds.filter((row) => ['normal', 'internal'].includes(row.feed))) {
    feed.covered_through_block = '200';
    feed.indexed_head = '200';
  }
  for (const row of [...fixture.scopes, ...fixture.sourceCoverage]) {
    if (['normal', 'internal'].includes(row.capability)) {
      row.requested_through_block = '200';
      row.through_block = '200';
    }
  }

  const report = await buildReport(7, fakeDatabase(fixture));
  const blockers = report.wallets[0].networks[0].completion.blockers;
  assert.ok(blockers.some((row) => row.code === 'AUDIT_BOUNDARY_MISMATCH'));
  assert.ok(blockers.some((row) => row.code === 'AUDIT_BOUNDARY_HASH_MISMATCH'));
});

test('independent evidence requires explicit valid boundary hashes', async () => {
  const fixture = completeFixture();
  fixture.nonceAudits[0].boundary_block_hash = null;
  fixture.balanceAudits[0].detail.boundary_hash = 'not-a-block-hash';
  const report = await buildReport(7, fakeDatabase(fixture));
  const completion = report.wallets[0].networks[0].completion;

  assert.ok(completion.blockers.some((row) => row.code === 'AUDIT_BOUNDARY_HASH_MISSING'));
});

test('enumeration coverage must be anchored to the audited boundary hash', async () => {
  const fixture = completeFixture();
  for (const row of fixture.scopes.filter(
    (entry) => ['normal', 'internal'].includes(entry.capability)
  )) {
    row.requested_through_hash = `0x${'b'.repeat(64)}`;
  }
  for (const row of fixture.sourceCoverage.filter(
    (entry) => ['normal', 'internal'].includes(entry.capability)
  )) {
    row.through_block_hash = `0x${'b'.repeat(64)}`;
  }

  const report = await buildReport(7, fakeDatabase(fixture));
  const blockers = report.wallets[0].networks[0].completion.blockers.filter(
    (row) => row.code === 'REQUIRED_AUDIT_CAPABILITY_NOT_COVERED'
  );
  assert.deepEqual(new Set(blockers.map((row) => row.evidence.capability)), new Set([
    'normal', 'internal',
  ]));
});

test('unknown nonzero audit gap fields fail closed', async () => {
  const fixture = completeFixture();
  fixture.jobs[0].progress.chain_1.new_provider_gap = 1;
  const report = await buildReport(7, fakeDatabase(fixture));
  const completion = report.wallets[0].networks[0].completion;

  assert.ok(completion.blockers.some((row) => (
    row.code === 'UNCLASSIFIED_AUDIT_GAP'
      && row.evidence.field === 'new_provider_gap'
  )));
});

test('reconciliation must follow the required feed success timestamps', async () => {
  const fixture = completeFixture();
  fixture.reconciliation[0].checked_at = '2026-09-19T00:00:00Z';
  const report = await buildReport(7, fakeDatabase(fixture));
  const completion = report.wallets[0].networks[0].completion;

  assert.ok(completion.blockers.some(
    (row) => row.code === 'RECONCILIATION_PREDATES_FEED_COVERAGE'
  ));
  assert.equal(completion.evidence_boundary.wall_clock_currentness_inferred, false);
});

test('independent audits must follow the current required feed evidence', async () => {
  const fixture = completeFixture();
  for (const feed of fixture.feeds.filter((row) => ['normal', 'internal'].includes(row.feed))) {
    feed.last_success_at = '2026-09-19T12:00:00Z';
  }
  fixture.reconciliation[0].checked_at = '2026-09-19T13:00:00Z';
  fixture.jobs[0].finished_at = '2026-09-19T01:00:00Z';
  fixture.nonceAudits[0].checked_at = '2026-09-19T01:00:00Z';
  fixture.balanceAudits[0].checked_at = '2026-09-19T01:00:00Z';

  const report = await buildReport(7, fakeDatabase(fixture));
  const blockers = report.wallets[0].networks[0].completion.blockers.filter(
    (row) => row.code === 'AUDIT_PREDATES_FEED_COVERAGE'
  );
  assert.deepEqual(new Set(blockers.map((row) => row.evidence.source)), new Set([
    'audit_job', 'nonce_audit', 'native_balance_audit',
  ]));
});

test('owned and pending discovery evidence contributes to the overall verdict', async () => {
  const fixture = completeFixture();
  fixture.ownLabels = [{
    id: 300, address: '0x2222222222222222222222222222222222222222',
    name: 'Synthetic own address', source: 'user', kind: 'own',
    created_at: '2026-09-18T00:00:00Z', mapped_wallet_id: null,
  }];
  fixture.discoveryCandidates = [
    {
      id: 301, address: '0x2222222222222222222222222222222222222222',
      chain_id: 1, status: 'confirmed_own', source: 'path', score: '0.98',
      updated_at: '2026-09-19T00:00:00Z', mapped_wallet_id: null,
    },
    {
      id: 302, address: '0x3333333333333333333333333333333333333333',
      chain_id: 0, status: 'pending', source: 'exchange_withdrawal', score: '0.95',
      updated_at: '2026-09-19T00:00:00Z', mapped_wallet_id: null,
    },
    {
      id: 304, address: '0x4444444444444444444444444444444444444444',
      chain_id: 8453, status: 'confirmed_own', source: 'base_bridge', score: '1',
      updated_at: '2026-09-19T00:00:00Z', mapped_wallet_id: null,
    },
  ];
  fixture.discoveryFetches = [{
    id: 303, candidate_id: 301,
    address: '0x2222222222222222222222222222222222222222',
    chain_id: 1, depth: 0, status: 'truncated', rows_fetched: 200,
    candidate_status: 'confirmed_own', candidate_source: 'path',
    mapped_wallet_id: null, fetched_at: '2026-09-19T00:00:00Z',
  }];

  const report = await buildReport(7, fakeDatabase(fixture));
  assert.equal(report.overall_verdict, 'incomplete');
  assert.equal(report.summary.untracked_own_addresses, 2);
  assert.ok(report.report_blockers.some((row) => row.code === 'UNTRACKED_OWN_ADDRESS'));
  assert.ok(report.report_limitations.some(
    (row) => row.code === 'BASE_DISCOVERY_SCOPE_EXCLUDED'
  ));
  assert.ok(report.report_blockers.some((row) => row.code === 'DISCOVERY_CHAIN_UNKNOWN'));
  assert.ok(report.report_blockers.some((row) => row.code === 'DISCOVERY_FETCH_INCOMPLETE'));
});

test('evidence on a chain with no compact chain row is not omitted', async () => {
  const fixture = completeFixture();
  fixture.activityStats.push({
    wallet_id: 10, chain_id: 42161, total_leg_count: 1, distinct_tx_count: 1,
    native_impact_leg_count: 1, native_impact_distinct_tx_count: 1,
    first_native_impact_block: '1', last_native_impact_block: '1',
  });

  const report = await buildReport(7, fakeDatabase(fixture));
  const arbitrum = report.wallets[0].networks.find((row) => row.chain.id === 42161);
  assert.ok(arbitrum);
  assert.ok(arbitrum.completion.blockers.some(
    (row) => row.code === 'MISSING_WALLET_CHAIN_STATE'
  ));
});

test('schema incompatibility returns a manifest and runs no evidence queries', async () => {
  const db = {
    calls: [],
    async query(sql) {
      this.calls.push(sql);
      return { rows: [{ table_name: 'eth_wallets', column_name: 'id' }] };
    },
  };
  const report = await buildReport(7, db);

  assert.equal(report.overall_verdict, 'schema_incompatible');
  assert.equal(report.schema.compatible, false);
  assert.ok(report.schema.missing_tables.includes('evm_audit_jobs'));
  assert.ok(report.schema.missing_columns.some(
    (row) => row.table === 'eth_wallets' && row.column === 'user_id'
  ));
  assert.equal(db.calls.length, 1);
  assert.deepEqual(report.wallets, []);
});

test('private report writer requires a new absolute path and enforces mode 0600', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'evm-completion-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const output = path.join(directory, 'report.json');
  writePrivateReport(output, { private: 'synthetic-only' });

  assert.equal(fs.statSync(output).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(fs.readFileSync(output, 'utf8')), { private: 'synthetic-only' });
  assert.throws(() => writePrivateReport(output, {}), /EEXIST/);
  assert.throws(() => writePrivateReport('relative.json', {}), /explicit absolute path/);
  assert.throws(
    () => writePrivateReport(path.resolve(__dirname, '../evm-report-not-ignored.json'), {}),
    /must be gitignored/
  );
});

test('private report output must be ignored in any containing Git worktree', (t) => {
  const repository = fs.mkdtempSync(path.join(os.tmpdir(), 'evm-completion-repo-'));
  t.after(() => fs.rmSync(repository, { recursive: true, force: true }));
  const initialized = spawnSync('git', ['init', '--quiet', repository]);
  assert.equal(initialized.status, 0);
  const privateDirectory = path.join(repository, 'private');
  fs.mkdirSync(privateDirectory);
  fs.writeFileSync(path.join(repository, '.gitignore'), 'private/\n');

  assert.throws(
    () => writePrivateReport(path.join(repository, 'public.json'), { private: true }),
    /inside a Git worktree must be gitignored/
  );
  const privateOutput = path.join(privateDirectory, 'report.json');
  writePrivateReport(privateOutput, { private: true });
  assert.equal(fs.statSync(privateOutput).mode & 0o777, 0o600);
});

test('nested connection errors retain a useful fail-closed message', () => {
  assert.equal(errorMessage({
    name: 'AggregateError',
    errors: [{ code: 'EPERM', message: 'connection denied' }],
  }), 'EPERM: connection denied');
});

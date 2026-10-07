'use strict';

// Values that are persisted, or that key persisted rows, must never change by
// accident: shortName is baked into holding names, native symbols key prices
// and reconciliation, provider strings decide cursor resets, venue ids and key
// services are CHECK-constrained, lock namespaces must match across processes.
// The refactor moves where these facts live; this snapshot proves the values
// did not move with them.
//
// Regenerate deliberately with UPDATE_SNAPSHOTS=1 and review the diff.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = 'postgresql://test:test@localhost/test';
delete process.env.ETH_CHAINS;
// RPC overrides would leak a developer's endpoints into the registry snapshot.
for (const key of Object.keys(process.env)) if (/_RPC_URL$/.test(key)) delete process.env[key];

const SNAPSHOT = path.join(__dirname, 'fixtures', 'snapshots', 'crypto-persisted-keys.json');
const FEEDS = ['normal', 'internal', 'token', 'nft', 'nft1155', 'statesync', null];

function collect() {
  const chains = require('../src/config/chains');
  const vocabulary = require('../src/utils/ethActivityVocabulary');
  const ExchangeAccount = require('../src/models/ExchangeAccount');
  const SecretsService = require('../src/services/SecretsService');
  const { CONNECTORS, CREDENTIAL_FIELDS } = require('../src/services/exchangeSync');
  const { FORMATS } = require('../src/services/exchangeImport');
  const { ADAPTERS, RULE_VERSION } = require('../src/services/bridge/adapters');
  const EthDerivedPipeline = require('../src/services/EthDerivedPipeline');
  const BridgeMatchingService = require('../src/services/BridgeMatchingService');
  const EvmAuditService = require('../src/services/EvmAuditService');

  const jobsDir = path.join(__dirname, '..', 'src', 'jobs');
  const jobNames = fs.readdirSync(jobsDir).sort()
    .map((file) => fs.readFileSync(path.join(jobsDir, file), 'utf8').match(/const JOB_NAME = '([^']+)'/))
    .filter(Boolean).map((match) => match[1]);
  const evmAuditSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'models', 'EvmAudit.js'), 'utf8');
  const auditLockNames = [...new Set([...evmAuditSource.matchAll(/hashtext\('([^']+)'\)/g)].map((m) => m[1]))].sort();

  const perChain = chains.allChains().map((chain) => ({
    id: chain.id,
    name: chain.name,
    shortName: chain.shortName,
    nativeAsset: chain.nativeAsset,
    enabledByDefault: chain.enabledByDefault,
    nativeSymbol: chains.nativeSymbol(chain.id),
    ethHoldingName: chains.ethHoldingName(chain.id),
    holdingSuffix: chains.holdingSuffix(chain.id),
    requiresKey: chains.accountApiRequiresKey(chain.id),
    historyProvider: chains.accountApiHistoryProvider(chain.id),
    providerNames: Object.fromEntries(FEEDS.map((feed) => [feed ?? '(none)', chains.accountHistoryProviderName(chain.id, feed)])),
    providerManifest: chains.accountApiProviderManifest(chain.id),
    routes: chains.accountApiRoutes(chain.id),
    ingestVersion: chain.ingestVersion ?? null,
  }));

  const auditChains = Object.fromEntries([...EvmAuditService._AUDIT_CHAINS.entries()].map(([id, entry]) => [id, {
    ...entry,
    activeIds: entry.activeIds ? [...entry.activeIds].sort() : undefined,
  }]));

  return {
    // The whole registry entry, so moving it into per-network files can be
    // proven byte-identical through the chains.js facade.
    registry: chains.allChains(),
    chains: perChain,
    unknownChain: {
      nativeSymbol: chains.nativeSymbol(999999),
      ethHoldingName: chains.ethHoldingName(999999),
      holdingSuffix: chains.holdingSuffix(999999),
      chainLabel: chains.chainLabel(999999),
    },
    nativeAssets: chains.NATIVE_ASSETS,
    auditChains,
    vocabulary: {
      categories: [...vocabulary.CATEGORIES].sort(),
      reviewReasons: vocabulary.REVIEW_REASONS,
      spamReasons: vocabulary.SPAM_REASONS,
      neverSpamCategories: [...vocabulary.NEVER_SPAM_CATEGORIES].sort(),
      usdBasisRank: vocabulary.USD_BASIS_RANK,
    },
    venues: {
      ids: [...ExchangeAccount.EXCHANGES].sort(),
      connectors: [...CONNECTORS.keys()].sort(),
      credentialVenues: Object.keys(CREDENTIAL_FIELDS).sort(),
      csvFormats: [...FORMATS].sort(),
    },
    userKeyServices: SecretsService.USER_SERVICES,
    bridge: {
      protocols: ADAPTERS.map((adapter) => adapter.protocol),
      ruleVersion: RULE_VERSION,
    },
    locks: {
      ethUserLane: EthDerivedPipeline.ETH_USER_LOCK_NAMESPACE,
      bridge: BridgeMatchingService.BRIDGE_LOCK_NAMESPACE,
      evmAuditHashtext: auditLockNames,
    },
    jobNames,
  };
}

// JSON round-trip drops undefined and normalizes Sets/Maps already expanded.
const normalize = (value) => JSON.parse(JSON.stringify(value));

test('persisted crypto keys match the committed snapshot', () => {
  const actual = normalize(collect());
  if (process.env.UPDATE_SNAPSHOTS === '1') {
    fs.mkdirSync(path.dirname(SNAPSHOT), { recursive: true });
    fs.writeFileSync(SNAPSHOT, `${JSON.stringify(actual, null, 2)}\n`);
  }
  const expected = JSON.parse(fs.readFileSync(SNAPSHOT, 'utf8'));
  assert.deepEqual(actual, expected);
});

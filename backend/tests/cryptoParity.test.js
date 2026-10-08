'use strict';

// Copies of one fact must agree until the refactor leaves a single source.
// Each test names the copies it compares; when a slice removes a copy, its
// test switches to asserting the copy reads from the registry.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = 'postgresql://test:test@localhost/test';

const ROOT = path.join(__dirname, '..', '..');
const MIGRATIONS = path.join(__dirname, '..', 'migrations');
const read = (relative) => fs.readFileSync(path.join(ROOT, relative), 'utf8');
const sorted = (values) => [...values].sort();

// Values of the LAST migration (in boot order) that adds this CHECK.
function lastCheckValues(constraint) {
  let values = null;
  for (const file of fs.readdirSync(MIGRATIONS).filter((name) => name.endsWith('.sql')).sort()) {
    const sql = fs.readFileSync(path.join(MIGRATIONS, file), 'utf8');
    const pattern = new RegExp(`ADD\\s+CONSTRAINT\\s+${constraint}\\s+CHECK\\s*\\(([\\s\\S]*?)\\)\\s*(?:NOT\\s+VALID\\s*)?;`, 'gi');
    for (const match of sql.matchAll(pattern)) {
      values = [...match[1].matchAll(/'([^']*)'/g)].map((value) => value[1]);
    }
  }
  return values;
}

function objectKeys(source, constName) {
  const body = source.match(new RegExp(`const ${constName} = \\{([\\s\\S]*?)\\n\\};`))[1];
  return [...body.matchAll(/^  (\w+|'[^']+'):/gm)].map((match) => match[1].replace(/'/g, ''));
}

// The frontend renders networks, explorers, ledger categories and label kinds
// from GET /api/crypto/meta (cryptoMetaFixture.test.js pins its test copy), so
// none of those lists may reappear as a client constant.
test('the frontend keeps no copy of network, explorer, category or label-kind lists', () => {
  const chainsSource = read('frontend/src/utils/chains.js');
  assert.doesNotMatch(chainsSource, /const EXPLORERS = \{/);
  assert.doesNotMatch(chainsSource, /const NATIVE_ASSETS = \{/);
  assert.doesNotMatch(chainsSource, /https:\/\//);
  const labelsSource = read('frontend/src/utils/dataLabels.js');
  assert.doesNotMatch(labelsSource, /export const LEDGER_CATEGORIES = \[/);
  assert.doesNotMatch(labelsSource, /value: 'exchange', label:/);
});

test('ledger categories served to the client match CryptoLedger.CATEGORIES', () => {
  const CryptoLedger = require('../src/models/CryptoLedger');
  const { buildCryptoMeta } = require('../src/crypto/meta');
  assert.deepEqual(
    sorted(buildCryptoMeta().vocabulary.ledgerCategories.map((entry) => entry.value)),
    sorted(CryptoLedger.CATEGORIES)
  );
});

test('activity categories match the eth_activity CHECK', () => {
  const { CATEGORIES } = require('../src/utils/ethActivityVocabulary');
  assert.deepEqual(sorted(lastCheckValues('eth_activity_category_check')), sorted(CATEGORIES));
});

test('frontend spam reason labels cover every backend spam code', () => {
  const { SPAM_REASONS } = require('../src/utils/ethActivityVocabulary');
  const frontend = objectKeys(read('frontend/src/utils/dataLabels.js'), 'SPAM_REASON_LABELS');
  assert.deepEqual(sorted(frontend), sorted(Object.values(SPAM_REASONS)));
});

test('label kinds agree between the vocabulary and the CHECK', () => {
  const { LABEL_KINDS } = require('../src/crypto/registry/vocabulary');
  assert.deepEqual(sorted(lastCheckValues('eth_address_labels_kind_check')), sorted(LABEL_KINDS));
  assert.doesNotMatch(read('backend/src/routes/eth.js'), /const LABEL_KINDS = new Set\(\[/);
});

test('the vocabulary shim is the registry module itself', () => {
  assert.equal(require('../src/utils/ethActivityVocabulary'), require('../src/crypto/registry/vocabulary'));
});

test('ledger category labels cover exactly the ledger categories', () => {
  const vocabulary = require('../src/crypto/registry/vocabulary');
  assert.deepEqual(
    sorted(vocabulary.LEDGER_CATEGORY_DEFINITIONS.map((entry) => entry.value)),
    sorted([...vocabulary.CATEGORIES, ...vocabulary.EXCHANGE_ONLY_CATEGORIES])
  );
});

test('venue ids match the exchange_accounts CHECK', () => {
  const ExchangeAccount = require('../src/models/ExchangeAccount');
  assert.deepEqual(sorted(lastCheckValues('exchange_accounts_exchange_check')), sorted(ExchangeAccount.EXCHANGES));
});

test('every API connector is a known venue', () => {
  const ExchangeAccount = require('../src/models/ExchangeAccount');
  const { CONNECTORS, CREDENTIAL_FIELDS } = require('../src/services/exchangeSync');
  for (const venue of CONNECTORS.keys()) assert.ok(ExchangeAccount.EXCHANGES.has(venue), venue);
  assert.deepEqual(sorted(Object.keys(CREDENTIAL_FIELDS)), sorted(CONNECTORS.keys()));
});

test('user key services match the user_api_keys CHECK', () => {
  const SecretsService = require('../src/services/SecretsService');
  assert.deepEqual(sorted(lastCheckValues('user_api_keys_service_check')), sorted(SecretsService.USER_SERVICES));
});

test('the EVM audit names every registry chain', () => {
  const chains = require('../src/config/chains');
  const EvmAuditService = require('../src/services/EvmAuditService');
  assert.deepEqual(
    sorted([...EvmAuditService._AUDIT_CHAINS.keys()]),
    sorted(chains.allChains().map((chain) => chain.id))
  );
});

test('LabelsPanel keys removal on the server builtin flag, not a copied source list', () => {
  const panel = read('frontend/src/components/crypto/LabelsPanel.jsx');
  assert.doesNotMatch(panel, /BUILTIN_LABEL_SOURCES/);
  assert.match(panel, /!label\.builtin &&/);
  assert.match(read('backend/src/models/EthAddressLabel.js'), /\(labels\.user_id IS NULL\) AS builtin/);
});

// Boot order is filename order, so two files sharing a numeric prefix run in
// an order chosen by the rest of their names. The existing collisions are
// grandfathered; new migrations take a fresh three-digit prefix.
test('migration prefixes are unique outside the grandfathered set', () => {
  const GRANDFATHERED = new Map([['062', 5], ['074', 2], ['081', 2]]);
  const counts = new Map();
  for (const file of fs.readdirSync(MIGRATIONS).filter((name) => name.endsWith('.sql'))) {
    const match = file.match(/^(\d{3})([a-z]?)_[a-z0-9_]+\.sql$/);
    assert.ok(match, `migration name does not match NNN_snake_case.sql: ${file}`);
    if (match[2]) assert.equal(`${match[1]}${match[2]}`, '081a', `letter suffixes are grandfathered only: ${file}`);
    counts.set(match[1], (counts.get(match[1]) || 0) + 1);
  }
  for (const [prefix, count] of counts) {
    assert.equal(count, GRANDFATHERED.get(prefix) || 1, `migration prefix ${prefix} is used by ${count} files`);
  }
});

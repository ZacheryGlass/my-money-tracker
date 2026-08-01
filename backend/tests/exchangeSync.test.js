'use strict';

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = 'postgresql://test:test@localhost/test';
// 32 bytes of base64, as secretCrypto requires. Individual tests delete it to
// prove the feature degrades to a 503 rather than storing anything in clear.
const ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');
process.env.SECRETS_ENCRYPTION_KEY = ENCRYPTION_KEY;

const FIXTURES = path.join(__dirname, 'fixtures', 'exchanges');
const readFixture = (name) => fs.readFileSync(path.join(FIXTURES, name), 'utf8');
const readJson = (name) => JSON.parse(readFixture(name));

const KRAKEN_LEDGERS = readJson('kraken-ledgers-api.json');
const KRAKEN_FUNDING = readJson('kraken-funding-api.json');
const COINBASE = readJson('coinbase-api.json');
const COINBASE_LEGACY = readJson('coinbase-legacy-api.json');

const OWNED_ACCOUNT_ID = 7;
const OWNER_ID = 1;
const COINBASE_ACCOUNT_ID = 8;

// --- fake pg ---------------------------------------------------------------
//
// Stands in for UNIQUE (exchange_account_id, external_id). Complete normalized
// rows are retained so upgrade tests can inspect the durable record rather than
// trusting only the sync receipt.
const stored = new Map();
const chainDetails = new Map();
let derivedBalances = {};
let deriveFromStored = false;
let accountOverrides = {};
let accountSyncLockActive = false;
let nextStoredId = 1;
const queries = [];

function accountRow(overrides = {}) {
  return {
    id: OWNED_ACCOUNT_ID,
    user_id: OWNER_ID,
    name: 'Kraken',
    exchange: 'kraken',
    last_import_at: null,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    api_key_last4: null,
    api_secret_last4: null,
    api_configured: false,
    sync_cursor: null,
    last_sync_at: null,
    last_sync_status: null,
    last_sync_error: null,
    balance_report: null,
    ...accountOverrides,
    ...overrides,
  };
}

const RECORD_COLUMNS = [
  'record_type', 'occurred_at', 'base_asset', 'base_amount', 'quote_asset', 'quote_amount',
  'fee_asset', 'fee_amount', 'tx_hash', 'address', 'external_id', 'needs_review', 'raw',
  'source', 'network', 'chain_id', 'fingerprint', 'fingerprint_version',
  'dedupe_provenance', 'duplicate_candidate',
];
const PARAMS_PER_ROW = RECORD_COLUMNS.length + 1;

function storedKey(accountId, externalId) {
  return `${accountId}|${externalId}`;
}

function recordFromInsertParams(params, start = 0) {
  const row = { id: nextStoredId++, exchange_account_id: params[start] };
  RECORD_COLUMNS.forEach((column, index) => {
    const value = params[start + index + 1];
    if (column === 'raw' && typeof value === 'string') {
      row[column] = JSON.parse(value);
    } else {
      row[column] = value;
    }
  });
  return row;
}

function recordsForAccount(accountId) {
  return [...stored.values()].filter((row) => row.exchange_account_id === accountId);
}

function calculatedBalances(accountId) {
  const totals = {};
  const add = (asset, amount) => {
    if (!asset || amount === null || amount === undefined) return;
    totals[asset] = addAmounts(totals[asset] ?? '0', String(amount));
  };
  for (const row of recordsForAccount(accountId)) {
    add(row.base_asset, row.base_amount);
    add(row.quote_asset, row.quote_amount);
    if (row.fee_asset && row.fee_amount !== null && row.fee_amount !== undefined) {
      add(row.fee_asset, negateAmount(String(row.fee_amount)));
    }
  }
  return totals;
}

function seedStoredRecord(accountId, record, { needsReview = record.needs_review } = {}) {
  const row = {
    id: nextStoredId++,
    exchange_account_id: accountId,
    ...record,
    needs_review: needsReview,
  };
  stored.set(storedKey(accountId, record.external_id), row);
  return row;
}

function resolveAccount(id, userId) {
  if (userId !== OWNER_ID) return [];
  if (id === OWNED_ACCOUNT_ID) return [accountRow()];
  if (id === COINBASE_ACCOUNT_ID) return [accountRow({ id: COINBASE_ACCOUNT_ID, name: 'Coinbase', exchange: 'coinbase' })];
  return [];
}

function fakeQuery(text, params) {
  const sql = String(text).replace(/\s+/g, ' ').trim();
  queries.push({ sql, params });

  if (['BEGIN', 'COMMIT', 'ROLLBACK'].includes(sql)) return { rows: [] };

  // Ordered most specific first: the credential-bearing read is the only
  // SELECT * left on this table, and derivedBalances also mentions
  // exchange_accounts, so a loose match would swallow it.
  if (/GROUP BY asset/.test(sql)) {
    const balances = deriveFromStored ? calculatedBalances(params[0]) : derivedBalances;
    return { rows: Object.entries(balances).map(([asset, derived]) => ({ asset, derived })) };
  }
  if (/^UPDATE exchange_records er SET tx_hash = COALESCE/.test(sql)) {
    let filled = 0;
    for (let i = 1; i < params.length; i += 5) {
      const key = `${params[0]}|${params[i]}`;
      if (!stored.has(key)) continue;
      const existing = chainDetails.get(key) || {};
      const next = {
        tx_hash: existing.tx_hash ?? params[i + 1],
        address: existing.address ?? params[i + 2],
        network: existing.network ?? params[i + 3],
        chain_id: existing.chain_id ?? params[i + 4],
      };
      if (next.tx_hash !== existing.tx_hash || next.address !== existing.address
          || next.network !== existing.network || next.chain_id !== existing.chain_id) {
        chainDetails.set(key, next);
        filled += 1;
      }
    }
    return { rows: [], rowCount: filled };
  }
  if (/^SELECT \* FROM exchange_accounts WHERE id = \$1 AND user_id = \$2/.test(sql)) {
    return { rows: resolveAccount(params[0], params[1]) };
  }
  if (/^SELECT id FROM exchange_accounts WHERE id = \$1 AND user_id = \$2/.test(sql)) {
    return accountSyncLockActive ? { rows: [] } : { rows: resolveAccount(params[0], params[1]).map(({ id }) => ({ id })) };
  }
  if (/^SELECT 1 FROM exchange_sync_jobs/.test(sql)) return { rows: [] };
  if (/^SELECT \* FROM exchange_accounts WHERE api_key_encrypted IS NOT NULL/.test(sql)) {
    return { rows: accountOverrides.api_key_encrypted ? [accountRow()] : [] };
  }
  if (/^SELECT id, user_id, name, .* FROM exchange_accounts WHERE id = \$1 AND user_id = \$2/.test(sql)) {
    return { rows: resolveAccount(params[0], params[1]) };
  }
  if (/FROM exchange_accounts ea/.test(sql)) {
    // Faithful to the projection: the list query selects PUBLIC_COLUMNS plus
    // the derived api_configured flag, so the fake returns exactly those and
    // nothing else. Handing back the whole row here would hide the very leak
    // the accompanying test is checking for.
    const full = accountRow();
    const row = Object.fromEntries(PUBLIC_COLUMNS.map((column) => [column, full[column] ?? null]));
    return {
      rows: [{
        ...row,
        api_configured: full.api_configured,
        record_count: stored.size,
        needs_review_count: [...stored.values()].filter((record) => record.needs_review).length,
      }],
    };
  }
  if (/^UPDATE exchange_accounts SET api_key_encrypted = NULL/.test(sql)) {
    // clearCredentials: a DELETE of ciphertext, which needs no encryption key.
    if (accountSyncLockActive) return { rows: [] };
    accountOverrides = {};
    return { rows: [accountRow({ id: params[0], api_configured: false })] };
  }
  if (/^UPDATE exchange_accounts SET api_key_encrypted/.test(sql)) {
    // Mirrors setCredentials: ciphertext in, last4 alongside. The row that
    // comes back is the PUBLIC projection, which is what the route serializes.
    return {
      rows: [accountRow({
        id: params[0],
        api_key_last4: params[3],
        api_secret_last4: params[5],
        api_configured: params[2] !== null,
      })],
    };
  }
  if (/^UPDATE exchange_accounts SET sync_lock_token = \$2::uuid/.test(sql)) {
    return accountSyncLockActive ? { rows: [] } : { rows: [{ id: params[0] }] };
  }
  if (/^UPDATE exchange_accounts SET sync_lock_until/.test(sql)) {
    return { rows: [{ id: params[0] }] };
  }
  if (/^SELECT id FROM exchange_accounts WHERE id = \$1 AND sync_lock_token = \$2::uuid/.test(sql)) {
    return { rows: [{ id: params[0] }] };
  }
  if (/^UPDATE exchange_accounts SET sync_lock_token = NULL/.test(sql)) {
    return { rows: [{ id: params[0] }] };
  }
  if (/^UPDATE exchange_accounts SET sync_cursor/.test(sql)) {
    if (params[1] !== null && params[1] !== undefined) {
      accountOverrides = { ...accountOverrides, sync_cursor: params[1] };
    }
    return { rows: [accountRow({ last_sync_status: params[2], last_sync_error: params[3] })] };
  }
  if (/^UPDATE exchange_accounts/.test(sql)) {
    return { rows: resolveAccount(params[0], params[1]) };
  }
  if (/^INSERT INTO exchange_records/.test(sql)) {
    const rows = [];
    for (let i = 0; i < params.length; i += PARAMS_PER_ROW) {
      const incoming = recordFromInsertParams(params, i);
      const key = storedKey(incoming.exchange_account_id, incoming.external_id);
      const needsReview = Boolean(incoming.needs_review);
      if (!stored.has(key)) {
        stored.set(key, incoming);
        rows.push({ inserted: true });
      } else if (stored.get(key).needs_review && !needsReview) {
        stored.set(key, { ...stored.get(key), ...incoming, id: stored.get(key).id });
        rows.push({ inserted: false });
      }
    }
    return { rows, rowCount: rows.length };
  }
  if (/FROM exchange_records er/.test(sql)) {
    if (/^SELECT COUNT\(\*\)::int AS total/.test(sql)) {
      const [accountId, userId] = params;
      if (userId !== OWNER_ID) return { rows: [{ total: 0 }] };
      let rows = recordsForAccount(accountId);
      if (/er\.needs_review/.test(sql)) rows = rows.filter((record) => record.needs_review);
      if (/NOT er\.needs_review/.test(sql)) rows = rows.filter((record) => !record.needs_review);
      return { rows: [{ total: rows.length }] };
    }
    if (/^SELECT er\.\*/.test(sql)) {
      const [accountId, userId] = params;
      if (userId !== OWNER_ID) return { rows: [] };
      let rows = recordsForAccount(accountId);
      if (/er\.needs_review/.test(sql)) rows = rows.filter((record) => record.needs_review);
      if (/NOT er\.needs_review/.test(sql)) rows = rows.filter((record) => !record.needs_review);
      const limit = params[params.length - 2];
      const offset = params[params.length - 1];
      return { rows: rows.slice(offset, offset + limit) };
    }
    return { rows: [] };
  }
  return { rows: [] };
}

// Spelled out rather than imported from the model: requiring the model here
// would bind it to the REAL pg Pool, before the fake below is installed. It
// doubles as the contract -- if a column is added to the public projection,
// this list has to say so deliberately, and an encrypted column added here by
// accident fails the leak test on the next line.
const PUBLIC_COLUMNS = [
  'id', 'user_id', 'name', 'exchange', 'last_import_at', 'created_at', 'updated_at',
  'api_key_last4', 'api_secret_last4',
  'last_sync_at', 'last_sync_status', 'last_sync_error', 'balance_report',
  'reconciliation_status', 'records_unavailable',
];

// The copy above cannot drift silently: once the fake pool is installed the
// real model is importable, and this pins the two lists to byte-equality.
test('the fake pool projection matches ExchangeAccount.PUBLIC_COLUMNS', () => {
  const ExchangeAccount = require('../src/models/ExchangeAccount');
  assert.deepEqual(PUBLIC_COLUMNS, ExchangeAccount.PUBLIC_COLUMNS);
});

const pgModulePath = require.resolve('pg');
require.cache[pgModulePath] = {
  id: pgModulePath,
  filename: pgModulePath,
  loaded: true,
  exports: {
    Pool: class FakePool {
      async query(text, params) { return fakeQuery(text, params); }
      async connect() {
        return { query: async (text, params) => fakeQuery(text, params), release() {} };
      }
      on() {}
    },
    types: { setTypeParser() {} },
  },
};

// --- fake axios ------------------------------------------------------------
//
// The connectors are the thing under test, so the transport is replaced rather
// than the connectors: every request they build (path, headers, body) lands
// here and can be asserted on.
const requests = [];
let krakenLedgerPages = null;
let krakenLedgerHistory = null;
let coinbaseTransactionPages = null;
let coinbaseAccountPages = null;
let coinbaseBrokeragePages = null;
let krakenFundingPages = null;
let failNextKrakenWith = null;
let failTransport = false;
// Real wall-clock latency, for the one test that needs two syncs genuinely
// overlapping rather than merely issued together.
let transportDelayMs = 0;

// What axios throws when the connection dies: an AxiosError carrying the whole
// signed request, headers and all. Reproducing it faithfully is the point --
// the credential leak this guards against lives on `config.headers`.
function transportFailure(url, headers, body) {
  const error = new Error('socket hang up');
  error.name = 'AxiosError';
  error.code = 'ECONNRESET';
  error.config = {
    method: body === undefined ? 'get' : 'post', url, headers: headers ?? {}, data: body,
  };
  error.request = {
    _header: [`${body === undefined ? 'GET' : 'POST'} ${url}`]
      .concat(Object.entries(headers ?? {}).map(([name, value]) => `${name}: ${value}`))
      .join('\r\n'),
  };
  throw error;
}

function krakenResponse(url, body) {
  const endpoint = url.split('/').pop();
  const params = new URLSearchParams(body);
  requests.push({ kind: 'kraken', endpoint, params, body });

  if (failNextKrakenWith) {
    const error = failNextKrakenWith;
    failNextKrakenWith = null;
    return { status: 200, data: { error: [error], result: {} } };
  }

  if (endpoint === 'Balance') {
    return { status: 200, data: { error: [], result: { XXBT: '0.0349000000', XETH: '0.2000000000', ZUSD: '997.2500' } } };
  }
  if (endpoint === 'WithdrawStatus' || endpoint === 'DepositStatus') {
    const pages = krakenFundingPages && krakenFundingPages[endpoint];
    if (pages) {
      const cursor = params.get('cursor');
      const index = cursor === 'true' ? 0 : pages.findIndex((page) => page._cursor === cursor);
      return { status: 200, data: { error: [], result: pages[index] ?? { withdrawal: [], next_cursor: null } } };
    }
    return { status: 200, data: KRAKEN_FUNDING[endpoint] };
  }
  if (endpoint === 'Ledgers') {
    // A whole synthetic history that honours start/end/ofs the way Kraken
    // documents them: start EXCLUSIVE, end INCLUSIVE, newest row first.
    if (krakenLedgerHistory) {
      const start = Number(params.get('start') || 0);
      const end = Number(params.get('end') || Number.MAX_SAFE_INTEGER);
      const offset = Number(params.get('ofs') || 0);
      const window = krakenLedgerHistory
        .filter((row) => row.time > start && row.time <= end)
        .sort((a, b) => b.time - a.time);
      const page = window.slice(offset, offset + 50);
      return {
        status: 200,
        data: {
          error: [],
          result: {
            ledger: Object.fromEntries(page.map((row) => [row.ledgerId, row])),
            count: window.length,
          },
        },
      };
    }
    if (krakenLedgerPages) {
      const offset = Number(params.get('ofs') || 0);
      const page = krakenLedgerPages[offset / 50] ?? { ledger: {}, count: 0 };
      return { status: 200, data: { error: [], result: page } };
    }
    return { status: 200, data: KRAKEN_LEDGERS };
  }
  return { status: 200, data: { error: [], result: {} } };
}

function coinbaseResponse(url, config) {
  const path = url.replace('https://api.coinbase.com', '');
  requests.push({ kind: 'coinbase', path, params: config?.params ?? {}, headers: config?.headers ?? {} });

  if (path === '/api/v3/brokerage/accounts') {
    if (coinbaseBrokeragePages) {
      const cursor = config?.params?.cursor;
      const index = cursor ? coinbaseBrokeragePages.findIndex((page) => page._cursor === cursor) : 0;
      return {
        status: 200,
        data: coinbaseBrokeragePages[index] ?? { accounts: [], has_next: false, cursor: '' },
      };
    }
    return { status: 200, data: COINBASE.brokerageAccounts };
  }
  if (path === '/api/v3/brokerage/orders/historical/fills') return { status: 200, data: COINBASE.fills };
  if (path === '/v2/accounts') {
    if (coinbaseAccountPages) {
      const after = config?.params?.starting_after;
      const index = after ? coinbaseAccountPages.findIndex((page) => page._after === after) : 0;
      return { status: 200, data: coinbaseAccountPages[index] ?? { data: [], pagination: {} } };
    }
    return { status: 200, data: COINBASE.v2Accounts };
  }
  if (/^\/v2\/accounts\/[^/]+\/transactions$/.test(path)) {
    if (coinbaseTransactionPages) {
      // Match the default fixture: only the first synthetic wallet carries the
      // transaction history. This keeps custom legacy pages from duplicating
      // every record when the connector walks the second account.
      if (!path.includes('11111111')) return { status: 200, data: { data: [], pagination: { next_uri: null } } };
      const after = config?.params?.starting_after;
      const index = after ? coinbaseTransactionPages.findIndex((page) => page._after === after) : 0;
      return { status: 200, data: coinbaseTransactionPages[index] ?? { data: [], pagination: {} } };
    }
    // Only the first v2 account carries the transactions; the second returns
    // an empty page so the per-account loop is exercised both ways.
    const isFirst = path.includes('11111111');
    return { status: 200, data: isFirst ? COINBASE.transactions : { data: [], pagination: { next_uri: null } } };
  }
  return { status: 200, data: {} };
}

const axiosModulePath = require.resolve('axios');
require.cache[axiosModulePath] = {
  id: axiosModulePath,
  filename: axiosModulePath,
  loaded: true,
  exports: {
    async post(url, body, config) {
      if (url.startsWith('https://api.kraken.com')) {
        if (failTransport) transportFailure(url, config?.headers, body);
        if (transportDelayMs) await new Promise((resolve) => { setTimeout(resolve, transportDelayMs); });
        requests[requests.length] = undefined;
        requests.pop();
        const response = krakenResponse(url, body);
        requests[requests.length - 1].headers = config?.headers ?? {};
        return response;
      }
      throw new Error(`unexpected POST ${url}`);
    },
    async get(url, config) {
      if (url.startsWith('https://api.coinbase.com')) {
        if (failTransport) transportFailure(url, config?.headers, undefined);
        return coinbaseResponse(url, config);
      }
      throw new Error(`unexpected GET ${url}`);
    },
  },
};

const request = require('supertest');
const app = require('../src/server');
const KrakenClient = require('../src/services/exchangeSync/krakenClient');
const CoinbaseClient = require('../src/services/exchangeSync/coinbaseClient');
const krakenConnector = require('../src/services/exchangeSync/kraken');
const coinbaseConnector = require('../src/services/exchangeSync/coinbase');
const ExchangeSyncService = require('../src/services/ExchangeSyncService');
const ExchangeRecord = require('../src/models/ExchangeRecord');
const { buildRecords } = require('../src/services/exchangeImport/krakenLedger');
const { parseExchangeCsv } = require('../src/services/exchangeImport');
const { addAmounts, negateAmount } = require('../src/services/exchangeImport/shared');

// A throwaway P-256 key in the shape Coinbase hands out. Generated here rather
// than committed: a PEM in a public repo reads like a leaked credential even
// when it is not.
const EC_KEY_PEM = crypto.generateKeyPairSync('ec', {
  namedCurve: 'prime256v1',
  privateKeyEncoding: { type: 'sec1', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});

function asUser(id) {
  if (id === undefined) delete process.env.DEV_AUTH_USER_ID;
  else process.env.DEV_AUTH_USER_ID = String(id);
}

beforeEach(() => {
  stored.clear();
  chainDetails.clear();
  queries.length = 0;
  requests.length = 0;
  derivedBalances = {};
  deriveFromStored = false;
  accountOverrides = {};
  nextStoredId = 1;
  accountSyncLockActive = false;
  krakenLedgerPages = null;
  krakenLedgerHistory = null;
  coinbaseTransactionPages = null;
  coinbaseAccountPages = null;
  coinbaseBrokeragePages = null;
  krakenFundingPages = null;
  failNextKrakenWith = null;
  failTransport = false;
  transportDelayMs = 0;
  process.env.SECRETS_ENCRYPTION_KEY = ENCRYPTION_KEY;
  asUser(undefined);
  KrakenClient._resetKeyState();
  CoinbaseClient._resetRateState();
  // Both clients pace themselves against the providers' documented limits
  // (Kraken's counter decays at 0.33/sec, so a 25-page walk really does take
  // ~2.5 minutes). The transport is faked here, so the pacing would only be
  // sleeping.
  KrakenClient._setPacingForTests(false);
  CoinbaseClient._setPacingForTests(false);
});

// Stores a credential the way the route does, so the sync tests have something
// to decrypt.
function connectAccount({ exchange = 'kraken', apiKey = 'KRAKEN-KEY-1234', apiSecret } = {}) {
  const secretCrypto = require('../src/utils/secretCrypto');
  const secret = apiSecret ?? Buffer.alloc(64, 3).toString('base64');
  accountOverrides = {
    exchange,
    api_key_encrypted: secretCrypto.encrypt(apiKey),
    api_key_last4: secretCrypto.last4(apiKey),
    api_secret_encrypted: secretCrypto.encrypt(secret),
    api_secret_last4: secretCrypto.last4(secret),
    api_configured: true,
  };
}

function legacyCoinbaseRecords() {
  return COINBASE_LEGACY.transactions.data.map((transaction, index) => (
    coinbaseConnector._internals.recordFromTransaction(transaction, {
      line: index + 1,
      fillsByOrder: new Map(),
    })
  ));
}

function useLegacyCoinbaseFixture() {
  coinbaseTransactionPages = [{
    data: COINBASE_LEGACY.transactions.data,
    pagination: { next_uri: null },
  }];
  coinbaseBrokeragePages = [{
    accounts: [
      {
        currency: 'BTC',
        available_balance: { value: '0.00030000', currency: 'BTC' },
        hold: { value: '0', currency: 'BTC' },
      },
      {
        currency: 'USD',
        available_balance: { value: '1.00', currency: 'USD' },
        hold: { value: '0', currency: 'USD' },
      },
      {
        currency: 'ETH2',
        available_balance: { value: '1.00000000', currency: 'ETH2' },
        hold: { value: '0', currency: 'ETH2' },
      },
    ],
    has_next: false,
    cursor: '',
  }];
}

// --- Kraken request signing ------------------------------------------------

test('kraken signing reproduces the worked example published in the auth guide', () => {
  // https://docs.kraken.com/api/docs/guides/spot-rest-auth
  // The whole point of a published vector: the four-step construction (SHA256
  // of nonce+body, RAW digest appended to the URI path, HMAC-SHA512 under the
  // base64-DECODED secret, base64 out) fails identically at every step -- one
  // opaque "EAPI:Invalid signature" -- so nothing but the vector can tell a
  // correct implementation from a wrong one.
  const secret = 'kQH5HW/8p1uGOVjbgWA7FunAmGO8lsSUXNsu3eow76sz84Q18fWxnyRzBHCd3pd5nE9qa99HAZtuZuj6F1huXg==';
  const postData = 'nonce=1616492376594&ordertype=limit&pair=XBTUSD&price=37500&type=buy&volume=1.25';

  assert.equal(
    KrakenClient.sign('/0/private/AddOrder', postData, secret),
    '4/dpxb3iT4tp/ZCVEwSnEsLxx0bqyhLpdfOpc6fn7OR8+UClSV5n9E6aSS8MPtnRfp32bAb0nmbRn6H8ndwLUQ=='
  );
});

test('kraken signing hashes the canonical string, not a rearrangement of it', () => {
  const secret = Buffer.alloc(64, 9).toString('base64');
  const postData = 'nonce=111&asset=all';

  // Reconstructed independently: SHA256(nonce + body) as RAW bytes appended to
  // the path, HMAC-SHA512 under the base64-decoded secret.
  const digest = crypto.createHash('sha256').update(`111${postData}`, 'utf8').digest();
  const expected = crypto
    .createHmac('sha512', Buffer.from(secret, 'base64'))
    .update(Buffer.concat([Buffer.from('/0/private/Ledgers', 'utf8'), digest]))
    .digest('base64');

  assert.equal(KrakenClient.sign('/0/private/Ledgers', postData, secret), expected);

  // The nonce appears twice in the SHA256 input -- once bare, once inside the
  // body -- and hashing the body alone is the classic near-miss.
  const withoutPrefix = crypto.createHash('sha256').update(postData, 'utf8').digest();
  const wrong = crypto
    .createHmac('sha512', Buffer.from(secret, 'base64'))
    .update(Buffer.concat([Buffer.from('/0/private/Ledgers', 'utf8'), withoutPrefix]))
    .digest('base64');
  assert.notEqual(expected, wrong);

  // ...and the digest goes in as bytes, not as hex text.
  const hexDigest = crypto
    .createHmac('sha512', Buffer.from(secret, 'base64'))
    .update(`/0/private/Ledgers${digest.toString('hex')}`)
    .digest('base64');
  assert.notEqual(expected, hexDigest);
});

test('kraken body puts the nonce first, because the signature prepends it', () => {
  const body = KrakenClient.encodeBody('42', { ofs: 50, asset: 'all', empty: '' });
  assert.ok(body.startsWith('nonce=42'), body);
  // Empty values are dropped rather than sent as blanks: the string signed and
  // the string sent have to be byte-identical, so anything optional must be
  // absent from both or present in both.
  assert.equal(body.includes('empty'), false);
});

test('kraken refuses to call anything that is not a read endpoint', async () => {
  const client = new KrakenClient({ apiKey: 'k', apiSecret: Buffer.alloc(32, 1).toString('base64') });
  await assert.rejects(() => client.request('AddOrder', {}), /not a read endpoint/);
  await assert.rejects(() => client.request('Withdraw', {}), /not a read endpoint/);
  assert.equal(KrakenClient.ALLOWED_ENDPOINTS.has('Balance'), true);
});

test('kraken treats HTTP 200 with a populated error array as a failure', async () => {
  const client = new KrakenClient({ apiKey: 'k', apiSecret: Buffer.alloc(32, 1).toString('base64') });
  failNextKrakenWith = 'EGeneral:Permission denied';
  // A 2xx that carries an error is Kraken's normal failure shape. Trusting the
  // status code here is how an empty ledger becomes "a complete history".
  await assert.rejects(() => client.getBalance(), (err) => {
    assert.equal(err.code, 'KRAKEN_AUTH_FAILED');
    assert.match(err.message, /Permission denied/);
    return true;
  });
});

// --- Coinbase JWT ----------------------------------------------------------

test('coinbase JWT carries the documented header and claims', () => {
  // https://docs.cdp.coinbase.com/coinbase-app/authentication-authorization/api-key-authentication
  const keyName = 'organizations/org-1/apiKeys/key-1';
  const token = CoinbaseClient.buildJwt({
    keyName,
    privateKey: crypto.createPrivateKey(EC_KEY_PEM.privateKey),
    method: 'GET',
    path: '/api/v3/brokerage/accounts',
    nowSeconds: 1700000000,
  });

  const [headerB64, payloadB64, signatureB64] = token.split('.');
  const header = JSON.parse(Buffer.from(headerB64, 'base64url'));
  const payload = JSON.parse(Buffer.from(payloadB64, 'base64url'));

  assert.equal(header.alg, 'ES256');
  assert.equal(header.typ, 'JWT');
  assert.equal(header.kid, keyName);
  // The nonce belongs in the HEADER. Putting it in the claims is a silent 401.
  assert.match(header.nonce, /^[0-9a-f]{32}$/);
  assert.equal(payload.nonce, undefined);

  // 'cdp', not the 'coinbase-cloud' the stale C# sample on that page still uses.
  assert.equal(payload.iss, 'cdp');
  assert.equal(payload.sub, keyName);
  // nbf is backdated against clock skew: with no leeway a server a second
  // ahead of Coinbase's mints a not-yet-valid token, which arrives as the same
  // opaque 401 a bad key does. exp still counts from the real issue time, so
  // the token never outlives the documented 2 minutes.
  assert.equal(payload.nbf, 1700000000 - CoinbaseClient.CLOCK_SKEW_LEEWAY_SECONDS);
  assert.equal(payload.exp, 1700000000 + 120);
  assert.ok(payload.exp - payload.nbf <= 120 + CoinbaseClient.CLOCK_SKEW_LEEWAY_SECONDS);
  // METHOD, one space, host + path. No scheme and no query string.
  assert.equal(payload.uri, 'GET api.coinbase.com/api/v3/brokerage/accounts');

  // ES256's JOSE encoding is the raw r||s pair: 64 bytes, never DER.
  assert.equal(Buffer.from(signatureB64, 'base64url').length, 64);
  assert.equal(crypto.verify(
    'sha256',
    Buffer.from(`${headerB64}.${payloadB64}`),
    { key: crypto.createPublicKey(EC_KEY_PEM.publicKey), dsaEncoding: 'ieee-p1363' },
    Buffer.from(signatureB64, 'base64url')
  ), true);
});

test('coinbase names an Ed25519 key as the wrong key type instead of failing as a 401', () => {
  // Ed25519 keys download as bare base64 and are explicitly unsupported here.
  // Signed anyway they produce an opaque 401, which reads as "bad key" and
  // sends the user to regenerate exactly the same unusable key.
  assert.throws(
    () => CoinbaseClient.parsePrivateKey(Buffer.alloc(64, 5).toString('base64')),
    (err) => {
      assert.equal(err.code, 'COINBASE_KEY_FORMAT');
      assert.match(err.message, /ECDSA/);
      return true;
    }
  );
});

test('coinbase refuses any path outside the read allowlist', async () => {
  const client = new CoinbaseClient({ apiKey: 'organizations/o/apiKeys/k', apiSecret: EC_KEY_PEM.privateKey });
  await assert.rejects(() => client.get('/api/v3/brokerage/orders'), /not a read endpoint/);
  // There is no post/put/delete on the client at all -- v2's Send Money is a
  // POST to a path that IS on the allowlist, so GET-only is the real guard.
  assert.equal(typeof client.post, 'undefined');
});

test('a JWT is minted per request, so a paginated walk never replays one', async () => {
  const client = new CoinbaseClient({ apiKey: 'organizations/o/apiKeys/k', apiSecret: EC_KEY_PEM.privateKey });
  await client.get('/v2/accounts', { limit: 100 });
  await client.get('/v2/accounts', { limit: 100, starting_after: 'x' });

  const tokens = requests.map((entry) => entry.headers.Authorization);
  assert.equal(tokens.length, 2);
  assert.notEqual(tokens[0], tokens[1]);
  // The query string rides in params, never in the signed uri claim.
  const claims = JSON.parse(Buffer.from(tokens[1].split('.')[1].replace('Bearer ', ''), 'base64url'));
  assert.equal(claims.uri, 'GET api.coinbase.com/v2/accounts');
});

// --- Kraken connector ------------------------------------------------------

test('kraken: the two ledger legs of a trade pair by refid into one record', async () => {
  connectAccount();
  const result = await krakenConnector.sync(
    { apiKey: 'k', apiSecret: Buffer.alloc(32, 1).toString('base64') },
    { cursor: null }
  );

  const byId = new Map(result.records.map((record) => [record.external_id, record]));
  const trade = byId.get('kraken:TTRD00-11111-TTTTTT');
  assert.ok(trade, 'the paired trade is keyed by its refid');
  assert.equal(trade.record_type, 'trade');
  assert.equal(trade.base_asset, 'ETH');
  // The exchange's own precision is preserved rather than normalized: this is
  // a quantity, not a computed total, and NUMERIC(38,18) can hold it exactly.
  assert.equal(trade.base_amount, '0.2000000000');
  assert.equal(trade.quote_asset, 'USD');
  assert.equal(trade.quote_amount, '-500.0000');
  assert.equal(trade.needs_review, false);
  // Neither leg survives as a record of its own.
  assert.equal(byId.has('kraken:LBBBBB-22222-BBBBBB'), false);
  assert.equal(byId.has('kraken:LCCCCC-33333-CCCCCC'), false);

  // spend + receive under one refid is a conversion, not two transfers.
  const conversion = byId.get('kraken:TCNV00-55555-CCCCCC');
  assert.equal(conversion.record_type, 'conversion');
  assert.equal(conversion.base_asset, 'SOL');
  assert.equal(conversion.quote_asset, 'USD');

  // A trade leg whose counter-leg is not in the window keys the REFID anyway,
  // so the complete pair lands on it later instead of beside it.
  const widowed = byId.get('kraken:TTRD99-99999-WWWWWW');
  assert.equal(widowed.needs_review, true);
  assert.equal(byId.has('kraken:LMMMMM-33333-MMMMMM'), false);
});

test('kraken: staking and reward rows are income; earn wallet moves are not', async () => {
  const result = await krakenConnector.sync(
    { apiKey: 'k', apiSecret: Buffer.alloc(32, 1).toString('base64') },
    { cursor: null }
  );
  const byId = new Map(result.records.map((record) => [record.external_id, record]));

  const staking = byId.get('kraken:LDDDDD-44444-DDDDDD');
  assert.equal(staking.record_type, 'reward');
  // ETH2 is pre-merge staked ETH and the same asset today.
  assert.equal(staking.base_asset, 'ETH');

  assert.equal(byId.get('kraken:LEEEEE-55555-EEEEEE').record_type, 'reward');
  assert.equal(byId.get('kraken:LEEEEE-55555-EEEEEE').base_asset, 'ADA', '.S suffix stripped');

  // Booking these as rewards would count the whole allocated principal as
  // income, twice -- once each way.
  assert.equal(byId.get('kraken:LFFFFF-66666-FFFFFF').record_type, 'transfer');
  assert.equal(byId.get('kraken:LGGGGG-77777-GGGGGG').record_type, 'transfer');
  assert.equal(byId.get('kraken:LHHHHH-88888-HHHHHH').record_type, 'transfer');
});

test('kraken: numbered aliases aggregate live balances and preserve provider identity', () => {
  const { normalizeBalances, toRecordRows } = krakenConnector._internals;
  const balances = normalizeBalances({
    SOL: '4',
    SOL03: '2',
    'SOL03.S': '3',
    'SOL04.S': '5',
  });

  assert.deepEqual(balances, { SOL: '9', SOL04: '5' });

  const rows = toRecordRows([
    {
      ledgerId: '', refid: '', time: 1712016000, type: 'transfer', subtype: '',
      asset: 'SOL03.S', amount: '1', fee: '0', balance: '1', aclass: 'currency',
    },
  ], new Map());
  assert.equal(rows[0].asset, 'SOL');
  assert.equal(rows[0].identityAsset, 'SOL03');
  assert.equal(rows[0].raw.asset, 'SOL03.S');

  const report = ExchangeSyncService.reconcile(balances, { SOL: '9', SOL04: '5' });
  assert.equal(report.mismatch_count, 0);
});

test('kraken: an unknown ledger type imports flagged, never skipped', async () => {
  const result = await krakenConnector.sync(
    { apiKey: 'k', apiSecret: Buffer.alloc(32, 1).toString('base64') },
    { cursor: null }
  );
  const unknown = result.records.find((record) => record.external_id === 'kraken:LLLLLL-22222-LLLLLL');

  assert.ok(unknown, 'a type nobody recognizes is still a row the exchange wrote');
  // The least committal type: a mystery row must not become income or enter
  // the on-chain matching pass as a deposit.
  assert.equal(unknown.record_type, 'transfer');
  assert.equal(unknown.needs_review, true);
  assert.equal(unknown.raw.type, 'quantumsettlement');
  assert.equal(result.stats.unknownTypes, 1);
});

test('kraken: a withdrawal keeps the network txid and destination address', async () => {
  const result = await krakenConnector.sync(
    { apiKey: 'k', apiSecret: Buffer.alloc(32, 1).toString('base64') },
    { cursor: null }
  );
  const withdrawal = result.records.find((record) => record.external_id === 'kraken:LKKKKK-11111-KKKKKK');

  assert.equal(withdrawal.record_type, 'withdrawal');
  // The Ledgers feed carries neither of these; they come from WithdrawStatus,
  // joined on refid. Forgotten-wallet discovery reads the address column.
  assert.equal(withdrawal.tx_hash, 'b7a1c3d5e7f90123456789abcdef0123456789abcdef0123456789abcdef0123');
  assert.equal(withdrawal.address, 'bc1qsynthetic0000000000000000000000000test');
  assert.equal(withdrawal.network, 'Bitcoin');
  assert.equal(withdrawal.chain_id, null, 'non-EVM networks stay explicit but un-normalized');

  // DepositStatus answers with the WRAPPED shape in the fixture and
  // WithdrawStatus with a bare array; both have to read.
  const deposit = result.records.find((record) => record.external_id === 'kraken:LAAAAA-11111-AAAAAA');
  assert.equal(deposit.record_type, 'deposit');
  // Addresses are stored lowercase so an exchange withdrawal can join to the
  // on-chain transfer it produced.
  assert.equal(deposit.address, '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb');
  assert.equal(deposit.network, 'Ethereum');
  assert.equal(deposit.chain_id, 1);
});

test('kraken: paging walks ofs until a short page, then stops', async () => {
  const ids = Object.keys(KRAKEN_LEDGERS.result.ledger);
  const entryFor = (index) => {
    const id = `LPAGE${String(index).padStart(2, '0')}-00000-PPPPPP`;
    return [id, { ...KRAKEN_LEDGERS.result.ledger[ids[index % ids.length]], refid: `RPAGE-${index}` }];
  };
  krakenLedgerPages = [
    { ledger: Object.fromEntries(Array.from({ length: 50 }, (_, i) => entryFor(i))), count: 60 },
    { ledger: Object.fromEntries(Array.from({ length: 10 }, (_, i) => entryFor(50 + i))), count: 60 },
  ];

  const result = await krakenConnector.sync(
    { apiKey: 'k', apiSecret: Buffer.alloc(32, 1).toString('base64') },
    { cursor: null }
  );

  const ledgerCalls = requests.filter((entry) => entry.endpoint === 'Ledgers');
  assert.equal(ledgerCalls.length, 2, 'a full page means there may be more; a short one means there is not');
  assert.equal(ledgerCalls[0].params.get('ofs'), null, 'the first page sends no offset');
  assert.equal(ledgerCalls[1].params.get('ofs'), '50');
  assert.equal(result.stats.rows, 60);
  assert.equal(result.stats.backfillPending, false);
});

test('kraken: a truncated walk keeps a resume point instead of claiming it finished', async () => {
  // Every page full, so the page budget runs out before the history does.
  const template = Object.values(KRAKEN_LEDGERS.result.ledger)[0];
  krakenLedgerPages = Array.from({ length: 40 }, (_, page) => ({
    ledger: Object.fromEntries(Array.from({ length: 50 }, (_, i) => {
      const n = page * 50 + i;
      return [`LBULK${String(n).padStart(4, '0')}-0-P`, { ...template, refid: `RBULK-${n}`, time: 1709283600 + n }];
    })),
    count: 2000,
  }));

  const result = await krakenConnector.sync(
    { apiKey: 'k', apiSecret: Buffer.alloc(32, 1).toString('base64') },
    { cursor: null, interactive: true }
  );

  assert.equal(result.stats.pages, krakenConnector.MAX_PAGES_INTERACTIVE);
  assert.equal(result.stats.backfillPending, true);
  // Ledgers returns NEWEST first, so a page budget truncates the OLD end. A
  // plain "newest time seen" watermark would mark the backfill complete and
  // strand everything older than the budget forever.
  assert.ok(Number.isFinite(result.cursor.pendingEnd), 'the unfinished window carries an end to resume from');
  assert.equal(result.cursor.pendingStart, 0);
});

test('kraken: repeated syncs read a long history to the end, skipping nothing', async () => {
  // The property the whole cursor design exists for, driven through the real
  // connector against a feed that honours start/end/ofs the way Kraken
  // documents them. 3,000 rows against a 1,250-row interactive budget, so the
  // first pass necessarily truncates.
  const template = Object.values(KRAKEN_LEDGERS.result.ledger)[0];
  const newest = 1710093600;
  // One row an hour, so the history is months long rather than fifty minutes:
  // a history shorter than RESUME_OVERLAP_SECONDS would be re-read whole by
  // the incremental pass and prove nothing about it.
  krakenLedgerHistory = Array.from({ length: 3000 }, (_, i) => ({
    ...template,
    ledgerId: `LHIST${String(i).padStart(4, '0')}-0-H`,
    refid: `RHIST-${i}`,
    type: 'deposit',
    time: newest - (i * 3600),
  }));

  const seen = new Set();
  let cursor = null;
  let runs = 0;
  for (; runs < 10; runs += 1) {
    // eslint-disable-next-line no-await-in-loop
    const result = await krakenConnector.sync(
      { apiKey: 'k', apiSecret: Buffer.alloc(32, 1).toString('base64') },
      { cursor, interactive: true }
    );
    result.records.forEach((record) => seen.add(record.external_id));
    cursor = result.cursor;
    if (!result.stats.backfillPending) break;
  }

  assert.ok(runs < 9, `the backfill has to converge; it took ${runs + 1} runs`);
  // Every single ledger row reached a record. A cursor that advanced past
  // unread rows would leave a hole here that nothing downstream could detect.
  assert.equal(seen.size, 3000);
  assert.equal(cursor.pendingEnd, null);

  // ...and once finished, a further sync is incremental rather than a fourth
  // walk of the whole history.
  requests.length = 0;
  await krakenConnector.sync(
    { apiKey: 'k', apiSecret: Buffer.alloc(32, 1).toString('base64') },
    { cursor, interactive: true }
  );
  assert.ok(requests.filter((entry) => entry.endpoint === 'Ledgers').length <= 2);
});

test('kraken: a page-budget boundary inside one second loses nothing', async () => {
  // Kraken's `time` is a float and its two trade legs share an IDENTICAL one,
  // so the interesting boundary is sub-second. A resume point that rounds DOWN
  // reads like a one-second overlap and is actually a one-second gap: every
  // row between the two windows falls out and no later run can reach it,
  // because the resume point only ever moves further down.
  const template = Object.values(KRAKEN_LEDGERS.result.ledger)[0];
  const newest = 1710093600;
  krakenLedgerHistory = [];
  for (let i = 0; i < 2600; i += 1) {
    // Ten rows per second, so a 1,250-row budget necessarily cuts mid-second.
    krakenLedgerHistory.push({
      ...template,
      ledgerId: `LFRAC${String(i).padStart(4, '0')}-0-F`,
      refid: `RFRAC-${i}`,
      type: 'deposit',
      time: newest - Math.floor(i / 10) - ((i % 10) / 10),
    });
  }

  const seen = new Set();
  let cursor = null;
  for (let run = 0; run < 10; run += 1) {
    // eslint-disable-next-line no-await-in-loop
    const result = await krakenConnector.sync(
      { apiKey: 'k', apiSecret: Buffer.alloc(32, 1).toString('base64') },
      { cursor, interactive: true }
    );
    result.records.forEach((record) => seen.add(record.external_id));
    cursor = result.cursor;
    if (!result.stats.backfillPending) break;
  }

  assert.equal(seen.size, 2600, 'every row must survive a boundary that falls inside a second');
});

test('kraken: an incremental sync rewinds past the watermark rather than resuming exactly on it', async () => {
  await krakenConnector.sync(
    { apiKey: 'k', apiSecret: Buffer.alloc(32, 1).toString('base64') },
    { cursor: { newestTime: 1710093600, pendingStart: null, pendingEnd: null } }
  );

  const ledgerCall = requests.find((entry) => entry.endpoint === 'Ledgers');
  // `start` is documented EXCLUSIVE and two rows can share a timestamp, so
  // resuming on the watermark itself silently drops any row that ties it.
  assert.equal(
    Number(ledgerCall.params.get('start')),
    1710093600 - krakenConnector.RESUME_OVERLAP_SECONDS
  );
});

test('kraken: balances fold every wallet spelling of one asset into one position', () => {
  const { normalizeBalances } = krakenConnector._internals;
  const folded = normalizeBalances({
    XETH: '1.5', ETH2: '2.5', 'ETH2.S': '0.25', ZUSD: '100.10', DOT: '3',
  });

  // XETH, ETH2 and ETH2.S are three keys in one Balance response and one
  // position in the ledger; overwriting instead of summing would report a
  // mismatch on a healthy account every night.
  assert.equal(folded.ETH, '4.25');
  assert.equal(folded.USD, '100.1');
  assert.equal(folded.DOT, '3');
});

// --- Coinbase connector ----------------------------------------------------

test('coinbase: historical staking and ETH2 aliases normalize without losing provider types', () => {
  const expected = new Map([
    ['staking_reward', 'reward'],
    ['inflation_reward', 'reward'],
    ['interest', 'reward'],
    ['retail_eth2_deprecation', 'transfer'],
  ]);
  const records = legacyCoinbaseRecords();

  assert.equal(records.length, expected.size);
  for (const record of records) {
    const providerType = record.raw.type;
    assert.equal(record.record_type, expected.get(providerType), providerType);
    assert.equal(record.needs_review, false, providerType);
    assert.equal(record.external_id, `cb:${record.raw.id}`);
    assert.ok(record.base_asset, providerType);
    assert.ok(record.base_amount, providerType);
  }
});

test('coinbase: a full backfill upgrades legacy rows and recalculates durable state', async () => {
  connectAccount({
    exchange: 'coinbase',
    apiKey: 'organizations/o/apiKeys/k',
    apiSecret: EC_KEY_PEM.privateKey,
  });
  useLegacyCoinbaseFixture();
  deriveFromStored = true;

  const incoming = legacyCoinbaseRecords();
  incoming.forEach((record) => seedStoredRecord(COINBASE_ACCOUNT_ID, record, { needsReview: true }));

  const response = await request(app).post(`/api/exchanges/${COINBASE_ACCOUNT_ID}/sync`);

  assert.equal(response.status, 200);
  assert.equal(response.body.imported, 0);
  assert.equal(response.body.upgraded, incoming.length);
  assert.equal(response.body.duplicates, 0);
  assert.equal(response.body.needs_review, 0);
  assert.equal(response.body.status, 'ok');
  assert.equal(response.body.balance_report.mismatch_count, 0);
  assert.equal(response.body.backfill_pending, false);
  assert.equal(stored.size, incoming.length);

  for (const record of incoming) {
    const saved = stored.get(storedKey(COINBASE_ACCOUNT_ID, record.external_id));
    assert.equal(saved.record_type, record.record_type);
    assert.equal(saved.needs_review, false);
    assert.equal(saved.raw.type, record.raw.type);
    assert.equal(saved.base_amount, record.base_amount);
  }

  const reviewQueue = await request(app)
    .get(`/api/exchanges/${COINBASE_ACCOUNT_ID}/records?needs_review=true`);
  assert.equal(reviewQueue.status, 200);
  assert.equal(reviewQueue.body.pagination.total, 0);

  // The first pass advanced the cursor. Force the same full-history contract a
  // second time to prove clean rows are duplicates, not repeat upgrades.
  accountOverrides = { ...accountOverrides, sync_cursor: null };
  const second = await request(app).post(`/api/exchanges/${COINBASE_ACCOUNT_ID}/sync`);
  assert.equal(second.status, 200);
  assert.equal(second.body.imported, 0);
  assert.equal(second.body.upgraded, 0);
  assert.equal(second.body.duplicates, incoming.length);
  assert.equal(stored.size, incoming.length);
});

test('coinbase: a resolved legacy row is not overwritten by a later clean import', async () => {
  const { recordFromTransaction } = coinbaseConnector._internals;
  const record = recordFromTransaction({
    id: 'manual-legacy-row',
    type: 'staking_reward',
    created_at: '2024-03-10T12:00:00Z',
    amount: { amount: '0.25', currency: 'BTC' },
  }, { line: 1, fillsByOrder: new Map() });
  const resolved = seedStoredRecord(COINBASE_ACCOUNT_ID, {
    ...record,
    record_type: 'transfer',
    raw: { _format: 'coinbase', _source: 'csv', type: 'manual_review' },
  }, { needsReview: false });

  const result = await ExchangeRecord.bulkInsert(COINBASE_ACCOUNT_ID, [record]);

  assert.deepEqual(result, {
    inserted: 0,
    upgraded: 0,
    duplicates: 1,
    deduplicated: 0,
    duplicateCandidates: 0,
    duplicateConflicts: 0,
    total: 1,
  });
  assert.equal(stored.get(storedKey(COINBASE_ACCOUNT_ID, record.external_id)).id, resolved.id);
  assert.equal(stored.get(storedKey(COINBASE_ACCOUNT_ID, record.external_id)).record_type, 'transfer');
  assert.equal(stored.get(storedKey(COINBASE_ACCOUNT_ID, record.external_id)).raw.type, 'manual_review');
});

test('coinbase: buys, sends, rewards and conversions map to the right record types', async () => {
  const result = await coinbaseConnector.sync(
    { apiKey: 'organizations/o/apiKeys/k', apiSecret: EC_KEY_PEM.privateKey },
    { cursor: null }
  );
  const byId = new Map(result.records.map((record) => [record.external_id, record]));

  // Keyed by the v2 transaction id -- the same id the retail CSV export's ID
  // column carries, which is what makes the two sources dedupe.
  const fill = byId.get('cb:aaaaaaaa-0000-0000-0000-00000000000a');
  assert.equal(fill.record_type, 'trade');
  assert.equal(fill.base_asset, 'BTC');
  assert.equal(fill.quote_asset, 'USD');
  assert.equal(fill.fee_amount, '1.55');

  const send = byId.get('cb:bbbbbbbb-0000-0000-0000-00000000000b');
  assert.equal(send.record_type, 'withdrawal');
  assert.equal(send.tx_hash, '0x3333333333333333333333333333333333333333333333333333333333333333');
  assert.equal(send.address, '0xcccccccccccccccccccccccccccccccccccccccc');

  assert.equal(byId.get('cb:cccccccc-0000-0000-0000-00000000000c').record_type, 'reward');
});

test('coinbase: a convert\'s two legs become one conversion keyed on the outgoing leg', async () => {
  const result = await coinbaseConnector.sync(
    { apiKey: 'organizations/o/apiKeys/k', apiSecret: EC_KEY_PEM.privateKey },
    { cursor: null }
  );
  const byId = new Map(result.records.map((record) => [record.external_id, record]));

  // A Convert writes two v2 transactions sharing a trade.id, one per account.
  // Imported separately they read as two unrelated moves. Folded, the record is
  // keyed on the OUTGOING leg's transaction id -- the trade id groups the legs
  // but cannot key the row, because the retail CSV export has no trade-id
  // column and the two readers must agree on one id.
  const conversion = byId.get('cb:dddddddd-0000-0000-0000-00000000000d');
  assert.equal(conversion.record_type, 'conversion');
  assert.equal(conversion.base_asset, 'USD');
  assert.equal(conversion.base_amount, '-100.00');
  assert.equal(conversion.quote_asset, 'BTC');
  assert.equal(conversion.quote_amount, '0.00160000');
  // The incoming leg does not survive as a record of its own, and neither does
  // the abandoned trade-keyed spelling.
  assert.equal(byId.has('cb:eeeeeeee-0000-0000-0000-00000000000e'), false);
  assert.equal(byId.has('cb:t:trade-0000-0000-0000-000000000001'), false);
});

test('coinbase: a trade\'s quote leg is signed against the base, as the CSV reader signs it', async () => {
  const { recordFromTransaction } = coinbaseConnector._internals;
  // native_amount VALUES the event, so Coinbase writes it with the same sign as
  // `amount`. The quote leg has to carry the opposite one: buying an asset
  // spends the quote. Copied verbatim, a $1,000 buy records +1000 USD where the
  // true effect is -1000, so derivedBalances (base + quote - fee) comes out by
  // twice the notional on every single trade.
  const buy = recordFromTransaction({
    id: 'buy-1',
    type: 'buy',
    created_at: '2024-03-02T10:00:00Z',
    amount: { amount: '1.00000000', currency: 'BTC' },
    native_amount: { amount: '1000.00', currency: 'USD' },
  }, { line: 1, fillsByOrder: new Map() });

  assert.equal(buy.base_amount, '1.00000000');
  assert.equal(buy.quote_asset, 'USD');
  assert.equal(buy.quote_amount, '-1000.00', 'buying spends the quote');

  const sell = recordFromTransaction({
    id: 'sell-1',
    type: 'sell',
    created_at: '2024-03-02T10:00:00Z',
    amount: { amount: '-1.00000000', currency: 'BTC' },
    native_amount: { amount: '-1000.00', currency: 'USD' },
  }, { line: 2, fillsByOrder: new Map() });

  assert.equal(sell.quote_amount, '1000.00', 'selling receives the quote');
});

test('coinbase: a transaction without a provider id gets a stable reviewable fallback id', () => {
  const { recordFromTransaction } = coinbaseConnector._internals;
  const transaction = {
    type: 'receive',
    created_at: '2024-03-02T10:00:00Z',
    amount: { amount: '1.25', currency: 'BTC' },
    to: { address: '0x1111111111111111111111111111111111111111' },
  };
  const first = recordFromTransaction(transaction, { line: 1, fillsByOrder: new Map() });
  const replay = recordFromTransaction({ ...transaction }, { line: 99, fillsByOrder: new Map() });

  assert.match(first.external_id, /^coinbase:transaction:h:[0-9a-f]{40}$/);
  assert.equal(first.external_id, replay.external_id);
  assert.equal(first.needs_review, true);
});

test('coinbase: a widowed convert leg is flagged, and the outgoing one is upgradeable in place', async () => {
  const { foldConversions, recordFromTransaction, recordFromConversion } = coinbaseConnector._internals;
  const from = {
    id: 'leg-from', type: 'trade', created_at: '2024-03-07T15:00:00Z',
    amount: { amount: '-100.00', currency: 'USD' }, trade: { id: 'trade-1' },
  };
  const to = {
    id: 'leg-to', type: 'trade', created_at: '2024-03-07T15:00:00Z',
    amount: { amount: '0.00160000', currency: 'BTC' }, trade: { id: 'trade-1' },
  };

  // The two legs live in two different v2 accounts sharing one page budget, so
  // a boundary between them fetches only one.
  const orphanedOut = foldConversions([from]);
  assert.equal(orphanedOut.pairs.length, 0);
  const outgoingOrphan = recordFromTransaction(orphanedOut.singles[0], { line: 1, fillsByOrder: new Map() });

  const complete = foldConversions([from, to]);
  const paired = recordFromConversion(complete.pairs[0], { line: 1 });

  // The canonical id is the OUTGOING leg's, so a lone outgoing leg lands on the
  // id the complete pair will carry and the existing ON CONFLICT arm upgrades
  // it in place rather than landing a second row beside it.
  assert.equal(outgoingOrphan.external_id, paired.external_id);
  assert.equal(paired.external_id, 'cb:leg-from');
  assert.equal(outgoingOrphan.needs_review, true);
  assert.equal(paired.needs_review, false);

  // A lone INCOMING leg cannot compute the outgoing leg's id from anything it
  // carries, so it keys its own and is flagged. That is the knowingly accepted
  // residual of keying on something the CSV reader can also compute: a second
  // visible flagged half-row, never a silently doubled position.
  const incomingOrphan = recordFromTransaction(
    foldConversions([to]).singles[0], { line: 1, fillsByOrder: new Map() }
  );
  assert.equal(incomingOrphan.external_id, 'cb:leg-to');
  assert.equal(incomingOrphan.needs_review, true);
});

test('coinbase: an account list that was cut short is not reported as a finished sync', async () => {
  // >1 page of v2 accounts, all pointing onward: accounts exist that were never
  // enumerated, let alone walked.
  const account = COINBASE.v2Accounts.data[0];
  coinbaseAccountPages = Array.from({ length: 40 }, (_, page) => ({
    _after: page === 0 ? undefined : `acct-${page * 100 - 1}`,
    data: Array.from({ length: 100 }, (_, i) => ({ ...account, id: `acct-${page * 100 + i}` })),
    pagination: { next_uri: `/v2/accounts?starting_after=acct-${page * 100 + 99}` },
  }));

  const result = await coinbaseConnector.sync(
    { apiKey: 'organizations/o/apiKeys/k', apiSecret: EC_KEY_PEM.privateKey },
    { cursor: null, interactive: true }
  );

  // Advancing the watermark here would stamp the run 'ok' with whole accounts
  // never read at all.
  assert.equal(result.stats.backfillPending, true);
  assert.equal(result.cursor.since, null);
});

test('coinbase: an oversized account list resumes from its last account cursor', async () => {
  const template = COINBASE.v2Accounts.data[0];
  coinbaseAccountPages = Array.from({ length: 26 }, (_, page) => ({
    _after: page === 0 ? undefined : `acct-${page * 100 - 1}`,
    data: Array.from({ length: 100 }, (_, i) => ({ ...template, id: `acct-${page * 100 + i}` })),
    pagination: page < 25
      ? { next_uri: `/v2/accounts?starting_after=acct-${page * 100 + 99}` }
      : { next_uri: null },
  }));

  const first = await coinbaseConnector.sync(
    { apiKey: 'organizations/o/apiKeys/k', apiSecret: EC_KEY_PEM.privateKey },
    { cursor: null, interactive: true }
  );
  assert.equal(first.stats.backfillPending, true);
  assert.equal(first.cursor.accountsStartAfter, 'acct-2499');

  requests.length = 0;
  await coinbaseConnector.sync(
    { apiKey: 'organizations/o/apiKeys/k', apiSecret: EC_KEY_PEM.privateKey },
    { cursor: first.cursor, interactive: false }
  );
  const accountCalls = requests.filter((entry) => entry.path === '/v2/accounts');
  assert.equal(accountCalls[0].params.starting_after, 'acct-2499');
});

test('coinbase: a multi-run backfill dates the watermark from when it started', async () => {
  // The head of each account is read on the first pass; the resume passes start
  // at a stored starting_after id and deliberately skip it. Stamping the
  // COMPLETING pass's time would declare everything up to then covered, and any
  // row written in between falls in the band and is never fetched.
  const template = COINBASE.transactions.data[2];
  coinbaseTransactionPages = Array.from({ length: 60 }, (_, index) => ({
    _after: index === 0 ? undefined : `cb-tx-${index * 100 - 1}`,
    data: Array.from({ length: 100 }, (_, i) => ({ ...template, id: `cb-tx-${index * 100 + i}` })),
    pagination: { next_uri: `/v2/accounts/x/transactions?starting_after=cb-tx-${index * 100 + 99}` },
  }));

  const first = await coinbaseConnector.sync(
    { apiKey: 'organizations/o/apiKeys/k', apiSecret: EC_KEY_PEM.privateKey },
    { cursor: null, interactive: true }
  );
  assert.equal(first.stats.backfillPending, true);
  const headStartedAt = first.cursor.headStartedAt;
  assert.ok(headStartedAt, 'the pass that read the head has to record when it did');

  // Now let the walk finish, and check the watermark is the FIRST pass's time.
  coinbaseTransactionPages = [{ data: [], pagination: { next_uri: null } }];
  const last = await coinbaseConnector.sync(
    { apiKey: 'organizations/o/apiKeys/k', apiSecret: EC_KEY_PEM.privateKey },
    { cursor: first.cursor, interactive: true }
  );

  assert.equal(last.stats.backfillPending, false);
  assert.equal(last.cursor.since, headStartedAt);
  assert.deepEqual(last.cursor.pending, {});
});

test('coinbase: a transaction type nobody recognizes imports flagged', async () => {
  const result = await coinbaseConnector.sync(
    { apiKey: 'organizations/o/apiKeys/k', apiSecret: EC_KEY_PEM.privateKey },
    { cursor: null }
  );
  const unknown = result.records.find((record) => record.external_id === 'cb:ffffffff-0000-0000-0000-00000000000f');

  assert.equal(unknown.record_type, 'transfer');
  assert.equal(unknown.needs_review, true);
  assert.equal(result.stats.unknownTypes, 1);
});

test('coinbase: an adjusted fill is never folded into the order totals', () => {
  const { summarizeFills } = coinbaseConnector._internals;
  const { byOrder, adjusted } = summarizeFills(COINBASE.fills.fills);

  // trade_type carries REVERSAL / CORRECTION / SYNTHETIC for adjusted fills.
  // Averaging those in would count an amended trade twice.
  assert.equal(adjusted, 1);
  assert.equal(byOrder.size, 1);
  assert.equal(byOrder.get('o0000000-0000-0000-0000-000000000001').commission, '1.55');
});

test('coinbase: v2 paging stops on an empty next_uri and threads starting_after', async () => {
  coinbaseTransactionPages = [
    {
      data: [
        { ...COINBASE.transactions.data[0], id: 'page1-a' },
        { ...COINBASE.transactions.data[2], id: 'page1-b' },
      ],
      pagination: { next_uri: '/v2/accounts/x/transactions?starting_after=page1-b' },
    },
    {
      _after: 'page1-b',
      data: [{ ...COINBASE.transactions.data[2], id: 'page2-a' }],
      pagination: { next_uri: null },
    },
  ];

  const result = await coinbaseConnector.sync(
    { apiKey: 'organizations/o/apiKeys/k', apiSecret: EC_KEY_PEM.privateKey },
    { cursor: null }
  );

  const txCalls = requests.filter((entry) => /\/transactions$/.test(entry.path));
  assert.ok(txCalls.length >= 2);
  // next_uri carries a query string but the JWT signs the bare path, so the
  // cursor is extracted and re-sent as a parameter rather than followed.
  assert.equal(txCalls[1].params.starting_after, 'page1-b');
  assert.equal(result.records.some((record) => record.external_id === 'cb:page2-a'), true);
});

test('coinbase: a backfill longer than the page budget resumes instead of restarting', async () => {
  // Every page full and every page pointing at another: the budget runs out
  // long before the history does.
  const template = COINBASE.transactions.data[2];
  const pageAt = (index) => ({
    _after: index === 0 ? undefined : `cb-tx-${index * 100 - 1}`,
    data: Array.from({ length: 100 }, (_, i) => ({ ...template, id: `cb-tx-${index * 100 + i}` })),
    pagination: { next_uri: `/v2/accounts/x/transactions?starting_after=cb-tx-${index * 100 + 99}` },
  });
  coinbaseTransactionPages = Array.from({ length: 60 }, (_, index) => pageAt(index));

  const first = await coinbaseConnector.sync(
    { apiKey: 'organizations/o/apiKeys/k', apiSecret: EC_KEY_PEM.privateKey },
    { cursor: null, interactive: true }
  );

  assert.equal(first.stats.backfillPending, true);
  // The resume point is per v2 account. Without it the next run would walk the
  // same first pages again, re-import rows it already has, and never once
  // reach the old ones -- a backfill that can never converge.
  const resumeIds = Object.values(first.cursor.pending);
  assert.ok(resumeIds.length > 0, 'an unfinished account must carry where it stopped');
  assert.match(resumeIds[0], /^cb-tx-\d+$/);
  // ...and the watermark is NOT stamped as complete.
  assert.equal(first.cursor.since, null);
});

test('coinbase: balances count held funds, not just the available slice', async () => {
  const result = await coinbaseConnector.sync(
    { apiKey: 'organizations/o/apiKeys/k', apiSecret: EC_KEY_PEM.privateKey },
    { cursor: null }
  );
  // available 0.05 + hold 0.01. Comparing the ledger against `available` alone
  // would flag every account with an open order.
  assert.equal(result.balances.BTC, '0.06');
  assert.equal(result.balances.USD, '250');
});

// --- Reconciliation --------------------------------------------------------

test('reconciliation ignores rounding dust but reports a real gap', () => {
  const clean = ExchangeSyncService.reconcile(
    { BTC: '0.03490000001', USD: '997.25' },
    { BTC: '0.0349', USD: '997.25' }
  );
  assert.equal(clean.mismatch_count, 0, 'an exchange rounds its published balance; the ledger does not');

  const broken = ExchangeSyncService.reconcile({ BTC: '0.0349', ETH: '0.2' }, { BTC: '0.5', ETH: '0.2' });
  assert.equal(broken.mismatch_count, 1);
  assert.equal(broken.mismatches[0].asset, 'BTC');
  assert.equal(broken.mismatches[0].difference, '-0.4651');
  // Reported, never corrected: the derived figure is the thing under test, so
  // overwriting it with the live one hides the bug this check exists to find.
  assert.equal(broken.mismatches[0].derived, '0.0349');
  assert.equal(broken.mismatches[0].live, '0.5');
});

test('an asset the ledger has never seen is a mismatch, not an absence', () => {
  const report = ExchangeSyncService.reconcile({}, { SOL: '12.5' });
  assert.equal(report.mismatch_count, 1);
  assert.equal(report.mismatches[0].derived, '0');
});

// --- Routes: credentials ---------------------------------------------------

test('PUT credentials stores a key and answers with a masked status only', async () => {
  const response = await request(app)
    .put(`/api/exchanges/${OWNED_ACCOUNT_ID}/credentials`)
    .send({ api_key: 'KRAKEN-PUBLIC-KEY-WXYZ', api_secret: 'c2VjcmV0LXByaXZhdGUta2V5LTEyMzQ=' });

  assert.equal(response.status, 200);
  assert.equal(response.body.credentials.configured, true);
  assert.equal(response.body.credentials.key_masked, '••••WXYZ');
  assert.equal(response.body.credentials.secret_masked, '••••MzQ=');

  // Nothing that could be a key may appear anywhere in the payload.
  const serialized = JSON.stringify(response.body);
  assert.equal(serialized.includes('KRAKEN-PUBLIC-KEY-WXYZ'), false);
  assert.equal(serialized.includes('c2VjcmV0LXByaXZhdGUta2V5LTEyMzQ='), false);
  assert.equal(/api_key_encrypted|api_secret_encrypted/.test(serialized), false);

  // ...and what reached the database is ciphertext in the secretCrypto format.
  const write = queries.find((entry) => /^UPDATE exchange_accounts SET api_key_encrypted/.test(entry.sql));
  assert.match(write.params[2], /^v1:/);
  assert.equal(write.params[2].includes('KRAKEN-PUBLIC-KEY-WXYZ'), false);
});

test('the account list never selects, let alone returns, the encrypted columns', async () => {
  connectAccount({ apiKey: 'KRAKEN-PUBLIC-KEY-WXYZ' });
  const response = await request(app).get('/api/exchanges');

  assert.equal(response.status, 200);
  const account = response.body.accounts[0];
  assert.equal(account.credentials.configured, true);
  assert.equal(account.credentials.key_masked, '••••WXYZ');
  assert.equal(Object.prototype.hasOwnProperty.call(account, 'api_key_encrypted'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(account, 'sync_cursor'), false);

  // The projection is the real guard: since migration 040 put ciphertext on
  // this table, a SELECT * here would leak it into the response body.
  const listQuery = queries.find((entry) => /FROM exchange_accounts ea/.test(entry.sql));
  assert.equal(/ea\.api_key_encrypted,/.test(listQuery.sql), false);
  assert.match(listQuery.sql, /api_key_encrypted IS NOT NULL AS api_configured/);
});

test('key writes degrade to a 503 without SECRETS_ENCRYPTION_KEY, storing nothing', async () => {
  delete process.env.SECRETS_ENCRYPTION_KEY;

  const write = await request(app)
    .put(`/api/exchanges/${OWNED_ACCOUNT_ID}/credentials`)
    .send({ api_key: 'k', api_secret: 's' });

  assert.equal(write.status, 503);
  assert.match(write.body.error, /SECRETS_ENCRYPTION_KEY/);
  // A plaintext fallback "just this once" is how a secret ends up in a backup.
  assert.equal(queries.some((entry) => /^UPDATE exchange_accounts SET api_key_encrypted/.test(entry.sql)), false);

  const list = await request(app).get('/api/exchanges');
  assert.equal(list.body.encryption_configured, false);
});

test('a stored key can still be revoked when the encryption key is gone', async () => {
  connectAccount();
  // The rotated-or-lost-key case is exactly the one that most needs revoking,
  // and gating the clear path on SECRETS_ENCRYPTION_KEY made the credential
  // unusable AND unremovable. Clearing decrypts nothing: it NULLs ciphertext.
  delete process.env.SECRETS_ENCRYPTION_KEY;

  const clear = await request(app).delete(`/api/exchanges/${OWNED_ACCOUNT_ID}/credentials`);

  assert.equal(clear.status, 200);
  assert.equal(clear.body.credentials.configured, false);
  const wipe = queries.find((entry) => /^UPDATE exchange_accounts SET api_key_encrypted = NULL/.test(entry.sql));
  assert.ok(wipe, 'the ciphertext columns are actually NULLed');
});

test('disconnect waits for an active sync instead of revoking its live key', async () => {
  connectAccount();
  accountSyncLockActive = true;

  const clear = await request(app).delete(`/api/exchanges/${OWNED_ACCOUNT_ID}/credentials`);

  assert.equal(clear.status, 409);
  assert.equal(clear.body.code, 'EXCHANGE_SYNC_IN_PROGRESS');
  assert.equal(queries.some((entry) => /^UPDATE exchange_accounts SET api_key_encrypted = NULL/.test(entry.sql)), false);
});

test('a sync with no encryption key is a 503 about the server, not a 409 about the account', async () => {
  connectAccount();
  delete process.env.SECRETS_ENCRYPTION_KEY;

  const response = await request(app).post(`/api/exchanges/${OWNED_ACCOUNT_ID}/sync`);

  // The stored credential is fine; the server just cannot read it. Blaming the
  // account would send the user to re-enter a key that is already correct.
  assert.equal(response.status, 503);
  assert.match(response.body.error, /SECRETS_ENCRYPTION_KEY/);
});

test('credential and sync routes 404 for an account that is not the caller\'s', async () => {
  asUser(2);
  for (const [method, url] of [
    ['put', `/api/exchanges/${OWNED_ACCOUNT_ID}/credentials`],
    ['delete', `/api/exchanges/${OWNED_ACCOUNT_ID}/credentials`],
    ['post', `/api/exchanges/${OWNED_ACCOUNT_ID}/test`],
    ['post', `/api/exchanges/${OWNED_ACCOUNT_ID}/sync`],
  ]) {
    const response = await request(app)[method](url).send({ api_key: 'k', api_secret: 's' });
    assert.equal(response.status, 404, `${method} ${url}`);
  }
});

test('PUT credentials rejects a half credential', async () => {
  const response = await request(app)
    .put(`/api/exchanges/${OWNED_ACCOUNT_ID}/credentials`)
    .send({ api_key: 'only-the-key' });

  // Half a credential fails every request with a signature error rather than
  // being skipped as unconfigured, so it is refused at the door.
  assert.equal(response.status, 400);
  assert.match(response.body.error, /api_secret is required/);
});

// --- Routes: test connection and sync --------------------------------------

test('POST /test proves the key with one read and writes nothing', async () => {
  connectAccount();
  const response = await request(app).post(`/api/exchanges/${OWNED_ACCOUNT_ID}/test`);

  assert.equal(response.status, 200);
  assert.equal(response.body.ok, true);
  assert.deepEqual(requests.map((entry) => entry.endpoint), ['Balance']);
  assert.equal(stored.size, 0, 'a connection test must not import anything');
});

test('a connection test refuses an account already owned by a sync', async () => {
  connectAccount();
  accountSyncLockActive = true;

  const response = await request(app).post(`/api/exchanges/${OWNED_ACCOUNT_ID}/test`);

  assert.equal(response.status, 409);
  assert.equal(response.body.code, 'EXCHANGE_SYNC_IN_PROGRESS');
  assert.deepEqual(requests, []);
});

test('a rejected key comes back as the provider\'s own message, not a 500', async () => {
  connectAccount();
  failNextKrakenWith = 'EGeneral:Permission denied';

  const response = await request(app).post(`/api/exchanges/${OWNED_ACCOUNT_ID}/test`);

  // The provider's refusal is the only thing that says which permission was
  // forgotten, so it survives to the client verbatim.
  assert.equal(response.status, 400);
  assert.equal(response.body.code, 'KRAKEN_AUTH_FAILED');
  assert.match(response.body.error, /Permission denied/);
});

test('syncing an account with no key stored is a 409 that says so', async () => {
  const response = await request(app).post(`/api/exchanges/${OWNED_ACCOUNT_ID}/sync`);

  assert.equal(response.status, 409);
  assert.equal(response.body.code, 'EXCHANGE_NOT_CONFIGURED');
});

test('an unsupported venue is told to use CSV rather than offered a broken sync', async () => {
  accountOverrides = { exchange: 'other' };
  const response = await request(app).post(`/api/exchanges/${OWNED_ACCOUNT_ID}/sync`);

  assert.equal(response.status, 400);
  assert.equal(response.body.code, 'EXCHANGE_NOT_SUPPORTED');
  assert.match(response.body.error, /CSV import/);
});

// --- The dedupe contract ---------------------------------------------------

test('a CSV upload after an API backfill of the same period adds nothing', async () => {
  connectAccount();

  const synced = await request(app).post(`/api/exchanges/${OWNED_ACCOUNT_ID}/sync`);
  assert.equal(synced.status, 200);
  assert.equal(synced.body.imported, 11, 'thirteen ledger rows, eleven economic events');
  assert.equal(stored.size, 11);

  // The same events, now as the CSV export. Both readers normalize into one
  // shape and share krakenLedger.buildRecords, so every external_id matches --
  // which is the only reason this is a no-op rather than a doubled history.
  const uploaded = await request(app)
    .post(`/api/exchanges/${OWNED_ACCOUNT_ID}/import`)
    .set('Content-Type', 'text/csv')
    .send(readFixture('kraken-ledgers.csv'));

  assert.equal(uploaded.status, 200);
  assert.equal(uploaded.body.imported, 0);
  assert.equal(uploaded.body.upgraded, 0, 'nothing was half-known, so nothing is upgraded');
  assert.equal(uploaded.body.duplicates, 11);
  assert.equal(stored.size, 11, 'no second copy of a single event');
});

test('every CSV import recomputes reconciliation, including a no-new-row import', async () => {
  connectAccount();
  accountOverrides.provider_balance_snapshot = {
    provider: 'kraken',
    observed_at: new Date().toISOString(),
    complete: true,
    balances: { BTC: '0' },
  };
  derivedBalances = { BTC: '1' };

  const first = await request(app)
    .post(`/api/exchanges/${OWNED_ACCOUNT_ID}/import`)
    .set('Content-Type', 'text/csv')
    .send(readFixture('kraken-ledgers.csv'));
  assert.equal(first.status, 200);
  assert.equal(first.body.reconciliation_status, 'mismatch');

  const second = await request(app)
    .post(`/api/exchanges/${OWNED_ACCOUNT_ID}/import`)
    .set('Content-Type', 'text/csv')
    .send(readFixture('kraken-ledgers.csv'));
  assert.equal(second.status, 200);
  assert.equal(second.body.imported, 0);
  assert.equal(second.body.reconciliation_status, 'mismatch');
  assert.equal(stored.size, 11);
});

test('a CSV-first import still gains the addresses only the API can see', async () => {
  connectAccount();

  const uploaded = await request(app)
    .post(`/api/exchanges/${OWNED_ACCOUNT_ID}/import`)
    .set('Content-Type', 'text/csv')
    .send(readFixture('kraken-ledgers.csv'));
  assert.equal(uploaded.body.imported, 11);
  // The Kraken ledgers export carries no txid and no destination at all.
  assert.equal(chainDetails.size, 0);

  const synced = await request(app).post(`/api/exchanges/${OWNED_ACCOUNT_ID}/sync`);

  assert.equal(synced.body.imported, 0, 'the events were already known');
  assert.equal(synced.body.duplicates, 11);
  // The ON CONFLICT upgrade is deliberately one-directional -- it only fires
  // on a review-flagged row -- so it cannot fill this hole. Without the
  // additive backfill, connecting a key after a CSV upload would leave the
  // whole back history with no addresses, and forgotten-wallet discovery
  // reads exactly that column.
  assert.ok(synced.body.chain_details_filled >= 2);
  const withdrawal = chainDetails.get(`${OWNED_ACCOUNT_ID}|kraken:LKKKKK-11111-KKKKKK`);
  assert.equal(withdrawal.address, 'bc1qsynthetic0000000000000000000000000test');
  assert.equal(withdrawal.network, 'Bitcoin');
});

test('a failed sync leaves the resume point exactly where it was', async () => {
  connectAccount();
  failNextKrakenWith = 'EService:Unavailable';

  const response = await request(app).post(`/api/exchanges/${OWNED_ACCOUNT_ID}/sync`);
  assert.equal(response.status, 502);

  const save = queries.find((entry) => /^UPDATE exchange_accounts SET sync_cursor/.test(entry.sql));
  // COALESCE($2, sync_cursor) with a null cursor keeps the stored one. An
  // advanced cursor after a failure starts the next run past rows nobody read.
  assert.equal(save.params[1], null);
  assert.equal(save.params[2], 'error');
});

test('a balance mismatch flags the account instead of being silently trusted', async () => {
  connectAccount();
  // The ledger says one thing, the exchange another: records were missed or
  // misparsed, which is exactly what this check exists to catch.
  derivedBalances = { BTC: '0.0000000000', ETH: '0.2000000000', USD: '997.2500' };

  const response = await request(app).post(`/api/exchanges/${OWNED_ACCOUNT_ID}/sync`);

  assert.equal(response.status, 200);
  assert.equal(response.body.status, 'balance_mismatch');
  assert.equal(response.body.balance_report.mismatch_count, 1);
  assert.equal(response.body.balance_report.mismatches[0].asset, 'BTC');
});

test('an unfinished backfill is not reported as a balance mismatch', async () => {
  connectAccount();
  derivedBalances = {};
  const template = Object.values(KRAKEN_LEDGERS.result.ledger)[0];
  krakenLedgerPages = Array.from({ length: 40 }, (_, page) => ({
    ledger: Object.fromEntries(Array.from({ length: 50 }, (_, i) => {
      const n = page * 50 + i;
      return [`LBULK${String(n).padStart(4, '0')}-0-P`, { ...template, refid: `RBULK-${n}`, time: 1709283600 + n }];
    })),
    count: 2000,
  }));

  const response = await request(app).post(`/api/exchanges/${OWNED_ACCOUNT_ID}/sync`);

  assert.equal(response.body.backfill_pending, true);
  // A partial history disagreeing with the live balance says nothing about the
  // parser. Calling it a mismatch here trains the user to ignore the flag
  // before it ever means anything.
  assert.equal(response.body.status, 'ok');
});

// --- The job ---------------------------------------------------------------

test('the job skips an account whose stored key cannot be decrypted', async () => {
  connectAccount();
  // The encryption key was rotated: the row is still there and can be
  // replaced, which is different from there being no key at all.
  accountOverrides.api_key_encrypted = 'v1:AAAA:BBBB:CCCC';

  const summary = await ExchangeSyncService.syncAllAccounts();

  assert.equal(summary.processed, 1);
  assert.equal(summary.skipped, 1);
  assert.equal(summary.failed, 0, 'one user\'s rotated key must not fail another user\'s sync');
  assert.equal(summary.results[0].skipped, 'EXCHANGE_CREDENTIAL_UNREADABLE');
});

test('the job reports nothing to do rather than failing when no account is connected', async () => {
  const ExchangeSyncJob = require('../src/jobs/exchangeSyncJob');
  const result = await ExchangeSyncJob.run();

  assert.equal(result.skipped, true);
  assert.equal(result.reason, 'no_accounts');
});

// --- Shared builder --------------------------------------------------------

test('both readers key the same event the same way', () => {
  // The dedupe contract in one assertion: a row normalized from the API and
  // the same row normalized from the CSV must produce one id, not two.
  const row = {
    line: 1,
    txid: 'LZZZZZ-99999-ZZZZZZ',
    refid: 'TTRD11-22222-TTTTTT',
    occurredAt: '2024-03-02T10:00:00.000Z',
    type: 'deposit',
    subtype: '',
    asset: 'ETH',
    amountCell: '1.0',
    amount: '1.0',
    fee: '0',
    raw: {},
  };
  assert.equal(buildRecords([row]).records[0].external_id, 'kraken:LZZZZZ-99999-ZZZZZZ');

  // A paired-type row alone under its refid keys the REFID, so the complete
  // pair lands on it rather than beside it.
  const widowed = { ...row, type: 'trade' };
  assert.equal(buildRecords([widowed]).records[0].external_id, 'kraken:TTRD11-22222-TTTTTT');
});

// --- The dedupe contract: Coinbase -----------------------------------------

test('a Coinbase CSV upload after an API backfill of the same period adds nothing', async () => {
  connectAccount({
    exchange: 'coinbase',
    apiKey: 'organizations/o/apiKeys/k',
    apiSecret: EC_KEY_PEM.privateKey,
  });

  const synced = await request(app).post(`/api/exchanges/${COINBASE_ACCOUNT_ID}/sync`);
  assert.equal(synced.status, 200);
  assert.equal(synced.body.imported, 5, 'six v2 transactions, five economic events');
  assert.equal(stored.size, 5);

  // The same events, now as the retail CSV export. Both readers key every row
  // on `cb:<v2 transaction id>` -- including a Convert, which keys the OUTGOING
  // leg's id because the CSV export has no trade-id column to key instead.
  // Keying the API side on the trade id made this upload double every Convert
  // under an id no ON CONFLICT could ever see.
  const uploaded = await request(app)
    .post(`/api/exchanges/${COINBASE_ACCOUNT_ID}/import`)
    .set('Content-Type', 'text/csv')
    .send(readFixture('coinbase-retail-api-parity.csv'));

  assert.equal(uploaded.status, 200);
  assert.equal(uploaded.body.imported, 0);
  assert.equal(uploaded.body.duplicates, 5);
  assert.equal(stored.size, 5, 'no second copy of a single event');
});

test('both readers key a Coinbase Convert the same way', () => {
  const { foldConversions, recordFromConversion } = coinbaseConnector._internals;

  const from = {
    id: 'cvt-out', type: 'trade', created_at: '2024-03-07T15:00:00Z',
    amount: { amount: '-100.00', currency: 'USD' }, trade: { id: 'trade-77' },
  };
  const to = {
    id: 'cvt-in', type: 'trade', created_at: '2024-03-07T15:00:00Z',
    amount: { amount: '0.00160000', currency: 'BTC' }, trade: { id: 'trade-77' },
  };
  const api = recordFromConversion(foldConversions([from, to]).pairs[0], { line: 1 });

  const csv = parseExchangeCsv([
    'ID,Timestamp,Transaction Type,Asset,Quantity Transacted,Price Currency,Subtotal,'
      + 'Total (inclusive of fees and/or spread),Fees and/or Spread,Notes,Sender Address,Recipient Address',
    'cvt-out,2024-03-07 15:00:00 UTC,Convert,USD,-100,USD,$100.00,$100.00,$0.00,Converted 100 USD to 0.0016 BTC,,',
    'cvt-in,2024-03-07 15:00:01 UTC,Convert,BTC,0.0016,USD,$100.00,$100.00,$0.00,Converted 100 USD to 0.0016 BTC,,',
  ].join('\n'));

  assert.equal(csv.records.length, 1, 'two ledger lines, one economic event');
  // The whole dedupe contract for a Convert in one assertion. The trade id
  // groups the legs; it cannot key the row, because the CSV reader has no way
  // to compute it.
  assert.equal(api.external_id, csv.records[0].external_id);
  assert.equal(api.external_id, 'cb:cvt-out');
});

// --- Convergence -----------------------------------------------------------

test('coinbase: more wallets than the page budget still converges', async () => {
  // The reviewer's shape. `pending` records where the UNFINISHED accounts
  // stopped but never which ones finished, and the loop restarts at the first
  // account every run -- so with more wallets than budget every pass re-walked
  // the same completed accounts, reached nobody new, and left backfillPending
  // stuck true (which suppresses balance reconciliation permanently).
  const template = COINBASE.v2Accounts.data[0];
  coinbaseAccountPages = [{
    data: Array.from({ length: 120 }, (_, i) => ({ ...template, id: `wallet-${i}` })),
    pagination: { next_uri: null },
  }];

  const walked = [];
  let cursor = null;
  let runs = 0;
  let pending = true;
  for (; runs < 12 && pending; runs += 1) {
    // eslint-disable-next-line no-await-in-loop
    const result = await coinbaseConnector.sync(
      { apiKey: 'organizations/o/apiKeys/k', apiSecret: EC_KEY_PEM.privateKey },
      { cursor, interactive: true }
    );
    requests
      .filter((entry) => /^\/v2\/accounts\/wallet-\d+\/transactions$/.test(entry.path ?? ''))
      .forEach((entry) => walked.push(entry.path));
    requests.length = 0;
    cursor = result.cursor;
    pending = result.stats.backfillPending;
  }

  assert.equal(pending, false, `the backfill has to converge; it took ${runs} runs`);
  assert.equal(new Set(walked).size, 120, 'every wallet is walked');
  // ...and none of them twice: re-walking a finished account is exactly what
  // burned the whole budget and stalled the backfill.
  assert.equal(walked.length, 120, 'no wallet is walked twice within one generation');
  assert.ok(cursor.since, 'the watermark advances once every wallet has been read');
  assert.deepEqual(cursor.pending, {});
  assert.deepEqual(cursor.done, []);
});

test('kraken: a budget boundary inside the TOP second resumes by offset, not by a clamp', async () => {
  // ceil(oldest) lands on `end` itself, so shrinking the window cannot make
  // progress. The old code clamped the resume point to end-1, which made
  // progress by silently stranding every remaining row in that second.
  const template = Object.values(KRAKEN_LEDGERS.result.ledger)[0];
  const end = 1710093600;
  krakenLedgerHistory = Array.from({ length: 1300 }, (_, i) => ({
    ...template,
    ledgerId: `LSEC${String(i).padStart(4, '0')}-0-S`,
    refid: `RSEC-${i}`,
    type: 'deposit',
    // All inside (end-1, end], so every row's ceil() is `end`.
    time: end - (i / 2000),
  }));

  const seen = new Set();
  // A pinned window, so the degenerate second is reached deterministically
  // rather than depending on which second the test happens to run in.
  let cursor = { newestTime: 0, pendingStart: 0, pendingEnd: end };
  const first = await krakenConnector.sync(
    { apiKey: 'k', apiSecret: Buffer.alloc(32, 1).toString('base64') },
    { cursor, interactive: true }
  );
  first.records.forEach((record) => seen.add(record.external_id));

  assert.equal(first.stats.backfillPending, true);
  assert.equal(first.cursor.pendingEnd, end, 'the window is kept, not clamped past the remaining rows');
  assert.equal(first.cursor.pendingOffset, 1250, 'progress is carried as an offset into the same window');

  cursor = first.cursor;
  const second = await krakenConnector.sync(
    { apiKey: 'k', apiSecret: Buffer.alloc(32, 1).toString('base64') },
    { cursor, interactive: true }
  );
  second.records.forEach((record) => seen.add(record.external_id));

  assert.equal(second.stats.backfillPending, false);
  assert.equal(seen.size, 1300, 'not one row inside the degenerate second is stranded');
});

test('kraken: the funding status endpoints are paged, not read once and truncated', async () => {
  // 500 rows with no cursor loop truncates a first backfill spanning years, and
  // the 1h steady-state windows never re-request what was missed -- silently,
  // because the ledger rows themselves import fine and only the addresses are
  // gone.
  krakenFundingPages = {
    WithdrawStatus: [
      { _cursor: undefined, withdrawal: [], next_cursor: 'w-page-2' },
      {
        _cursor: 'w-page-2',
        withdrawal: KRAKEN_FUNDING.WithdrawStatus.result,
        next_cursor: null,
      },
    ],
  };

  const result = await krakenConnector.sync(
    { apiKey: 'k', apiSecret: Buffer.alloc(32, 1).toString('base64') },
    { cursor: null }
  );

  const calls = requests.filter((entry) => entry.endpoint === 'WithdrawStatus');
  assert.equal(calls.length, 2);
  assert.equal(calls[0].params.get('cursor'), 'true', 'the first call asks for the paginated form');
  assert.equal(calls[1].params.get('cursor'), 'w-page-2');
  // The address only exists on the SECOND page, so it proves the loop ran.
  const withdrawal = result.records.find((record) => record.external_id === 'kraken:LKKKKK-11111-KKKKKK');
  assert.equal(withdrawal.address, 'bc1qsynthetic0000000000000000000000000test');
});

// --- Credentials never reach a log -----------------------------------------

test('a kraken transport failure carries no key material', async () => {
  failTransport = true;
  const client = new KrakenClient({
    apiKey: 'KRAKEN-KEY-1234',
    apiSecret: Buffer.alloc(64, 3).toString('base64'),
  });

  await assert.rejects(() => client.getBalance(), (err) => {
    // pino's default `err` serializer copies own enumerable properties, and an
    // AxiosError keeps the signed request on config.headers -- API-Key and
    // API-Sign, in the clear, one logger.error away from the log stream.
    const dump = JSON.stringify({ message: err.message, ...err });
    assert.equal(dump.includes('KRAKEN-KEY-1234'), false);
    assert.equal(/API-Key|API-Sign/i.test(dump), false);
    assert.equal(err.config, undefined);
    assert.equal(err.request, undefined);
    // ...and what a human debugging actually needs survives.
    assert.equal(err.code, 'ECONNRESET');
    assert.equal(err.request_summary.url, 'https://api.kraken.com/0/private/Balance');
    return true;
  });
});

test('a coinbase transport failure carries no bearer token', async () => {
  failTransport = true;
  const client = new CoinbaseClient({
    apiKey: 'organizations/o/apiKeys/k',
    apiSecret: EC_KEY_PEM.privateKey,
  });

  await assert.rejects(() => client.get('/v2/accounts', { limit: 1 }), (err) => {
    const dump = JSON.stringify({ message: err.message, ...err });
    assert.equal(/Authorization|Bearer/i.test(dump), false);
    assert.equal(err.config, undefined);
    assert.equal(err.request, undefined);
    assert.equal(err.request_summary.url, 'https://api.coinbase.com/v2/accounts');
    return true;
  });
});

// --- Fees, balances and statuses -------------------------------------------

test('coinbase: a commission with no native_amount takes its currency from the fill', async () => {
  const { recordFromTransaction } = coinbaseConnector._internals;
  const fillsByOrder = new Map([['order-1', {
    baseAsset: 'BTC', quoteAsset: 'USD', commission: '2.00', quoteAmount: null,
  }]]);

  // No native_amount, so the quote currency is unknown from the v2 row alone.
  // The commission is "always represented in quote currency" and the fill knows
  // which that is, so it backfills the fee asset. Left null, the fee vanishes
  // from derivedBalances (fee_asset IS NOT NULL) and shows up as a
  // balance_mismatch that no re-sync can clear.
  const rescued = recordFromTransaction({
    id: 'fee-1',
    type: 'advanced_trade_fill',
    created_at: '2024-03-02T10:00:00Z',
    amount: { amount: '0.00500000', currency: 'BTC' },
    advanced_trade_fill: { order_id: 'order-1', commission: '2.00' },
  }, { line: 1, fillsByOrder });

  assert.equal(rescued.fee_amount, '2.00');
  assert.equal(rescued.fee_asset, 'USD');
  assert.equal(rescued.needs_review, false);

  // Nothing anywhere names the currency: the fee is kept, because it was really
  // charged, and the row is flagged rather than stored in a shape
  // reconciliation would silently ignore.
  const unattributed = recordFromTransaction({
    id: 'fee-2',
    type: 'advanced_trade_fill',
    created_at: '2024-03-02T10:00:00Z',
    amount: { amount: '0.00500000', currency: 'BTC' },
    advanced_trade_fill: { order_id: 'order-unknown', commission: '2.00' },
  }, { line: 2, fillsByOrder });

  assert.equal(unattributed.fee_amount, '2.00');
  assert.equal(unattributed.fee_asset, null);
  assert.equal(unattributed.needs_review, true);
});

test('coinbase: an incomplete live balance picture skips reconciliation instead of flagging', async () => {
  connectAccount({
    exchange: 'coinbase',
    apiKey: 'organizations/o/apiKeys/k',
    apiSecret: EC_KEY_PEM.privateKey,
  });
  // More brokerage portfolios than the account-list page budget: the balances
  // that came back are a fraction of the truth, and every portfolio missing
  // from them reads as a zero the ledger contradicts.
  coinbaseBrokeragePages = Array.from({ length: 30 }, (_, page) => ({
    _cursor: page === 0 ? undefined : `bk-${page - 1}`,
    accounts: COINBASE.brokerageAccounts.accounts,
    has_next: true,
    cursor: `bk-${page}`,
  }));
  derivedBalances = { BTC: '999.0' };

  const response = await request(app).post(`/api/exchanges/${COINBASE_ACCOUNT_ID}/sync`);

  assert.equal(response.status, 200);
  assert.equal(response.body.status, 'coverage_limited', 'half a balance picture must surface a coverage warning');
  assert.equal(response.body.balance_report.skipped, 'live_balances_incomplete');
  assert.equal(response.body.balance_report.mismatch_count, 0);
  assert.equal(response.body.coverage_limitations.length, 1);
});

test('coinbase: a missing v3 balance cursor fails closed as incomplete', async () => {
  coinbaseBrokeragePages = [{
    _cursor: undefined,
    accounts: COINBASE.brokerageAccounts.accounts,
    has_next: true,
    cursor: '',
  }];

  const result = await coinbaseConnector.sync(
    { apiKey: 'organizations/o/apiKeys/k', apiSecret: EC_KEY_PEM.privateKey },
    { cursor: null, interactive: true }
  );

  assert.equal(result.balancesComplete, false);
});

test('a server without an encryption key writes no per-account sync status', async () => {
  connectAccount();
  delete process.env.SECRETS_ENCRYPTION_KEY;

  const response = await request(app).post(`/api/exchanges/${OWNED_ACCOUNT_ID}/sync`);
  assert.equal(response.status, 503);

  // 'not_configured' against THIS account records a server misconfiguration as
  // a fact about a credential that is stored and fine -- and it outlives the
  // fix, because nothing rewrites it until the next successful sync.
  const save = queries.find((entry) => /^UPDATE exchange_accounts SET sync_cursor/.test(entry.sql));
  assert.equal(save, undefined);
});

test('a second sync of the same account while one is running is refused, not doubled', async () => {
  connectAccount();
  // Genuine overlap: without latency the first pass finishes before the second
  // is dispatched and the test would prove nothing.
  transportDelayMs = 25;

  const [first, second] = await Promise.all([
    request(app).post(`/api/exchanges/${OWNED_ACCOUNT_ID}/sync`),
    request(app).post(`/api/exchanges/${OWNED_ACCOUNT_ID}/sync`),
  ]);

  // Two passes on one cursor both read from the same resume point, fetch the
  // same pages, and whichever finishes last overwrites the other's cursor.
  const statuses = [first.status, second.status].sort();
  assert.deepEqual(statuses, [200, 409]);
  const refused = first.status === 409 ? first : second;
  assert.equal(refused.body.code, 'EXCHANGE_SYNC_IN_PROGRESS');
  assert.equal(stored.size, 11, 'the refused pass imported nothing of its own');
});

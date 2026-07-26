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

const OWNED_ACCOUNT_ID = 7;
const OWNER_ID = 1;
const COINBASE_ACCOUNT_ID = 8;

// --- fake pg ---------------------------------------------------------------
//
// Stands in for UNIQUE (exchange_account_id, external_id): keyed by the same
// pair, valued by the row's needs_review, so the guarded upgrade behaves the
// way Postgres would.
const stored = new Map();
const chainDetails = new Map();
let derivedBalances = {};
let accountOverrides = {};
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

const PARAMS_PER_ROW = 15;
const EXTERNAL_ID_OFFSET = 11;
const NEEDS_REVIEW_OFFSET = 12;

function resolveAccount(id, userId) {
  if (userId !== OWNER_ID) return [];
  if (id === OWNED_ACCOUNT_ID) return [accountRow()];
  if (id === COINBASE_ACCOUNT_ID) return [accountRow({ id: COINBASE_ACCOUNT_ID, name: 'Coinbase', exchange: 'coinbase' })];
  return [];
}

function fakeQuery(text, params) {
  const sql = String(text).replace(/\s+/g, ' ').trim();
  queries.push({ sql, params });

  // Ordered most specific first: the credential-bearing read is the only
  // SELECT * left on this table, and derivedBalances also mentions
  // exchange_accounts, so a loose match would swallow it.
  if (/GROUP BY asset/.test(sql)) {
    return { rows: Object.entries(derivedBalances).map(([asset, derived]) => ({ asset, derived })) };
  }
  if (/^UPDATE exchange_records er SET tx_hash = COALESCE/.test(sql)) {
    let filled = 0;
    for (let i = 1; i < params.length; i += 3) {
      const key = `${params[0]}|${params[i]}`;
      if (!stored.has(key)) continue;
      const existing = chainDetails.get(key) || {};
      const next = { tx_hash: existing.tx_hash ?? params[i + 1], address: existing.address ?? params[i + 2] };
      if (next.tx_hash !== existing.tx_hash || next.address !== existing.address) {
        chainDetails.set(key, next);
        filled += 1;
      }
    }
    return { rows: [], rowCount: filled };
  }
  if (/^SELECT \* FROM exchange_accounts WHERE id = \$1 AND user_id = \$2/.test(sql)) {
    return { rows: resolveAccount(params[0], params[1]) };
  }
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
        needs_review_count: 0,
      }],
    };
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
  if (/^UPDATE exchange_accounts SET sync_cursor/.test(sql)) {
    return { rows: [accountRow({ last_sync_status: params[2], last_sync_error: params[3] })] };
  }
  if (/^UPDATE exchange_accounts/.test(sql)) {
    return { rows: resolveAccount(params[0], params[1]) };
  }
  if (/^INSERT INTO exchange_records/.test(sql)) {
    const rows = [];
    for (let i = 0; i < params.length; i += PARAMS_PER_ROW) {
      const key = `${params[i]}|${params[i + EXTERNAL_ID_OFFSET]}`;
      const needsReview = Boolean(params[i + NEEDS_REVIEW_OFFSET]);
      if (!stored.has(key)) {
        stored.set(key, needsReview);
        rows.push({ inserted: true });
      } else if (stored.get(key) && !needsReview) {
        stored.set(key, needsReview);
        rows.push({ inserted: false });
      }
    }
    return { rows, rowCount: rows.length };
  }
  if (/FROM exchange_records er/.test(sql)) {
    if (/COUNT\(\*\)/.test(sql)) return { rows: [{ total: 0 }] };
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
];

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
let coinbaseTransactionPages = null;
let failNextKrakenWith = null;

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
  if (endpoint === 'WithdrawStatus') return { status: 200, data: KRAKEN_FUNDING.WithdrawStatus };
  if (endpoint === 'DepositStatus') return { status: 200, data: KRAKEN_FUNDING.DepositStatus };
  if (endpoint === 'Ledgers') {
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

  if (path === '/api/v3/brokerage/accounts') return { status: 200, data: COINBASE.brokerageAccounts };
  if (path === '/api/v3/brokerage/orders/historical/fills') return { status: 200, data: COINBASE.fills };
  if (path === '/v2/accounts') return { status: 200, data: COINBASE.v2Accounts };
  if (/^\/v2\/accounts\/[^/]+\/transactions$/.test(path)) {
    if (coinbaseTransactionPages) {
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
        requests[requests.length] = undefined;
        requests.pop();
        const response = krakenResponse(url, body);
        requests[requests.length - 1].headers = config?.headers ?? {};
        return response;
      }
      throw new Error(`unexpected POST ${url}`);
    },
    async get(url, config) {
      if (url.startsWith('https://api.coinbase.com')) return coinbaseResponse(url, config);
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
const { buildRecords } = require('../src/services/exchangeImport/krakenLedger');

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
  accountOverrides = {};
  krakenLedgerPages = null;
  coinbaseTransactionPages = null;
  failNextKrakenWith = null;
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
  assert.equal(payload.nbf, 1700000000);
  assert.equal(payload.exp, 1700000000 + 120);
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

  // DepositStatus answers with the WRAPPED shape in the fixture and
  // WithdrawStatus with a bare array; both have to read.
  const deposit = result.records.find((record) => record.external_id === 'kraken:LAAAAA-11111-AAAAAA');
  assert.equal(deposit.record_type, 'deposit');
  // Addresses are stored lowercase so an exchange withdrawal can join to the
  // on-chain transfer it produced.
  assert.equal(deposit.address, '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb');
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
  // Imported separately they read as two unrelated moves.
  const conversion = byId.get('cb:dddddddd-0000-0000-0000-00000000000d');
  assert.equal(conversion.record_type, 'conversion');
  assert.equal(conversion.base_asset, 'USD');
  assert.equal(conversion.base_amount, '-100.00');
  assert.equal(conversion.quote_asset, 'BTC');
  assert.equal(conversion.quote_amount, '0.00160000');
  assert.equal(byId.has('cb:eeeeeeee-0000-0000-0000-00000000000e'), false, 'the incoming leg is not its own record');
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

  const clear = await request(app).delete(`/api/exchanges/${OWNED_ACCOUNT_ID}/credentials`);
  assert.equal(clear.status, 503);

  const list = await request(app).get('/api/exchanges');
  assert.equal(list.body.encryption_configured, false);
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

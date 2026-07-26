'use strict';

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = 'postgresql://test:test@localhost/test';

// --- fake pg ---------------------------------------------------------------

let queryHandler;
const pgModulePath = require.resolve('pg');
require.cache[pgModulePath] = {
  id: pgModulePath,
  filename: pgModulePath,
  loaded: true,
  exports: {
    Pool: class FakePool {
      query(...args) { return queryHandler(...args); }
      connect() { throw new Error('Unexpected connect'); }
      on() {}
    },
    types: { setTypeParser() {} },
  },
};

// --- fake axios ------------------------------------------------------------
//
// Every HTTP call the decode path makes is recorded, which is how the
// cache-once assertions below prove "zero lookups" rather than merely
// "the right answer".

const httpCalls = [];
let httpHandler = () => { throw new Error('Unexpected HTTP call'); };
const axiosModulePath = require.resolve('axios');
const fakeAxios = function fakeAxios() { throw new Error('Unexpected axios() call'); };
fakeAxios.get = async (url, config) => {
  httpCalls.push({ url, params: config && config.params });
  return httpHandler(url, config);
};
require.cache[axiosModulePath] = {
  id: axiosModulePath,
  filename: axiosModulePath,
  loaded: true,
  exports: fakeAxios,
};

const MethodSignatureService = require('../src/services/MethodSignatureService');
const EthTransfer = require('../src/models/EthTransfer');
const EthWalletService = require('../src/services/EthWalletService');

// --- recorded fixtures -----------------------------------------------------
//
// Real responses, captured with curl on 2026-07-25 and never edited:
//   sourcify-*  GET https://api.4byte.sourcify.dev/signature-database/v1/lookup?function=<sel>
//   4byte-*     GET https://www.4byte.directory/api/v1/signatures/?hex_signature=<sel>
// 0x7ff36ab5 (swapExactETHForTokens) is the hit -- it is also a genuine
// collision, so it doubles as the candidate-picking test. 0x1a2b3c4d is a
// selector neither service knows.

const fixture = (name) => require(path.join(__dirname, 'fixtures', name));
const SOURCIFY_HIT = fixture('sourcify-lookup-hit.json');
const SOURCIFY_MISS = fixture('sourcify-lookup-miss.json');
const FOURBYTE_HIT = fixture('4byte-signatures-hit.json');
const FOURBYTE_MISS = fixture('4byte-signatures-miss.json');

const KNOWN = '0x7ff36ab5';
const UNKNOWN = '0x1a2b3c4d';
const SWAP = 'swapExactETHForTokens(uint256,address[],address,uint256)';

const isSourcify = (url) => url.includes('4byte.sourcify.dev');

// --- db harness ------------------------------------------------------------

function fakeDb({ pending = [], cached = [] } = {}) {
  const state = { cached, signatureInserts: [], applied: [], transferInserts: [] };
  queryHandler = async (sql, params) => {
    if (/SELECT method_id/.test(sql)) {
      return { rows: pending.map((selector) => ({ method_id: selector })) };
    }
    // applyMethodNames also names eth_method_signatures (it joins the cache), so
    // match on the SELECT list rather than the table alone.
    if (/SELECT selector, name, source FROM eth_method_signatures/.test(sql)) {
      const wanted = new Set(params[0]);
      return { rows: state.cached.filter((row) => wanted.has(row.selector)) };
    }
    if (/INSERT INTO eth_method_signatures/.test(sql)) {
      state.signatureInserts.push({ selector: params[0], name: params[1], source: params[2] });
      return { rowCount: 1 };
    }
    if (/UPDATE eth_transfers/.test(sql)) {
      state.applied.push({ sql, params });
      return { rowCount: 0 };
    }
    if (/INSERT INTO eth_transfers/.test(sql)) {
      state.transferInserts.push({ sql, params });
      return { rowCount: 1 };
    }
    throw new Error(`Unexpected query: ${sql}`);
  };
  return state;
}

const WALLET = '0xAbCd000000000000000000000000000000000001';
const OTHER = '0x1111111111111111111111111111111111111111';

function normalTx(overrides = {}) {
  return {
    hash: '0xhash1',
    blockNumber: '100',
    timeStamp: '1700000000',
    from: WALLET,
    to: OTHER,
    value: '1000000000000000000',
    gasUsed: '21000',
    gasPrice: '50000000000',
    isError: '0',
    methodId: KNOWN,
    functionName: SWAP,
    ...overrides,
  };
}

beforeEach(() => {
  httpCalls.length = 0;
  httpHandler = () => { throw new Error('Unexpected HTTP call'); };
  queryHandler = async () => { throw new Error('Unexpected query'); };
});

// --- ingest capture --------------------------------------------------------

test('captures methodId and functionName on the native leg only', () => {
  const rows = EthWalletService.normalizeFeeds(WALLET, {
    normal: [normalTx()],
    internal: [{ hash: '0xhash1', blockNumber: '100', timeStamp: '1700000000', from: OTHER, to: WALLET, value: '5', isError: '0' }],
    token: [{ hash: '0xhash1', blockNumber: '100', timeStamp: '1700000000', from: OTHER, to: WALLET, value: '9', contractAddress: OTHER, tokenSymbol: 'TKN', tokenDecimal: '18' }],
  });

  const native = rows.filter((r) => r.transfer_type === 'native');
  assert.equal(native.length, 1);
  assert.equal(native[0].ordinal, 0);
  assert.equal(native[0].method_id, KNOWN);
  assert.equal(native[0].method_name, SWAP);

  // Only the top-level tx has calldata. A gas, internal or token leg claiming a
  // method would double-count one swap as several dapp interactions.
  for (const row of rows.filter((r) => r.transfer_type !== 'native')) {
    assert.equal(row.method_id, null, `${row.transfer_type} leg must not carry a selector`);
    assert.equal(row.method_name, null, `${row.transfer_type} leg must not carry a method name`);
  }
});

test('normalizes Etherscan placeholder selectors and names to NULL', () => {
  // Etherscan spells "no method here" four different ways; all of them must
  // become NULL, or the decode pass would go looking up the string "0x".
  const cases = [
    { methodId: '0x', functionName: '' },
    { methodId: '', functionName: '' },
    { methodId: '0x', functionName: 'deprecated' },
    {},
  ];
  for (const overrides of cases) {
    const rows = EthWalletService.normalizeFeeds(WALLET, { normal: [normalTx({ methodId: undefined, functionName: undefined, ...overrides })] });
    const native = rows.find((r) => r.transfer_type === 'native');
    assert.equal(native.method_id, null, JSON.stringify(overrides));
    assert.equal(native.method_name, null, JSON.stringify(overrides));
  }
});

test('lowercases a mixed-case selector and rejects malformed ones', () => {
  assert.equal(MethodSignatureService.normalizeSelector('0x7FF36AB5'), KNOWN);
  assert.equal(MethodSignatureService.normalizeSelector('0x7ff36ab'), null);
  assert.equal(MethodSignatureService.normalizeSelector('7ff36ab5'), null);
  assert.equal(MethodSignatureService.normalizeSelector(null), null);
});

test('truncates an over-long signature to the column width', () => {
  const long = `${'a'.repeat(400)}(uint256)`;
  assert.equal(MethodSignatureService.normalizeMethodName(long).length, 200);
});

test('bulkInsert persists method_id and method_name', async () => {
  const db = fakeDb();
  const rows = EthWalletService.normalizeFeeds(WALLET, { normal: [normalTx()] })
    .map((row) => ({ ...row, wallet_id: 7 }));

  await EthTransfer.bulkInsert(rows);

  assert.equal(db.transferInserts.length, 1);
  const { sql, params } = db.transferInserts[0];
  assert.match(sql, /is_error, method_id, method_name/);
  assert.ok(params.includes(KNOWN), 'selector must reach the INSERT parameters');
  assert.ok(params.includes(SWAP), 'method name must reach the INSERT parameters');
});

// --- provider parsing (recorded responses) ---------------------------------

test('Sourcify lookup prefers the candidate from a verified contract', async () => {
  httpHandler = async () => ({ data: SOURCIFY_HIT });
  const name = await MethodSignatureService.lookupSourcify(KNOWN);
  // The recorded response carries a real collision: the spam signature
  // join_tg_invmru_haha_9d69f3f shares this selector. hasVerifiedContract is
  // the only thing that tells them apart.
  assert.equal(name, SWAP);
  assert.equal(httpCalls[0].params.function, KNOWN);
});

test('Sourcify lookup returns null for a selector it does not know', async () => {
  httpHandler = async () => ({ data: SOURCIFY_MISS });
  assert.equal(await MethodSignatureService.lookupSourcify(UNKNOWN), null);
});

test('4byte lookup picks the earliest submission of a collided selector', async () => {
  httpHandler = async () => ({ data: FOURBYTE_HIT });
  const name = await MethodSignatureService.lookupFourByte(KNOWN);
  // The recorded response lists the 2022 spam signature FIRST and the 2020 real
  // one second, so taking results[0] would return the wrong name.
  assert.equal(name, SWAP);
  assert.equal(httpCalls[0].params.hex_signature, KNOWN);
});

test('4byte lookup returns null for a selector it does not know', async () => {
  httpHandler = async () => ({ data: FOURBYTE_MISS });
  assert.equal(await MethodSignatureService.lookupFourByte(UNKNOWN), null);
});

// --- decode pass -----------------------------------------------------------

test('decode resolves an unknown selector from Sourcify without asking 4byte', async () => {
  const db = fakeDb({ pending: [KNOWN] });
  httpHandler = async (url) => {
    assert.ok(isSourcify(url), '4byte must not be called once Sourcify answered');
    return { data: SOURCIFY_HIT };
  };

  const summary = await MethodSignatureService.decodePendingForWallet(7);

  assert.equal(httpCalls.length, 1);
  assert.equal(summary.resolved, 1);
  assert.deepEqual(db.signatureInserts, [{ selector: KNOWN, name: SWAP, source: 'sourcify' }]);
});

test('decode falls back to 4byte when Sourcify has no answer', async () => {
  const db = fakeDb({ pending: [KNOWN] });
  httpHandler = async (url) => ({ data: isSourcify(url) ? SOURCIFY_MISS : FOURBYTE_HIT });

  await MethodSignatureService.decodePendingForWallet(7);

  assert.equal(httpCalls.length, 2);
  assert.ok(isSourcify(httpCalls[0].url), 'Sourcify is the primary source');
  assert.deepEqual(db.signatureInserts, [{ selector: KNOWN, name: SWAP, source: '4byte' }]);
});

test('a second sync performs zero lookups for already-cached selectors', async () => {
  // Both flavours of cached row: a hit AND a miss. The miss is the important
  // one -- an undecodable selector recurs on every sync, so if only hits
  // suppressed the fetch it would be re-asked forever.
  const db = fakeDb({
    pending: [KNOWN, UNKNOWN],
    cached: [
      { selector: KNOWN, name: SWAP, source: 'sourcify' },
      { selector: UNKNOWN, name: null, source: 'none' },
    ],
  });

  const summary = await MethodSignatureService.decodePendingForWallet(7);

  assert.equal(httpCalls.length, 0, 'a cached selector must never hit the network again');
  assert.equal(summary.lookups, 0);
  assert.deepEqual(db.signatureInserts, [], 'nothing new to cache');
  // The names still get copied onto the rows from the cache.
  assert.equal(db.applied.length, 1);
  assert.deepEqual(db.applied[0].params, [7]);
});

test('decode caches a miss so an unresolvable selector is only ever fetched once', async () => {
  const db = fakeDb({ pending: [UNKNOWN] });
  httpHandler = async (url) => ({ data: isSourcify(url) ? SOURCIFY_MISS : FOURBYTE_MISS });

  const summary = await MethodSignatureService.decodePendingForWallet(7);

  assert.equal(httpCalls.length, 2, 'both sources are asked before giving up');
  assert.equal(summary.resolved, 0);
  assert.deepEqual(db.signatureInserts, [{ selector: UNKNOWN, name: null, source: 'none' }]);
});

test('applyMethodNames leaves an unresolved selector NULL for the raw-selector fallback', async () => {
  const db = fakeDb({ pending: [UNKNOWN], cached: [{ selector: UNKNOWN, name: null, source: 'none' }] });

  await MethodSignatureService.decodePendingForWallet(7);

  const sql = db.applied[0].sql.replace(/--[^\n]*/g, '').replace(/\s+/g, ' ');
  // Without this predicate a cached miss would write NULL over nothing (or, if
  // the cache ever stored an empty string, an empty method name), and the UI
  // would lose its "show the raw selector" fallback.
  assert.match(sql, /AND s\.name IS NOT NULL/);
  assert.match(sql, /AND t\.method_name IS NULL/);
});

test('a provider outage does not poison the selector with a cached miss', async () => {
  const db = fakeDb({ pending: [UNKNOWN] });
  httpHandler = async (url) => {
    if (isSourcify(url)) throw new Error('ETIMEDOUT');
    return { data: FOURBYTE_MISS };
  };

  const summary = await MethodSignatureService.decodePendingForWallet(7);

  // Caching is permanent, so a miss is only trustworthy when BOTH services
  // actually answered. One bad minute of network must not cost a name forever.
  assert.equal(summary.resolved, 0);
  assert.deepEqual(db.signatureInserts, []);
});

test('decode is a no-op when nothing is pending', async () => {
  fakeDb({ pending: [] });
  const summary = await MethodSignatureService.decodePendingForWallet(7);
  assert.deepEqual(summary, { pending: 0, lookups: 0, resolved: 0, applied: 0 });
  assert.equal(httpCalls.length, 0);
});

test('the pending work list is derived from stored rows, scoped to one wallet', async () => {
  let pendingSql = null;
  queryHandler = async (sql) => {
    if (/SELECT method_id/.test(sql)) {
      pendingSql = sql.replace(/--[^\n]*/g, '').replace(/\s+/g, ' ');
      return { rows: [] };
    }
    throw new Error(`Unexpected query: ${sql}`);
  };

  await EthTransfer.pendingMethodSelectors(7);

  assert.match(pendingSql, /WHERE wallet_id = \$1 AND method_id IS NOT NULL AND method_name IS NULL/);
  // Most-used selectors first, so the lookup budget names what the user
  // actually sees before it names a one-off.
  assert.match(pendingSql, /ORDER BY COUNT\(\*\) DESC/);
});

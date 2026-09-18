'use strict';

const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const axios = require('axios');

const BinanceUSClient = require('../src/services/exchangeSync/binanceusClient');
const connector = require('../src/services/exchangeSync/binanceus');

afterEach(() => {
  BinanceUSClient._resetKeyState();
  BinanceUSClient._setPacingForTests(true);
});

test('Binance.US client signs only the allow-listed GET path', async () => {
  const original = axios.get;
  BinanceUSClient._setPacingForTests(false);
  let request;
  axios.get = async (url, options) => {
    request = { url, options };
    return { status: 200, data: { balances: [] } };
  };
  try {
    const client = new BinanceUSClient({ apiKey: 'key', apiSecret: 'secret' });
    const body = await client.getAccount();
    assert.deepEqual(body, { balances: [] });
    assert.match(request.url, /^https:\/\/api\.binance\.us\/api\/v3\/account\?/);
    assert.equal(request.options.headers['X-MBX-APIKEY'], 'key');
    const query = new URL(request.url).searchParams;
    assert.equal(query.get('recvWindow'), '5000');
    assert.ok(query.get('timestamp'));
    assert.match(query.get('signature'), /^[0-9a-f]{64}$/);
    await assert.rejects(() => client.get('/api/v3/order'), /not a read endpoint/);
  } finally {
    axios.get = original;
  }
});

test('Binance.US API errors identify the endpoint and unsigned request parameters', async () => {
  const original = axios.get;
  BinanceUSClient._setPacingForTests(false);
  axios.get = async () => ({
    status: 400,
    data: { code: -1130, msg: 'A parameter was larger than max value.' },
  });
  try {
    const client = new BinanceUSClient({ apiKey: 'key', apiSecret: 'secret' });
    await assert.rejects(
      () => client.get('/sapi/v1/asset/assetDistributionHistory', { limit: 1000 }),
      (error) => {
        assert.equal(error.code, 'BINANCE_US_API_ERROR');
        assert.match(error.message, /\/sapi\/v1\/asset\/assetDistributionHistory/);
        assert.match(error.message, /limit=1000/);
        assert.doesNotMatch(error.message, /signature|timestamp|recvWindow/);
        assert.deepEqual(error.requestParams, { limit: 1000 });
        return true;
      },
    );
  } finally {
    axios.get = original;
  }
});

test('Binance.US trade records preserve exact signed legs and fees', () => {
  const record = connector._internals.tradeRecord({
    symbol: 'ETHUSDT', id: 42, qty: '0.125000000000000000', quoteQty: '250.50',
    commission: '0.000125', commissionAsset: 'ETH', isBuyer: true,
    time: 1700000000000,
  }, new Map([['ETHUSDT', { baseAsset: 'ETH', quoteAsset: 'USDT' }]]));
  assert.equal(record.record_type, 'trade');
  assert.equal(record.base_amount, '0.125000000000000000');
  assert.equal(record.quote_amount, '-250.50');
  assert.equal(record.fee_asset, 'ETH');
  assert.equal(record.fee_amount, '0.000125');
  assert.equal(record.external_id, 'binanceus:trade:ETHUSDT:42');
  assert.equal(record.needs_review, false);
});

test('Binance.US capital records make failed rows visible for review', () => {
  const record = connector._internals.capitalRecord({
    id: 'w-1', coin: 'ETH', amount: '1.25', fee: '0.001', status: '拒否',
    txId: '0xabc', address: '0x0000000000000000000000000000000000000001',
    network: 'Ethereum', applyTime: 1700000000000,
  }, 'withdrawal');
  assert.equal(record.record_type, 'withdrawal');
  assert.equal(record.base_amount, '-1.25');
  assert.equal(record.fee_amount, '0.001');
  assert.equal(record.tx_hash, '0xabc');
  assert.equal(record.chain_id, 1);
  assert.equal(record.needs_review, true);
});

test('Binance.US balances add free and locked values exactly', () => {
  const balances = connector._internals.accountBalances({ balances: [
    { asset: 'USDT', free: '1.10', locked: '2.20' },
    { asset: 'USDT', free: '0.000000000000000001', locked: '0' },
    { asset: 'ETH', free: '0', locked: '0.5' },
  ] });
  assert.deepEqual(balances, { ETH: '0.5', USDT: '3.300000000000000001' });
});

test('Binance.US history feeds use endpoint-specific request contracts', async () => {
  const originalGet = BinanceUSClient.prototype.get;
  const requests = [];
  BinanceUSClient.prototype.get = async function get(path, params = {}) {
    requests.push({ path, params });
    if (path === '/api/v3/account') return { balances: [] };
    if (path === '/sapi/v1/staking/stakingBalance') return { success: true, code: '000000', data: [] };
    if (path === '/sapi/v1/staking/stakingRewardsHistory') return { success: true, code: '000000', total: 0, data: [] };
    if (path === '/api/v3/exchangeInfo') return { symbols: [] };
    if (path === '/sapi/v1/capital/config/getall') return [];
    if (path === '/sapi/v1/fiatpayment/query/deposit/history') {
      return { assetLogRecordList: [{
        orderId: 'd-1', fiatCurrency: 'USD', amount: '1', createTime: 1700000000000,
      }] };
    }
    if (path === '/sapi/v1/fiatpayment/query/withdraw/history') {
      return { assetLogRecordList: [{
        orderId: 'w-1', fiatCurrency: 'USD', amount: '2', createTime: 1700000000000,
      }] };
    }
    if (path === '/sapi/v1/asset/assetDistributionHistory') return { rows: [] };
    if (path === '/sapi/v1/asset/query/dust-logs') return { userDustConvertHistory: [] };
    throw new Error(`unexpected Binance path ${path}`);
  };
  try {
    const result = await connector.sync({ apiKey: 'key', apiSecret: 'secret' }, { interactive: true });
    const fiatRequests = requests.filter(({ path }) => path.includes('/fiatpayment/query/'));
    assert.deepEqual(fiatRequests.map(({ params }) => params), [{ offset: 0 }, { offset: 0 }]);
    const distribution = requests.find(({ path }) => path === '/sapi/v1/asset/assetDistributionHistory');
    assert.deepEqual(distribution.params, { limit: 500 });
    const dust = requests.find(({ path }) => path === '/sapi/v1/asset/query/dust-logs');
    assert.equal(dust.params.startTime, 0);
    assert.ok(Number.isSafeInteger(dust.params.endTime));
    assert.equal(result.records.length, 2);
    assert.equal(result.stats.backfillPending, false);
    assert.equal(result.coverageLimitations.length, 3);
    assert.equal(result.balancesComplete, true);
    assert.equal(result.cursor.phase, 'trades');
  } finally {
    BinanceUSClient.prototype.get = originalGet;
  }
});

test('Binance.US staking outage keeps history available but refuses a complete balance snapshot', async () => {
  const originalGet = BinanceUSClient.prototype.get;
  BinanceUSClient.prototype.get = async function get(path) {
    if (path === '/api/v3/account') return { balances: [{ asset: 'ETH', free: '1', locked: '0' }] };
    if (path === '/sapi/v1/staking/stakingBalance') throw new Error('Staking read unavailable');
    if (path === '/sapi/v1/staking/stakingRewardsHistory') return { success: true, code: '000000', total: 0, data: [] };
    if (path === '/api/v3/exchangeInfo') return { symbols: [] };
    if (path === '/sapi/v1/capital/config/getall') return [];
    if (path.includes('/fiatpayment/')) return { assetLogRecordList: [] };
    if (path.includes('assetDistributionHistory')) return { rows: [] };
    if (path.includes('dust-logs')) return { userDustConvertHistory: [] };
    throw new Error(`Unexpected endpoint ${path}`);
  };
  try {
    const result = await connector.sync({ apiKey: 'key', apiSecret: 'secret' });
    assert.equal(result.balancesComplete, false);
    assert.equal(result.balances.ETH, '1');
    assert.equal(result.stats.backfillPending, false);
    assert.ok(result.coverageLimitations.some(reason => reason.includes('staking balances are unavailable')));
  } finally { BinanceUSClient.prototype.get = originalGet; }
});

// Synthetic responses only; no customer history in this public repository.
async function withHistoryApi({ coins = ['ETH'], now, respond }, run) {
  const originalGet = BinanceUSClient.prototype.get;
  const originalNow = Date.now;
  const requests = [];
  let clock = now ?? connector._internals.HISTORY_START + 86400000;
  Date.now = () => clock;
  BinanceUSClient.prototype.get = async function get(path, params = {}) {
    requests.push({ path, params: { ...params } });
    const custom = await respond?.(path, params);
    if (custom !== undefined) return custom;
    if (path === '/api/v3/account') return { balances: [] };
    if (path === '/sapi/v1/staking/stakingBalance') return { success: true, code: '000000', data: [] };
    if (path === '/sapi/v1/staking/stakingRewardsHistory') return { success: true, code: '000000', total: 0, data: [] };
    if (path === '/api/v3/exchangeInfo') return { symbols: [] };
    if (path === '/sapi/v1/capital/config/getall') return coins.map(coin => ({ coin }));
    if (path.includes('/capital/')) return [];
    if (path.includes('/fiatpayment/')) return { assetLogRecordList: [] };
    if (path.includes('assetDistributionHistory')) return { rows: [] };
    if (path.includes('dust-logs')) return { userDustConvertHistory: [] };
    throw new Error(`Unexpected endpoint ${path}`);
  };
  try { await run({ requests, setNow: value => { clock = value; } }); }
  finally { BinanceUSClient.prototype.get = originalGet; Date.now = originalNow; }
}
const credentials = { apiKey: 'synthetic-key', apiSecret: 'synthetic-secret' };
const capitalRequests = requests => requests.filter(r => /capital\/(deposit|withdraw)\//.test(r.path));

test('Binance.US backfills contiguous 90-day windows and keeps per-coin checkpoints', async () => {
  const { HISTORY_START: start, CAPITAL_WINDOW_MS: window } = connector._internals;
  const end = start + window * 2 + 4321;
  await withHistoryApi({ now: end }, async ({ requests, setNow }) => {
    const first = await connector.sync(credentials);
    const calls = capitalRequests(requests);
    assert.equal(calls.length, 6);
    for (let i = 0; i < 3; i += 1) {
      assert.equal(calls[i * 2].params.startTime, start + i * window);
      assert.equal(calls[i * 2].params.endTime, Math.min(end, start + (i + 1) * window - 1));
      assert.deepEqual(calls[i * 2].params, calls[i * 2 + 1].params);
      assert.equal(calls[i * 2].params.coin, 'ETH');
    }
    assert.equal(first.stats.backfillPending, false);
    assert.equal(first.cursor.capitalThrough.ETH, end);
    requests.length = 0;
    setNow(end + 86400000);
    const next = await connector.sync(credentials, { cursor: first.cursor });
    assert.equal(capitalRequests(requests)[0].params.startTime, end - window);
    assert.equal(next.cursor.capitalThrough.ETH, end + 86400000);
    assert.equal(first.cursor.capitalThrough.ETH, end, 'caller cursor is immutable');
  });
});

test('Binance.US capital pagination finishes deposits before walking withdrawals', async () => {
  const start = connector._internals.HISTORY_START;
  const deposit = id => ({ id, coin: 'ETH', amount: '0.001', insertTime: start + 5000, status: 1 });
  await withHistoryApi({ respond(path, params) {
    if (path.endsWith('/deposit/hisrec')) return params.offset === 0
      ? Array.from({ length: 1000 }, (_, id) => deposit(`synthetic-${id}`)) : [deposit('synthetic-final')];
  } }, async ({ requests }) => {
    const result = await connector.sync(credentials);
    assert.equal(result.records.length, 1001);
    assert.equal(result.stats.backfillPending, false);
    const calls = capitalRequests(requests);
    assert.deepEqual(calls.map(c => c.params.offset), [0, 1000, 0]);
    assert.ok(calls[2].path.endsWith('/withdraw/history'));
  });
});

test('Binance.US capital resumes at the budget boundary with frozen coins and time range', async () => {
  const coins = Array.from({ length: 50 }, (_, i) => `COIN${String(i).padStart(2, '0')}`);
  await withHistoryApi({ coins }, async ({ requests, setNow }) => {
    const first = await connector.sync(credentials);
    assert.equal(first.stats.requests, connector.MAX_REQUESTS_INTERACTIVE);
    assert.equal(first.stats.backfillPending, true);
    assert.equal(first.cursor.phase, 'capital');
    assert.equal(first.cursor.capitalFeed, 'withdrawal');
    const boundary = first.cursor.capitalEnd;
    const old = JSON.stringify(first.cursor);
    coins.reverse(); coins.unshift('NEWCOIN');
    requests.length = 0;
    setNow(boundary + 86400000);
    const second = await connector.sync(credentials, { cursor: first.cursor });
    assert.equal(JSON.stringify(first.cursor), old);
    const calls = capitalRequests(requests);
    assert.equal(calls[0].params.coin, 'COIN47');
    assert.ok(calls[0].path.endsWith('/withdraw/history'));
    assert.ok(calls.every(c => c.params.endTime === boundary));
    assert.equal(second.stats.backfillPending, false);
    assert.equal(Object.keys(second.cursor.capitalThrough).length, 50);
    assert.equal(second.cursor.capitalThrough.NEWCOIN, undefined);
    assert.ok(requests.some(r => r.path.endsWith('/stakingRewardsHistory')));
  });
});

test('Binance.US v1 cursor restarts rather than asserting historical coverage', () => {
  const result = connector._internals.normalizeCursor({ version: 1, phase: 'dust', coinIndex: 999, depositOffset: 1000 });
  assert.equal(result.version, 2);
  assert.equal(result.phase, 'trades');
  assert.equal(result.coinIndex, 0);
  assert.deepEqual(result.capitalThrough, {});
});

test('Binance.US staking rewards preserve replay IDs and paginate across batches', async () => {
  const start = connector._internals.HISTORY_START;
  const reward = id => ({ asset: 'ETH', amount: '0.0001', time: start + 6000, tranId: id, autoRestaked: true });
  await withHistoryApi({ coins: [], respond(path, params) {
    if (path.endsWith('/stakingRewardsHistory')) return {
      success: true, code: '000000', total: 501,
      data: params.page === 1 ? Array.from({ length: 500 }, (_, i) => reward(i + 1)) : [reward(501)],
    };
  } }, async ({ requests, setNow }) => {
    const first = await connector.sync(credentials);
    assert.equal(first.records.length, 500);
    assert.equal(first.cursor.rewardsPage, 2);
    assert.equal(first.stats.backfillPending, true);
    const fixedEnd = first.cursor.rewardsEnd;
    requests.length = 0;
    setNow(fixedEnd + 86400000);
    const second = await connector.sync(credentials, { cursor: first.cursor });
    assert.equal(requests.find(r => r.path.endsWith('/stakingRewardsHistory')).params.endTime, fixedEnd);
    assert.equal(second.stats.backfillPending, false);
    assert.equal(second.cursor.rewardsPage, 1);
    assert.equal(second.records[0].external_id, 'binanceus:distribution:501');
    assert.equal(second.records[0].record_type, 'reward');
    assert.equal(second.records[0].base_amount, '0.0001');
    assert.equal(second.records[0].raw._source_endpoint, '/sapi/v1/staking/stakingRewardsHistory');
    assert.equal(second.records[0].raw.autoRestaked, true);
    assert.ok(!requests.some(r => r.path.endsWith('/staking/history')));
  });
});

test('Binance.US reward failure preserves other feeds and refuses completion', async () => {
  await withHistoryApi({ respond(path) {
    if (path.endsWith('/stakingRewardsHistory')) return { success: true, code: '000000', total: 10, data: [] };
  } }, async () => {
    const result = await connector.sync(credentials);
    assert.equal(result.stats.backfillPending, true);
    assert.equal(result.cursor.rewardsPage, 1);
    assert.ok(result.coverageLimitations.some(r => r.includes('rewards page is incomplete')));
    assert.ok(result.cursor.capitalThrough.ETH);
  });
});

test('Binance.US malformed or repeated capital pages cannot advance durable coverage', async () => {
  for (const body of [{ rows: [] }, Array.from({ length: 1000 }, (_, id) => ({
    id: `synthetic-${id}`, coin: 'ETH', amount: '0.001', status: 1,
    insertTime: connector._internals.HISTORY_START + 5000,
  }))]) {
    await withHistoryApi({ respond(path) { if (path.endsWith('/deposit/hisrec')) return body; } }, async () => {
      const cursor = connector._internals.emptyCursor(); cursor.phase = 'capital';
      const before = JSON.stringify(cursor);
      await assert.rejects(connector.sync(credentials, { cursor }), { code: 'BINANCE_US_HISTORY_INCOMPLETE' });
      assert.equal(JSON.stringify(cursor), before);
    });
  }
});

test('Binance.US withdrawal completion status differs from deposit status', () => {
  const row = { id: 'synthetic-withdrawal', coin: 'ETH', amount: '2', transactionFee: '0.01', applyTime: 1700000000000 };
  assert.equal(connector._internals.capitalRecord({ ...row, status: 6 }, 'withdrawal').needs_review, false);
  assert.equal(connector._internals.capitalRecord({ ...row, status: 1 }, 'withdrawal').needs_review, true);
  assert.equal(connector._internals.capitalRecord({ ...row, status: 1 }, 'deposit').needs_review, false);
  assert.equal(connector._internals.capitalRecord({ ...row, status: 6 }, 'withdrawal').fee_amount, '0.01');
});

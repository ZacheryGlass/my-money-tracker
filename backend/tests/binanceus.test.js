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

test('Binance.US fiat pages carry independent cursors across durable batches', async () => {
  const originalGet = BinanceUSClient.prototype.get;
  let fiatDepositPage = 0;
  BinanceUSClient.prototype.get = async function get(path, params = {}) {
    if (path === '/api/v3/account') return { balances: [] };
    if (path === '/api/v3/exchangeInfo') return { symbols: [] };
    if (path === '/sapi/v1/capital/config/getall') return [];
    if (path === '/sapi/v1/fiatpayment/query/deposit/history') {
      fiatDepositPage = params.page;
      return { total: 1500, data: Array.from({ length: params.page === 1 ? 1000 : 500 }, (_, index) => ({
        orderId: `d-${params.page}-${index}`,
        fiatCurrency: 'USD', amount: '1', createTime: 1700000000000 + index,
      })) };
    }
    if (path === '/sapi/v1/fiatpayment/query/withdraw/history') {
      return { total: 0, data: [] };
    }
    if (path === '/sapi/v1/asset/assetDistributionHistory') return { rows: [] };
    if (path === '/sapi/v1/asset/query/dust-logs') return { userDustConvertHistory: [] };
    throw new Error(`unexpected Binance path ${path}`);
  };
  try {
    const first = await connector.sync({ apiKey: 'key', apiSecret: 'secret' }, { interactive: true });
    assert.equal(fiatDepositPage, 1);
    assert.equal(first.stats.backfillPending, true);
    assert.equal(first.coverageLimitations.length, 2);
    assert.equal(first.cursor.phase, 'fiat');
    assert.equal(first.cursor.fiatDepositPage, 2);
    const second = await connector.sync({ apiKey: 'key', apiSecret: 'secret' }, {
      cursor: first.cursor, interactive: true,
    });
    assert.equal(fiatDepositPage, 2);
    assert.equal(second.stats.backfillPending, false);
    assert.equal(second.cursor.phase, 'trades');
  } finally {
    BinanceUSClient.prototype.get = originalGet;
  }
});

'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const Holding = require('../src/models/Holding');
const PriceCache = require('../src/models/PriceCache');
const Dashboard = require('../src/services/DashboardService');

test('portfolio includes each exchange holding once and warns about stale or overlapping manual positions', async (t) => {
  t.mock.method(Holding, 'findAll', async () => [
    { account_id: 91, account_type: 'crypto', account_name: 'Synthetic exchange', account_exchange_account_id: 81, ticker: 'ETH', quantity: '3', exchange_balance_stale: true },
    { account_id: 92, account_type: 'crypto', account_name: 'Synthetic wallet', account_eth_wallet_id: 71, ticker: 'ETH', quantity: '2' },
    { account_id: 93, account_type: 'crypto', account_name: 'Synthetic manual', ticker: 'ETH', quantity: '1' },
  ]);
  t.mock.method(PriceCache, 'getLatestPrices', async () => [{ ticker: 'ETH', price_usd: '2000', fetched_at: new Date() }]);
  t.mock.method(Dashboard, 'getFreshness', async () => ({ status: 'ok' }));
  const result = await Dashboard.getCurrentPortfolio(1);
  assert.equal(result.items.length, 3);
  assert.equal(result.total, 12000);
  assert.equal(result.freshness.exchanges.staleCount, 1);
  assert.deepEqual(result.freshness.exchanges.manualOverlapAssets, ['ETH']);
  assert.equal(result.freshness.status, 'warning');
});

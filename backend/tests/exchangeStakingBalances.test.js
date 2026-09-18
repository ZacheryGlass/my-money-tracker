'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const coinbase = require('../src/services/exchangeSync/coinbase')._internals;
const binance = require('../src/services/exchangeSync/binanceus')._internals;
const kraken = require('../src/services/exchangeSync/kraken')._internals;
const wallet = (id, code, amount) => ({ id, balance: { currency: code, amount } });
const trading = (uuid, code, value, hold = '0') => ({ uuid,
  available_balance: { currency: code, value }, hold: { currency: code, value: hold } });

test('Coinbase includes wallet-only staking, keeps trading precision and counts each account once', () => {
  const spot = trading('spot', 'ETH', '2.000000000000000001', '0.5');
  const stake = wallet('staking', 'ETH', '4.12345678');
  const result = coinbase.accountBalances([spot, spot], [wallet('spot', 'ETH', '2.50000000'), stake, stake,
    wallet('old-stake', 'ETH2', '0.125'), wallet('wrapped', 'cbETH', '3')]);
  assert.equal(result.complete, true);
  assert.equal(result.balances.ETH, '6.748456780000000001');
  assert.equal(result.balances.CBETH, '3');
  assert.equal(result.balance_details.ETH.accounts.length, 3);
  assert.equal(result.balance_details.ETH.accounts.find(a => a.id === 'staking').reported_balance, '4.12345678');
});

test('Coinbase cannot certify missing IDs, malformed balances or conflicting account identities', () => {
  for (const [v3, v2] of [
    [[trading(null, 'ETH', '2')], []],
    [[], [wallet('stake', 'ETH', 'not-a-number')]],
    [[trading('same', 'BTC', '2')], [wallet('same', 'ETH', '2')]],
    [[], [wallet('stake', 'ETH', '1'), wallet('stake', 'ETH', '2')]],
  ]) assert.equal(coinbase.accountBalances(v3, v2).complete, false);
});

test('Coinbase list pagination fails closed on malformed or unfinished empty responses', async () => {
  for (const body of [{}, { data: [] }, { data: [], pagination: { next_uri: '/v2/accounts?starting_after=x' } }]) {
    await assert.rejects(coinbase.pageV2({ get: async () => body }, '/v2/accounts', { maxPages: 1 }));
  }
});

test('Kraken combines spot, legacy staking and Earn balances without merging wrapped ETH', () => {
  const result = kraken.normalizeBalanceDetails({ XETH: '1.5', ETH2: '0.1', 'ETH2.S': '2',
    'ETH.B': '3', 'ETH.F': '0.2', 'ETH.M': '0.3', WETH: '4' });
  assert.equal(result.balances.ETH, '7.1');
  assert.equal(result.balances.WETH, '4');
  assert.deepEqual(result.balanceDetails.ETH.provider_balances,
    { XETH: '1.5', ETH2: '0.1', 'ETH2.S': '2', 'ETH.B': '3', 'ETH.F': '0.2', 'ETH.M': '0.3' });
});

const staking = data => ({ success: true, code: '000000', data });
test('Binance.US totals spot plus staking while keeping uncredited rewards separate', () => {
  const result = binance.accountBalanceDetails({ balances: [
    { asset: 'ETH', free: '0.000000000000000001', locked: '0.5' },
  ] }, staking([{ asset: 'ETH', stakingAmount: '12.125', pendingRewards: '0.05', unstakeInProgress: '0' }]));
  assert.equal(result.complete, true);
  assert.equal(result.balances.ETH, '12.625000000000000001');
  assert.equal(result.balanceDetails.ETH.staking.pending_rewards, '0.05');
  assert.equal(result.balanceDetails.ETH.provider_balances.ETH, result.balances.ETH);
});

test('Binance.US staking errors, duplicate assets and active unstakes cannot publish complete balances', () => {
  for (const body of [null, {}, { success: false, data: [] }, staking([{ asset: 'ETH', stakingAmount: 'bad' }]),
    staking([{ asset: 'ETH', stakingAmount: '1', unstakeInProgress: '0.5' }]),
    staking([{ asset: 'ETH', stakingAmount: '1' }, { asset: 'ETH', stakingAmount: '1' }])]) {
    assert.equal(binance.accountBalanceDetails({ balances: [] }, body).complete, false);
  }
  assert.equal(binance.accountBalanceDetails({}, staking([])).complete, false);
});

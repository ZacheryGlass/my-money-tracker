'use strict';

module.exports = async function exchangeHoldingsSqlChecks(pool, ok) {
  const service = require('../src/services/ExchangeHoldingsService');
  const Holding = require('../src/models/Holding');
  const account = (await pool.query(`INSERT INTO exchange_accounts (user_id, name, exchange, api_key_encrypted, api_secret_encrypted)
    VALUES (1, 'Synthetic holdings projection', 'coinbase', 'test-only', 'test-only') RETURNING *`)).rows[0];
  const client = await pool.connect();
  const snapshot = {
    provider: 'coinbase', complete: true, credential_generation: null,
    observed_at: new Date().toISOString(), balances: { ETH: '1.000000000000000001', ETH2: '2.25', BTC: '0.5', USD: '12.34' },
  };
  const project = async (data) => {
    await client.query('BEGIN');
    try {
      await client.query("UPDATE exchange_accounts SET provider_balance_snapshot=$2, last_sync_status='ok' WHERE id=$1", [account.id, data]);
      const result = await service.syncSnapshot(account, data, { client });
      await client.query('COMMIT');
      return result;
    } catch (error) { await client.query('ROLLBACK'); throw error; }
  };
  try {
    const first = await project(snapshot);
    const get = async () => (await pool.query('SELECT id, ticker, name, quantity::text FROM holdings WHERE account_id=$1 ORDER BY id', [first.accountId])).rows;
    const before = await get();
    const second = await project(snapshot);
    ok('exchange snapshot replay preserves account/holding IDs and USD has no NULL-key duplicate',
      first.accountId === second.accountId && JSON.stringify(before) === JSON.stringify(await get()) && before.length === 3);
    ok('exchange holdings retain wei precision and combine staking once', before.find((r) => r.ticker === 'ETH').quantity === '3.250000000000000001');
    let rejected = false;
    try { await project({ ...snapshot, complete: false, balances: {} }); } catch { rejected = true; }
    ok('incomplete snapshot leaves previous quantities intact', rejected && JSON.stringify(before) === JSON.stringify(await get()));
    await project({ ...snapshot, balances: { ETH: '4', USD: '8.50' } });
    const current = await Holding.findAll({ userId: 1 });
    const exchangeRows = current.filter((r) => r.account_exchange_account_id === account.id);
    ok('complete snapshots remove closed positions and are visible through shared holdings', exchangeRows.length === 2 && !exchangeRows.some((r) => r.ticker === 'BTC'));
    ok('exchange balances are fresh even without completed transaction history', exchangeRows.every((r) => r.exchange_balance_stale === false));
    ok('exchange holdings stay scoped to their owner', !(await Holding.findAll({ userId: 2 })).some((r) => r.account_exchange_account_id === account.id));
    await pool.query("UPDATE exchange_accounts SET last_sync_status='error' WHERE id=$1", [account.id]);
    const stale = (await Holding.findAll({ userId: 1 })).filter((r) => r.account_exchange_account_id === account.id);
    ok('failed exchange reads retain last known holdings and mark them stale', stale.length === 2 && stale.every((r) => r.exchange_balance_stale));
    await pool.query('UPDATE exchange_accounts SET api_key_encrypted=NULL, api_secret_encrypted=NULL, provider_balance_snapshot=NULL WHERE id=$1', [account.id]);
    ok('disconnect retains holdings with a stale marker', (await Holding.findAll({ userId: 1 })).filter((r) => r.account_exchange_account_id === account.id).every((r) => r.exchange_balance_stale));
    let scoped = false;
    try { await pool.query('UPDATE accounts SET user_id=2 WHERE id=$1', [first.accountId]); } catch (error) { scoped = error.code === '23503'; }
    ok('database rejects cross-owner exchange portfolio links', scoped);
    await project({ ...snapshot, balances: {} });
    ok('a complete zero balance list clears prior positions', (await get()).length === 0);
    await pool.query('DELETE FROM exchange_accounts WHERE id=$1', [account.id]);
    ok('deleting the exchange removes its portfolio projection', (await get()).length === 0);
  } finally {
    client.release();
    await pool.query('DELETE FROM exchange_accounts WHERE id=$1', [account.id]);
  }
};

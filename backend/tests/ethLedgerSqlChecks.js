'use strict';

// Synthetic fixtures executed by verify-ledger-sql against its disposable DB.
module.exports = async function checkEthLedger(pool, ok) {
  const EthLedger = require('../src/models/EthLedger');
  const EthTransfer = require('../src/models/EthTransfer');
  const ExchangeRecord = require('../src/models/ExchangeRecord');
  const owner = 9001;
  await pool.query("INSERT INTO users (id, username) VALUES (9001, 'eth-ledger-fixture')");
  const addresses = ['7', '8'].map((c) => `0x${c.repeat(40)}`);
  const wallets = (await pool.query(`INSERT INTO eth_wallets (user_id, address, label)
    VALUES ($1, $2, 'Ledger A'), ($1, $3, 'Ledger B') RETURNING id`,
  [owner, ...addresses])).rows.map((r) => r.id);
  const exchange = (await pool.query(`INSERT INTO exchange_accounts (user_id, name, exchange)
    VALUES ($1, 'Ledger venue', 'other') RETURNING id`, [owner])).rows[0].id;
  const ext = `0x${'9'.repeat(40)}`;
  let ordinal = 0;
  const leg = (wallet, type, value, from, to, extra = {}) => ({
    wallet_id: wallets[wallet], chain_id: 1, tx_hash: `0x${String(++ordinal).padStart(64, '0')}`,
    ordinal: 0, transfer_type: type, value_wei: String(value), from_address: from,
    to_address: to, block_number: ordinal, block_time: `2026-01-01T00:00:${String(ordinal).padStart(2, '0')}Z`,
    is_error: false, ...extra,
  });
  const raw = [
    leg(0, 'native', '10000000000000000001', ext, addresses[0]),
    leg(0, 'native', '1000000000000000000', addresses[0], addresses[0]),
    leg(0, 'gas', 10, addresses[0], ext, { method_name: 'transfer' }),
    leg(0, 'native', '900000000000000000000', addresses[0], ext, { is_error: true }),
    leg(0, 'gas', 7, addresses[0], ext, { tx_is_error: true }),
    leg(0, 'native', '2000000000000000000', addresses[0], addresses[1]),
    leg(0, 'gas', 5, addresses[0], addresses[1]),
    leg(1, 'native', '2000000000000000000', addresses[0], addresses[1]),
    leg(0, 'internal', 123, ext, addresses[0]),
    leg(1, 'native', 500, ext, addresses[1], { chain_id: 42161 }),
    leg(0, 'native', '999999999999999999999', ext, addresses[0], { chain_id: 137 }),
    leg(0, 'token', '999999999999999999999', ext, addresses[0], { token_symbol: 'ETH', token_contract: ext, token_standard: 'erc20' }),
    leg(0, 'nft', 1, ext, addresses[0], { token_contract: ext, token_standard: 'erc721', token_id: '1' }),
    leg(0, 'gas', 2, addresses[0], ext, { method_name: 'mint' }),
  ];
  await EthTransfer.bulkInsert(raw);
  await pool.query(`INSERT INTO exchange_records (exchange_account_id, record_type, occurred_at,
    base_asset, base_amount, quote_asset, quote_amount, fee_asset, fee_amount, external_id)
    VALUES ($1, 'deposit', '2026-01-02', 'ETH', 1, NULL, NULL, NULL, NULL, 'ledger-deposit'),
      ($1, 'withdrawal', '2026-01-03', 'ETH', -0.5, NULL, NULL, 'ETH', 0.01, 'ledger-withdraw'),
      ($1, 'trade', '2026-01-04', 'BTC', -1, 'ETH', 0.25, 'ETH', 0.001, 'ledger-trade'),
      ($1, 'fee', '2026-01-05', NULL, NULL, NULL, NULL, 'ETH', 0.000000000000000001, 'ledger-fee')`, [exchange]);
  await pool.query(`INSERT INTO eth_reconciliation_adjustments (wallet_id, chain_id, asset_key, amount_wei, note)
    VALUES ($1, 1, 'ETH', -123, 'Synthetic audit only')`, [wallets[0]]);
  const all = await EthLedger.findForUser(owner, { limit: 500 });
  const expected = 10000000000000000001n - 10n - 7n - 5n + 123n + 500n - 2n
    + 1000000000000000000n - 500000000000000000n - 10000000000000000n
    + 250000000000000000n - 1000000000000000n - 1n;
  ok('ETH ledger preserves wei and includes both owned sides plus all ETH fees',
    all.closing_balance_wei === String(expected)
      && all.data.filter((r) => r.kind === 'gas').length === 4
      && all.data.filter((r) => r.kind === 'exchange_fee').length === 3
      && all.data.filter((r) => r.delta_wei === '0').length === 2);
  ok('ETH ledger excludes token symbols, NFTs and non-ETH native chains',
    all.data.every((r) => r.chain_id !== 137 && !['token', 'nft'].includes(r.kind)));
  ok('ETH ledger excludes audit-only adjustments but discloses them',
    all.scopes.find((s) => s.scope === `wallet:${wallets[0]}:1`).adjustment_wei === '-123');
  let running = 0n;
  ok('ETH ledger every row balance equals all preceding deltas', all.data.every((r) => {
    running += BigInt(r.delta_wei);
    return r.balance_wei === String(running);
  }));
  const page = await EthLedger.findForUser(owner, { limit: 2, offset: 3 });
  const empty = await EthLedger.findForUser(owner, { offset: 10000 });
  ok('ETH ledger windows precede pagination, including empty pages',
    JSON.stringify(page.data) === JSON.stringify(all.data.slice(3, 5))
      && page.total === all.total && empty.total === all.total && empty.data.length === 0
      && empty.closing_balance_wei === all.closing_balance_wei);
  const scope = `wallet:${wallets[0]}:1`;
  const scoped = await EthLedger.findForUser(owner, { scope });
  const native = await EthTransfer.nativeBalanceDeltas(wallets[0]);
  const exchangeLedger = await EthLedger.findForUser(owner, { scope: `exchange:${exchange}` });
  const exchangeBalance = await ExchangeRecord.derivedBalances(exchange, owner);
  ok('ETH ledger account balances agree with canonical reconciliation math',
    scoped.closing_balance_wei === native.find((r) => r.chain_id === 1).balance_wei
      && exchangeLedger.closing_balance_wei === String(739000000000000000n - 1n)
      && exchangeBalance.ETH === '0.738999999999999999'
      && all.data.filter((r) => r.scope === scope).at(-1).account_balance_wei === scoped.closing_balance_wei);
  const filtered = await EthLedger.findForUser(owner, { walletId: wallets[0] });
  const foreign = await EthLedger.findForUser(2, { scope });
  ok('ETH ledger wallet filters and both source branches remain user isolated',
    filtered.data.every((r) => r.scope.startsWith(`wallet:${wallets[0]}:`))
      && foreign.data.length === 0 && !foreign.scopes.some((s) => s.scope === scope));
  await pool.query(`INSERT INTO exchange_records (exchange_account_id, record_type, occurred_at,
    base_asset, base_amount, external_id, needs_review)
    VALUES ($1, 'transfer', '2026-01-06', 'ETH', NULL, 'ledger-unknown', true)`, [exchange]);
  const unknown = await EthLedger.findForUser(owner);
  ok('ETH ledger never treats an unknown ETH amount as zero',
    unknown.unknown_amounts === 1 && unknown.closing_balance_wei === null
      && unknown.data.at(-1).balance_wei === null && unknown.data.at(-1).delta_wei === null
      && unknown.data[0].balance_wei === all.data[0].balance_wei);
  const coinbase = (await pool.query(`INSERT INTO exchange_accounts (user_id, name, exchange)
    VALUES ($1, 'Staking fixture', 'coinbase') RETURNING id`, [owner])).rows[0].id;
  await pool.query(`INSERT INTO exchange_records (exchange_account_id, record_type, occurred_at,
    base_asset, base_amount, quote_asset, quote_amount, fee_asset, fee_amount, external_id, raw)
    VALUES ($1, 'deposit', '2026-02-01', 'ETH', 10, NULL, NULL, NULL, NULL, 'stake-funding', '{}'),
      ($1, 'conversion', '2026-02-02', 'ETH', -10, 'ETH2', 10, NULL, NULL, 'stake', '{"to":"ETH2"}'),
      ($1, 'reward', '2026-02-03', 'ETH2', 0.500000000000000001, NULL, NULL, NULL, NULL, 'stake-reward', '{"asset":"ETH2"}'),
      ($1, 'conversion', '2026-02-04', 'ETH2', -4, 'ETH', 4, 'ETH2', 0.01, 'unstake', '{"from":"ETH2"}'),
      ($1, 'deposit', '2026-02-05', 'CBETH', 50, NULL, NULL, NULL, NULL, 'wrapped', '{}'),
      ($2, 'deposit', '2026-02-05', 'ETH2', 99, NULL, NULL, NULL, NULL, 'unrelated-eth2', '{}')`, [coinbase, exchange]);
  const original = (await pool.query('SELECT id, raw, external_id, base_amount, quote_amount, fee_amount FROM exchange_records WHERE exchange_account_id=$1 ORDER BY id', [coinbase])).rows;
  const migration = require('node:fs').readFileSync(require('node:path').join(__dirname, '../migrations/090_coinbase_eth2_asset_alias.sql'), 'utf8');
  await pool.query(migration);
  const saved = (await pool.query('SELECT id, raw, external_id, base_amount, quote_amount, fee_amount FROM exchange_records WHERE exchange_account_id=$1 ORDER BY id', [coinbase])).rows;
  const balance = await ExchangeRecord.derivedBalances(coinbase, owner);
  const stakingLedger = await EthLedger.findForUser(owner, { scope: `exchange:${coinbase}` });
  ok('Coinbase ETH2 migration preserves quantities, source evidence and record identities', JSON.stringify(original) === JSON.stringify(saved));
  ok('ETH staking principal cancels and rewards and fees contribute exactly once',
    balance.ETH === '10.490000000000000001' && balance.ETH2 === undefined
      && balance.CBETH === '50.000000000000000000' && stakingLedger.closing_balance_wei === '10490000000000000001'
      && stakingLedger.data.length === 7);
  const byReference = ref => stakingLedger.data.filter(r => r.reference === ref).reduce((sum, r) => sum + BigInt(r.delta_wei), 0n);
  ok('ETH2 staking and unstaking preserve principal in the running ledger',
    byReference('stake') === 0n && byReference('unstake') === -10000000000000000n);
  const otherBalance = await ExchangeRecord.derivedBalances(exchange, owner);
  ok('Coinbase ETH2 alias does not merge another venue or another users data',
    otherBalance.ETH2 === '99.000000000000000000'
      && (await EthLedger.findForUser(2, { scope: `exchange:${coinbase}` })).data.length === 0);
  ok('ETH2 migration is idempotent', (await pool.query(migration)).rowCount === 0);
  await pool.query('DELETE FROM eth_wallets WHERE user_id = $1', [owner]);
  await pool.query('DELETE FROM exchange_accounts WHERE user_id = $1', [owner]);
  await pool.query('DELETE FROM users WHERE id = $1', [owner]);
};

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ExchangeBalanceReconciliationService = require('../src/services/ExchangeBalanceReconciliationService');

const migration = fs.readFileSync(
  path.join(__dirname, '..', 'migrations', '062_exchange_balance_exceptions.sql'),
  'utf8'
);

test('migration creates immutable audit runs, snapshots, and one current exception per asset', () => {
  assert.match(migration, /CREATE TABLE IF NOT EXISTS exchange_balance_audit_runs/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS exchange_balance_audit_snapshots/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS exchange_balance_exceptions/);
  assert.match(migration, /derived_balance NUMERIC\(38, 18\)/);
  assert.match(migration, /live_balance NUMERIC\(38, 18\)/);
  assert.match(migration, /delta NUMERIC\(38, 18\)/);
  assert.match(migration, /UNIQUE \(exchange_account_id, canonical_asset\)/);
  assert.match(migration, /exchange_account_id INT NOT NULL REFERENCES exchange_accounts\(id\) ON DELETE CASCADE/);
  assert.match(migration, /current_snapshot_id BIGINT REFERENCES exchange_balance_audit_snapshots\(id\) ON DELETE SET NULL/);
  assert.match(migration, /opening_balance_gap.*provider_migration.*rounding_dust/s);
  assert.match(migration, /parser_defect.*missing_activity/s);
});

test('exact snapshot classification preserves provider codes and raw balances', () => {
  const snapshots = ExchangeBalanceReconciliationService.snapshotsFor(
    { ETH: '1.000000000000000001' },
    { ETH: '1.000000000000000002' },
    {
      ETH: {
        provider_asset_codes: ['ETH2', 'XETH'],
        provider_balances: { XETH: '0.5', ETH2: '0.500000000000000002' },
      },
    },
    '2026-07-31T00:00:00.000Z'
  );
  assert.deepEqual(snapshots[0], {
    canonical_asset: 'ETH',
    provider_asset_codes: ['ETH2', 'XETH'],
    provider_balances: { XETH: '0.5', ETH2: '0.500000000000000002' },
    derived_balance: '1.000000000000000001',
    live_balance: '1.000000000000000002',
    delta: '-0.000000000000000001',
    comparison_status: 'dust',
    calculated_at: '2026-07-31T00:00:00.000Z',
    adjusted_delta: '-0.000000000000000001',
  });
});

test('materiality stays exact and treats a changed live value as a mismatch', () => {
  assert.equal(
    ExchangeBalanceReconciliationService.classify('0.123456789012345678', '0.123456789012345679').status,
    'dust'
  );
  assert.equal(
    ExchangeBalanceReconciliationService.classify('0.123456789012345678', '0.223456789012345679').status,
    'mismatch'
  );
});

test('an accepted rounding_dust verdict survives a delta that stays dust, and only that', () => {
  const previous = {
    status: 'accepted', category: 'rounding_dust', evidence: 'staking reward rounding',
    adjustment: '0', reviewer_id: 1, reviewed_at: '2026-10-05T00:00:00.000Z',
    previous_derived_balance: '1.000000003814', previous_live_balance: '1.000000000000',
    previous_delta: '0.000000003814', previous_provider_asset_codes: ['ETH'],
    previous_provider_balances: { ETH: '1.000000000000' },
  };
  const [dust] = ExchangeBalanceReconciliationService.snapshotsFor(
    { ETH: '1.000000005806' }, { ETH: '1.000000000000' }, {}
  );
  assert.equal(dust.comparison_status, 'dust');
  const kept = ExchangeBalanceReconciliationService.currentState(previous, dust);
  assert.equal(kept.status, 'accepted');
  assert.equal(kept.category, 'rounding_dust');

  const [grown] = ExchangeBalanceReconciliationService.snapshotsFor(
    { ETH: '1.5' }, { ETH: '1.0' }, {}
  );
  assert.equal(ExchangeBalanceReconciliationService.currentState(previous, grown).status, 'open');
  assert.equal(
    ExchangeBalanceReconciliationService.currentState({ ...previous, category: 'parser_defect' }, dust).status,
    'open'
  );
  assert.equal(
    ExchangeBalanceReconciliationService.currentState({ ...previous, adjustment: '-0.000000003814' }, dust).status,
    'open'
  );
});

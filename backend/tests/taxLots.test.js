'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = 'postgresql://test:test@localhost/test';

const pgModulePath = require.resolve('pg');
require.cache[pgModulePath] = {
  id: pgModulePath,
  filename: pgModulePath,
  loaded: true,
  exports: {
    Pool: class FakePool {
      query() { throw new Error('Unexpected query'); }
      connect() { throw new Error('Unexpected connect'); }
      on() {}
    },
    types: { setTypeParser() {} },
  },
};

const { buildLots } = require('../src/services/TaxLotService');

const buy = (id, date, quantity, price, fees = 0) => ({
  id, trade_date: date, side: 'buy', quantity, price, fees,
});
const sell = (id, date, quantity, price = 0) => ({
  id, trade_date: date, side: 'sell', quantity, price, fees: 0,
});

test('buildLots opens one lot per purchase and folds fees into the basis', () => {
  const { lots, shortfall } = buildLots([buy(1, '2024-01-01', 10, 10, 5)]);

  assert.equal(shortfall, 0);
  assert.equal(lots.length, 1);
  assert.deepEqual(lots[0], {
    quantity: 10,
    remainingQuantity: 10,
    costBasis: 105,
    acquiredDate: '2024-01-01',
    sourceTradeId: 1,
  });
});

test('buildLots consumes the oldest lot first', () => {
  const { lots } = buildLots([
    buy(1, '2024-01-01', 10, 10),
    buy(2, '2024-02-01', 10, 20),
    sell(3, '2024-03-01', 12),
  ]);

  // Lot 1 is fully consumed and drops out; 8 shares of lot 2 remain at $20.
  assert.equal(lots.length, 1);
  assert.equal(lots[0].sourceTradeId, 2);
  assert.equal(lots[0].acquiredDate, '2024-02-01');
  assert.equal(lots[0].remainingQuantity, 8);
  assert.equal(lots[0].costBasis, 160);
});

// unrealized gain is computed as (remaining_quantity * price - cost_basis), so a
// partially sold lot must carry the basis of what is left, not of the original buy.
test('buildLots scales the cost basis down with the remaining quantity', () => {
  const { lots } = buildLots([
    buy(1, '2024-01-01', 10, 10, 5),
    sell(2, '2024-02-01', 4),
  ]);

  assert.equal(lots[0].quantity, 10);
  assert.equal(lots[0].remainingQuantity, 6);
  assert.equal(lots[0].costBasis, 63); // 6 shares * $10.50 unit cost
});

test('buildLots drops fully consumed lots', () => {
  const { lots, shortfall } = buildLots([
    buy(1, '2024-01-01', 5, 10),
    sell(2, '2024-02-01', 5),
  ]);

  assert.equal(lots.length, 0);
  assert.equal(shortfall, 0);
});

// Positions opened before Plaid's trade window have sells with nothing to
// consume. That must not abort the rebuild for every other position.
test('buildLots clamps oversells and reports the shortfall', () => {
  const { lots, shortfall } = buildLots([
    buy(1, '2024-01-01', 5, 10),
    sell(2, '2024-02-01', 8),
  ]);

  assert.equal(lots.length, 0);
  assert.equal(shortfall, 3);
});

test('buildLots spreads one sell across several lots', () => {
  const { lots } = buildLots([
    buy(1, '2024-01-01', 5, 10),
    buy(2, '2024-02-01', 5, 20),
    buy(3, '2024-03-01', 5, 30),
    sell(4, '2024-04-01', 7),
  ]);

  assert.equal(lots.length, 2);
  assert.equal(lots[0].sourceTradeId, 2);
  assert.equal(lots[0].remainingQuantity, 3);
  assert.equal(lots[0].costBasis, 60);
  assert.equal(lots[1].sourceTradeId, 3);
  assert.equal(lots[1].remainingQuantity, 5);
});

// Doubles cannot hold a DECIMAL(20,8) exactly, and rebuild() replays every day,
// so any sub-unit drift becomes a permanent phantom lot or a recurring bogus
// "sells exceeded lots" warning. Matching is done in integer units to prevent it.
test('buildLots closes a position exactly at DECIMAL(20,8) magnitudes', () => {
  const { lots, shortfall } = buildLots([
    buy(1, '2024-01-01', '918273645.19283746', '0.00001'),
    sell(2, '2024-01-02', '123456789.87654321'),
    sell(3, '2024-01-03', '345678912.34567891'),
    sell(4, '2024-01-04', '449137942.97061534'),
  ]);

  assert.equal(shortfall, 0);
  assert.equal(lots.length, 0);
});

test('buildLots leaves no phantom remainder when many lots close together', () => {
  const { lots, shortfall } = buildLots([
    buy(1, '2024-01-01', '123456789.87654321', '0.00001'),
    buy(2, '2024-01-02', '345678912.34567891', '0.00001'),
    buy(3, '2024-01-03', '449137942.97061534', '0.00001'),
    sell(4, '2024-01-04', '918273645.19283746'),
  ]);

  assert.equal(shortfall, 0);
  assert.equal(lots.length, 0);
});

test('buildLots handles fractional quantities and string values from pg', () => {
  const { lots, shortfall } = buildLots([
    buy(1, '2024-01-01', '1.50000000', '100.00000000', '0'),
    sell(2, '2024-02-01', '0.25000000'),
  ]);

  assert.equal(shortfall, 0);
  assert.equal(lots[0].remainingQuantity, 1.25);
  assert.equal(lots[0].costBasis, 125);
});

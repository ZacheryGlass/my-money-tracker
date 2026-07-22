'use strict';

const pool = require('../config/database');
const Trade = require('../models/Trade');
const logger = require('../config/logger');

// quantity is DECIMAL(20,8), so one unit is 1e-8 of a share.
const QUANTITY_PRECISION = 8;
const QUANTITY_SCALE = 10n ** BigInt(QUANTITY_PRECISION);

function roundTo(value, places) {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}

// Quantities are matched as exact integer units rather than floats. Doubles
// carry ~15-17 significant digits, which is not enough for a DECIMAL(20,8)
// value, and the error is larger than the 1e-8 grid it would be rounded to --
// so sells that exactly close a position can leave a sub-unit remainder behind.
// That remainder is not harmless: rebuild() runs daily, so it reappears forever
// as a phantom open lot, or as a spurious "sells exceeded lots" warning.
function toUnits(value) {
  let text = typeof value === 'string' ? value.trim() : '';
  if (!/^-?(\d+(\.\d*)?|\.\d+)$/.test(text)) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return 0n;
    // Also normalizes exponent notation, which the parser below cannot read.
    text = numeric.toFixed(QUANTITY_PRECISION);
  }
  const [, sign, whole = '', fraction = ''] = /^(-?)(\d*)(?:\.(\d*))?$/.exec(text);
  const scaled = (fraction + '0'.repeat(QUANTITY_PRECISION)).slice(0, QUANTITY_PRECISION);
  const units = BigInt(whole || '0') * QUANTITY_SCALE + BigInt(scaled || '0');
  return sign === '-' ? -units : units;
}

function fromUnits(units) {
  return Number(units) / Number(QUANTITY_SCALE);
}

// Replays one position's trades into open FIFO lots. Exported for testing.
//
// cost_basis is deliberately the basis of the REMAINING quantity, not of the
// original purchase: FinancialQueryService computes unrealized gain as
// (remaining_quantity * price - cost_basis), which is only correct if the basis
// has been scaled down alongside a partially sold lot.
function buildLots(trades) {
  const lots = [];
  let shortfallUnits = 0n;

  for (const trade of trades) {
    const quantityUnits = toUnits(trade.quantity);
    if (quantityUnits <= 0n) continue;
    const price = Number(trade.price) || 0;
    const fees = Number(trade.fees) || 0;

    if (trade.side === 'buy') {
      const quantity = fromUnits(quantityUnits);
      lots.push({
        quantityUnits,
        remainingUnits: quantityUnits,
        unitCost: (quantity * price + fees) / quantity,
        acquiredDate: trade.trade_date,
        tradeId: trade.id,
      });
      continue;
    }

    let unsoldUnits = quantityUnits;
    for (const lot of lots) {
      if (unsoldUnits <= 0n) break;
      if (lot.remainingUnits <= 0n) continue;
      const taken = lot.remainingUnits < unsoldUnits ? lot.remainingUnits : unsoldUnits;
      lot.remainingUnits -= taken;
      unsoldUnits -= taken;
    }
    // Sells that predate Plaid's trade window have no lot to consume. Clamping
    // and reporting keeps one old position from failing the whole rebuild.
    if (unsoldUnits > 0n) shortfallUnits += unsoldUnits;
  }

  return {
    lots: lots
      .filter((lot) => lot.remainingUnits > 0n)
      .map((lot) => {
        const remainingQuantity = fromUnits(lot.remainingUnits);
        return {
          quantity: fromUnits(lot.quantityUnits),
          remainingQuantity,
          costBasis: Math.max(0, roundTo(remainingQuantity * lot.unitCost, 2)),
          acquiredDate: lot.acquiredDate,
          sourceTradeId: lot.tradeId,
        };
      }),
    shortfall: fromUnits(shortfallUnits),
  };
}

function groupKey(trade) {
  return `${trade.account_id}::${String(trade.symbol).toUpperCase()}`;
}

// Full rebuild rather than incremental: trades are the source of truth, the row
// count is tiny, and a restated or backfilled trade silently invalidates any
// incrementally maintained lot. Lots without a source trade are hand-entered and
// are left alone.
async function rebuild() {
  const trades = await Trade.findAllOrdered();

  const groups = new Map();
  for (const trade of trades) {
    const key = groupKey(trade);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(trade);
  }

  const accountIds = [];
  const symbols = [];
  const acquiredDates = [];
  const quantities = [];
  const remainingQuantities = [];
  const costBases = [];
  const sourceTradeIds = [];
  const shortfalls = [];

  for (const [key, positionTrades] of groups) {
    const { lots, shortfall } = buildLots(positionTrades);
    const [accountId, symbol] = key.split('::');
    if (shortfall > 0) shortfalls.push({ accountId: Number(accountId), symbol, shortfall });

    for (const lot of lots) {
      accountIds.push(Number(accountId));
      symbols.push(symbol);
      acquiredDates.push(lot.acquiredDate);
      quantities.push(lot.quantity);
      remainingQuantities.push(lot.remainingQuantity);
      costBases.push(lot.costBasis);
      sourceTradeIds.push(lot.sourceTradeId);
    }
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM tax_lots WHERE source_trade_id IS NOT NULL');
    if (accountIds.length) {
      await client.query(
        `INSERT INTO tax_lots (account_id, symbol, acquired_date, quantity, remaining_quantity, cost_basis, source_trade_id)
         SELECT * FROM UNNEST($1::int[], $2::varchar[], $3::date[], $4::numeric[], $5::numeric[], $6::numeric[], $7::int[])`,
        [accountIds, symbols, acquiredDates, quantities, remainingQuantities, costBases, sourceTradeIds]
      );
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }

  if (shortfalls.length) {
    logger.warn({ shortfalls }, 'Sells exceeded available tax lots; trade history likely predates the Plaid window');
  }
  logger.info({ positions: groups.size, lots: accountIds.length }, 'Tax lot rebuild completed');
  return { positions: groups.size, lots: accountIds.length, shortfalls };
}

module.exports = { rebuild, buildLots };

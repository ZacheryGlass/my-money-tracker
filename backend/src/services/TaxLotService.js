'use strict';

const pool = require('../config/database');
const Trade = require('../models/Trade');
const logger = require('../config/logger');

const QUANTITY_PRECISION = 8;

function roundTo(value, places) {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}

// Replays one position's trades into open FIFO lots. Exported for testing.
//
// cost_basis is deliberately the basis of the REMAINING quantity, not of the
// original purchase: FinancialQueryService computes unrealized gain as
// (remaining_quantity * price - cost_basis), which is only correct if the basis
// has been scaled down alongside a partially sold lot.
function buildLots(trades) {
  const lots = [];
  let shortfall = 0;

  for (const trade of trades) {
    const quantity = Number(trade.quantity) || 0;
    const price = Number(trade.price) || 0;
    const fees = Number(trade.fees) || 0;
    if (quantity <= 0) continue;

    if (trade.side === 'buy') {
      lots.push({
        quantity,
        remaining: quantity,
        unitCost: (quantity * price + fees) / quantity,
        acquiredDate: trade.trade_date,
        tradeId: trade.id,
      });
      continue;
    }

    let unsold = quantity;
    for (const lot of lots) {
      if (unsold <= 0) break;
      if (lot.remaining <= 0) continue;
      const taken = Math.min(lot.remaining, unsold);
      lot.remaining = roundTo(lot.remaining - taken, QUANTITY_PRECISION);
      unsold = roundTo(unsold - taken, QUANTITY_PRECISION);
    }
    // Sells that predate Plaid's trade window have no lot to consume. Clamping
    // and reporting keeps one old position from failing the whole rebuild.
    if (unsold > 0) shortfall = roundTo(shortfall + unsold, QUANTITY_PRECISION);
  }

  return {
    lots: lots
      .filter((lot) => lot.remaining > 0)
      .map((lot) => ({
        quantity: roundTo(lot.quantity, QUANTITY_PRECISION),
        remainingQuantity: roundTo(lot.remaining, QUANTITY_PRECISION),
        costBasis: Math.max(0, roundTo(lot.remaining * lot.unitCost, 2)),
        acquiredDate: lot.acquiredDate,
        sourceTradeId: lot.tradeId,
      })),
    shortfall,
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

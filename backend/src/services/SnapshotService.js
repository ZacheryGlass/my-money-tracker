'use strict';

const Holding = require('../models/Holding');
const PriceCache = require('../models/PriceCache');
const TickerSnapshot = require('../models/TickerSnapshot');
const AccountSnapshot = require('../models/AccountSnapshot');
const logger = require('../config/logger');

class SnapshotService {
  static async createTickerSnapshots(date) {
    // Fetch all holdings and prices
    const [holdings, prices] = await Promise.all([
      Holding.findAll(),
      PriceCache.getLatestPrices()
    ]);

    // Build price lookup map: { ticker: price_usd }
    const priceMap = {};
    for (const p of prices) {
      priceMap[p.ticker.toUpperCase()] = parseFloat(p.price_usd);
    }

    // Calculate value for each holding and prepare snapshots
    const snapshots = [];
    let succeeded = 0;
    let failed = 0;

    for (const holding of holdings) {
      let value = 0;
      // Recorded alongside value so history can tell a price move apart from a
      // change in position size. Null for manually valued holdings, which have
      // no share count or unit price.
      let quantity = null;
      let price = null;

      const qty = parseFloat(holding.quantity || 0);
      if (holding.ticker && qty > 0 && priceMap[holding.ticker.toUpperCase()]) {
        price = priceMap[holding.ticker.toUpperCase()];
        quantity = qty;
        value = qty * price;
        succeeded++;
      } else if (holding.manual_value !== null) {
        value = parseFloat(holding.manual_value);
        succeeded++;
      } else {
        // Missing price and no manual value — holding will not appear in this snapshot
        logger.warn({ holdingId: holding.id, name: holding.name, ticker: holding.ticker }, 'No price found for holding, skipping snapshot');
        failed++;
        continue;
      }

      snapshots.push({
        snapshotDate: date,
        accountId: holding.account_id,
        ticker: holding.ticker,
        name: holding.name,
        value: value,
        quantity: quantity,
        price: price
      });
    }

    // Bulk insert snapshots
    if (snapshots.length > 0) {
      await TickerSnapshot.bulkCreate(snapshots);
    }

    return {
      processed: holdings.length,
      succeeded,
      failed,
      created: snapshots.length
    };
  }

  static async createAccountSnapshots(date) {
    // Get all ticker snapshots for this date
    const tickerSnapshots = await TickerSnapshot.findByDate(date);

    // Group by account and sum values
    const accountTotals = {};
    for (const snapshot of tickerSnapshots) {
      if (!accountTotals[snapshot.account_id]) {
        accountTotals[snapshot.account_id] = 0;
      }
      accountTotals[snapshot.account_id] += parseFloat(snapshot.value);
    }

    // Prepare account snapshots
    const snapshots = [];
    for (const [accountId, totalValue] of Object.entries(accountTotals)) {
      snapshots.push({
        snapshotDate: date,
        accountId: parseInt(accountId),
        totalValue: totalValue
      });
    }

    // Bulk insert account snapshots
    if (snapshots.length > 0) {
      await AccountSnapshot.bulkCreate(snapshots);
    }

    return {
      accountsProcessed: snapshots.length,
      created: snapshots.length
    };
  }

  static async createDailySnapshots(date) {
    // Create ticker snapshots (upserts, safe to re-run)
    const tickerResult = await this.createTickerSnapshots(date);
    logger.info({ date, created: tickerResult.created, succeeded: tickerResult.succeeded, failed: tickerResult.failed }, 'Ticker snapshots created');

    // Create account snapshots
    const accountResult = await this.createAccountSnapshots(date);
    logger.info({ date, created: accountResult.created }, 'Account snapshots created');

    return {
      success: true,
      tickerSnapshots: tickerResult,
      accountSnapshots: accountResult
    };
  }
}

module.exports = SnapshotService;

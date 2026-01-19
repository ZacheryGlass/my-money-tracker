const pool = require('../config/database');
const Holding = require('../models/Holding');
const PriceCache = require('../models/PriceCache');
const TickerSnapshot = require('../models/TickerSnapshot');
const AccountSnapshot = require('../models/AccountSnapshot');

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

      if (holding.ticker && priceMap[holding.ticker.toUpperCase()]) {
        // Crypto/Securities with ticker: quantity × price
        value = parseFloat(holding.quantity || 0) * priceMap[holding.ticker.toUpperCase()];
        succeeded++;
      } else if (holding.manual_value !== null) {
        // Real Estate/Debt: use manual_value directly
        value = parseFloat(holding.manual_value);
        succeeded++;
      } else {
        // Missing price and no manual value, log warning and skip
        console.warn(`[snapshot] Warning: No price found for holding ${holding.id} (${holding.name}, ticker: ${holding.ticker})`);
        failed++;
        continue;
      }

      snapshots.push({
        snapshotDate: date,
        accountId: holding.account_id,
        ticker: holding.ticker,
        name: holding.name,
        value: value
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
    // Check if snapshots already exist for this date
    const tickerSnapshotsExist = await TickerSnapshot.existsForDate(date);
    if (tickerSnapshotsExist) {
      console.log(`[snapshot] Snapshots already exist for ${date}, skipping...`);
      return { skipped: true, reason: 'snapshots_already_exist' };
    }

    // Create ticker snapshots
    const tickerResult = await this.createTickerSnapshots(date);
    console.log(`[snapshot] Created ${tickerResult.created} ticker snapshots (${tickerResult.succeeded} succeeded, ${tickerResult.failed} failed)`);

    // Create account snapshots
    const accountResult = await this.createAccountSnapshots(date);
    console.log(`[snapshot] Created ${accountResult.created} account snapshots`);

    return {
      success: true,
      tickerSnapshots: tickerResult,
      accountSnapshots: accountResult
    };
  }
}

module.exports = SnapshotService;

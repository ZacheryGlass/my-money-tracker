const Holding = require('../models/Holding');
const PriceCache = require('../models/PriceCache');

const MINIMUM_VALUE_THRESHOLD = 100;
const LIABILITY_TYPES = new Set(['credit', 'loan']);

class DashboardService {
  static async getCurrentPortfolio() {
    // Fetch all holdings and prices
    const [holdings, prices] = await Promise.all([
      Holding.findAll(),
      PriceCache.getLatestPrices()
    ]);

    // Build price lookup map: { ticker: price_usd }
    const priceMap = {};
    let latestFetchedAt = null;

    for (const p of prices) {
      priceMap[p.ticker.toUpperCase()] = parseFloat(p.price_usd);
      if (!latestFetchedAt || new Date(p.fetched_at) > new Date(latestFetchedAt)) {
        latestFetchedAt = p.fetched_at;
      }
    }

    // Calculate value for each holding and build items
    const items = [];

    for (const holding of holdings) {
      let value = 0;

      const qty = parseFloat(holding.quantity || 0);
      if (holding.ticker && qty > 0 && priceMap[holding.ticker.toUpperCase()]) {
        value = qty * priceMap[holding.ticker.toUpperCase()];
      } else if (holding.manual_value !== null) {
        value = parseFloat(holding.manual_value);
      }

      // Filter holdings with value < $100
      if (Math.abs(value) < MINIMUM_VALUE_THRESHOLD) {
        continue;
      }

      const type = LIABILITY_TYPES.has(holding.account_type) ? 'liability' : 'asset';

      items.push({
        name: holding.name,
        ticker: holding.ticker || null,
        value: value,
        account: holding.account_name,
        account_id: holding.account_id,
        category: holding.category,
        type: type
      });
    }

    // Sort by absolute value descending
    items.sort((a, b) => Math.abs(b.value) - Math.abs(a.value));

    // Calculate portfolio total
    const total = items.reduce((sum, item) => sum + item.value, 0);

    return {
      items,
      total,
      lastUpdated: latestFetchedAt ? new Date(latestFetchedAt).toISOString() : null
    };
  }
}

module.exports = DashboardService;

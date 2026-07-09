const Holding = require('../models/Holding');
const PriceCache = require('../models/PriceCache');
const pool = require('../config/database');

const MINIMUM_VALUE_THRESHOLD = 100;
const LIABILITY_TYPES = new Set(['credit', 'loan']);
const SNAPSHOT_STALE_AFTER_DAYS = 2;
const PLAID_SYNC_STALE_AFTER_DAYS = 2;
const PRICE_STALE_AFTER_HOURS = 30;
const UNCATEGORIZED_LABEL = 'Uncategorized';

function toIsoString(value) {
  return value ? new Date(value).toISOString() : null;
}

function ageInDays(value) {
  if (!value) return null;
  const ageMs = Date.now() - new Date(value).getTime();
  return Math.max(0, Math.floor(ageMs / (1000 * 60 * 60 * 24)));
}

function ageInHours(value) {
  if (!value) return null;
  const ageMs = Date.now() - new Date(value).getTime();
  return Math.max(0, Math.round((ageMs / (1000 * 60 * 60)) * 10) / 10);
}

class DashboardService {
  static async getCurrentPortfolio() {
    // Fetch all holdings and prices
    const [holdings, prices] = await Promise.all([
      Holding.findAll({ includeHidden: false }),
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
      const category = typeof holding.category === 'string' && holding.category.trim()
        ? holding.category.trim()
        : UNCATEGORIZED_LABEL;

      items.push({
        name: holding.name,
        ticker: holding.ticker || null,
        value: value,
        account: holding.account_name,
        account_id: holding.account_id,
        account_source_name: holding.account_source_name,
        category,
        type: type
      });
    }

    // Sort by absolute value descending
    items.sort((a, b) => Math.abs(b.value) - Math.abs(a.value));

    // Calculate portfolio total
    const total = items.reduce((sum, item) => sum + item.value, 0);
    const totalAssets = items
      .filter((item) => item.type === 'asset')
      .reduce((sum, item) => sum + item.value, 0);
    const totalLiabilities = items
      .filter((item) => item.type === 'liability')
      .reduce((sum, item) => sum + Math.abs(item.value), 0);

    const freshness = await this.getFreshness(latestFetchedAt);

    return {
      items,
      total,
      summary: {
        totalAssets,
        totalLiabilities,
        netWorth: totalAssets - totalLiabilities
      },
      lastUpdated: latestFetchedAt ? new Date(latestFetchedAt).toISOString() : null,
      freshness
    };
  }

  static async getFreshness(latestPriceFetchedAt = null) {
    const [snapshotResult, plaidResult] = await Promise.all([
      pool.query('SELECT MAX(snapshot_date) AS latest_snapshot_date FROM account_snapshots'),
      pool.query(
        `SELECT id, institution_name, error_code, error_message, last_synced_at
         FROM plaid_items
         ORDER BY institution_name NULLS LAST, id`
      )
    ]);

    const latestSnapshotDate = snapshotResult.rows[0]?.latest_snapshot_date || null;
    const snapshotAgeDays = ageInDays(latestSnapshotDate);
    const priceAgeHours = ageInHours(latestPriceFetchedAt);

    const plaidItems = plaidResult.rows.map((item) => {
      const syncAgeDays = ageInDays(item.last_synced_at);
      const hasError = Boolean(item.error_code);
      const isStale = item.last_synced_at ? syncAgeDays > PLAID_SYNC_STALE_AFTER_DAYS : true;

      return {
        id: item.id,
        institutionName: item.institution_name || 'Linked institution',
        lastSyncedAt: toIsoString(item.last_synced_at),
        syncAgeDays,
        errorCode: item.error_code || null,
        errorMessage: item.error_message || null,
        hasError,
        isStale
      };
    });

    const erroredItems = plaidItems.filter((item) => item.hasError);
    const staleItems = plaidItems.filter((item) => item.isStale);

    return {
      status:
        snapshotAgeDays > SNAPSHOT_STALE_AFTER_DAYS ||
        priceAgeHours > PRICE_STALE_AFTER_HOURS ||
        erroredItems.length > 0 ||
        staleItems.length > 0
          ? 'warning'
          : 'ok',
      thresholds: {
        snapshotStaleAfterDays: SNAPSHOT_STALE_AFTER_DAYS,
        plaidSyncStaleAfterDays: PLAID_SYNC_STALE_AFTER_DAYS,
        priceStaleAfterHours: PRICE_STALE_AFTER_HOURS
      },
      snapshot: {
        latestDate: latestSnapshotDate ? new Date(latestSnapshotDate).toISOString().slice(0, 10) : null,
        ageDays: snapshotAgeDays,
        isStale: snapshotAgeDays !== null && snapshotAgeDays > SNAPSHOT_STALE_AFTER_DAYS
      },
      prices: {
        latestFetchedAt: toIsoString(latestPriceFetchedAt),
        ageHours: priceAgeHours,
        isStale: priceAgeHours !== null && priceAgeHours > PRICE_STALE_AFTER_HOURS
      },
      plaid: {
        totalItems: plaidItems.length,
        errorCount: erroredItems.length,
        staleCount: staleItems.length,
        attentionItems: plaidItems.filter((item) => item.hasError || item.isStale)
      }
    };
  }
}

module.exports = DashboardService;

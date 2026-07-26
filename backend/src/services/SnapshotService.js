'use strict';

const Holding = require('../models/Holding');
const PriceCache = require('../models/PriceCache');
const TickerSnapshot = require('../models/TickerSnapshot');
const AccountSnapshot = require('../models/AccountSnapshot');
const logger = require('../config/logger');

// TickerSnapshot.bulkCreate upserts on (snapshot_date, account_id, ticker) for
// tickered rows and (snapshot_date, account_id, name) for the rest. Two holdings
// in ONE account that share a conflict key therefore appear twice in a single
// INSERT ... ON CONFLICT DO UPDATE, and Postgres refuses that outright:
// "ON CONFLICT DO UPDATE command cannot affect row a second time" -- an error,
// not a dropped row, so the whole nightly snapshot job dies for every user.
//
// Multi-chain wallets make that routine: one crypto account now carries an ETH
// holding per chain, all with ticker 'ETH' so they all price off the single
// shared price_cache row. (It was already reachable by hand -- nothing stops a
// user entering the same ticker twice in one account.)
//
// So same-key rows are summed into one snapshot here. Account totals stay
// exact, which is what account_snapshots and net worth are built from;
// per-chain detail lives on holdings and eth_transfers, which is where the UI
// reads it from anyway. The surviving name comes from the LOWEST holding id so
// the series keeps one stable label -- holdings arrive ordered by updated_at,
// so picking "first seen" would let the name flap between chains day to day.
function collapseDuplicateKeys(snapshots) {
  const byKey = new Map();
  for (const snapshot of snapshots) {
    // Keyed on the RAW ticker, deliberately not an upper-cased one: the unique
    // index this exists to protect (migration 009, (snapshot_date, account_id,
    // ticker)) is case-sensitive, so 'aapl' and 'AAPL' are two rows Postgres is
    // perfectly happy to insert. Folding case here would merge two legitimately
    // separate series into one and lose the second's history -- a wider collapse
    // than the crash it prevents.
    const key = snapshot.ticker != null
      ? `t:${snapshot.accountId}:${snapshot.ticker}`
      : `n:${snapshot.accountId}:${snapshot.name}`;
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, { ...snapshot });
      continue;
    }
    existing.value += snapshot.value;
    // Quantities only add up when both sides have one. A tickered row with a
    // quantity merged with a manually valued row (no quantity, no unit price)
    // has no meaningful share count, and inventing one would make
    // quantity * price disagree with value.
    existing.quantity = existing.quantity != null && snapshot.quantity != null
      ? existing.quantity + snapshot.quantity
      : null;
    if (existing.quantity == null) existing.price = null;
    if (snapshot.holdingId != null && (existing.holdingId == null || snapshot.holdingId < existing.holdingId)) {
      existing.holdingId = snapshot.holdingId;
      existing.name = snapshot.name;
    }
  }
  return [...byKey.values()];
}

class SnapshotService {
  static async createTickerSnapshots(date) {
    // Fetch all holdings and prices
    const [holdings, prices] = await Promise.all([
      Holding.findAllForJobs(),
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
        price: price,
        // Not persisted; only used to pick a stable name when collapsing.
        holdingId: holding.id
      });
    }

    const collapsed = collapseDuplicateKeys(snapshots);

    // Bulk insert snapshots
    if (collapsed.length > 0) {
      await TickerSnapshot.bulkCreate(collapsed);
    }

    return {
      processed: holdings.length,
      succeeded,
      failed,
      created: collapsed.length
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
module.exports.collapseDuplicateKeys = collapseDuplicateKeys;

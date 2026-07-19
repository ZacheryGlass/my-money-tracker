'use strict';

const YahooFinance = require('yahoo-finance2').default;
const pool = require('../config/database');
const logger = require('../config/logger');

const yahooFinance = new YahooFinance({ suppressNotices: ['yahooSurvey'] });

const DEFAULT_SYMBOL = 'SPY';
// Benchmark symbols tracked for comparison: S&P 500 (SPY) and Nasdaq 100 (QQQ).
const SYMBOLS = ['SPY', 'QQQ'];
const MAX_BACKFILL_DAYS = 5 * 365;

class BenchmarkService {
  // Earliest date worth backfilling: far enough to cover the full account
  // snapshot history (capped at 5 years).
  static async getBackfillStartDate() {
    const cap = new Date();
    cap.setUTCDate(cap.getUTCDate() - MAX_BACKFILL_DAYS);
    const snapshot = await pool.query('SELECT MIN(snapshot_date) AS earliest FROM account_snapshots');
    const earliest = snapshot.rows[0]?.earliest ? new Date(snapshot.rows[0].earliest) : null;
    if (!earliest) return cap;
    earliest.setUTCDate(earliest.getUTCDate() - 7);
    return earliest > cap ? earliest : cap;
  }

  // Resume from the latest stored price date (inclusive, so a partial-day
  // price stored by an intraday manual trigger gets corrected by the next
  // run's upsert); on first run, backfill the full window.
  static async getFetchStartDate(symbol) {
    const latest = await pool.query(
      'SELECT MAX(price_date) AS latest FROM benchmark_prices WHERE UPPER(symbol) = UPPER($1)',
      [symbol]
    );
    if (latest.rows[0]?.latest) {
      return new Date(latest.rows[0].latest);
    }
    return this.getBackfillStartDate();
  }

  // fullRefresh re-fetches the entire window: Yahoo rescales historical
  // adjclose values on every dividend/split, so an incremental-only series
  // drifts; a periodic full pass (the job runs one weekly) re-bases all rows.
  static async updateBenchmarkPrices(symbol = DEFAULT_SYMBOL, { fullRefresh = false } = {}) {
    const period1 = fullRefresh
      ? await this.getBackfillStartDate()
      : await this.getFetchStartDate(symbol);
    const period2 = new Date();
    if (period1 >= period2) {
      return { symbol, fetched: 0, upserted: 0, message: 'Already up to date' };
    }

    const result = await yahooFinance.chart(symbol, { period1, period2, interval: '1d' });
    const quotes = (result?.quotes || []).filter((quote) => quote.date && (quote.adjclose ?? quote.close) != null);

    let upserted = 0;
    for (const quote of quotes) {
      const priceDate = quote.date.toISOString().slice(0, 10);
      await pool.query(
        `INSERT INTO benchmark_prices (symbol, price_date, adjusted_close, source, fetched_at)
         VALUES ($1, $2, $3, 'yahoo', CURRENT_TIMESTAMP)
         ON CONFLICT (symbol, price_date) DO UPDATE
         SET adjusted_close = EXCLUDED.adjusted_close, source = EXCLUDED.source, fetched_at = CURRENT_TIMESTAMP`,
        [symbol.toUpperCase(), priceDate, quote.adjclose ?? quote.close]
      );
      upserted++;
    }

    logger.info({ symbol, fetched: quotes.length, upserted }, 'Benchmark prices updated');
    return { symbol, fetched: quotes.length, upserted };
  }
}

BenchmarkService.DEFAULT_SYMBOL = DEFAULT_SYMBOL;
BenchmarkService.SYMBOLS = SYMBOLS;

module.exports = BenchmarkService;

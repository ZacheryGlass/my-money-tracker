'use strict';

const axios = require('axios');
const YahooFinance = require('yahoo-finance2').default;
const yahooFinance = new YahooFinance({ suppressNotices: ['yahooSurvey'] });
const PriceCache = require('../models/PriceCache');
const SecretsService = require('./SecretsService');
const logger = require('../config/logger');

let coinGeckoIdMapCache = null;
let coinGeckoIdMapCacheTime = 0;
const COINGECKO_CACHE_TTL = 6 * 60 * 60 * 1000; // 6 hours

class PriceService {
  // Get price from Coinbase (free, no auth needed)
  static async getCoinbasePrice(ticker) {
    try {
      const currencyPair = ticker.toUpperCase() + '-USD';
      const url = `https://api.coinbase.com/v2/prices/${currencyPair}/spot`;
      const response = await axios.get(url, { timeout: 5000 });

      if (response.status !== 200) {
        logger.warn({ ticker, status: response.status }, 'Coinbase fetch failed');
        return null;
      }

      const price = parseFloat(response.data.data.amount);
      logger.debug({ ticker, price, source: 'coinbase' }, 'Price fetched');
      return price;
    } catch (error) {
      logger.warn({ ticker, err: error }, 'Coinbase error');
      return null;
    }
  }

  // Helper to fetch from CoinGecko API
  static async fetchCoinGeckoJson(url) {
    try {
      const config = {
        method: 'get',
        timeout: 5000,
        headers: {
          accept: 'application/json'
        }
      };

      const apiKey = await SecretsService.getAppSetting('cg_api_key');
      if (apiKey) {
        config.headers['x-cg-api-key'] = apiKey;
      }

      const response = await axios(url, config);
      if (response.status !== 200) {
        logger.warn({ status: response.status }, 'CoinGecko non-200 response');
        throw new Error(`CoinGecko HTTP ${response.status}`);
      }
      return response.data;
    } catch (error) {
      logger.warn({ err: error }, 'CoinGecko fetch error');
      throw error;
    }
  }

  // Get price from CoinGecko
  static async getCoinGeckoPrice(ticker, idMap) {
    try {
      const coinId = idMap[ticker.toUpperCase()];
      if (!coinId) {
        logger.debug({ ticker }, 'CoinGecko: no ID mapping found');
        return null;
      }

      const url = `https://api.coingecko.com/api/v3/simple/price?ids=${encodeURIComponent(coinId)}&vs_currencies=usd`;
      const json = await this.fetchCoinGeckoJson(url);
      const price = Number(json[coinId] && json[coinId]['usd']);

      if (!isFinite(price)) {
        logger.warn({ ticker, coinId }, 'CoinGecko: missing price in response');
        return null;
      }

      logger.debug({ ticker, price, source: 'coingecko' }, 'Price fetched');
      return price;
    } catch (error) {
      logger.warn({ ticker, err: error }, 'CoinGecko error');
      return null;
    }
  }

  // Get price from CoinMarketCap
  static async getCoinMarketCapPrice(ticker) {
    try {
      const apiKey = await SecretsService.getAppSetting('cmc_api_key');
      if (!apiKey) {
        logger.warn('CoinMarketCap: API key missing');
        return null;
      }

      // Key goes in the header, not the query string, so it stays out of logged URLs.
      const url = `https://pro-api.coinmarketcap.com/v1/cryptocurrency/quotes/latest?symbol=${encodeURIComponent(ticker.toUpperCase())}`;
      const response = await axios.get(url, {
        timeout: 5000,
        headers: { 'X-CMC_PRO_API_KEY': apiKey, accept: 'application/json' }
      });
      const price = parseFloat(response.data['data'][ticker.toUpperCase()]['quote']['USD']['price']);

      logger.debug({ ticker, price, source: 'coinmarketcap' }, 'Price fetched');
      return price;
    } catch (error) {
      logger.warn({ ticker, err: error }, 'CoinMarketCap error');
      return null;
    }
  }

  // Returns a SYMBOL -> CoinGecko id map for the requested tickers.
  //
  // The cache holds the FULL symbol->id list, not the filtered result. Caching
  // the filtered map meant the first ticker to reach the CoinGecko fallback
  // (fetchPrice calls this with a single ticker) cached a map containing only
  // itself; for the next six hours every other ticker hit that cache, found no
  // id, and skipped CoinGecko entirely -- silently falling through to
  // CoinMarketCap. Symbols are not unique on CoinGecko; last match wins, as
  // before.
  static async buildCoinGeckoIdMap(tickersToFind) {
    const now = Date.now();

    if (!coinGeckoIdMapCache || (now - coinGeckoIdMapCacheTime) >= COINGECKO_CACHE_TTL) {
      try {
        logger.info('CoinGecko ID map cache empty or expired, fetching full coin list');
        const url = 'https://api.coingecko.com/api/v3/coins/list?include_platform=false';
        const fullCoinList = await this.fetchCoinGeckoJson(url);

        const symbolToId = {};
        for (const coin of fullCoinList) {
          const symbol = (coin.symbol || '').toUpperCase();
          if (symbol) symbolToId[symbol] = coin.id;
        }

        coinGeckoIdMapCache = symbolToId;
        coinGeckoIdMapCacheTime = now;
      } catch (error) {
        logger.error({ err: error }, 'Error building CoinGecko ID map');
        return {};
      }
    } else {
      logger.debug('Using cached CoinGecko ticker->ID map');
    }

    const requested = {};
    for (const ticker of tickersToFind) {
      const symbol = String(ticker || '').toUpperCase();
      if (coinGeckoIdMapCache[symbol]) requested[symbol] = coinGeckoIdMapCache[symbol];
    }
    return requested;
  }

  static async getYahooFinancePrice(ticker, isCrypto = false) {
    const symbol = isCrypto ? `${ticker.toUpperCase()}-USD` : ticker.toUpperCase();
    try {
      const result = await yahooFinance.quote(symbol);
      const price = result && result.regularMarketPrice;
      if (price == null || !isFinite(price)) {
        logger.warn({ ticker, symbol }, 'Yahoo Finance: no price in response');
        return null;
      }
      logger.debug({ ticker, symbol, price, source: 'yahoo' }, 'Price fetched');
      return price;
    } catch (error) {
      logger.warn({ ticker, symbol, err: error }, 'Yahoo Finance error');
      return null;
    }
  }

  static async fetchPrice(ticker, assetType) {
    logger.info({ ticker, assetType }, 'Fetching price');
    const isCrypto = assetType === 'Crypto' || assetType === 'Cash';

    // Yahoo Finance first -- works for both stocks and crypto (TICKER-USD)
    let price = await this.getYahooFinancePrice(ticker, isCrypto);
    if (price !== null) return { price, source: 'yahoo' };

    // Crypto fallbacks: Coinbase -> CoinGecko -> CMC
    if (isCrypto) {
      price = await this.getCoinbasePrice(ticker);
      if (price !== null) return { price, source: 'coinbase' };

      try {
        const idMap = await this.buildCoinGeckoIdMap([ticker]);
        if (idMap[ticker.toUpperCase()]) {
          price = await this.getCoinGeckoPrice(ticker, idMap);
          if (price !== null) return { price, source: 'coingecko' };
        }
      } catch (error) {
        logger.warn({ ticker, err: error }, 'CoinGecko fallback failed');
      }

      price = await this.getCoinMarketCapPrice(ticker);
      if (price !== null) return { price, source: 'coinmarketcap' };
    }

    // Last resort: try Yahoo without crypto suffix
    if (isCrypto) {
      price = await this.getYahooFinancePrice(ticker, false);
      if (price !== null) return { price, source: 'yahoo' };
    }

    logger.warn({ ticker }, 'All price providers failed');
    return null;
  }

  static async fetchPricesForTickers(tickers, assetTypeMap) {
    const results = [];

    for (const ticker of tickers) {
      const assetType = assetTypeMap ? assetTypeMap[ticker] : undefined;
      const result = await this.fetchPrice(ticker, assetType);

      if (result) {
        try {
          await PriceCache.upsert(ticker, result.price, result.source);
          results.push({
            ticker,
            price: result.price,
            source: result.source,
            success: true
          });
        } catch (error) {
          logger.error({ ticker, err: error }, 'Failed to cache price');
          results.push({
            ticker,
            success: false,
            error: error.message
          });
        }
      } else {
        results.push({
          ticker,
          success: false,
          error: 'All price providers failed'
        });
      }
    }

    return results;
  }
}

module.exports = PriceService;

const axios = require('axios');
const PriceCache = require('../models/PriceCache');

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
        console.log(`Coinbase: Failed ${ticker}. Status: ${response.status}`);
        return null;
      }

      const price = parseFloat(response.data.data.amount);
      console.log(`Coinbase: ${ticker} -> $${price}`);
      return price;
    } catch (error) {
      console.log(`Coinbase error ${ticker}: ${error.message}`);
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

      if (process.env.CG_API_KEY) {
        config.headers['x-cg-api-key'] = process.env.CG_API_KEY;
      }

      const response = await axios(url, config);
      if (response.status !== 200) {
        console.log(`CoinGecko HTTP ${response.status}: ${response.data.toString().slice(0, 300)}`);
        throw new Error(`CoinGecko HTTP ${response.status}`);
      }
      return response.data;
    } catch (error) {
      console.log(`CoinGecko fetch error: ${error.message}`);
      throw error;
    }
  }

  // Get price from CoinGecko
  static async getCoinGeckoPrice(ticker, idMap) {
    try {
      const coinId = idMap[ticker.toUpperCase()];
      if (!coinId) {
        console.log(`CoinGecko: No ID for "${ticker}".`);
        return null;
      }

      const url = `https://api.coingecko.com/api/v3/simple/price?ids=${encodeURIComponent(coinId)}&vs_currencies=usd`;
      const json = await this.fetchCoinGeckoJson(url);
      const price = Number(json[coinId] && json[coinId]['usd']);

      if (!isFinite(price)) {
        console.log(`CoinGecko: Missing price for ${ticker}`);
        return null;
      }

      console.log(`CoinGecko: ${ticker} -> $${price}`);
      return price;
    } catch (error) {
      console.log(`CoinGecko error ${ticker}: ${error.message}`);
      return null;
    }
  }

  // Get price from CoinMarketCap
  static async getCoinMarketCapPrice(ticker) {
    try {
      if (!process.env.CMC_PRO_API_KEY) {
        console.log('CoinMarketCap: API key missing.');
        return null;
      }

      const url = `https://pro-api.coinmarketcap.com/v1/cryptocurrency/quotes/latest?symbol=${ticker.toUpperCase()}&CMC_PRO_API_KEY=${process.env.CMC_PRO_API_KEY}`;
      const response = await axios.get(url, { timeout: 5000 });
      const price = parseFloat(response.data['data'][ticker.toUpperCase()]['quote']['USD']['price']);

      console.log(`CoinMarketCap: ${ticker} -> $${price}`);
      return price;
    } catch (error) {
      console.log(`CoinMarketCap error ${ticker}: ${error.message}`);
      return null;
    }
  }

  // Build CoinGecko ID mapping with caching
  static async buildCoinGeckoIdMap(tickersToFind) {
    const now = Date.now();

    // Return cached map if still valid
    if (coinGeckoIdMapCache && (now - coinGeckoIdMapCacheTime) < COINGECKO_CACHE_TTL) {
      console.log('Using cached filtered Ticker -> ID map.');
      return coinGeckoIdMapCache;
    }

    try {
      console.log('Cache empty or expired. Fetching list from CoinGecko.');
      const url = 'https://api.coingecko.com/api/v3/coins/list?include_platform=false';
      const fullCoinList = await this.fetchCoinGeckoJson(url);

      const filteredMap = {};
      const tickerSet = new Set(tickersToFind.map(t => t.toUpperCase()));

      for (let i = 0; i < fullCoinList.length; i++) {
        const coin = fullCoinList[i];
        const symbol = (coin.symbol || '').toUpperCase();
        if (tickerSet.has(symbol)) {
          filteredMap[symbol] = coin.id;
        }
      }

      // Cache the map
      coinGeckoIdMapCache = filteredMap;
      coinGeckoIdMapCacheTime = now;

      return filteredMap;
    } catch (error) {
      console.log(`Error building CoinGecko ID map: ${error.message}`);
      return {};
    }
  }

  // Main price fetching with waterfall strategy
  static async fetchPrice(ticker) {
    console.log(`--- Processing Ticker: ${ticker} ---`);

    // Try Coinbase first
    let price = await this.getCoinbasePrice(ticker);
    if (price !== null) {
      return { price, source: 'coinbase' };
    }

    // Try CoinGecko second
    try {
      const idMap = await this.buildCoinGeckoIdMap([ticker]);
      if (idMap[ticker.toUpperCase()]) {
        price = await this.getCoinGeckoPrice(ticker, idMap);
        if (price !== null) {
          return { price, source: 'coingecko' };
        }
      }
    } catch (error) {
      console.log(`CoinGecko fallback failed: ${error.message}`);
    }

    // Try CoinMarketCap third
    price = await this.getCoinMarketCapPrice(ticker);
    if (price !== null) {
      return { price, source: 'coinmarketcap' };
    }

    console.log(`All providers FAILED for ${ticker}.`);
    return null;
  }

  // Fetch prices for multiple tickers and cache them
  static async fetchPricesForTickers(tickers) {
    const results = [];

    for (const ticker of tickers) {
      const result = await this.fetchPrice(ticker);

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
          console.error(`Failed to cache price for ${ticker}:`, error.message);
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

'use strict';

const STABLECOIN_SET = new Set([
  'USD', 'USDC', 'USDT', 'DAI', 'XDAI', 'TUSD', 'FDUSD', 'BUSD'
]);

// Wallet holdings are inserted with no category, so a native asset that is
// missing here classifies as a STOCK: the price lookup then asks Yahoo for a
// bare equity symbol and skips every crypto fallback. Every chain's
// nativeAsset in config/chains.js must appear in this set.
const CRYPTO_SET = new Set([
  'BTC', 'ETH', 'SOL', 'XMR', 'ALGO', 'DOT', 'ADA', 'ICP', 'EOS',
  'MATIC', 'POL', 'LRC', 'DASH', 'MIOTA', 'XNO', 'BCH', 'LTC', 'NANO',
  'LINK', 'TON', 'DOGE', 'PEPE'
]);

const COMMODITY_SET = new Set([
  'BAR', 'SIVR', 'GLD', 'IAU', 'SLV', 'PPLT', 'PALL', 'SGOL'
]);

function classifyTicker(ticker, category) {
  if (!ticker) return 'Manual';

  const t = ticker.toUpperCase();

  if (category === 'Crypto') return 'Crypto';
  if (STABLECOIN_SET.has(t)) return 'Cash';
  if (CRYPTO_SET.has(t)) return 'Crypto';
  if (COMMODITY_SET.has(t)) return 'Commodity';
  return 'Stock';
}

module.exports = { classifyTicker };

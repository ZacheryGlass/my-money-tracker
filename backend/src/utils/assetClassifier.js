'use strict';

const STABLECOIN_SET = new Set([
  'USD', 'USDC', 'USDT', 'DAI', 'TUSD', 'FDUSD', 'BUSD'
]);

const CRYPTO_SET = new Set([
  'BTC', 'ETH', 'SOL', 'XMR', 'ALGO', 'DOT', 'ADA', 'ICP', 'EOS',
  'MATIC', 'LRC', 'DASH', 'MIOTA', 'XNO', 'BCH', 'LTC', 'NANO',
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

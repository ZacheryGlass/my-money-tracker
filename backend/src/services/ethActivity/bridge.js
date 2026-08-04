'use strict';

// Bridge activity shaping only. Cross-chain identity lives in
// services/bridge/adapters.js and services/bridge/matcher.js. In particular,
// this file contains no pair selection, percentage tolerance, or greedy claim
// logic: amounts and time may create review suggestions but never folds.

const { formatUnits } = require('../../utils/units');
const { NFT_STANDARDS } = require('../../utils/ethActivityVocabulary');

const BRIDGE_DEPOSIT_WINDOW_MS = 24 * 60 * 60 * 1000;
const BRIDGE_WITHDRAWAL_WINDOW_MS = 8 * 24 * 60 * 60 * 1000;

function scaleAmount(text) {
  const raw = String(text ?? '').trim();
  if (!/^\d+(\.\d+)?$/.test(raw)) return null;
  const [whole, frac = ''] = raw.split('.');
  return BigInt(whole) * 10n ** 18n + BigInt(`${frac}${'0'.repeat(18)}`.slice(0, 18));
}

// Display-level aliases used only while generating suggestions. They do not
// prove contract asset identity and never reach protocol matching.
function bridgeAsset(symbol) {
  const upper = String(symbol ?? '').trim().toUpperCase();
  const base = upper.replace(/\.E$/, '');
  if (!base) return null;
  if (base === 'WETH') return 'ETH';
  if (base === 'MATIC') return 'POL';
  if (base === 'DAI' || base === 'USDS') return 'XDAI';
  return base;
}

function bridgeMovement(row, direction) {
  const legs = Array.isArray(row.legs) ? row.legs : [];
  if (!legs.length) return null;
  const byAsset = new Map();
  for (const leg of legs) {
    if (leg.direction !== direction || NFT_STANDARDS.has(leg.token_standard)
        || leg.symbol_known === false) return null;
    const asset = bridgeAsset(leg.asset);
    const amount = scaleAmount(leg.amount);
    if (!asset || amount === null || amount === 0n) return null;
    const current = byAsset.get(asset) || { asset, amount: 0n };
    current.amount += amount;
    byAsset.set(asset, current);
  }
  const time = new Date(row.block_time).getTime();
  if (!Number.isFinite(time)) return null;
  const assets = [...byAsset.values()]
    .sort((a, b) => a.asset.localeCompare(b.asset))
    .map((entry) => ({
      asset: entry.asset,
      amount: entry.amount,
      rawAmount: formatUnits(entry.amount, 18),
    }));
  return {
    asset: assets[0].asset,
    amount: assets[0].amount,
    rawAmount: assets[0].rawAmount,
    assets,
    time,
  };
}

module.exports = {
  BRIDGE_DEPOSIT_WINDOW_MS,
  BRIDGE_WITHDRAWAL_WINDOW_MS,
  bridgeAsset,
  bridgeMovement,
};

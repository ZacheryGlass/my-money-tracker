'use strict';

// --- bridge matching -------------------------------------------------------
//
// A bridge deposit is ONE movement of the user's own money that the chains
// record as two unrelated transactions: an outflow on chain A and an inflow on
// chain B, with different hashes, different block numbers (per-chain sequences,
// 039) and -- for a third-party fast bridge -- a different counterparty address
// on each side, because the relayer who fills you on the destination is not the
// contract you deposited into. So matching is amount-and-time based, never
// address based.
//
// Every bound below fails in the SAFE direction. A leg we decline to pair stays
// `needs_review` and visible; a leg paired WRONGLY silently fuses two unrelated
// transfers into one "self-transfer" and deletes a real send from the ledger.

const { DEFAULT_CHAIN_ID } = require('../../config/chains');
const { formatUnits } = require('../../utils/units');
const { NFT_STANDARDS } = require('../../utils/ethActivityVocabulary');

// Canonical bridges take no cut of the asset (you get exactly what you sent, and
// pay in gas); fast bridges price relayer capital in, typically well under 1%.
// 2% is generous enough to cover those and tight enough that two unrelated
// round-number transfers do not pair.
const BRIDGE_MAX_FEE_BPS = 200n;

// L1 -> L2 lands in minutes on every rollup here; L2 -> L1 waits out the
// optimistic challenge period (7 days on Arbitrum/OP-stack). The window is
// chosen by the chain the money LEFT, which is the only thing that decides
// which of the two it is.
const BRIDGE_DEPOSIT_WINDOW_MS = 24 * 60 * 60 * 1000;
const BRIDGE_WITHDRAWAL_WINDOW_MS = 8 * 24 * 60 * 60 * 1000;

// A whole-unit decimal string ("0.25") -> base units at a fixed 18-decimal
// scale, so two chains that spell the same token with different decimals still
// compare. Digits past the 18th are dropped on BOTH sides identically and are
// ~17 orders of magnitude below the fee tolerance. Returns null for anything
// that is not a plain non-negative decimal -- a leg we cannot read is a leg we
// do not pair.
function scaleAmount(text) {
  const raw = String(text ?? '').trim();
  if (!/^\d+(\.\d+)?$/.test(raw)) return null;
  const [whole, frac = ''] = raw.split('.');
  return BigInt(whole) * 10n ** 18n + BigInt(`${frac}${'0'.repeat(18)}`.slice(0, 18));
}

// Two spellings of one asset, both 1:1 by construction:
//   WETH  -- wrapped ETH; bridges deliver either side of the wrapper freely.
//   MATIC -- renamed POL in Sept 2024, 1:1; pre-rename L1 legs carry MATIC.
//   DAI   -- the Ethereum-side token that the Gnosis bridge represents as its
//            native xDAI balance on the destination chain.
//   FOO.e -- the bridged-representation suffix (Arbitrum's USDC.e), which is
//            what the canonical bridge MINTS for FOO, so refusing to match it
//            would leave every canonical ERC-20 deposit unpaired.
// Deliberately short. Every entry here is an assertion that two symbols are the
// same money, and a wrong one pairs two different assets.
//
// ORDER MATTERS, and it is the suffix first. The two rules COMPOSE -- a bridged
// wrapped ether is spelled `WETH.e` -- so testing WETH before stripping the
// suffix leaves `WETH.e` in a bucket of its own that pairs with neither ETH nor
// WETH, and the deposit it belongs to stays unmatched forever.
function bridgeAsset(symbol) {
  const upper = String(symbol ?? '').trim().toUpperCase();
  const base = upper.replace(/\.E$/, '');
  if (!base) return null;
  if (base === 'WETH') return 'ETH';
  // MATIC -> POL: the Sept-2024 1:1 rename. nativeSymbol(137) says POL
  // unconditionally, while the L1 half of a pre-rename Plasma deposit carries
  // the old MATIC token symbol -- without this map every historical Polygon
  // deposit pairs with nothing and both halves stay flagged forever.
  if (base === 'MATIC') return 'POL';
  // DAI/USDS -> XDAI: the canonical Gnosis bridge historically locked DAI and
  // now accepts USDS on Ethereum, minting the same native xDAI on Gnosis.
  // They must share one matching key or either generation stays unpaired.
  if (base === 'DAI' || base === 'USDS') return 'XDAI';
  return base;
}

// One bridge activity row -> the fungible movement bundle it represents, or
// null if it is not a shape we will pair. A canonical bridge can carry more
// than one fungible asset in a single transaction (for example POL and USDC
// in one Polygon bundle). We only accept a bundle when every net leg has the
// same direction, a readable symbol and a non-zero amount; NFTs, mixed
// directions and unreadable tokens remain reviewable rather than guessed.
function bridgeMovement(row, direction) {
  const legs = Array.isArray(row.legs) ? row.legs : [];
  if (!legs.length) return null;
  const byAsset = new Map();
  for (const leg of legs) {
    if (leg.direction !== direction || NFT_STANDARDS.has(leg.token_standard)) return null;
    // A leg we cannot read is a leg we do not pair. `asset` is a display string
    // and 'TOKEN' is what an ERC-20 whose symbol the feed never supplied renders
    // as -- so two DIFFERENT unnamed tokens would compare equal here and fuse
    // into one movement, which is precisely the wrong-pairing failure this
    // whole section is bounded against.
    if (leg.symbol_known === false) return null;
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
      // A bridge link stores the normalized whole-unit amount. The legacy
      // primary columns below retain the first asset for old readers; bundle
      // readers use `assets` instead.
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

function movementAssets(movement) {
  return Array.isArray(movement.assets) && movement.assets.length
    ? movement.assets
    : [{ asset: movement.asset, amount: movement.amount, rawAmount: movement.rawAmount }];
}

function bundleMatches(out, candidate) {
  const outs = movementAssets(out);
  const ins = movementAssets(candidate);
  if (outs.length !== ins.length) return false;
  const inByAsset = new Map(ins.map((entry) => [entry.asset, entry]));
  return outs.every((entry) => {
    const incoming = inByAsset.get(entry.asset);
    if (!incoming || incoming.amount > entry.amount) return false;
    return (entry.amount - incoming.amount) * 10000n <= entry.amount * BRIDGE_MAX_FEE_BPS;
  });
}

// Pure so the whole pairing policy is testable without a database. `outs` and
// `ins` must already be time-ordered; the greedy first-fit that follows is what
// makes the result deterministic -- with two identical bridges in flight, the
// earlier out claims the earlier in.
function pairBridgeLegs(outs, ins) {
  const claimed = new Set();
  const links = [];
  for (const out of outs) {
    const match = ins.find((candidate) => {
      if (claimed.has(candidate.id)) return false;
      // Cross-chain by definition. Same-chain would pair a send with an
      // unrelated receive on the same chain, which is not a bridge at all.
      if (candidate.chain_id === out.chain_id) return false;
      // Money cannot arrive before it left.
      if (candidate.time < out.time) return false;
      const window = out.chain_id === DEFAULT_CHAIN_ID
        ? BRIDGE_DEPOSIT_WINDOW_MS
        : BRIDGE_WITHDRAWAL_WINDOW_MS;
      if (candidate.time - out.time > window) return false;
      // The fee comes out of each asset's amount, so the far side is never
      // larger for any asset in the bundle.
      return bundleMatches(out, candidate);
    });
    if (!match) continue;
    claimed.add(match.id);
    const link = {
      out_activity_id: out.id,
      in_activity_id: match.id,
      asset: out.asset,
      out_amount: out.rawAmount,
      in_amount: match.rawAmount,
      // The delta IS the bridge fee, in units of the asset. Computed from the
      // scaled integers rather than the display strings so it never inherits a
      // float's rounding.
      fee_amount: formatUnits(out.amount - match.amount, 18),
    };
    // Keep the established scalar columns for compatibility. Multi-asset
    // bridges additionally carry the complete per-asset accounting so a
    // two-asset bundle is not reduced to whichever asset sorted first.
    if (movementAssets(out).length > 1) {
      const incomingByAsset = new Map(movementAssets(match).map((entry) => [entry.asset, entry]));
      link.asset_details = movementAssets(out).map((entry) => {
        const incoming = incomingByAsset.get(entry.asset);
        return {
          asset: entry.asset,
          out_amount: entry.rawAmount,
          in_amount: incoming.rawAmount,
          fee_amount: formatUnits(entry.amount - incoming.amount, 18),
        };
      });
    }
    links.push(link);
  }
  return links;
}

// scaleAmount stays module-private: bridgeMovement is its only caller.
module.exports = {
  BRIDGE_MAX_FEE_BPS,
  BRIDGE_DEPOSIT_WINDOW_MS,
  BRIDGE_WITHDRAWAL_WINDOW_MS,
  bridgeAsset,
  bridgeMovement,
  pairBridgeLegs,
};

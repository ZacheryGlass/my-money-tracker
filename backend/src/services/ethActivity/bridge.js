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
  return base === 'WETH' ? 'ETH' : base;
}

// One bridge activity row -> the single fungible movement it represents, or
// null if it is not a shape we will pair. Exactly one net leg is required: a
// transaction that also moved a second asset (or an NFT) is not a plain value
// bridge, and guessing which leg crossed the chain is the kind of guess that
// writes a wrong number into someone's ledger.
function bridgeMovement(row, direction) {
  const legs = Array.isArray(row.legs) ? row.legs : [];
  if (legs.length !== 1) return null;
  const [leg] = legs;
  if (leg.direction !== direction) return null;
  if (NFT_STANDARDS.has(leg.token_standard)) return null;
  // A leg we cannot read is a leg we do not pair. `asset` is a display string
  // and 'TOKEN' is what an ERC-20 whose symbol the feed never supplied renders
  // as -- so two DIFFERENT unnamed tokens would compare equal here and fuse
  // into one "movement", which is precisely the wrong-pairing failure this
  // whole section is bounded against.
  if (leg.symbol_known === false) return null;
  const asset = bridgeAsset(leg.asset);
  const amount = scaleAmount(leg.amount);
  if (!asset || amount === null || amount === 0n) return null;
  const time = new Date(row.block_time).getTime();
  if (!Number.isFinite(time)) return null;
  return { asset, amount, time };
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
      if (candidate.asset !== out.asset) return false;
      // Money cannot arrive before it left.
      if (candidate.time < out.time) return false;
      const window = out.chain_id === DEFAULT_CHAIN_ID
        ? BRIDGE_DEPOSIT_WINDOW_MS
        : BRIDGE_WITHDRAWAL_WINDOW_MS;
      if (candidate.time - out.time > window) return false;
      // The fee comes out of the amount, so the far side is never larger.
      if (candidate.amount > out.amount) return false;
      return (out.amount - candidate.amount) * 10000n <= out.amount * BRIDGE_MAX_FEE_BPS;
    });
    if (!match) continue;
    claimed.add(match.id);
    links.push({
      out_activity_id: out.id,
      in_activity_id: match.id,
      asset: out.asset,
      out_amount: out.rawAmount,
      in_amount: match.rawAmount,
      // The delta IS the bridge fee, in units of the asset. Computed from the
      // scaled integers rather than the display strings so it never inherits a
      // float's rounding.
      fee_amount: formatUnits(out.amount - match.amount, 18),
    });
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

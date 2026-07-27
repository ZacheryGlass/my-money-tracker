'use strict';

// Pure leg/asset primitives shared by the classification ladder, the spam
// quarantine and the row builder (all in this directory). No database, no
// logger -- everything here is a function of the transfer rows it is handed,
// which is what keeps the whole policy surface unit-testable.

const { DEFAULT_CHAIN_ID, nativeSymbol } = require('../../config/chains');
const { NFT_TRANSFER_TYPES, USD_BASIS_RANK } = require('../../utils/ethActivityVocabulary');

function weakestBasis(a, b) {
  if (!a) return b;
  if (!b) return a;
  return (USD_BASIS_RANK[a] ?? 2) >= (USD_BASIS_RANK[b] ?? 2) ? a : b;
}

// USD is accumulated in INTEGER CENTS, never in dollars.
// eth_transfers.usd_at_time is NUMERIC(20,2) and arrives as a string; summing
// the parsed dollars would drift by fractions of a cent across a swap's legs
// and land a $3,000.00 trade at $2,999.99. Exact NUMERIC in SQL, exact cents
// in JS -- floats value nothing here.
function toCents(value) {
  if (value == null) return null;
  const number = Number(value);
  return Number.isFinite(number) ? Math.round(number * 100) : null;
}

function fromCents(cents) {
  return cents == null ? null : Number((cents / 100).toFixed(2));
}

// Branch on transfer_type FIRST. value_wei on an NFT leg is a count of units
// (033), not wei and not a scaled token amount, so scaling it by 18 -- or by
// anything -- would render a 1-of-1 as 0.000000000000000001. token_decimals is
// written 0 on those rows, but this never relies on that.
//
// THE DECIMALS-REPAIR RULE, shared verbatim with the valuation SQL
// (AssetPriceHistory quantitySql): the leg's OWN token_decimals, else the
// MINIMUM non-NULL value seen for that (chain, contract) across the wallet,
// else 18 -- clamped to [0, 78] so a malformed feed value cannot turn
// 10^decimals into an aborting exponent. Etherscan omits tokenDecimal on some
// legs of a contract it fills in on others, so a repair is needed; it just has
// to be the SAME repair on both sides. When it was not, one row could show a
// netted `amount` scaled by 6 next to a `usd_value` scaled by 18 -- two numbers
// about the same transfer that cannot both be true.
function legDecimals(transfer, fallback = 18) {
  if (NFT_TRANSFER_TYPES.has(transfer.transfer_type)) return 0;
  if (transfer.transfer_type === 'token') {
    const raw = transfer.token_decimals != null ? Number(transfer.token_decimals) : fallback;
    const decimals = Number.isFinite(raw) ? raw : 18;
    return Math.max(0, Math.min(decimals, 78));
  }
  return 18;
}

// The wallet-wide half of that rule: MIN(token_decimals) per (chain, contract)
// over every leg, matching the SQL window function exactly. Built across ALL of
// a wallet's transfers, not per transaction -- the SQL partition spans the
// wallet, so a per-tx map would disagree the moment the only leg naming its
// decimals sat in a different transaction.
function tokenDecimalsFallbacks(transfers) {
  const byToken = new Map();
  for (const transfer of transfers) {
    if (transfer.transfer_type !== 'token' || !transfer.token_contract) continue;
    if (transfer.token_decimals == null) continue;
    const value = Number(transfer.token_decimals);
    if (!Number.isFinite(value)) continue;
    const key = `${transfer.chain_id ?? DEFAULT_CHAIN_ID}:${transfer.token_contract}`;
    const seen = byToken.get(key);
    if (seen == null || value < seen) byToken.set(key, value);
  }
  return byToken;
}

// Did the feed actually give this leg a symbol, or is the display string about
// to be a placeholder? Whitespace counts as absent: ' ' is not a symbol.
function hasSymbol(transfer) {
  return typeof transfer.token_symbol === 'string' && transfer.token_symbol.trim() !== '';
}

// The netting key. An NFT nets per (contract, token_id): two different ids from
// one collection are two different things and must never cancel out.
function assetOf(transfer, decimalsFallbacks = new Map()) {
  if (NFT_TRANSFER_TYPES.has(transfer.transfer_type)) {
    return {
      key: `nft:${transfer.token_contract}:${transfer.token_id}`,
      asset: transfer.token_symbol || 'NFT',
      contract: transfer.token_contract || null,
      token_id: transfer.token_id != null ? String(transfer.token_id) : null,
      token_standard: transfer.token_standard
        || (transfer.transfer_type === 'nft' ? 'erc721' : 'erc1155'),
      decimals: 0,
      symbol_known: hasSymbol(transfer),
    };
  }
  if (transfer.transfer_type === 'token') {
    return {
      key: `erc20:${transfer.token_contract}`,
      asset: transfer.token_symbol || 'TOKEN',
      contract: transfer.token_contract || null,
      token_id: null,
      token_standard: transfer.token_standard || 'erc20',
      // The feed omits tokenDecimal on some legs; the wallet-wide MIN for this
      // (chain, contract) fills the gap, which is the same repair the valuation
      // SQL makes. One leg missing its decimals can no longer pin the netted
      // amount to a scale the dollar figure disagrees with.
      decimals: legDecimals(
        transfer,
        decimalsFallbacks.get(`${transfer.chain_id ?? DEFAULT_CHAIN_ID}:${transfer.token_contract}`) ?? 18
      ),
      // `asset` above is a DISPLAY string, and 'TOKEN' is a placeholder, not a
      // symbol -- two different unnamed ERC-20s both render as 'TOKEN'. Anything
      // that compares assets for IDENTITY (bridge pairing) must know the
      // difference, so the leg says whether its symbol was ever read. The
      // netting loop upgrades to the first NON-EMPTY symbol seen for the same
      // contract, so one named leg makes the whole netted asset readable.
      symbol_known: hasSymbol(transfer),
    };
  }
  // native + internal are both the chain's native asset, and netting them
  // together is the point: a contract that refunds part of what you sent is one
  // net outflow. The symbol comes from the registry, so a POL leg on Polygon
  // never nets against -- or renders as -- ether.
  const symbol = nativeSymbol(transfer.chain_id ?? DEFAULT_CHAIN_ID);
  return {
    key: symbol, asset: symbol, contract: null, token_id: null, token_standard: null,
    decimals: 18, symbol_known: true,
  };
}

function counterpartyAddress(wallet, leg) {
  return leg.from_address === wallet ? leg.to_address : leg.from_address;
}

// Who the transaction was with. Exchange first (that verdict is the one with
// financial consequences), then a single unambiguous counterparty, then the
// contract the wallet called -- which is the gas leg's destination, and the
// only meaningful "who" for a router swap that touched six pool addresses.
function resolveCounterparty(wallet, valueLegs, gasLegs) {
  const exchangeLeg = valueLegs.find((leg) => !leg.counterparty_is_own && leg.counterparty_exchange);
  if (exchangeLeg) {
    return { address: counterpartyAddress(wallet, exchangeLeg), name: exchangeLeg.counterparty_exchange };
  }
  const addresses = new Set(
    valueLegs
      .filter((leg) => !leg.counterparty_is_own)
      .map((leg) => counterpartyAddress(wallet, leg))
      .filter(Boolean)
  );
  if (addresses.size === 1) return { address: [...addresses][0], name: null };
  const gasTo = gasLegs.find((leg) => leg.to_address)?.to_address || null;
  if (gasTo) return { address: gasTo, name: null };
  // A self-transfer's only counterparties are own addresses, filtered out
  // above; fall back to the first of them rather than reporting none.
  const ownAddress = valueLegs.map((leg) => counterpartyAddress(wallet, leg)).find(Boolean);
  return { address: ownAddress || null, name: null };
}

// legDecimals and hasSymbol stay module-private: assetOf is their only caller.
module.exports = {
  weakestBasis,
  toCents,
  fromCents,
  tokenDecimalsFallbacks,
  assetOf,
  counterpartyAddress,
  resolveCounterparty,
};

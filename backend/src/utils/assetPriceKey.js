'use strict';

// How an asset is named in asset_price_history (043).
//
// NOT a ticker. Symbols collide constantly on chain -- anyone can deploy a
// contract calling itself USDC -- and the same contract ADDRESS is a different
// asset on every chain it exists on (039: USDC on Base and USDC on Arbitrum are
// separate positions at separate addresses, and even an identical address from
// a deterministic deployment is a separate asset with its own CoinGecko asset
// platform). So a token's identity here is its (chain, contract) pair.
//
// Two forms, and only two:
//   '<SYMBOL>'                  -- a native asset, keyed by its SYMBOL and not
//                                  by chain: 'ETH' covers mainnet, Arbitrum and
//                                  Linea alike (one asset, one series), 'POL'
//                                  covers Polygon. Keying natives per chain
//                                  would fetch and store the same ETH series
//                                  once per chain; keying them all 'ETH' would
//                                  price POL as ether.
//   'erc20:<chain_id>:<0xaddr>' -- an ERC-20, lowercased.
//
// NFTs get no key at all. Their valuation is out of scope (#73) and their
// value_wei is a COUNT OF UNITS (033), so a key would invite exactly the
// units-as-wei confusion the rest of the codebase works to prevent.

const { DEFAULT_CHAIN_ID, nativeSymbol, isNativeSymbol } = require('../config/chains');

// The native key on a chain that is ETH-native, and the historical spelling of
// every native row written before Polygon. Kept as a named export because it is
// still the right default for a caller with no chain in hand.
const NATIVE_ASSET_KEY = 'ETH';

// Types that carry no fungible value to price: an NFT leg (count of units, out
// of scope) and nothing else -- gas, native and internal legs all carry the
// chain's native asset.
const UNPRICEABLE_TRANSFER_TYPES = new Set(['nft', 'nft1155']);

function tokenAssetKey(chainId, contract) {
  if (!contract) return null;
  return `erc20:${Number(chainId ?? DEFAULT_CHAIN_ID)}:${String(contract).toLowerCase()}`;
}

// The key for one eth_transfers row, or null when the row has no priceable
// asset. A token row with no contract is malformed rather than native -- the
// feed always carries one -- so it gets null rather than being priced as ETH.
function assetKeyForTransfer(transfer) {
  if (!transfer) return null;
  if (UNPRICEABLE_TRANSFER_TYPES.has(transfer.transfer_type)) return null;
  if (transfer.transfer_type === 'token') {
    return tokenAssetKey(transfer.chain_id ?? DEFAULT_CHAIN_ID, transfer.token_contract);
  }
  return nativeSymbol(transfer.chain_id ?? DEFAULT_CHAIN_ID);
}

// Inverse of the two builders, for the price job: it reads asset keys out of
// the ledger and has to turn each back into a provider request. Returns null
// for anything that is not one of the two forms, so a key written by a future
// migration cannot be silently mistaken for a mainnet contract.
//
// `chainId` stays null on the native branch: the symbol IS the asset, and the
// chain it happened to move on says nothing about how to price it.
function parseAssetKey(assetKey) {
  if (isNativeSymbol(assetKey)) {
    return { kind: 'native', symbol: String(assetKey).toUpperCase(), chainId: null, contract: null };
  }
  const match = /^erc20:(\d+):(0x[0-9a-f]{40})$/.exec(String(assetKey || ''));
  if (!match) return null;
  return { kind: 'erc20', chainId: Number(match[1]), contract: match[2] };
}

module.exports = {
  NATIVE_ASSET_KEY,
  UNPRICEABLE_TRANSFER_TYPES,
  tokenAssetKey,
  assetKeyForTransfer,
  parseAssetKey,
};

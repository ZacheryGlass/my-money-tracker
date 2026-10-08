// Network facts for rendering, read from the crypto meta store (the backend's
// network registry, GET /api/crypto/meta). Nothing here lists networks: adding
// a network on the server is all a new chain needs.
import { networkById } from '../features/crypto/meta';

// Mainnet. Rows ingested before multi-chain sync carry a NULL chain_id, and
// every one of them is mainnet's -- so a missing id resolves here rather than
// produce a dead link.
export const DEFAULT_CHAIN_ID = 1;

const networkFor = (chainId) => networkById(
  chainId === null || chainId === undefined || chainId === '' ? DEFAULT_CHAIN_ID : chainId
);

// The native asset's symbol for a chain, for rows the API sends as raw amounts
// (a transfer leg's value, a wallet's balance drift). Rows that already carry a
// symbol from the server should render THAT rather than call this. An unknown
// network reads as ETH, the native asset of every chain this app ever retired.
export function nativeSymbol(chainId) {
  return networkFor(chainId)?.nativeAsset || 'ETH';
}

// A network as a person names it ("Arbitrum One"), never "chain 42161". An
// unknown id still says what it is rather than rendering blank.
export function networkName(chainId) {
  const network = networkFor(chainId);
  return network?.name || `Network ${chainId}`;
}

// An unknown network has no explorer: callers render the hash or address
// without a link rather than send the user to the wrong chain's explorer.
export function explorerBase(chainId) {
  return networkFor(chainId)?.explorer?.baseUrl || null;
}

function explorerLink(chainId, pathKey, placeholder, value) {
  const explorer = networkFor(chainId)?.explorer;
  if (!explorer?.baseUrl || !explorer[pathKey]) return null;
  return `${explorer.baseUrl}${explorer[pathKey].replace(placeholder, value)}`;
}

export function explorerTxUrl(txHash, chainId) {
  return explorerLink(chainId, 'txPath', '{hash}', txHash);
}

// Addresses are chain-agnostic (the same EOA exists on every chain), so a
// caller with no chain context can pass nothing and get mainnet's explorer.
export function explorerAddressUrl(address, chainId) {
  return explorerLink(chainId, 'addressPath', '{address}', address);
}

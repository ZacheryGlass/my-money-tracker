// Block-explorer links per chain. Mirrors the chain set in
// backend/src/config/chains.js -- keep the two in step when a chain is added.
//
// This lives on the client rather than riding along on every API row: a tx or
// address link is pure presentation derived from an id the API already sends
// (eth_transfers.chain_id, transactions.chain_id), so shipping a URL per row
// would just repeat a constant thousands of times.
const EXPLORERS = {
  1: 'https://etherscan.io',
  10: 'https://optimistic.etherscan.io',
  8453: 'https://basescan.org',
  42161: 'https://arbiscan.io',
  59144: 'https://lineascan.build',
};

// Mainnet. Rows ingested before multi-chain sync carry a NULL chain_id, and
// every one of them is mainnet's -- so an unknown or missing id must resolve
// here rather than produce a dead link.
export const DEFAULT_CHAIN_ID = 1;

export function explorerBase(chainId) {
  return EXPLORERS[Number(chainId)] || EXPLORERS[DEFAULT_CHAIN_ID];
}

export function explorerTxUrl(txHash, chainId) {
  return `${explorerBase(chainId)}/tx/${txHash}`;
}

// Addresses are chain-agnostic (the same EOA exists on every chain), so a
// caller with no chain context can pass nothing and get Etherscan.
export function explorerAddressUrl(address, chainId) {
  return `${explorerBase(chainId)}/address/${address}`;
}

// Block-explorer links per chain. Mirrors the chain set in
// backend/src/config/chains.js -- keep the two in step when a chain is added.
//
// This lives on the client rather than riding along on every API row: a tx or
// address link is pure presentation derived from an id the API already sends
// (eth_transfers.chain_id, transactions.chain_id), so shipping a URL per row
// would just repeat a constant thousands of times.
const EXPLORERS = {
  1: 'https://etherscan.io',
  10: 'https://explorer.optimism.io',
  100: 'https://gnosis.blockscout.com',
  137: 'https://polygonscan.com',
  8453: 'https://base.blockscout.com',
  42161: 'https://arbiscan.io',
  59144: 'https://lineascan.build',
};

// Chains whose gas and native balance are NOT ether. Only the exceptions are
// listed: every other chain here is ETH-native, and defaulting keeps a row with
// a NULL or unknown chain_id reading as ETH -- which is what every such row is.
const NATIVE_ASSETS = {
  100: 'XDAI',
  137: 'POL',
};

// Mainnet. Rows ingested before multi-chain sync carry a NULL chain_id, and
// every one of them is mainnet's -- so an unknown or missing id must resolve
// here rather than produce a dead link.
export const DEFAULT_CHAIN_ID = 1;

// The native asset's symbol for a chain, for rows the API sends as raw amounts
// (a transfer leg's value, a wallet's balance drift). Rows that already carry a
// symbol from the server should render THAT rather than call this.
export function nativeSymbol(chainId) {
  return NATIVE_ASSETS[Number(chainId)] || 'ETH';
}

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

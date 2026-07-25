'use strict';

// The canonical 0x1234…abcd abbreviation. Shared rather than re-declared per
// module because it is no longer purely cosmetic: routes/eth.js persists it as
// the label NAME for nameless 'external'/'own' verdicts, and EthWalletService
// derives the account name from it, so two copies drifting would leave stored
// data disagreeing with what the UI renders.
function shortAddress(address) {
  return address ? `${address.slice(0, 6)}…${address.slice(-4)}` : 'unknown';
}

module.exports = { shortAddress };

'use strict';

// The EVM balance derivations, stated once. Shared by the ledger (holdings and
// reconciliation: EthTransfer) and the history audit (EvmAudit), which must
// compute the same number from the same rows or the audit would be testing a
// different ledger than the one the user sees.
//
// Expressions over `t` (eth_transfers) and `w` (eth_wallets). Exact NUMERIC
// throughout; callers cast to text on the way out.

const sum = (body, coalesce) => (coalesce ? `COALESCE(SUM(${body}), 0)` : `SUM(${body})`);

// Native balance: inbound native+internal - outbound native+internal - gas.
// Gas is its own term (a gas leg's from is always the wallet, so on a
// self-send an inbound arm would credit the fee back). Failed value legs are
// excluded; their gas leg still counts (a revert burns it). NFT legs never
// appear: their value_wei is a unit count.
function nativeBalanceExpression({ coalesce = false } = {}) {
  return `(${sum(`CASE WHEN t.transfer_type IN ('native', 'internal')
                         AND t.is_error = FALSE AND t.to_address = w.address
                        THEN t.value_wei ELSE 0 END`, coalesce)}
             - ${sum(`CASE WHEN t.transfer_type IN ('native', 'internal')
                         AND t.is_error = FALSE AND t.from_address = w.address
                        THEN t.value_wei ELSE 0 END`, coalesce)}
             - ${sum(`CASE WHEN t.transfer_type = 'gas' THEN t.value_wei ELSE 0 END`, coalesce)})`;
}

// ERC-20 balance in base units. `requireSuccess` puts the is_error test in the
// arms for a query that does not already filter failed legs out.
function tokenBalanceExpression({ coalesce = false, requireSuccess = false } = {}) {
  const ok = requireSuccess ? 't.is_error = FALSE AND ' : '';
  return `(${sum(`CASE WHEN ${ok}t.to_address = w.address THEN t.value_wei ELSE 0 END`, coalesce)}
             - ${sum(`CASE WHEN ${ok}t.from_address = w.address THEN t.value_wei ELSE 0 END`, coalesce)})`;
}

// The legs a token balance is derived from: ERC-20 only (NFT feeds have their
// own transfer types, and the standard test is the fail-closed half), with a
// contract, and not on the owner's ignore list.
function erc20BalanceFilter(ownerUserIdSql) {
  return `t.transfer_type = 'token'
         AND t.token_standard = 'erc20'
         AND t.token_contract IS NOT NULL
         AND t.token_contract NOT IN (SELECT contract_address FROM eth_ignored_tokens WHERE user_id = ${ownerUserIdSql})`;
}

module.exports = { nativeBalanceExpression, tokenBalanceExpression, erc20BalanceFilter };

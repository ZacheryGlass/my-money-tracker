import { eth as ethAPI, exchanges as exchangesAPI } from '../../../utils/api';

// Accept a flagged row as it is. On-chain, the review IS an override that
// confirms the category the app chose (it clears needs_review, and outlives
// every rebuild); a folded exchange half is resolved on its own record. An
// exchange record is resolved directly -- a one-way door, so it has no undo.
//
// Returns how to take it back, when that is safe: only an on-chain row that
// had no override (and no note) before, since clearing an override also
// deletes its note and any spam verdict.
export async function markRowReviewed(row) {
  if (row.exchange_match?.needs_review && row.exchange_match.exchange_record_id != null) {
    await exchangesAPI.resolveRecord(row.exchange_match.exchange_account_id, row.exchange_match.exchange_record_id);
  }
  if (row.source === 'onchain') {
    await ethAPI.setActivityOverride({
      walletId: row.wallet_id, txHash: row.tx_hash, chainId: row.chain_id, category: row.category,
    });
    return !row.is_overridden && !row.override_note
      ? { walletId: row.wallet_id, txHash: row.tx_hash, chainId: row.chain_id }
      : null;
  }
  if (row.record_needs_review) await exchangesAPI.resolveRecord(row.exchange_account_id, row.row_id);
  return null;
}

export const undoMarkReviewed = (target) => ethAPI.clearActivityOverride(target);

// Words for the codes the crypto API stores. Codes stay codes on the wire (some
// are persisted keys); this is the one place they become sentences.

// A code nobody has worded yet still reads as words, never as snake_case.
export const humanize = (code) => {
  const text = String(code ?? '').replaceAll('_', ' ').trim();
  return text ? text[0].toUpperCase() + text.slice(1) : '';
};

const FEED_LABELS = {
  normal: 'transactions',
  internal: 'internal transfers',
  token: 'token transfers',
  nft: 'NFT transfers',
  nft1155: 'multi-edition NFT transfers',
  native_credit: 'network credits',
  statesync: 'bridge deposits',
  legacy_amounts: 'some older amounts',
};
export const feedLabel = (feed) => FEED_LABELS[feed] || humanize(feed).toLowerCase();

const AUDIT_STATUS_LABELS = {
  queued: 'waiting to start',
  running: 'running',
  deferred: 'paused by the data provider',
  unsupported: 'not supported on these networks',
  failed: 'failed',
  complete: 'complete',
  complete_with_gaps: 'complete, with known gaps',
  cancelled: 'cancelled',
};
export const auditStatusLabel = (status) => AUDIT_STATUS_LABELS[status] || humanize(status).toLowerCase();

const AUDIT_STAGE_LABELS = {
  queued: 'Waiting to start',
  discovering: 'Finding the networks this wallet used',
  fetching: 'Fetching transactions',
  canonicalizing: 'Organizing transactions',
  nonce_verification: 'Checking no transaction is missing',
  balance_reconciliation: 'Comparing balances',
  bridge_reconciliation: 'Matching bridge transfers',
  complete: 'Finished',
};
export const auditStageLabel = (stage) => AUDIT_STAGE_LABELS[stage] || humanize(stage);

const COVERAGE_STATUS_LABELS = {
  complete: 'Complete',
  failed: 'Failed',
  deferred: 'Paused',
  unsupported: 'Not available',
  unverified: 'Not yet confirmed',
  not_applicable: 'Not used',
};
export const coverageStatusLabel = (status) => COVERAGE_STATUS_LABELS[status] || humanize(status);

// How a wallet transaction and an exchange record were judged to be one
// movement. The evidence is the reason to trust or reject a pairing, so it is
// stated rather than reduced to a confidence score.
export const MATCH_METHOD_TEXT = {
  tx_hash: 'Both sides recorded the same transaction hash',
  address_amount: 'You confirmed the address and fee-adjusted amount',
  amount_window: 'You confirmed the amount and settlement time',
  manual: 'You confirmed this pairing',
};

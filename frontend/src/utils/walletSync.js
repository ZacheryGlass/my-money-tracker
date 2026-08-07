export const DEFERRED_SYNC_CODES = new Set(['SYNC_DEFERRED']);
export const LIMITED_SYNC_CODES = new Set(['FEED_UNSUPPORTED', 'CHAIN_UNAVAILABLE']);
export const NON_FAILURE_SYNC_CODES = new Set([
  ...DEFERRED_SYNC_CODES,
  ...LIMITED_SYNC_CODES,
]);

export const isWalletSyncFailure = (wallet) => Boolean(
  wallet?.error_code && !NON_FAILURE_SYNC_CODES.has(wallet.error_code)
);

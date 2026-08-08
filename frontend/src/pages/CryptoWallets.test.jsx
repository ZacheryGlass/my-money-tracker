import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import CryptoPage from './CryptoPage';

// The on-chain balance audit as the user meets it (#62). Sync starts at block 0,
// so a nonzero ETH delta can only mean a movement was never recorded -- these
// tests are about that reading loudly, a token delta reading plainly with its
// contract named, and an unchecked asset never reading as a pass.

const apiMocks = vi.hoisted(() => ({
  accounts: { getAll: vi.fn() },
  holdings: { getAll: vi.fn(), create: vi.fn(), update: vi.fn(), delete: vi.fn() },
  history: { getAccounts: vi.fn() },
  crypto: {
    getLedger: vi.fn(), getLedgerSummary: vi.fn(), ledgerExportUrl: vi.fn(),
    getBridgeAudit: vi.fn(), setBridgeVerdict: vi.fn(), clearBridgeVerdict: vi.fn(),
  },
  eth: {
    addWallet: vi.fn(), addWallets: vi.fn(), getWallets: vi.fn(), getCoverage: vi.fn(), syncWallet: vi.fn(), recaptureWallet: vi.fn(), removeWallet: vi.fn(),
    startHistoryAudit: vi.fn(), getHistoryAudit: vi.fn(), getHistoryAudits: vi.fn(),
    getTransfers: vi.fn(), getIgnoredTokens: vi.fn(), ignoreToken: vi.fn(), unignoreToken: vi.fn(),
    getAddressLabels: vi.fn(), labelAddress: vi.fn(), unlabelAddress: vi.fn(),
    getUnreviewedCounterparties: vi.fn(), getReconciliation: vi.fn(),
    getActivity: vi.fn(), setActivitySpam: vi.fn(),
    getDiscoveryCandidates: vi.fn(), getDiscoveryReceipts: vi.fn(), runDiscovery: vi.fn(), decideDiscovery: vi.fn(),
    addReconciliationAdjustment: vi.fn(), removeReconciliationAdjustment: vi.fn(),
  },
  exchanges: {
    getAll: vi.fn(), create: vi.fn(), update: vi.fn(), remove: vi.fn(),
    importCsv: vi.fn(), getRecords: vi.fn(), resolveRecord: vi.fn(),
  },
}));

vi.mock('../utils/api', () => ({
  accounts: apiMocks.accounts,
  holdings: apiMocks.holdings,
  history: apiMocks.history,
  crypto: apiMocks.crypto,
  eth: apiMocks.eth,
  exchanges: apiMocks.exchanges,
}));

const ONE_ETH = '1000000000000000000';
const DAI = '0x6b175474e89094c44da98b954eedeac495271d0f';

const wallet = (reconciliation) => ({
  id: 1,
  address: '0xd8da6bf26964af9d7eed9e03e53415d37aa96045',
  label: 'Main',
  last_synced_at: new Date().toISOString(),
  error_code: null,
  eth_quantity: '2',
  account: null,
  chains: [
    { chain_id: 1, name: 'Ethereum', enabled: true, unsupported_feeds: [], error_code: null },
    { chain_id: 42161, name: 'Arbitrum One', enabled: true, unsupported_feeds: [], error_code: null },
  ],
  reconciliation,
});

const report = (overrides = {}) => ({
  checked_at: new Date().toISOString(),
  assets_checked: 2,
  matched: 2,
  dust: 0,
  mismatched: 0,
  native_mismatches: 0,
  skipped: 0,
  unavailable: 0,
  needs_review: false,
  issues: [],
  truncated: false,
  ...overrides,
});

describe('Crypto -> Wallets tab', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    apiMocks.eth.getWallets.mockResolvedValue({ wallets: [] });
    apiMocks.eth.getIgnoredTokens.mockResolvedValue({ tokens: [] });
    apiMocks.eth.getAddressLabels.mockResolvedValue({ labels: [] });
    apiMocks.eth.getUnreviewedCounterparties.mockResolvedValue({
      data: [], summary: { count: 0, dust_count: 0, usd_volume: 0 },
    });
    apiMocks.eth.getActivity.mockResolvedValue({
      data: [], summary: { spam_count: 0, needs_review_count: 0 }, pagination: { total: 0 },
    });
    apiMocks.eth.getHistoryAudits.mockResolvedValue({ audits: [] });
    apiMocks.eth.getHistoryAudit.mockResolvedValue({ audit: null });
    apiMocks.eth.getDiscoveryCandidates.mockResolvedValue({ candidates: [] });
    apiMocks.eth.getDiscoveryReceipts.mockResolvedValue({ receipts: [] });
    apiMocks.exchanges.getAll.mockResolvedValue({ accounts: [] });
    apiMocks.accounts.getAll.mockResolvedValue({ accounts: [] });
    apiMocks.holdings.getAll.mockResolvedValue({ holdings: [] });
    apiMocks.history.getAccounts.mockResolvedValue({ data: [] });
    apiMocks.crypto.getLedgerSummary.mockResolvedValue({ summary: { total: 0, needs_review_count: 0 } });
    apiMocks.crypto.getLedger.mockResolvedValue({ data: [], pagination: { total: 0 } });
  });

  const openEthereumTab = async (wallets, onAttentionChange = vi.fn()) => {
    apiMocks.eth.getWallets.mockResolvedValue({ wallets });
    render(<CryptoPage tab="crypto-wallets" onTabChange={vi.fn()} onAttentionChange={onAttentionChange} />);
    await screen.findByText('EVM Wallets');
    return onAttentionChange;
  };

  // The list is a table now: the row states the verdict and the expanded panel
  // carries the evidence. DataTable renders the desktop table and the mobile
  // list together (CSS hides one), so [0] is always the desktop row.
  const expandWallet = async (name = 'Main') => {
    const cells = await screen.findAllByText(name);
    fireEvent.click(cells[0]);
  };

  // The on-chain balance audit as the user meets it (#62). Sync starts at
  // block 0, so a nonzero ETH delta can only mean a movement was never
  // recorded.
  it('states plainly when the ledger reproduces the chain', async () => {
    await openEthereumTab([wallet(report())]);
    // The row's own verdict, before anything is opened.
    expect(screen.getAllByText('Matches chain').length).toBeGreaterThan(0);

    await expandWallet();
    expect(await screen.findByText(/ledger matches the chain across 2 of 2 assets/i)).toBeInTheDocument();
  });

  it('raises an alert when the derived ETH balance is short', async () => {
    await openEthereumTab([wallet(report({
      mismatched: 1,
      native_mismatches: 1,
      matched: 1,
      needs_review: true,
      issues: [{
        id: 1, chain_id: 1, asset_key: 'ETH', asset_type: 'native', token_symbol: 'ETH',
        token_decimals: 18, derived_units: '2000000000000000000', live_units: '3000000000000000000',
        delta_units: '-1000000000000000000', status: 'mismatch', skip_reason: null,
      }],
    }))]);

    // The row says so without being opened -- a drift the user has to click to
    // discover is a drift they will not discover.
    expect(screen.getAllByText(/ETH unaccounted for/i).length).toBeGreaterThan(0);

    await expandWallet();
    // The chain and the size of the hole, not just "something is wrong".
    expect(await screen.findByText(/Ethereum: ledger is -1 ETH off/)).toBeInTheDocument();
  });

  it('reports a drifting wallet to the Wallets sidebar badge', async () => {
    const onAttentionChange = await openEthereumTab([wallet(report({
      mismatched: 1, native_mismatches: 1, needs_review: true,
      issues: [{
        id: 1, chain_id: 1, asset_key: 'ETH', asset_type: 'native', token_symbol: 'ETH',
        token_decimals: 18, derived_units: '0', live_units: ONE_ETH,
        delta_units: `-${ONE_ETH}`, status: 'mismatch', skip_reason: null,
      }],
    }))]);

    await waitFor(() => expect(onAttentionChange).toHaveBeenCalledWith({
      errored: 1,
      needsReview: 0,
    }));
  });

  it('names the offending contract on a token mismatch rather than a bare number', async () => {
    await openEthereumTab([wallet(report({
      mismatched: 1, native_mismatches: 0, matched: 1,
      issues: [{
        id: 2, chain_id: 42161, asset_key: DAI, asset_type: 'token', token_symbol: 'DAI',
        token_decimals: 18, derived_units: '2000000000000000000', live_units: ONE_ETH,
        delta_units: ONE_ETH, status: 'mismatch', skip_reason: null,
      }],
    }))]);

    expect(screen.getAllByText('Token drift').length).toBeGreaterThan(0);

    await expandWallet();
    expect(await screen.findByText(/Token balances that do not add up/i)).toBeInTheDocument();
    // Four contracts can call themselves DAI; the symbol alone is unactionable.
    expect(screen.getByTitle(DAI)).toBeInTheDocument();
    expect(screen.getByText(/on Arbitrum One is 1 off/)).toBeInTheDocument();
  });

  it('does not badge Wallets for token drift alone', async () => {
    const onAttentionChange = await openEthereumTab([wallet(report({
      mismatched: 1, native_mismatches: 0, needs_review: false,
      issues: [{
        id: 2, chain_id: 1, asset_key: DAI, asset_type: 'token', token_symbol: 'DAI',
        token_decimals: 18, derived_units: '2000000000000000000', live_units: ONE_ETH,
        delta_units: ONE_ETH, status: 'mismatch', skip_reason: null,
      }],
    }))]);

    // Rebasing and fee-on-transfer contracts drift with no missed transfer
    // behind them; badging those pins the count above zero permanently, and a
    // badge that cannot reach zero gets ignored -- taking the ETH signal with it.
    await expandWallet();
    await screen.findByText(/Token balances that do not add up/i);
    await waitFor(() => expect(onAttentionChange).toHaveBeenCalledWith({
      errored: 0,
      needsReview: 0,
    }));
  });

  it('says what it could not check instead of implying everything passed', async () => {
    await openEthereumTab([wallet(report({
      assets_checked: 2, matched: 1, mismatched: 0, skipped: 1,
      issues: [{
        id: 3, chain_id: 42161, asset_key: 'ETH', asset_type: 'native', token_symbol: 'ETH',
        token_decimals: 18, derived_units: '0', live_units: null,
        delta_units: null, status: 'skipped', skip_reason: 'feed_gap',
      }],
    }))]);

    await expandWallet();
    expect(await screen.findByText(/Not checked this run/i)).toBeInTheDocument();
    expect(screen.getByText(/a data feed this chain could not serve/i)).toBeInTheDocument();
    // The positive line still appears, but it reports 1 of 2 rather than a
    // clean bill of health -- a partial audit must count itself honestly, and
    // both numbers being on screen is what makes the gap legible.
    expect(screen.getByText(/ledger matches the chain across/i).textContent.replace(/\s+/g, ' '))
      .toMatch(/across 1 of 2 assets/);
  });

  // Reconciliation adjustments (048): documented audit-side corrections. The
  // UI's whole contract is that an adjusted verdict is never silent -- the
  // note shows beside the audit -- and that absorbing a known drift is one
  // required note away.
  describe('audit adjustments', () => {
    const DRIFT = '123456789';
    const driftReport = (overrides = {}) => report({
      mismatched: 1, native_mismatches: 1, matched: 1, needs_review: true,
      issues: [{
        id: 1, chain_id: 42161, asset_key: 'ETH', asset_type: 'native', token_symbol: 'ETH',
        token_decimals: 18, derived_units: '1000000000123456789', live_units: ONE_ETH,
        delta_units: DRIFT, status: 'mismatch', skip_reason: null,
      }],
      ...overrides,
    });

    it('opens an add form prefilled with the amount that zeroes the delta, and requires the note', async () => {
      apiMocks.eth.addReconciliationAdjustment.mockResolvedValue({ adjustment: { id: 3 }, reconciliation: { status: 'match' } });
      await openEthereumTab([wallet(driftReport())]);
      await expandWallet();

      fireEvent.click(await screen.findByRole('button', { name: /^adjust$/i }));
      // Prefilled with the negated delta: saving as-is is exactly what absorbs
      // the drift, so the one thing left to type is the explanation.
      const amount = await screen.findByLabelText(/amount \(base units/i);
      expect(amount.value).toBe(`-${DRIFT}`);
      // The prefill is labeled as absorbing the ENTIRE remaining drift, so a
      // large real loss is never one unlabeled click from being absorbed.
      expect(screen.getByText(/absorbs the entire remaining drift/i)).toBeInTheDocument();

      // No note, no save -- an adjustment without its explanation is
      // indistinguishable from fudging the audit.
      const save = screen.getByRole('button', { name: /save adjustment/i });
      expect(save).toBeDisabled();

      fireEvent.change(screen.getByLabelText(/why \(required\)/i), {
        target: { value: 'Classic-era L2 fees Etherscan does not report' },
      });
      expect(save).not.toBeDisabled();
      fireEvent.click(save);

      await waitFor(() => expect(apiMocks.eth.addReconciliationAdjustment).toHaveBeenCalledWith({
        walletId: 1,
        chainId: 42161,
        assetKey: 'ETH',
        amountWei: `-${DRIFT}`,
        note: 'Classic-era L2 fees Etherscan does not report',
      }));
      // The list refetches so the recomputed verdict (and the badge) update.
      await waitFor(() => expect(apiMocks.eth.getWallets.mock.calls.length).toBeGreaterThan(1));
    });

    it('prints the adjusted derived beside the raw figure once an adjustment exists', async () => {
      await openEthereumTab([wallet(driftReport({
        adjustments: [{
          id: 3, wallet_id: 1, chain_id: 42161, asset_key: 'ETH',
          amount_wei: '-100000000', note: 'Part of the gap is classic-era fees',
          created_at: new Date().toISOString(),
        }],
      }))]);
      await expandWallet();

      // Raw derived, adjusted derived, chain -- three figures whose arithmetic
      // now checks out on sight. The server's delta already includes the
      // adjustment, so printing it beside the RAW derived/live pair visibly
      // failed to add up.
      const line = await screen.findByText((content, element) =>
        element?.tagName === 'LI' && /with adjustments 1\.000000000023456789/.test(element.textContent));
      expect(line.textContent).toMatch(/derived 1\.000000000123456789/);
    });

    it('shows each adjustment with its note beside the audit, and removes one on demand', async () => {
      apiMocks.eth.removeReconciliationAdjustment.mockResolvedValue({ message: 'Adjustment removed' });
      // A clean report WITH an adjustment: the match only holds because of the
      // correction, so the correction must be on display.
      await openEthereumTab([wallet(report({
        adjustments: [{
          id: 3, wallet_id: 1, chain_id: 42161, asset_key: 'ETH',
          amount_wei: `-${DRIFT}`, note: 'Classic-era L2 fees Etherscan does not report',
          created_at: new Date().toISOString(),
        }],
      }))]);
      await expandWallet();

      expect(await screen.findByText(/audit adjustments/i)).toBeInTheDocument();
      expect(screen.getByText(/Classic-era L2 fees Etherscan does not report/)).toBeInTheDocument();

      fireEvent.click(screen.getByRole('button', { name: /^remove$/i }));
      await waitFor(() => expect(apiMocks.eth.removeReconciliationAdjustment).toHaveBeenCalledWith(3));
      await waitFor(() => expect(apiMocks.eth.getWallets.mock.calls.length).toBeGreaterThan(1));
    });
  });

  it('renders nothing for a wallet that has never been audited', async () => {
    // Never audited and audited-clean are different claims; a wallet added
    // moments ago must not appear to have passed.
    await openEthereumTab([wallet(null)]);
    expect(screen.getAllByText('Not audited').length).toBeGreaterThan(0);

    await expandWallet();
    expect(await screen.findByText(/No balance audit yet/i)).toBeInTheDocument();
    expect(screen.queryByText(/ledger matches the chain/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/ETH unaccounted for/i)).not.toBeInTheDocument();
  });
  // Per-chain sync state (039). The wallet badge carries transient failures
  // only, so a standing gap has to be reported here or not at all.
  const CHAIN_WALLET = {
    id: 1,
    address: '0xaaaa000000000000000000000000000000000001',
    label: 'Main',
    account: null,
    error_code: null,
    reconciliation: null,
  };

  it('shows per-chain state, including gaps the wallet badge deliberately omits', async () => {
    await openEthereumTab([{
      ...CHAIN_WALLET,
      chains: [
        { chain_id: 1, name: 'Ethereum', enabled: true, error_code: null, unsupported_feeds: [], last_synced_at: '2026-07-26T09:00:00Z' },
        { chain_id: 42161, name: 'Arbitrum One', enabled: true, error_code: 'FEED_UNSUPPORTED', error_message: 'internal unavailable on Arbitrum One; derived balances there may drift', unsupported_feeds: ['internal'], last_synced_at: '2026-07-26T09:00:00Z' },
        { chain_id: 8453, name: 'Base', enabled: false, error_code: null, unsupported_feeds: [], last_synced_at: null },
      ],
    }]);

    // The row warns without being opened; the chips name the gap.
    expect(screen.getAllByText('2 chains').length).toBeGreaterThan(0);
    await expandWallet();
    expect(await screen.findByText('Arbitrum One')).toBeInTheDocument();
    // The gap is named, not just flagged: "no internal" is what tells the user
    // (and #62) which derived numbers may drift.
    expect(screen.getByText('no internal')).toBeInTheDocument();
    // A switched-off chain reads as off while keeping its row -- disabling
    // stops the sync, it does not delete history.
    expect(screen.getByText('Base')).toBeInTheDocument();
    expect(screen.getByText('off')).toBeInTheDocument();
    // Chain-level coverage detail alone does not inflate the Wallets badge.
    expect(screen.getAllByText('Limited coverage').length).toBeGreaterThan(0);
    expect(screen.queryByText('Sync failed')).toBeNull();
  });

  it('shows provider cooldowns as deferred instead of failed', async () => {
    await openEthereumTab([{
      ...CHAIN_WALLET,
      error_code: 'SYNC_DEFERRED',
      error_message: 'Base explorer rate limited; automatic retry pending',
      chains: [{
        chain_id: 8453,
        name: 'Base',
        enabled: true,
        error_code: 'SYNC_DEFERRED',
        error_message: 'Base explorer rate limited; automatic retry pending',
        unsupported_feeds: [],
        last_synced_at: '2026-07-26T09:00:00Z',
      }],
    }]);

    expect(screen.getAllByText('Sync deferred').length).toBeGreaterThan(0);
    expect(screen.queryByText('Sync failed')).toBeNull();
    await expandWallet();
    expect(await screen.findByText(/automatic retry pending/i)).toBeInTheDocument();
  });

  it('keeps genuine feed failures red even when another chain has a standing limit', async () => {
    await openEthereumTab([{
      ...CHAIN_WALLET,
      error_code: 'FEED_SKIPPED',
      error_message: 'Polygon token feed timed out',
      chains: [
        {
          chain_id: 137, name: 'Polygon', enabled: true,
          error_code: 'FEED_SKIPPED', error_message: 'token feed timed out',
          unsupported_feeds: [], last_synced_at: '2026-07-26T09:00:00Z',
        },
        {
          chain_id: 100, name: 'Gnosis Chain', enabled: true,
          error_code: 'FEED_UNSUPPORTED', error_message: 'internal traces unavailable',
          unsupported_feeds: ['internal'], last_synced_at: '2026-07-26T09:00:00Z',
        },
      ],
    }]);

    expect(screen.getAllByText('Sync failed').length).toBeGreaterThan(0);
  });

  it('reports a deferred Sync click without a red failure banner', async () => {
    apiMocks.eth.syncWallet.mockResolvedValue({ sync: { status: 'deferred' } });
    await openEthereumTab([wallet(report())]);

    fireEvent.click((await screen.findAllByRole('button', { name: /sync main/i }))[0]);

    expect(await screen.findByText(/wallet sync deferred while the explorer cools down/i)).toBeInTheDocument();
    expect(screen.queryByText('Failed to sync wallet')).toBeNull();
  });

  it('starts history audit separately from ordinary Sync and persists queued status', async () => {
    apiMocks.eth.startHistoryAudit.mockResolvedValue({
      created: true,
      job: { id: '41', requested_wallet_id: 1, status: 'queued', stage: 'queued', progress: {} },
    });
    await openEthereumTab([wallet(report())]);

    fireEvent.click((await screen.findAllByRole('button', { name: /audit mined history for main/i }))[0]);
    await waitFor(() => expect(apiMocks.eth.startHistoryAudit).toHaveBeenCalledWith(1, { mode: 'full' }));
    expect(apiMocks.eth.syncWallet).not.toHaveBeenCalled();
    await expandWallet();
    expect(await screen.findByText(/History audit: queued/i)).toBeInTheDocument();
  });

  it('offers an incremental verification run for idempotency checks', async () => {
    apiMocks.eth.startHistoryAudit.mockResolvedValue({
      created: true,
      job: { id: '42', requested_wallet_id: 1, mode: 'incremental', status: 'queued', stage: 'queued', progress: {} },
    });
    await openEthereumTab([wallet(report())]);

    fireEvent.click((await screen.findAllByRole('button', { name: /incrementally verify main/i }))[0]);
    await waitFor(() => expect(apiMocks.eth.startHistoryAudit).toHaveBeenCalledWith(1, { mode: 'incremental' }));
    expect(apiMocks.eth.syncWallet).not.toHaveBeenCalled();
  });

  it('renders known audit limitations amber instead of a generic red failure', async () => {
    await openEthereumTab([{
      ...wallet(report()),
      history_audit: {
        id: '40', requested_wallet_id: 1, status: 'complete_with_gaps', stage: 'complete',
        progress: { gaps: 2 }, error_detail: null,
      },
    }]);
    await expandWallet();
    const status = await screen.findByText(/History audit: complete with gaps/i);
    expect(status.closest('div')).toHaveClass('text-amber-300');
    expect(screen.queryByText(/History audit: failed/i)).toBeNull();
  });

  it('shows a single chain\u2019s standing gap, which a chain-count gate hid entirely', async () => {
    // ETH_CHAINS=1 (or any wallet down to one chain) still has to report a
    // feed its key cannot serve: the wallet badge deliberately omits standing
    // gaps, so gating the strip on "more than one chain" made the only
    // surface that reports them disappear.
    await openEthereumTab([{
      ...CHAIN_WALLET,
      chains: [
        { chain_id: 1, name: 'Ethereum', enabled: true, error_code: 'FEED_UNSUPPORTED', error_message: 'internal unavailable on Ethereum; derived balances there may drift', unsupported_feeds: ['internal'], last_synced_at: '2026-07-26T09:00:00Z' },
      ],
    }]);

    await expandWallet();
    expect(await screen.findByText('no internal')).toBeInTheDocument();
  });

  it('stays quiet for a single healthy chain', async () => {
    // Nothing to warn about: one chain, no gap, no error. The row names the
    // chain and stops there.
    await openEthereumTab([{
      ...CHAIN_WALLET,
      chains: [
        { chain_id: 1, name: 'Ethereum', enabled: true, error_code: null, unsupported_feeds: [], last_synced_at: '2026-07-26T09:00:00Z' },
      ],
    }]);

    expect(await screen.findAllByText('Ethereum')).not.toHaveLength(0);
    expect(screen.queryByText(/no internal/)).toBeNull();
    expect(screen.queryByText('off')).toBeNull();
  });

  it('requires confirmation and starts a note-preserving full-history recapture', async () => {
    apiMocks.eth.recaptureWallet.mockResolvedValue({ started: true, annotations_preserved: true });
    await openEthereumTab([wallet(report())]);

    const buttons = await screen.findAllByRole('button', { name: /recapture full history for main/i });
    fireEvent.click(buttons[0]);
    expect(await screen.findByText(/transaction notes, address notes, labels, category overrides/i)).toBeInTheDocument();
    expect(apiMocks.eth.recaptureWallet).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: /start recapture/i }));
    await waitFor(() => expect(apiMocks.eth.recaptureWallet).toHaveBeenCalledWith(1));
  });

  it('shows exact feed gaps in the downloadable source coverage report', async () => {
    apiMocks.eth.getCoverage.mockResolvedValue({
      generated_at: '2026-07-30T22:00:00.000Z',
      summary: {
        rows: 3, enabled_rows: 3, complete: 1, failed: 0,
        deferred: 1, unsupported: 1, not_applicable: 0, unverified: 0, gaps: 2,
      },
      coverage: [
        {
          wallet_id: 1, wallet_label: 'Main', wallet_address: wallet().address,
          chain_id: 1, chain_name: 'Ethereum', feed: 'normal',
          status: 'complete', enabled: true, provider: 'Etherscan V2',
        },
        {
          wallet_id: 1, wallet_label: 'Main', wallet_address: wallet().address,
          chain_id: 100, chain_name: 'Gnosis Chain', feed: 'internal',
          status: 'unsupported', enabled: true, provider: 'Blockscout',
          error_message: 'Internal traces unavailable for blocks 0-123',
          covered_through_block: 99,
        },
        {
          wallet_id: 1, wallet_label: 'Main', wallet_address: wallet().address,
          chain_id: 8453, chain_name: 'Base', feed: 'token',
          status: 'deferred', enabled: true, provider: 'Blockscout',
          error_message: 'Provider cooldown; retry after 10 seconds',
          retry_after_at: '2026-07-30T22:00:10.000Z',
          covered_through_block: 49999999,
        },
      ],
    });
    await openEthereumTab([wallet(report())]);

    fireEvent.click(screen.getByRole('button', { name: /coverage report/i }));

    expect(await screen.findByRole('dialog', { name: /evm source coverage/i })).toBeInTheDocument();
    expect(screen.getByText(/main · gnosis chain · internal/i)).toBeInTheDocument();
    expect(screen.getByText(/internal traces unavailable for blocks 0-123/i)).toBeInTheDocument();
    expect(screen.getByText(/main · base · token/i)).toBeInTheDocument();
    expect(screen.getByText(/provider cooldown; retry after 10 seconds/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /download json/i })).toBeInTheDocument();
  });

  // Adding wallets. One textbox takes a pasted list, one address per line.
  describe('connect crypto wallet', () => {
    const openWalletModal = async () => {
      await openEthereumTab([]);
      fireEvent.click(await screen.findByRole('button', { name: /connect crypto/i }));
      return screen.findByPlaceholderText(/one per line/i);
    };

    it('sends a pasted list through the bulk endpoint', async () => {
      apiMocks.eth.addWallets.mockResolvedValue({
        summary: { added: 2, duplicate: 0, failed: 0 },
        results: [],
      });
      const input = await openWalletModal();

      fireEvent.change(input, {
        target: { value: `0x${'1'.repeat(40)}\n0x${'2'.repeat(40)}\n` },
      });
      fireEvent.click(screen.getByRole('button', { name: /track 2 wallets/i }));

      await waitFor(() => expect(apiMocks.eth.addWallets).toHaveBeenCalledWith([
        `0x${'1'.repeat(40)}`,
        `0x${'2'.repeat(40)}`,
      ]));
      expect(apiMocks.eth.addWallet).not.toHaveBeenCalled();
    });

    // A single address keeps the original one-shot path, label included --
    // the bulk endpoint takes no labels.
    it('keeps the single-address path on the single-add endpoint', async () => {
      apiMocks.eth.addWallet.mockResolvedValue({});
      const input = await openWalletModal();

      fireEvent.change(input, { target: { value: `  0x${'3'.repeat(40)}  ` } });
      fireEvent.click(screen.getByRole('button', { name: /^track wallet$/i }));

      await waitFor(() => expect(apiMocks.eth.addWallet).toHaveBeenCalledWith(`0x${'3'.repeat(40)}`, undefined));
      expect(apiMocks.eth.addWallets).not.toHaveBeenCalled();
    });

    // A typo must name itself rather than be dropped from the batch.
    it('refuses the batch and names the malformed line', async () => {
      const input = await openWalletModal();

      fireEvent.change(input, { target: { value: `0x${'1'.repeat(40)}\nnope` } });
      fireEvent.click(screen.getByRole('button', { name: /track 2 wallets/i }));

      expect(await screen.findByText(/not a valid evm address: nope/i)).toBeInTheDocument();
      expect(apiMocks.eth.addWallets).not.toHaveBeenCalled();
    });

    // Anything the server refused is reported per address, not summarized away.
    it('lists the addresses the server did not add', async () => {
      apiMocks.eth.addWallets.mockResolvedValue({
        summary: { added: 1, duplicate: 1, failed: 0 },
        results: [
          { address: `0x${'1'.repeat(40)}`, status: 'added' },
          { address: `0x${'2'.repeat(40)}`, status: 'duplicate', error: 'That address is already tracked' },
        ],
      });
      const input = await openWalletModal();

      fireEvent.change(input, { target: { value: `0x${'1'.repeat(40)}\n0x${'2'.repeat(40)}` } });
      fireEvent.click(screen.getByRole('button', { name: /track 2 wallets/i }));

      expect(await screen.findByText(/already tracked/i)).toBeInTheDocument();
      expect(screen.getByText(`0x${'2'.repeat(40)}`)).toBeInTheDocument();
    });
  });
});

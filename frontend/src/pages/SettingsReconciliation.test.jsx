import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import Settings from './Settings';

// The on-chain balance audit as the user meets it (#62). Sync starts at block 0,
// so a nonzero ETH delta can only mean a movement was never recorded -- these
// tests are about that reading loudly, a token delta reading plainly with its
// contract named, and an unchecked asset never reading as a pass.

const apiMocks = vi.hoisted(() => ({
  accounts: { getAll: vi.fn(), updateDisplayName: vi.fn(), updateVisibility: vi.fn() },
  plaid: {
    createLinkToken: vi.fn(), createUpdateLinkToken: vi.fn(), exchangeToken: vi.fn(),
    getItems: vi.fn(), syncItem: vi.fn(), removeItem: vi.fn(),
  },
  eth: {
    addWallet: vi.fn(), getWallets: vi.fn(), syncWallet: vi.fn(), removeWallet: vi.fn(),
    getTransfers: vi.fn(), getIgnoredTokens: vi.fn(), ignoreToken: vi.fn(), unignoreToken: vi.fn(),
    getAddressLabels: vi.fn(), labelAddress: vi.fn(), unlabelAddress: vi.fn(),
    getUnreviewedCounterparties: vi.fn(), getReconciliation: vi.fn(),
  },
  keys: { getAll: vi.fn(), set: vi.fn(), clear: vi.fn() },
  admin: { getOverview: vi.fn(), triggerJob: vi.fn() },
  holdings: { create: vi.fn() },
  exportData: { downloadHoldings: vi.fn(), downloadHistory: vi.fn() },
  history: { getPortfolio: vi.fn() },
  exchanges: {
    getAll: vi.fn(), create: vi.fn(), update: vi.fn(), remove: vi.fn(),
    importCsv: vi.fn(), getRecords: vi.fn(), resolveRecord: vi.fn(),
  },
}));

vi.mock('../utils/api', () => ({
  accounts: apiMocks.accounts,
  plaid: apiMocks.plaid,
  eth: apiMocks.eth,
  keys: apiMocks.keys,
  admin: apiMocks.admin,
  holdings: apiMocks.holdings,
  exportData: apiMocks.exportData,
  history: apiMocks.history,
  exchanges: apiMocks.exchanges,
}));

vi.mock('react-plaid-link', () => ({
  usePlaidLink: () => ({ open: vi.fn(), ready: false }),
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

describe('Settings -> Ethereum balance audit', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    apiMocks.plaid.getItems.mockResolvedValue({ items: [] });
    apiMocks.eth.getWallets.mockResolvedValue({ wallets: [] });
    apiMocks.eth.getIgnoredTokens.mockResolvedValue({ tokens: [] });
    apiMocks.eth.getAddressLabels.mockResolvedValue({ labels: [] });
    apiMocks.eth.getUnreviewedCounterparties.mockResolvedValue({
      data: [], summary: { count: 0, dust_count: 0, usd_volume: 0 },
    });
    apiMocks.exchanges.getAll.mockResolvedValue({ accounts: [] });
    apiMocks.admin.getOverview.mockRejectedValue({ response: { status: 403 } });
    apiMocks.keys.getAll.mockResolvedValue({
      encryptionConfigured: true, userKeys: {}, appSettings: {},
    });
    apiMocks.accounts.getAll.mockResolvedValue({ accounts: [] });
  });

  const openEthereumTab = async (wallets) => {
    apiMocks.eth.getWallets.mockResolvedValue({ wallets });
    render(
      <MemoryRouter initialEntries={['/settings']}>
        <Settings user={{ id: 1, username: 'zachery', isAdmin: false }} />
      </MemoryRouter>
    );
    fireEvent.click(await screen.findByRole('tab', { name: /Ethereum/ }));
    await screen.findByText('Ethereum Wallets');
  };

  it('states plainly when the ledger reproduces the chain', async () => {
    await openEthereumTab([wallet(report())]);
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

    expect(await screen.findByText(/ETH unaccounted for/i)).toBeInTheDocument();
    // The chain and the size of the hole, not just "something is wrong".
    expect(screen.getByText(/Ethereum: ledger is -1 ETH off/)).toBeInTheDocument();
  });

  it('counts a drifting wallet in the Ethereum tab badge', async () => {
    await openEthereumTab([wallet(report({
      mismatched: 1, native_mismatches: 1, needs_review: true,
      issues: [{
        id: 1, chain_id: 1, asset_key: 'ETH', asset_type: 'native', token_symbol: 'ETH',
        token_decimals: 18, derived_units: '0', live_units: ONE_ETH,
        delta_units: `-${ONE_ETH}`, status: 'mismatch', skip_reason: null,
      }],
    }))]);

    // The tab carries the attention count; a silent drift would defeat the
    // point of auditing at all.
    expect(await screen.findByText('Ethereum (1)')).toBeInTheDocument();
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

    expect(await screen.findByText(/Token balances that do not add up/i)).toBeInTheDocument();
    // Four contracts can call themselves DAI; the symbol alone is unactionable.
    expect(screen.getByTitle(DAI)).toBeInTheDocument();
    expect(screen.getByText(/on Arbitrum One is 1 off/)).toBeInTheDocument();
  });

  it('does not badge the tab for token drift alone', async () => {
    await openEthereumTab([wallet(report({
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
    await screen.findByText(/Token balances that do not add up/i);
    expect(screen.queryByText(/Ethereum \(\d+\)/)).not.toBeInTheDocument();
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

    expect(await screen.findByText(/Not checked this run/i)).toBeInTheDocument();
    expect(screen.getByText(/a data feed this chain could not serve/i)).toBeInTheDocument();
    // The positive line still appears, but it reports 1 of 2 rather than a
    // clean bill of health -- a partial audit must count itself honestly, and
    // both numbers being on screen is what makes the gap legible.
    expect(screen.getByText(/ledger matches the chain across/i).textContent.replace(/\s+/g, ' '))
      .toMatch(/across 1 of 2 assets/);
  });

  it('renders nothing for a wallet that has never been audited', async () => {
    // Never audited and audited-clean are different claims; a wallet added
    // moments ago must not appear to have passed.
    await openEthereumTab([wallet(null)]);
    await screen.findByText('Ethereum Wallets');
    expect(screen.queryByText(/ledger matches the chain/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/ETH unaccounted for/i)).not.toBeInTheDocument();
  });
});

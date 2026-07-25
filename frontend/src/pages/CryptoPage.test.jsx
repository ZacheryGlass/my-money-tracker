import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import CryptoPage from './CryptoPage';

const apiMocks = vi.hoisted(() => ({
  accounts: { getAll: vi.fn() },
  holdings: { getAll: vi.fn(), create: vi.fn(), update: vi.fn(), delete: vi.fn() },
  history: { getAccounts: vi.fn() },
  eth: {
    getWallets: vi.fn(),
    syncWallet: vi.fn(),
    getTransfers: vi.fn(),
    ignoreToken: vi.fn(),
    getAddressLabels: vi.fn(),
    labelAddress: vi.fn(),
  },
}));

vi.mock('../utils/api', () => ({
  accounts: apiMocks.accounts,
  holdings: apiMocks.holdings,
  history: apiMocks.history,
  eth: apiMocks.eth,
}));

const CRYPTO_ACCOUNT = {
  id: 9,
  name: 'Ethereum 0xaaaa…0001',
  effective_name: 'Ethereum 0xaaaa…0001',
  type: 'crypto',
  eth_wallet_id: 1,
};

describe('CryptoPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    apiMocks.eth.getWallets.mockResolvedValue({ wallets: [] });
    apiMocks.eth.getTransfers.mockResolvedValue({ data: [], pagination: { total: 0 } });
    apiMocks.eth.getAddressLabels.mockResolvedValue({ labels: [] });
    apiMocks.holdings.getAll.mockResolvedValue({ holdings: [] });
    apiMocks.accounts.getAll.mockResolvedValue({ accounts: [] });
    apiMocks.history.getAccounts.mockResolvedValue({ data: [] });
  });

  it('sends the user to the Ethereum settings tab when nothing is tracked', async () => {
    const onNavigate = vi.fn();
    render(<CryptoPage onNavigate={onNavigate} />);

    fireEvent.click(await screen.findByRole('button', { name: /connect crypto/i }));

    expect(onNavigate).toHaveBeenCalledWith('settings', { tab: 'ethereum' });
  });

  it('totals only crypto holdings and leaves other accounts out', async () => {
    apiMocks.accounts.getAll.mockResolvedValue({
      accounts: [CRYPTO_ACCOUNT, { id: 3, name: 'Brokerage', type: 'investment' }],
    });
    apiMocks.holdings.getAll.mockResolvedValue({
      holdings: [
        { id: 1, account_id: 9, account_type: 'crypto', account_eth_wallet_id: 1, ticker: 'ETH', name: 'Ethereum', quantity: '2', current_value: '6000' },
        { id: 2, account_id: 9, account_type: 'crypto', account_eth_wallet_id: 1, ticker: null, name: 'USDC 0xa0b8…eb48', manual_value: '250' },
        // Must not count toward the crypto total.
        { id: 3, account_id: 3, account_type: 'investment', ticker: 'VTI', name: 'Vanguard Total Market', current_value: '90000' },
      ],
    });
    apiMocks.eth.getWallets.mockResolvedValue({
      wallets: [{ id: 1, address: '0xaaaa000000000000000000000000000000000001', account: CRYPTO_ACCOUNT, eth_quantity: '2', last_synced_at: '2026-07-24T08:00:00Z' }],
    });

    render(<CryptoPage onNavigate={vi.fn()} />);

    // Rendered twice by design: the page headline and the Total Value card.
    expect(await screen.findAllByText('$6,250')).toHaveLength(2);
    // DataTable renders desktop rows and mobile cards together, CSS-hidden.
    expect(screen.getAllByText('Ethereum').length).toBeGreaterThan(0);
    expect(screen.getAllByText('USDC 0xa0b8…eb48').length).toBeGreaterThan(0);
    expect(screen.queryByText('Vanguard Total Market')).toBeNull();
  });
});

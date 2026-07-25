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

  it('defaults the activity feed to every wallet and tags rows with their wallet', async () => {
    apiMocks.accounts.getAll.mockResolvedValue({ accounts: [CRYPTO_ACCOUNT] });
    apiMocks.eth.getWallets.mockResolvedValue({
      wallets: [
        { id: 1, address: '0xaaaa000000000000000000000000000000000001', label: 'Main ETH Address', eth_quantity: '2' },
        { id: 2, address: '0xbbbb000000000000000000000000000000000002', label: 'Ledger Nano S', eth_quantity: '0' },
      ],
    });
    apiMocks.eth.getTransfers.mockResolvedValue({
      data: [
        // Sent from wallet 2's own address: must read as outbound even though
        // wallet 1 leads the list.
        {
          id: 11, wallet_id: 2, wallet_address: '0xbbbb000000000000000000000000000000000002',
          transfer_type: 'external', tx_hash: '0xfeed000000', block_time: '2026-07-01T00:00:00Z',
          from_address: '0xbbbb000000000000000000000000000000000002',
          to_address: '0xcccc000000000000000000000000000000000003',
          value_wei: '1000000000000000000', is_error: false,
          counterparty_is_own: false, counterparty_exchange: null,
        },
      ],
      pagination: { total: 1 },
    });

    render(<CryptoPage onNavigate={vi.fn()} />);

    await screen.findByText('On-chain Activity');
    // No walletId => the merged feed across every wallet.
    expect(apiMocks.eth.getTransfers).toHaveBeenCalledWith(
      expect.objectContaining({ walletId: null })
    );
    expect(screen.getByRole('tab', { name: /all wallets \(2\)/i })).toHaveAttribute('aria-selected', 'true');
    // Row is tagged with its own wallet and signed against that wallet's
    // address. Matched by exact title, which only the row chip carries -- the
    // wallet tab's title also appends the address.
    expect(screen.getByTitle('Ledger Nano S')).toBeInTheDocument();
    expect(screen.getByText(/^-1 ETH$/)).toBeInTheDocument();
  });

  it('truncates a sentence-length wallet label but keeps it whole on hover', async () => {
    const LONG = 'Use to store EOS ERC20 tokens before mainnet. Sent remainder to BinanceUS';
    apiMocks.eth.getWallets.mockResolvedValue({
      wallets: [
        { id: 1, address: '0xaaaa000000000000000000000000000000000001', label: LONG, eth_quantity: '0' },
        { id: 2, address: '0xbbbb000000000000000000000000000000000002', label: 'Ledger Nano S', eth_quantity: '0' },
      ],
    });

    render(<CryptoPage onNavigate={vi.fn()} />);

    const tab = await screen.findByRole('tab', { name: /^Use to store EOS/ });
    expect(tab.textContent.length).toBeLessThan(30);
    expect(tab).toHaveAttribute('title', `${LONG} · 0xaaaa000000000000000000000000000000000001`);
  });
});

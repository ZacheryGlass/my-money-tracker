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

    render(<CryptoPage tab="crypto-holdings" onNavigate={vi.fn()} />);

    // Headline only: the Total Value card lives on the Overview tab.
    expect(await screen.findByText('$6,250')).toBeInTheDocument();
    // DataTable renders desktop rows and mobile cards together, CSS-hidden.
    expect(screen.getAllByText('Ethereum').length).toBeGreaterThan(0);
    expect(screen.getAllByText('USDC 0xa0b8…eb48').length).toBeGreaterThan(0);
    expect(screen.queryByText('Vanguard Total Market')).toBeNull();
  });

  it('switches tabs by navigating, so a sub-tab is a real URL', async () => {
    const onTabChange = vi.fn();
    apiMocks.accounts.getAll.mockResolvedValue({ accounts: [CRYPTO_ACCOUNT] });
    apiMocks.eth.getWallets.mockResolvedValue({
      wallets: [{ id: 1, address: '0xaaaa000000000000000000000000000000000001', label: 'Main', eth_quantity: '1' }],
    });

    render(<CryptoPage onTabChange={onTabChange} onNavigate={vi.fn()} />);

    fireEvent.click(await screen.findByRole('tab', { name: /^Transactions/ }));

    // The id must match App.jsx's navItems entry or handleNavigate silently
    // swallows it and the tab becomes a dead click.
    expect(onTabChange).toHaveBeenCalledWith('crypto-transactions');
  });

  it('falls back to Overview when a wallet-less user deep-links to Transactions', async () => {
    apiMocks.accounts.getAll.mockResolvedValue({ accounts: [{ ...CRYPTO_ACCOUNT, eth_wallet_id: null }] });

    render(<CryptoPage tab="crypto-transactions" onNavigate={vi.fn()} />);

    // Overview's content, not an empty activity feed.
    await screen.findByText('Total Value');
    expect(screen.queryByText('On-chain Activity')).toBeNull();
    expect(screen.queryByRole('tab', { name: /^Transactions/ })).toBeNull();
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

    render(<CryptoPage tab="crypto-transactions" onNavigate={vi.fn()} />);

    await screen.findByText('On-chain Activity');
    // No walletId => the merged feed across every wallet.
    expect(apiMocks.eth.getTransfers).toHaveBeenCalledWith(
      expect.objectContaining({ walletId: null })
    );
    expect(screen.getByLabelText('Wallet')).toHaveValue('');
    // Row is tagged with its own wallet and signed against that wallet's
    // address. Matched by exact title, which only the row chip carries.
    expect(screen.getByTitle('Ledger Nano S')).toBeInTheDocument();
    // Desktop row and mobile card render together, CSS-hidden.
    expect(screen.getAllByText(/^-1 ETH$/).length).toBeGreaterThan(0);
  });

  it('reloads holdings after ignoring a token, so the totals drop with the row', async () => {
    apiMocks.accounts.getAll.mockResolvedValue({ accounts: [CRYPTO_ACCOUNT] });
    apiMocks.eth.getWallets.mockResolvedValue({
      wallets: [{ id: 1, address: '0xaaaa000000000000000000000000000000000001', label: 'Main', eth_quantity: '2' }],
    });
    apiMocks.eth.getTransfers.mockResolvedValue({
      data: [{
        id: 21, wallet_id: 1, wallet_address: '0xaaaa000000000000000000000000000000000001',
        transfer_type: 'token', tx_hash: '0xspam00000', block_time: '2026-07-01T00:00:00Z',
        from_address: '0xdddd000000000000000000000000000000000004',
        to_address: '0xaaaa000000000000000000000000000000000001',
        value_wei: '1000000', is_error: false,
        token_contract: '0xbad0000000000000000000000000000000000bad',
        token_symbol: 'SCAM', token_decimals: 6,
        counterparty_is_own: false, counterparty_exchange: null,
      }],
      pagination: { total: 1 },
    });
    apiMocks.eth.ignoreToken.mockResolvedValue({ token: {} });

    render(<CryptoPage tab="crypto-transactions" onNavigate={vi.fn()} />);

    await screen.findByText('On-chain Activity');
    const callsBefore = apiMocks.holdings.getAll.mock.calls.length;

    fireEvent.click(screen.getByTitle(/ignore/i));

    await vi.waitFor(() => {
      expect(apiMocks.eth.ignoreToken).toHaveBeenCalledWith('0xbad0000000000000000000000000000000000bad', 'SCAM');
      // Ignoring deletes the token's holding row server-side. Without a parent
      // refetch the Holdings tab and Total Value keep counting what was removed.
      expect(apiMocks.holdings.getAll.mock.calls.length).toBeGreaterThan(callsBefore);
    });
  });

  it('shows a sentence-length wallet label whole in the wallet picker', async () => {
    const LONG = 'Use to store EOS ERC20 tokens before mainnet. Sent remainder to BinanceUS';
    apiMocks.accounts.getAll.mockResolvedValue({ accounts: [CRYPTO_ACCOUNT] });
    apiMocks.eth.getWallets.mockResolvedValue({
      wallets: [
        { id: 1, address: '0xaaaa000000000000000000000000000000000001', label: LONG, eth_quantity: '0' },
        { id: 2, address: '0xbbbb000000000000000000000000000000000002', label: 'Ledger Nano S', eth_quantity: '0' },
      ],
    });

    render(<CryptoPage tab="crypto-transactions" onNavigate={vi.fn()} />);

    // A <select> shows the label whole; the old tab strip had to truncate it.
    expect(await screen.findByRole('option', { name: LONG })).toBeInTheDocument();
  });

  it('offers Add Holding, the only route to creating a manual crypto holding', async () => {
    apiMocks.accounts.getAll.mockResolvedValue({
      accounts: [{ id: 12, name: 'Cold storage', effective_name: 'Cold storage', type: 'crypto', eth_wallet_id: null }],
    });

    render(<CryptoPage tab="crypto-holdings" onNavigate={vi.fn()} />);

    fireEvent.click(await screen.findByRole('button', { name: /add holding/i }));

    // "Add New Holding" is HoldingForm's create-mode heading; "Edit Holding"
    // would mean it opened prefilled and would take the update branch.
    expect(screen.getByRole('heading', { name: 'Add New Holding' })).toBeInTheDocument();
  });
});

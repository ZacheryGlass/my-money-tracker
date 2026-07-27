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
    setActivityOverride: vi.fn(),
    clearActivityOverride: vi.fn(),
    getReconciliation: vi.fn(),
    getUnpricedAssets: vi.fn(),
  },
  crypto: { getLedger: vi.fn(), getLedgerSummary: vi.fn(), ledgerExportUrl: vi.fn() },
  exchanges: {
    getAll: vi.fn(), resolveRecord: vi.fn(), setMatchVerdict: vi.fn(), clearMatchVerdict: vi.fn(),
  },
}));

vi.mock('../utils/api', () => ({
  accounts: apiMocks.accounts,
  holdings: apiMocks.holdings,
  history: apiMocks.history,
  eth: apiMocks.eth,
  crypto: apiMocks.crypto,
  exchanges: apiMocks.exchanges,
}));

// The Transactions tab now opens onto the unified ledger; the raw per-leg feed
// is the second view behind this button.
const showTransferLegs = async () => {
  fireEvent.click(await screen.findByRole('button', { name: /transfer legs/i }));
};

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
    apiMocks.crypto.getLedger.mockResolvedValue({ data: [], pagination: { total: 0 } });
    apiMocks.crypto.getLedgerSummary.mockResolvedValue({
      summary: {
        total: 0, needs_review_count: 0, onchain_count: 0, exchange_count: 0, matched_count: 0,
      },
    });
    apiMocks.crypto.ledgerExportUrl.mockReturnValue('/api/crypto/ledger/export');
    apiMocks.exchanges.getAll.mockResolvedValue({ accounts: [] });
    apiMocks.eth.getReconciliation.mockResolvedValue({ data: [], summary: {} });
    apiMocks.eth.getUnpricedAssets.mockResolvedValue({ data: [], total: 0 });
  });

  // Wallets are added on this page now (#75), not in Settings.
  it('sends the user to the Wallets tab when nothing is tracked', async () => {
    const onTabChange = vi.fn();
    render(<CryptoPage onTabChange={onTabChange} />);

    fireEvent.click(await screen.findByRole('button', { name: /connect crypto/i }));

    expect(onTabChange).toHaveBeenCalledWith('crypto-wallets');
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

    render(<CryptoPage tab="crypto-holdings" onTabChange={vi.fn()} />);

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

    render(<CryptoPage onTabChange={onTabChange} />);

    fireEvent.click(await screen.findByRole('tab', { name: /^Transactions/ }));

    // The id must match App.jsx's navItems entry or handleNavigate silently
    // swallows it and the tab becomes a dead click.
    expect(onTabChange).toHaveBeenCalledWith('crypto-transactions');
  });

  it('falls back to Overview when a wallet-less user deep-links to Transactions', async () => {
    apiMocks.accounts.getAll.mockResolvedValue({ accounts: [{ ...CRYPTO_ACCOUNT, eth_wallet_id: null }] });

    render(<CryptoPage tab="crypto-transactions" onTabChange={vi.fn()} />);

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

    render(<CryptoPage tab="crypto-transactions" onTabChange={vi.fn()} />);
    await showTransferLegs();

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

  it('shows what a transfer was worth on its own date, and says so when it cannot', async () => {
    apiMocks.accounts.getAll.mockResolvedValue({ accounts: [CRYPTO_ACCOUNT] });
    apiMocks.eth.getWallets.mockResolvedValue({
      wallets: [{ id: 1, address: '0xaaaa000000000000000000000000000000000001', label: 'Main', eth_quantity: '2' }],
    });
    const base = {
      wallet_id: 1, wallet_address: '0xaaaa000000000000000000000000000000000001',
      from_address: '0xaaaa000000000000000000000000000000000001',
      to_address: '0xcccc000000000000000000000000000000000003',
      is_error: false, counterparty_is_own: false, counterparty_exchange: null,
    };
    apiMocks.eth.getTransfers.mockResolvedValue({
      data: [
        // The issue's own example: 0.5 ETH in mid-2017 was ~$150, not today's
        // ~$1,800. The client renders the server's dated valuation verbatim.
        {
          ...base, id: 11, transfer_type: 'external', tx_hash: '0xa1',
          block_time: '2017-06-12T14:00:00Z', value_wei: '500000000000000000',
          usd_at_time: '150.00', usd_basis: 'exact',
        },
        // A dead token with no series anywhere. Never $0 -- unknown is not
        // worthless, and the difference is the whole point.
        {
          ...base, id: 12, transfer_type: 'token', tx_hash: '0xa2',
          block_time: '2017-08-01T10:00:00Z', value_wei: '5000000000000000000',
          token_contract: '0xdead000000000000000000000000000000000001',
          token_symbol: 'DEAD', token_decimals: 18,
          usd_at_time: null, usd_basis: 'unpriced',
        },
        // An NFT leg: value_wei is a count of units, so it carries no dollars
        // at all rather than a wrong one.
        {
          ...base, id: 13, transfer_type: 'nft', tx_hash: '0xa3',
          block_time: '2021-05-01T10:00:00Z', value_wei: '1',
          token_contract: '0xd1d1000000000000000000000000000000000001',
          token_symbol: 'PUNK', token_id: '42', token_standard: 'erc721',
          usd_at_time: null, usd_basis: 'not_applicable',
        },
      ],
      pagination: { total: 3 },
    });

    render(<CryptoPage tab="crypto-transactions" onTabChange={vi.fn()} />);
    await showTransferLegs();

    await screen.findByText('On-chain Activity');
    // 2017 dollars, not 2026 dollars -- and always two decimals, so the column
    // does not mix $150 with $1,234.50.
    expect(screen.getAllByText('$150.00').length).toBeGreaterThan(0);
    expect(screen.queryByText(/\$1,8\d\d/)).toBeNull();
    expect(screen.getAllByText('No USD value').length).toBeGreaterThan(0);
    // Exactly one unpriced row: the NFT leg shows no USD line at all rather
    // than claiming its value is unknown.
    expect(screen.getAllByText('No USD value').length).toBe(
      screen.getAllByText(/^-5 DEAD$/).length
    );
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

    render(<CryptoPage tab="crypto-transactions" onTabChange={vi.fn()} />);
    await showTransferLegs();

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

  // The inline Label button is the only place a wrong verdict is visible next
  // to the transfer it distorts, so it has to be able to write any verdict --
  // not just 'exchange', which is what a builtin pack row already claims.
  it('labels a counterparty with a chosen verdict from the activity feed', async () => {
    apiMocks.accounts.getAll.mockResolvedValue({ accounts: [CRYPTO_ACCOUNT] });
    apiMocks.eth.getWallets.mockResolvedValue({
      wallets: [{ id: 1, address: '0xaaaa000000000000000000000000000000000001', label: 'Main', eth_quantity: '2' }],
    });
    apiMocks.eth.getTransfers.mockResolvedValue({
      data: [{
        id: 31, wallet_id: 1, wallet_address: '0xaaaa000000000000000000000000000000000001',
        transfer_type: 'external', tx_hash: '0xshop00000', block_time: '2026-07-02T00:00:00Z',
        from_address: '0xaaaa000000000000000000000000000000000001',
        to_address: '0xcccc000000000000000000000000000000000003',
        value_wei: '1000000000000000000', is_error: false,
        counterparty_is_own: false, counterparty_exchange: null,
      }],
      pagination: { total: 1 },
    });
    apiMocks.eth.labelAddress.mockResolvedValue({ label: {} });

    render(<CryptoPage tab="crypto-transactions" onTabChange={vi.fn()} />);
    await showTransferLegs();
    await screen.findByText('On-chain Activity');

    // Desktop row and mobile card render together, so take the first form.
    fireEvent.click(screen.getAllByTitle(/label this address/i)[0]);
    const verdict = screen.getAllByLabelText('Counterparty verdict')[0];
    // Every address defaults to Keep; the server resolves it against any
    // hidden builtin so a rename can never re-vote a pack verdict.
    expect(verdict).toHaveValue('keep');
    fireEvent.change(verdict, { target: { value: 'external' } });
    fireEvent.click(screen.getAllByRole('button', { name: /^save$/i })[0]);

    await vi.waitFor(() => {
      // No name needed for this verdict: it never reaches classification, so
      // the server fills in a short address.
      expect(apiMocks.eth.labelAddress).toHaveBeenCalledWith(
        '0xcccc000000000000000000000000000000000003', null, { kind: 'external' }
      );
    });
  });

  it('links every transfer to its own chain’s explorer', async () => {
    // A hash exists only on the chain it was mined on: an Arbitrum tx looked up
    // on etherscan.io is simply "not found", which reads as though it never
    // happened. Legacy rows predate chain_id and are all mainnet's.
    apiMocks.accounts.getAll.mockResolvedValue({ accounts: [CRYPTO_ACCOUNT] });
    apiMocks.eth.getWallets.mockResolvedValue({
      wallets: [{ id: 1, address: '0xaaaa000000000000000000000000000000000001', label: 'Main', eth_quantity: '2' }],
    });
    const leg = (id, hash, chain_id) => ({
      id, chain_id, wallet_id: 1, wallet_address: '0xaaaa000000000000000000000000000000000001',
      transfer_type: 'external', tx_hash: hash, block_time: '2026-07-01T00:00:00Z',
      from_address: '0xaaaa000000000000000000000000000000000001',
      to_address: '0xcccc000000000000000000000000000000000003',
      value_wei: '1000000000000000000', is_error: false,
      counterparty_is_own: false, counterparty_exchange: null,
    });
    apiMocks.eth.getTransfers.mockResolvedValue({
      data: [leg(41, '0xarb00000', 42161), leg(42, '0xold00000', null), leg(43, '0xpol00000', 137)],
      pagination: { total: 3 },
    });

    render(<CryptoPage tab="crypto-transactions" onTabChange={vi.fn()} />);
    await showTransferLegs();
    await screen.findByText('On-chain Activity');

    expect(screen.getByTitle('0xarb00000').closest('a'))
      .toHaveAttribute('href', 'https://arbiscan.io/tx/0xarb00000');
    expect(screen.getByTitle('0xold00000').closest('a'))
      .toHaveAttribute('href', 'https://etherscan.io/tx/0xold00000');
    expect(screen.getByTitle('0xpol00000').closest('a'))
      .toHaveAttribute('href', 'https://polygonscan.com/tx/0xpol00000');
  });

  it('renders a Polygon transfer in POL, not in ether', async () => {
    // The amount and the symbol come from different places -- the value from
    // the row, the symbol from the chain -- so a missing chain lookup prints a
    // POL amount with an ETH ticker beside it, which is a wrong number as far
    // as any reader is concerned.
    apiMocks.accounts.getAll.mockResolvedValue({ accounts: [CRYPTO_ACCOUNT] });
    apiMocks.eth.getWallets.mockResolvedValue({
      wallets: [{ id: 1, address: '0xaaaa000000000000000000000000000000000001', label: 'Main', eth_quantity: '2' }],
    });
    apiMocks.eth.getTransfers.mockResolvedValue({
      data: [{
        id: 51, chain_id: 137, wallet_id: 1,
        wallet_address: '0xaaaa000000000000000000000000000000000001',
        transfer_type: 'native', tx_hash: '0xpol11111', block_time: '2026-07-01T00:00:00Z',
        from_address: '0xaaaa000000000000000000000000000000000001',
        to_address: '0xcccc000000000000000000000000000000000003',
        value_wei: '3000000000000000000', is_error: false,
        counterparty_is_own: false, counterparty_exchange: null,
      }],
      pagination: { total: 1 },
    });

    render(<CryptoPage tab="crypto-transactions" onTabChange={vi.fn()} />);
    await showTransferLegs();
    await screen.findByText('On-chain Activity');

    // Both layouts mount (the table and the mobile card), so this appears twice.
    expect((await screen.findAllByText(/3 POL/)).length).toBeGreaterThan(0);
    expect(screen.queryByText(/3 ETH/)).toBeNull();
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

    render(<CryptoPage tab="crypto-transactions" onTabChange={vi.fn()} />);

    // A <select> shows the label whole; the old tab strip had to truncate it.
    expect(await screen.findByRole('option', { name: LONG })).toBeInTheDocument();
  });

  it('reports the attention counts to the app shell for the sidebar badge', async () => {
    apiMocks.accounts.getAll.mockResolvedValue({ accounts: [CRYPTO_ACCOUNT] });
    apiMocks.eth.getWallets.mockResolvedValue({
      wallets: [
        { id: 1, address: '0xaaaa000000000000000000000000000000000001', label: 'Main', eth_quantity: '2', error_code: 'ETHERSCAN_RATE_LIMIT' },
        { id: 2, address: '0xbbbb000000000000000000000000000000000002', label: 'Cold', eth_quantity: '0' },
      ],
    });
    apiMocks.crypto.getLedgerSummary.mockResolvedValue({
      summary: { total: 5, needs_review_count: 3, onchain_count: 5, exchange_count: 0, matched_count: 0 },
    });
    const onAttentionChange = vi.fn();

    render(<CryptoPage tab="crypto-holdings" onTabChange={vi.fn()} onAttentionChange={onAttentionChange} />);

    // Every fetchData reports both numbers up, which is what lets the sidebar
    // badge drain live as review actions refetch this page's data.
    await vi.waitFor(() => {
      expect(onAttentionChange).toHaveBeenCalledWith({ errored: 1, needsReview: 3 });
    });
  });

  it('reports unknown as null, never zero, for a half that failed to fetch', async () => {
    // A red badge downgrading to all-clear because the wallets request
    // happened to fail is the lossy direction for an attention signal; the
    // shell merges nulls against what it already knows.
    apiMocks.accounts.getAll.mockResolvedValue({ accounts: [CRYPTO_ACCOUNT] });
    apiMocks.eth.getWallets.mockRejectedValue(new Error('backend blip'));
    apiMocks.crypto.getLedgerSummary.mockResolvedValue({
      summary: { total: 5, needs_review_count: 3, onchain_count: 5, exchange_count: 0, matched_count: 0 },
    });
    const onAttentionChange = vi.fn();

    render(<CryptoPage tab="crypto-holdings" onTabChange={vi.fn()} onAttentionChange={onAttentionChange} />);

    await vi.waitFor(() => {
      expect(onAttentionChange).toHaveBeenCalledWith({ errored: null, needsReview: 3 });
    });
  });

  it('offers Add Holding, the only route to creating a manual crypto holding', async () => {
    apiMocks.accounts.getAll.mockResolvedValue({
      accounts: [{ id: 12, name: 'Cold storage', effective_name: 'Cold storage', type: 'crypto', eth_wallet_id: null }],
    });

    render(<CryptoPage tab="crypto-holdings" onTabChange={vi.fn()} />);

    fireEvent.click(await screen.findByRole('button', { name: /add holding/i }));

    // "Add New Holding" is HoldingForm's create-mode heading; "Edit Holding"
    // would mean it opened prefilled and would take the update branch.
    expect(screen.getByRole('heading', { name: 'Add New Holding' })).toBeInTheDocument();
  });
});

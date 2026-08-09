import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import Settings from './Settings';

const apiMocks = vi.hoisted(() => ({
  accounts: {
    getAll: vi.fn(),
    updateDisplayName: vi.fn(),
    updateVisibility: vi.fn(),
  },
  plaid: {
    createLinkToken: vi.fn(),
    createUpdateLinkToken: vi.fn(),
    exchangeToken: vi.fn(),
    getItems: vi.fn(),
    syncItem: vi.fn(),
    removeItem: vi.fn(),
  },
  eth: {
    addWallet: vi.fn(),
    addWallets: vi.fn(),
    getWallets: vi.fn(),
    syncWallet: vi.fn(),
    removeWallet: vi.fn(),
    getTransfers: vi.fn(),
    getIgnoredTokens: vi.fn(),
    ignoreToken: vi.fn(),
    unignoreToken: vi.fn(),
    getAddressLabels: vi.fn(),
    labelAddress: vi.fn(),
    unlabelAddress: vi.fn(),
    getUnreviewedCounterparties: vi.fn(),
    getActivity: vi.fn(),
    setActivitySpam: vi.fn(),
  },
  keys: {
    getAll: vi.fn(),
    set: vi.fn(),
    clear: vi.fn(),
  },
  admin: {
    getOverview: vi.fn(),
    triggerJob: vi.fn(),
  },
  holdings: {
    create: vi.fn(),
  },
  exportData: {
    downloadHoldings: vi.fn(),
    downloadHistory: vi.fn(),
  },
  history: {
    getPortfolio: vi.fn(),
  },
  exchanges: {
    getAll: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    remove: vi.fn(),
    importCsv: vi.fn(),
    getRecords: vi.fn(),
    resolveRecord: vi.fn(),
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

describe('Settings display names', () => {
  // Admin-ness comes from the identity App already fetched via /api/me, not
  // from probing the admin API.
  const renderSettings = (user = { id: 2, username: 'alice', isAdmin: false }) => render(
    <MemoryRouter initialEntries={['/settings']}>
      <Settings user={user} />
    </MemoryRouter>
  );

  beforeEach(() => {
    vi.clearAllMocks();
    apiMocks.plaid.getItems.mockResolvedValue({ items: [] });
    apiMocks.eth.getWallets.mockResolvedValue({ wallets: [] });
    apiMocks.eth.getIgnoredTokens.mockResolvedValue({ tokens: [] });
    apiMocks.eth.getAddressLabels.mockResolvedValue({ labels: [] });
    // Every call in fetchItems' Promise.all needs a default here: an undefined
    // mock throws synchronously while the array is being built, and fetchItems'
    // try/catch swallows that into an error banner with no data rendered.
    apiMocks.eth.getUnreviewedCounterparties.mockResolvedValue({
      data: [], summary: { count: 0, dust_count: 0, usd_volume: 0 },
    });
    apiMocks.eth.getActivity.mockResolvedValue({
      data: [], summary: { spam_count: 0, needs_review_count: 0 }, pagination: { total: 0 },
    });
    apiMocks.exchanges.getAll.mockResolvedValue({ accounts: [] });
    apiMocks.admin.getOverview.mockRejectedValue({ response: { status: 403 } });
    apiMocks.keys.getAll.mockResolvedValue({
      encryptionConfigured: true,
      userKeys: {
        plaid_client_id: { source: 'none', masked: null },
        plaid_secret: { source: 'none', masked: null },
        etherscan: { source: 'none', masked: null },
        moralis: { source: 'none', masked: null },
      },
      appSettings: {
        cg_api_key: { source: 'none', masked: null },
        cmc_api_key: { source: 'none', masked: null },
      },
    });
    apiMocks.accounts.getAll.mockResolvedValue({
      accounts: [
        {
          id: 7,
          name: 'Bank of Example - Very Long Checking Account Name',
          display_name: null,
          effective_name: 'Bank of Example - Very Long Checking Account Name',
          is_hidden: false,
          type: 'depository',
          plaid_item_id: 3,
          holdings_count: 0,
        },
      ],
    });
    apiMocks.accounts.updateDisplayName.mockResolvedValue({ account: { id: 7, display_name: 'Checking' } });
    apiMocks.accounts.updateVisibility.mockResolvedValue({ account: { id: 7, is_hidden: true } });
  });

  const openAccountsTab = async () => {
    fireEvent.click(await screen.findByRole('tab', { name: 'Accounts' }));
  };

  it('opens the tab requested via navigation state', async () => {
    render(
      <MemoryRouter initialEntries={[{ pathname: '/settings', state: { tab: 'institutions' } }]}>
        <Settings />
      </MemoryRouter>
    );

    await screen.findByText('Institution Health');
    expect(screen.getByRole('tab', { name: 'Institutions' })).toHaveAttribute('aria-selected', 'true');
  });

  it('saves an account display name override', async () => {
    renderSettings();
    await openAccountsTab();

    const input = await screen.findByPlaceholderText('Bank of Example - Very Long Checking Account Name');
    fireEvent.change(input, { target: { value: 'Checking' } });
    fireEvent.click(screen.getByRole('button', { name: /save/i }));

    await waitFor(() => {
      expect(apiMocks.accounts.updateDisplayName).toHaveBeenCalledWith(7, 'Checking');
    });
  });

  it('renders API key statuses and saves a key', async () => {
    apiMocks.keys.getAll.mockResolvedValue({
      encryptionConfigured: true,
      userKeys: {
        plaid_client_id: { source: 'none', masked: null },
        plaid_secret: { source: 'env', masked: null },
        etherscan: { source: 'db', masked: '••••1234' },
        moralis: { source: 'none', masked: null },
      },
      appSettings: {
        cg_api_key: { source: 'none', masked: null },
        cmc_api_key: { source: 'none', masked: null },
      },
    });
    apiMocks.keys.set.mockResolvedValue({ service: 'etherscan', source: 'db', masked: '••••abcd' });
    renderSettings();
    fireEvent.click(await screen.findByRole('tab', { name: 'API Keys' }));

    await screen.findByText('Your Keys');
    expect(screen.getByText('Moralis API Key')).toBeInTheDocument();
    expect(screen.queryByText(/Coinbase CDP/)).not.toBeInTheDocument();
    expect(screen.getByText('••••1234')).toBeInTheDocument();
    expect(screen.getByText('Using server default')).toBeInTheDocument();
    // Only the stored (db) key row offers Clear.
    expect(screen.getAllByRole('button', { name: /clear/i })).toHaveLength(1);

    const input = screen.getByPlaceholderText('Replace key…');
    fireEvent.change(input, { target: { value: 'new-key-value' } });
    fireEvent.click(input.closest('form').querySelector('button[type="submit"]'));

    await waitFor(() => {
      expect(apiMocks.keys.set).toHaveBeenCalledWith('etherscan', 'new-key-value');
    });

    const moralisForm = screen.getByText('Moralis API Key').closest('form');
    const moralisInput = moralisForm.querySelector('input');
    fireEvent.change(moralisInput, { target: { value: 'moralis-key-value' } });
    fireEvent.click(moralisForm.querySelector('button[type="submit"]'));

    await waitFor(() => {
      expect(apiMocks.keys.set).toHaveBeenCalledWith('moralis', 'moralis-key-value');
    });
  });

  it('disables key inputs and explains when encryption is unconfigured', async () => {
    apiMocks.keys.getAll.mockResolvedValue({
      encryptionConfigured: false,
      userKeys: {
        plaid_client_id: { source: 'env', masked: null },
        plaid_secret: { source: 'env', masked: null },
        etherscan: { source: 'none', masked: null },
        moralis: { source: 'none', masked: null },
      },
      appSettings: {
        cg_api_key: { source: 'none', masked: null },
        cmc_api_key: { source: 'none', masked: null },
      },
    });
    renderSettings();
    fireEvent.click(await screen.findByRole('tab', { name: 'API Keys' }));

    await screen.findByText(/missing SECRETS_ENCRYPTION_KEY/);
    const inputs = screen.getAllByPlaceholderText('Paste key…');
    expect(inputs.every((input) => input.disabled)).toBe(true);
  });

  it('hides the Server tab for non-admins and never probes the admin API', async () => {
    renderSettings();
    await screen.findByRole('tab', { name: 'API Keys' });
    expect(screen.queryByRole('tab', { name: 'Server' })).not.toBeInTheDocument();
    expect(apiMocks.admin.getOverview).not.toHaveBeenCalled();
  });

  it('renders the Server tab for the admin with env, users, jobs, and health', async () => {
    apiMocks.admin.getOverview.mockResolvedValue({
      encryptionConfigured: true,
      appSettings: {
        cg_api_key: { source: 'db', masked: '••••7777' },
        cmc_api_key: { source: 'none', masked: null },
      },
      env: [
        // No last-4 for the key-encryption key: the server reports set/valid only.
        { name: 'SECRETS_ENCRYPTION_KEY', set: true, valid: true, masked: null },
        { name: 'MCP_API_KEY', set: true, masked: '••••abcd' },
        { name: 'DATABASE_URL', set: true, host: 'db.example.com' },
        { name: 'ALLOWED_PRINCIPALS', set: true, value: 'a@x.com,b@y.com' },
      ],
      users: [
        { id: 1, username: 'zachery', display_name: 'Zachery', is_admin: true, emails: ['a@x.com'], account_count: 3, wallet_count: 1, plaid_item_count: 2, configured_keys: ['etherscan'] },
        { id: 2, username: 'alice', display_name: null, is_admin: false, emails: ['b@y.com'], account_count: 1, wallet_count: 0, plaid_item_count: 0, configured_keys: [] },
      ],
      jobs: { jobs: { 'price-update': { schedule: '0 8 * * *', timezone: 'Etc/UTC', description: '', lastRun: null } } },
      health: { dbReachable: true, encryptionConfigured: true, latestPriceFetchedAt: null, migrationCount: 31 },
    });
    // The shared-key card reads live statuses from /api/keys (admins get
    // appSettings there), so the masked value comes from this mock.
    apiMocks.keys.getAll.mockResolvedValue({
      encryptionConfigured: true,
      userKeys: {
        plaid_client_id: { source: 'none', masked: null },
        plaid_secret: { source: 'none', masked: null },
        etherscan: { source: 'none', masked: null },
        moralis: { source: 'none', masked: null },
      },
      appSettings: {
        cg_api_key: { source: 'db', masked: '••••7777' },
        cmc_api_key: { source: 'none', masked: null },
      },
    });
    renderSettings({ id: 1, username: 'zachery', isAdmin: true });
    fireEvent.click(await screen.findByRole('tab', { name: 'Server' }));

    await screen.findByText('Market Data Keys');
    expect(screen.getByText('••••7777')).toBeInTheDocument();
    expect(screen.getByText('MCP_API_KEY')).toBeInTheDocument();
    expect(screen.getByText('••••abcd')).toBeInTheDocument();
    expect(screen.getByText('db.example.com')).toBeInTheDocument();
    expect(screen.getByText('Admin')).toBeInTheDocument();
    expect(screen.getByText('alice')).toBeInTheDocument();
    expect(screen.getByText('Never run')).toBeInTheDocument();
    expect(screen.getByText('Reachable')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /run now/i }));
    await waitFor(() => {
      expect(apiMocks.admin.triggerJob).toHaveBeenCalledWith('price-update');
    });
  });

  it('keeps the Server tab rendered when the post-trigger refresh fails', async () => {
    apiMocks.admin.getOverview.mockResolvedValueOnce({
      encryptionConfigured: true,
      appSettings: { cg_api_key: { source: 'none', masked: null }, cmc_api_key: { source: 'none', masked: null } },
      env: [{ name: 'MCP_API_KEY', set: true, masked: '••••abcd' }],
      users: [{ id: 1, username: 'zachery', display_name: null, is_admin: true, emails: [], account_count: 0, wallet_count: 0, plaid_item_count: 0, configured_keys: [] }],
      jobs: { jobs: { 'price-update': { schedule: '0 8 * * *', timezone: 'Etc/UTC', description: '', lastRun: null } } },
      health: { dbReachable: true, encryptionConfigured: true, latestPriceFetchedAt: null, migrationCount: 31 },
    });
    // The refresh after the trigger fails; the tab must survive it.
    apiMocks.admin.getOverview.mockRejectedValueOnce(new Error('network'));
    apiMocks.admin.triggerJob.mockResolvedValue({});

    renderSettings({ id: 1, username: 'zachery', isAdmin: true });
    fireEvent.click(await screen.findByRole('tab', { name: 'Server' }));
    await screen.findByText('Market Data Keys');

    fireEvent.click(screen.getByRole('button', { name: /run now/i }));

    await waitFor(() => expect(apiMocks.admin.triggerJob).toHaveBeenCalled());
    expect(screen.getByRole('tab', { name: 'Server' })).toBeInTheDocument();
    expect(screen.getByText('Market Data Keys')).toBeInTheDocument();
  });

  it('shows wallet-scan outcome counts and reports a background trigger as started', async () => {
    const completedOverview = {
      encryptionConfigured: true,
      appSettings: { cg_api_key: { source: 'none', masked: null }, cmc_api_key: { source: 'none', masked: null } },
      env: [],
      users: [],
      jobs: {
        jobs: {
          'eth-sync': {
            schedule: '50 7 * * *',
            timezone: 'Etc/UTC',
            description: '',
            lastRun: {
              status: 'completed',
              started_at: new Date().toISOString(),
              completed_at: new Date().toISOString(),
              tickers_processed: 2,
              tickers_succeeded: 2,
              tickers_failed: 0,
              details: { deferred: 0, unsupported: 1, unverified: 0, skipped: 0 },
            },
          },
        },
      },
      health: { dbReachable: true, encryptionConfigured: true, latestPriceFetchedAt: null, migrationCount: 75 },
    };
    apiMocks.admin.getOverview
      .mockResolvedValueOnce(completedOverview)
      .mockResolvedValueOnce({
        ...completedOverview,
        jobs: {
          jobs: {
            'eth-sync': {
              ...completedOverview.jobs.jobs['eth-sync'],
              lastRun: {
                status: 'running',
                started_at: new Date().toISOString(),
              },
            },
          },
        },
      })
      .mockResolvedValueOnce(completedOverview);
    apiMocks.admin.triggerJob.mockResolvedValue({
      status: 'started',
      result: { started: true, jobLogId: 91 },
    });

    renderSettings({ id: 1, username: 'zachery', isAdmin: true });
    fireEvent.click(await screen.findByRole('tab', { name: 'Server' }));

    const outcome = await screen.findByText(/2\/2 succeeded · 0 failed · 0 deferred · 1 unsupported/);
    expect(outcome.className).toContain('text-amber-400');

    fireEvent.click(screen.getByRole('button', { name: /run now/i }));
    expect(await screen.findByText(/Job started\. Live status and the final outcome appear below/)).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: 'Running' })).toBeDisabled();
    expect(await screen.findByText(
      /2\/2 succeeded · 0 failed · 0 deferred · 1 unsupported/,
      {},
      { timeout: 3000 }
    )).toBeInTheDocument();
    expect(apiMocks.admin.getOverview).toHaveBeenCalledTimes(3);
  });

  it('loads all accounts and toggles account visibility', async () => {
    renderSettings();
    await openAccountsTab();

    await screen.findByText('Account Display');
    expect(apiMocks.accounts.getAll).toHaveBeenCalledWith({ includeHidden: true });

    fireEvent.click(screen.getByRole('switch', { name: /hide bank of example/i }));

    await waitFor(() => {
      expect(apiMocks.accounts.updateVisibility).toHaveBeenCalledWith(7, true);
    });
  });
});

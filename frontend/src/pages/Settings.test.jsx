import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
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

  it('renders builtin labels without a remove button and user labels with one', async () => {
    apiMocks.eth.getAddressLabels.mockResolvedValue({
      labels: [
        { address: '0x1111111111111111111111111111111111111111', name: 'Coinbase', source: 'builtin', note: 'Etherscan tag: Coinbase 1' },
        { address: '0x2222222222222222222222222222222222222222', name: 'My Deposit', source: 'user', note: null },
      ],
    });
    renderSettings();
    fireEvent.click(await screen.findByRole('tab', { name: 'Ethereum' }));

    await screen.findByText('Labeled Addresses');
    expect(await screen.findByText('Built-in')).toBeInTheDocument();
    // Exactly one Remove button: the user row's. The builtin row has none.
    // Scoped to this section so a button added elsewhere on the tab can't trip it.
    const labeled = within(screen.getByRole('region', { name: /labeled addresses/i }));
    expect(labeled.getAllByRole('button', { name: /remove/i })).toHaveLength(1);
    expect(screen.getByText('My Deposit')).toBeInTheDocument();
  });

  // Thousands of addresses arrive pre-labeled from the builtin pack, and a
  // wrong 'exchange' among them rewrites real spending as an internal transfer.
  // This form is where that gets corrected, so the verdict has to be reachable
  // -- and a rename must not silently re-vote.
  describe('label form verdicts', () => {
    const openLabelForm = async (labels = []) => {
      apiMocks.eth.getAddressLabels.mockResolvedValue({ labels });
      apiMocks.eth.labelAddress.mockResolvedValue({ label: {} });
      renderSettings();
      fireEvent.click(await screen.findByRole('tab', { name: /Ethereum/ }));
      await screen.findByText('Labeled Addresses');
      // Scoped: the wallet form higher up the tab has its own 0x… input.
      const form = within(screen.getByRole('region', { name: /labeled addresses/i }));
      return {
        address: form.getByPlaceholderText('0x…'),
        name: form.getByPlaceholderText('Coinbase'),
        verdict: form.getByRole('combobox', { name: /verdict/i }),
        submit: form.getByRole('button', { name: /label address/i }),
      };
    };

    it('defaults every address to Keep and lets the server resolve the verdict', async () => {
      const form = await openLabelForm();
      fireEvent.change(form.address, { target: { value: '0x3333333333333333333333333333333333333333' } });
      fireEvent.change(form.name, { target: { value: 'Coinbase' } });
      expect(form.verdict).toHaveValue('keep');

      fireEvent.click(form.submit);
      // kind undefined omits the field: the server inherits a builtin's
      // verdict when one exists (the scraped pack is hidden from this list,
      // so the client cannot know) and treats only a truly unjudged address
      // as an exchange. Defaulting to 'exchange' here re-voted hidden pack
      // 'external' gateways on a plain rename.
      await waitFor(() => {
        expect(apiMocks.eth.labelAddress).toHaveBeenCalledWith(
          '0x3333333333333333333333333333333333333333', 'Coinbase', { kind: undefined }
        );
      });
    });

    it('marks an address as an outside party with no name typed', async () => {
      const form = await openLabelForm();
      fireEvent.change(form.address, { target: { value: '0x3333333333333333333333333333333333333333' } });
      fireEvent.change(form.verdict, { target: { value: 'external' } });
      fireEvent.click(form.submit);

      // The name is optional for this verdict -- it never reaches
      // classification, so the server falls back to a short address.
      await waitFor(() => {
        expect(apiMocks.eth.labelAddress).toHaveBeenCalledWith(
          '0x3333333333333333333333333333333333333333', null, { kind: 'external' }
        );
      });
    });

    it('renaming an already-labeled address keeps its verdict by sending no kind', async () => {
      const form = await openLabelForm([
        { address: '0x2222222222222222222222222222222222222222', name: 'Cold storage', kind: 'own', source: 'user' },
      ]);
      fireEvent.change(form.address, { target: { value: '0x2222222222222222222222222222222222222222' } });
      expect(form.verdict).toHaveValue('keep');
      fireEvent.change(form.name, { target: { value: 'Ledger' } });
      fireEvent.click(form.submit);

      // kind undefined omits the field, which the API reads as "keep the
      // current verdict". Writing 'exchange' here would drop the address out of
      // the own set and turn a self-transfer into a phantom exchange deposit.
      await waitFor(() => {
        expect(apiMocks.eth.labelAddress).toHaveBeenCalledWith(
          '0x2222222222222222222222222222222222222222', 'Ledger', { kind: undefined }
        );
      });
    });
  });

  describe('unknown counterparty triage', () => {
    const WALLET = { id: 1, address: '0xaaaa000000000000000000000000000000000001', account: null, error_code: null };
    const MATERIAL = {
      address: '0xbbbb000000000000000000000000000000000002',
      transfer_count: 3,
      sent_count: 3,
      usd_volume: 12403,
      material: true,
      first_seen: '2026-02-11T04:15:00Z',
      last_seen: '2026-07-19T22:03:00Z',
      token_symbols: [],
      sole_token_contract: null,
    };
    const dust = (suffix) => ({
      ...MATERIAL,
      address: `0xdddd00000000000000000000000000000000000${suffix}`,
      transfer_count: 1,
      sent_count: 0,
      usd_volume: 0,
      material: false,
    });

    const openEthTab = async (queue = { data: [MATERIAL], summary: { count: 1, dust_count: 0, usd_volume: 12403 } }) => {
      apiMocks.eth.getWallets.mockResolvedValue({ wallets: [WALLET] });
      apiMocks.eth.getUnreviewedCounterparties.mockResolvedValue(queue);
      renderSettings();
      // Loose match: the attention badge appends its count to the tab's
      // accessible name whenever there is anything to review.
      fireEvent.click(await screen.findByRole('tab', { name: /Ethereum/ }));
      await screen.findByText('Needs Review');
    };

    it('renders an unreviewed counterparty with its volume and a You sent pill', async () => {
      await openEthTab();
      expect(screen.getByText('0xbbbb…0002')).toBeInTheDocument();
      expect(screen.getByText('3 transfers')).toBeInTheDocument();
      expect(screen.getByText('You sent')).toBeInTheDocument();
    });

    it('marks a counterparty as an outside party in one click', async () => {
      apiMocks.eth.labelAddress.mockResolvedValue({ label: {} });
      await openEthTab();

      fireEvent.click(screen.getByRole('button', { name: /outside party — 0xbbbb/i }));
      await waitFor(() => {
        expect(apiMocks.eth.labelAddress).toHaveBeenCalledWith(MATERIAL.address, null, { kind: 'external' });
      });
      // The full refetch is what drops the queue row and moves the badge.
      await waitFor(() => expect(apiMocks.eth.getUnreviewedCounterparties).toHaveBeenCalledTimes(2));
    });

    it('requires a second click to act on "It\'s mine", then splits track from label', async () => {
      apiMocks.eth.labelAddress.mockResolvedValue({ label: {} });
      apiMocks.eth.addWallet.mockResolvedValue({});
      await openEthTab();

      // Opening the panel must not itself be a verdict -- tracking creates an
      // account and runs a full sync, so it has to confirm.
      fireEvent.click(screen.getByRole('button', { name: /it's mine — 0xbbbb/i }));
      expect(apiMocks.eth.labelAddress).not.toHaveBeenCalled();
      expect(apiMocks.eth.addWallet).not.toHaveBeenCalled();

      fireEvent.click(screen.getByRole('button', { name: /mine, don't track it — 0xbbbb/i }));
      await waitFor(() => {
        // An empty optional name goes as null, so the backend falls back to the
        // short address rather than storing a blank label.
        expect(apiMocks.eth.labelAddress).toHaveBeenCalledWith(MATERIAL.address, null, { kind: 'own' });
      });
      expect(apiMocks.eth.addWallet).not.toHaveBeenCalled();
    });

    it('routes "Track as a wallet" through addWallet, not labelAddress', async () => {
      apiMocks.eth.addWallet.mockResolvedValue({});
      await openEthTab();

      fireEvent.click(screen.getByRole('button', { name: /it's mine — 0xbbbb/i }));
      fireEvent.click(screen.getByRole('button', { name: /track as a wallet — 0xbbbb/i }));
      await waitFor(() => expect(apiMocks.eth.addWallet).toHaveBeenCalledWith(MATERIAL.address, null));
      expect(apiMocks.eth.labelAddress).not.toHaveBeenCalled();
    });

    it('counts only material counterparties and wallet errors in the tab badge', async () => {
      // 1 errored wallet + 1 material + 3 dust must read 2, not 5. A badge that
      // cannot reach zero gets ignored, taking sync errors down with it.
      apiMocks.eth.getWallets.mockResolvedValue({
        wallets: [WALLET, { ...WALLET, id: 2, address: '0xaaaa000000000000000000000000000000000003', error_code: 'RATE_LIMIT' }],
      });
      apiMocks.eth.getUnreviewedCounterparties.mockResolvedValue({
        data: [MATERIAL, dust('4'), dust('5'), dust('6')],
        summary: { count: 1, dust_count: 3, usd_volume: 12403 },
      });
      renderSettings();

      const tab = await screen.findByRole('tab', { name: /Ethereum/ });
      await waitFor(() => expect(within(tab).getByText('2')).toBeInTheDocument());
    });

    it('shows per-chain state, including gaps the wallet badge deliberately omits', async () => {
      // The wallet badge carries transient failures only, so a chain (or a feed
      // on one) this Etherscan key cannot serve would otherwise be invisible --
      // and an unfetched feed means derived figures there are incomplete.
      apiMocks.eth.getWallets.mockResolvedValue({
        wallets: [{
          ...WALLET,
          chains: [
            { chain_id: 1, name: 'Ethereum', enabled: true, error_code: null, unsupported_feeds: [], last_synced_at: '2026-07-26T09:00:00Z' },
            { chain_id: 42161, name: 'Arbitrum One', enabled: true, error_code: 'FEED_UNSUPPORTED', error_message: 'internal unavailable on Arbitrum One; derived balances there may drift', unsupported_feeds: ['internal'], last_synced_at: '2026-07-26T09:00:00Z' },
            { chain_id: 8453, name: 'Base', enabled: false, error_code: null, unsupported_feeds: [], last_synced_at: null },
          ],
        }],
      });
      apiMocks.eth.getUnreviewedCounterparties.mockResolvedValue({ data: [], summary: { count: 0, dust_count: 0, usd_volume: 0 } });
      renderSettings();
      fireEvent.click(await screen.findByRole('tab', { name: /Ethereum/ }));

      expect(await screen.findByText('Arbitrum One')).toBeInTheDocument();
      // The gap is named, not just flagged: "no internal" is what tells the user
      // (and #62) which derived numbers may drift.
      expect(screen.getByText('no internal')).toBeInTheDocument();
      // A switched-off chain reads as off while keeping its row -- disabling
      // stops the sync, it does not delete history.
      expect(screen.getByText('Base')).toBeInTheDocument();
      expect(screen.getByText('off')).toBeInTheDocument();
      // And none of this touches the wallet-level attention badge.
      const tab = screen.getByRole('tab', { name: /Ethereum/ });
      expect(within(tab).queryByText('1')).toBeNull();
    });

    it('shows a single chain’s standing gap, which a chain-count gate hid entirely', async () => {
      // ETH_CHAINS=1 (or any wallet down to one chain) still has to report a
      // feed its key cannot serve: the wallet badge deliberately omits standing
      // gaps, so gating the strip on "more than one chain" made the only
      // surface that reports them disappear.
      apiMocks.eth.getWallets.mockResolvedValue({
        wallets: [{
          ...WALLET,
          chains: [
            { chain_id: 1, name: 'Ethereum', enabled: true, error_code: 'FEED_UNSUPPORTED', error_message: 'internal unavailable on Ethereum; derived balances there may drift', unsupported_feeds: ['internal'], last_synced_at: '2026-07-26T09:00:00Z' },
          ],
        }],
      });
      apiMocks.eth.getUnreviewedCounterparties.mockResolvedValue({ data: [], summary: { count: 0, dust_count: 0, usd_volume: 0 } });
      renderSettings();
      fireEvent.click(await screen.findByRole('tab', { name: /Ethereum/ }));

      expect(await screen.findByText('no internal')).toBeInTheDocument();
    });

    it('stays quiet for a single healthy chain', async () => {
      // Nothing to say: one chain, no gap, no error. The strip would just be
      // a permanent "Ethereum" chip.
      apiMocks.eth.getWallets.mockResolvedValue({
        wallets: [{
          ...WALLET,
          chains: [
            { chain_id: 1, name: 'Ethereum', enabled: true, error_code: null, unsupported_feeds: [], last_synced_at: '2026-07-26T09:00:00Z' },
          ],
        }],
      });
      apiMocks.eth.getUnreviewedCounterparties.mockResolvedValue({ data: [], summary: { count: 0, dust_count: 0, usd_volume: 0 } });
      renderSettings();
      fireEvent.click(await screen.findByRole('tab', { name: /Ethereum/ }));

      // The wallet card is rendered; the chain strip inside it is not.
      await screen.findByRole('button', { name: /sync/i });
      expect(screen.queryByText('Ethereum', { selector: 'span' })).toBeNull();
    });

    it('collapses low-value counterparties behind a disclosure', async () => {
      await openEthTab({
        data: [MATERIAL, dust('4'), dust('5')],
        summary: { count: 1, dust_count: 2, usd_volume: 12403 },
      });

      expect(screen.queryByText('0xdddd…0004')).toBeNull();
      fireEvent.click(screen.getByRole('button', { name: /2 low-value counterparties/i }));
      expect(screen.getByText('0xdddd…0004')).toBeInTheDocument();
    });

    it('keeps own labels in the main list and collapses outside parties', async () => {
      apiMocks.eth.getAddressLabels.mockResolvedValue({
        labels: [
          { address: '0x4444444444444444444444444444444444444444', name: 'Ledger', source: 'user', kind: 'own' },
          { address: '0x5555555555555555555555555555555555555555', name: 'Some stranger', source: 'user', kind: 'external' },
        ],
      });
      await openEthTab();

      expect(screen.getByText('Ledger')).toBeInTheDocument();
      expect(screen.getByText('Yours')).toBeInTheDocument();
      expect(screen.queryByText('Some stranger')).toBeNull();
      fireEvent.click(screen.getByRole('button', { name: /1 reviewed as outside parties/i }));
      expect(screen.getByText('Some stranger')).toBeInTheDocument();
    });

    it('confirms before ignoring a token, since the ignore list is user-global', async () => {
      apiMocks.eth.ignoreToken.mockResolvedValue({});
      await openEthTab({
        data: [{ ...MATERIAL, token_symbols: ['SCAM'], sole_token_contract: '0xc0ffee' }],
        summary: { count: 1, dust_count: 0, usd_volume: 0 },
      });

      // sole_token_contract only proves THIS counterparty deals in one token.
      // Ignoring drops the position from every wallet, so if the same token was
      // also acquired legitimately, one stray click would delete a real holding.
      fireEvent.click(screen.getByRole('button', { name: /^ignore scam — 0xbbbb/i }));
      expect(apiMocks.eth.ignoreToken).not.toHaveBeenCalled();
      expect(screen.getByText(/removes it from holdings and activity in/i)).toBeInTheDocument();

      fireEvent.click(screen.getByRole('button', { name: /ignore scam everywhere — 0xbbbb/i }));
      await waitFor(() => expect(apiMocks.eth.ignoreToken).toHaveBeenCalledWith('0xc0ffee', 'SCAM'));
    });

    it('shows a retry state when the queue fetch fails rather than claiming all clear', async () => {
      apiMocks.eth.getWallets.mockResolvedValue({ wallets: [WALLET] });
      apiMocks.eth.getUnreviewedCounterparties.mockRejectedValue(new Error('boom'));
      renderSettings();
      fireEvent.click(await screen.findByRole('tab', { name: /Ethereum/ }));

      await screen.findByText('Needs Review');
      // Rendering "every counterparty has been reviewed" here would be the same
      // silence this section exists to break.
      expect(screen.queryByText(/every counterparty has been reviewed/i)).toBeNull();
      expect(screen.getByText(/couldn't load the review queue/i)).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /retry/i })).toBeInTheDocument();
      // One endpoint failing must not surface a page-level error.
      expect(screen.queryByText(/failed to load/i)).toBeNull();
    });
  });

  // The spam quarantine (#74). The section exists to make the quarantine
  // inspectable and reversible: hiding rows is only acceptable if the user can
  // see how many were hidden, why, and get any of them back in one click.
  describe('quarantined spam', () => {
    const WALLET = { id: 1, address: '0xaaaa000000000000000000000000000000000001', account: null, error_code: null };
    const POISONED = {
      wallet_id: 1,
      chain_id: 1,
      tx_hash: `0x${'1'.repeat(64)}`,
      block_time: '2026-07-19T22:03:00Z',
      category: 'receive',
      spam: true,
      spam_reason: 'address_poisoning',
      legs: [{ asset: 'ETH', direction: 'in', amount: '0.00001' }],
    };

    const openEthTab = async (spamResult) => {
      apiMocks.eth.getWallets.mockResolvedValue({ wallets: [WALLET] });
      if (spamResult !== undefined) apiMocks.eth.getActivity.mockResolvedValue(spamResult);
      renderSettings();
      fireEvent.click(await screen.findByRole('tab', { name: /Ethereum/ }));
      await screen.findByText('Quarantined');
    };

    it('says nothing was quarantined when nothing was', async () => {
      await openEthTab();
      expect(screen.getByText(/nothing has been quarantined/i)).toBeInTheDocument();
    });

    it('reports the count, the reason and the amount, and warns about poisoning', async () => {
      await openEthTab({
        data: [POISONED],
        summary: { spam_count: 1, needs_review_count: 0 },
        pagination: { total: 1 },
      });

      // The server's count, not the page's: the list is capped.
      expect(screen.getByText(/^1 quarantined transaction$/)).toBeInTheDocument();
      fireEvent.click(screen.getByRole('button', { name: /quarantined transaction/i }));

      expect(screen.getByText('Lookalike address')).toBeInTheDocument();
      // The security warning is the whole reason the server stores a reason
      // CODE rather than prose -- this line must not appear on a dust airdrop.
      expect(screen.getByText(/never copy an address out of transaction history/i)).toBeInTheDocument();
      // What moved is still on the row: hidden is not deleted.
      expect(screen.getByText('+0.00001 ETH')).toBeInTheDocument();
    });

    it('restores a false positive in one click, chain and all', async () => {
      apiMocks.eth.setActivitySpam.mockResolvedValue({ override: {} });
      await openEthTab({
        data: [{ ...POISONED, chain_id: 42161 }],
        summary: { spam_count: 1, needs_review_count: 0 },
        pagination: { total: 1 },
      });
      fireEvent.click(screen.getByRole('button', { name: /quarantined transaction/i }));

      fireEvent.click(screen.getByRole('button', { name: /not spam/i }));
      await waitFor(() => {
        // The chain id rides along: a hash only identifies a transaction
        // together with its chain (039).
        expect(apiMocks.eth.setActivitySpam).toHaveBeenCalledWith(1, POISONED.tx_hash, false, { chainId: 42161 });
      });
      // The full refetch is what brings the row back and puts its counterparty
      // back into Needs Review.
      await waitFor(() => expect(apiMocks.eth.getActivity).toHaveBeenCalledTimes(2));
    });

    it('pages through the whole quarantine, so a rescue stays reachable in a spam wave', async () => {
      // This section is the ONLY place "Not spam" exists. A hard cap at one page
      // would mean the transaction most worth rescuing -- the real one buried
      // under a wave of airdrops -- is the one that cannot be reached.
      const row = (n) => ({ ...POISONED, tx_hash: `0x${String(n).padStart(64, '0')}` });
      await openEthTab({
        data: [row(1), row(2)],
        summary: { spam_count: 4, needs_review_count: 0 },
        pagination: { total: 4 },
      });
      fireEvent.click(screen.getByRole('button', { name: /quarantined transactions/i }));
      expect(screen.getByText(/showing the 2 most recent of 4/i)).toBeInTheDocument();

      apiMocks.eth.getActivity.mockResolvedValue({
        // Row 2 comes back a second time: a rescue on an earlier page shifts
        // everything below it up, and the same transaction must not render twice.
        data: [row(2), row(3)],
        summary: { spam_count: 4, needs_review_count: 0 },
        pagination: { total: 4 },
      });
      fireEvent.click(screen.getByRole('button', { name: /show more/i }));

      await waitFor(() => {
        expect(apiMocks.eth.getActivity).toHaveBeenLastCalledWith({
          spam: 'only', limit: 50, offset: 2,
        });
      });
      await waitFor(() => expect(screen.getByText(/showing the 3 most recent of 4/i)).toBeInTheDocument());
      expect(screen.getAllByRole('button', { name: /not spam/i })).toHaveLength(3);
    });

    it('shows a retry state when the quarantine fetch fails rather than claiming it hid nothing', async () => {
      apiMocks.eth.getWallets.mockResolvedValue({ wallets: [WALLET] });
      apiMocks.eth.getActivity.mockRejectedValue(new Error('boom'));
      renderSettings();
      fireEvent.click(await screen.findByRole('tab', { name: /Ethereum/ }));

      await screen.findByText('Quarantined');
      expect(screen.queryByText(/nothing has been quarantined/i)).toBeNull();
      expect(screen.getByText(/couldn't load the quarantine/i)).toBeInTheDocument();
      expect(screen.queryByText(/failed to load/i)).toBeNull();
    });
  });

  it('renders API key statuses and saves a key', async () => {
    apiMocks.keys.getAll.mockResolvedValue({
      encryptionConfigured: true,
      userKeys: {
        plaid_client_id: { source: 'none', masked: null },
        plaid_secret: { source: 'env', masked: null },
        etherscan: { source: 'db', masked: '••••1234' },
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
  });

  it('disables key inputs and explains when encryption is unconfigured', async () => {
    apiMocks.keys.getAll.mockResolvedValue({
      encryptionConfigured: false,
      userKeys: {
        plaid_client_id: { source: 'env', masked: null },
        plaid_secret: { source: 'env', masked: null },
        etherscan: { source: 'none', masked: null },
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

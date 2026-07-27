import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import CryptoPage from './CryptoPage';

// Address labels and ignored tokens, on the Crypto page's Labels tab (#75,
// moved off Settings). Thousands of addresses arrive pre-labeled from the
// builtin pack, and a wrong 'exchange' among them rewrites real spending as an
// internal transfer -- this form is where that gets corrected, so the verdict
// has to be reachable, and a rename must not silently re-vote.

const apiMocks = vi.hoisted(() => ({
  accounts: { getAll: vi.fn() },
  holdings: { getAll: vi.fn(), create: vi.fn(), update: vi.fn(), delete: vi.fn() },
  history: { getAccounts: vi.fn() },
  crypto: { getLedger: vi.fn(), getLedgerSummary: vi.fn(), ledgerExportUrl: vi.fn() },
  eth: {
    addWallet: vi.fn(), addWallets: vi.fn(), getWallets: vi.fn(), syncWallet: vi.fn(), removeWallet: vi.fn(),
    getTransfers: vi.fn(), getIgnoredTokens: vi.fn(), ignoreToken: vi.fn(), unignoreToken: vi.fn(),
    getAddressLabels: vi.fn(), labelAddress: vi.fn(), unlabelAddress: vi.fn(),
    getUnreviewedCounterparties: vi.fn(), getActivity: vi.fn(), setActivitySpam: vi.fn(),
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
  apiMocks.exchanges.getAll.mockResolvedValue({ accounts: [] });
  apiMocks.accounts.getAll.mockResolvedValue({ accounts: [] });
  apiMocks.holdings.getAll.mockResolvedValue({ holdings: [] });
  apiMocks.history.getAccounts.mockResolvedValue({ data: [] });
  apiMocks.crypto.getLedgerSummary.mockResolvedValue({ summary: { total: 0, needs_review_count: 0 } });
  apiMocks.crypto.getLedger.mockResolvedValue({ data: [], pagination: { total: 0 } });
});

const openLabelsTab = async (labels = []) => {
  apiMocks.eth.getAddressLabels.mockResolvedValue({ labels });
  render(<CryptoPage tab="crypto-labels" onTabChange={vi.fn()} />);
  await screen.findByText('Labeled Addresses');
};

describe('Crypto -> Labels tab', () => {
  it('renders builtin labels without a remove button and user labels with one', async () => {
    await openLabelsTab([
      { address: '0x1111111111111111111111111111111111111111', name: 'Coinbase', source: 'builtin', note: 'Etherscan tag: Coinbase 1' },
      { address: '0x2222222222222222222222222222222222222222', name: 'My Deposit', source: 'user', note: null },
    ]);

    expect(await screen.findByText('Built-in')).toBeInTheDocument();
    // Exactly one Remove button: the user row's. The builtin row has none.
    // Scoped to this section so a button added elsewhere on the tab can't trip it.
    const labeled = within(screen.getByRole('region', { name: /labeled addresses/i }));
    expect(labeled.getAllByRole('button', { name: /remove/i })).toHaveLength(1);
    expect(screen.getByText('My Deposit')).toBeInTheDocument();
  });

  it('keeps own labels in the main list and collapses outside parties', async () => {
    await openLabelsTab([
      { address: '0x4444444444444444444444444444444444444444', name: 'Ledger', source: 'user', kind: 'own' },
      { address: '0x5555555555555555555555555555555555555555', name: 'Some stranger', source: 'user', kind: 'external' },
    ]);

    expect(await screen.findByText('Ledger')).toBeInTheDocument();
    expect(screen.getByText('Yours')).toBeInTheDocument();
    expect(screen.queryByText('Some stranger')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /1 reviewed as outside parties/i }));
    expect(screen.getByText('Some stranger')).toBeInTheDocument();
  });

  describe('label form verdicts', () => {
    const openLabelForm = async (labels = []) => {
      apiMocks.eth.labelAddress.mockResolvedValue({ label: {} });
      await openLabelsTab(labels);
      // Scoped: the ignored-token form lower down has its own 0x… input.
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

    it('marks an address as a bridge with no name typed', async () => {
      const form = await openLabelForm();
      fireEvent.change(form.address, { target: { value: '0x3333333333333333333333333333333333333333' } });
      fireEvent.change(form.verdict, { target: { value: 'bridge' } });
      fireEvent.click(form.submit);

      // Like external and own, a bridge name is display-only -- it never
      // becomes counterparty_exchange -- so the server falls back to a short
      // address. Bridges redeploy faster than any seed can follow, which is why
      // this verdict is offered by hand at all.
      await waitFor(() => {
        expect(apiMocks.eth.labelAddress).toHaveBeenCalledWith(
          '0x3333333333333333333333333333333333333333', null, { kind: 'bridge' }
        );
      });
    });

    it('lists a seeded bridge label so a wrong one is correctable', async () => {
      // The 5k scraped rows are hidden from this list; the few dozen bridge
      // rows are not. A wrong bridge address has to be visible to be fixed.
      await openLabelForm([
        {
          address: '0x4dbd4fc535ac27206064b68ffcf827b0a60bab3f',
          name: 'Arbitrum: Delayed Inbox',
          kind: 'bridge',
          source: 'builtin-bridge',
        },
      ]);
      expect(await screen.findByText('Arbitrum: Delayed Inbox')).toBeInTheDocument();
      expect(screen.getByText('Bridge')).toBeInTheDocument();
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

  it('ignores a token and lists it with an undo', async () => {
    apiMocks.eth.ignoreToken.mockResolvedValue({});
    apiMocks.eth.getIgnoredTokens.mockResolvedValue({
      tokens: [{ contract_address: '0x6b175474e89094c44da98b954eedeac495271d0f', symbol: 'SCAM' }],
    });
    await openLabelsTab();

    const heading = await screen.findByText('Ignored Tokens');
    const form = within(heading.closest('section'));
    fireEvent.change(form.getByPlaceholderText('0x…'), {
      target: { value: '0x6b175474e89094c44da98b954eedeac495271d0f' },
    });
    fireEvent.change(form.getByPlaceholderText('SCAM'), { target: { value: 'SCAM' } });
    fireEvent.click(form.getByRole('button', { name: /ignore token/i }));

    await waitFor(() => {
      expect(apiMocks.eth.ignoreToken).toHaveBeenCalledWith('0x6b175474e89094c44da98b954eedeac495271d0f', 'SCAM');
    });
    // Ignoring drops the token from balance derivation, so it has to stay
    // listed with a one-click undo rather than vanishing silently.
    expect(await screen.findByRole('button', { name: /unignore/i })).toBeInTheDocument();
  });
});

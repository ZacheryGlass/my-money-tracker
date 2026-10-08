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
  crypto: {
    getLedger: vi.fn(), getLedgerSummary: vi.fn(), ledgerExportUrl: vi.fn(),
    getBridgeAudit: vi.fn(), setBridgeVerdict: vi.fn(), clearBridgeVerdict: vi.fn(),
  },
  eth: {
    addWallet: vi.fn(), addWallets: vi.fn(), getWallets: vi.fn(), syncWallet: vi.fn(), removeWallet: vi.fn(),
    getTransfers: vi.fn(), getIgnoredTokens: vi.fn(), ignoreToken: vi.fn(), unignoreToken: vi.fn(),
    getAddressLabels: vi.fn(), labelAddress: vi.fn(), unlabelAddress: vi.fn(),
    getAddressNotes: vi.fn(), saveAddressNote: vi.fn(), deleteAddressNote: vi.fn(),
    getUnreviewedCounterparties: vi.fn(), getActivity: vi.fn(), setActivitySpam: vi.fn(),
  },
  exchanges: {
    getAll: vi.fn(), create: vi.fn(), update: vi.fn(), remove: vi.fn(),
    importCsv: vi.fn(), getRecords: vi.fn(), resolveRecord: vi.fn(),
    getBalanceExceptions: vi.fn(),
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
  apiMocks.eth.getAddressNotes.mockResolvedValue({ notes: [] });
  apiMocks.eth.getUnreviewedCounterparties.mockResolvedValue({
    data: [], summary: { count: 0, dust_count: 0, usd_volume: 0 },
  });
  apiMocks.eth.getActivity.mockResolvedValue({
    data: [], summary: { spam_count: 0, needs_review_count: 0 }, pagination: { total: 0 },
  });
  apiMocks.exchanges.getAll.mockResolvedValue({ accounts: [] });
  apiMocks.exchanges.getBalanceExceptions.mockResolvedValue({ summary: { count: 0 } });
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
  it('asks before removing a label, since it reclassifies past transfers', async () => {
    apiMocks.eth.unlabelAddress.mockResolvedValue({});
    await openLabelsTab([{
      address: '0x3333333333333333333333333333333333333333', name: 'My Coinbase', kind: 'exchange', source: 'user', builtin: false,
    }]);

    fireEvent.click(screen.getByRole('button', { name: /^remove$/i }));
    const confirm = await screen.findByRole('dialog', { name: 'Remove this label?' });
    expect(apiMocks.eth.unlabelAddress).not.toHaveBeenCalled();
    fireEvent.click(within(confirm).getByRole('button', { name: 'Remove label' }));

    await waitFor(() => {
      expect(apiMocks.eth.unlabelAddress).toHaveBeenCalledWith('0x3333333333333333333333333333333333333333');
    });
  });

  it('says the labels failed to load instead of claiming none exist', async () => {
    apiMocks.eth.getAddressLabels.mockRejectedValue(new Error('boom'));
    render(<CryptoPage tab="crypto-labels" onTabChange={vi.fn()} />);

    expect(await screen.findByText("Couldn't load your address labels.")).toBeInTheDocument();
    expect(screen.queryByText('No addresses are labeled.')).toBeNull();
  });

  it('renders builtin labels without a remove button and user labels with one', async () => {
    await openLabelsTab([
      { address: '0x1111111111111111111111111111111111111111', name: 'Coinbase', source: 'builtin', builtin: true, note: 'Etherscan tag: Coinbase 1' },
      { address: '0x2222222222222222222222222222222222222222', name: 'My Deposit', source: 'user', note: null },
    ]);

    // The pill on the row (the filter strip also has a Built-in segment).
    const builtinRow = (await screen.findByText('Coinbase')).closest('.px-4');
    expect(within(builtinRow).getByText('Built-in')).toBeInTheDocument();
    expect(within(builtinRow).getByRole('button', { name: 'Override' })).toBeInTheDocument();
    // Exactly one Remove button: the user row's. The builtin row has none.
    // Scoped to this section so a button added elsewhere on the tab can't trip it.
    const labeled = within(screen.getByRole('region', { name: /labeled addresses/i }));
    expect(labeled.getAllByRole('button', { name: /remove/i })).toHaveLength(1);
    expect(screen.getByText('My Deposit')).toBeInTheDocument();
  });

  it('narrows the list by verdict and by search, and edits a label in place', async () => {
    apiMocks.eth.labelAddress.mockResolvedValue({ label: {} });
    await openLabelsTab([
      { address: '0x4444444444444444444444444444444444444444', name: 'Ledger', source: 'user', kind: 'own' },
      { address: '0x6666666666666666666666666666666666666666', name: 'Kraken deposit', source: 'user', kind: 'exchange' },
      { address: '0x5555555555555555555555555555555555555555', name: 'Some stranger', source: 'user', kind: 'external' },
    ]);

    fireEvent.click(within(screen.getByRole('group', { name: 'Show' })).getByRole('button', { name: 'Exchanges' }));
    expect(screen.getByText('Kraken deposit')).toBeInTheDocument();
    expect(screen.queryByText('Ledger')).toBeNull();

    fireEvent.click(within(screen.getByRole('group', { name: 'Show' })).getByRole('button', { name: 'All' }));
    fireEvent.change(screen.getByLabelText('Search labels'), { target: { value: 'stranger' } });
    expect(screen.getByText('Some stranger')).toBeInTheDocument();
    expect(screen.queryByText('Kraken deposit')).toBeNull();

    const row = screen.getByText('Some stranger').closest('.px-4');
    fireEvent.click(within(row).getByRole('button', { name: 'Edit' }));
    fireEvent.change(within(row).getByLabelText('Counterparty verdict'), { target: { value: 'own' } });
    fireEvent.click(within(row).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(apiMocks.eth.labelAddress).toHaveBeenCalledWith(
      '0x5555555555555555555555555555555555555555', 'Some stranger', { kind: 'own' }
    ));
  });

  it('keeps an exchange label linked to its exchange account through an edit', async () => {
    apiMocks.eth.labelAddress.mockResolvedValue({ label: {} });
    await openLabelsTab([
      { address: '0x6666666666666666666666666666666666666666', name: 'Old desk', source: 'user', kind: 'exchange', exchange_account_id: 7 },
    ]);
    const row = (await screen.findByText('Old desk')).closest('.px-4');
    fireEvent.click(within(row).getByRole('button', { name: 'Edit' }));
    fireEvent.change(within(row).getByLabelText('Label name'), { target: { value: 'Old exchange desk' } });
    fireEvent.click(within(row).getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(apiMocks.eth.labelAddress).toHaveBeenCalledWith(
      '0x6666666666666666666666666666666666666666', 'Old exchange desk', { kind: 'exchange', exchange_account_id: 7 }
    ));
  });

  it('keeps own labels in the main list and collapses outside parties', async () => {
    await openLabelsTab([
      { address: '0x4444444444444444444444444444444444444444', name: 'Ledger', source: 'user', kind: 'own' },
      { address: '0x5555555555555555555555555555555555555555', name: 'Some stranger', source: 'user', kind: 'external' },
    ]);

    const ledgerRow = (await screen.findByText('Ledger')).closest('.px-4');
    expect(within(ledgerRow).getByText('Yours')).toBeInTheDocument();
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
          '0x3333333333333333333333333333333333333333', 'Coinbase', { kind: undefined, exchange_account_id: null }
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
          '0x3333333333333333333333333333333333333333', null, { kind: 'external', exchange_account_id: null }
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
          '0x3333333333333333333333333333333333333333', null, { kind: 'bridge', exchange_account_id: null }
        );
      });
    });

    it('marks an address as a swap service with no name typed', async () => {
      // The verdict for an instant-swap deposit address: what was sent there
      // was SOLD. Labeling it 'exchange' instead would book the disposal as an
      // internal transfer and delete it from the record, which is why this is
      // its own verdict rather than a naming convention on an exchange label.
      const form = await openLabelForm();
      fireEvent.change(form.address, { target: { value: '0x5555555555555555555555555555555555555555' } });
      fireEvent.change(form.verdict, { target: { value: 'service' } });
      fireEvent.click(form.submit);

      await waitFor(() => {
        expect(apiMocks.eth.labelAddress).toHaveBeenCalledWith(
          '0x5555555555555555555555555555555555555555', null, { kind: 'service', exchange_account_id: null }
        );
      });
    });

    it('shows a swap-service label its own pill, not an exchange one', async () => {
      await openLabelForm([
        {
          address: '0x263388e56bdb89ed680eec82f472098a732ccd02',
          name: 'Changelly',
          kind: 'service',
          source: 'user',
        },
      ]);
      expect(await screen.findByText('Changelly')).toBeInTheDocument();
      // The verdict <option> carries the same words, so match the pill itself.
      expect(screen.getAllByText('Swap service').some((el) => el.tagName === 'SPAN')).toBe(true);
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
          builtin: true,
        },
      ]);
      expect(await screen.findByText('Arbitrum: Delayed Inbox')).toBeInTheDocument();
      expect(screen.getByText('Bridge')).toBeInTheDocument();
    });

    it('lists seeded Polymarket labels without allowing removal', async () => {
      await openLabelForm([
        {
          address: '0x4bfb41d5b3570defd03c39a9a4d8de6bd8b8982e',
          name: 'Polymarket: CTF Exchange V1',
          kind: 'external',
          source: 'builtin-polymarket',
          builtin: true,
        },
      ]);
      fireEvent.click(screen.getByRole('button', { name: /1 reviewed as outside parties/i }));
      expect(await screen.findByText('Polymarket: CTF Exchange V1')).toBeInTheDocument();
      expect(screen.getByText('Polymarket')).toBeInTheDocument();
      const labeled = within(screen.getByRole('region', { name: /labeled addresses/i }));
      expect(labeled.queryByRole('button', { name: /remove/i })).toBeNull();
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
          '0x2222222222222222222222222222222222222222', 'Ledger', { kind: undefined, exchange_account_id: null }
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
    // Ignoring rewrites every wallet's holdings, so it asks first.
    const confirm = await screen.findByRole('dialog', { name: 'Ignore this token?' });
    expect(apiMocks.eth.ignoreToken).not.toHaveBeenCalled();
    expect(within(confirm).getByText(/removed from holdings and activity in every wallet/)).toBeInTheDocument();
    fireEvent.click(within(confirm).getByRole('button', { name: 'Ignore token' }));

    await waitFor(() => {
      expect(apiMocks.eth.ignoreToken).toHaveBeenCalledWith('0x6b175474e89094c44da98b954eedeac495271d0f', 'SCAM');
    });
    // Ignoring drops the token from balance derivation, so it has to stay
    // listed with a one-click undo rather than vanishing silently.
    expect(await screen.findByRole('button', { name: /unignore/i })).toBeInTheDocument();
  });
});

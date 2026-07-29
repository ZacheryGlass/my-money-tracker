import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import CryptoPage from './CryptoPage';

// The two triage queues on the Crypto page's Review tab (#75, moved off
// Settings): counterparties nobody has judged, and the transactions the spam
// heuristics judged for you.

const apiMocks = vi.hoisted(() => ({
  accounts: { getAll: vi.fn() },
  holdings: { getAll: vi.fn(), create: vi.fn(), update: vi.fn(), delete: vi.fn() },
  history: { getAccounts: vi.fn() },
  crypto: { getLedger: vi.fn(), getLedgerSummary: vi.fn(), ledgerExportUrl: vi.fn() },
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

beforeEach(() => {
  vi.clearAllMocks();
  apiMocks.eth.getWallets.mockResolvedValue({ wallets: [WALLET] });
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
  apiMocks.accounts.getAll.mockResolvedValue({ accounts: [] });
  apiMocks.holdings.getAll.mockResolvedValue({ holdings: [] });
  apiMocks.history.getAccounts.mockResolvedValue({ data: [] });
  apiMocks.crypto.getLedgerSummary.mockResolvedValue({ summary: { total: 0, needs_review_count: 0 } });
  apiMocks.crypto.getLedger.mockResolvedValue({ data: [], pagination: { total: 0 } });
});

const renderReview = () => render(<CryptoPage tab="crypto-review" onTabChange={vi.fn()} />);

describe('unknown counterparty triage', () => {
  const openReviewTab = async (queue = { data: [MATERIAL], summary: { count: 1, dust_count: 0, usd_volume: 12403 } }) => {
    apiMocks.eth.getUnreviewedCounterparties.mockResolvedValue(queue);
    renderReview();
    await screen.findByText('Needs Review');
  };

  it('renders an unreviewed counterparty with its volume and a You sent pill', async () => {
    await openReviewTab();
    expect(await screen.findByText('0xbbbb…0002')).toBeInTheDocument();
    expect(screen.getByText('3 transfers')).toBeInTheDocument();
    expect(screen.getByText('You sent')).toBeInTheDocument();
  });

  it('notes an uncertain address without applying a verdict', async () => {
    apiMocks.eth.saveAddressNote.mockResolvedValue({ note: {} });
    await openReviewTab();
    fireEvent.change(screen.getByLabelText(/note for 0xbbbb/i), {
      target: { value: 'Likely cold storage; confirm on device' },
    });
    fireEvent.click(screen.getByRole('button', { name: /save note/i }));

    await waitFor(() => {
      expect(apiMocks.eth.saveAddressNote).toHaveBeenCalledWith(
        MATERIAL.address,
        'Likely cold storage; confirm on device'
      );
      expect(apiMocks.eth.labelAddress).not.toHaveBeenCalled();
    });
  });

  const chooseVerdict = async (value) => {
    fireEvent.change(await screen.findByRole('combobox', { name: /verdict for 0xbbbb/i }), { target: { value } });
  };
  const apply = () => fireEvent.click(screen.getByRole('button', { name: /apply verdict — 0xbbbb/i }));

  it('marks a counterparty as an outside party from the verdict dropdown', async () => {
    apiMocks.eth.labelAddress.mockResolvedValue({ label: {} });
    await openReviewTab();

    await chooseVerdict('external');
    // Choosing is not deciding: nothing is written until Apply.
    expect(apiMocks.eth.labelAddress).not.toHaveBeenCalled();
    apply();
    await waitFor(() => {
      expect(apiMocks.eth.labelAddress).toHaveBeenCalledWith(MATERIAL.address, null, { kind: 'external' });
    });
    // The full refetch is what drops the queue row and moves the badge.
    await waitFor(() => expect(apiMocks.eth.getUnreviewedCounterparties).toHaveBeenCalledTimes(2));
  });

  it('keeps "mine, do not track" and "track as a wallet" separate verdicts', async () => {
    apiMocks.eth.labelAddress.mockResolvedValue({ label: {} });
    apiMocks.eth.addWallet.mockResolvedValue({});
    await openReviewTab();

    await chooseVerdict('own');
    apply();
    await waitFor(() => {
      // An empty optional name goes as null, so the backend falls back to the
      // short address rather than storing a blank label.
      expect(apiMocks.eth.labelAddress).toHaveBeenCalledWith(MATERIAL.address, null, { kind: 'own' });
    });
    // Labelling must never create an account or run a sync.
    expect(apiMocks.eth.addWallet).not.toHaveBeenCalled();
  });

  it('routes "Track as a wallet" through addWallet, not labelAddress', async () => {
    apiMocks.eth.addWallet.mockResolvedValue({});
    await openReviewTab();

    await chooseVerdict('track');
    // Tracking creates an account and runs a full sync, so the consequence is
    // stated before Apply is pressed.
    expect(screen.getByText(/pulls the full history/i)).toBeInTheDocument();
    apply();
    await waitFor(() => expect(apiMocks.eth.addWallet).toHaveBeenCalledWith(MATERIAL.address, null));
    expect(apiMocks.eth.labelAddress).not.toHaveBeenCalled();
  });

  it('will not submit an exchange verdict without a name', async () => {
    await openReviewTab();

    await chooseVerdict('exchange');
    // The exchange name is the counterparty text AND the internal-transfer
    // assertion, so it is the one required field.
    expect(screen.getByRole('button', { name: /apply verdict — 0xbbbb/i })).toBeDisabled();
    fireEvent.change(screen.getByLabelText(/name for 0xbbbb/i), { target: { value: 'Coinbase' } });
    apiMocks.eth.labelAddress.mockResolvedValue({ label: {} });
    apply();
    await waitFor(() => {
      expect(apiMocks.eth.labelAddress).toHaveBeenCalledWith(MATERIAL.address, 'Coinbase', { kind: 'exchange' });
    });
  });

  it('counts only material counterparties in the Review tab badge', async () => {
    // 1 material + 3 dust must read 1, not 4. A badge that cannot reach zero
    // gets ignored, taking the queue it points at with it.
    apiMocks.eth.getUnreviewedCounterparties.mockResolvedValue({
      data: [MATERIAL, dust('4'), dust('5'), dust('6')],
      summary: { count: 1, dust_count: 3, usd_volume: 12403 },
    });
    renderReview();

    const tab = await screen.findByRole('tab', { name: /Review/ });
    await waitFor(() => expect(within(tab).getByText('1')).toBeInTheDocument());
  });

  it('collapses low-value counterparties behind a disclosure', async () => {
    await openReviewTab({
      data: [MATERIAL, dust('4'), dust('5')],
      summary: { count: 1, dust_count: 2, usd_volume: 12403 },
    });

    await screen.findByText('0xbbbb…0002');
    expect(screen.queryByText('0xdddd…0004')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /2 low-value counterparties/i }));
    expect(screen.getByText('0xdddd…0004')).toBeInTheDocument();
  });

  it('warns before ignoring a token, since the ignore list is user-global', async () => {
    apiMocks.eth.ignoreToken.mockResolvedValue({});
    await openReviewTab({
      data: [{ ...MATERIAL, token_symbols: ['SCAM'], sole_token_contract: '0xc0ffee' }],
      summary: { count: 1, dust_count: 0, usd_volume: 0 },
    });

    // sole_token_contract only proves THIS counterparty deals in one token.
    // Ignoring drops the position from every wallet, so if the same token was
    // also acquired legitimately it would delete a real holding -- the warning
    // has to be readable while Apply is still unpressed.
    await chooseVerdict('ignore');
    expect(apiMocks.eth.ignoreToken).not.toHaveBeenCalled();
    expect(screen.getByText(/removes it from holdings and activity in every wallet/i)).toBeInTheDocument();

    apply();
    await waitFor(() => expect(apiMocks.eth.ignoreToken).toHaveBeenCalledWith('0xc0ffee', 'SCAM'));
  });

  it('offers the ignore verdict only where a single token is in play', async () => {
    await openReviewTab();
    const select = await screen.findByRole('combobox', { name: /verdict for 0xbbbb/i });
    expect(within(select).queryByText(/ignore/i)).toBeNull();
  });

  it('shows a retry state when the queue fetch fails rather than claiming all clear', async () => {
    apiMocks.eth.getUnreviewedCounterparties.mockRejectedValue(new Error('boom'));
    renderReview();

    await screen.findByText('Needs Review');
    // Rendering "every counterparty has been reviewed" here would be the same
    // silence this section exists to break.
    expect(screen.queryByText(/every counterparty has been reviewed/i)).toBeNull();
    expect(screen.getByText(/couldn't load the review queue/i)).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: /retry/i }).length).toBeGreaterThan(0);
    // One endpoint failing must not surface a page-level error.
    expect(screen.queryByText(/failed to load/i)).toBeNull();
  });
});

// The spam quarantine (#74). The section exists to make the quarantine
// inspectable and reversible: hiding rows is only acceptable if the user can
// see how many were hidden, why, and get any of them back in one click.
describe('quarantined spam', () => {
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

  const openReviewTab = async (spamResult) => {
    if (spamResult !== undefined) apiMocks.eth.getActivity.mockResolvedValue(spamResult);
    renderReview();
    await screen.findByText(/^Quarantined wallet transactions$/);
  };

  it('says nothing was quarantined when nothing was', async () => {
    await openReviewTab();
    expect(await screen.findByText(/nothing has been quarantined/i)).toBeInTheDocument();
  });

  it('reports the count, the reason and the amount, and warns about poisoning', async () => {
    await openReviewTab({
      data: [POISONED],
      summary: { spam_count: 1, needs_review_count: 0 },
      pagination: { total: 1 },
    });

    // The server's count, not the page's: the list is capped.
    expect(await screen.findByText(/^1 quarantined wallet transaction$/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /quarantined wallet transaction/i }));

    expect(screen.getByText('Lookalike address')).toBeInTheDocument();
    // The security warning is the whole reason the server stores a reason
    // CODE rather than prose -- this line must not appear on a dust airdrop.
    expect(screen.getByText(/never copy an address out of transaction history/i)).toBeInTheDocument();
    // What moved is still on the row: hidden is not deleted.
    expect(screen.getByText('+0.00001 ETH')).toBeInTheDocument();
  });

  it('restores a false positive in one click, chain and all', async () => {
    apiMocks.eth.setActivitySpam.mockResolvedValue({ override: {} });
    await openReviewTab({
      data: [{ ...POISONED, chain_id: 42161 }],
      summary: { spam_count: 1, needs_review_count: 0 },
      pagination: { total: 1 },
    });
    fireEvent.click(await screen.findByRole('button', { name: /quarantined wallet transaction/i }));

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
    await openReviewTab({
      data: [row(1), row(2)],
      summary: { spam_count: 4, needs_review_count: 0 },
      pagination: { total: 4 },
    });
    fireEvent.click(await screen.findByRole('button', { name: /quarantined wallet transactions/i }));
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
    apiMocks.eth.getActivity.mockRejectedValue(new Error('boom'));
    renderReview();

    await screen.findByText(/^Quarantined wallet transactions$/);
    expect(screen.queryByText(/nothing has been quarantined/i)).toBeNull();
    expect(screen.getByText(/couldn't load the quarantine/i)).toBeInTheDocument();
    expect(screen.queryByText(/failed to load/i)).toBeNull();
  });
});

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import CryptoPage from './CryptoPage';

const apiMocks = vi.hoisted(() => ({
  accounts: { getAll: vi.fn() },
  holdings: { getAll: vi.fn() },
  history: { getAccounts: vi.fn() },
  eth: {
    getWallets: vi.fn(),
    getAddressNotes: vi.fn(),
    getIgnoredTokens: vi.fn(),
    getAddressLabels: vi.fn(),
    getUnreviewedCounterparties: vi.fn(),
    getActivity: vi.fn(),
    getReconciliation: vi.fn(),
    getUnpricedAssets: vi.fn(),
  },
  crypto: { getLedgerSummary: vi.fn() },
  exchanges: {
    getAll: vi.fn(),
    getBalanceExceptions: vi.fn(),
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

vi.mock('../components/CryptoLedger', () => ({
  default: ({ initialNeedsReview = '', refreshKey, onDataChanged }) => (
    <button
      type="button"
      data-testid={initialNeedsReview ? 'ledger-review' : 'ledger-all'}
      onClick={() => onDataChanged?.()}
    >
      revision:{refreshKey}
    </button>
  ),
}));

vi.mock('../components/crypto/ReviewPanel', () => ({
  default: () => <div>Review queues</div>,
  SPAM_PAGE_SIZE: 50,
  SPAM_MAX_LIMIT: 500,
}));

beforeEach(() => {
  vi.clearAllMocks();
  apiMocks.accounts.getAll.mockResolvedValue({ accounts: [] });
  apiMocks.holdings.getAll.mockResolvedValue({ holdings: [] });
  apiMocks.history.getAccounts.mockResolvedValue({ data: [] });
  apiMocks.eth.getWallets.mockResolvedValue({ wallets: [] });
  apiMocks.eth.getAddressNotes.mockResolvedValue({ notes: [] });
  apiMocks.eth.getIgnoredTokens.mockResolvedValue({ tokens: [] });
  apiMocks.eth.getAddressLabels.mockResolvedValue({ labels: [] });
  apiMocks.eth.getUnreviewedCounterparties.mockResolvedValue({ summary: { count: 0 } });
  apiMocks.eth.getActivity.mockResolvedValue({ data: [], summary: { spam_count: 0 } });
  apiMocks.eth.getReconciliation.mockResolvedValue({ data: [], summary: {} });
  apiMocks.eth.getUnpricedAssets.mockResolvedValue({ data: [] });
  apiMocks.crypto.getLedgerSummary.mockResolvedValue({
    summary: { total: 1, needs_review_count: 1 },
  });
  apiMocks.exchanges.getAll.mockResolvedValue({ accounts: [] });
  apiMocks.exchanges.getBalanceExceptions.mockResolvedValue({ summary: { count: 0 } });
});

describe('CryptoPage navigation', () => {
  it('refreshes the hidden Activity ledger after a Review mutation', async () => {
    const onTabChange = vi.fn();
    const { rerender } = render(
      <CryptoPage tab="crypto-transactions" onTabChange={onTabChange} />
    );

    await screen.findByTestId('ledger-all');
    rerender(<CryptoPage tab="crypto-review" onTabChange={onTabChange} />);
    await screen.findByTestId('ledger-review');

    fireEvent.click(screen.getByTestId('ledger-review'));

    await waitFor(() => {
      expect(screen.getByTestId('ledger-all')).toHaveTextContent('revision:1');
      expect(screen.getByTestId('ledger-review')).toHaveTextContent('revision:1');
    });
  });
});

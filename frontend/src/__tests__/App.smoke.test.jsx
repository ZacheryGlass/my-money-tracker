import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import App from '../App';
import { me, crypto as cryptoAPI } from '../utils/api';

// Login happens upstream (Azure Easy Auth); the app assumes it is already
// authenticated and only fetches /api/me for the sidebar display name, plus
// the crypto attention counts for the sidebar badge.
vi.mock('../utils/api', () => ({
  me: vi.fn().mockResolvedValue({ user: { id: 1, username: 'zachery' } }),
  holdings: { getAll: vi.fn() },
  accounts: { getAll: vi.fn() },
  dashboard: { getPortfolio: vi.fn() },
  crypto: {
    getLedgerSummary: vi.fn().mockResolvedValue({ summary: { needs_review_count: 0 } }),
  },
  eth: { getWallets: vi.fn().mockResolvedValue({ wallets: [] }) },
  history: {
    getPortfolio: vi.fn(),
    getTickers: vi.fn(),
    getAccounts: vi.fn(),
  },
  exportData: {
    downloadHoldings: vi.fn(),
    downloadHistory: vi.fn(),
  },
  default: { get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn() },
}));

// Stub the pages so the smoke test exercises the app shell without mocking
// every page's API response shape.
vi.mock('../components/Dashboard', () => ({
  default: () => <div>Dashboard stub</div>,
}));
vi.mock('../pages/CryptoPage', () => ({
  default: ({ tab }) => <div>Crypto stub: {tab}</div>,
}));

describe('App smoke test', () => {
  it('renders the app shell for the authenticated user', async () => {
    render(
      <MemoryRouter>
        <App />
      </MemoryRouter>
    );

    // Lazy page resolves through Suspense; findByText waits for it.
    expect(await screen.findByText('Dashboard stub')).toBeInTheDocument();
    // The app fetches the identity for the sidebar (collapsed in jsdom,
    // so the username itself is not visible).
    expect(me).toHaveBeenCalled();
  });

  it('routes a Crypto page and highlights its own sidebar destination', async () => {
    render(
      <MemoryRouter initialEntries={['/crypto/holdings']}>
        <App />
      </MemoryRouter>
    );

    expect(await screen.findByText('Crypto stub: crypto-holdings')).toBeInTheDocument();
    // jsdom's matchMedia stub collapses the sidebar, so the label is a title
    // attribute and the active state is the accent background, not aria.
    const holdingsNav = screen.getByTitle('Crypto Holdings');
    expect(holdingsNav.className).toContain('bg-[#3994BC26]');
  });

  // Review owns the actionable queue, so its badge is visible from anywhere.
  it('badges Crypto Review with the unexplained count from anywhere', async () => {
    cryptoAPI.getLedgerSummary.mockResolvedValueOnce({ summary: { needs_review_count: 3 } });

    render(
      <MemoryRouter>
        <App />
      </MemoryRouter>
    );

    expect(await screen.findByTitle('Crypto Review (3)')).toBeInTheDocument();
  });

  it('keeps the old Discovery URL as a Wallets alias', async () => {
    render(
      <MemoryRouter initialEntries={['/crypto/discovery']}>
        <App />
      </MemoryRouter>
    );

    expect(await screen.findByText('Crypto stub: crypto-discovery')).toBeInTheDocument();
    expect(screen.getByTitle('Crypto Wallets').className).toContain('bg-[#3994BC26]');
  });
});

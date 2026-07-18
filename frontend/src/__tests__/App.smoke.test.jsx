import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import App from '../App';
import { me } from '../utils/api';

// Login happens upstream (Azure Easy Auth); the app assumes it is already
// authenticated and only fetches /api/me for the sidebar display name.
vi.mock('../utils/api', () => ({
  me: vi.fn().mockResolvedValue({ user: { id: 1, username: 'zachery' } }),
  holdings: { getAll: vi.fn() },
  accounts: { getAll: vi.fn() },
  dashboard: { getPortfolio: vi.fn() },
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

// Stub the dashboard page so the smoke test exercises the app shell without
// mocking every dashboard API response shape.
vi.mock('../components/Dashboard', () => ({
  default: () => <div>Dashboard stub</div>,
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
});

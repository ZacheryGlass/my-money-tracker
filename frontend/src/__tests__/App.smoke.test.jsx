import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import App from '../App';
import { AuthProvider } from '../context/AuthContext';

// Prevent real API calls from AuthContext on mount.
// authAPI.me rejects so no token check attempt lands (localStorage is empty in tests anyway).
vi.mock('../utils/api', () => ({
  auth: {
    login: vi.fn(),
    me: vi.fn().mockRejectedValue(new Error('no network in tests')),
  },
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

describe('App smoke test', () => {
  it('renders the login form when unauthenticated', async () => {
    render(
      <MemoryRouter>
        <AuthProvider>
          <App />
        </AuthProvider>
      </MemoryRouter>
    );

    // After auth initialization completes (no token in localStorage), Login renders.
    // findByText waits for async state updates to settle.
    const heading = await screen.findByText('My Money Tracker');
    expect(heading).toBeInTheDocument();
  });
});

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
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
}));

vi.mock('../utils/api', () => ({
  accounts: apiMocks.accounts,
  plaid: apiMocks.plaid,
}));

vi.mock('react-plaid-link', () => ({
  usePlaidLink: () => ({ open: vi.fn(), ready: false }),
}));

describe('Settings display names', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    apiMocks.plaid.getItems.mockResolvedValue({ items: [] });
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

  it('saves an account display name override', async () => {
    render(<Settings />);

    const input = await screen.findByPlaceholderText('Bank of Example - Very Long Checking Account Name');
    fireEvent.change(input, { target: { value: 'Checking' } });
    fireEvent.click(screen.getByRole('button', { name: /save/i }));

    await waitFor(() => {
      expect(apiMocks.accounts.updateDisplayName).toHaveBeenCalledWith(7, 'Checking');
    });
  });

  it('loads all accounts and toggles account visibility', async () => {
    render(<Settings />);

    await screen.findByText('Account Display');
    expect(apiMocks.accounts.getAll).toHaveBeenCalledWith({ includeHidden: true });

    fireEvent.click(screen.getByRole('switch', { name: /hide bank of example/i }));

    await waitFor(() => {
      expect(apiMocks.accounts.updateVisibility).toHaveBeenCalledWith(7, true);
    });
  });
});

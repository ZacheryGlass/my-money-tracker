import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import ExchangeBalanceExceptionQueue from './ExchangeBalanceExceptionQueue';

const apiMocks = vi.hoisted(() => ({
  updateBalanceException: vi.fn(),
}));

vi.mock('../../utils/api', () => ({
  exchanges: apiMocks,
}));

const EXCEPTION = {
  id: 4,
  exchange_account_id: 7,
  account_name: 'Kraken Main',
  canonical_asset: 'ETH',
  provider_asset_codes: ['ETH2', 'XETH'],
  derived_balance: '1.000000000000000001',
  live_balance: '1.5',
  delta: '-0.499999999999999999',
  adjusted_delta: '-0.499999999999999999',
  adjustment: '0',
  status: 'open',
  category: null,
  evidence: null,
  version: 3,
  calculated_at: '2026-07-31T00:00:00.000Z',
};

beforeEach(() => {
  vi.clearAllMocks();
  apiMocks.updateBalanceException.mockResolvedValue({ exception: EXCEPTION });
});

describe('ExchangeBalanceExceptionQueue', () => {
  it('renders exact values, provider codes, and an account link', () => {
    const onOpenAccount = vi.fn();
    render(<ExchangeBalanceExceptionQueue data={{ data: [EXCEPTION], pagination: { total: 1 } }} showAccount onOpenAccount={onOpenAccount} />);

    expect(screen.getByText('1.000000000000000001')).toBeInTheDocument();
    expect(screen.getByText('ETH2, XETH')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Kraken Main' }));
    expect(onOpenAccount).toHaveBeenCalledWith(7);
  });

  it('requires the form fields through the API payload and sends the row version', async () => {
    render(<ExchangeBalanceExceptionQueue data={{ data: [EXCEPTION] }} />);
    fireEvent.change(screen.getByLabelText('Category'), { target: { value: 'provider_migration' } });
    fireEvent.change(screen.getByLabelText('Evidence'), { target: { value: 'The venue migrated ETH2 into the spot wallet.' } });
    fireEvent.change(screen.getByLabelText('Adjustment'), { target: { value: '0.499999999999999999' } });
    fireEvent.click(screen.getByRole('button', { name: 'Accept' }));

    await waitFor(() => expect(apiMocks.updateBalanceException).toHaveBeenCalledWith(4, {
      version: 3,
      status: 'accepted',
      category: 'provider_migration',
      evidence: 'The venue migrated ETH2 into the spot wallet.',
      adjustment: '0.499999999999999999',
    }));
  });
});

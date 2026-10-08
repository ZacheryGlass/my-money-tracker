import { render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import StakingIncomeCard from './StakingIncomeCard';

const apiMocks = vi.hoisted(() => ({ crypto: { getStakingIncome: vi.fn() } }));
vi.mock('../../../utils/api', () => ({ crypto: apiMocks.crypto }));

const asset = (overrides) => ({ quantity: '1', usd: '0.00', events: 1, unpriced: 0, ...overrides });

describe('StakingIncomeCard', () => {
  it('tells priced dust and part-priced assets apart from assets with no price', async () => {
    apiMocks.crypto.getStakingIncome.mockResolvedValue({
      income: {
        total_usd: '5802.51',
        events: 386,
        unpriced: 75,
        assets: [
          asset({ asset: 'ETH', quantity: '2.3', usd: '5802.51', events: 280 }),
          asset({ asset: 'POL', quantity: '0.0000001649', events: 52, unpriced: 23 }),
          asset({ asset: 'SOL', quantity: '0.87', events: 52, unpriced: 52 }),
          asset({ asset: 'USDC', quantity: '0.00000002', events: 2 }),
        ],
      },
    });
    render(<StakingIncomeCard />);

    const row = async (symbol) => (await screen.findByText(symbol)).closest('li');
    expect(within(await row('POL')).getByText(/< \$0\.01/)).toBeInTheDocument();
    expect(within(await row('POL')).getByText(/23 without a price/)).toBeInTheDocument();
    expect(within(await row('USDC')).getByText('< $0.01')).toBeInTheDocument();
    expect(within(await row('SOL')).getByText('No USD value')).toBeInTheDocument();
    expect(within(await row('ETH')).queryByText('No USD value')).toBeNull();
  });
});

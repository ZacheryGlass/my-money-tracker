import { describe, expect, it } from 'vitest';
import {
  changeOverDays, groupHoldingsByAsset, possibleDuplicates, splitNetworkSuffix, valueBySource,
} from './holdings';

const h = (overrides) => ({ id: overrides.id, quantity: '1', current_value: '10', ...overrides });

describe('groupHoldingsByAsset', () => {
  it('sums one ticker across accounts and names it by the largest holding', () => {
    const groups = groupHoldingsByAsset([
      h({ id: 1, ticker: 'ETH', name: 'ETH (Arbitrum)', quantity: '0.5', current_value: '1000' }),
      h({ id: 2, ticker: 'eth', name: 'Ethereum', quantity: '2', current_value: '4000', account_eth_wallet_id: 1 }),
      h({ id: 3, ticker: null, name: 'USDC.e 0x2791…4174 (Polygon)', quantity: '20', current_value: '20' }),
    ]);
    expect(groups.map((g) => [g.display, g.quantity, g.value, g.holdings.length])).toEqual([
      ['Ethereum', 2.5, 5000, 2],
      ['USDC.e 0x2791…4174 (Polygon)', 20, 20, 1],
    ]);
    expect(groups[0].holdings[0].id).toBe(2);
  });
});

describe('splitNetworkSuffix', () => {
  it('splits a known network off a token name, and leaves anything else alone', () => {
    expect(splitNetworkSuffix('USDC.e 0x2791…4174 (Polygon)')).toEqual({ base: 'USDC.e 0x2791…4174', network: 'Polygon' });
    expect(splitNetworkSuffix('Wrapped thing (not a network)')).toEqual({ base: 'Wrapped thing (not a network)', network: null });
  });
});

describe('possibleDuplicates', () => {
  it('flags a manual holding that matches a synced balance exactly', () => {
    const dupes = possibleDuplicates([
      h({ id: 1, ticker: 'ICP', quantity: '7.8106' }),
      h({ id: 2, ticker: 'ICP', quantity: '7.8106000', account_exchange_account_id: 5 }),
      h({ id: 3, ticker: 'SOL', quantity: '14.52' }),
      h({ id: 4, ticker: 'SOL', quantity: '15.19', account_exchange_account_id: 5 }),
    ]);
    expect([...dupes.keys()]).toEqual([1]);
    expect(dupes.get(1).map((m) => m.id)).toEqual([2]);
  });
});

describe('valueBySource and changeOverDays', () => {
  it('splits value by where it is held', () => {
    expect(valueBySource([
      h({ id: 1, current_value: '5', account_eth_wallet_id: 1 }),
      h({ id: 2, current_value: '7', account_exchange_account_id: 2 }),
      h({ id: 3, current_value: '11' }),
    ])).toEqual({ wallet: 5, exchange: 7, manual: 11 });
  });

  it('measures the change from the last point at least 30 days back', () => {
    const series = [
      { snapshot_date: '2026-08-01', total_value: 100 },
      { snapshot_date: '2026-09-07', total_value: 200 },
      { snapshot_date: '2026-09-10', total_value: 250 },
      { snapshot_date: '2026-10-08', total_value: 300 },
    ];
    expect(changeOverDays(series, 30)).toEqual({ change: 100, percent: 50, since: '2026-09-07' });
    expect(changeOverDays([{ snapshot_date: '2026-10-08', total_value: 1 }], 30)).toBeNull();
  });
});

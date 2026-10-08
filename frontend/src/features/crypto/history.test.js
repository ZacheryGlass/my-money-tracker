import { describe, expect, it } from 'vitest';
import { totalSeries } from './history';

describe('totalSeries', () => {
  it('sums every account per snapshot date, oldest first', () => {
    expect(totalSeries([
      { snapshot_date: '2026-10-08T00:00:00.000Z', account_id: 1, total_value: '100.5' },
      { snapshot_date: '2026-10-07', account_id: 1, total_value: '90' },
      { snapshot_date: '2026-10-08', account_id: 2, total_value: '20' },
      { snapshot_date: '2026-10-07', account_id: 3, total_value: 'not-a-number' },
    ])).toEqual([
      { snapshot_date: '2026-10-07', total_value: 90 },
      { snapshot_date: '2026-10-08', total_value: 120.5 },
    ]);
  });

  it('returns nothing for no rows', () => {
    expect(totalSeries(undefined)).toEqual([]);
  });
});

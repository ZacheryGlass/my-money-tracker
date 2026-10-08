import { describe, expect, it } from 'vitest';
import { fixStatesReason, groupReviewRows, suggestedFix } from './grouping';

const row = (overrides) => ({
  source: 'onchain', category: 'exchange_deposit', review_reason: 'No exchange record',
  counterparty_name: 'Binance', counterparty_address: '0xb1', usd_value: '10', occurred_at: '2018-01-05',
  ...overrides,
});

describe('groupReviewRows', () => {
  it('groups one problem across counterparties, largest group first', () => {
    const groups = groupReviewRows([
      row({ counterparty_name: 'Binance 3', occurred_at: '2018-01-12' }),
      row({}),
      row({ category: 'exchange_withdrawal', usd_value: null }),
    ]);

    expect(groups.map((g) => [g.category, g.rows.length])).toEqual([
      ['exchange_deposit', 2],
      ['exchange_withdrawal', 1],
    ]);
    expect(groups[0].parties).toEqual(['Binance 3', 'Binance']);
    expect(groups[0].usdTotal).toBe(20);
    expect(groups[1].unpriced).toBe(1);
  });

  it('keeps one-way transfers per counterparty, so one label explains a group', () => {
    const groups = groupReviewRows([
      row({ category: 'send', counterparty_name: null, counterparty_address: '0xaa' }),
      row({ category: 'send', counterparty_name: null, counterparty_address: '0xbb' }),
      row({ category: 'send', counterparty_name: null, counterparty_address: '0xaa' }),
    ]);

    expect(groups.map((g) => [g.counterpartyAddress, g.rows.length])).toEqual([['0xaa', 2], ['0xbb', 1]]);
    expect(suggestedFix(groups[0])).toMatch(/One label explains every transfer/);
  });

  it('points an unmatched exchange flow at that exchange', () => {
    const [group] = groupReviewRows([row({})]);
    expect(suggestedFix(group)).toMatch(/No record from Binance covers this transfer/);
    // Which already says what the reason line would.
    expect(fixStatesReason(group)).toBe(true);
  });

  it('keeps the reason where the fix does not restate it', () => {
    const [group] = groupReviewRows([row({ category: 'send', counterparty_name: null, counterparty_address: '0xaa' })]);
    expect(fixStatesReason(group)).toBe(false);
  });
});

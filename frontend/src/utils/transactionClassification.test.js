import { describe, expect, it } from 'vitest';
import { classifyTransaction } from './transactionClassification';

describe('transactionClassification', () => {
  it('marks everyday card purchases as spending', () => {
    const txn = classifyTransaction({
      amount: 42.5,
      name: 'Coffee Shop',
      merchant_name: 'Coffee Shop',
      category: 'FOOD_AND_DRINK',
    });

    expect(txn.spend).toBe(42.5);
    expect(txn.isEveryday).toBe(true);
    expect(txn.kindLabel).toBe('Food & Drink');
  });

  it('excludes transfers and investment activity from everyday spending', () => {
    const transfer = classifyTransaction({
      amount: 500,
      name: 'Online Transfer',
      category: 'TRANSFER_OUT',
    });
    const investment = classifyTransaction({
      amount: 1200,
      name: 'Vanguard shares purchased',
      category: 'BUY',
    });

    expect(transfer.isEveryday).toBe(false);
    expect(investment.isEveryday).toBe(false);
  });

  it('recognizes likely payroll income without counting transfers as income', () => {
    const payroll = classifyTransaction({
      amount: -2500,
      name: 'ACME Payroll Direct Deposit',
      category: 'DEPOSIT',
    });
    const transfer = classifyTransaction({
      amount: -500,
      name: 'Brokerage Transfer',
      category: 'TRANSFER_IN',
    });

    expect(payroll.income).toBe(2500);
    expect(payroll.isLikelyIncome).toBe(true);
    expect(transfer.isLikelyIncome).toBe(false);
  });
});

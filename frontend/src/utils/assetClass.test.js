import { describe, expect, it } from 'vitest';
import { getAssetClass, getHoldingIdentity } from './assetClass';

describe('asset-class helpers', () => {
  it('groups holdings by their economic asset class', () => {
    expect(getAssetClass({ account_type: 'crypto', name: 'Bitcoin' })).toBe('Crypto');
    expect(getAssetClass({ account_type: 'investment', ticker: 'VTI' })).toBe('Stocks & Funds');
    expect(getAssetClass({ account_type: 'property', name: 'Primary home' })).toBe('Real Estate');
    expect(getAssetClass({ account_type: 'depository', name: 'Checking' })).toBe('Cash');
  });

  it('uses the account and symbol to identify a position', () => {
    expect(getHoldingIdentity({ account_id: 7, ticker: 'amzn' })).toBe('7::AMZN');
    expect(getHoldingIdentity({ account_id: 7, name: 'Primary home' })).toBe('7::PRIMARY HOME');
  });
});

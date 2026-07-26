import { describe, expect, it } from 'vitest';
import { formatTokenUnits } from './format';

// Base-unit rendering for the on-chain balance audit (#62). The audit exists to
// surface differences a float would round away, so the display path has to be
// exact too -- a formatter that turns a real 1-wei discrepancy into "0" undoes
// the entire feature at the last step.
describe('formatTokenUnits', () => {
  it('scales by the asset decimals', () => {
    expect(formatTokenUnits('1000000000000000000', 18)).toBe('1');
    expect(formatTokenUnits('1500000000000000000', 18)).toBe('1.5');
    expect(formatTokenUnits('250000000', 6)).toBe('250');
  });

  it('defaults a missing decimals to 18, matching the shared unit helpers', () => {
    // NULL token_decimals means 18 everywhere on the backend; diverging here
    // would scale a real drift into or out of the display threshold.
    expect(formatTokenUnits('1000000000000000000')).toBe('1');
    expect(formatTokenUnits('1000000000000000000', null)).toBe('1');
  });

  it('treats a zero-decimal token as whole units', () => {
    // NFT-style and 0-decimal ERC-20s: the smallest unit IS one token.
    expect(formatTokenUnits('7', 0)).toBe('7');
  });

  it('keeps sign and magnitude on a negative delta', () => {
    // A negative derived balance is the loudest evidence of a missed inbound
    // transfer; swallowing the sign would report it as a surplus.
    expect(formatTokenUnits('-1000000000000000000', 18)).toBe('-1');
  });

  it('never rounds a residual up into a clean zero', () => {
    // 1 wei of drift. Rounding to six places would render '0', which is the one
    // answer the audit must never give when the ledger and the chain disagree.
    expect(formatTokenUnits('1', 18)).toBe('0');
    expect(formatTokenUnits('1', 18, { maxFractionDigits: 18 })).toBe('0.000000000000000001');
    // ...and truncation never inflates either.
    expect(formatTokenUnits('1999999999999999999', 18, { maxFractionDigits: 2 })).toBe('1.99');
  });

  it('handles a whole part past Number precision without corrupting it', () => {
    // A scam token can mint absurd supply; grouping via Number would silently
    // rewrite the digits.
    const huge = '123456789012345678901234567890000000000000000000';
    expect(formatTokenUnits(huge, 18)).toBe('123,456,789,012,345,678,901,234,567,890');
  });

  it('returns null for values it cannot read rather than guessing a zero', () => {
    expect(formatTokenUnits(null)).toBe(null);
    expect(formatTokenUnits(undefined)).toBe(null);
    expect(formatTokenUnits('')).toBe(null);
    expect(formatTokenUnits('1.5')).toBe(null);
    expect(formatTokenUnits('not a number')).toBe(null);
  });
});

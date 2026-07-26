import { describe, expect, it } from 'vitest';
import { formatExactUnits } from './format';

// Crypto quantities are decimal STRINGS at 18 places. Number() rounds anything
// past ~15 significant digits, so a ledger that formats through a float
// silently disagrees with the chain about what moved.
describe('formatExactUnits', () => {
  it('leaves an ordinary amount alone, grouped', () => {
    expect(formatExactUnits('1832.4')).toBe('1,832.4');
    expect(formatExactUnits('0.5')).toBe('0.5');
    expect(formatExactUnits('1')).toBe('1');
    expect(formatExactUnits('0')).toBe('0');
  });

  it('trims the padding a NUMERIC(38,18) column brings with it', () => {
    expect(formatExactUnits('0.500000000000000000')).toBe('0.5');
    expect(formatExactUnits('1832.400000000000000000')).toBe('1,832.4');
  });

  it('rounds half-up through BigInt rather than a float', () => {
    // 19 significant digits: not representable as a double.
    expect(formatExactUnits('1234567.890123456789')).toBe('1,234,567.890123');
    expect(formatExactUnits('0.9999999')).toBe('1');
    expect(formatExactUnits('0.1234565')).toBe('0.123457');
    expect(formatExactUnits('0.1234564')).toBe('0.123456');
  });

  it('says "smaller than the smallest digit" rather than rendering dust as zero', () => {
    // A ledger row reading 0 for a real movement is a lie, and dust is exactly
    // what a crypto ledger is full of.
    expect(formatExactUnits('0.0000001')).toBe('<0.000001');
    expect(formatExactUnits('0.000000000000000001')).toBe('<0.000001');
    // A genuine zero still reads as zero.
    expect(formatExactUnits('0.000000000000000000')).toBe('0');
  });

  it('keeps a negative sign, and drops it when the value rounds away', () => {
    expect(formatExactUnits('-0.5')).toBe('-0.5');
    expect(formatExactUnits('-0.0000001')).toBe('-<0.000001');
  });

  it('honours a wider fraction for gas, where six places is not enough', () => {
    expect(formatExactUnits('0.000000840000000000', { maxFractionDigits: 12 })).toBe('0.00000084');
  });

  it('passes anything that is not a decimal through untouched', () => {
    expect(formatExactUnits(null)).toBe('0');
    expect(formatExactUnits(undefined)).toBe('0');
    expect(formatExactUnits('')).toBe('0');
    expect(formatExactUnits('1e18')).toBe('1e18');
  });
});

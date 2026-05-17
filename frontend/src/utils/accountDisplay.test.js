import { describe, expect, it } from 'vitest';
import { getAccountDisplayName, hasAccountDisplayName } from './accountDisplay';

describe('accountDisplay', () => {
  it('uses effective_name first', () => {
    expect(getAccountDisplayName({
      name: 'Very Long Plaid Account Name',
      display_name: 'Checking',
      effective_name: 'Primary Checking',
    })).toBe('Primary Checking');
  });

  it('falls back to display_name, then source name', () => {
    expect(getAccountDisplayName({ name: 'Source Name', display_name: 'Short Name' })).toBe('Short Name');
    expect(getAccountDisplayName({ name: 'Source Name', display_name: '   ' })).toBe('Source Name');
  });

  it('detects saved display names', () => {
    expect(hasAccountDisplayName({ display_name: 'Short Name' })).toBe(true);
    expect(hasAccountDisplayName({ display_name: '   ' })).toBe(false);
  });
});

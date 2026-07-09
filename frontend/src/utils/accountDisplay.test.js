import { describe, expect, it } from 'vitest';
import { buildAccountDisplayNameMap, getAccountDisplayName, hasAccountDisplayName } from './accountDisplay';

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

  it('disambiguates duplicate display names with source names', () => {
    const names = buildAccountDisplayNameMap([
      { id: 1, name: 'Fidelity - 401k', display_name: '401k' },
      { id: 2, name: 'Empower - 401k', display_name: '401k' },
      { id: 3, name: 'Checking' },
    ]);

    expect(names.get(1)).toBe('401k (Fidelity - 401k)');
    expect(names.get(2)).toBe('401k (Empower - 401k)');
    expect(names.get(3)).toBe('Checking');
  });
});

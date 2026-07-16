export const ASSET_CLASS_ORDER = [
  'Crypto',
  'Stocks & Funds',
  'Real Estate',
  'Cash',
  'Other',
];

const includesAny = (value, terms) => terms.some((term) => value.includes(term));

export function getAssetClass(item = {}) {
  const accountType = String(item.account_type || '').toLowerCase();
  const category = String(item.category || '').toLowerCase();
  const name = String(item.name || '').toLowerCase();
  const combined = `${accountType} ${category} ${name}`;

  if (accountType === 'crypto' || includesAny(combined, ['crypto', 'bitcoin', 'ether'])) {
    return 'Crypto';
  }

  if (
    includesAny(combined, ['real estate', 'property', 'home value', 'residence']) ||
    accountType === 'property'
  ) {
    return 'Real Estate';
  }

  if (
    accountType === 'depository' ||
    includesAny(combined, ['cash', 'checking', 'savings', 'money market', 'venmo'])
  ) {
    return 'Cash';
  }

  if (
    accountType === 'investment' ||
    includesAny(combined, ['stock', 'fund', 'equity', 'etf', 'index', 'bond']) ||
    item.ticker
  ) {
    return 'Stocks & Funds';
  }

  return 'Other';
}

export function getHoldingIdentity(item = {}) {
  const symbol = item.ticker || item.name || '';
  return `${item.account_id ?? item.account ?? 'other'}::${String(symbol).trim().toUpperCase()}`;
}

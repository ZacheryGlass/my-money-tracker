export const formatCurrency = (value, options = {}) => {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
    ...options,
  }).format(value);
};

export const formatPercent = (value, decimals = 1, { sign: showSign = true } = {}) => {
  const safeValue = Number(value) || 0;
  const prefix = showSign && safeValue >= 0 ? '+' : '';
  return `${prefix}${safeValue.toFixed(decimals)}%`;
};

export const formatDateDisplay = (dateString) => {
  const date = new Date(dateString);
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(date);
};

export const formatDateAxis = (dateString) => {
  const date = new Date(dateString);
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  }).format(date);
};

export const formatRelativeTime = (dateString, fallback = 'Never') => {
  if (!dateString) return fallback;
  const date = new Date(dateString);
  if (Number.isNaN(date.getTime())) return fallback;
  const diffMins = Math.max(0, Math.floor((Date.now() - date.getTime()) / 60000));
  if (diffMins < 1) return 'Just now';
  if (diffMins < 60) return `${diffMins}m ago`;
  const diffHours = Math.floor(diffMins / 60);
  if (diffHours < 24) return `${diffHours}h ago`;
  return `${Math.floor(diffHours / 24)}d ago`;
};

export const formatDayOrdinal = (day) => {
  if (day == null) return null;
  const n = Number(day);
  if (!Number.isInteger(n) || n < 1 || n > 31) return null;
  const suffix = n % 100 >= 11 && n % 100 <= 13 ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' }[n % 10] || 'th');
  return `${n}${suffix}`;
};

// A base-unit integer (wei, or a token's own smallest unit) rendered as a
// decimal amount. BigInt throughout: a uint256 is far past Number precision, and
// the balance audit exists to surface differences that Number would round away
// into agreement. `decimals` follows the backend convention -- null means 18.
export const formatTokenUnits = (units, decimals = 18, { maxFractionDigits = 6 } = {}) => {
  if (units === null || units === undefined || units === '') return null;
  const text = String(units).trim();
  if (!/^-?\d+$/.test(text)) return null;
  const scale = Number.isInteger(decimals) && decimals >= 0 ? decimals : 18;
  const value = BigInt(text);
  const negative = value < 0n;
  const magnitude = negative ? -value : value;
  const base = 10n ** BigInt(scale);
  const whole = (magnitude / base).toString();
  // Truncated, never rounded: rounding a residual drift up to the next display
  // digit is how a real 1-wei discrepancy comes to read as a clean zero.
  const fraction = scale === 0
    ? ''
    : (magnitude % base).toString().padStart(scale, '0').slice(0, maxFractionDigits).replace(/0+$/, '');
  // Grouped by regex on the digit string, not via Number: a scam token can mint
  // a whole part past 2^53, and toLocaleString would quietly corrupt it.
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${negative ? '-' : ''}${grouped}${fraction ? `.${fraction}` : ''}`;
};

// The same rendering at FULL precision: every digit the asset's decimals allow,
// so truncation is impossible. This is what the balance audit's deltas use.
// formatTokenUnits' six-digit default renders a sub-microether drift as '0',
// which in the audit reads as "the ledger is 0 ETH off" beside two figures
// printed identically -- the exact opposite of what a mismatch row means. And
// because a nonzero magnitude always keeps a nonzero digit here, a bare '-0'
// can never be printed either.
export const formatExactUnits = (units, decimals = 18) => {
  const scale = Number.isInteger(decimals) && decimals >= 0 ? decimals : 18;
  return formatTokenUnits(units, scale, { maxFractionDigits: scale });
};

export const formatCompactCurrency = (value) => {
  const sign = value < 0 ? '-' : '';
  const abs = Math.abs(value);
  if (abs >= 1_000_000) {
    return `${sign}$${(abs / 1_000_000).toFixed(1)}M`;
  }
  if (abs >= 1_000) {
    return `${sign}$${(abs / 1_000).toFixed(0)}K`;
  }
  return formatCurrency(value);
};

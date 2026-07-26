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

// Crypto quantities arrive as full-precision decimal STRINGS -- 18 decimals of
// wei, or NUMERIC(38,18) off an exchange record -- and Number() silently
// rounds anything past ~15 significant digits. This formats the string itself:
// half-up rounding through BigInt, then trailing zeros trimmed and the whole
// part grouped.
//
// A non-zero amount that rounds to zero renders as "<0.000001" rather than
// "0": a ledger row reading 0 for a real (if tiny) movement is a lie, and dust
// is exactly what a crypto ledger is full of.
export const formatExactUnits = (value, { maxFractionDigits = 6 } = {}) => {
  if (value === null || value === undefined || value === '') return '0';
  const text = String(value).trim();
  if (!/^-?\d*(\.\d*)?$/.test(text) || text === '' || text === '-' || text === '.') return text;

  const negative = text.startsWith('-');
  const [wholeRaw = '0', fracRaw = ''] = text.replace(/^-/, '').split('.');
  const whole = wholeRaw || '0';

  let outWhole = whole;
  let outFrac = fracRaw.slice(0, maxFractionDigits);
  if (fracRaw.length > maxFractionDigits && fracRaw.charCodeAt(maxFractionDigits) >= 53) {
    // Carry through the decimal point without ever building a float.
    const bumped = (BigInt(whole + outFrac.padEnd(maxFractionDigits, '0') || '0') + 1n)
      .toString()
      .padStart(maxFractionDigits + 1, '0');
    outWhole = maxFractionDigits ? bumped.slice(0, -maxFractionDigits) : bumped;
    outFrac = maxFractionDigits ? bumped.slice(-maxFractionDigits) : '';
  }
  outFrac = outFrac.replace(/0+$/, '');

  const isZero = /^0*$/.test(outWhole) && outFrac === '';
  const wasZero = /^0*$/.test(whole) && /^0*$/.test(fracRaw);
  if (isZero && !wasZero) {
    return `${negative ? '-' : ''}<0.${'0'.repeat(Math.max(0, maxFractionDigits - 1))}1`;
  }

  const grouped = BigInt(outWhole || '0').toLocaleString('en-US');
  const sign = negative && !isZero ? '-' : '';
  return `${sign}${grouped}${outFrac ? `.${outFrac}` : ''}`;
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

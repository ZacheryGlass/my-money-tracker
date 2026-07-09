const NON_PURCHASE_CATEGORIES = new Set([
  'TRANSFER_IN',
  'TRANSFER_OUT',
  'LOAN_PAYMENTS',
  'BUY',
  'SELL',
  'CONTRIBUTION',
  'WITHDRAWAL',
  'DIVIDEND',
  'GOVERNMENT_AND_NON_PROFIT',
]);

const INCOME_CATEGORIES = new Set([
  'INCOME',
  'PAYROLL',
  'DEPOSIT',
  'INTEREST',
]);

const NON_PURCHASE_PATTERNS = [
  /\bshares?\b/i,
  /\bpurchased\b/i,
  /\bcontribution\b/i,
  /\bpayment thank you\b/i,
  /\bautopay\b/i,
  /\binternal revenue\b/i,
  /\birs\b/i,
  /\btreasury\b/i,
  /\bvanguard\b/i,
  /\bt\. rowe price\b/i,
];

const INCOME_PATTERNS = [
  /\bpayroll\b/i,
  /\bsalary\b/i,
  /\bpaycheck\b/i,
  /\bdirect dep(osit)?\b/i,
  /\bwages?\b/i,
  /\binterest paid\b/i,
];

const KIND_RULES = [
  {
    name: 'Transfers & Investments',
    categories: ['TRANSFER_IN', 'TRANSFER_OUT', 'LOAN_PAYMENTS', 'BUY', 'SELL', 'CONTRIBUTION', 'DEPOSIT', 'WITHDRAWAL', 'DIVIDEND'],
    patterns: [/\btransfer\b/i, /\bpayment\b/i, /\bshares?\b/i, /\binvest\b/i, /\bcontribution\b/i],
  },
  {
    name: 'Taxes & Government',
    categories: ['GOVERNMENT_AND_NON_PROFIT'],
    patterns: [/\binternal revenue\b/i, /\birs\b/i, /\btax\b/i, /\btreasury\b/i, /\bdmv\b/i],
  },
  {
    name: 'Food & Drink',
    categories: ['FOOD_AND_DRINK'],
    patterns: [/\brestaurant\b/i, /\bcafe\b/i, /\bcoffee\b/i, /\bstarbucks\b/i, /\bdoordash\b/i, /\buber eats\b/i, /\bgrubhub\b/i],
  },
  {
    name: 'Groceries & Household',
    categories: ['GROCERIES'],
    patterns: [/\bgrocery\b/i, /\bmarket\b/i, /\btrader joe/i, /\baldi\b/i, /\bkroger\b/i, /\bwhole foods\b/i, /\bcostco\b/i, /\bsams club\b/i],
  },
  {
    name: 'Shopping & Retail',
    categories: ['GENERAL_MERCHANDISE', 'MERCHANDISE'],
    patterns: [/\bamazon\b/i, /\btarget\b/i, /\bwalmart\b/i, /\bbest buy\b/i, /\bebay\b/i, /\bstore\b/i],
  },
  {
    name: 'Housing & Utilities',
    categories: ['RENT_AND_UTILITIES'],
    patterns: [/\brent\b/i, /\butility\b/i, /\belectric\b/i, /\bwater\b/i, /\binternet\b/i, /\bcomcast\b/i, /\bspectrum\b/i, /\bphone\b/i],
  },
  {
    name: 'Auto & Transportation',
    categories: ['TRANSPORTATION', 'GAS'],
    patterns: [/\bgas\b/i, /\bfuel\b/i, /\bshell\b/i, /\bexxon\b/i, /\bchevron\b/i, /\bparking\b/i, /\btoll\b/i, /\buber\b/i, /\blyft\b/i],
  },
  {
    name: 'Health & Medical',
    categories: ['MEDICAL'],
    patterns: [/\bmedical\b/i, /\bdoctor\b/i, /\bdental\b/i, /\bpharmacy\b/i, /\bcvs\b/i, /\bwalgreens\b/i, /\bhealth\b/i],
  },
  {
    name: 'Subscriptions & Software',
    categories: ['SUBSCRIPTION'],
    patterns: [/\bnetflix\b/i, /\bspotify\b/i, /\badobe\b/i, /\bapple\.com\/bill\b/i, /\bgoogle\b/i, /\bmicrosoft\b/i, /\bgithub\b/i, /\bpatreon\b/i],
  },
  {
    name: 'Entertainment & Hobbies',
    categories: ['ENTERTAINMENT'],
    patterns: [/\btheater\b/i, /\bcinema\b/i, /\bsteam\b/i, /\bnintendo\b/i, /\bplaystation\b/i, /\bxbox\b/i, /\bticket\b/i],
  },
  {
    name: 'Travel',
    categories: ['TRAVEL'],
    patterns: [/\bairlines?\b/i, /\bhotel\b/i, /\bairbnb\b/i, /\bdelta\b/i, /\bunited\b/i, /\bsouthwest\b/i, /\bmarriott\b/i, /\bhilton\b/i],
  },
  {
    name: 'Personal & Professional Services',
    categories: ['PERSONAL_CARE', 'GENERAL_SERVICES'],
    patterns: [/\bsalon\b/i, /\bbarber\b/i, /\bgym\b/i, /\bfitness\b/i, /\bcleaning\b/i, /\bservice\b/i],
  },
  {
    name: 'Fees & Financial',
    categories: ['BANK_FEES'],
    patterns: [/\bfee\b/i, /\binterest charge\b/i, /\bfinance charge\b/i],
  },
];

export function cleanText(value) {
  return String(value || '').trim().replace(/\s+/g, ' ');
}

export function toTitleCase(value) {
  return cleanText(value)
    .replace(/_/g, ' ')
    .toLowerCase()
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

export function getMerchant(txn) {
  return cleanText(txn.merchant_name) || cleanText(txn.name) || 'Unknown Merchant';
}

export function getCategory(txn) {
  return txn.category ? toTitleCase(txn.category) : 'Uncategorized';
}

export function getCategoryKey(txn) {
  return cleanText(txn.category)
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

export function getSpend(txn) {
  const amount = Number(txn.amount) || 0;
  return amount > 0 ? amount : 0;
}

export function getIncome(txn) {
  const amount = Number(txn.amount) || 0;
  return amount < 0 ? Math.abs(amount) : 0;
}

export function getKind(txn) {
  const categoryKey = getCategoryKey(txn);
  const text = [
    txn.merchantLabel || getMerchant(txn),
    txn.name,
    txn.categoryLabel || getCategory(txn),
    txn.account_name,
  ].map(cleanText).join(' ');

  const match = KIND_RULES.find((rule) => {
    if (rule.categories.includes(categoryKey)) return true;
    return rule.patterns.some((pattern) => pattern.test(text));
  });

  return match?.name || 'Other Purchases';
}

export function isEverydayPurchase(txn) {
  const categoryKey = getCategoryKey(txn);
  if (NON_PURCHASE_CATEGORIES.has(categoryKey)) return false;

  const text = [
    txn.merchantLabel || getMerchant(txn),
    txn.name,
    txn.categoryLabel || getCategory(txn),
    txn.account_name,
  ].map(cleanText).join(' ');

  return !NON_PURCHASE_PATTERNS.some((pattern) => pattern.test(text));
}

export function isLikelyIncome(txn) {
  if (getIncome(txn) <= 0) return false;

  const categoryKey = getCategoryKey(txn);
  const text = [
    txn.merchantLabel || getMerchant(txn),
    txn.name,
    txn.categoryLabel || getCategory(txn),
    txn.account_name,
  ].map(cleanText).join(' ');

  if (INCOME_CATEGORIES.has(categoryKey)) return true;
  if (INCOME_PATTERNS.some((pattern) => pattern.test(text))) return true;
  return !NON_PURCHASE_CATEGORIES.has(categoryKey);
}

export function classifyTransaction(txn) {
  const merchantLabel = getMerchant(txn);
  const categoryLabel = getCategory(txn);
  const row = {
    ...txn,
    spend: getSpend(txn),
    income: getIncome(txn),
    merchantLabel,
    categoryLabel,
  };

  row.categoryKey = getCategoryKey(row);
  row.kindLabel = getKind(row);
  row.isEveryday = isEverydayPurchase(row);
  row.isLikelyIncome = isLikelyIncome(row);
  row.searchText = [
    merchantLabel,
    txn.name,
    categoryLabel,
    row.kindLabel,
    txn.account_name,
  ].join(' ').toLowerCase();

  return row;
}

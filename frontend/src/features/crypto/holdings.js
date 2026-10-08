import { getCryptoMeta } from './meta';

export const holdingValue = (holding) => parseFloat(holding.current_value ?? holding.manual_value ?? 0) || 0;

// A holding with no price is unknown, not small: "Hide under $1" must never
// fold a 3 BTC position away because nothing priced it.
export const isPriced = (holding) => holding.current_value != null || holding.manual_value != null;
export const isDust = (holding) => isPriced(holding) && holdingValue(holding) < 1;

// Wallet syncs and exchange snapshots rebuild these rows; a manual edit would
// be silently clobbered.
export const isSyncManaged = (holding) => Boolean(
  holding.is_plaid_managed || holding.account_eth_wallet_id || holding.account_exchange_account_id
);

export const holdingSource = (holding) => {
  if (holding.account_eth_wallet_id) return 'wallet';
  if (holding.account_exchange_account_id) return 'exchange';
  return 'manual';
};

// Token holdings carry their network in the name ("USDC.e 0x2791…4174
// (Polygon)") because holdings are matched by name; that suffix is data and
// stays. For display it reads better as a chip, split off here only when it
// names a known network.
export function splitNetworkSuffix(name) {
  const text = String(name || '');
  const match = text.match(/^(.*\S)\s+\(([^)]+)\)$/);
  if (!match) return { base: text, network: null };
  const networks = getCryptoMeta()?.networks || [];
  const known = networks.some((network) => [network.name, network.shortName].includes(match[2]));
  return known ? { base: match[1], network: match[2] } : { base: text, network: null };
}

// One row per asset across every account that holds it. A ticker groups (ETH
// on mainnet, Arbitrum and three exchanges is one position); a token without a
// ticker is its own asset, keyed by its name, which already names contract and
// network.
export function groupHoldingsByAsset(holdings) {
  const groups = new Map();
  for (const holding of holdings || []) {
    const ticker = holding.ticker ? String(holding.ticker).toUpperCase() : null;
    const key = ticker ? `t:${ticker}` : `n:${holding.name}`;
    let group = groups.get(key);
    if (!group) {
      group = { key, ticker, name: ticker ? null : holding.name, quantity: 0, value: 0, holdings: [] };
      groups.set(key, group);
    }
    group.holdings.push(holding);
    group.value += holdingValue(holding);
    group.quantity += parseFloat(holding.quantity) || 0;
  }
  return [...groups.values()]
    .map((group) => {
      const largest = [...group.holdings].sort((a, b) => holdingValue(b) - holdingValue(a))[0];
      // The most valuable holding names the asset ("Ethereum", not "ETH (Arbitrum)").
      const display = group.ticker ? splitNetworkSuffix(largest.name).base : group.name;
      return { ...group, display, holdings: group.holdings.sort((a, b) => holdingValue(b) - holdingValue(a)) };
    })
    .sort((a, b) => b.value - a.value);
}

// A manual holding whose ticker and exact quantity equal a synced wallet or
// exchange balance is probably the same coins counted twice -- a hint only:
// legacy manual holdings are never assumed to be duplicates.
export function possibleDuplicates(holdings) {
  const quantityKey = (holding) => {
    const quantity = parseFloat(holding.quantity);
    return Number.isFinite(quantity) && quantity > 0 ? quantity.toFixed(8) : null;
  };
  const managed = new Map();
  for (const holding of holdings || []) {
    if (!isSyncManaged(holding) || !holding.ticker) continue;
    const q = quantityKey(holding);
    if (!q) continue;
    const key = `${String(holding.ticker).toUpperCase()}|${q}`;
    managed.set(key, [...(managed.get(key) || []), holding]);
  }
  const out = new Map();
  for (const holding of holdings || []) {
    if (isSyncManaged(holding) || !holding.ticker) continue;
    const q = quantityKey(holding);
    const matches = q && managed.get(`${String(holding.ticker).toUpperCase()}|${q}`);
    if (matches?.length) out.set(holding.id, matches);
  }
  return out;
}

// Value by where it is held, for the Overview's split bar.
export function valueBySource(holdings) {
  const totals = { wallet: 0, exchange: 0, manual: 0 };
  for (const holding of holdings || []) totals[holdingSource(holding)] += holdingValue(holding);
  return totals;
}

// The total's change over `days`, from the nightly "All crypto" series: the
// newest point against the last point on or before `days` earlier.
export function changeOverDays(series, days = 30) {
  if (!series?.length) return null;
  const last = series[series.length - 1];
  const cutoff = new Date(`${last.snapshot_date}T00:00:00Z`);
  cutoff.setUTCDate(cutoff.getUTCDate() - days);
  const cutoffKey = cutoff.toISOString().slice(0, 10);
  const base = [...series].reverse().find((point) => point.snapshot_date <= cutoffKey);
  if (!base || !(base.total_value > 0)) return null;
  const change = last.total_value - base.total_value;
  return { change, percent: (change / base.total_value) * 100, since: base.snapshot_date };
}

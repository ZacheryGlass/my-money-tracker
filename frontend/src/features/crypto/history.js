// One "All crypto" line from per-account snapshots: the sum of every account's
// value on each snapshot date, the same rule /api/history/portfolio applies to
// the whole portfolio. The nightly job writes every account in one pass, so a
// date only lacks an account that did not exist (or held nothing) yet.
export function totalSeries(accountRows) {
  const totals = new Map();
  for (const row of accountRows || []) {
    const date = String(row.snapshot_date || '').split('T')[0];
    if (!date) continue;
    const value = parseFloat(row.total_value);
    totals.set(date, (totals.get(date) || 0) + (Number.isFinite(value) ? value : 0));
  }
  return [...totals.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([snapshot_date, total_value]) => ({ snapshot_date, total_value }));
}

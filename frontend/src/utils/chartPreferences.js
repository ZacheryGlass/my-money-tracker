export const YEAR_REVIEW_CHARTS = [
  { id: 'monthlyChange', label: 'Monthly Net Worth Change', description: 'Monthly gains and losses.' },
  { id: 'cumulativeGrowth', label: 'Cumulative Growth', description: 'Running growth from the start of the year.' },
  { id: 'trajectory', label: 'Net Worth Trajectory', description: 'Absolute portfolio value over time.' },
  { id: 'allocation', label: 'Portfolio Allocation', description: 'Current asset mix.' },
  { id: 'monthlyCashFlow', label: 'Monthly Cash Flow', description: 'Income versus spending by month.' },
  { id: 'cashFlow', label: 'Cash Flow Summary', description: 'Annual or year-to-date income and spending totals.' },
];

const STORAGE_KEY = 'year-review-chart-preferences';
export const CHART_PREFERENCES_EVENT = 'chart-preferences-changed';

export const DEFAULT_CHART_PREFERENCES = Object.fromEntries(
  YEAR_REVIEW_CHARTS.map((chart) => [chart.id, true])
);

export function loadChartPreferences() {
  try {
    const saved = globalThis.localStorage?.getItem(STORAGE_KEY);
    return saved
      ? { ...DEFAULT_CHART_PREFERENCES, ...JSON.parse(saved) }
      : { ...DEFAULT_CHART_PREFERENCES };
  } catch {
    return { ...DEFAULT_CHART_PREFERENCES };
  }
}

export function saveChartPreferences(preferences) {
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(preferences));
    globalThis.window?.dispatchEvent(new Event(CHART_PREFERENCES_EVENT));
  } catch {
    // Preferences remain active for the current component state if storage is unavailable.
  }
}

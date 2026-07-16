import React, { useMemo } from 'react';
import { ChevronRight, X } from 'lucide-react';
import { formatCurrency, formatPercent } from '../utils/format';

const ReturnValue = ({ value }) => {
  if (!Number.isFinite(value)) {
    return <span className="font-money text-tertiary">—</span>;
  }

  return (
    <span className={`font-money font-semibold ${value >= 0 ? 'text-gain' : 'text-loss'}`}>
      {formatPercent(value)}
    </span>
  );
};

const DashboardTable = ({
  items = [],
  onNavigate,
  assetClassFilter = null,
  onClearAssetClassFilter,
}) => {
  const sortedItems = useMemo(() => (
    [...items]
      .filter((item) => item.type !== 'liability')
      .filter((item) => !assetClassFilter || item.assetClass === assetClassFilter)
      .sort((a, b) => Math.abs(b.value) - Math.abs(a.value))
  ), [assetClassFilter, items]);

  return (
    <div>
      {assetClassFilter && (
        <div className="flex items-center justify-between gap-3 border-b border-border bg-accent-subtle px-3 py-2">
          <span className="text-caption text-secondary">
            Showing <strong className="text-primary">{assetClassFilter}</strong> holdings
          </span>
          <button
            type="button"
            onClick={onClearAssetClassFilter}
            className="inline-flex items-center gap-1 text-caption font-semibold text-accent hover:underline"
          >
            Clear filter <X size={12} />
          </button>
        </div>
      )}

      <div className="hidden md:block">
        <table className="w-full table-fixed">
          <thead className="border-b border-border bg-surface-2">
            <tr>
              <th className="w-[36%] px-3 py-2 text-left text-caption font-semibold uppercase text-tertiary">Holding</th>
              <th className="w-[25%] px-3 py-2 text-left text-caption font-semibold uppercase text-tertiary">Account</th>
              <th className="w-[16%] px-3 py-2 text-left text-caption font-semibold uppercase text-tertiary">Asset class</th>
              <th className="w-[14%] px-3 py-2 text-right text-caption font-semibold uppercase text-tertiary">Value</th>
              <th className="w-[9%] px-3 py-2 text-right text-caption font-semibold uppercase text-tertiary">30D</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {sortedItems.map((item) => (
              <tr
                key={item.identity}
                className="cursor-pointer transition-colors hover:bg-surface-2"
                onClick={() => onNavigate('assets')}
              >
                <td className="px-3 py-2.5">
                  <div className="truncate text-body-sm font-semibold text-primary" title={item.name}>{item.name}</div>
                  {item.ticker && <div className="font-money text-caption text-tertiary">{item.ticker}</div>}
                </td>
                <td className="truncate px-3 py-2.5 text-body-sm text-secondary" title={item.displayAccount}>{item.displayAccount}</td>
                <td className="px-3 py-2.5 text-body-sm text-secondary">{item.assetClass}</td>
                <td className="px-3 py-2.5 text-right font-money text-title-sm font-semibold text-gain">
                  {formatCurrency(item.value)}
                </td>
                <td className="px-3 py-2.5 text-right text-body-sm" title="30-day position value change">
                  <ReturnValue value={item.thirtyDayReturnPercent} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="divide-y divide-border md:hidden">
        {sortedItems.map((item) => (
          <button
            key={item.identity}
            type="button"
            onClick={() => onNavigate('assets')}
            className="grid w-full grid-cols-[minmax(0,1fr)_auto] gap-4 px-3 py-3 text-left transition-colors hover:bg-surface-2"
          >
            <span className="min-w-0">
              <span className="block truncate text-title-sm font-semibold text-primary">{item.name}</span>
              <span className="mt-0.5 block truncate text-body-sm text-tertiary">
                {item.displayAccount} · {item.assetClass}
              </span>
            </span>
            <span className="text-right">
              <span className="block font-money text-display-sm font-semibold text-gain">
                {formatCurrency(item.value)}
              </span>
              <span className="mt-0.5 block text-body-sm">
                <ReturnValue value={item.thirtyDayReturnPercent} />
                <span className="ml-1 text-caption text-tertiary">30D</span>
              </span>
            </span>
          </button>
        ))}
      </div>

      {sortedItems.length === 0 && (
        <div className="px-4 py-10 text-center text-body-sm text-tertiary">
          No holdings match this view.
        </div>
      )}

      {sortedItems.length > 0 && (
        <button
          type="button"
          onClick={() => onNavigate('assets')}
          className="flex w-full items-center justify-center gap-1 border-t border-border bg-surface-2 px-3 py-2.5 text-body-sm font-semibold text-accent transition-colors hover:bg-surface-3"
        >
          Open holdings manager <ChevronRight size={13} />
        </button>
      )}
    </div>
  );
};

export default DashboardTable;

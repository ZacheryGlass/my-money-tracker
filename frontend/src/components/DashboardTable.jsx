import React, { useMemo, useState } from 'react';
import {
  useReactTable,
  getCoreRowModel,
  getSortedRowModel,
  flexRender,
} from '@tanstack/react-table';
import { ChevronUp, ChevronDown } from 'lucide-react';
import { formatCurrency } from '../utils/format';
import { buildAccountDisplayNameMap } from '../utils/accountDisplay';
import { formatCategoryLabel } from '../utils/dataLabels';
import { useIsMobile } from '../hooks/useMediaQuery';

const DashboardTable = ({ items, onNavigate }) => {
  const isMobile = useIsMobile();
  const [showAllMobile, setShowAllMobile] = useState(false);
  const [sorting, setSorting] = React.useState([{ id: 'value', desc: true }]);
  const accountDisplayNames = useMemo(() => buildAccountDisplayNameMap(
    items.map((item) => ({
      id: item.account_id,
      effective_name: item.account,
      account_source_name: item.account_source_name,
      name: item.account_source_name || item.account,
    }))
  ), [items]);

  const columns = useMemo(
    () => [
      {
        accessorKey: 'name',
        header: 'Asset Name',
        cell: ({ getValue }) => {
          const name = getValue();
          return (
            <span className="block truncate font-semibold text-primary" title={name}>
              {name}
            </span>
          );
        },
        meta: {
          headerClassName: 'w-[30%] min-w-[220px]',
          cellClassName: 'w-[30%] min-w-[220px]',
        },
      },
      {
        accessorKey: 'ticker',
        header: 'Ticker',
        cell: ({ getValue }) => (
          <span className="font-money text-caption px-1.5 py-0.5 bg-surface-3 text-tertiary border border-border">
            {getValue() || '-'}
          </span>
        ),
        meta: {
          headerClassName: 'w-[95px]',
          cellClassName: 'w-[95px] whitespace-nowrap',
        },
      },
      {
        accessorKey: 'value',
        header: 'Current Value',
        cell: ({ row }) => {
          const value = row.original.value;
          const isLiability = row.original.type === 'liability';
          return (
            <span className={`font-money text-title-md font-semibold ${isLiability ? 'text-loss' : 'text-gain'}`}>
              {formatCurrency(Math.abs(value))}
            </span>
          );
        },
        meta: {
          align: 'right',
          headerClassName: 'w-[150px]',
          cellClassName: 'w-[150px] whitespace-nowrap text-right',
        },
      },
      {
        accessorKey: 'account',
        header: 'Account',
        cell: ({ row }) => {
          const name = accountDisplayNames.get(row.original.account_id) || row.original.account || 'Other';
          return (
            <span className="block truncate text-tertiary" title={name}>
              {name}
            </span>
          );
        },
        meta: {
          headerClassName: 'w-[220px]',
          cellClassName: 'w-[220px]',
        },
      },
      {
        accessorKey: 'category',
        header: 'Category',
        cell: ({ getValue }) => (
          <span className="text-caption text-tertiary">{formatCategoryLabel(getValue())}</span>
        ),
        meta: {
          headerClassName: 'w-[150px]',
          cellClassName: 'w-[150px] whitespace-nowrap',
        },
      },
      {
        accessorKey: 'type',
        header: 'Type',
        cell: ({ getValue }) => {
          const type = getValue();
          return (
            <span
              className={`px-2 py-0.5 text-caption font-semibold uppercase ${
                type === 'liability'
                  ? 'bg-loss-bg text-loss'
                  : 'bg-gain-bg text-gain'
              }`}
            >
              {type === 'liability' ? 'Liability' : 'Asset'}
            </span>
          );
        },
        meta: {
          headerClassName: 'w-[110px]',
          cellClassName: 'w-[110px] whitespace-nowrap',
        },
      },
    ],
    [accountDisplayNames]
  );

  const table = useReactTable({
    data: items,
    columns,
    state: { sorting },
    onSortingChange: setSorting,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
  });

  const accountTotals = useMemo(() => {
    const totals = {};
    items.forEach((item) => {
      const key = item.account_id ?? item.account ?? 'Other';
      if (!totals[key]) {
        totals[key] = {
          id: key,
          name: accountDisplayNames.get(item.account_id) || item.account || 'Other',
          value: 0,
        };
      }
      totals[key].value += item.value;
    });
    return Object.values(totals).sort((a, b) => b.value - a.value);
  }, [items, accountDisplayNames]);

  const categoryTotals = useMemo(() => {
    const totals = {};
    items.forEach((item) => {
      const category = formatCategoryLabel(item.category);
      if (!totals[category]) totals[category] = 0;
      totals[category] += item.value;
    });
    return Object.entries(totals).sort((a, b) => b[1] - a[1]);
  }, [items]);
  const sortedRows = table.getRowModel().rows;
  const mobileRows = isMobile && !showAllMobile ? sortedRows.slice(0, 8) : sortedRows;

  return (
    <div className="flex flex-col gap-4">
      <div className="order-2">
        <div className="hidden max-w-full overflow-hidden xl:block">
          <table className="w-full table-fixed divide-y divide-border">
            <thead className="bg-surface-2">
              {table.getHeaderGroups().map((headerGroup) => (
                <tr key={headerGroup.id}>
                  {headerGroup.headers.map((header) => {
                    const meta = header.column.columnDef.meta || {};
                    return (
                      <th
                        key={header.id}
                        className={`cursor-pointer px-3 py-2 text-left text-caption font-semibold uppercase tracking-wide text-tertiary transition-colors hover:bg-surface-3 hover:text-secondary ${meta.headerClassName || ''}`}
                        onClick={header.column.getToggleSortingHandler()}
                      >
                        <div className={`flex items-center gap-1 ${meta.align === 'right' ? 'justify-end' : ''}`}>
                          {flexRender(header.column.columnDef.header, header.getContext())}
                          <span className="opacity-50">
                            {header.column.getIsSorted() === 'asc' ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
                          </span>
                        </div>
                      </th>
                    );
                  })}
                </tr>
              ))}
            </thead>
            <tbody className="divide-y divide-border">
              {table.getRowModel().rows.length === 0 ? (
                <tr>
                  <td colSpan={columns.length} className="px-3 py-8 text-center text-tertiary text-body-sm">
                    No holdings found in this portfolio.
                  </td>
                </tr>
              ) : (
                table.getRowModel().rows.map((row) => (
                  <tr key={row.id} className="hover:bg-surface-2 transition-colors cursor-pointer" onClick={() => onNavigate('accounts')}>
                    {row.getVisibleCells().map((cell) => {
                      const meta = cell.column.columnDef.meta || {};
                      return (
                        <td key={cell.id} className={`px-3 py-2 text-body-sm ${meta.cellClassName || 'whitespace-nowrap'}`}>
                          {flexRender(cell.column.columnDef.cell, cell.getContext())}
                        </td>
                      );
                    })}
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        {/* Mobile Card View */}
        <div className="divide-y divide-border xl:hidden">
          {sortedRows.length === 0 ? (
            <div className="px-3 py-8 text-center text-tertiary text-body-sm">No holdings found.</div>
          ) : (
            mobileRows.map((row) => (
              <div key={row.id} className="p-3 hover:bg-surface-2 transition-colors cursor-pointer" onClick={() => onNavigate('accounts')}>
                <div className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-x-4">
                  <div className="min-w-0">
                    <div className="truncate text-title-sm font-semibold text-primary">{row.original.name}</div>
                    <div className="mt-1 flex min-w-0 items-center gap-2">
                        <span className="font-money text-caption px-1.5 py-0.5 bg-surface-3 text-tertiary border border-border">
                          {row.original.ticker || '-'}
                        </span>
                        <span className="truncate text-body-sm text-tertiary">{accountDisplayNames.get(row.original.account_id) || row.original.account || 'Other'}</span>
                    </div>
                  </div>
                  <div className="text-right">
                    <span
                      className={`inline-flex px-2 py-0.5 text-caption font-semibold uppercase ${
                        row.original.type === 'liability'
                          ? 'bg-loss-bg text-loss'
                          : 'bg-gain-bg text-gain'
                      }`}
                    >
                      {row.original.type === 'liability' ? 'Liability' : 'Asset'}
                    </span>
                    <div className="mt-2 text-caption uppercase text-tertiary">Value</div>
                    <div className={`font-money text-display-md font-semibold leading-tight ${row.original.type === 'liability' ? 'text-loss' : 'text-gain'}`}>
                      {formatCurrency(Math.abs(row.original.value))}
                    </div>
                  </div>
                </div>
              </div>
            ))
          )}
          {isMobile && sortedRows.length > 8 && (
            <button
              type="button"
              onClick={() => setShowAllMobile((shown) => !shown)}
              className="flex min-h-12 w-full items-center justify-center border-t border-border bg-surface-2 px-4 text-body-sm font-semibold text-accent transition-colors hover:bg-surface-3"
            >
              {showAllMobile ? 'Show fewer holdings' : `Show all ${sortedRows.length} holdings`}
            </button>
          )}
        </div>
      </div>

      {/* Breakdowns */}
      <div className="order-1 grid grid-cols-1 gap-px bg-border md:grid-cols-2">
        <div className="card p-4 space-y-2">
          <h3 className="text-caption text-tertiary uppercase tracking-wide">
            Account Subtotals
          </h3>
          <div className="space-y-1">
            {accountTotals.map((account) => (
              <div key={account.id} className="flex items-center justify-between gap-3 px-2 py-1.5 hover:bg-surface-2 transition-colors cursor-pointer" onClick={() => onNavigate('accounts')}>
                <span className="min-w-0 truncate text-body-sm text-secondary">{account.name}</span>
                <span className={`shrink-0 font-money text-title-sm font-semibold ${account.value < 0 ? 'text-loss' : 'text-gain'}`}>
                  {formatCurrency(account.value)}
                </span>
              </div>
            ))}
          </div>
        </div>

        <div className="card p-4 space-y-2">
          <h3 className="text-caption text-tertiary uppercase tracking-wide">
            Category Breakdown
          </h3>
          <div className="space-y-1">
            {categoryTotals.map(([category, total]) => (
              <div key={category} className="flex items-center justify-between gap-3 px-2 py-1.5">
                <span className="min-w-0 truncate text-body-sm text-secondary">{category}</span>
                <span className={`shrink-0 font-money text-title-sm font-semibold ${total < 0 ? 'text-loss' : 'text-gain'}`}>
                  {formatCurrency(total)}
                </span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
};

export default DashboardTable;

import React, { useMemo } from 'react';
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

const DashboardTable = ({ items, onNavigate }) => {
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
            <span className={`font-money font-semibold ${isLiability ? 'text-loss' : 'text-gain'}`}>
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

  return (
    <div className="space-y-4">
      <div>
        <div className="hidden max-w-full overflow-x-auto lg:block">
          <table className="w-full min-w-[945px] table-fixed divide-y divide-border">
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
        <div className="lg:hidden divide-y divide-border">
          {table.getRowModel().rows.length === 0 ? (
            <div className="px-3 py-8 text-center text-tertiary text-body-sm">No holdings found.</div>
          ) : (
            table.getRowModel().rows.map((row) => (
              <div key={row.id} className="p-3 hover:bg-surface-2 transition-colors cursor-pointer" onClick={() => onNavigate('accounts')}>
                <div className="space-y-2">
                  <div className="flex justify-between items-start">
                    <div className="min-w-0 pr-3">
                      <div className="truncate text-body-sm font-semibold text-primary">{row.original.name}</div>
                      <div className="flex items-center gap-2 mt-0.5">
                        <span className="font-money text-caption px-1.5 py-0.5 bg-surface-3 text-tertiary border border-border">
                          {row.original.ticker || '-'}
                        </span>
                        <span className="text-caption text-tertiary">{row.original.account}</span>
                      </div>
                    </div>
                    <span
                      className={`px-2 py-0.5 text-caption font-semibold uppercase ${
                        row.original.type === 'liability'
                          ? 'bg-loss-bg text-loss'
                          : 'bg-gain-bg text-gain'
                      }`}
                    >
                      {row.original.type === 'liability' ? 'Liability' : 'Asset'}
                    </span>
                  </div>

                  <div className="flex items-center justify-between pt-2 border-t border-border">
                    <span className="text-caption text-tertiary uppercase">Value</span>
                    <span className={`font-money font-semibold ${row.original.type === 'liability' ? 'text-loss' : 'text-gain'}`}>
                      {formatCurrency(Math.abs(row.original.value))}
                    </span>
                  </div>
                </div>
              </div>
            ))
          )}
        </div>
      </div>

      {/* Breakdowns */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-px bg-border">
        <div className="card p-4 space-y-2">
          <h3 className="text-caption text-tertiary uppercase tracking-wide">
            Account Subtotals
          </h3>
          <div className="space-y-1">
            {accountTotals.map((account) => (
              <div key={account.id} className="flex justify-between items-center px-2 py-1.5 hover:bg-surface-2 transition-colors cursor-pointer" onClick={() => onNavigate('accounts')}>
                <span className="text-body-sm text-secondary">{account.name}</span>
                <span className={`font-money text-body-sm font-semibold ${account.value < 0 ? 'text-loss' : 'text-gain'}`}>
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
              <div key={category} className="flex justify-between items-center px-2 py-1.5">
                <span className="text-body-sm text-secondary">{category}</span>
                <span className={`font-money text-body-sm font-semibold ${total < 0 ? 'text-loss' : 'text-gain'}`}>
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

import React, { useMemo } from 'react';
import {
  useReactTable,
  getCoreRowModel,
  getSortedRowModel,
  flexRender,
} from '@tanstack/react-table';
import { motion } from 'framer-motion';
import { ChevronUp, ChevronDown, ListFilter, CreditCard, Tag } from 'lucide-react';
import { formatCurrency } from '../utils/format';

const DashboardTable = ({ items }) => {
  const [sorting, setSorting] = React.useState([{ id: 'value', desc: true }]);

  const columns = useMemo(
    () => [
      { 
        accessorKey: 'name', 
        header: 'Asset Name',
        cell: ({ getValue }) => (
          <span className="font-bold text-primary">{getValue()}</span>
        )
      },
      {
        accessorKey: 'ticker',
        header: 'Ticker',
        cell: ({ getValue }) => (
          <span className="font-money text-[11px] px-1.5 py-0.5 rounded bg-surface-3 text-secondary border border-border/50">
            {getValue() || '-'}
          </span>
        ),
      },
      {
        accessorKey: 'value',
        header: 'Current Value',
        cell: ({ row }) => {
          const value = row.original.value;
          const isLiability = row.original.type === 'liability';
          return (
            <span className={`font-money font-bold ${isLiability ? 'text-loss' : 'text-gain'}`}>
              {formatCurrency(Math.abs(value))}
            </span>
          );
        },
      },
      { 
        accessorKey: 'account', 
        header: 'Account',
        cell: ({ getValue }) => (
          <div className="flex items-center gap-2 text-secondary">
            <CreditCard size={14} className="opacity-50" />
            <span className="text-sm">{getValue()}</span>
          </div>
        )
      },
      {
        accessorKey: 'category',
        header: 'Category',
        cell: ({ getValue }) => (
          <div className="flex items-center gap-2 text-tertiary">
            <Tag size={14} className="opacity-50" />
            <span className="text-xs font-medium">{getValue() || '-'}</span>
          </div>
        )
      },
      {
        accessorKey: 'type',
        header: 'Type',
        cell: ({ getValue }) => {
          const type = getValue();
          return (
            <span
              className={`px-2.5 py-1 text-[10px] font-bold uppercase tracking-wider rounded-full ${
                type === 'liability' 
                  ? 'bg-loss/10 text-loss border border-loss/20' 
                  : 'bg-gain/10 text-gain border border-gain/20'
              }`}
            >
              {type === 'liability' ? 'Liability' : 'Asset'}
            </span>
          );
        },
      },
    ],
    []
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
      if (!totals[item.account]) totals[item.account] = 0;
      totals[item.account] += item.value;
    });
    return Object.entries(totals).sort((a, b) => b[1] - a[1]);
  }, [items]);

  const categoryTotals = useMemo(() => {
    const totals = {};
    items.forEach((item) => {
      if (!totals[item.category]) totals[item.category] = 0;
      totals[item.category] += item.value;
    });
    return Object.entries(totals).sort((a, b) => b[1] - a[1]);
  }, [items]);

  return (
    <div className="space-y-8">
      <div className="space-y-4">
        <div className="flex items-center justify-between px-2">
          <div className="flex items-center gap-2">
            <ListFilter size={18} className="text-accent" />
            <h3 className="text-[11px] font-bold tracking-widest uppercase text-tertiary">
              Portfolio Holdings
            </h3>
          </div>
          <span className="text-[10px] text-tertiary font-medium">
            {items.length} positions
          </span>
        </div>

        <div className="card overflow-hidden bg-surface-2/30 backdrop-blur-sm border-border/50">
          <div className="hidden lg:block overflow-x-auto">
            <table className="min-w-full divide-y divide-border">
              <thead className="bg-surface-3/50">
                {table.getHeaderGroups().map((headerGroup) => (
                  <tr key={headerGroup.id}>
                    {headerGroup.headers.map((header) => (
                      <th
                        key={header.id}
                        className="px-6 py-4 text-left text-[10px] font-bold tracking-widest uppercase text-secondary cursor-pointer hover:bg-surface-3 hover:text-primary transition-all group"
                        onClick={header.column.getToggleSortingHandler()}
                      >
                      <div className="flex items-center gap-2">
                        {flexRender(header.column.columnDef.header, header.getContext())}
                        <div className="opacity-0 group-hover:opacity-100 transition-opacity">
                          {header.column.getIsSorted() === 'asc' ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
                        </div>
                      </div>
                    </th>
                  ))}
                </tr>
              ))}
            </thead>
            <tbody className="divide-y divide-border/50">
              {table.getRowModel().rows.length === 0 ? (
                <tr>
                  <td colSpan={columns.length} className="px-6 py-12 text-center text-tertiary italic text-sm">
                    No holdings found in this portfolio.
                  </td>
                </tr>
              ) : (
                table.getRowModel().rows.map((row) => (
                  <tr key={row.id} className="hover:bg-accent/5 transition-colors group">
                    {row.getVisibleCells().map((cell) => (
                      <td key={cell.id} className="px-6 py-4 whitespace-nowrap text-sm text-primary">
                        {flexRender(cell.column.columnDef.cell, cell.getContext())}
                      </td>
                    ))}
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

          {/* Mobile Card View */}
          <div className="lg:hidden divide-y divide-border/50">
          {table.getRowModel().rows.length === 0 ? (
            <div className="px-4 py-12 text-center text-tertiary italic">No holdings found.</div>
          ) : (
            table.getRowModel().rows.map((row) => (
              <div key={row.id} className="p-5 hover:bg-surface-3 transition-colors active:bg-surface-3">
                <div className="space-y-4">
                  <div className="flex justify-between items-start">
                    <div className="space-y-1">
                      <div className="font-bold text-primary leading-tight">{row.original.name}</div>
                      <div className="flex items-center gap-2">
                        <span className="font-money text-[10px] px-1.5 py-0.5 rounded bg-surface-3 text-secondary border border-border/50 tracking-wider">
                          {row.original.ticker || '-'}
                        </span>
                        <span className="text-[10px] text-tertiary font-medium uppercase tracking-wider">{row.original.account}</span>
                      </div>
                    </div>
                    <span
                      className={`px-2.5 py-1 text-[9px] font-bold uppercase tracking-wider rounded-full ${
                        row.original.type === 'liability' 
                          ? 'bg-loss/10 text-loss border border-loss/20' 
                          : 'bg-gain/10 text-gain border border-gain/20'
                      }`}
                    >
                      {row.original.type === 'liability' ? 'Liability' : 'Asset'}
                    </span>
                  </div>
                  
                  <div className="flex items-center justify-between pt-2 border-t border-border/30">
                    <div className="text-[10px] text-tertiary font-bold uppercase tracking-widest">Value</div>
                    <span className={`text-lg font-bold font-money ${row.original.type === 'liability' ? 'text-loss' : 'text-gain'}`}>
                      {formatCurrency(Math.abs(row.original.value))}
                    </span>
                  </div>
                </div>
              </div>
            ))
          )}
          </div>
        </div>
      </div>

      {/* Breakdowns Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <motion.div 
          whileHover={{ y: -4 }}
          className="card p-6 lg:p-8 space-y-6 bg-surface-2/30 backdrop-blur-sm"
        >
          <div className="flex items-center gap-2">
            <CreditCard size={18} className="text-blue-400" />
            <h3 className="text-[11px] font-bold tracking-widest uppercase text-tertiary">
              Account Subtotals
            </h3>
          </div>
          <div className="space-y-2">
            {accountTotals.map(([account, total]) => (
              <div key={account} className="flex justify-between items-center p-3 rounded-xl hover:bg-surface-3 transition-all group">
                <span className="text-secondary text-sm font-medium group-hover:text-primary transition-colors">{account}</span>
                <span className={`font-money text-sm font-bold ${total < 0 ? 'text-loss' : 'text-gain'}`}>
                  {formatCurrency(total)}
                </span>
              </div>
            ))}
          </div>
        </motion.div>

        <motion.div 
          whileHover={{ y: -4 }}
          className="card p-6 lg:p-8 space-y-6 bg-surface-2/30 backdrop-blur-sm"
        >
          <div className="flex items-center gap-2">
            <Tag size={18} className="text-purple-400" />
            <h3 className="text-[11px] font-bold tracking-widest uppercase text-tertiary">
              Category Breakdown
            </h3>
          </div>
          <div className="space-y-2">
            {categoryTotals.map(([category, total]) => (
              <div key={category} className="flex justify-between items-center p-3 rounded-xl hover:bg-surface-3 transition-all group">
                <span className="text-secondary text-sm font-medium group-hover:text-primary transition-colors">{category}</span>
                <span className={`font-money text-sm font-bold ${total < 0 ? 'text-loss' : 'text-gain'}`}>
                  {formatCurrency(total)}
                </span>
              </div>
            ))}
          </div>
        </motion.div>
      </div>
    </div>
  );
};

export default DashboardTable;

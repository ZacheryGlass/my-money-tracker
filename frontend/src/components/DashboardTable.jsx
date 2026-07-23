import React, { useMemo, useState } from 'react';
import { ChevronRight, X } from 'lucide-react';
import {
  useReactTable, getCoreRowModel, getSortedRowModel,
} from '@tanstack/react-table';
import { formatCurrency, formatPercent } from '../utils/format';
import DataTable from './DataTable';

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

const COLUMNS = [
  {
    accessorKey: 'name',
    header: 'Holding',
    meta: { width: '36%', cellClassName: 'min-w-0' },
    cell: ({ row }) => (
      <div className="min-w-0">
        <div className="truncate text-body-sm font-semibold text-primary" title={row.original.name}>{row.original.name}</div>
        {row.original.ticker && <div className="font-money text-caption text-tertiary">{row.original.ticker}</div>}
      </div>
    ),
  },
  {
    accessorKey: 'displayAccount',
    header: 'Account',
    meta: { width: '25%', cellClassName: 'truncate' },
    cell: ({ getValue }) => <span title={getValue()}>{getValue()}</span>,
  },
  {
    accessorKey: 'assetClass',
    header: 'Asset class',
    meta: { width: '16%', cellClassName: 'truncate' },
  },
  {
    accessorKey: 'value',
    header: 'Value',
    meta: { width: '14%', align: 'right', headerClassName: 'text-right', cellClassName: 'text-right' },
    cell: ({ getValue }) => (
      <span className="font-money text-title-sm font-semibold text-gain">{formatCurrency(getValue())}</span>
    ),
  },
  {
    accessorKey: 'thirtyDayReturnPercent',
    header: '30D',
    meta: { width: '9%', align: 'right', headerClassName: 'text-right', cellClassName: 'text-right' },
    cell: ({ getValue }) => (
      <span title="30-day position value change"><ReturnValue value={getValue()} /></span>
    ),
  },
];

const DashboardTable = ({
  items = [],
  onNavigate,
  assetClassFilter = null,
  onClearAssetClassFilter,
}) => {
  const [sorting, setSorting] = useState([{ id: 'value', desc: true }]);

  const data = useMemo(() => (
    items
      .filter((item) => item.type !== 'liability')
      .filter((item) => !assetClassFilter || item.assetClass === assetClassFilter)
  ), [assetClassFilter, items]);

  const table = useReactTable({
    data,
    columns: COLUMNS,
    state: { sorting },
    onSortingChange: setSorting,
    getRowId: (row, index) => row.identity ?? String(index),
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
  });

  return (
    <DataTable
      table={table}
      bare
      breakpoint="md"
      emptyMessage="No holdings match this view."
      onRowClick={() => onNavigate('assets')}
      header={assetClassFilter && (
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
      footer={data.length > 0 && (
        <button
          type="button"
          onClick={() => onNavigate('assets')}
          className="flex w-full items-center justify-center gap-1 border-t border-border bg-surface-2 px-3 py-2.5 text-body-sm font-semibold text-accent transition-colors hover:bg-surface-3"
        >
          Open holdings manager <ChevronRight size={13} />
        </button>
      )}
      renderMobileRow={(row) => (
        <button
          key={row.id}
          type="button"
          onClick={() => onNavigate('assets')}
          className="grid w-full grid-cols-[minmax(0,1fr)_auto] gap-4 px-3 py-3 text-left transition-colors hover:bg-surface-2"
        >
          <span className="min-w-0">
            <span className="block truncate text-title-sm font-semibold text-primary">{row.original.name}</span>
            <span className="mt-0.5 block truncate text-body-sm text-tertiary">
              {row.original.displayAccount} · {row.original.assetClass}
            </span>
          </span>
          <span className="text-right">
            <span className="block font-money text-display-sm font-semibold text-gain">
              {formatCurrency(row.original.value)}
            </span>
            <span className="mt-0.5 block text-body-sm">
              <ReturnValue value={row.original.thirtyDayReturnPercent} />
              <span className="ml-1 text-caption text-tertiary">30D</span>
            </span>
          </span>
        </button>
      )}
    />
  );
};

export default DashboardTable;

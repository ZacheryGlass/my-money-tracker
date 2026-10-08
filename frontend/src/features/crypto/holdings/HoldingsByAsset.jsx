import React, { useMemo, useState } from 'react';
import { getCoreRowModel, getSortedRowModel, useReactTable } from '@tanstack/react-table';
import { ChevronDown, ChevronRight } from 'lucide-react';
import DataTable from '../../../components/DataTable';
import { useMediaQuery } from '../../../hooks/useMediaQuery';
import { formatCurrency } from '../../../utils/format';
import { holdingValue, splitNetworkSuffix } from '../holdings';

const quantityText = (quantity) => quantity.toLocaleString(undefined, { maximumFractionDigits: 6 });

// One row per asset, summed across every wallet, exchange and manual account
// that holds it; a row opens to the accounts behind the total.
export default function HoldingsByAsset({ groups, accountName, renderHoldingChips, onOpenHolding }) {
  const [openKey, setOpenKey] = useState(null);
  // DataTable keeps the desktop table and the phone rows both in the DOM; the
  // breakdown mounts in the one on screen only (DataTable's lg breakpoint).
  const compact = useMediaQuery('(max-width: 1023px)');
  const [sorting, setSorting] = useState([{ id: 'value', desc: true }]);
  const columns = useMemo(() => [
    {
      id: 'asset',
      accessorFn: (group) => group.ticker || group.display,
      header: 'Asset',
      meta: { cellClassName: 'min-w-0' },
      cell: ({ row }) => {
        const group = row.original;
        const { base, network } = splitNetworkSuffix(group.display);
        return (
          <div className="flex min-w-0 items-center gap-2">
            {openKey === group.key
              ? <ChevronDown size={11} className="shrink-0 text-accent" />
              : <ChevronRight size={11} className="shrink-0 text-tertiary" />}
            {group.ticker && <span className="font-mono text-sm font-bold uppercase text-accent">{group.ticker}</span>}
            {/* "ETH ETH" says nothing twice: the name shows only when it adds one. */}
            {base.toUpperCase() !== group.ticker && (
              <span className="truncate text-body-sm font-semibold text-primary">{base}</span>
            )}
            {network && <NetworkChip name={network} />}
          </div>
        );
      },
    },
    {
      id: 'accounts',
      accessorFn: (group) => group.holdings.length,
      header: 'Held in',
      meta: { width: '8rem', cellClassName: 'whitespace-nowrap text-caption text-tertiary' },
      cell: ({ getValue }) => `${getValue()} ${getValue() === 1 ? 'account' : 'accounts'}`,
    },
    {
      id: 'quantity',
      accessorFn: (group) => group.quantity,
      header: 'Quantity',
      meta: { width: '9rem', align: 'right', headerClassName: 'text-right', cellClassName: 'whitespace-nowrap text-right' },
      cell: ({ getValue }) => <span className="font-money">{quantityText(getValue())}</span>,
    },
    {
      id: 'value',
      accessorFn: (group) => group.value,
      header: 'Value',
      meta: { width: '9rem', align: 'right', headerClassName: 'text-right', cellClassName: 'whitespace-nowrap text-right' },
      cell: ({ getValue }) => <span className="value-emphasis">{formatCurrency(getValue())}</span>,
    },
  ], [openKey]);

  const table = useReactTable({
    data: groups,
    columns,
    state: { sorting },
    onSortingChange: setSorting,
    getRowId: (group) => group.key,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
  });

  const breakdown = (group) => (
    <ul className="divide-y divide-border">
      {group.holdings.map((holding) => (
        <li key={holding.id}>
          <button
            type="button"
            onClick={() => onOpenHolding?.(holding)}
            className="flex w-full flex-wrap items-center gap-x-3 gap-y-1 px-2 py-1.5 text-left text-body-sm hover:bg-surface-3"
          >
            <span className="min-w-0 flex-1 truncate text-secondary">
              {accountName(holding)}
              {/* One account can hold the asset on two networks. */}
              {splitNetworkSuffix(holding.name).network && (
                <span className="ml-2"><NetworkChip name={splitNetworkSuffix(holding.name).network} /></span>
              )}
            </span>
            {renderHoldingChips?.(holding)}
            {/* A fixed column, or every source tag shifts with its quantity's width. */}
            <span className="min-w-[7rem] text-right font-money text-tertiary">{quantityText(parseFloat(holding.quantity) || 0)}</span>
            <span className="w-24 text-right font-money text-primary">{formatCurrency(holdingValue(holding))}</span>
          </button>
        </li>
      ))}
    </ul>
  );

  return (
    <DataTable
      table={table}
      emptyMessage="No crypto holdings found."
      onRowClick={(group) => setOpenKey((key) => (key === group.key ? null : group.key))}
      rowClassName={() => 'cursor-pointer'}
      renderRowDetail={(row) => (!compact && openKey === row.original.key ? breakdown(row.original) : null)}
      mobile="rows"
      renderMobileRow={(row) => {
        const group = row.original;
        const open = openKey === group.key;
        return (
          <div key={row.id} className="p-3">
            <button
              type="button"
              aria-expanded={open}
              onClick={() => setOpenKey(open ? null : group.key)}
              className="flex w-full items-start justify-between gap-3 text-left"
            >
              <span className="min-w-0">
                <span className="block truncate text-body-sm font-semibold text-primary">
                  {[group.ticker, splitNetworkSuffix(group.display).base]
                    .filter((part, index, parts) => part && (index === 0 || part.toUpperCase() !== parts[0]))
                    .join(' · ')}
                </span>
                <span className="block text-caption text-tertiary">
                  {quantityText(group.quantity)} in {group.holdings.length} {group.holdings.length === 1 ? 'account' : 'accounts'}
                </span>
              </span>
              <span className="value-emphasis shrink-0">{formatCurrency(group.value)}</span>
            </button>
            {open && compact && <div className="mt-2 border-t border-border pt-2">{breakdown(group)}</div>}
          </div>
        );
      }}
    />
  );
}

export function NetworkChip({ name }) {
  return (
    <span className="shrink-0 rounded border border-border bg-surface-3 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide text-tertiary">
      {name}
    </span>
  );
}

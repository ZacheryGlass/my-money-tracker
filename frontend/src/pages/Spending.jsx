import React, { useEffect, useMemo, useState } from 'react';
import { ReceiptText, RefreshCw } from 'lucide-react';
import { useReactTable, getCoreRowModel } from '@tanstack/react-table';
import { formatCurrency, formatDateDisplay } from '../utils/format';
import { accounts as accountsApi, transactions as transactionsApi } from '../utils/api';
import { getAccountDisplayName } from '../utils/accountDisplay';
import { formatTransactionCategory } from '../utils/dataLabels';
import DataTable from '../components/DataTable';
import FilterTabs from '../components/FilterTabs';
import LoadingState from '../components/LoadingState';

const PAGE_SIZE = 100;

// Only these account types carry transactions (Plaid syncs transactions for
// bank and credit card accounts, not investments/property).
const TRANSACTION_ACCOUNT_TYPES = new Set(['depository', 'credit']);

function Amount({ value }) {
  const amount = parseFloat(value) || 0;
  const isOutflow = amount > 0;
  return (
    <span className={`font-money font-bold ${isOutflow ? 'text-loss' : 'text-gain'}`}>
      {isOutflow ? '-' : '+'}{formatCurrency(Math.abs(amount))}
    </span>
  );
}

// Column ids double as the API's `sort` values — see SORT_COLUMNS in
// backend/src/routes/transactions.js.
const COLUMNS = [
  {
    accessorKey: 'date',
    header: 'Date',
    meta: { width: '7rem', cellClassName: 'whitespace-nowrap font-mono text-caption' },
    cell: ({ getValue }) => formatDateDisplay(getValue()),
  },
  {
    id: 'name',
    accessorFn: (row) => row.merchant_name || row.name,
    header: 'Description',
    meta: { cellClassName: 'min-w-0' },
    cell: ({ row, getValue }) => (
      <div className="flex items-center gap-2">
        <span className="truncate text-body-sm font-semibold text-primary">{getValue()}</span>
        {row.original.pending && (
          <span className="shrink-0 rounded border border-border bg-surface-2 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide text-tertiary">
            Pending
          </span>
        )}
      </div>
    ),
  },
  {
    accessorKey: 'category',
    header: 'Category',
    meta: { width: '11rem', cellClassName: 'truncate' },
    cell: ({ getValue }) => formatTransactionCategory(getValue()),
  },
  {
    accessorKey: 'account_name',
    header: 'Account',
    meta: { width: '11rem', cellClassName: 'truncate' },
  },
  {
    accessorKey: 'amount',
    header: 'Amount',
    meta: { width: '8rem', align: 'right', headerClassName: 'text-right', cellClassName: 'whitespace-nowrap text-right' },
    cell: ({ getValue }) => <Amount value={getValue()} />,
  },
];

export default function Spending() {
  const [accountList, setAccountList] = useState([]);
  const [selectedAccountId, setSelectedAccountId] = useState('');
  const [rows, setRows] = useState([]);
  const [total, setTotal] = useState(0);
  const [sorting, setSorting] = useState([{ id: 'date', desc: true }]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState(null);

  // Only a page of transactions is loaded at a time, so sorting has to happen
  // in the database — a client-side sort would only reorder what's on screen.
  const queryParams = useMemo(() => {
    const params = { sort: sorting[0].id, direction: sorting[0].desc ? 'desc' : 'asc' };
    if (selectedAccountId) params.account_id = selectedAccountId;
    return params;
  }, [selectedAccountId, sorting]);

  useEffect(() => {
    accountsApi.getAll()
      .then((data) => setAccountList(
        (data.accounts || []).filter((account) => TRANSACTION_ACCOUNT_TYPES.has(account.type))
      ))
      .catch(() => setAccountList([]));
  }, []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    transactionsApi.getAll({ ...queryParams, limit: PAGE_SIZE, offset: 0 })
      .then((result) => {
        if (cancelled) return;
        setRows(result.data || []);
        setTotal(result.pagination?.total || 0);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err.response?.data?.error || 'Failed to load transactions');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [queryParams]);

  const loadMore = async () => {
    setLoadingMore(true);
    try {
      const result = await transactionsApi.getAll({ ...queryParams, limit: PAGE_SIZE, offset: rows.length });
      setRows((prev) => [...prev, ...(result.data || [])]);
      setTotal(result.pagination?.total || 0);
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to load more transactions');
    } finally {
      setLoadingMore(false);
    }
  };

  const table = useReactTable({
    data: rows,
    columns: COLUMNS,
    state: { sorting },
    onSortingChange: setSorting,
    manualSorting: true,
    enableSortingRemoval: false,
    getRowId: (row) => String(row.id),
    getCoreRowModel: getCoreRowModel(),
  });

  return (
    <div className="container mx-auto max-w-[1100px] space-y-6 px-4 py-6 md:py-8">
      <div>
        <div className="mb-2 flex items-center gap-2">
          <ReceiptText className="h-5 w-5 text-accent" />
          <span className="text-[10px] font-bold uppercase tracking-wide text-secondary">Transactions</span>
        </div>
        <h1 className="text-3xl font-bold tracking-tighter text-primary md:text-5xl">Spending</h1>
        <p className="mt-1 text-sm text-secondary">All transactions across your accounts</p>
      </div>

      <FilterTabs
        id="account-filter"
        label="Account"
        options={[
          { value: '', label: 'All accounts' },
          ...accountList.map((account) => ({ value: String(account.id), label: getAccountDisplayName(account) })),
        ]}
        value={selectedAccountId}
        onChange={setSelectedAccountId}
      />

      {error && (
        <div className="card border-loss/30 bg-loss-bg p-4 text-sm text-loss">
          {error}
        </div>
      )}

      {loading ? (
        <LoadingState label="Loading Transactions" className="min-h-[300px]" />
      ) : (
        <DataTable
          table={table}
          breakpoint="md"
          emptyMessage="No transactions found."
          header={(
            <div className="flex items-center justify-between border-b border-border p-4">
              <div className="flex items-center gap-2">
                <ReceiptText size={15} className="text-accent" />
                <span className="text-[10px] font-bold uppercase tracking-wide text-tertiary">Transactions</span>
              </div>
              <span className="text-[10px] font-bold uppercase tracking-wide text-tertiary">
                Showing {rows.length.toLocaleString()} of {total.toLocaleString()}
              </span>
            </div>
          )}
          footer={rows.length < total && (
            <div className="border-t border-border p-3">
              <button
                type="button"
                onClick={loadMore}
                disabled={loadingMore}
                className="flex h-11 w-full items-center justify-center gap-2 rounded border border-border bg-surface-2 text-xs font-bold uppercase tracking-wider text-secondary transition-colors hover:text-primary disabled:opacity-50"
              >
                {loadingMore && <RefreshCw size={14} className="animate-spin" />}
                Load More
              </button>
            </div>
          )}
          renderMobileRow={(row) => {
            const txn = row.original;
            return (
              <div key={row.id} className="bg-surface p-4">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="truncate text-sm font-semibold text-primary">{txn.merchant_name || txn.name}</span>
                      {txn.pending && (
                        <span className="shrink-0 rounded border border-border bg-surface-2 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide text-tertiary">
                          Pending
                        </span>
                      )}
                    </div>
                    <div className="mt-1 flex flex-wrap items-center gap-2 text-[10px] uppercase tracking-wider text-tertiary">
                      <span>{formatDateDisplay(txn.date)}</span>
                      <span>{formatTransactionCategory(txn.category)}</span>
                    </div>
                  </div>
                  <div className="shrink-0 text-sm">
                    <Amount value={txn.amount} />
                  </div>
                </div>
                <div className="mt-2 truncate text-[10px] text-secondary">{txn.account_name}</div>
              </div>
            );
          }}
        />
      )}
    </div>
  );
}

import React, { useEffect, useState } from 'react';
import { ReceiptText, RefreshCw } from 'lucide-react';
import { formatCurrency, formatDateDisplay } from '../utils/format';
import { accounts as accountsApi, transactions as transactionsApi } from '../utils/api';
import { getAccountDisplayName } from '../utils/accountDisplay';
import FilterTabs from '../components/FilterTabs';

const PAGE_SIZE = 100;

// Only these account types carry transactions (Plaid syncs transactions for
// bank and credit card accounts, not investments/property).
const TRANSACTION_ACCOUNT_TYPES = new Set(['depository', 'credit']);

function formatCategory(category) {
  if (!category) return 'Uncategorized';
  return category
    .toLowerCase()
    .split(/[_\s]+/)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

function Amount({ value }) {
  const amount = parseFloat(value) || 0;
  const isOutflow = amount > 0;
  return (
    <span className={`font-money font-bold ${isOutflow ? 'text-loss' : 'text-gain'}`}>
      {isOutflow ? '-' : '+'}{formatCurrency(Math.abs(amount))}
    </span>
  );
}

export default function Spending() {
  const [accountList, setAccountList] = useState([]);
  const [selectedAccountId, setSelectedAccountId] = useState('');
  const [rows, setRows] = useState([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState(null);

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
    const params = { limit: PAGE_SIZE, offset: 0 };
    if (selectedAccountId) params.account_id = selectedAccountId;

    transactionsApi.getAll(params)
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
  }, [selectedAccountId]);

  const loadMore = async () => {
    setLoadingMore(true);
    try {
      const params = { limit: PAGE_SIZE, offset: rows.length };
      if (selectedAccountId) params.account_id = selectedAccountId;
      const result = await transactionsApi.getAll(params);
      setRows((prev) => [...prev, ...(result.data || [])]);
      setTotal(result.pagination?.total || 0);
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to load more transactions');
    } finally {
      setLoadingMore(false);
    }
  };

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
        <div className="flex min-h-[300px] flex-col items-center justify-center gap-4">
          <div className="h-6 w-6 animate-spin rounded-full border-2 border-accent border-t-transparent" />
          <span className="text-xs font-bold uppercase tracking-wide text-tertiary">Loading Transactions</span>
        </div>
      ) : (
        <div className="card overflow-hidden">
          <div className="flex items-center justify-between border-b border-border p-4">
            <div className="flex items-center gap-2">
              <ReceiptText size={15} className="text-accent" />
              <span className="text-[10px] font-bold uppercase tracking-wide text-tertiary">Transactions</span>
            </div>
            <span className="text-[10px] font-bold uppercase tracking-wide text-tertiary">
              Showing {rows.length.toLocaleString()} of {total.toLocaleString()}
            </span>
          </div>

          <div className="hidden md:block">
            <table className="w-full table-fixed divide-y divide-border">
              <thead className="bg-surface-2">
                <tr>
                  <th className="w-28 px-5 py-3 text-left text-[10px] font-bold uppercase tracking-wide text-tertiary">Date</th>
                  <th className="px-5 py-3 text-left text-[10px] font-bold uppercase tracking-wide text-tertiary">Description</th>
                  <th className="w-44 px-5 py-3 text-left text-[10px] font-bold uppercase tracking-wide text-tertiary">Category</th>
                  <th className="w-44 px-5 py-3 text-left text-[10px] font-bold uppercase tracking-wide text-tertiary">Account</th>
                  <th className="w-32 px-5 py-3 text-right text-[10px] font-bold uppercase tracking-wide text-tertiary">Amount</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border bg-surface">
                {rows.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="px-5 py-12 text-center text-sm text-tertiary">
                      No transactions found.
                    </td>
                  </tr>
                ) : (
                  rows.map((txn) => (
                    <tr key={txn.id} className="transition-colors hover:bg-surface-2">
                      <td className="whitespace-nowrap px-5 py-3 font-mono text-xs text-secondary">{formatDateDisplay(txn.date)}</td>
                      <td className="min-w-0 px-5 py-3">
                        <div className="flex items-center gap-2">
                          <span className="truncate text-sm font-semibold text-primary">{txn.merchant_name || txn.name}</span>
                          {txn.pending && (
                            <span className="shrink-0 rounded border border-border bg-surface-2 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide text-tertiary">
                              Pending
                            </span>
                          )}
                        </div>
                      </td>
                      <td className="truncate px-5 py-3 text-xs text-secondary">{formatCategory(txn.category)}</td>
                      <td className="truncate px-5 py-3 text-xs text-secondary">{txn.account_name}</td>
                      <td className="whitespace-nowrap px-5 py-3 text-right text-sm">
                        <Amount value={txn.amount} />
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>

          <div className="divide-y divide-border md:hidden">
            {rows.length === 0 ? (
              <div className="p-10 text-center text-sm text-tertiary">No transactions found.</div>
            ) : (
              rows.map((txn) => (
                <div key={txn.id} className="bg-surface p-4">
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
                        <span>{formatCategory(txn.category)}</span>
                      </div>
                    </div>
                    <div className="shrink-0 text-sm">
                      <Amount value={txn.amount} />
                    </div>
                  </div>
                  <div className="mt-2 truncate text-[10px] text-secondary">{txn.account_name}</div>
                </div>
              ))
            )}
          </div>

          {rows.length < total && (
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
        </div>
      )}
    </div>
  );
}

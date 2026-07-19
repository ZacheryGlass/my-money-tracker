import React, { useState, useEffect, useMemo } from 'react';
import {
  useReactTable, getCoreRowModel, getSortedRowModel, getPaginationRowModel, flexRender,
} from '@tanstack/react-table';
import { Link2, Check, X } from 'lucide-react';
import { holdings as holdingsAPI, accounts as accountsAPI } from '../utils/api';
import { formatCurrency, formatDateAxis } from '../utils/format';
import FilterTabs from '../components/FilterTabs';
import HoldingForm from '../components/HoldingForm';
import LoadingState from '../components/LoadingState';
import SummaryStats from '../components/SummaryStats';
import useTransientMessage from '../hooks/useTransientMessage';
import { buildAccountDisplayNameMap, getAccountDisplayName } from '../utils/accountDisplay';
import { formatCategoryLabel } from '../utils/dataLabels';

const TABS = [
  { id: 'assets', label: 'Assets', types: new Set(['investment', 'crypto', 'property', 'other']) },
  { id: 'cash', label: 'Cash', types: new Set(['depository']) },
  { id: 'liabilities', label: 'Liabilities', types: new Set(['credit', 'loan']) },
];

const TAB_CONFIG = Object.fromEntries(TABS.map((t) => [t.id, t]));

const getHoldingValue = (holding) => parseFloat(holding.current_value ?? holding.manual_value ?? 0) || 0;

const formatLastUpdated = (dateString) => {
  if (!dateString) return 'No update yet';
  const updatedAt = new Date(dateString);
  if (Number.isNaN(updatedAt.getTime())) return 'No update yet';

  const days = Math.max(0, Math.floor((Date.now() - updatedAt.getTime()) / 86400000));
  if (days === 0) return 'Updated today';
  if (days === 1) return 'Updated yesterday';
  if (days < 14) return `Updated ${days}d ago`;

  return `Updated ${formatDateAxis(dateString)}`;
};

const LinkedPill = () => (
  <span className="inline-flex items-center gap-1 px-1.5 py-0.5 text-caption bg-accent-muted text-accent border border-accent/20 flex-shrink-0">
    <Link2 size={10} />
    Linked
  </span>
);

const BalancesPage = ({ tab = 'assets', onTabChange }) => {
  const [holdings, setHoldings] = useState([]);
  const [accounts, setAccounts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [successMessage, showSuccess] = useTransientMessage();
  const [sorting, setSorting] = useState([{ id: 'value', desc: true }]);
  const [accountFilter, setAccountFilter] = useState('');
  const [categoryFilter, setCategoryFilter] = useState('');
  const [pagination, setPagination] = useState({ pageIndex: 0, pageSize: 25 });
  const [isFormOpen, setIsFormOpen] = useState(false);
  const [editingHolding, setEditingHolding] = useState(null);

  useEffect(() => { fetchData(); }, []);

  // Reset per-tab view state when switching tabs (component stays mounted).
  useEffect(() => {
    setAccountFilter('');
    setCategoryFilter('');
    setSorting([{ id: 'value', desc: true }]);
    setPagination((p) => ({ ...p, pageIndex: 0 }));
  }, [tab]);

  const fetchData = async () => {
    setLoading(true);
    try {
      const [holdingsData, accountsData] = await Promise.all([holdingsAPI.getAll(), accountsAPI.getAll()]);
      setHoldings(holdingsData.holdings || []);
      setAccounts(accountsData.accounts || []);
      setError(null);
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to load data');
    } finally {
      setLoading(false);
    }
  };

  const handleEdit = (holding) => { if (holding.is_plaid_managed) return; setEditingHolding(holding); setIsFormOpen(true); };

  const handleSave = async (data) => {
    if (editingHolding) { await holdingsAPI.update(editingHolding.id, data); showSuccess('Holding updated'); }
    else { await holdingsAPI.create(data); showSuccess('Holding added'); }
    await fetchData();
    setIsFormOpen(false);
  };

  const handleDelete = async (id) => {
    try { await holdingsAPI.delete(id); showSuccess('Entry deleted'); setIsFormOpen(false); setEditingHolding(null); await fetchData(); }
    catch (err) { setError(err.response?.data?.error || 'Failed to delete'); }
  };

  const accountsMap = useMemo(() => new Map(accounts.map((a) => [a.id, a])), [accounts]);
  const accountDisplayNames = useMemo(() => buildAccountDisplayNameMap(accounts), [accounts]);
  const displayAccountName = useMemo(
    () => (account) => account ? accountDisplayNames.get(account.id) || getAccountDisplayName(account) : 'Account',
    [accountDisplayNames]
  );

  const accountGroup = useMemo(() => {
    const groups = new Map();
    accounts.forEach((a) => {
      const match = TABS.find((t) => t.types.has(a.type));
      if (match) groups.set(a.id, match.id);
    });
    return groups;
  }, [accounts]);

  // Totals for all three groups, shown in the header regardless of active tab.
  // Assets keeps its historical >= $10 noise threshold; liabilities are abs().
  const groupTotals = useMemo(() => {
    const totals = { assets: 0, cash: 0, liabilities: 0 };
    holdings.forEach((h) => {
      const group = accountGroup.get(h.account_id);
      if (!group) return;
      const value = getHoldingValue(h);
      if (group === 'assets') {
        if (Math.abs(h.current_value ?? 0) >= 10) totals.assets += value;
      } else if (group === 'liabilities') {
        totals.liabilities += Math.abs(value);
      } else {
        totals.cash += value;
      }
    });
    return totals;
  }, [holdings, accountGroup]);

  const scopedHoldings = useMemo(() => {
    let data = holdings.filter((h) => accountGroup.get(h.account_id) === tab);
    if (tab === 'assets') data = data.filter((h) => Math.abs(h.current_value ?? 0) >= 10);
    return data;
  }, [holdings, accountGroup, tab]);

  const tabAccounts = useMemo(() => {
    const ids = new Set(scopedHoldings.map((h) => h.account_id));
    return accounts
      .filter((a) => ids.has(a.id))
      .sort((a, b) => displayAccountName(a).localeCompare(displayAccountName(b)));
  }, [accounts, scopedHoldings, displayAccountName]);

  const distinctCategories = useMemo(() => {
    if (tab !== 'assets') return [];
    const cats = new Set();
    scopedHoldings.forEach((h) => { cats.add(formatCategoryLabel(h.category)); });
    return Array.from(cats).sort();
  }, [scopedHoldings, tab]);

  const filteredData = useMemo(() => {
    let data = scopedHoldings;
    if (accountFilter) data = data.filter((h) => h.account_id === parseInt(accountFilter));
    if (categoryFilter) data = data.filter((h) => formatCategoryLabel(h.category) === categoryFilter);
    return data;
  }, [scopedHoldings, accountFilter, categoryFilter]);

  const isLiabilities = tab === 'liabilities';
  const valueClass = isLiabilities ? 'text-loss' : 'text-gain';

  const columns = useMemo(() => {
    const accountColumn = {
      id: 'account',
      accessorFn: (row) => {
        const account = accountsMap.get(row.account_id);
        return account ? displayAccountName(account) : row.account_name || 'Account';
      },
      header: tab === 'assets' ? 'Account' : 'Institution',
      cell: ({ row, getValue }) => {
        const account = accountsMap.get(row.original.account_id);
        return (
          <div className="min-w-0">
            <span className="block truncate text-primary" title={getValue()}>{getValue()}</span>
            <span className="text-caption text-tertiary uppercase">{account?.type || 'Account'}</span>
          </div>
        );
      },
    };

    const nameColumn = {
      accessorKey: 'name',
      header: tab === 'assets' ? 'Asset Name' : 'Account Name',
      cell: ({ row }) => (
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="truncate font-semibold text-primary" title={row.original.name}>{row.original.name}</span>
            {row.original.is_plaid_managed && <LinkedPill />}
          </div>
          <p className="text-caption text-tertiary truncate">
            {tab === 'assets'
              ? `${row.original.ticker ? `${row.original.ticker} / ` : ''}${formatCategoryLabel(row.original.category)}${row.original.location ? ` / ${row.original.location}` : ''}`
              : formatLastUpdated(row.original.updated_at)}
          </p>
        </div>
      ),
    };

    const valueColumn = {
      id: 'value',
      accessorFn: (row) => isLiabilities ? Math.abs(getHoldingValue(row)) : getHoldingValue(row),
      header: isLiabilities ? 'Owed' : (tab === 'cash' ? 'Balance' : 'Value'),
      cell: ({ getValue }) => <span className={`value-emphasis ${valueClass}`}>{formatCurrency(getValue())}</span>,
    };

    let typeColumn;
    if (tab === 'assets') {
      typeColumn = {
        accessorKey: 'category',
        header: 'Category',
        cell: ({ getValue }) => <span className="block max-w-[120px] truncate text-tertiary" title={formatCategoryLabel(getValue())}>{formatCategoryLabel(getValue())}</span>,
      };
    } else if (isLiabilities) {
      typeColumn = {
        id: 'type',
        accessorFn: (row) => accountsMap.get(row.account_id)?.type === 'credit' ? 'Credit' : 'Loan',
        header: 'Type',
        cell: ({ getValue }) => (
          <span className={`inline-flex px-2 py-1 text-caption uppercase border ${getValue() === 'Credit' ? 'border-loss/20 text-loss bg-loss-bg' : 'border-accent/20 text-accent bg-accent-muted'}`}>
            {getValue()}
          </span>
        ),
      };
    } else {
      typeColumn = {
        accessorKey: 'category',
        header: 'Type',
        cell: ({ getValue, row }) => (
          <span className={`inline-flex px-2 py-1 text-caption uppercase border ${Math.abs(getHoldingValue(row.original)) < 0.01 ? 'border-border text-tertiary bg-surface-2' : 'border-gain/20 text-gain bg-gain-bg'}`}>
            {Math.abs(getHoldingValue(row.original)) < 0.01 ? 'Zero Balance' : getValue() || 'Depository'}
          </span>
        ),
      };
    }

    return [accountColumn, nameColumn, valueColumn, typeColumn];
  }, [tab, isLiabilities, valueClass, accountsMap, displayAccountName]);

  const table = useReactTable({
    data: filteredData,
    columns,
    state: { sorting, pagination },
    onSortingChange: setSorting,
    onPaginationChange: setPagination,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getPaginationRowModel: getPaginationRowModel(),
  });

  if (loading) {
    return <LoadingState />;
  }

  const activeLabel = TAB_CONFIG[tab]?.label || 'Balances';

  return (
    <div className="px-4 py-4">
      <div className="mb-4 flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="mb-0.5 text-caption uppercase tracking-wide text-tertiary">{activeLabel}</p>
          <h1 className="font-money text-display-lg text-primary">{formatCurrency(groupTotals[tab] || 0)}</h1>
          <p className="text-body-sm text-tertiary">
            {scopedHoldings.length} holdings across {tabAccounts.length} accounts
          </p>
        </div>
        <SummaryStats stats={[
          { label: 'Assets', value: formatCurrency(groupTotals.assets) },
          { label: 'Cash', value: formatCurrency(groupTotals.cash) },
          { label: 'Liabilities', value: formatCurrency(groupTotals.liabilities), valueClassName: 'font-money font-semibold text-loss' },
        ]} />
      </div>

      <FilterTabs
        id="balances-group"
        label="Balances"
        className="mb-3"
        options={TABS.map((t) => ({ value: t.id, label: t.label }))}
        value={tab}
        onChange={(id) => onTabChange?.(id)}
      />

      {successMessage && <div className="mb-3 flex items-center gap-2 border border-gain/20 bg-gain-bg p-2 text-body-sm text-gain"><Check size={14} />{successMessage}</div>}
      {error && <div className="mb-3 flex items-center gap-2 border border-loss/20 bg-loss-bg p-2 text-body-sm text-loss"><X size={14} />{error}</div>}

      <div className="mb-3 flex flex-wrap items-center gap-3">
        {distinctCategories.length > 0 && (
          <label className="flex items-center gap-2">
            <span className="text-caption font-semibold uppercase tracking-wide text-tertiary">Category</span>
            <select
              value={categoryFilter}
              onChange={(e) => { setCategoryFilter(e.target.value); setPagination((p) => ({ ...p, pageIndex: 0 })); }}
              className="h-9 min-w-[180px] border border-border bg-surface px-2 text-body-sm text-primary"
            >
              <option value="">All categories</option>
              {distinctCategories.map((cat) => (
                <option key={cat} value={cat}>{cat}</option>
              ))}
            </select>
          </label>
        )}
        {tabAccounts.length > 0 && (
          <label className="flex items-center gap-2">
            <span className="text-caption font-semibold uppercase tracking-wide text-tertiary">Account</span>
            <select
              value={accountFilter}
              onChange={(e) => { setAccountFilter(e.target.value); setPagination((p) => ({ ...p, pageIndex: 0 })); }}
              className="h-9 min-w-[180px] border border-border bg-surface px-2 text-body-sm text-primary"
            >
              <option value="">All accounts</option>
              {tabAccounts.map((account) => (
                <option key={account.id} value={String(account.id)}>{displayAccountName(account)}</option>
              ))}
            </select>
          </label>
        )}
      </div>

      <div className="card overflow-hidden">
        <div className="hidden max-w-full overflow-hidden lg:block">
          <table className="w-full table-fixed divide-y divide-border">
            <thead className="bg-surface-2">
              {table.getHeaderGroups().map((hg) => (
                <tr key={hg.id}>
                  {hg.headers.map((header) => (
                    <th key={header.id} className="px-3 py-2 text-left text-caption font-semibold text-tertiary uppercase tracking-wide cursor-pointer hover:bg-surface-3" onClick={header.column.getToggleSortingHandler()}>
                      <div className="flex items-center gap-1">
                        {flexRender(header.column.columnDef.header, header.getContext())}
                        {header.column.getIsSorted() && <span className="text-accent">{header.column.getIsSorted() === 'asc' ? '↑' : '↓'}</span>}
                      </div>
                    </th>
                  ))}
                </tr>
              ))}
            </thead>
            <tbody className="divide-y divide-border">
              {table.getRowModel().rows.length === 0 ? (
                <tr><td colSpan={columns.length} className="px-3 py-8 text-center text-tertiary text-body-sm">No {activeLabel.toLowerCase()} found.</td></tr>
              ) : (
                table.getRowModel().rows.map((row) => (
                  <tr key={row.id} className={`hover:bg-surface-2 transition-colors ${row.original.is_plaid_managed ? '' : 'cursor-pointer'}`} onClick={() => handleEdit(row.original)}>
                    {row.getVisibleCells().map((cell) => (
                      <td key={cell.id} className="px-3 py-2 text-body-sm text-secondary">{flexRender(cell.column.columnDef.cell, cell.getContext())}</td>
                    ))}
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        <div className="divide-y divide-border lg:hidden">
          {table.getRowModel().rows.length === 0 ? (
            <div className="px-3 py-8 text-center text-tertiary text-body-sm">No {activeLabel.toLowerCase()} found.</div>
          ) : (
            table.getRowModel().rows.map((row) => {
              const account = accountsMap.get(row.original.account_id);
              const value = isLiabilities ? Math.abs(getHoldingValue(row.original)) : getHoldingValue(row.original);
              return (
                <div key={row.id} className={`p-3 ${row.original.is_plaid_managed ? '' : 'cursor-pointer hover:bg-surface-2'}`} onClick={() => handleEdit(row.original)}>
                  <div className="flex items-start justify-between">
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-body-sm font-semibold text-primary">{row.original.name}</p>
                      <p className="truncate text-caption text-tertiary">
                        {displayAccountName(account)}
                        {tab === 'assets'
                          ? ` / ${formatCategoryLabel(row.original.category)}${row.original.ticker ? ` / ${row.original.ticker}` : ''}`
                          : ` / ${formatLastUpdated(row.original.updated_at)}`}
                      </p>
                    </div>
                    <p className={`value-emphasis shrink-0 pl-3 ${valueClass}`}>{formatCurrency(value)}</p>
                  </div>
                </div>
              );
            })
          )}
        </div>
      </div>

      {filteredData.length > 0 && (
        <div className="flex items-center justify-between mt-3">
          <div className="flex items-center gap-2">
            <span className="text-caption text-tertiary">Rows:</span>
            <select
              value={pagination.pageSize}
              onChange={(e) => setPagination((p) => ({ ...p, pageIndex: 0, pageSize: Number(e.target.value) }))}
              className="px-2 py-1 text-caption"
            >
              {[10, 25, 50, 100].map((size) => <option key={size} value={size}>{size}</option>)}
            </select>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-caption text-tertiary">
              Page {table.getState().pagination.pageIndex + 1} of {table.getPageCount()}
            </span>
            <button onClick={() => table.previousPage()} disabled={!table.getCanPreviousPage()} className="px-2 py-1 bg-surface-3 text-secondary border border-border rounded text-caption disabled:opacity-30">Prev</button>
            <button onClick={() => table.nextPage()} disabled={!table.getCanNextPage()} className="px-2 py-1 bg-surface-3 text-secondary border border-border rounded text-caption disabled:opacity-30">Next</button>
          </div>
        </div>
      )}

      <HoldingForm isOpen={isFormOpen} onClose={() => setIsFormOpen(false)} onSave={handleSave} onDelete={handleDelete} holding={editingHolding} accounts={accounts} />
    </div>
  );
};

export default BalancesPage;

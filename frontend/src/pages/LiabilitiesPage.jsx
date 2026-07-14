import React, { useState, useEffect, useMemo } from 'react';
import {
  useReactTable, getCoreRowModel, getSortedRowModel, getFilteredRowModel, getPaginationRowModel, flexRender,
} from '@tanstack/react-table';
import { Link2, Check, X } from 'lucide-react';
import { holdings as holdingsAPI, accounts as accountsAPI } from '../utils/api';
import { formatCurrency } from '../utils/format';
import HoldingForm from '../components/HoldingForm';
import FilterDisclosure from '../components/FilterDisclosure';
import SummaryStats from '../components/SummaryStats';
import { buildAccountDisplayNameMap, getAccountDisplayName } from '../utils/accountDisplay';

const LIABILITY_TYPES = new Set(['credit', 'loan']);

const getLiabilityValue = (holding) => Math.abs(parseFloat(holding.current_value ?? holding.manual_value ?? 0) || 0);

const formatLastUpdated = (dateString) => {
  if (!dateString) return 'No update yet';
  const updatedAt = new Date(dateString);
  if (Number.isNaN(updatedAt.getTime())) return 'No update yet';

  const days = Math.max(0, Math.floor((Date.now() - updatedAt.getTime()) / 86400000));
  if (days === 0) return 'Updated today';
  if (days === 1) return 'Updated yesterday';
  if (days < 14) return `Updated ${days}d ago`;

  return `Updated ${updatedAt.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`;
};

const LiabilitiesPage = () => {
  const [holdings, setHoldings] = useState([]);
  const [accounts, setAccounts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [successMessage, setSuccessMessage] = useState('');
  const [sorting, setSorting] = useState([]);
  const [accountFilter, setAccountFilter] = useState('');
  const [pagination, setPagination] = useState({ pageIndex: 0, pageSize: 25 });
  const [isFormOpen, setIsFormOpen] = useState(false);
  const [editingHolding, setEditingHolding] = useState(null);

  useEffect(() => { fetchData(); }, []);

  const fetchData = async () => {
    setLoading(true);
    try {
      const [holdingsData, accountsData] = await Promise.all([holdingsAPI.getAll(), accountsAPI.getAll()]);
      setHoldings(holdingsData.holdings || []); setAccounts(accountsData.accounts || []); setError(null);
    } catch (err) { setError(err.response?.data?.error || 'Failed to load data'); }
    finally { setLoading(false); }
  };

  const showSuccess = (message) => { setSuccessMessage(message); setTimeout(() => setSuccessMessage(''), 3000); };
  const handleEdit = (holding) => { if (holding.is_plaid_managed) return; setEditingHolding(holding); setIsFormOpen(true); };

  const handleSave = async (data) => {
    if (editingHolding) { await holdingsAPI.update(editingHolding.id, data); showSuccess('Liability updated'); }
    else { await holdingsAPI.create(data); showSuccess('Liability added'); }
    await fetchData(); setIsFormOpen(false);
  };

  const handleDelete = async (id) => {
    try { await holdingsAPI.delete(id); showSuccess('Entry deleted'); setIsFormOpen(false); setEditingHolding(null); await fetchData(); }
    catch (err) { setError(err.response?.data?.error || 'Failed to delete'); }
  };

  const liabilityAccounts = useMemo(() => accounts.filter((a) => LIABILITY_TYPES.has(a.type)), [accounts]);
  const liabilityAccountIds = useMemo(() => new Set(liabilityAccounts.map((a) => a.id)), [liabilityAccounts]);
  const accountsMap = useMemo(() => new Map(accounts.map((a) => [a.id, a])), [accounts]);
  const accountDisplayNames = useMemo(() => buildAccountDisplayNameMap(accounts), [accounts]);
  const displayAccountName = useMemo(
    () => (account) => account ? accountDisplayNames.get(account.id) || getAccountDisplayName(account) : 'Account',
    [accountDisplayNames]
  );

  const liabilityHoldings = useMemo(() => holdings.filter((h) => liabilityAccountIds.has(h.account_id)), [holdings, liabilityAccountIds]);

  const liabilityAccountSummaries = useMemo(() => liabilityAccounts.map((account) => {
    const rows = liabilityHoldings.filter((h) => h.account_id === account.id);
    const total = rows.reduce((sum, h) => sum + getLiabilityValue(h), 0);
    const latestUpdate = rows.reduce((latest, h) => {
      if (!h.updated_at) return latest;
      const timestamp = new Date(h.updated_at).getTime();
      return Number.isNaN(timestamp) || timestamp <= latest ? latest : timestamp;
    }, 0);

    return {
      account,
      rows,
      total,
      holdingCount: rows.length,
      type: account.type === 'credit' ? 'Credit Card' : 'Loan',
      isLinked: Boolean(account.plaid_item_id) || rows.some((h) => h.is_plaid_managed),
      isZeroBalance: total < 0.01,
      latestUpdate: latestUpdate ? new Date(latestUpdate).toISOString() : null,
    };
  }).sort((a, b) => {
    if (a.account.type !== b.account.type) return a.account.type === 'credit' ? -1 : 1;
    return b.total - a.total;
  }), [liabilityAccounts, liabilityHoldings]);

  const filteredData = useMemo(() => {
    let data = liabilityHoldings;
    if (accountFilter) data = data.filter((h) => h.account_id === parseInt(accountFilter));
    return data;
  }, [liabilityHoldings, accountFilter]);

  const { totalCredit, totalLoans, totalLiabilities } = useMemo(() => {
    let credit = 0, loans = 0;
    filteredData.forEach((h) => {
      const value = getLiabilityValue(h);
      const type = accountsMap.get(h.account_id)?.type;
      if (type === 'credit') credit += value; else loans += value;
    });
    return { totalCredit: credit, totalLoans: loans, totalLiabilities: credit + loans };
  }, [filteredData, accountsMap]);

  const liabilityPageStats = useMemo(() => {
    const largestAccount = liabilityAccountSummaries.reduce((largest, summary) => (
      !largest || summary.total > largest.total ? summary : largest
    ), null);
    const linkedAccounts = liabilityAccountSummaries.filter((summary) => summary.isLinked).length;
    const creditAccounts = liabilityAccountSummaries.filter((summary) => summary.account.type === 'credit');
    const loanAccounts = liabilityAccountSummaries.filter((summary) => summary.account.type === 'loan');
    const latestUpdate = liabilityAccountSummaries.reduce((latest, account) => {
      if (!account.latestUpdate) return latest;
      const timestamp = new Date(account.latestUpdate).getTime();
      return Number.isNaN(timestamp) || timestamp <= latest ? latest : timestamp;
    }, 0);
    const selectedSummary = accountFilter
      ? liabilityAccountSummaries.find((summary) => summary.account.id === parseInt(accountFilter))
      : null;

    return {
      largestAccount,
      linkedAccounts,
      manualAccounts: liabilityAccountSummaries.length - linkedAccounts,
      creditAccounts,
      loanAccounts,
      latestUpdate: latestUpdate ? new Date(latestUpdate).toISOString() : null,
      selectedSummary,
    };
  }, [liabilityAccountSummaries, accountFilter]);

  const columns = useMemo(() => [
    {
      id: 'account',
      accessorFn: (row) => displayAccountName(accountsMap.get(row.account_id)) || row.account_name || 'Account',
      header: 'Institution',
      cell: ({ getValue }) => <span className="text-caption text-tertiary uppercase">{getValue()}</span>,
    },
    { accessorKey: 'name', header: 'Account Name', cell: ({ row }) => (
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <span className="font-semibold text-primary truncate">{row.original.name}</span>
          {row.original.is_plaid_managed && <span className="inline-flex items-center gap-1 px-1.5 py-0.5 text-caption bg-accent-muted text-accent border border-accent/20"><Link2 size={10} />Linked</span>}
        </div>
        <p className="text-caption text-tertiary">{formatLastUpdated(row.original.updated_at)}</p>
      </div>
    )},
    { id: 'value', accessorFn: (row) => getLiabilityValue(row), header: 'Owed',
      cell: ({ getValue }) => <span className="value-emphasis text-loss">{formatCurrency(getValue())}</span> },
    { id: 'type', accessorFn: (row) => accountsMap.get(row.account_id)?.type === 'credit' ? 'Credit' : 'Loan',
      header: 'Type', cell: ({ getValue }) => (
        <span className={`inline-flex px-2 py-1 text-caption uppercase border ${getValue() === 'Credit' ? 'border-loss/20 text-loss bg-loss-bg' : 'border-accent/20 text-accent bg-accent-muted'}`}>
          {getValue()}
        </span>
      ) },
  ], [accountsMap, displayAccountName]);

  const table = useReactTable({ data: filteredData, columns, state: { sorting, pagination }, onSortingChange: setSorting, onPaginationChange: setPagination, getCoreRowModel: getCoreRowModel(), getSortedRowModel: getSortedRowModel(), getFilteredRowModel: getFilteredRowModel(), getPaginationRowModel: getPaginationRowModel() });

  if (loading) {
    return <div className="flex flex-col items-center justify-center min-h-[400px] gap-3"><div className="w-6 h-6 border-2 border-accent border-t-transparent rounded-full animate-spin" /><span className="text-caption text-tertiary">Loading...</span></div>;
  }

  return (
    <div className="px-4 py-4">
      <div className="mb-4 flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="text-caption text-tertiary uppercase tracking-wide mb-0.5">Liabilities</p>
          <h1 className="text-display-lg font-money text-primary">{formatCurrency(totalLiabilities)}</h1>
          <p className="text-body-sm text-tertiary">{liabilityAccounts.length} accounts, {liabilityPageStats.linkedAccounts} linked</p>
        </div>
        <SummaryStats stats={[
          { label: 'Credit Cards', value: formatCurrency(totalCredit), valueClassName: 'value-emphasis text-loss' },
          { label: 'Loans', value: formatCurrency(totalLoans), valueClassName: 'value-emphasis text-loss' },
          { label: 'Freshness', value: formatLastUpdated(liabilityPageStats.latestUpdate) },
        ]} />
      </div>

      <FilterDisclosure
        summary={liabilityPageStats.selectedSummary
          ? displayAccountName(liabilityPageStats.selectedSummary.account)
          : `${liabilityAccountSummaries.length} liability accounts shown`}
        activeCount={accountFilter ? 1 : 0}
        onClear={() => setAccountFilter('')}
      >
        <div>
          <p className="mb-2 text-caption font-semibold uppercase tracking-wide text-tertiary">Account</p>
            <div className="flex flex-wrap gap-1">
              <button onClick={() => setAccountFilter('')} className={`flex items-center gap-1.5 border px-2 py-1 text-caption transition-colors ${accountFilter === '' ? 'bg-accent-muted border-accent/30 text-accent' : 'bg-surface border-border text-tertiary hover:text-secondary'}`}>
                All Accounts {accountFilter === '' && <Check size={12} />}
              </button>
              {liabilityAccountSummaries.map(({ account, total }) => (
                <button key={account.id} onClick={() => setAccountFilter(String(account.id))} className={`flex items-center gap-1.5 border px-2 py-1 text-caption transition-colors ${accountFilter === String(account.id) ? 'bg-accent-muted border-accent/30 text-accent' : 'bg-surface border-border text-tertiary hover:text-secondary'}`}>
                  <span className="max-w-[180px] truncate">{displayAccountName(account)}</span>
                  <span className="text-loss">{formatCurrency(total)}</span>
                  {accountFilter === String(account.id) && <Check size={12} />}
                </button>
              ))}
            </div>
          </div>
      </FilterDisclosure>

      {error && <div className="p-2 bg-loss-bg border border-loss/20 text-loss text-body-sm flex items-center gap-2 mb-3"><X size={14} />{error}</div>}
      {successMessage && <div className="p-2 bg-gain-bg border border-gain/20 text-gain text-body-sm flex items-center gap-2 mb-3"><Check size={14} />{successMessage}</div>}

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
                <tr><td colSpan={columns.length} className="px-3 py-8 text-center text-tertiary text-body-sm">No liabilities found.</td></tr>
              ) : table.getRowModel().rows.map((row) => (
                <tr key={row.id} className={`hover:bg-surface-2 transition-colors ${row.original.is_plaid_managed ? '' : 'cursor-pointer'}`} onClick={() => !row.original.is_plaid_managed && handleEdit(row.original)}>
                  {row.getVisibleCells().map((cell) => (
                    <td key={cell.id} className="px-3 py-2 whitespace-nowrap text-body-sm">{flexRender(cell.column.columnDef.cell, cell.getContext())}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="divide-y divide-border lg:hidden">
          {table.getRowModel().rows.map((row) => {
            const value = Math.abs(parseFloat(row.original.current_value ?? row.original.manual_value ?? 0));
            return (
              <div key={row.id} className={`p-3 ${row.original.is_plaid_managed ? '' : 'cursor-pointer hover:bg-surface-2'}`} onClick={() => !row.original.is_plaid_managed && handleEdit(row.original)}>
                <div className="flex justify-between items-start">
                  <div className="flex-1 min-w-0">
                    <p className="text-body-sm font-semibold text-primary truncate">{row.original.name}</p>
                    <p className="text-caption text-tertiary">{displayAccountName(accountsMap.get(row.original.account_id))} / {formatLastUpdated(row.original.updated_at)}</p>
                  </div>
                  <p className="value-emphasis text-loss">{formatCurrency(value)}</p>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      <HoldingForm isOpen={isFormOpen} onClose={() => setIsFormOpen(false)} onSave={handleSave} onDelete={handleDelete} holding={editingHolding} accounts={liabilityAccounts} />
    </div>
  );
};

export default LiabilitiesPage;

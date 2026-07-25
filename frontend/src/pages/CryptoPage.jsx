import React, { useState, useEffect, useMemo } from 'react';
import {
  useReactTable,
  getCoreRowModel,
  getSortedRowModel,
  getPaginationRowModel,
} from '@tanstack/react-table';
import { Activity, AlertTriangle, Coins, Layers, RefreshCw, Wallet } from 'lucide-react';
import { accounts as accountsAPI, holdings as holdingsAPI, history as historyApi, eth as ethAPI } from '../utils/api';
import { formatCurrency, formatRelativeTime } from '../utils/format';
import { buildAccountDisplayNameMap, getAccountDisplayName } from '../utils/accountDisplay';
import { formatCategoryLabel } from '../utils/dataLabels';
import AccountHistoryChart from '../components/AccountHistoryChart';
import DataTable, { DataTablePagination } from '../components/DataTable';
import FilterTabs from '../components/FilterTabs';
import HoldingForm from '../components/HoldingForm';
import LoadingState from '../components/LoadingState';
import MetricCard from '../components/MetricCard';
import OnChainActivity, { EthWalletBadge, shortEthAddress } from '../components/OnChainActivity';
import SummaryStats from '../components/SummaryStats';
import useTransientMessage from '../hooks/useTransientMessage';

const getHoldingValue = (holding) => parseFloat(holding.current_value ?? holding.manual_value ?? 0) || 0;

// Wallet syncs rebuild these rows; manual edits would be silently clobbered.
const isSyncManaged = (holding) => Boolean(holding.is_plaid_managed || holding.account_eth_wallet_id);

const formatEthQuantity = (quantity) =>
  Number(quantity || 0).toLocaleString(undefined, { maximumFractionDigits: 4 });

// Wallet labels double as notes-to-self ("Use to store EOS ERC20 tokens before
// mainnet. Sent remainder to BinanceUS"), which would blow out a tab strip.
// Truncate for the tab and keep the full text as hover title.
const TAB_LABEL_MAX = 22;
const truncateLabel = (text) =>
  (text.length > TAB_LABEL_MAX ? `${text.slice(0, TAB_LABEL_MAX - 1).trimEnd()}…` : text);

const CryptoPage = ({ onNavigate }) => {
  const [wallets, setWallets] = useState([]);
  const [holdings, setHoldings] = useState([]);
  const [accounts, setAccounts] = useState([]);
  const [historyRows, setHistoryRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [selectedWalletId, setSelectedWalletId] = useState(null);
  const [syncingWalletId, setSyncingWalletId] = useState(null);
  const [sorting, setSorting] = useState([{ id: 'value', desc: true }]);
  const [pagination, setPagination] = useState({ pageIndex: 0, pageSize: 25 });
  const [isFormOpen, setIsFormOpen] = useState(false);
  const [editingHolding, setEditingHolding] = useState(null);
  const [successMessage, showSuccess] = useTransientMessage();

  const fetchData = async () => {
    try {
      const [walletsData, holdingsData, accountsData, historyData] = await Promise.all([
        ethAPI.getWallets().catch(() => null),
        holdingsAPI.getAll(),
        accountsAPI.getAll(),
        historyApi.getAccounts({ limit: 10000, withCount: false }),
      ]);
      setWallets(walletsData?.wallets || []);
      setHoldings(holdingsData.holdings || []);
      setAccounts(accountsData.accounts || []);
      setHistoryRows(historyData.data || []);
      setError(null);
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to load crypto data');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { fetchData(); }, []);

  const cryptoAccounts = useMemo(
    () => accounts.filter((account) => account.type === 'crypto'),
    [accounts]
  );
  const cryptoAccountIds = useMemo(
    () => new Set(cryptoAccounts.map((account) => account.id)),
    [cryptoAccounts]
  );
  const cryptoHoldings = useMemo(
    () => holdings.filter((holding) => holding.account_type === 'crypto'),
    [holdings]
  );
  const cryptoHistory = useMemo(
    () => historyRows.filter((row) => cryptoAccountIds.has(row.account_id)),
    [historyRows, cryptoAccountIds]
  );

  const accountDisplayNames = useMemo(() => buildAccountDisplayNameMap(accounts), [accounts]);
  const displayAccountName = (account) =>
    account ? accountDisplayNames.get(account.id) || getAccountDisplayName(account) : 'Account';
  const accountsMap = useMemo(() => new Map(accounts.map((a) => [a.id, a])), [accounts]);

  const totalCryptoValue = useMemo(
    () => cryptoHoldings.reduce((sum, holding) => sum + getHoldingValue(holding), 0),
    [cryptoHoldings]
  );
  // From holdings, not wallet.eth_quantity: manual crypto accounts hold ETH
  // too, and a wallet sync writes its balance as an ETH holding anyway.
  const ethQuantity = useMemo(
    () => cryptoHoldings
      .filter((holding) => holding.ticker === 'ETH')
      .reduce((sum, holding) => sum + (parseFloat(holding.quantity) || 0), 0),
    [cryptoHoldings]
  );
  const otherPositions = useMemo(
    () => cryptoHoldings.filter((holding) => holding.ticker !== 'ETH').length,
    [cryptoHoldings]
  );
  const lastSyncedAt = useMemo(() => {
    const timestamps = wallets.map((w) => w.last_synced_at).filter(Boolean);
    if (timestamps.length === 0) return null;
    return timestamps.sort().at(-1);
  }, [wallets]);

  // '' is the All-wallets feed and the default -- with several addresses, the
  // question is almost always "what happened across my wallets".
  const activeWallet = wallets.find((wallet) => wallet.id === selectedWalletId) || null;

  const walletLabel = (wallet) => {
    if (wallet.label) return wallet.label;
    if (wallet.account) return displayAccountName(wallet.account);
    return shortEthAddress(wallet.address);
  };

  const walletNames = useMemo(
    () => new Map(wallets.map((wallet) => [wallet.id, walletLabel(wallet)])),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [wallets, accountDisplayNames]
  );

  const erroredWallets = useMemo(() => wallets.filter((wallet) => wallet.error_code), [wallets]);

  const handleSync = async (walletId) => {
    if (syncingWalletId) return;
    setSyncingWalletId(walletId);
    setError(null);
    try {
      await ethAPI.syncWallet(walletId);
      await fetchData();
      showSuccess('Wallet synced');
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to sync wallet');
    } finally {
      setSyncingWalletId(null);
    }
  };

  const handleEdit = (holding) => {
    if (isSyncManaged(holding)) return;
    setEditingHolding(holding);
    setIsFormOpen(true);
  };

  const handleSave = async (data) => {
    if (editingHolding) { await holdingsAPI.update(editingHolding.id, data); showSuccess('Holding updated'); }
    else { await holdingsAPI.create(data); showSuccess('Holding added'); }
    await fetchData();
    setIsFormOpen(false);
  };

  const handleDelete = async (id) => {
    try {
      await holdingsAPI.delete(id);
      showSuccess('Entry deleted');
      setIsFormOpen(false);
      setEditingHolding(null);
      await fetchData();
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to delete');
    }
  };

  const columns = useMemo(() => [
    {
      id: 'ticker',
      accessorFn: (row) => row.ticker || '',
      header: 'Ticker',
      meta: { width: '6rem', cellClassName: 'whitespace-nowrap' },
      cell: ({ getValue }) => (
        <span className="font-mono text-sm font-bold text-accent uppercase">{getValue() || '—'}</span>
      ),
    },
    {
      accessorKey: 'name',
      header: 'Name',
      meta: { cellClassName: 'min-w-0' },
      cell: ({ row, getValue }) => (
        <div className="flex min-w-0 items-center gap-2">
          <span className="truncate text-body-sm font-semibold text-primary">{getValue()}</span>
          {row.original.account_eth_wallet_id && <EthWalletBadge />}
        </div>
      ),
    },
    {
      id: 'account',
      accessorFn: (row) => displayAccountName(accountsMap.get(row.account_id)),
      header: 'Account',
      meta: { width: '11rem', cellClassName: 'truncate' },
    },
    {
      id: 'quantity',
      accessorFn: (row) => (row.quantity != null ? parseFloat(row.quantity) : null),
      header: 'Quantity',
      meta: { width: '9rem', align: 'right', headerClassName: 'text-right', cellClassName: 'whitespace-nowrap text-right' },
      cell: ({ getValue }) => {
        const quantity = getValue();
        return quantity != null
          ? <span className="font-money">{quantity.toLocaleString(undefined, { maximumFractionDigits: 6 })}</span>
          : <span className="text-tertiary">—</span>;
      },
    },
    {
      id: 'value',
      accessorFn: (row) => getHoldingValue(row),
      header: 'Value',
      meta: { width: '9rem', align: 'right', headerClassName: 'text-right', cellClassName: 'whitespace-nowrap text-right' },
      cell: ({ getValue }) => <span className="value-emphasis">{formatCurrency(getValue())}</span>,
    },
    {
      id: 'category',
      accessorFn: (row) => formatCategoryLabel(row.category),
      header: 'Category',
      meta: { width: '9rem', cellClassName: 'truncate' },
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
  ], [accountsMap, accountDisplayNames]);

  const table = useReactTable({
    data: cryptoHoldings,
    columns,
    state: { sorting, pagination },
    onSortingChange: setSorting,
    onPaginationChange: setPagination,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getPaginationRowModel: getPaginationRowModel(),
  });

  if (loading) {
    return <LoadingState label="Loading Crypto" />;
  }

  const isEmpty = wallets.length === 0 && cryptoAccounts.length === 0;

  return (
    <div className="mx-auto w-full max-w-[1240px] px-3 py-6 sm:px-4 md:py-8">
      <div className="mb-4 flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="mb-0.5 text-caption uppercase tracking-wide text-tertiary">Crypto</p>
          <h1 className="font-money text-display-lg text-primary">
            {formatCurrency(totalCryptoValue)}
          </h1>
          <p className="text-body-sm text-tertiary">
            Across {wallets.length} {wallets.length === 1 ? 'wallet' : 'wallets'} · {cryptoAccounts.length} {cryptoAccounts.length === 1 ? 'account' : 'accounts'}
          </p>
        </div>

        <SummaryStats stats={[
          { label: 'ETH', value: formatEthQuantity(ethQuantity), valueClassName: 'font-money font-semibold text-accent' },
          { label: 'Positions', value: cryptoHoldings.length },
        ]} />
      </div>

      {successMessage && (
        <div className="mb-4 border border-gain/20 bg-gain-bg p-3 text-body-sm text-gain">
          {successMessage}
        </div>
      )}
      {error && (
        <div className="mb-4 border border-loss/30 bg-loss-bg p-3 text-body-sm text-loss">
          {error}
        </div>
      )}

      {isEmpty ? (
        <div className="card p-12 text-center border-dashed border-2 border-border bg-transparent">
          <Wallet size={40} className="mx-auto text-tertiary mb-4 opacity-20" />
          <h3 className="text-lg font-bold text-primary mb-2 uppercase tracking-tight">No Crypto Tracked</h3>
          <p className="text-sm text-secondary max-w-md mx-auto leading-relaxed mb-5">
            Connect an Ethereum wallet from Settings to pull its balance and full transfer
            history, or add a manual crypto account.
          </p>
          <button
            onClick={() => onNavigate('settings', { tab: 'ethereum' })}
            className="inline-flex items-center justify-center gap-2 px-5 py-2.5 rounded text-xs font-bold uppercase tracking-wider text-purple-300 bg-purple-500/10 border border-purple-500/30 hover:bg-purple-500/20 hover:text-purple-200 transition-all"
          >
            <Wallet size={14} />
            Connect Crypto
          </button>
        </div>
      ) : (
        <div className="space-y-10">
          <div className="grid grid-cols-1 gap-px bg-border sm:grid-cols-2 xl:grid-cols-4">
            <MetricCard compact label="Total Value" value={formatCurrency(totalCryptoValue)} valueColor="accent" icon={Coins} />
            <MetricCard compact label="ETH Held" value={formatEthQuantity(ethQuantity)} icon={Wallet} />
            <MetricCard
              compact
              label="Wallets"
              value={wallets.length}
              caption={lastSyncedAt ? `Synced ${formatRelativeTime(lastSyncedAt)}` : 'Never synced'}
              icon={Activity}
            />
            <MetricCard compact label="Other Positions" value={otherPositions} icon={Layers} />
          </div>

          {cryptoHistory.length > 0 && (
            <section>
              <div className="flex items-center gap-2 mb-4">
                <Activity className="text-accent w-4 h-4" />
                <h2 className="text-xs font-bold uppercase tracking-wide text-secondary">Value History</h2>
              </div>
              <AccountHistoryChart
                accountData={cryptoHistory}
                portfolioData={null}
                accounts={cryptoAccounts}
                selectedAccounts={[...cryptoAccountIds]}
                showPortfolio={false}
                loading={false}
                error={null}
                singleColumn
              />
            </section>
          )}

          <section>
            <div className="flex items-center justify-between mb-4">
              <div className="flex items-center gap-2">
                <Coins className="text-accent w-4 h-4" />
                <h2 className="text-xs font-bold uppercase tracking-wide text-secondary">Holdings</h2>
              </div>
              {cryptoHoldings.length > 0 && (
                <span className="text-[10px] font-bold text-accent px-2 py-0.5 rounded bg-accent/10 border border-accent/20">
                  {cryptoHoldings.length} Total
                </span>
              )}
            </div>

            <DataTable
              table={table}
              emptyMessage="No crypto holdings found."
              onRowClick={handleEdit}
              rowClassName={(holding) => (isSyncManaged(holding) ? '' : 'cursor-pointer')}
              mobile="rows"
              renderMobileRow={(row) => {
                const holding = row.original;
                return (
                  <div
                    key={row.id}
                    className={`p-3 ${isSyncManaged(holding) ? '' : 'cursor-pointer hover:bg-surface-2'}`}
                    onClick={() => handleEdit(holding)}
                  >
                    <div className="flex items-start justify-between">
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-body-sm font-semibold text-primary">{holding.name}</p>
                        <p className="truncate text-caption text-tertiary">
                          {displayAccountName(accountsMap.get(holding.account_id))}
                          {holding.ticker ? ` / ${holding.ticker}` : ''}
                        </p>
                      </div>
                      <p className="value-emphasis shrink-0 pl-3">{formatCurrency(getHoldingValue(holding))}</p>
                    </div>
                  </div>
                );
              }}
            />
            <DataTablePagination table={table} total={cryptoHoldings.length} />
          </section>

          {wallets.length > 0 && (
            <section>
              <FilterTabs
                id="crypto-wallet"
                label="Wallet"
                className="mb-4"
                options={[
                  { value: '', label: `All wallets (${wallets.length})` },
                  ...wallets.map((wallet) => {
                    const name = walletLabel(wallet);
                    return {
                      value: String(wallet.id),
                      label: truncateLabel(name),
                      selectLabel: name,
                      title: `${name} · ${wallet.address}`,
                    };
                  }),
                ]}
                value={selectedWalletId == null ? '' : String(selectedWalletId)}
                onChange={(value) => setSelectedWalletId(value === '' ? null : parseInt(value))}
                actions={(
                  <button
                    onClick={() => handleSync(selectedWalletId)}
                    disabled={syncingWalletId != null || selectedWalletId == null}
                    title={selectedWalletId == null ? 'Select a wallet to sync it' : undefined}
                    className="inline-flex h-8 items-center justify-center gap-2 rounded border border-border bg-surface-3 px-3 text-[9px] font-bold uppercase tracking-wide text-secondary transition-all hover:border-accent hover:text-accent disabled:opacity-50"
                  >
                    <RefreshCw size={12} className={syncingWalletId != null ? 'animate-spin' : ''} />
                    Sync
                  </button>
                )}
              />

              {/* In the merged feed no single wallet is selected, so surface
                  every errored wallet rather than staying silent about them. */}
              {(selectedWalletId == null ? erroredWallets : [activeWallet].filter((w) => w?.error_code))
                .map((wallet) => (
                  <div key={wallet.id} className="mb-4 p-4 rounded border text-xs leading-relaxed bg-loss/5 border-loss/20 text-loss">
                    <div className="flex items-start gap-3">
                      <AlertTriangle size={14} className="mt-0.5 flex-shrink-0" />
                      <p>
                        <span className="font-semibold">{walletLabel(wallet)}: </span>
                        {wallet.error_message || `Wallet sync reported an error: ${wallet.error_code}`}
                      </p>
                    </div>
                  </div>
                ))}

              <OnChainActivity
                key={selectedWalletId ?? 'all'}
                walletId={selectedWalletId}
                walletNames={selectedWalletId == null ? walletNames : undefined}
              />
            </section>
          )}
        </div>
      )}

      <HoldingForm
        isOpen={isFormOpen}
        onClose={() => setIsFormOpen(false)}
        onSave={handleSave}
        onDelete={handleDelete}
        holding={editingHolding}
        accounts={cryptoAccounts.filter((account) => !account.eth_wallet_id)}
      />
    </div>
  );
};

export default CryptoPage;

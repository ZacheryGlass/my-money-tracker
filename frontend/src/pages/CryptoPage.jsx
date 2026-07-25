import React, { useState, useEffect, useMemo } from 'react';
import {
  useReactTable,
  getCoreRowModel,
  getSortedRowModel,
  getPaginationRowModel,
} from '@tanstack/react-table';
import { Activity, AlertTriangle, Coins, Layers, Plus, RefreshCw, Wallet } from 'lucide-react';
import { accounts as accountsAPI, holdings as holdingsAPI, history as historyApi, eth as ethAPI } from '../utils/api';
import { formatCurrency, formatRelativeTime } from '../utils/format';
import { buildAccountDisplayNameMap, getAccountDisplayName } from '../utils/accountDisplay';
import { formatCategoryLabel } from '../utils/dataLabels';
import AccountHistoryChart from '../components/AccountHistoryChart';
import DataTable, { DataTablePagination } from '../components/DataTable';
import HoldingForm from '../components/HoldingForm';
import LoadingState from '../components/LoadingState';
import MetricCard from '../components/MetricCard';
import FilterTabs from '../components/FilterTabs';
import OnChainActivity, { EthWalletBadge, shortEthAddress } from '../components/OnChainActivity';
import SummaryStats from '../components/SummaryStats';
import useTransientMessage from '../hooks/useTransientMessage';

const getHoldingValue = (holding) => parseFloat(holding.current_value ?? holding.manual_value ?? 0) || 0;

// Wallet syncs rebuild these rows; manual edits would be silently clobbered.
const isSyncManaged = (holding) => Boolean(holding.is_plaid_managed || holding.account_eth_wallet_id);

const formatEthQuantity = (quantity) =>
  Number(quantity || 0).toLocaleString(undefined, { maximumFractionDigits: 4 });

// Ids double as page ids, so the tab strip's onChange is just handleNavigate.
const OVERVIEW_TAB = 'crypto';
const HOLDINGS_TAB = 'crypto-holdings';
const TRANSACTIONS_TAB = 'crypto-transactions';
const CRYPTO_TAB_IDS = [OVERVIEW_TAB, HOLDINGS_TAB, TRANSACTIONS_TAB];

// Sentinel for "sync every wallet"; real wallet ids are >= 1.
const SYNC_ALL = 'all';

const CryptoPage = ({ tab = OVERVIEW_TAB, onTabChange, onNavigate }) => {
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
  // Bumped after a sync so the feed refetches: OnChainActivity is keyed on the
  // selected wallet, which a sync does not change, so without this the rows
  // sitting right under the Sync button would stay stale.
  const [syncNonce, setSyncNonce] = useState(0);

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

  // Falls back to Overview for an unknown tab, and for Transactions when there
  // are no wallets to show -- covers a bookmarked /crypto/transactions after
  // the last wallet is disconnected. Everything downstream reads activeTab,
  // never the raw `tab` prop.
  //
  // These three hooks MUST stay above the `if (loading)` return below: hooks
  // declared after an early return run on some renders and not others, which
  // React rejects outright ("rendered more hooks than during the previous
  // render") the moment loading flips false.
  const activeTab = CRYPTO_TAB_IDS.includes(tab)
    && (tab !== TRANSACTIONS_TAB || wallets.length > 0)
    ? tab
    : OVERVIEW_TAB;

  // Tab bodies are hidden with CSS, never unmounted: unmounting OnChainActivity
  // would throw away its accumulated Load More pages, transfer-type filter and
  // label cache on every tab hop. The Set still defers each body's FIRST mount,
  // so landing on Overview never fires the feed's requests.
  const [mountedTabs, setMountedTabs] = useState(() => new Set([activeTab]));
  useEffect(() => {
    setMountedTabs((seen) => (seen.has(activeTab) ? seen : new Set(seen).add(activeTab)));
  }, [activeTab]);

  // `error` multiplexes load, sync and delete failures and is otherwise only
  // cleared on the next attempt, so without this a sync failure would follow
  // the user onto every other tab.
  useEffect(() => { setError(null); }, [activeTab]);

  const handleSync = async (walletId) => {
    if (syncingWalletId) return;
    setSyncingWalletId(walletId);
    setError(null);
    try {
      await ethAPI.syncWallet(walletId);
      await fetchData();
      setSyncNonce((nonce) => nonce + 1);
      showSuccess('Wallet synced');
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to sync wallet');
    } finally {
      setSyncingWalletId(null);
    }
  };

  // Sequential, not Promise.all: these are Etherscan calls on one user's key
  // and firing seven at once invites a rate limit. Note this cannot be written
  // as a loop over handleSync -- that opens with `if (syncingWalletId) return`,
  // so every iteration after the first would early-return.
  const handleSyncAll = async () => {
    if (syncingWalletId) return;
    setSyncingWalletId(SYNC_ALL);
    setError(null);
    const failed = [];
    for (const wallet of wallets) {
      try {
        await ethAPI.syncWallet(wallet.id);
      } catch {
        failed.push(walletLabel(wallet));
      }
    }
    await fetchData();
    setSyncNonce((nonce) => nonce + 1);
    setSyncingWalletId(null);
    if (failed.length) setError(`${failed.length} of ${wallets.length} wallets failed to sync: ${failed.join(', ')}`);
    else showSuccess('Wallets synced');
  };

  const handleSyncClick = () => (
    selectedWalletId == null ? handleSyncAll() : handleSync(selectedWalletId)
  );

  const handleEdit = (holding) => {
    if (isSyncManaged(holding)) return;
    setEditingHolding(holding);
    setIsFormOpen(true);
  };

  const handleAdd = () => {
    setEditingHolding(null);
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

  const countBadge = (count, tone) => (
    <span className={`ml-1 rounded border px-1.5 py-0.5 text-[10px] font-bold ${tone}`}>{count}</span>
  );

  // Transactions is dropped entirely when there is no wallet to show, rather
  // than offered as a tab that opens onto an empty body.
  const tabOptions = [
    { value: OVERVIEW_TAB, label: 'Overview' },
    {
      value: HOLDINGS_TAB,
      label: 'Holdings',
      badge: cryptoHoldings.length > 0
        ? countBadge(cryptoHoldings.length, 'border-accent/20 bg-accent/10 text-accent')
        : null,
    },
    ...(wallets.length > 0 ? [{
      value: TRANSACTIONS_TAB,
      label: 'Transactions',
      badge: erroredWallets.length > 0
        ? countBadge(erroredWallets.length, 'border-loss/20 bg-loss/10 text-loss')
        : null,
    }] : []),
  ];

  // Body wrapper: mounted once visited, then hidden rather than unmounted.
  const tabBody = (id, children) => (
    mountedTabs.has(id) ? (
      <div className={activeTab === id ? 'space-y-10' : 'hidden'}>{children}</div>
    ) : null
  );

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
            {wallets.length > 0 && (lastSyncedAt ? ` · Synced ${formatRelativeTime(lastSyncedAt)}` : ' · Never synced')}
          </p>
        </div>

        <SummaryStats stats={[
          { label: 'ETH', value: formatEthQuantity(ethQuantity), valueClassName: 'font-money font-semibold text-accent' },
          { label: 'Positions', value: cryptoHoldings.length },
        ]} />
      </div>

      {/* Header -> tabs -> banners, following BalancesPage. The banners are
          transient (useTransientMessage clears after 3s); above the strip they
          would jump the tab bar vertically as they come and go. */}
      {!isEmpty && tabOptions.length >= 2 && (
        <FilterTabs
          id="crypto-section"
          label="Section"
          className="mb-6"
          options={tabOptions}
          value={activeTab}
          onChange={(id) => onTabChange?.(id)}
        />
      )}

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
            className="inline-flex items-center justify-center gap-2 px-5 py-2.5 rounded text-xs font-bold uppercase tracking-wider text-crypto bg-crypto-bg border border-crypto-border hover:bg-crypto-bg-hover hover:text-crypto-hover transition-all"
          >
            <Wallet size={14} />
            Connect Crypto
          </button>
        </div>
      ) : (
        <>
          {tabBody(OVERVIEW_TAB, (
            <>
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

              {cryptoHistory.length > 0 ? (
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
              ) : (
                <p className="text-body-sm text-tertiary">
                  No value history yet. Snapshots are written nightly.
                </p>
              )}
            </>
          ))}

          {tabBody(HOLDINGS_TAB, (
            <section>
              <div className="flex items-center justify-between mb-4">
                <div className="flex items-center gap-2">
                  <Coins className="text-accent w-4 h-4" />
                  <h2 className="text-xs font-bold uppercase tracking-wide text-secondary">Holdings</h2>
                </div>
                {/* The only route to holdingsAPI.create on this page: row
                    clicks open the edit form and bail on sync-managed rows, and
                    Balances no longer lists crypto accounts at all. */}
                <button
                  onClick={handleAdd}
                  className="inline-flex h-8 items-center gap-2 rounded border border-border bg-surface-3 px-3 text-[9px] font-bold uppercase tracking-wide text-secondary transition-all hover:border-accent hover:text-accent"
                >
                  <Plus size={12} />
                  Add Holding
                </button>
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
          ))}

          {wallets.length > 0 && tabBody(TRANSACTIONS_TAB, (
            <section>
              {/* A <select>, not a tab strip: these labels are notes-to-self
                  ("Use to store EOS ERC20 tokens before mainnet...") that no
                  strip can show whole, and a second tab strip here would
                  compete with the page tabs above. */}
              <div className="mb-4 flex flex-wrap items-center gap-3">
                {/* min-w-0 on both the label and the select is load-bearing: a
                    <select> sizes to its widest <option>, and these labels run
                    to a full sentence, so without it the control blows past the
                    viewport on a phone instead of ellipsizing. */}
                <label className="flex min-w-0 flex-1 items-center gap-2 sm:flex-initial">
                  <span className="shrink-0 text-caption font-semibold uppercase tracking-wide text-tertiary">Wallet</span>
                  <select
                    value={selectedWalletId == null ? '' : String(selectedWalletId)}
                    onChange={(event) => setSelectedWalletId(
                      event.target.value === '' ? null : parseInt(event.target.value)
                    )}
                    className="h-9 w-full min-w-0 border border-border bg-surface px-2 text-body-sm text-primary sm:w-[280px]"
                  >
                    <option value="">All wallets ({wallets.length})</option>
                    {wallets.map((wallet) => (
                      <option key={wallet.id} value={String(wallet.id)}>{walletLabel(wallet)}</option>
                    ))}
                  </select>
                </label>
                <button
                  onClick={handleSyncClick}
                  disabled={syncingWalletId != null}
                  className="inline-flex h-8 items-center justify-center gap-2 rounded border border-border bg-surface-3 px-3 text-[9px] font-bold uppercase tracking-wide text-secondary transition-all hover:border-accent hover:text-accent disabled:opacity-50"
                >
                  <RefreshCw size={12} className={syncingWalletId != null ? 'animate-spin' : ''} />
                  {selectedWalletId == null ? 'Sync all' : 'Sync'}
                </button>
              </div>

              {/* One line, not one banner per wallet: in the default all-wallets
                  view a stack of these would push the feed off the screen. The
                  full message per wallet already lives in Settings. */}
              {erroredWallets.length > 0 && (
                <div className="mb-4 flex flex-wrap items-center gap-2 border border-loss/20 bg-loss/5 p-2 text-body-sm text-loss">
                  <AlertTriangle size={14} className="shrink-0" />
                  <span>
                    {erroredWallets.length} {erroredWallets.length === 1 ? 'wallet' : 'wallets'} failed
                    their last sync — this feed may be incomplete.
                  </span>
                  <button
                    onClick={() => onNavigate('settings', { tab: 'ethereum' })}
                    className="underline hover:text-primary"
                  >
                    View details
                  </button>
                </div>
              )}

              <OnChainActivity
                key={`${selectedWalletId ?? 'all'}:${syncNonce}`}
                walletId={selectedWalletId}
                walletNames={selectedWalletId == null ? walletNames : undefined}
                onDataChanged={fetchData}
              />
            </section>
          ))}
        </>
      )}

      <HoldingForm
        isOpen={isFormOpen}
        onClose={() => { setIsFormOpen(false); setEditingHolding(null); }}
        onSave={handleSave}
        onDelete={handleDelete}
        holding={editingHolding}
        accounts={cryptoAccounts.filter((account) => !account.eth_wallet_id)}
      />
    </div>
  );
};

export default CryptoPage;

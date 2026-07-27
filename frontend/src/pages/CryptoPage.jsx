import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import {
  useReactTable,
  getCoreRowModel,
  getSortedRowModel,
  getPaginationRowModel,
} from '@tanstack/react-table';
import { Activity, AlertTriangle, Coins, Layers, Plus, RefreshCw, Wallet } from 'lucide-react';
import {
  accounts as accountsAPI,
  holdings as holdingsAPI,
  history as historyApi,
  eth as ethAPI,
  exchanges as exchangesAPI,
  crypto as cryptoAPI,
} from '../utils/api';
import { formatCurrency, formatRelativeTime, shortEthAddress } from '../utils/format';
import { buildAccountDisplayNameMap, getAccountDisplayName } from '../utils/accountDisplay';
import { formatCategoryLabel } from '../utils/dataLabels';
import AccountHistoryChart from '../components/AccountHistoryChart';
import CryptoLedger from '../components/CryptoLedger';
import DataTable, { DataTablePagination } from '../components/DataTable';
import HoldingForm from '../components/HoldingForm';
import LoadingState from '../components/LoadingState';
import MetricCard from '../components/MetricCard';
import FilterTabs from '../components/FilterTabs';
import OnChainActivity, { EthWalletBadge } from '../components/OnChainActivity';
import SummaryStats from '../components/SummaryStats';
import WalletsPanel from '../components/crypto/WalletsPanel';
import ExchangesPanel from '../components/crypto/ExchangesPanel';
import ReviewPanel, { SPAM_PAGE_SIZE, SPAM_MAX_LIMIT } from '../components/crypto/ReviewPanel';
import LabelsPanel from '../components/crypto/LabelsPanel';
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
// The management tabs, moved off Settings with #75: a wallet, an exchange
// account, a counterparty verdict and an ignored token are all crypto data, and
// living under Settings put each of them several clicks from the feed it
// changes. The Ethereum tab's five stacked sections became three tabs on the
// split that already existed between them -- what is tracked (Wallets), what
// needs a decision (Review), and the reference lists those decisions write
// (Labels).
const WALLETS_TAB = 'crypto-wallets';
const EXCHANGES_TAB = 'crypto-exchanges';
const REVIEW_TAB = 'crypto-review';
const LABELS_TAB = 'crypto-labels';
const MANAGE_TAB_IDS = [WALLETS_TAB, EXCHANGES_TAB, REVIEW_TAB, LABELS_TAB];
const CRYPTO_TAB_IDS = [OVERVIEW_TAB, HOLDINGS_TAB, TRANSACTIONS_TAB, ...MANAGE_TAB_IDS];

// Inside the Transactions tab. The unified ledger (#63) is the tab -- one
// chronological line per EVENT across wallets, chains and exchange accounts.
// The raw per-leg feed stays reachable beside it rather than being deleted:
// it is the only place a token can be ignored in context, and a swap's six
// router hops are legible there in a way a netted line cannot be.
const LEDGER_VIEW = 'ledger';
const TRANSFERS_VIEW = 'transfers';

// Sentinel for "sync every wallet"; real wallet ids are >= 1.
const SYNC_ALL = 'all';

const CryptoPage = ({ tab = OVERVIEW_TAB, onTabChange }) => {
  const [wallets, setWallets] = useState([]);
  const [holdings, setHoldings] = useState([]);
  const [accounts, setAccounts] = useState([]);
  const [historyRows, setHistoryRows] = useState([]);
  // Counts for the Transactions badge and for whether the tab exists at all.
  // Exchange records create no account and no wallet, so a user whose crypto
  // history is entirely CSV imports has nothing else to gate the tab on.
  const [ledgerSummary, setLedgerSummary] = useState(null);
  const [txView, setTxView] = useState(LEDGER_VIEW);
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

  // Everything the four management tabs read. Fetched separately from the page
  // data and only once a management tab is opened: none of it is needed to
  // render Overview, Holdings or the ledger, and six extra requests on every
  // landing would be paid by the users who never manage anything.
  const [ignoredTokens, setIgnoredTokens] = useState([]);
  const [addressLabels, setAddressLabels] = useState([]);
  // null = not loaded or the fetch failed; [] = loaded and genuinely empty.
  // The distinction matters: never claim "all clear" on a failed request.
  const [counterpartyData, setCounterpartyData] = useState(null);
  // Quarantined spam (#74), same rule as counterpartyData: "nothing was hidden"
  // must never be the way a failed request looks, because the whole promise of
  // a quarantine is that it says what it swallowed.
  const [spamActivity, setSpamActivity] = useState(null);
  const [exchangeAccounts, setExchangeAccounts] = useState([]);
  // Loaded-and-empty and failed-to-load must not look alike: "No Exchange
  // Accounts" after a failed request invites the user to add one they already
  // have, and hides the imports they made.
  const [exchangeLoadFailed, setExchangeLoadFailed] = useState(false);
  // What each venue's credential form should ask for, and which read-only
  // permissions to grant. Served by the API rather than hardcoded so the
  // guidance cannot drift from the connector that depends on it.
  const [credentialFields, setCredentialFields] = useState({});
  const [exchangeEncryptionConfigured, setExchangeEncryptionConfigured] = useState(true);
  const [manageLoaded, setManageLoaded] = useState(false);
  // How many pages of the quarantine are currently on screen. A REF, not state:
  // fetchManageData reads it, and putting it in that useCallback's deps would
  // make "show more" refetch every management list instead of one.
  //
  // It also has to survive the refetch that follows a "Not spam" click, the
  // only surface with that button: a wave that buried a real transaction at
  // row 200 must not spring back to row 50 when something above it is rescued.
  const spamPagesRef = useRef(1);

  const fetchData = async () => {
    try {
      const [walletsData, holdingsData, accountsData, historyData, ledgerData] = await Promise.all([
        ethAPI.getWallets().catch(() => null),
        holdingsAPI.getAll(),
        accountsAPI.getAll(),
        historyApi.getAccounts({ limit: 10000, withCount: false }),
        cryptoAPI.getLedgerSummary().catch(() => null),
      ]);
      setWallets(walletsData?.wallets || []);
      setHoldings(holdingsData.holdings || []);
      setAccounts(accountsData.accounts || []);
      setHistoryRows(historyData.data || []);
      setLedgerSummary(ledgerData?.summary || null);
      setError(null);
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to load crypto data');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { fetchData(); }, []);

  // Each list degrades on its own: a failed labels request must not blank the
  // exchange accounts beside it, and the two nullable ones say so themselves.
  const fetchManageData = useCallback(async () => {
    const [ignoredResult, labelsResult, counterpartyResult, spamResult, exchangeResult] = await Promise.all([
      ethAPI.getIgnoredTokens().catch(() => null),
      ethAPI.getAddressLabels().catch(() => null),
      ethAPI.getUnreviewedCounterparties().catch(() => null),
      // Paged, not capped: the first page is all anyone usually needs, and
      // "Show more" walks the rest. summary.spam_count is the honest total and
      // the header renders it, not the array's length.
      ethAPI.getActivity({
        spam: 'only',
        limit: Math.min(SPAM_PAGE_SIZE * spamPagesRef.current, SPAM_MAX_LIMIT),
      }).catch(() => null),
      exchangesAPI.getAll().catch(() => null),
    ]);
    setIgnoredTokens(ignoredResult?.tokens || []);
    setAddressLabels(labelsResult?.labels || []);
    setCounterpartyData(counterpartyResult || null);
    setSpamActivity(spamResult || null);
    setExchangeAccounts(exchangeResult?.accounts || []);
    setExchangeLoadFailed(!exchangeResult);
    setCredentialFields(exchangeResult?.credential_fields || {});
    // Only treated as unavailable on a response that actually said so: a
    // failed request must not read as "the server cannot store keys".
    setExchangeEncryptionConfigured(exchangeResult ? exchangeResult.encryption_configured !== false : true);
    setManageLoaded(true);
  }, []);

  // A management action changes both halves -- labelling an address rewrites
  // the ledger behind it, ignoring a token drops holdings -- so both refetch.
  const handleManageChanged = useCallback(async () => {
    await Promise.all([fetchData(), fetchManageData()]);
    // The ledger and the transfer feed are keyed on this: a label write
    // reclassifies rows they are already showing.
    setSyncNonce((nonce) => nonce + 1);
  }, [fetchManageData]);

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
  // Wallet-backed accounts are rebuilt by every sync, so a manual holding can
  // only go in an account the user made themselves.
  const manualCryptoAccounts = useMemo(
    () => cryptoAccounts.filter((account) => !account.eth_wallet_id),
    [cryptoAccounts]
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

  // A wallet whose ETH ledger does not reproduce the chain's balance counts
  // here too, but only ONCE even when it also carries a sync error -- the two
  // are the same wallet asking for the same look. Token drift deliberately does
  // not count: rebasing and fee-on-transfer contracts drift with no missed
  // transfer behind it, so badging them would pin the number above zero for
  // anyone who ever held one.
  const walletAttentionCount = useMemo(
    () => wallets.filter((wallet) => wallet.error_code || wallet.reconciliation?.needs_review).length,
    [wallets]
  );
  // Material only, deliberately. A badge that cannot reach zero -- because a
  // single airdrop wave parked 40 dust counterparties behind it -- teaches the
  // user to ignore the badge.
  const reviewAttentionCount = counterpartyData?.summary?.count || 0;
  const exchangeAttentionCount = useMemo(
    () => exchangeAccounts.reduce((sum, account) => sum + (account.needs_review_count || 0), 0),
    [exchangeAccounts]
  );

  // Typeahead for the triage form keeps every exchange name, builtins included.
  const exchangeNameOptions = useMemo(
    () => [...new Set(addressLabels.filter((l) => !l.kind || l.kind === 'exchange').map((l) => l.name))],
    [addressLabels]
  );

  // Falls back to Overview for an unknown tab, and for Transactions when there
  // are no wallets to show -- covers a bookmarked /crypto/transactions after
  // the last wallet is disconnected. Everything downstream reads activeTab,
  // never the raw `tab` prop.
  //
  // These three hooks MUST stay above the `if (loading)` return below: hooks
  // declared after an early return run on some renders and not others, which
  // React rejects outright ("rendered more hooks than during the previous
  // render") the moment loading flips false.
  // The ledger spans wallets AND exchange accounts, so the tab exists whenever
  // either has anything in it.
  const hasLedger = wallets.length > 0 || (ledgerSummary?.total || 0) > 0;
  const isEmpty = wallets.length === 0 && cryptoAccounts.length === 0 && !hasLedger;

  // Transactions falls back to Overview when there is no ledger, which covers a
  // bookmarked /crypto/transactions after the last wallet is disconnected.
  // Every other tab always exists -- a condition here that depends on data
  // arriving later would fall back on the first, still-loading render and mount
  // Overview permanently, since tab bodies are mounted once and then hidden.
  const activeTab = CRYPTO_TAB_IDS.includes(tab)
    && (tab !== TRANSACTIONS_TAB || hasLedger)
    ? tab
    : OVERVIEW_TAB;
  // Set by the Overview empty state and the failed-sync banner, which point at
  // a management tab rather than at Settings now that both live here.
  const goToTab = (id) => onTabChange?.(id);

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

  // The management lists load the first time one of their tabs is opened, and
  // once only -- every later refresh runs through handleManageChanged, which is
  // tied to an action rather than to arriving on a tab.
  useEffect(() => {
    if (manageLoaded || !MANAGE_TAB_IDS.includes(activeTab)) return;
    fetchManageData();
  }, [activeTab, manageLoaded, fetchManageData]);

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

  const countBadge = (count, tone) => (
    <span className={`ml-1 rounded border px-1.5 py-0.5 text-[10px] font-bold ${tone}`}>{count}</span>
  );

  // Transactions is dropped entirely when there is nothing to show, rather
  // than offered as a tab that opens onto an empty body.
  //
  // Its badge answers "what is unexplained", which is the ledger's whole
  // promise, and it can actually reach zero -- every flagged row is resolvable
  // by hand. A failed wallet sync outranks it: an incomplete feed makes the
  // review count itself untrustworthy.
  const needsReviewCount = ledgerSummary?.needs_review_count || 0;
  const tabOptions = [
    { value: OVERVIEW_TAB, label: 'Overview' },
    {
      value: HOLDINGS_TAB,
      label: 'Holdings',
      badge: cryptoHoldings.length > 0
        ? countBadge(cryptoHoldings.length, 'border-accent/20 bg-accent/10 text-accent')
        : null,
    },
    ...(hasLedger ? [{
      value: TRANSACTIONS_TAB,
      label: 'Transactions',
      badge: erroredWallets.length > 0
        ? countBadge(erroredWallets.length, 'border-loss/20 bg-loss/10 text-loss')
        : needsReviewCount > 0
          ? countBadge(needsReviewCount, 'border-orange-500/30 bg-orange-500/10 text-orange-400')
          : null,
    }] : []),
    // The management tabs are always offered, empty portfolio included: adding
    // the first wallet or exchange account is what they are for. The divider
    // splits the strip into what the user READS (Overview, Holdings,
    // Transactions) and what they MANAGE, so seven tabs scan as 3 + 4.
    { divider: true, hint: 'Manage' },
    {
      value: WALLETS_TAB,
      label: 'Wallets',
      badge: walletAttentionCount > 0
        ? countBadge(walletAttentionCount, 'border-loss/20 bg-loss/10 text-loss')
        : null,
    },
    {
      value: EXCHANGES_TAB,
      label: 'Exchanges',
      badge: exchangeAttentionCount > 0
        ? countBadge(exchangeAttentionCount, 'border-loss/20 bg-loss/10 text-loss')
        : null,
    },
    {
      value: REVIEW_TAB,
      label: 'Review',
      badge: reviewAttentionCount > 0
        ? countBadge(reviewAttentionCount, 'border-orange-500/30 bg-orange-500/10 text-orange-400')
        : null,
    },
    { value: LABELS_TAB, label: 'Labels' },
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
      {/* Always rendered, empty portfolio included: the management tabs are how
          the first wallet or exchange account gets added. */}
      <FilterTabs
        id="crypto-section"
        label="Section"
        className="mb-6"
        options={tabOptions}
        value={activeTab}
        onChange={goToTab}
      />

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

      <>
          {tabBody(OVERVIEW_TAB, isEmpty ? (
            <div className="card p-12 text-center border-dashed border-2 border-border bg-transparent">
              <Wallet size={40} className="mx-auto text-tertiary mb-4 opacity-20" />
              <h3 className="text-lg font-bold text-primary mb-2 uppercase tracking-tight">No Crypto Tracked</h3>
              <p className="text-sm text-secondary max-w-md mx-auto leading-relaxed mb-5">
                Track an Ethereum wallet to pull its balance and full transfer history, add an
                exchange account for activity that never touched a wallet, or add a manual crypto
                account.
              </p>
              <button
                onClick={() => goToTab(WALLETS_TAB)}
                className="inline-flex items-center justify-center gap-2 px-5 py-2.5 rounded text-xs font-bold uppercase tracking-wider text-crypto bg-crypto-bg border border-crypto-border hover:bg-crypto-bg-hover hover:text-crypto-hover transition-all"
              >
                <Wallet size={14} />
                Connect Crypto
              </button>
            </div>
          ) : (
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
                    Balances no longer lists crypto accounts at all. Hidden when
                    there is no manual crypto account to add to -- the form's
                    account select would open empty. */}
                {manualCryptoAccounts.length > 0 && (
                <button
                  onClick={handleAdd}
                  className="inline-flex h-8 items-center gap-2 rounded border border-border bg-surface-3 px-3 text-[9px] font-bold uppercase tracking-wide text-secondary transition-all hover:border-accent hover:text-accent"
                >
                  <Plus size={12} />
                  Add Holding
                </button>
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
          ))}

          {hasLedger && tabBody(TRANSACTIONS_TAB, (
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
                {wallets.length > 0 && (
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
                )}
                {wallets.length > 0 && (
                  <button
                    onClick={handleSyncClick}
                    disabled={syncingWalletId != null}
                    className="inline-flex h-8 items-center justify-center gap-2 rounded border border-border bg-surface-3 px-3 text-[9px] font-bold uppercase tracking-wide text-secondary transition-all hover:border-accent hover:text-accent disabled:opacity-50"
                  >
                    <RefreshCw size={12} className={syncingWalletId != null ? 'animate-spin' : ''} />
                    {selectedWalletId == null ? 'Sync all' : 'Sync'}
                  </button>
                )}
              </div>

              {/* One line, not one banner per wallet: in the default all-wallets
                  view a stack of these would push the feed off the screen. The
                  full message per wallet is on the Wallets tab. */}
              {erroredWallets.length > 0 && (
                <div className="mb-4 flex flex-wrap items-center gap-2 border border-loss/20 bg-loss/5 p-2 text-body-sm text-loss">
                  <AlertTriangle size={14} className="shrink-0" />
                  <span>
                    {erroredWallets.length} {erroredWallets.length === 1 ? 'wallet' : 'wallets'} failed
                    their last sync — this feed may be incomplete.
                  </span>
                  <button
                    onClick={() => goToTab(WALLETS_TAB)}
                    className="underline hover:text-primary"
                  >
                    View details
                  </button>
                </div>
              )}

              {txView === LEDGER_VIEW ? (
                <CryptoLedger
                  walletId={selectedWalletId}
                  refreshKey={syncNonce}
                  onDataChanged={fetchData}
                  // The raw feed is entered from a quiet link on the ledger's
                  // filter bar, not a sibling mode toggle: it is a drill-down
                  // (and the one place a token can be ignored in context), not
                  // an equal way to read the ledger.
                  onShowTransferLegs={() => setTxView(TRANSFERS_VIEW)}
                />
              ) : (
                <>
                  <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
                    <p className="text-caption text-tertiary">
                      Every per-leg transfer as the chain recorded it — the raw feed behind the
                      ledger&apos;s events, and the place to ignore a token in context.
                    </p>
                    <button
                      type="button"
                      onClick={() => setTxView(LEDGER_VIEW)}
                      className="inline-flex h-8 items-center gap-1.5 rounded border border-border bg-surface-3 px-3 text-[9px] font-bold uppercase tracking-wide text-secondary transition-all hover:border-accent hover:text-accent"
                    >
                      ← Back to ledger
                    </button>
                  </div>
                  <OnChainActivity
                    key={`${selectedWalletId ?? 'all'}:${syncNonce}`}
                    walletId={selectedWalletId}
                    walletNames={selectedWalletId == null ? walletNames : undefined}
                    onDataChanged={fetchData}
                  />
                </>
              )}
            </section>
          ))}

          {tabBody(WALLETS_TAB, (
            <WalletsPanel
              wallets={wallets}
              onChanged={handleManageChanged}
              onError={setError}
              showSuccess={showSuccess}
            />
          ))}

          {tabBody(EXCHANGES_TAB, (
            <ExchangesPanel
              accounts={exchangeAccounts}
              loadFailed={exchangeLoadFailed}
              credentialFields={credentialFields}
              encryptionConfigured={exchangeEncryptionConfigured}
              onChanged={handleManageChanged}
              onError={setError}
              showSuccess={showSuccess}
              onRetry={fetchManageData}
            />
          ))}

          {tabBody(REVIEW_TAB, (
            <ReviewPanel
              counterpartyData={counterpartyData}
              spamActivity={spamActivity}
              onSpamPageLoaded={(next) => { spamPagesRef.current += 1; setSpamActivity(next); }}
              exchangeNameOptions={exchangeNameOptions}
              hasWallets={wallets.length > 0}
              onChanged={handleManageChanged}
              onError={setError}
              showSuccess={showSuccess}
              onRetry={fetchManageData}
            />
          ))}

          {tabBody(LABELS_TAB, (
            <LabelsPanel
              addressLabels={addressLabels}
              ignoredTokens={ignoredTokens}
              onChanged={handleManageChanged}
              onError={setError}
              showSuccess={showSuccess}
            />
          ))}
      </>

      <HoldingForm
        isOpen={isFormOpen}
        onClose={() => { setIsFormOpen(false); setEditingHolding(null); }}
        onSave={handleSave}
        onDelete={handleDelete}
        holding={editingHolding}
        accounts={manualCryptoAccounts}
      />
    </div>
  );
};

export default CryptoPage;

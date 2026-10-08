import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import {
  useReactTable,
  getCoreRowModel,
  getSortedRowModel,
  getPaginationRowModel,
} from '@tanstack/react-table';
import { Activity, AlertTriangle, Coins, Plus, RefreshCw, Wallet } from 'lucide-react';
import {
  accounts as accountsAPI,
  holdings as holdingsAPI,
  history as historyApi,
  eth as ethAPI,
  exchanges as exchangesAPI,
  crypto as cryptoAPI,
} from '../utils/api';
import { formatCurrency, formatDateDisplay, formatPercent, formatRelativeTime, shortEthAddress } from '../utils/format';
import { buildAccountDisplayNameMap, getAccountDisplayName } from '../utils/accountDisplay';
import AccountHistoryChart from '../components/AccountHistoryChart';
import { totalSeries } from '../features/crypto/history';
import {
  changeOverDays, groupHoldingsByAsset, isDust, possibleDuplicates, splitNetworkSuffix, valueBySource,
} from '../features/crypto/holdings';
import AttentionList from '../features/crypto/overview/AttentionList';
import HeldWhere from '../features/crypto/overview/HeldWhere';
import StakingIncomeCard from '../features/crypto/overview/StakingIncomeCard';
import AllocationDonut from '../components/AllocationDonut';
import HoldingsByAsset, { NetworkChip } from '../features/crypto/holdings/HoldingsByAsset';
import CryptoLedger from '../components/CryptoLedger';
import EthLedger from '../components/EthLedger';
import SegmentedControl from '../components/SegmentedControl';
import DataTable, { DataTablePagination } from '../components/DataTable';
import HoldingForm from '../components/HoldingForm';
import LoadingState from '../components/LoadingState';
import LoadFailed from '../features/crypto/LoadFailed';
import TransactionQueue from '../features/crypto/review/TransactionQueue';
import BridgeEvidencePanel from '../features/crypto/review/BridgeEvidencePanel';
import FilterTabs from '../components/FilterTabs';
import OnChainActivity, { EthWalletBadge } from '../components/OnChainActivity';
import SummaryStats from '../components/SummaryStats';
import WalletsPanel from '../components/crypto/WalletsPanel';
import ExchangesPanel from '../components/crypto/ExchangesPanel';
import ReviewPanel, { SPAM_PAGE_SIZE, SPAM_MAX_LIMIT } from '../components/crypto/ReviewPanel';
import LabelsPanel from '../components/crypto/LabelsPanel';
import DiscoveryPanel from '../components/crypto/DiscoveryPanel';
import useTransientMessage from '../hooks/useTransientMessage';
import { isWalletSyncFailure } from '../utils/walletSync';

const getHoldingValue = (holding) => parseFloat(holding.current_value ?? holding.manual_value ?? 0) || 0;

// Wallet syncs rebuild these rows; manual edits would be silently clobbered.
const isSyncManaged = (holding) => Boolean(holding.is_plaid_managed || holding.account_eth_wallet_id || holding.account_exchange_account_id);

const formatEthQuantity = (quantity) =>
  Number(quantity || 0).toLocaleString(undefined, { maximumFractionDigits: 4 });

// Each id is a real page in the Crypto sidebar section. They share this mounted
// workspace so expensive ledger state survives navigation, but the user sees
// page titles and sidebar destinations rather than one eight-tab workbench.
const OVERVIEW_TAB = 'crypto';
const HOLDINGS_TAB = 'crypto-holdings';
const TRANSACTIONS_TAB = 'crypto-transactions';
const WALLETS_TAB = 'crypto-wallets';
const EXCHANGES_TAB = 'crypto-exchanges';
const REVIEW_TAB = 'crypto-review';
const LABELS_TAB = 'crypto-labels';
const DISCOVERY_ALIAS = 'crypto-discovery';
const MANAGE_TAB_IDS = [WALLETS_TAB, EXCHANGES_TAB, REVIEW_TAB, LABELS_TAB];
const CRYPTO_TAB_IDS = [OVERVIEW_TAB, HOLDINGS_TAB, TRANSACTIONS_TAB, ...MANAGE_TAB_IDS];

const PAGE_META = {
  [HOLDINGS_TAB]: {
    title: 'Holdings',
    description: 'Every crypto position you hold, across wallets, exchanges and manual accounts.',
  },
  [TRANSACTIONS_TAB]: {
    title: 'Activity',
    description: 'Every transaction across your wallets, networks and exchange accounts, newest first.',
  },
  [WALLETS_TAB]: {
    title: 'Wallets',
    description: 'Add wallet addresses, keep them synced, and find wallets you may have forgotten.',
  },
  [EXCHANGES_TAB]: {
    title: 'Exchanges',
    description: 'Connect exchanges with read-only keys or CSV exports, and check their balances.',
  },
  [REVIEW_TAB]: {
    title: 'Review',
    description: 'Explain what the app could not: unexplained transactions, unknown addresses and balance gaps.',
  },
  [LABELS_TAB]: {
    title: 'Labels & Rules',
    description: 'Say what addresses are, keep notes on them, and hide tokens you do not want counted.',
  },
};

// Inside the Transactions tab. The unified ledger (#63) is the tab -- one
// chronological line per EVENT across wallets, chains and exchange accounts.
// The raw per-leg feed stays reachable beside it rather than being deleted:
// it is the only place a token can be ignored in context, and a swap's six
// router hops are legible there in a way a netted line cannot be.
const LEDGER_VIEW = 'ledger';
const TRANSFERS_VIEW = 'transfers';

// Sentinel for "sync every wallet"; real wallet ids are >= 1.
const SYNC_ALL = 'all';
// onAttentionChange reports the wallet, ledger and management attention counts
// up to the app shell, which renders them as page-specific Crypto badges.
const CryptoPage = ({ tab = OVERVIEW_TAB, onTabChange, onAttentionChange }) => {
  const [wallets, setWallets] = useState([]);
  const [holdings, setHoldings] = useState([]);
  const [accounts, setAccounts] = useState([]);
  const [historyRows, setHistoryRows] = useState([]);
  // Counts for the Activity/Review summaries. Exchange records create no
  // account and no wallet, so a user whose crypto history is entirely CSV
  // imports has nothing else to gate the page on.
  const [ledgerSummary, setLedgerSummary] = useState(null);
  const [ledgerSummaryState, setLedgerSummaryState] = useState('loading');
  const [txView, setTxView] = useState(LEDGER_VIEW);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  // The page's own read failing, kept apart from `error` (actions: sync,
  // delete), which is cleared on every page change. A load failure has to
  // stay on screen, or the next page reads as genuinely empty.
  const [loadError, setLoadError] = useState(null);
  const [walletsLoadFailed, setWalletsLoadFailed] = useState(false);
  const [selectedWalletId, setSelectedWalletId] = useState(null);
  // Activity narrows to a wallet OR an exchange account, never both.
  const [selectedExchangeAccountId, setSelectedExchangeAccountId] = useState(null);
  // One address's transactions, opened from Review's "View transactions".
  const [ledgerCounterparty, setLedgerCounterparty] = useState(null);
  // A category to open Activity on (the Overview's "See every reward").
  const [ledgerCategoryRequest, setLedgerCategoryRequest] = useState(null);
  const clearLedgerCategoryRequest = useCallback(() => setLedgerCategoryRequest(null), []);
  const [pickerExchangeAccounts, setPickerExchangeAccounts] = useState([]);
  const [syncingWalletId, setSyncingWalletId] = useState(null);
  const [sorting, setSorting] = useState([{ id: 'value', desc: true }]);
  const [pagination, setPagination] = useState({ pageIndex: 0, pageSize: 25 });
  const [isFormOpen, setIsFormOpen] = useState(false);
  const [editingHolding, setEditingHolding] = useState(null);
  const [successMessage, showSuccess] = useTransientMessage();
  const [noticeMessage, showNotice] = useTransientMessage();
  // Bumped after a sync so the feed refetches: OnChainActivity is keyed on the
  // selected wallet, which a sync does not change, so without this the rows
  // sitting right under the Sync button would stay stale.
  const [syncNonce, setSyncNonce] = useState(0);

  // Everything the management pages read. Fetched separately from the page
  // data and only once a management page is opened: none of it is needed to
  // render Overview, Holdings or Activity, and six extra requests on every
  // landing would be paid by the users who never manage anything.
  const [ignoredTokens, setIgnoredTokens] = useState([]);
  const [addressLabels, setAddressLabels] = useState([]);
  const [labelsLoadFailed, setLabelsLoadFailed] = useState(false);
  const [ignoredLoadFailed, setIgnoredLoadFailed] = useState(false);
  const [addressNotes, setAddressNotes] = useState([]);
  // null = not loaded or the fetch failed; [] = loaded and genuinely empty.
  // The distinction matters: never claim "all clear" on a failed request.
  const [counterpartyData, setCounterpartyData] = useState(null);
  // Quarantined spam (#74), same rule as counterpartyData: "nothing was hidden"
  // must never be the way a failed request looks, because the whole promise of
  // a quarantine is that it says what it swallowed.
  const [spamActivity, setSpamActivity] = useState(null);
  const [exchangeAccounts, setExchangeAccounts] = useState([]);
  const [exchangeFocusAccountId, setExchangeFocusAccountId] = useState(null);
  const [reviewQueue, setReviewQueue] = useState(null);
  const [bridgeSuggestionCount, setBridgeSuggestionCount] = useState(null);
  // undefined = not loaded yet; null = the request failed; an object is a
  // successful read.
  const [exchangeExceptions, setExchangeExceptions] = useState(undefined);
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
  // The unified ledger summary is much heavier than the portfolio reads. It
  // must never hold the whole Crypto page on a loading screen; this sequence
  // also prevents an older summary from overwriting a newer post-action one.
  const ledgerSummaryRequestRef = useRef(0);

  // useCallback because it closes over the onAttentionChange prop: the mount
  // effect and handleManageChanged list it, and an unstable identity would
  // refire the whole page fetch on every parent render.
  const fetchData = useCallback(async () => {
    try {
      const summaryRequest = ++ledgerSummaryRequestRef.current;
      const ledgerPromise = cryptoAPI.getLedgerSummary()
        .then((data) => ({ ok: true, data }))
        .catch(() => ({ ok: false, data: null }));
      const [walletsData, holdingsData, accountsData, historyData, notesData] = await Promise.all([
        ethAPI.getWallets().catch(() => null),
        holdingsAPI.getAll(),
        accountsAPI.getAll(),
        historyApi.getAccounts({ type: 'crypto', limit: 10000, withCount: false }),
        ethAPI.getAddressNotes().catch(() => null),
      ]);
      setWallets(walletsData?.wallets || []);
      setWalletsLoadFailed(!walletsData);
      setHoldings(holdingsData.holdings || []);
      setAccounts(accountsData.accounts || []);
      setHistoryRows(historyData.data || []);
      if (notesData) setAddressNotes(notesData.notes || []);
      // The summary keeps running after the portfolio is renderable. Review
      // actions still refresh the badge, but a slow fold query cannot hide the
      // Notes/Labels/Wallets surfaces behind "Loading Crypto".
      void ledgerPromise.then(({ ok, data: ledgerData }) => {
        if (summaryRequest !== ledgerSummaryRequestRef.current) return;
        setLedgerSummary(ok ? (ledgerData?.summary || null) : null);
        setLedgerSummaryState(ok ? 'ready' : 'error');
        // A half whose fetch failed reports NULL, never zero: "unknown"
        // downgrading a red badge to all-clear is the lossy direction.
        onAttentionChange?.({
          errored: walletsData
            ? (walletsData.wallets || []).filter((wallet) => (
              isWalletSyncFailure(wallet) || wallet.reconciliation?.needs_review
            )).length
            : null,
          needsReview: ok ? (ledgerData?.summary?.needs_review_count || 0) : null,
        });
      });
      setLoadError(null);
    } catch (err) {
      setLoadError(err.response?.data?.error || 'Failed to load crypto data');
    } finally {
      setLoading(false);
    }
  }, [onAttentionChange]);

  useEffect(() => { fetchData(); }, [fetchData]);

  // Just the wallet list: what the Wallets page polls while a sync or a
  // recapture runs in the background.
  const refreshWallets = useCallback(async () => {
    try {
      const result = await ethAPI.getWallets();
      setWallets(result?.wallets || []);
    } catch {
      // A missed poll is harmless; the next one, or the next action, retries.
    }
  }, []);

  // Each list degrades on its own: a failed labels request must not blank the
  // exchange accounts beside it, and the two nullable ones say so themselves.
  const fetchManageData = useCallback(async () => {
    const exchangeExceptionsPromise = exchangesAPI.getBalanceExceptions({ limit: 50 })
      .catch(() => null);
    const [ignoredResult, labelsResult, counterpartyResult, spamResult, exchangeResult, exchangeExceptionResult, bridgeResult] = await Promise.all([
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
      exchangeExceptionsPromise,
      // Only the count is read here; the Bridges tab loads the full audit.
      Promise.resolve().then(() => cryptoAPI.getBridgeAudit({ limit: 1, suggestion_limit: 1 })).catch(() => null),
    ]);
    setIgnoredTokens(ignoredResult?.tokens || []);
    setIgnoredLoadFailed(!ignoredResult);
    setAddressLabels(labelsResult?.labels || []);
    setLabelsLoadFailed(!labelsResult);
    setCounterpartyData(counterpartyResult || null);
    setSpamActivity(spamResult || null);
    setExchangeAccounts(exchangeResult?.accounts || []);
    setExchangeLoadFailed(!exchangeResult);
    setCredentialFields(exchangeResult?.credential_fields || {});
    // Only treated as unavailable on a response that actually said so: a
    // failed request must not read as "the server cannot store keys".
    setExchangeEncryptionConfigured(exchangeResult ? exchangeResult.encryption_configured !== false : true);
    setExchangeExceptions(exchangeExceptionResult);
    setBridgeSuggestionCount(bridgeResult ? (bridgeResult.summary?.suggestions || 0) : null);
    const reviewDecisions = counterpartyResult && exchangeExceptionResult
      ? (counterpartyResult.summary?.count || 0) + (exchangeExceptionResult?.summary?.count || 0)
      : null;
    onAttentionChange?.({ reviewDecisions });
    setManageLoaded(true);
  }, [onAttentionChange]);

  // A management action changes both halves -- labelling an address rewrites
  // the ledger behind it, ignoring a token drops holdings -- so both refetch.
  const handleManageChanged = useCallback(async () => {
    await Promise.all([fetchData(), fetchManageData()]);
    // The ledger and the transfer feed are keyed on this: a label write
    // reclassifies rows they are already showing.
    setSyncNonce((nonce) => nonce + 1);
  }, [fetchData, fetchManageData]);

  // Ledger actions re-derive both the visible feed and the hidden page copy.
  // Keep management queues in sync only after they have been loaded; Activity
  // should not pay for six management requests just because it has a label
  // button.
  const handleLedgerChanged = useCallback(async () => {
    await fetchData();
    if (manageLoaded) await fetchManageData();
    setSyncNonce((nonce) => nonce + 1);
  }, [fetchData, fetchManageData, manageLoaded]);

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
    () => cryptoAccounts.filter((account) => !account.eth_wallet_id && !account.exchange_account_id),
    [cryptoAccounts]
  );
  const cryptoHistory = useMemo(
    () => historyRows.filter((row) => cryptoAccountIds.has(row.account_id)),
    [historyRows, cryptoAccountIds]
  );
  const cryptoTotalHistory = useMemo(() => totalSeries(cryptoHistory), [cryptoHistory]);
  const thirtyDayChange = useMemo(() => changeOverDays(cryptoTotalHistory, 30), [cryptoTotalHistory]);

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

  // Six "Metamask" wallets are one name six times in a picker; the short
  // address tells them apart where a name is shared.
  const pickerWalletLabel = (wallet) => {
    const name = walletLabel(wallet);
    const shared = wallets.filter((other) => walletLabel(other) === name).length > 1;
    return shared ? `${name} · ${shortEthAddress(wallet.address)}` : name;
  };

  const walletNames = useMemo(
    () => new Map(wallets.map((wallet) => [wallet.id, walletLabel(wallet)])),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [wallets, accountDisplayNames]
  );

  const erroredWallets = useMemo(() => wallets.filter(isWalletSyncFailure), [wallets]);
  const duplicateHints = useMemo(() => possibleDuplicates(cryptoHoldings), [cryptoHoldings]);
  const walletValues = useMemo(() => {
    const totals = new Map();
    for (const holding of cryptoHoldings) {
      totals.set(holding.account_id, (totals.get(holding.account_id) || 0) + getHoldingValue(holding));
    }
    return totals;
  }, [cryptoHoldings]);
  // Dust off by default: a hundred-odd positions are mostly airdropped cents,
  // and the hidden count says how many are folded away.
  const [holdingsView, setHoldingsView] = useState('asset');
  const [hideDust, setHideDust] = useState(true);
  const visibleHoldings = useMemo(
    () => (hideDust ? cryptoHoldings.filter((holding) => !isDust(holding)) : cryptoHoldings),
    [cryptoHoldings, hideDust]
  );
  const assetGroups = useMemo(() => groupHoldingsByAsset(cryptoHoldings), [cryptoHoldings]);
  // The donut's slices: the seven largest assets and one "Other".
  // Slices under 1% fold into Other too: a sliver that reads 0.0% is noise.
  const allocationItems = useMemo(() => {
    const total = assetGroups.reduce((sum, group) => sum + group.value, 0);
    const shown = assetGroups.slice(0, 7).filter((group) => total > 0 && group.value / total >= 0.01);
    const top = shown.map((group) => ({
      account_id: group.key, account: group.ticker || group.display, value: group.value,
    }));
    const rest = total - shown.reduce((sum, group) => sum + group.value, 0);
    return rest > 0.005 ? [...top, { account_id: 'other', account: 'Other', value: rest }] : top;
  }, [assetGroups]);
  const deferredWallets = useMemo(
    () => wallets.filter((wallet) => wallet.error_code === 'SYNC_DEFERRED'),
    [wallets]
  );

  // Material only, deliberately. A badge that cannot reach zero -- because a
  // single airdrop wave parked 40 dust counterparties behind it -- teaches the
  // user to ignore the badge.
  const exchangeExceptionAttentionCount = exchangeExceptions?.summary?.count || 0;
  // The Review page's queues. Spam and bridges are informational counts: the
  // spam list is already handled, and a bridge waiting for a pairing is also a
  // flagged transaction, so neither adds to the sidebar badge.
  const reviewQueues = [
    { id: 'transactions', label: 'Transactions', count: ledgerSummaryState === 'ready' ? (ledgerSummary?.needs_review_count || 0) : null },
    { id: 'counterparties', label: 'Addresses', count: manageLoaded && counterpartyData ? (counterpartyData.summary?.count || 0) : null },
    { id: 'exchange', label: 'Exchange balances', count: manageLoaded && exchangeExceptions ? exchangeExceptionAttentionCount : null },
    { id: 'bridges', label: 'Bridges', count: bridgeSuggestionCount, quiet: true },
    { id: 'spam', label: 'Spam', count: manageLoaded && spamActivity ? (spamActivity.summary?.spam_count || 0) : null, quiet: true },
  ];
  // The Overview's "Needs attention": each line routes to where it is fixed.
  const staleExchangeAccounts = new Set(cryptoHoldings
    .filter((holding) => holding.account_exchange_account_id && holding.exchange_balance_stale)
    .map((holding) => holding.account_exchange_account_id));
  const attentionItems = [
    { key: 'review', count: ledgerSummary?.needs_review_count || 0, text: 'transactions need review', singular: 'transaction needs review', page: REVIEW_TAB },
    { key: 'failed', count: erroredWallets.length, text: 'wallets failed their last sync', singular: 'wallet failed its last sync', tone: 'loss', page: WALLETS_TAB },
    {
      key: 'drift',
      count: wallets.filter((wallet) => wallet.reconciliation?.needs_review).length,
      text: "wallets' history does not add up to their blockchain balance",
      singular: "wallet's history does not add up to its blockchain balance",
      tone: 'loss',
      page: WALLETS_TAB,
    },
    { key: 'stale', count: staleExchangeAccounts.size, text: 'exchange balances are out of date', singular: 'exchange balance is out of date', page: EXCHANGES_TAB },
    { key: 'unpriced', count: ledgerSummary?.unpriced_count || 0, text: 'wallet transactions have no USD value', singular: 'wallet transaction has no USD value', page: TRANSACTIONS_TAB },
    { key: 'duplicates', count: duplicateHints.size, text: 'manual holdings may duplicate a synced balance', singular: 'manual holding may duplicate a synced balance', page: HOLDINGS_TAB },
  ];

  // Opens on the first queue with something in it, once the counts are known;
  // after that the user's choice stands.
  const firstNonEmptyQueue = reviewQueues.find((queue) => !queue.quiet && queue.count > 0)?.id;
  const reviewCountsKnown = reviewQueues.filter((queue) => !queue.quiet).every((queue) => queue.count != null);
  const activeReviewQueue = reviewQueue
    || (reviewCountsKnown ? firstNonEmptyQueue || 'transactions' : 'transactions');

  // Typeahead for the triage form keeps every exchange name, builtins included.
  const exchangeNameOptions = useMemo(
    () => [...new Set(addressLabels.filter((l) => !l.kind || l.kind === 'exchange').map((l) => l.name))],
    [addressLabels]
  );

  // Falls back to Overview for an unknown tab. Everything downstream reads
  // activeTab, never the raw tab prop.
  //
  // These three hooks MUST stay above the `if (loading)` return below: hooks
  // declared after an early return run on some renders and not others, which
  // React rejects outright ("rendered more hooks than during the previous
  // render") the moment loading flips false.
  // The ledger spans wallets AND exchange accounts. Activity remains a valid
  // empty page so a saved URL never opens with a different sidebar item active.
  const hasLedger = wallets.length > 0 || (ledgerSummary?.total || 0) > 0;
  const isEmpty = wallets.length === 0
    && !walletsLoadFailed
    && !loadError
    && cryptoAccounts.length === 0
    && !hasLedger
    && ledgerSummaryState !== 'error';

  // Discovery used to be a separate tab. Its old URL now lands on Wallets,
  // while every unknown Crypto page fails safely to Overview.
  const requestedTab = tab === DISCOVERY_ALIAS ? WALLETS_TAB : tab;
  const activeTab = CRYPTO_TAB_IDS.includes(requestedTab)
    ? requestedTab
    : OVERVIEW_TAB;
  // Set by cross-page actions such as the Overview empty state and the
  // failed-sync banner. Sidebar navigation itself is owned by App.
  const goToTab = (id) => onTabChange?.(id);

  // The Activity picker lists exchange accounts too. Read once when Activity
  // first opens (the ledger reads the same list, and the two share one
  // request); once the management lists have loaded, theirs is the fresher.
  const pickerRequestedRef = useRef(false);
  useEffect(() => {
    if (activeTab !== TRANSACTIONS_TAB || manageLoaded || pickerRequestedRef.current) return;
    pickerRequestedRef.current = true;
    Promise.resolve().then(() => exchangesAPI.getAll())
      .then((result) => setPickerExchangeAccounts(result?.accounts || []))
      .catch(() => {});
  }, [activeTab, manageLoaded]);
  const activityExchangeAccounts = manageLoaded ? exchangeAccounts : pickerExchangeAccounts;

  // Page bodies are hidden with CSS, never unmounted: unmounting OnChainActivity
  // would throw away its accumulated Load More pages, transfer-type filter and
  // label cache on every page hop. The Set still defers each body's FIRST mount,
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
      const result = await ethAPI.syncWallet(walletId);
      await fetchData();
      setSyncNonce((nonce) => nonce + 1);
      if (result.sync?.status === 'failed') {
        setError('Wallet sync finished, but some networks could not be read. Open Wallets for details.');
      } else if (result.sync?.status === 'deferred') {
        showNotice('Sync paused: the blockchain data provider is limiting requests. Try again later; the nightly sync also retries on its own.');
      } else if (result.sync?.status === 'unsupported') {
        showNotice('Wallet synced. Some networks are only partly covered by the data provider.');
      } else {
        showSuccess('Wallet synced');
      }
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
    const deferred = [];
    const limited = [];
    for (const wallet of wallets) {
      try {
        const result = await ethAPI.syncWallet(wallet.id);
        if (result.sync?.status === 'failed') failed.push(walletLabel(wallet));
        else if (result.sync?.status === 'deferred') deferred.push(walletLabel(wallet));
        else if (result.sync?.status === 'unsupported') limited.push(walletLabel(wallet));
      } catch {
        failed.push(walletLabel(wallet));
      }
    }
    await fetchData();
    setSyncNonce((nonce) => nonce + 1);
    setSyncingWalletId(null);
    if (failed.length) {
      setError(`${failed.length} of ${wallets.length} wallets failed to sync: ${failed.join(', ')}`);
    } else if (deferred.length) {
      showNotice(`${deferred.length} of ${wallets.length} wallets paused: the blockchain data provider is limiting requests. Try again later; the nightly sync also retries on its own.`);
    } else if (limited.length) {
      showNotice(`Wallets synced. ${limited.length} have networks the data provider only partly covers; see Coverage on the Wallets page.`);
    } else {
      showSuccess('Wallets synced');
    }
  };

  const handleSyncClick = () => (
    selectedWalletId == null ? handleSyncAll() : handleSync(selectedWalletId)
  );

  const handleEdit = (holding) => {
    if (isSyncManaged(holding)) return;
    setEditingHolding(holding);
    setIsFormOpen(true);
  };

  // A synced holding opens where it comes from (its wallet, or its exchange
  // account); only a manual one opens the edit form.
  const openHolding = (holding) => {
    if (holding.account_eth_wallet_id) { goToTab(WALLETS_TAB); return; }
    if (holding.account_exchange_account_id) {
      setExchangeFocusAccountId(holding.account_exchange_account_id);
      goToTab(EXCHANGES_TAB);
      return;
    }
    handleEdit(holding);
  };

  const holdingChips = (holding) => (
    <>
      {holding.account_eth_wallet_id && <EthWalletBadge />}
      {holding.account_exchange_account_id && holding.current_value == null && holding.manual_value == null && (
        <span className="text-caption text-tertiary">Unpriced</span>
      )}
      {holding.account_exchange_account_id && (
        <span className={`text-caption ${holding.exchange_balance_stale ? 'text-loss' : 'text-tertiary'}`}
          title={`Exchange balance observed ${formatRelativeTime(holding.exchange_balance_as_of)}`}>
          {holding.exchange_balance_stale ? 'Exchange · stale' : 'Exchange'}
        </span>
      )}
      {duplicateHints.has(holding.id) && (
        <span
          className="rounded border border-orange-500/30 bg-orange-500/10 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide text-orange-400"
          title="The same quantity is already counted in a synced balance. If these are the same coins, remove this manual holding so they are not counted twice."
        >
          Same as {duplicateHints.get(holding.id).map((match) => displayAccountName(accountsMap.get(match.account_id))).join(', ')}
        </span>
      )}
    </>
  );

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
      cell: ({ row, getValue }) => {
        const { base, network } = splitNetworkSuffix(getValue());
        return (
          <div className="flex min-w-0 items-center gap-2">
            <span className="truncate text-body-sm font-semibold text-primary" title={getValue()}>{base}</span>
            {network && <NetworkChip name={network} />}
            {holdingChips(row.original)}
          </div>
        );
      },
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  ], [accountsMap, accountDisplayNames, duplicateHints]);

  const table = useReactTable({
    data: visibleHoldings,
    columns,
    state: { sorting, pagination },
    onSortingChange: setSorting,
    onPaginationChange: setPagination,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getPaginationRowModel: getPaginationRowModel(),
  });

  // Only the pages built from the portfolio read wait for it. Exchanges,
  // Review and Labels have their own data and loading states, and holding them
  // behind a page-wide spinner made the slowest read gate every page.
  if (loading && [OVERVIEW_TAB, HOLDINGS_TAB].includes(activeTab)) {
    return <LoadingState label="Loading Crypto" />;
  }

  const pageMeta = PAGE_META[activeTab];

  // Body wrapper: mounted once visited, then hidden rather than unmounted.
  const tabBody = (id, children) => (
    mountedTabs.has(id) ? (
      <div className={activeTab === id ? 'space-y-10' : 'hidden'}>{children}</div>
    ) : null
  );

  return (
    <div className="mx-auto w-full max-w-[1240px] px-3 py-6 sm:px-4 md:py-8">
      <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
        {activeTab === OVERVIEW_TAB ? (
          <div>
            <p className="mb-0.5 text-caption uppercase tracking-wide text-tertiary">Crypto Overview</p>
            <h1 className="font-money text-display-lg text-primary">
              {formatCurrency(totalCryptoValue)}
            </h1>
            {thirtyDayChange && (
              <p className={`font-money text-body-sm font-semibold ${thirtyDayChange.change >= 0 ? 'text-gain' : 'text-loss'}`}
                title={`From the nightly snapshot of ${formatDateDisplay(thirtyDayChange.since)}`}>
                {thirtyDayChange.change >= 0 ? '+' : '−'}{formatCurrency(Math.abs(thirtyDayChange.change))}
                {' '}({formatPercent(thirtyDayChange.percent, 1)}) in 30 days
              </p>
            )}
            <p className="text-body-sm text-tertiary">
              Across {wallets.length} {wallets.length === 1 ? 'wallet' : 'wallets'} · {cryptoAccounts.length} {cryptoAccounts.length === 1 ? 'account' : 'accounts'}
              {wallets.length > 0 && (lastSyncedAt ? ` · Synced ${formatRelativeTime(lastSyncedAt)}` : ' · Never synced')}
            </p>
          </div>
        ) : (
          <div className="max-w-3xl">
            <p className="mb-0.5 text-caption uppercase tracking-wide text-tertiary">Crypto</p>
            <h1 className="text-display-lg font-semibold text-primary">{pageMeta.title}</h1>
            <p className="mt-1 text-body-sm text-tertiary">{pageMeta.description}</p>
          </div>
        )}

        {activeTab === OVERVIEW_TAB && (
          <SummaryStats stats={[
            { label: 'ETH', value: formatEthQuantity(ethQuantity), valueClassName: 'font-money font-semibold text-accent' },
            { label: 'Positions', value: cryptoHoldings.length },
          ]} />
        )}
        {activeTab === HOLDINGS_TAB && (
          <SummaryStats stats={[
            { label: 'Value', value: formatCurrency(totalCryptoValue), valueClassName: 'font-money font-semibold text-accent' },
            { label: 'Positions', value: cryptoHoldings.length },
          ]} />
        )}
      </div>

      {successMessage && (
        <div role="status" className="mb-4 border border-gain/20 bg-gain-bg p-3 text-body-sm text-gain">
          {successMessage}
        </div>
      )}
      {noticeMessage && (
        <div role="status" className="mb-4 border border-amber-500/30 bg-amber-500/10 p-3 text-body-sm text-amber-300">
          {noticeMessage}
        </div>
      )}
      {error && (
        <div role="alert" className="mb-4 border border-loss/30 bg-loss-bg p-3 text-body-sm text-loss">
          {error}
        </div>
      )}
      {loadError && (
        <div className="mb-4">
          <LoadFailed message={loadError} onRetry={fetchData} />
        </div>
      )}

      <>
          {/* After a failed portfolio read the Overview says nothing at all
              rather than "Nothing needs your attention" over empty data. */}
          {tabBody(OVERVIEW_TAB, loadError ? null : isEmpty ? (
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
              <div className="grid gap-4 lg:grid-cols-2">
                <AttentionList items={attentionItems} onNavigate={goToTab} />
                <HeldWhere totals={valueBySource(cryptoHoldings)} />
              </div>

              <div className="grid gap-4 lg:grid-cols-2">
                <div className="card">
                  <AllocationDonut items={allocationItems} title="By asset" compact mobileBar />
                </div>
                <StakingIncomeCard
                  refreshKey={syncNonce}
                  onOpenActivity={() => {
                    setLedgerCategoryRequest({ category: 'staking_reward', nonce: Date.now() });
                    setTxView(LEDGER_VIEW);
                    goToTab(TRANSACTIONS_TAB);
                  }}
                />
              </div>

              {cryptoHistory.length > 0 ? (
                <section>
                  <div className="flex items-center gap-2 mb-4">
                    <Activity className="text-accent w-4 h-4" />
                    <h2 className="text-xs font-bold uppercase tracking-wide text-secondary">Value History</h2>
                  </div>
                  <AccountHistoryChart
                    accountData={cryptoHistory}
                    portfolioData={cryptoTotalHistory}
                    accounts={cryptoAccounts}
                    selectedAccounts={[...cryptoAccountIds]}
                    showPortfolio
                    portfolioLabel="All crypto"
                    portfolioSummaryLabel="Ending value"
                    defaultMode="value"
                    hideAccountsInitially
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
              <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
                <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
                  <SegmentedControl
                    label="View"
                    value={holdingsView}
                    onChange={setHoldingsView}
                    options={[
                      { value: 'asset', label: 'By asset' },
                      { value: 'account', label: 'By account' },
                    ]}
                  />
                  <label className="flex items-center gap-2 text-caption text-secondary">
                    <input
                      type="checkbox"
                      checked={hideDust}
                      onChange={(event) => setHideDust(event.target.checked)}
                      className="h-4 w-4 accent-accent"
                    />
                    Hide under $1
                    {hideDust && cryptoHoldings.length > visibleHoldings.length && (
                      <span className="text-tertiary">({(cryptoHoldings.length - visibleHoldings.length).toLocaleString()} hidden)</span>
                    )}
                  </label>
                </div>
                {/* The only route to holdingsAPI.create on this page. Hidden
                    when there is no manual crypto account to add to -- the
                    form's account select would open empty. */}
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

              {holdingsView === 'asset' ? (
                <HoldingsByAsset
                  groups={hideDust ? assetGroups.filter((group) => !group.holdings.every(isDust)) : assetGroups}
                  accountName={(holding) => displayAccountName(accountsMap.get(holding.account_id))}
                  renderHoldingChips={holdingChips}
                  onOpenHolding={openHolding}
                />
              ) : (
                <>
                  <DataTable
                    table={table}
                    emptyMessage="No crypto holdings found."
                    onRowClick={openHolding}
                    rowClassName={() => 'cursor-pointer'}
                    mobile="rows"
                    renderMobileRow={(row) => {
                      const holding = row.original;
                      return (
                        <button
                          key={row.id}
                          type="button"
                          onClick={() => openHolding(holding)}
                          className="block w-full p-3 text-left hover:bg-surface-2"
                        >
                          <div className="flex items-start justify-between">
                            <div className="min-w-0 flex-1">
                              <p className="truncate text-body-sm font-semibold text-primary">{splitNetworkSuffix(holding.name).base}</p>
                              <p className="truncate text-caption text-tertiary">
                                {displayAccountName(accountsMap.get(holding.account_id))}
                                {holding.ticker ? ` / ${holding.ticker}` : ''}
                                {splitNetworkSuffix(holding.name).network ? ` · ${splitNetworkSuffix(holding.name).network}` : ''}
                              </p>
                            </div>
                            <p className="value-emphasis shrink-0 pl-3">{formatCurrency(getHoldingValue(holding))}</p>
                          </div>
                        </button>
                      );
                    }}
                  />
                  <DataTablePagination table={table} total={visibleHoldings.length} />
                </>
              )}
            </section>
          ))}

          {tabBody(TRANSACTIONS_TAB, loading ? <LoadingState label="Loading activity" /> : (
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
                      value={selectedWalletId != null ? `w:${selectedWalletId}`
                        : selectedExchangeAccountId != null ? `x:${selectedExchangeAccountId}` : ''}
                      onChange={(event) => {
                        const [kind, id] = event.target.value.split(':');
                        setSelectedWalletId(kind === 'w' ? Number(id) : null);
                        setSelectedExchangeAccountId(kind === 'x' ? Number(id) : null);
                      }}
                      aria-label="Wallet or exchange account"
                      className="h-9 w-full min-w-0 border border-border bg-surface px-2 text-body-sm text-primary sm:w-[280px]"
                    >
                      <option value="">
                        All ({wallets.length} {wallets.length === 1 ? 'wallet' : 'wallets'}
                        {activityExchangeAccounts.length ? `, ${activityExchangeAccounts.length} exchange accounts` : ''})
                      </option>
                      <optgroup label="Wallets">
                        {wallets.map((wallet) => (
                          <option key={wallet.id} value={`w:${wallet.id}`}>{pickerWalletLabel(wallet)}</option>
                        ))}
                      </optgroup>
                      {activityExchangeAccounts.length > 0 && (
                        <optgroup label="Exchange accounts">
                          {activityExchangeAccounts.map((account) => (
                            <option key={account.id} value={`x:${account.id}`}>{account.name}</option>
                          ))}
                        </optgroup>
                      )}
                    </select>
                  </label>
                )}
                {wallets.length > 0 && selectedExchangeAccountId == null && (
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
              {deferredWallets.length > 0 && (
                <div className="mb-4 flex flex-wrap items-center gap-2 border border-accent/20 bg-accent/5 p-2 text-body-sm text-accent">
                  <AlertTriangle size={14} className="shrink-0" />
                  <span>
                    {deferredWallets.length} {deferredWallets.length === 1 ? 'wallet is' : 'wallets are'} waiting for an explorer cooldown.
                  </span>
                  <button
                    onClick={() => goToTab(WALLETS_TAB)}
                    className="underline hover:text-primary"
                  >
                    View details
                  </button>
                </div>
              )}

              <div className="mb-4">
                {/* The raw transfer legs are a drill-down with their own Back
                    button, not a third ledger: neither option is lit there. */}
                <SegmentedControl label="Ledger" value={txView}
                  onChange={setTxView} options={[
                    { value: LEDGER_VIEW, label: 'All crypto activity' },
                    { value: 'eth', label: 'ETH running balance' },
                  ]} />
              </div>
              {txView === 'eth' ? (
                <EthLedger key={`${selectedWalletId ?? 'all'}:${syncNonce}`} walletId={selectedWalletId} />
              ) : txView === LEDGER_VIEW ? (
                <CryptoLedger
                  walletId={selectedWalletId}
                  exchangeAccountId={selectedExchangeAccountId}
                  counterparty={ledgerCounterparty}
                  onClearCounterparty={() => setLedgerCounterparty(null)}
                  categoryRequest={ledgerCategoryRequest}
                  onCategoryRequestApplied={clearLedgerCategoryRequest}
                  onNavigate={goToTab}
                  refreshKey={syncNonce}
                  addressNotes={addressNotes}
                  onDataChanged={handleLedgerChanged}
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
                      Each individual transfer as the blockchain recorded it, behind the events in
                      Activity. Spam tokens can be ignored from here.
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
                    onDataChanged={handleLedgerChanged}
                  />
                </>
              )}
            </section>
          ))}

          {tabBody(WALLETS_TAB, loading ? <LoadingState label="Loading wallets" /> : (
            <>
              <WalletsPanel
                wallets={wallets}
                loadFailed={walletsLoadFailed}
                onRetry={fetchData}
                walletValues={walletValues}
                onRefreshWallets={refreshWallets}
                onViewActivity={(walletId) => {
                  setSelectedWalletId(walletId);
                  setSelectedExchangeAccountId(null);
                  setLedgerCounterparty(null);
                  setTxView(LEDGER_VIEW);
                  goToTab(TRANSACTIONS_TAB);
                }}
                onChanged={handleManageChanged}
                onError={setError}
                showSuccess={showSuccess}
                showNotice={showNotice}
              />
              <DiscoveryPanel
                onChanged={handleManageChanged}
                onError={setError}
                showSuccess={showSuccess}
              />
            </>
          ))}

          {tabBody(EXCHANGES_TAB, !manageLoaded ? <LoadingState label="Loading exchanges" /> : (
            <ExchangesPanel
              accounts={exchangeAccounts}
              loadFailed={exchangeLoadFailed}
              credentialFields={credentialFields}
              encryptionConfigured={exchangeEncryptionConfigured}
              onChanged={handleManageChanged}
              onError={setError}
              showSuccess={showSuccess}
              onRetry={fetchManageData}
              focusAccountId={exchangeFocusAccountId}
            />
          ))}

          {tabBody(REVIEW_TAB, (
            <>
              <FilterTabs
                id="crypto-review-queue"
                label="Review queue"
                value={activeReviewQueue}
                onChange={setReviewQueue}
                options={reviewQueues.map((queue) => ({
                  value: queue.id,
                  label: queue.label,
                  selectLabel: queue.count == null ? queue.label : `${queue.label} (${queue.count})`,
                  badge: queue.count == null ? null : (
                    <span className={`ml-2 rounded px-1.5 py-0.5 font-mono text-[10px] ${
                      queue.count > 0 && !queue.quiet ? 'bg-orange-500/15 text-orange-400' : 'bg-surface-3 text-tertiary'
                    }`}>
                      {queue.count.toLocaleString()}
                    </span>
                  ),
                }))}
              />
              {activeReviewQueue === 'transactions' && (
                <TransactionQueue
                  refreshKey={syncNonce}
                  addressNotes={addressNotes}
                  exchangeNameOptions={exchangeNameOptions}
                  onDataChanged={handleLedgerChanged}
                  onError={setError}
                  showSuccess={showSuccess}
                  onOpenExchanges={() => onTabChange?.(EXCHANGES_TAB)}
                  onOpenBridges={() => setReviewQueue('bridges')}
                />
              )}
              {activeReviewQueue === 'bridges' && (
                <BridgeEvidencePanel
                  refreshKey={syncNonce}
                  onChanged={handleLedgerChanged}
                  onError={setError}
                  onCountChange={setBridgeSuggestionCount}
                />
              )}
              {['counterparties', 'exchange', 'spam'].includes(activeReviewQueue) && (
                /* Waits for the wallet read too: hasWallets decides which queues exist. */
                !manageLoaded || loading ? <LoadingState label="Loading review queues" className="min-h-[160px]" /> : (
                  <ReviewPanel
                    section={activeReviewQueue}
                    counterpartyData={counterpartyData && {
                      ...counterpartyData,
                      data: (counterpartyData.data || []).map((counterparty) => ({
                        ...counterparty,
                        note: addressNotes.find((item) => item.address === counterparty.address)?.note || '',
                      })),
                    }}
                    spamActivity={spamActivity}
                    onSpamPageLoaded={(next) => { spamPagesRef.current += 1; setSpamActivity(next); }}
                    exchangeNameOptions={exchangeNameOptions}
                    hasWallets={wallets.length > 0}
                    onChanged={handleManageChanged}
                    onError={setError}
                    showSuccess={showSuccess}
                    onRetry={fetchManageData}
                    exchangeExceptions={exchangeExceptions}
                    exchangeExceptionsError={exchangeExceptions === null
                      ? 'Couldn\'t load the exchange balance review queue.'
                      : null}
                    onOpenExchanges={(accountId) => {
                      setExchangeFocusAccountId(accountId);
                      onTabChange?.(EXCHANGES_TAB);
                    }}
                    onViewTransactions={(address) => {
                      setLedgerCounterparty(address);
                      setSelectedWalletId(null);
                      setSelectedExchangeAccountId(null);
                      setTxView(LEDGER_VIEW);
                      goToTab(TRANSACTIONS_TAB);
                    }}
                  />
                )
              )}
            </>
          ))}

          {tabBody(LABELS_TAB, !manageLoaded ? <LoadingState label="Loading labels" /> : (
            <LabelsPanel
              addressLabels={addressLabels}
              labelsLoadFailed={labelsLoadFailed}
              ignoredLoadFailed={ignoredLoadFailed}
              onRetry={fetchManageData}
              addressNotes={addressNotes}
              exchangeAccounts={exchangeAccounts}
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

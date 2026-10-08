import React, { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { useReactTable, getCoreRowModel } from '@tanstack/react-table';
import {
  AlertTriangle, Check, ChevronDown, ChevronRight, DollarSign, Download,
  ExternalLink, Landmark, Link2, Pencil, RefreshCw, Search, ShieldAlert, Tag, Undo2,
  Wallet, X,
} from 'lucide-react';
import { crypto as cryptoAPI, eth as ethAPI, exchanges as exchangesAPI } from '../utils/api';
import {
  formatDateDisplay, formatTokenUnits, formatUsdAtTime, shortEthAddress,
} from '../utils/format';
import { useMediaQuery } from '../hooks/useMediaQuery';
import { explorerTxUrl, explorerAddressUrl, nativeSymbol } from '../utils/chains';
import { describeExchangeMatchEvidence } from '../utils/exchangeMatchEvidence';
import {
  ledgerCategories,
  onchainOverrideCategories,
  formatLedgerCategory,
  spamReasonLabel,
} from '../utils/dataLabels';
import DataTable from './DataTable';
import LoadingState from './LoadingState';
import SegmentedControl from './SegmentedControl';
import { MATCH_METHOD_TEXT, humanize } from '../features/crypto/plainText';
import { describeHopPair, hopPairEvidence } from '../features/crypto/bridgeText';
import CounterpartyVerdictForm from '../features/crypto/CounterpartyVerdictForm';
import { describeLegs, enrichLedgerRow, formatCapped } from '../features/crypto/ledgerRows';

const PAGE_SIZE = 100;
// GET /api/crypto/ledger clamps `limit` to 500, and asking past it is a 400.
const MAX_PAGE_SIZE = 500;

// Review status is THE workflow dimension -- the one a user flips while
// draining the queue -- so it gets the one prominent segmented control.
// Source is a rare flip and Category has twenty values; both are labeled
// selects. Underline tabs are reserved for the page navigation above: three
// unlabeled strips that all read "ALL ..." was three competing navigations.
const STATUS_OPTIONS = [
  { value: '', label: 'Everything' },
  { value: 'true', label: 'Needs review' },
  { value: 'false', label: 'Explained' },
];

const SOURCE_OPTIONS = [
  { value: '', label: 'All' },
  { value: 'onchain', label: 'Wallets' },
  { value: 'exchange', label: 'Exchanges' },
];

// Tone by what the category MEANS for the portfolio, not one colour per value:
// money leaving, money arriving, a move between the user's own places, and the
// ones that are only an explanation.
const CATEGORY_TONES = {
  self_transfer: 'accent',
  exchange_deposit: 'transfer',
  exchange_withdrawal: 'transfer',
  exchange_transfer: 'transfer',
  bridge_out: 'transfer',
  bridge_in: 'transfer',
  exchange_trade: 'trade',
  swap: 'trade',
  nft_purchase: 'trade',
  nft_sale: 'trade',
  staking_reward: 'gain',
  airdrop: 'gain',
  receive: 'gain',
  nft_mint: 'neutral',
  nft_burn: 'neutral',
  approval: 'neutral',
  contract_interaction: 'neutral',
  send: 'loss',
  spend: 'loss',
  fee: 'loss',
  failed: 'failed',
};

const TONE_STYLES = {
  accent: 'bg-accent/10 text-accent border-accent/20',
  transfer: 'bg-teal-500/10 text-teal-400 border-teal-500/20',
  trade: 'bg-blue-500/10 text-blue-400 border-blue-500/20',
  gain: 'bg-gain/10 text-gain border-gain/20',
  loss: 'bg-loss/10 text-loss border-loss/20',
  failed: 'bg-loss/20 text-loss border-loss/30',
  neutral: 'bg-surface-3 text-tertiary border-border',
};

const categoryChipClass = (category) => TONE_STYLES[CATEGORY_TONES[category] || 'neutral'];

const bridgeVerificationLabel = (match) => {
  if (match?.verification_method === 'protocol_identity') return 'Protocol verified';
  if (match?.verification_method === 'user_verdict') return 'User confirmed';
  return 'Bridged';
};


// At-the-time dollars, or an explicit gap. A blank cell would read as $0, which
// is the one thing an unpriced asset is NOT -- so an unpriced row says so, and
// a carried price says it was carried.
const USD_BASIS_NOTE = {
  exact: null,
  carried: 'Priced from the nearest earlier close, not this exact date',
  unpriced: 'No price for this asset on this date — not zero',
  not_applicable: 'No dollar value applies to this row',
};

const describeBridgeFees = (match) => {
  const assets = Array.isArray(match?.assets) && match.assets.length
    ? match.assets
    : [{ asset: match?.asset, fee_amount: match?.fee_amount }];
  const fees = assets
    .filter((entry) => entry.fee_amount && Number.parseFloat(entry.fee_amount) !== 0)
    .map((entry) => `${entry.fee_amount} ${entry.asset}`);
  return fees.join(' + ');
};

// Hop's protocol identity is a hash over the source event fields, while the
// movement evidence also records the gross amount, bonder fee, and exact net
// amount accepted from the destination receipt. Keep those raw units visible:
// the bridge registry does not guess token decimals, and a rounded display
// would make the identity audit less useful than the underlying evidence.
const describeBridgeSource = (member) => {
  const amount = member?.out_amount != null ? `${member.out_amount} ${member.asset || ''}`.trim() : null;
  return amount || member?.tx_hash || 'Source transaction';
};

// How #61 decided this pairing, in the user's words. The evidence IS the reason
// to trust or reject it, so it is shown rather than hidden behind a confidence
// score nobody can interpret.
const MATCH_METHOD_NOTE = MATCH_METHOD_TEXT;

// Most review reasons arrive as prose; a few are stored as codes the server
// reads back (the unavailable-records marker is how the matcher finds its own
// writes), so they are put into words here rather than renamed there.
const REVIEW_REASON_TEXT = {
  exchange_records_unavailable:
    'Exchange custody: this exchange account is marked as having no recoverable records, so its side of the movement cannot be shown.',
};

const Chip = ({ className = '', children, title }) => (
  <span
    title={title}
    className={`inline-flex shrink-0 items-center gap-1 border px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide ${className}`}
  >
    {children}
  </span>
);

const DetailField = ({ label, children }) => (
  <div className="min-w-0">
    <p className="text-[9px] font-bold uppercase tracking-wide text-tertiary">{label}</p>
    <div className="mt-0.5 break-words text-body-sm text-secondary">{children}</div>
  </div>
);

// The unified crypto ledger: one chronological stream over eth_activity and
// exchange_records, with the review workflow that drains "needs review" to
// zero. A matched pair (an exchange record carrying the hash of a transaction
// one of the user's wallets also saw) is folded server-side and rendered once.
//
// `walletId` narrows to one wallet, which necessarily excludes every exchange
// row -- those genuinely do not belong to a wallet.
//
// `onDataChanged` fires after a mutation that re-derives data the parent also
// renders: labelling an address rewrites the mirrored transactions and every
// classification downstream of it.
//
// `onShowTransferLegs` swaps the parent to the raw per-leg feed. A quiet link
// on the filter bar rather than a sibling mode toggle: the raw feed is a
// power-user drill-down (and the one place a token can be ignored in context),
// not an equal way to read the ledger.
const CryptoLedger = ({
  walletId = null,
  exchangeAccountId = null,
  // One address's transactions, set from outside (Review's "View
  // transactions"); cleared by the chip it shows.
  counterparty = null,
  onClearCounterparty,
  // { category, nonce }: open on a category chosen elsewhere (the Overview's
  // "See every reward"); the nonce makes asking twice work.
  categoryRequest = null,
  onCategoryRequestApplied,
  onNavigate,
  refreshKey = 0,
  onDataChanged,
  onShowTransferLegs,
  addressNotes = [],
  initialNeedsReview = '',
}) => {
  const [rows, setRows] = useState([]);
  const [total, setTotal] = useState(0);
  const [summary, setSummary] = useState(null);
  const [exchangeAccounts, setExchangeAccounts] = useState([]);
  const [reconciliation, setReconciliation] = useState(null);
  const [unpriced, setUnpriced] = useState([]);
  const [source, setSource] = useState('');
  const [status, setStatus] = useState(initialNeedsReview);
  const [category, setCategory] = useState('');
  const [spam, setSpam] = useState('');
  // The box holds what is typed; the feed follows it a beat later, so a hash
  // being pasted or a symbol being typed is one request, not one per key.
  const [searchText, setSearchText] = useState('');
  const [search, setSearch] = useState('');
  useEffect(() => {
    const handle = setTimeout(() => setSearch(searchText.trim()), 350);
    return () => clearTimeout(handle);
  }, [searchText]);
  // Applied once and handed back: the ledger remounts when its view toggles,
  // and a request still standing would re-filter it every time.
  useEffect(() => {
    if (!categoryRequest) return;
    setCategory(categoryRequest.category);
    setStatus('');
    setSpam('');
    onCategoryRequestApplied?.();
  }, [categoryRequest, onCategoryRequestApplied]);
  const [fromDate, setFromDate] = useState('');
  const [toDate, setToDate] = useState('');
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState(null);
  const [expandedId, setExpandedId] = useState(null);
  const addressNoteByAddress = useMemo(
    () => new Map(addressNotes.map((item) => [item.address, item.note])),
    [addressNotes]
  );
  const [reload, setReload] = useState(0);
  // The table needs lg width once the sidebar takes its share; below that the
  // stacked rows read better than a description squeezed to a few characters.
  const isMobile = useMediaQuery('(max-width: 1023px)');

  // A source picked on the all-wallets ledger does not carry into one
  // wallet's, where the control is hidden and "exchange" can match nothing.
  const effectiveSource = walletId == null && exchangeAccountId == null ? source : '';
  const filters = useMemo(() => ({
    ...(effectiveSource ? { source: effectiveSource } : {}),
    ...(category ? { category } : {}),
    ...(status ? { needsReview: status } : {}),
    // Omitted when empty, so the server's own default ('exclude') is what
    // answers -- the client never has to restate it.
    ...(spam ? { spam } : {}),
    ...(walletId != null ? { walletId } : {}),
    ...(exchangeAccountId != null ? { exchangeAccountId } : {}),
    ...(counterparty ? { counterparty } : {}),
    ...(search ? { q: search } : {}),
    ...(fromDate ? { from: fromDate } : {}),
    ...(toDate ? { to: toDate } : {}),
  }), [effectiveSource, category, status, spam, walletId, exchangeAccountId, counterparty, search, fromDate, toDate]);

  // Guards a Load More response that arrives after the filters moved on.
  const filtersRef = useRef(filters);
  useEffect(() => { filtersRef.current = filters; }, [filters]);

  // How much of the feed is on screen, so a post-action refetch can ask for the
  // SAME window rather than snapping back to page 1. Reviewing is the core loop
  // of this screen: after ten Load Mores, resolving one row and losing the
  // other nine pages (and the open detail panel with them) makes the queue feel
  // like it is refilling itself.
  const loadedRef = useRef(0);
  // A filter change is a genuinely new feed, so the window resets. Declared
  // BEFORE the loader: effects run in order, so this has already zeroed by the
  // time the fetch below reads it.
  useEffect(() => { loadedRef.current = 0; }, [filters]);
  useEffect(() => { loadedRef.current = rows.length; }, [rows]);

  // A refresh triggered by a review action must not flip the whole table back
  // to the loading state: DataTable unmounts, and the expanded row the user is
  // still working in goes with it.
  const silentRef = useRef(false);
  const refresh = useCallback(() => {
    silentRef.current = true;
    setReload((n) => n + 1);
  }, []);
  const handleRowChanged = useCallback(async () => {
    refresh();
    await onDataChanged?.();
  }, [onDataChanged, refresh]);
  // The parent answers a review action by bumping `refreshKey`, which reloads
  // this SAME feed a second time; that reload must be just as quiet, or it
  // undoes the silent one above. Only a new feed (a filter change) or a first
  // load shows the loading state.
  const loadedFiltersRef = useRef(null);

  useEffect(() => {
    let cancelled = false;
    const sameFeed = loadedFiltersRef.current === filters && loadedRef.current > 0;
    loadedFiltersRef.current = filters;
    const silent = silentRef.current || sameFeed;
    silentRef.current = false;
    const load = async () => {
      if (!silent) setLoading(true);
      setError(null);
      try {
        // Clamped to the route's own cap (500): asking for more is a 400, and
        // a review action must never be the thing that breaks the feed.
        const limit = Math.min(Math.max(loadedRef.current, PAGE_SIZE), MAX_PAGE_SIZE);
        const result = await cryptoAPI.getLedger({ ...filters, limit, offset: 0 });
        if (cancelled) return;
        setRows(result.data || []);
        setTotal(result.pagination?.total || 0);
      } catch (err) {
        if (!cancelled) setError(err.response?.data?.error || 'Failed to load the crypto ledger');
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    load();
    return () => { cancelled = true; };
  }, [filters, reload, refreshKey]);

  // Narrowed by WALLET only, and otherwise unfiltered -- so it reloads on its
  // own schedule rather than with `filters`. The view filters (category,
  // source, status) must not move the badge: a needs-review count that dropped
  // to zero because the user filtered those rows away is a badge that lies.
  // `walletId` is different in kind -- it selects which ledger this is, and the
  // header sentence sits directly above the rows it is describing.
  useEffect(() => {
    let cancelled = false;
    // The scope that picks which ledger is on screen -- a wallet or an
    // exchange account -- narrows the header and the counts with it.
    cryptoAPI.getLedgerSummary({
      ...(walletId != null ? { walletId } : {}),
      ...(exchangeAccountId != null ? { exchangeAccountId } : {}),
    })
      .then((result) => { if (!cancelled) setSummary(result.summary || null); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [reload, refreshKey, walletId, exchangeAccountId]);

  // Completeness signals. A ledger that claims to be the whole history has to
  // say when it is NOT -- otherwise "everything is explained" and "everything
  // we managed to import is explained" look identical. Three independent ways
  // it can be incomplete, each with its own source of truth:
  //
  //   the chain disagrees with the stored ledger   -> #62's balance audit
  //   an asset has no price for its date           -> #73's unpriced list
  //   a venue import is behind or did not reconcile -> the account's sync status
  useEffect(() => {
    let cancelled = false;
    Promise.all([
      exchangesAPI.getAll().catch(() => null),
      ethAPI.getReconciliation({ status: 'mismatch' }).catch(() => null),
      ethAPI.getUnpricedAssets().catch(() => null),
    ]).then(([accounts, recon, unpriced]) => {
      if (cancelled) return;
      setExchangeAccounts(accounts?.accounts || []);
      setReconciliation(recon || null);
      setUnpriced(unpriced?.data || []);
    });
    return () => { cancelled = true; };
  }, [reload, refreshKey]);

  // 'unknown' counts only where a key could have produced a balance report: a
  // CSV-only archive of a closed venue never will, and flagging it forever
  // would keep this strip up with nothing anyone can do about it.
  const incompleteAccounts = useMemo(() => exchangeAccounts.filter(
    (account) => ['mismatch', 'stale'].includes(account.reconciliation_status)
      || (account.reconciliation_status === 'unknown' && account.credentials?.configured)
      || account.last_sync_status === 'balance_mismatch'
      || account.last_sync_status === 'error'
      || account.last_sync_status === 'coverage_limited'
      || account.last_sync_status === 'reconciled_with_exceptions'
      || (account.balance_exception_count || 0) > 0
      || account.balance_report?.backfill_pending
      || account.balance_report?.balances_incomplete
      || (Array.isArray(account.balance_report?.coverage_limitations)
        && account.balance_report.coverage_limitations.length > 0)
  ), [exchangeAccounts]);

  // Native-only, matching the audit's own badge rule: a token delta has benign
  // explanations (rebasing supply, fee-on-transfer) and badging those would pin
  // a permanent number on every wallet that ever held one -- a warning that
  // cannot clear gets ignored, taking the native signal with it.
  //
  // Keyed on asset_type, not on the key being 'ETH': the native key is the
  // chain's own symbol, so an asset_key test would silently drop Polygon.
  const nativeDrift = useMemo(
    () => (reconciliation?.data || []).filter((row) => row.asset_type === 'native'),
    [reconciliation]
  );

  const loadMore = async () => {
    const at = filtersRef.current;
    setLoadingMore(true);
    try {
      const result = await cryptoAPI.getLedger({ ...at, limit: PAGE_SIZE, offset: rows.length });
      if (filtersRef.current !== at) return;
      setRows((prev) => [...prev, ...(result.data || [])]);
      setTotal(result.pagination?.total || 0);
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to load more of the ledger');
    } finally {
      setLoadingMore(false);
    }
  };

  const exportHref = cryptoAPI.ledgerExportUrl({
    source: effectiveSource || undefined,
    category: category || undefined,
    needs_review: status || undefined,
    spam: spam || undefined,
    wallet_id: walletId ?? undefined,
    exchange_account_id: exchangeAccountId ?? undefined,
    counterparty: counterparty || undefined,
    q: search || undefined,
    from: fromDate || undefined,
    to: toDate || undefined,
  });

  const enriched = useMemo(() => rows.map(enrichLedgerRow), [rows]);

  const columns = useMemo(() => [
    {
      id: 'date',
      accessorFn: (row) => row.occurred_at,
      header: 'Date',
      meta: { width: '8rem', cellClassName: 'whitespace-nowrap font-mono text-caption' },
      cell: ({ row }) => (
        <span className="flex items-center gap-1">
          {expandedId === row.original.id
            ? <ChevronDown size={11} className="shrink-0 text-accent" />
            : <ChevronRight size={11} className="shrink-0 text-tertiary" />}
          {formatDateDisplay(row.original.occurred_at)}
        </span>
      ),
    },
    {
      id: 'description',
      accessorFn: (row) => row.description,
      header: 'Description',
      meta: { cellClassName: 'min-w-0' },
      cell: ({ row }) => {
        const entry = row.original;
        return (
          <div className="flex min-w-0 items-center gap-2">
            <span className="truncate font-money text-body-sm font-semibold text-primary" title={entry.description}>
              {entry.description}
            </span>
            {entry.needs_review && (
              <Chip className="border-orange-500/30 bg-orange-500/10 text-orange-400" title={REVIEW_REASON_TEXT[entry.review_reason] || entry.review_reason || 'Flagged on import'}>
                <AlertTriangle size={9} />
                Review
              </Chip>
            )}
            {entry.is_overridden && (
              <Chip className="border-accent/20 bg-accent/10 text-accent" title={entry.override_note || 'Category set by hand'}>
                <Pencil size={9} />
                Corrected
              </Chip>
            )}
            {/* Only ever visible in the Quarantined/Include views -- the
                default feed has no spam rows in it at all. The reason rides on
                the chip because a row hidden on grounds nobody can state is
                the failure a quarantine cannot have. */}
            {entry.spam && (
              <Chip
                className="border-loss/20 bg-loss/10 text-loss"
                title={spamReasonLabel(entry.spam_reason).detail}
              >
                <ShieldAlert size={9} />
                {spamReasonLabel(entry.spam_reason).title}
              </Chip>
            )}
            {/* One movement the chains recorded twice, on two chains with two
                hashes. Shown once, hosted by the side that sent. */}
            {entry.bridge_match && (
              <Chip
                className="border-teal-500/20 bg-teal-500/10 text-teal-400"
                title={`${bridgeVerificationLabel(entry.bridge_match)}; completed on ${entry.bridge_match.chain_label || 'the far chain'}; one movement, shown once`}
              >
                <Link2 size={9} />
                {bridgeVerificationLabel(entry.bridge_match)}
              </Chip>
            )}
            {entry.exchange_match && (
              <Chip
                className={entry.exchange_match.verdict === 'confirmed'
                  ? 'border-gain/20 bg-gain/10 text-gain'
                  : 'border-teal-500/20 bg-teal-500/10 text-teal-400'}
                title={`One event recorded on both sides; shown once. ${
                  MATCH_METHOD_NOTE[entry.exchange_match.match_method] || entry.exchange_match.match_method
                }`}
              >
                <Link2 size={9} />
                {entry.exchange_match.verdict === 'confirmed' ? 'Matched ✓' : 'Matched'}
              </Chip>
            )}
            {entry.exchange_fiat_match && (
              <Chip
                className="border-accent/20 bg-accent/10 text-accent"
                title="Exchange fiat movement linked to the bank transaction imported from Plaid"
              >
                <Landmark size={9} />
                Bank linked
              </Chip>
            )}
            {/* A hash only exists on its own chain: the same lookup on the
                wrong explorer reads as "this never happened". */}
            {entry.tx_hash && entry.source === 'onchain' && (
              <a
                href={explorerTxUrl(entry.tx_hash, entry.chain_id)}
                target="_blank"
                rel="noreferrer"
                title={entry.tx_hash}
                onClick={(event) => event.stopPropagation()}
                className="shrink-0 text-tertiary transition-colors hover:text-accent"
              >
                <ExternalLink size={11} />
              </a>
            )}
          </div>
        );
      },
    },
    {
      id: 'category',
      accessorFn: (row) => row.category,
      header: 'Category',
      meta: { width: '9.5rem' },
      cell: ({ row }) => (
        <Chip className={categoryChipClass(row.original.category)}>
          {formatLedgerCategory(row.original.category)}
        </Chip>
      ),
    },
    {
      id: 'where',
      accessorFn: (row) => row.source_label || '',
      header: 'Where',
      meta: { width: '10rem' },
      // Which wallet, then which network: the network alone ("Ethereum") does
      // not say whose money moved when thirty wallets share it.
      cell: ({ row }) => {
        const entry = row.original;
        const onChain = entry.source === 'onchain';
        const primary = onChain ? entry.wallet_label || shortEthAddress(entry.wallet_address) : entry.source_label;
        return (
          <span
            className={`flex min-w-0 items-start gap-1 ${onChain ? 'text-crypto' : 'text-teal-400'}`}
            title={onChain ? `${primary} on ${entry.source_label}` : entry.source_label}
          >
            {onChain
              ? <Wallet size={10} className="mt-1 shrink-0" />
              : <Landmark size={10} className="mt-1 shrink-0" />}
            <span className="min-w-0">
              <span className="block truncate">{primary}</span>
              {onChain && <span className="block truncate text-[10px] text-tertiary">{entry.source_label}</span>}
            </span>
          </span>
        );
      },
    },
    {
      id: 'counterparty',
      accessorFn: (row) => row.counterparty,
      header: 'Counterparty',
      // Below xl the description needs the room; the row detail still names
      // the counterparty, and the mobile row never had this column.
      meta: { width: '8rem', headerClassName: 'hidden xl:table-cell', cellClassName: 'hidden truncate xl:table-cell' },
      cell: ({ row }) => (
        <span title={row.original.counterparty_address || row.original.counterparty}>
          {row.original.counterparty}
        </span>
      ),
    },
    {
      id: 'usd',
      accessorFn: (row) => row.usd_value || '',
      header: 'Value',
      meta: { width: '8rem', align: 'right', headerClassName: 'text-right', cellClassName: 'whitespace-nowrap text-right' },
      // Dollars AT THE TIME (#73), not today's price: a 2017 half-ETH send was
      // ~$150, and pricing it at today's ~$1,800 is a different transaction.
      // An unpriced row says so instead of showing a blank a reader would
      // total as zero.
      cell: ({ row }) => {
        const entry = row.original;
        // Three states, through the shared rule: a figure, "No USD value" (the
        // asset had no close that day -- unknown, not worthless), or nothing at
        // all. A sub-cent amount reads "< $0.01" rather than rounding to $0,
        // which would put a real movement in the same cell as a fake zero.
        const usd = formatUsdAtTime(entry.usd_value, entry.usd_basis);
        if (usd === null) return <span className="text-tertiary">—</span>;
        if (entry.usd_value == null) {
          return (
            <span className="text-tertiary" title={USD_BASIS_NOTE[entry.usd_basis] || undefined}>
              {usd}
            </span>
          );
        }
        return (
          <span
            className={`value-emphasis ${entry.usd_basis === 'carried' ? 'opacity-70' : ''}`}
            title={USD_BASIS_NOTE[entry.usd_basis] || undefined}
          >
            {usd}
            {entry.usd_basis === 'carried' && <span className="ml-0.5 text-tertiary">~</span>}
          </span>
        );
      },
    },
    {
      id: 'fee',
      accessorFn: (row) => row.fee_amount || '',
      header: 'Fee',
      meta: {
        // Fits "< 0.00000001 POL" whole at the 14px root (9rem did not).
        width: '10.5rem',
        align: 'right',
        headerClassName: 'hidden text-right xl:table-cell',
        cellClassName: 'hidden truncate whitespace-nowrap text-right xl:table-cell',
      },
      cell: ({ row }) => {
        const entry = row.original;
        if (!entry.fee_amount || Number.parseFloat(entry.fee_amount) === 0) {
          return <span className="text-tertiary">—</span>;
        }
        return (
          <span className="font-money text-tertiary" title={entry.usd_fee ? `${formatUsdAtTime(entry.usd_fee)} at the time` : undefined}>
            {formatCapped(entry.fee_units, entry.fee_decimals, 8) ?? entry.fee_amount} {entry.fee_asset}
          </span>
        );
      },
    },
  ], [expandedId]);

  const table = useReactTable({
    data: enriched,
    columns,
    // TanStack keys on the ARRAY INDEX by default, and every React key and
    // detail-panel identity downstream inherits that. A refetch that inserts or
    // drops one row would then hand the open panel -- which seeds its category,
    // note and label fields from props once -- another row's state, and the
    // next Save would write the correction to the wrong transaction.
    getRowId: (row) => `${row.source}:${row.row_id}`,
    // Rows arrive time-ordered from the API and page in via Load More; sorting
    // a partial page client-side would reorder only what is loaded and quietly
    // claim to be the whole ledger's order.
    enableSorting: false,
    getCoreRowModel: getCoreRowModel(),
  });

  const toggleRow = (row) => setExpandedId((current) => (current === row.id ? null : row.id));

  const rangeText = summary?.first_at && summary?.last_at
    ? `${formatDateDisplay(summary.first_at)} — ${formatDateDisplay(summary.last_at)}`
    : null;

  // Counts ride ON the segmented control, so the number and the filter are the
  // same thing -- the old "N need review" badge looked clickable and was not.
  // Wallet-scoped like the summary, and deliberately NOT view-filtered: a
  // needs-review count that dropped to zero because the user filtered those
  // rows away is a count that lies.
  const statusCounts = summary ? {
    '': summary.total ?? 0,
    true: summary.needs_review_count ?? 0,
    false: Math.max(0, (summary.total ?? 0) - (summary.needs_review_count ?? 0)),
  } : null;

  return (
    <section>
      <div className="mb-3 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-xs font-bold uppercase tracking-wide text-secondary">All activity</h2>
          <p
            className="mt-0.5 text-caption text-tertiary"
            // Why the parts do not add up to the whole: a movement both sides
            // recorded (an exchange deposit and its wallet transaction, or a
            // bridge's two ends) is one event, shown once.
            title={summary && (summary.matched_count || summary.bridge_matched_count)
              ? `${(summary.matched_count || 0).toLocaleString()} exchange and wallet pairs and ${(summary.bridge_matched_count || 0).toLocaleString()} bridge transfers are each shown once`
              : undefined}
          >
            {summary
              // "records", not "events", on the exchange side: the count is
              // RECORDS the venues wrote, folded halves included, so it is the
              // number that reconciles with each account's record count.
              ? `${summary.total.toLocaleString()} events · ${summary.onchain_count.toLocaleString()} from wallets · ${summary.exchange_count.toLocaleString()} exchange records${summary.unpriced_count ? ` · ${summary.unpriced_count.toLocaleString()} without a price` : ''}`
              : 'Loading…'}
            {rangeText ? ` · ${rangeText}` : ''}
            {/* The quarantine says how much it swallowed, always: hiding rows
                without stating the number is indistinguishable from a sync
                that never fetched them. The count IS the way into that view --
                the old three-way Spam strip ("Hidden / Quarantined / Include")
                was three answers to a question the screen never asked, with
                the default state lit up reading "HIDDEN". The spam=all mode
                stays in the API and the CSV export; it earns no control. */}
            {(summary?.spam_count > 0 || spam === 'only') && (
              <button
                type="button"
                // Entering the quarantine resets EVERY narrowing filter, and
                // the filter bar hides while inside: needs_review is MASKED
                // on quarantined rows at read time and a venue record is
                // never spam, so Show/Source/Category combinations over the
                // quarantine are empty by construction -- and the Show
                // control's counts describe the non-spam ledger, which would
                // sit lying above a twelve-row quarantine feed.
                onClick={() => {
                  if (spam === 'only') setSpam('');
                  else { setSpam('only'); setStatus(''); setSource(''); setCategory(''); }
                  setExpandedId(null);
                }}
                aria-pressed={spam === 'only'}
                title={spam === 'only'
                  ? 'Return to the ledger'
                  : 'Rows hidden as spam: address poisoning, dust and scam airdrops. Nothing was deleted.'}
                className={`ml-2 inline-flex items-center gap-1 border px-1.5 py-0.5 align-middle text-[9px] font-bold uppercase tracking-wide transition-colors ${
                  spam === 'only'
                    ? 'border-accent/40 bg-accent/10 text-accent'
                    : 'border-border bg-surface-3 text-tertiary hover:border-accent hover:text-accent'
                }`}
              >
                <ShieldAlert size={9} />
                {spam === 'only'
                  ? 'Back to the ledger'
                  : `${(summary?.spam_count ?? 0).toLocaleString()} hidden as spam · view`}
              </button>
            )}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {/* Only the all-clear renders here now; when something needs review
              the count sits on the segmented control below, where clicking it
              actually does something. */}
          {summary && summary.needs_review_count === 0 && (
            <span className="inline-flex items-center gap-1.5 border border-gain/20 bg-gain/10 px-2 py-1 text-[10px] font-bold uppercase tracking-wide text-gain">
              <Check size={11} />
              Nothing unexplained
            </span>
          )}
          <a
            href={exportHref}
            className="inline-flex h-8 items-center gap-2 rounded border border-border bg-surface-3 px-3 text-[9px] font-bold uppercase tracking-wide text-secondary transition-all hover:border-accent hover:text-accent"
          >
            <Download size={12} />
            Export CSV
          </a>
        </div>
      </div>


      {/* ONE labeled filter bar, not three unlabeled tab strips: underline
          tabs above this mean navigation, so everything here has to look like
          what it is -- a filter with a visible name. Category stays a select
          (twenty values, and the server 400s an unknown one, so the options
          are the shared vocabulary rather than free text). Hidden entirely in
          the quarantine view -- see the chip above for why. */}
      {spam !== 'only' && (
      <div className="mb-3 flex flex-wrap items-center gap-x-4 gap-y-2 border border-border bg-surface p-2">
        {/* Three segments carrying five-digit counts overflow a phone, so
            there it is a dropdown whose options still say the counts. */}
        <SegmentedControl
          label="Show"
          mobile="select"
          value={status}
          onChange={(next) => { setStatus(next); setExpandedId(null); }}
          options={STATUS_OPTIONS.map((option) => ({
            ...option,
            selectLabel: statusCounts
              ? `${option.label} (${Number(statusCounts[option.value]).toLocaleString()})`
              : option.label,
            // Needs review is the queue, so its selected state runs the same
            // orange as the review chips; the count beside it stays orange
            // even unselected while it is nonzero.
            activeClassName: option.value === 'true' ? 'bg-orange-500/15 text-orange-400' : undefined,
            badge: statusCounts ? (
              <span className={`px-1 text-[9px] font-bold ${
                option.value === 'true' && statusCounts[option.value] > 0
                  ? 'bg-orange-500/15 text-orange-400'
                  : 'bg-surface-3 text-tertiary'
              }`}>
                {Number(statusCounts[option.value]).toLocaleString()}
              </span>
            ) : null,
          }))}
        />

        {/* One wallet's ledger is on-chain by definition: offering
            "Exchange" there only leads to an empty table. */}
        {walletId == null && exchangeAccountId == null && (
          <SegmentedControl
            label="Source"
            value={source}
            onChange={(next) => { setSource(next); setExpandedId(null); }}
            options={SOURCE_OPTIONS}
          />
        )}

        <label className="flex min-w-0 items-center gap-2">
          <span className="shrink-0 text-[9px] font-bold uppercase tracking-wide text-tertiary">Category</span>
          <select
            value={category}
            onChange={(event) => { setCategory(event.target.value); setExpandedId(null); }}
            aria-label="Ledger category"
            className="h-8 min-w-0 rounded border border-input-border bg-surface-2 px-2 text-body-sm text-primary"
          >
            <option value="">All categories</option>
            {ledgerCategories().map(([value, label]) => (
              <option key={value} value={value}>{label}</option>
            ))}
          </select>
        </label>

        <label className="flex min-w-0 flex-1 basis-full items-center gap-2 sm:basis-auto sm:min-w-[14rem]">
          <Search size={13} className="shrink-0 text-tertiary" />
          <input
            type="search"
            value={searchText}
            onChange={(event) => { setSearchText(event.target.value); setExpandedId(null); }}
            placeholder="Hash, address, asset or name"
            aria-label="Search activity"
            maxLength={100}
            className="h-8 w-full min-w-0 rounded border border-input-border bg-surface-2 px-2 text-body-sm text-primary placeholder:text-tertiary"
          />
        </label>

        <div className="flex min-w-0 items-center gap-1.5">
          <span className="shrink-0 text-[9px] font-bold uppercase tracking-wide text-tertiary">Dates</span>
          <input
            type="date"
            value={fromDate}
            max={toDate || undefined}
            onChange={(event) => { setFromDate(event.target.value); setExpandedId(null); }}
            aria-label="From date"
            className="h-8 min-w-0 rounded border border-input-border bg-surface-2 px-1.5 text-body-sm text-primary"
          />
          <span className="text-tertiary">–</span>
          <input
            type="date"
            value={toDate}
            min={fromDate || undefined}
            onChange={(event) => { setToDate(event.target.value); setExpandedId(null); }}
            aria-label="To date"
            className="h-8 min-w-0 rounded border border-input-border bg-surface-2 px-1.5 text-body-sm text-primary"
          />
          {(fromDate || toDate) && (
            <button
              type="button"
              onClick={() => { setFromDate(''); setToDate(''); }}
              aria-label="Clear dates"
              className="rounded p-1 text-tertiary hover:text-primary"
            >
              <X size={12} />
            </button>
          )}
        </div>

        {counterparty && (
          <span className="inline-flex items-center gap-1 rounded border border-accent/30 bg-accent/10 px-2 py-1 text-caption text-accent">
            Only {shortEthAddress(counterparty)}
            {onClearCounterparty && (
              <button type="button" onClick={onClearCounterparty} aria-label="Show every address" className="hover:text-primary">
                <X size={11} />
              </button>
            )}
          </span>
        )}

        {onShowTransferLegs && (
          <button
            type="button"
            onClick={onShowTransferLegs}
            title="Each transfer as the blockchain recorded it; ignore spam tokens from here"
            className="ml-auto shrink-0 text-caption text-tertiary underline underline-offset-2 transition-colors hover:text-accent"
          >
            Individual transfers →
          </button>
        )}
      </div>
      )}

      {/* Three ways this ledger can be less than the whole truth, each from
          its own source of truth -- stated separately because the fixes differ
          (a balance drift means a transfer is missing, an unpriced asset means
          the dollars are absent rather than zero, a stalled import means rows
          are) -- but on ONE strip: three full-width banners stacked here
          pushed the table below the fold. */}
      {(nativeDrift.length > 0 || unpriced.length > 0 || incompleteAccounts.length > 0) && (
        <div className="mb-3 flex flex-wrap items-start gap-x-6 gap-y-1.5 border border-orange-500/20 bg-orange-500/5 p-2 text-body-sm">
          <span className="mt-0.5 shrink-0 text-[9px] font-bold uppercase tracking-wide text-orange-400">Completeness</span>
          {nativeDrift.length > 0 && (
            <span className="flex items-center gap-1.5 text-loss">
              <AlertTriangle size={13} className="shrink-0" />
              <span>
                The transaction history does not add up to the balance on the blockchain
                for {nativeDrift.length} {nativeDrift.length === 1 ? 'wallet and network' : 'wallet and network pairs'} — a
                transaction is missing, so these totals are short.
                {onNavigate && (
                  <button type="button" onClick={() => onNavigate('crypto-wallets')} className="ml-1.5 underline hover:text-primary">
                    Open Wallets
                  </button>
                )}
              </span>
            </span>
          )}
          {unpriced.length > 0 && (
            <span className="flex items-center gap-1.5 text-orange-400">
              <DollarSign size={13} className="shrink-0" />
              <span>
                {unpriced.length} {unpriced.length === 1 ? 'asset has' : 'assets have'} no
                price for the dates they moved ({unpriced.slice(0, 4).map((a) => a.asset_symbol || a.asset_key).join(', ')}
                {unpriced.length > 4 ? `, +${unpriced.length - 4} more` : ''}) — their rows read
                &quot;No USD value&quot;, which is not the same as $0.
              </span>
            </span>
          )}
          {incompleteAccounts.length > 0 && (
            <span className="flex items-center gap-1.5 text-orange-400">
              <AlertTriangle size={13} className="shrink-0" />
              <span>
                {incompleteAccounts.length === 1 ? incompleteAccounts[0].name : `${incompleteAccounts.length} exchange accounts`}{' '}
                {incompleteAccounts.length === 1 ? 'has' : 'have'} not finished syncing, or {incompleteAccounts.length === 1 ? 'does' : 'do'} not
                match the exchange&apos;s own balances — this list may be incomplete.
                {onNavigate && (
                  <button type="button" onClick={() => onNavigate('crypto-exchanges')} className="ml-1.5 underline hover:text-primary">
                    Open Exchanges
                  </button>
                )}
              </span>
            </span>
          )}
        </div>
      )}

      {/* What the Spam view IS, said once at the top: these rows were kept out
          of Needs Review, nothing about them was deleted, and any of them can
          be restored from its own row. Without this the view reads as a list of
          problems rather than a list of things already dealt with. */}
      {spam === 'only' && (
        <div className="mb-3 flex flex-wrap items-center gap-2 border border-border bg-surface-3 p-2 text-body-sm text-secondary">
          <ShieldAlert size={14} className="shrink-0 text-tertiary" />
          <span>
            Quarantined: address-poisoning attempts, dust and scam airdrops, kept out of Needs Review.
            Nothing was deleted — these keep their amounts and still count toward the balance checks.
            Open a row and choose &quot;Not spam&quot; to restore it; the choice sticks through every future sync.
          </span>
        </div>
      )}

      {error && (
        <div className="mb-3 flex items-center gap-2 border border-loss/20 bg-loss-bg p-2 text-body-sm text-loss">
          <X size={16} />
          {error}
        </div>
      )}

      {loading ? (
        <LoadingState label="Building the ledger" className="min-h-[300px]" />
      ) : (
        <DataTable
          table={table}
          breakpoint="lg"
          emptyMessage={spam === 'only'
            ? 'Nothing has been quarantined.'
            : 'No ledger entries match these filters.'}
          onRowClick={toggleRow}
          rowClassName={() => 'cursor-pointer'}
          // ONE mount, never two. DataTable keeps the desktop table and the
          // mobile list both in the DOM and hides one with CSS, so rendering
          // the panel from both paths mounted it twice: two `getTransfers`
          // fetches for one expand, two copies of the correction form's state
          // drifting apart, and duplicate aria labels for every field.
          renderRowDetail={(row) => (!isMobile && expandedId === row.original.id ? (
            <LedgerRowDetail
              key={row.original.id}
              row={row.original}
              onError={setError}
              onChanged={handleRowChanged}
              addressNote={addressNoteByAddress.get(row.original.counterparty_address) || ''}
            />
          ) : null)}
          header={rows.length > 0 && (
            <div className="flex items-center justify-between border-b border-border p-4">
              <span className="text-[10px] font-bold uppercase tracking-wide text-tertiary">Events</span>
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
            const entry = row.original;
            const open = expandedId === entry.id;
            return (
              <div key={row.id} className="bg-surface p-4">
                <button
                  type="button"
                  onClick={() => toggleRow(entry)}
                  aria-expanded={open}
                  className="block w-full text-left"
                >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="truncate font-money text-sm font-semibold text-primary">{entry.description}</p>
                    <div className="mt-1 flex flex-wrap items-center gap-2 text-[10px] uppercase tracking-wider text-tertiary">
                      <span>{formatDateDisplay(entry.occurred_at)}</span>
                      <span className="truncate">
                        {entry.source === 'onchain' && entry.wallet_label ? `${entry.wallet_label} · ` : ''}{entry.source_label}
                      </span>
                    </div>
                  </div>
                  <div className="flex shrink-0 flex-col items-end gap-1">
                    <Chip className={categoryChipClass(entry.category)}>
                      {formatLedgerCategory(entry.category)}
                    </Chip>
                    {formatUsdAtTime(entry.usd_value, entry.usd_basis) && (
                      <span className={`font-money text-body-sm ${entry.usd_value == null ? 'text-tertiary' : 'text-primary'}`}>
                        {formatUsdAtTime(entry.usd_value, entry.usd_basis)}
                        {entry.usd_basis === 'carried' && <span className="ml-0.5 text-tertiary">~</span>}
                      </span>
                    )}
                  </div>
                </div>
                {entry.needs_review && (
                  <p className="mt-2 text-[10px] uppercase tracking-wider text-orange-400">Needs review</p>
                )}
                </button>
                {open && isMobile && (
                  <div>
                    <LedgerRowDetail
                      key={entry.id}
                      row={entry}
                      onError={setError}
                      onChanged={handleRowChanged}
                      addressNote={addressNoteByAddress.get(entry.counterparty_address) || ''}
                    />
                  </div>
                )}
              </div>
            );
          }}
        />
      )}
    </section>
  );
};

// The expanded row: what actually moved, plus the review actions that resolve
// it. Every action calls an endpoint that already exists -- an override on the
// on-chain side, a counterparty label (which reclassifies ALL history for that
// address, so one label can drain many rows), and a resolve on the venue side.
// The raw eth_transfers legs behind a transaction, with what each moved. An
// NFT leg's value_wei is a unit COUNT (033), never wei, so it never scales.
const RAW_LEG_TYPE = {
  native: 'transfer', internal: 'internal', token: 'token', gas: 'network fee', nft: 'NFT', nft1155: 'NFT',
};
const rawLegAmount = (leg, chainId) => {
  if (leg.transfer_type === 'nft' || leg.transfer_type === 'nft1155') {
    const id = leg.token_id != null ? ` #${String(leg.token_id).slice(0, 8)}${String(leg.token_id).length > 8 ? '…' : ''}` : '';
    return `${leg.value_wei || 1} × ${leg.token_symbol || 'NFT'}${id}`;
  }
  if (leg.transfer_type === 'token') {
    return `${formatCapped(leg.value_wei, leg.token_decimals ?? 18, 8) ?? '?'} ${leg.token_symbol || 'tokens'}`;
  }
  return `${formatCapped(leg.value_wei, 18, 8) ?? '?'} ${nativeSymbol(leg.chain_id ?? chainId)}`;
};

export const LedgerRowDetail = ({ row, onError, onChanged, addressNote = '' }) => {
  const onChain = row.source === 'onchain';
  const [category, setCategory] = useState(row.category);
  const [note, setNote] = useState(row.override_note || '');
  const [saving, setSaving] = useState(null);
  const [labelOpen, setLabelOpen] = useState(false);
  const [legs, setLegs] = useState(null);

  // The raw eth_transfers legs behind this transaction. Netted legs answer
  // "what changed"; the raw ones answer "how" -- a router swap nets to two
  // assets but really touched six addresses. Fetched on expand rather than
  // ridden along on every feed row.
  useEffect(() => {
    if (!onChain || !row.tx_hash) return undefined;
    let cancelled = false;
    ethAPI.getTransfers({ walletId: row.wallet_id, tx_hash: row.tx_hash, chain_id: row.chain_id, limit: 100 })
      .then((result) => { if (!cancelled) setLegs(result.data || []); })
      .catch(() => { if (!cancelled) setLegs([]); });
    return () => { cancelled = true; };
  }, [onChain, row.tx_hash, row.wallet_id, row.chain_id]);

  // "Saved", beside the action that did it: a review that only shows itself
  // by the row moving (or not) leaves the user unsure anything happened.
  const [saved, setSaved] = useState(null);
  const savedTimer = useRef(null);
  useEffect(() => () => clearTimeout(savedTimer.current), []);
  const run = async (key, action) => {
    if (saving) return;
    setSaving(key);
    setSaved(null);
    onError(null);
    try {
      await action();
      setSaved(key);
      clearTimeout(savedTimer.current);
      savedTimer.current = setTimeout(() => setSaved(null), 3000);
      await onChanged();
    } catch (err) {
      onError(err.response?.data?.error || 'That action failed');
    } finally {
      setSaving(null);
    }
  };

  // A changed note rides along with a category correction in the same write;
  // the API takes both, and two writes could leave one half saved.
  const noteChanged = note !== (row.override_note || '');
  const saveOverride = () => run('override', () => ethAPI.setActivityOverride({
    walletId: row.wallet_id,
    txHash: row.tx_hash,
    chainId: row.chain_id,
    category,
    ...(noteChanged ? { note } : {}),
  }));

  const saveNote = () => run('note', () => ethAPI.setActivityNote({
    walletId: row.wallet_id,
    txHash: row.tx_hash,
    chainId: row.chain_id,
    note,
  }));

  // The one-click un-quarantine, against the endpoint the Review tab's
  // section already owns. `false` is explicit: the API refuses anything but a
  // boolean, because a coerced 'false' would quarantine the row being rescued.
  const rescueFromSpam = () => run('spam', () => ethAPI.setActivitySpam(
    row.wallet_id, row.tx_hash, false, { chainId: row.chain_id }
  ));

  const revertOverride = () => run('revert', () => ethAPI.clearActivityOverride({
    walletId: row.wallet_id,
    txHash: row.tx_hash,
    chainId: row.chain_id,
  }));

  const saveLabel = ({ name, kind }) => run('label', async () => {
    await ethAPI.labelAddress(row.counterparty_address, name || null, { kind });
    setLabelOpen(false);
  });

  const resolveRecord = (accountId, recordId) => run(
    `resolve:${recordId}`,
    () => exchangesAPI.resolveRecord(accountId, recordId)
  );

  // Confirm or reject the pairing #61 derived. A verdict names exactly one
  // pair, in whichever of 041's two shapes this row is: an on-chain match is
  // keyed on (wallet, chain, tx_hash) -- NOT on eth_activity.id, which churns
  // on every rebuild -- and a venue-to-venue pair on the counter record.
  const matchTarget = (match) => ({
    exchangeRecordId: match.verdict_exchange_record_id,
    ...(match.verdict_counter_record_id != null
      ? { counterRecordId: match.verdict_counter_record_id }
      : { walletId: row.wallet_id, txHash: row.tx_hash, chainId: row.chain_id }),
  });

  const judgeMatch = (match, verdict) => run(
    `match:${verdict}`,
    () => exchangesAPI.setMatchVerdict({ ...matchTarget(match), verdict })
  );

  const clearMatchVerdict = (match) => run(
    'match:clear',
    () => exchangesAPI.clearMatchVerdict(matchTarget(match))
  );

  return (
    <div className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <DetailField label="Category">
          {formatLedgerCategory(row.category)}
          {row.is_overridden && row.derived_category && row.derived_category !== row.category && (
            <span className="ml-1 text-tertiary">(was {formatLedgerCategory(row.derived_category)})</span>
          )}
        </DetailField>
        <DetailField label="Where">{row.source_label}{row.wallet_label ? ` · ${row.wallet_label}` : ''}</DetailField>
        <DetailField label="Counterparty">
          {row.counterparty_address ? (
            <a
              href={explorerAddressUrl(row.counterparty_address, row.chain_id)}
              target="_blank"
              rel="noreferrer"
              className="font-mono text-accent hover:underline"
            >
              {row.counterparty_name || shortEthAddress(row.counterparty_address)}
            </a>
          ) : (row.record_address || row.account_name || '—')}
        </DetailField>
        <DetailField label="Fee">
          {row.fee_amount && Number.parseFloat(row.fee_amount) !== 0
            ? `${formatTokenUnits(row.fee_units, row.fee_decimals, { maxFractionDigits: 18 }) ?? row.fee_amount} ${row.fee_asset}`
            : '—'}
          {row.usd_fee && <span className="ml-1 text-tertiary">({formatUsdAtTime(row.usd_fee)})</span>}
        </DetailField>
        {/* The basis is part of the number: "$1,832 exact" and "$1,832 carried
            from an earlier close" are different claims, and "no price" is not
            zero. Stating it is what keeps the dollars honest. */}
        <DetailField label="Value at the time">
          {row.usd_value != null
            ? <>
                {formatUsdAtTime(row.usd_value, row.usd_basis)}
                {row.usd_basis === 'carried' && (
                  <span className="ml-1 text-tertiary">(nearest earlier daily price)</span>
                )}
              </>
            : <span title={USD_BASIS_NOTE[row.usd_basis] || undefined}>
                {row.usd_basis === 'not_applicable' ? 'Not applicable' : 'No USD value for this date'}
              </span>}
        </DetailField>
        {row.method_name && (
          // Attacker-controlled text end to end (anyone can deploy a contract
          // or submit a signature to 4byte), and a low-confidence hint at that
          // -- selector collisions are mined deliberately. Rendered as text by
          // React's default escaping, and NO classification reads it.
          <DetailField label="Method">
            <span className="font-mono text-caption text-tertiary" title={row.method_id || undefined}>
              {row.method_name}
            </span>
          </DetailField>
        )}
        {row.protocol_interpretation && (
          <div className="col-span-full border border-accent/20 bg-accent/5 p-2">
            <p className="text-[9px] font-bold uppercase tracking-wide text-accent">
              {humanize(row.protocol_interpretation.protocol)} · {humanize(row.protocol_interpretation.action).toLowerCase()}
            </p>
            <p className="mt-1 text-body-sm text-secondary">{row.protocol_interpretation.summary}</p>
            {row.protocol_interpretation.limitations?.length > 0 && (
              <p className="mt-0.5 text-caption text-tertiary">
                Limitation: {row.protocol_interpretation.limitations.join(' ')}
              </p>
            )}
          </div>
        )}
        {row.external_id && <DetailField label="Exchange record">{row.external_id}</DetailField>}
        {row.exchange_fiat_match && (
          <div className="col-span-full border border-accent/20 bg-accent/5 p-2">
            <p className="text-[9px] font-bold uppercase tracking-wide text-accent">Linked bank transaction</p>
            <p className="mt-1 text-body-sm text-secondary">
              {row.exchange_fiat_match.bank_name || row.exchange_fiat_match.merchant_name || 'Plaid transaction'}
              {row.exchange_fiat_match.bank_account_name ? ` · ${row.exchange_fiat_match.bank_account_name}` : ''}
              {row.exchange_fiat_match.bank_date ? ` · ${formatDateDisplay(row.exchange_fiat_match.bank_date)}` : ''}
            </p>
            <p className="mt-0.5 text-caption text-tertiary">
              Same fiat movement · {row.exchange_fiat_match.day_delta === 0
                ? 'same day'
                : `${row.exchange_fiat_match.day_delta} day${row.exchange_fiat_match.day_delta === 1 ? '' : 's'} apart`}
            </p>
          </div>
        )}
        {row.review_reason && (
          <DetailField label={row.needs_review ? 'Why flagged' : 'How it was explained'}>
            {REVIEW_REASON_TEXT[row.review_reason] || row.review_reason}
          </DetailField>
        )}
        {addressNote && <DetailField label="Address note">{addressNote}</DetailField>}
        {row.override_note && <DetailField label="Transaction note">{row.override_note}</DetailField>}
      </div>

      {/* A pairing this row was rejected against. Rejecting DELETES the match,
          so there is no match object to hang the undo on -- without this the
          rejection is permanent and invisible, and the matcher will never
          propose that pairing again. */}
      {!row.exchange_match && row.rejected_match && (
        <div className="flex flex-wrap items-center gap-2 border border-border bg-surface-3 p-2 text-body-sm text-tertiary">
          <span>You rejected a suggested pairing for this transaction, so it is shown on its own.</span>
          <button
            type="button"
            // Addressed in the shape the verdict was STORED in: a venue-to-venue
            // rejection is keyed on both record ids, an on-chain one on (wallet,
            // chain, tx_hash). Sending the wrong shape is a 400 or a 404.
            onClick={() => run('match:clear', () => exchangesAPI.clearMatchVerdict(
              row.rejected_match.counter_record_id != null
                ? {
                  exchangeRecordId: row.rejected_match.exchange_record_id,
                  counterRecordId: row.rejected_match.counter_record_id,
                }
                : {
                  exchangeRecordId: row.rejected_match.exchange_record_id,
                  walletId: row.wallet_id,
                  txHash: row.tx_hash,
                  chainId: row.chain_id,
                }
            ))}
            disabled={saving != null}
            className="inline-flex h-7 items-center gap-1 rounded border border-border bg-surface-2 px-2 text-[9px] font-bold uppercase tracking-wide text-tertiary transition-all hover:text-primary disabled:opacity-40"
          >
            {saving === 'match:clear' ? <RefreshCw size={10} className="animate-spin" /> : <Undo2 size={10} />}
            Undo rejection
          </button>
        </div>
      )}

      {/* The other half of this movement (#61), with the EVIDENCE that paired
          them. A confirm/reject is a judgement about that evidence, so hiding
          it behind a confidence score would leave nothing to judge. */}
      {row.exchange_match && (
        <div className="border border-teal-500/20 bg-teal-500/5 p-2">
          <p className="text-[9px] font-bold uppercase tracking-wide text-teal-400">
            Matched with {row.exchange_match.account_name || row.exchange_match.exchange} · {row.exchange_match.record_type}
          </p>
          <div className="mt-1 flex flex-wrap items-center gap-2 text-body-sm text-secondary">
            <span className="font-money">{describeLegs(row.exchange_match.legs)}</span>
            <span className="text-tertiary">
              · {MATCH_METHOD_NOTE[row.exchange_match.match_method] || row.exchange_match.match_method}
              {row.exchange_match.match_confidence ? ` · ${row.exchange_match.match_confidence} confidence` : ''}
            </span>
          </div>
          {(row.exchange_match.comparison_kind === 'amount'
            || row.exchange_match.match_method === 'tx_hash') && (
            <p className="mt-1 text-caption text-tertiary">
              {describeExchangeMatchEvidence(row.exchange_match)}
              {row.exchange_match.address_match ? ' · address corroborated' : ''}
            </p>
          )}
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            {row.exchange_match.verdict ? (
              <>
                <Chip className={row.exchange_match.verdict === 'confirmed'
                  ? 'border-gain/20 bg-gain/10 text-gain'
                  : 'border-loss/20 bg-loss/10 text-loss'}>
                  You {row.exchange_match.verdict} this
                </Chip>
                <button
                  type="button"
                  onClick={() => clearMatchVerdict(row.exchange_match)}
                  disabled={saving != null}
                  title="Hand the decision back to the matcher"
                  className="inline-flex h-7 items-center gap-1 rounded border border-border bg-surface-3 px-2 text-[9px] font-bold uppercase tracking-wide text-tertiary transition-all hover:text-primary disabled:opacity-40"
                >
                  {saving === 'match:clear' ? <RefreshCw size={10} className="animate-spin" /> : <Undo2 size={10} />}
                  Undo verdict
                </button>
              </>
            ) : (
              <>
                <button
                  type="button"
                  onClick={() => judgeMatch(row.exchange_match, 'confirmed')}
                  disabled={saving != null}
                  className="inline-flex h-7 items-center gap-1 rounded border border-gain/30 bg-gain/10 px-2 text-[9px] font-bold uppercase tracking-wide text-gain transition-all hover:bg-gain/20 disabled:opacity-40"
                >
                  {saving === 'match:confirmed' ? <RefreshCw size={10} className="animate-spin" /> : <Check size={10} />}
                  Same movement
                </button>
                {/* Rejecting splits the pair back into two rows -- which is the
                    honest outcome when the matcher guessed, not a deletion. */}
                <button
                  type="button"
                  onClick={() => judgeMatch(row.exchange_match, 'rejected')}
                  disabled={saving != null}
                  title="These are two different movements; show them separately"
                  className="inline-flex h-7 items-center gap-1 rounded border border-loss/30 bg-loss/10 px-2 text-[9px] font-bold uppercase tracking-wide text-loss transition-all hover:bg-loss/20 disabled:opacity-40"
                >
                  {saving === 'match:rejected' ? <RefreshCw size={10} className="animate-spin" /> : <X size={10} />}
                  Not the same
                </button>
              </>
            )}
            {row.exchange_match.needs_review && (
              <button
                type="button"
                onClick={() => resolveRecord(row.exchange_match.exchange_account_id, row.exchange_match.exchange_record_id)}
                disabled={saving != null}
                className="inline-flex h-7 items-center gap-1 rounded border border-accent/30 bg-accent/10 px-2 text-[9px] font-bold uppercase tracking-wide text-accent transition-all hover:bg-accent/20 disabled:opacity-40"
              >
                {saving === `resolve:${row.exchange_match.exchange_record_id}` && <RefreshCw size={10} className="animate-spin" />}
                Mark the record reviewed
              </button>
            )}
          </div>
        </div>
      )}

      {/* The same transaction as another of the user's own wallets saw it. The
          activity table writes one row per WALLET, so a wallet-to-wallet
          transfer is two rows for one movement -- the sending side hosts and
          this is what it folded, stated rather than silently dropped. */}
      {row.self_match?.length > 0 && (
        <div className="border border-accent/20 bg-accent/5 p-2">
          <p className="text-[9px] font-bold uppercase tracking-wide text-accent">
            Also recorded by {row.self_match.length === 1 ? 'another of your wallets' : 'your other wallets'} · shown once
          </p>
          <ul className="mt-1 space-y-0.5">
            {row.self_match.map((half) => (
              <li key={half.wallet_id} className="text-body-sm text-secondary">
                <span className="text-tertiary">{half.wallet_label || shortEthAddress(half.wallet_address)}: </span>
                <span className="font-money">{describeLegs(half.legs)}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* The far half of a cross-chain bridge (#59). Two chains recorded one
          movement of the user's own money as two unrelated transactions; the
          sending side hosts and the arrival is stated here rather than dropped,
          with its own hash so it stays checkable on its own explorer. */}
      {row.bridge_match && (
        <div className="border border-teal-500/20 bg-teal-500/5 p-2">
          <p className="text-[9px] font-bold uppercase tracking-wide text-teal-400">
            {bridgeVerificationLabel(row.bridge_match)} · bridged to {row.bridge_match.chain_label || 'another chain'} · one movement, shown once
          </p>
          <div className="mt-1 flex flex-wrap items-center gap-2 text-body-sm text-secondary">
            <span className="font-money">{describeLegs(row.bridge_match.legs)}</span>
            {describeBridgeFees(row.bridge_match) && (
              <span className="text-tertiary">
                · bridge fee {describeBridgeFees(row.bridge_match)}
              </span>
            )}
            {row.bridge_match.tx_hash && (
              <a
                href={explorerTxUrl(row.bridge_match.tx_hash, row.bridge_match.chain_id)}
                target="_blank"
                rel="noreferrer"
                title={row.bridge_match.tx_hash}
                className="font-mono text-caption text-accent hover:underline"
              >
                {shortEthAddress(row.bridge_match.tx_hash)}
              </a>
            )}
          </div>
          {hopPairEvidence(row.bridge_match) && (
            <p
              className="mt-1 break-words text-caption text-tertiary"
              title={hopPairEvidence(row.bridge_match).transfer_id || undefined}
            >
              {describeHopPair(row.bridge_match)}
            </p>
          )}
          {row.bridge_match.source_members?.length > 1 && (
            <div className="mt-2 border-t border-teal-500/10 pt-2">
              <p className="text-[9px] font-bold uppercase tracking-wide text-teal-400">
                Constituent source transactions
              </p>
              <ul className="mt-1 space-y-0.5">
                {row.bridge_match.source_members.map((member) => (
                  <li key={`${member.chain_id}:${member.tx_hash}:${member.row_id}`} className="flex flex-wrap items-center gap-2 text-body-sm text-secondary">
                    <span className="font-money">{describeBridgeSource(member)}</span>
                    {member.tx_hash && (
                      <a
                        href={explorerTxUrl(member.tx_hash, member.chain_id)}
                        target="_blank"
                        rel="noreferrer"
                        title={member.tx_hash}
                        className="font-mono text-caption text-accent hover:underline"
                      >
                        {shortEthAddress(member.tx_hash)}
                      </a>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}

      {onChain && legs !== null && legs.length > 0 && (
        <div>
          <p className="text-[9px] font-bold uppercase tracking-wide text-tertiary">Transfer legs</p>
          <ul className="mt-1 space-y-0.5">
            {legs.map((leg) => (
              <li key={leg.id} className="font-mono text-caption text-tertiary">
                <span className="text-secondary">{rawLegAmount(leg, row.chain_id)}</span>
                {' · '}
                {RAW_LEG_TYPE[leg.transfer_type] || leg.transfer_type}
                {' · '}
                {shortEthAddress(leg.from_address)} → {leg.to_address ? shortEthAddress(leg.to_address) : 'contract creation'}
                {leg.is_error ? ' · failed' : ''}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Review actions. On-chain corrections write eth_activity_overrides,
          which the nightly rebuild cannot erase; labelling a counterparty
          triggers a reclassification that can resolve many rows at once. */}
      <div className="flex flex-wrap items-end gap-2 border-t border-border pt-3">
        {onChain ? (
          <>
            <label className="flex min-w-0 items-center gap-2">
              <span className="shrink-0 text-[9px] font-bold uppercase tracking-wide text-tertiary">Set category</span>
              <select
                value={category}
                onChange={(event) => setCategory(event.target.value)}
                aria-label="Set category"
                className="h-8 min-w-0 rounded border border-input-border bg-surface-2 px-2 text-body-sm text-primary outline-none focus:ring-1 focus:ring-accent"
              >
                {onchainOverrideCategories().map(([value, label]) => (
                  <option key={value} value={value}>{label}</option>
                ))}
              </select>
            </label>
            <input
              type="text"
              value={note}
              onChange={(event) => setNote(event.target.value)}
              placeholder="What this transaction did"
              aria-label="Transaction note"
              className="h-8 w-40 min-w-0 rounded border border-input-border bg-surface-2 px-2 text-body-sm text-primary outline-none focus:ring-1 focus:ring-accent"
            />
            <button
              type="button"
              onClick={saveNote}
              disabled={saving != null}
              className="inline-flex h-8 items-center gap-1.5 rounded border border-border bg-surface-3 px-2.5 text-[9px] font-bold uppercase tracking-wide text-secondary transition-all hover:text-primary disabled:opacity-40"
            >
              {saving === 'note' && <RefreshCw size={10} className="animate-spin" />}
              Save note
            </button>
            {/* Accepting the category as it stands is the commonest review,
                and it used to need "Save correction" on an unchanged picker. */}
            {row.needs_review && category === row.category ? (
              <button
                type="button"
                onClick={saveOverride}
                disabled={saving != null}
                className="inline-flex h-8 items-center gap-1.5 rounded border border-gain/30 bg-gain/10 px-2.5 text-[9px] font-bold uppercase tracking-wide text-gain transition-all hover:bg-gain/20 disabled:opacity-40"
              >
                {saving === 'override' ? <RefreshCw size={10} className="animate-spin" /> : <Check size={10} />}
                Looks right, mark reviewed
              </button>
            ) : (
              <button
                type="button"
                onClick={saveOverride}
                disabled={saving != null || category === row.category}
                className="inline-flex h-8 items-center gap-1.5 rounded border border-accent/30 bg-accent/10 px-2.5 text-[9px] font-bold uppercase tracking-wide text-accent transition-all hover:bg-accent/20 disabled:opacity-40"
              >
                {saving === 'override' && <RefreshCw size={10} className="animate-spin" />}
                Save correction
              </button>
            )}
            {row.is_overridden && (
              <button
                type="button"
                onClick={revertOverride}
                disabled={saving != null}
                title="Go back to the category the app worked out"
                className="inline-flex h-8 items-center gap-1.5 rounded border border-border bg-surface-3 px-2.5 text-[9px] font-bold uppercase tracking-wide text-tertiary transition-all hover:text-primary disabled:opacity-40"
              >
                {saving === 'revert' ? <RefreshCw size={10} className="animate-spin" /> : <Undo2 size={10} />}
                Revert
              </button>
            )}
            {/* The rescue, on the row that shows the mistake. It posts the SAME
                verdict the Review tab's quarantine section posts (POST
                /api/eth/activity/spam with spam:false), so there is one
                endpoint, one wording and one stored answer -- a second rescue
                path with its own semantics is how two screens start disagreeing
                about whether a transaction is real. Nothing is deleted either
                way; this only decides which view the row appears in. */}
            {row.spam && (
              <button
                type="button"
                onClick={rescueFromSpam}
                disabled={saving != null}
                title="Restore this transaction to the ledger; the choice sticks through every future sync"
                className="inline-flex h-8 items-center gap-1.5 rounded border border-border bg-surface-3 px-2.5 text-[9px] font-bold uppercase tracking-wide text-tertiary transition-all hover:border-accent hover:text-accent disabled:opacity-40"
              >
                {saving === 'spam' ? <RefreshCw size={10} className="animate-spin" /> : <Undo2 size={10} />}
                Not spam
              </button>
            )}
            {row.labelable && !labelOpen && (
              <button
                type="button"
                onClick={() => setLabelOpen(true)}
                title="Give this counterparty a verdict; it reclassifies every transaction with it"
                className="inline-flex h-8 items-center gap-1.5 rounded border border-border bg-surface-3 px-2.5 text-[9px] font-bold uppercase tracking-wide text-tertiary transition-all hover:border-teal-500/30 hover:text-teal-400"
              >
                <Tag size={10} />
                {row.counterparty_name ? 'Relabel counterparty' : 'Label counterparty'}
              </button>
            )}
          </>
        ) : row.needs_review && row.record_needs_review ? (
          // Gated on the ROW's OWN flag, not the ORed one: on a folded pair the
          // flag can belong to the other half, and resolving this record would
          // clear something already clear and leave the row still flagged --
          // a button that looks broken. The other half has its own button in
          // the match panel above.
          <button
            type="button"
            onClick={() => resolveRecord(row.exchange_account_id, row.row_id)}
            disabled={saving != null}
            className="inline-flex h-8 items-center gap-1.5 rounded border border-gain/30 bg-gain/10 px-2.5 text-[9px] font-bold uppercase tracking-wide text-gain transition-all hover:bg-gain/20 disabled:opacity-40"
          >
            {saving === `resolve:${row.row_id}` && <RefreshCw size={10} className="animate-spin" />}
            Mark reviewed
          </button>
        ) : (
          <p className="text-caption text-tertiary">
            Imported from {row.account_name}. Exchange records are corrected by re-importing a fuller export.
          </p>
        )}
        {saved && (
          <span role="status" className="inline-flex h-8 items-center gap-1 text-caption font-semibold text-gain">
            <Check size={12} /> Saved
          </span>
        )}
      </div>

      {labelOpen && (
        <div className="border-t border-border pt-3">
          <CounterpartyVerdictForm
            initialName={row.counterparty_name || ''}
            busy={saving === 'label'}
            onSubmit={saveLabel}
            onCancel={() => setLabelOpen(false)}
          />
        </div>
      )}
    </div>
  );
};

export default CryptoLedger;

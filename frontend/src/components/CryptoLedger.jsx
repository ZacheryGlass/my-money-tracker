import React, { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { useReactTable, getCoreRowModel } from '@tanstack/react-table';
import {
  AlertTriangle, ChevronDown, ChevronRight, Download, ExternalLink, Landmark,
  Link2, Pencil, RefreshCw, Tag, Undo2, Wallet, X,
} from 'lucide-react';
import { crypto as cryptoAPI, eth as ethAPI, exchanges as exchangesAPI } from '../utils/api';
import { formatDateDisplay, formatExactUnits } from '../utils/format';
import { explorerTxUrl, explorerAddressUrl } from '../utils/chains';
import {
  LEDGER_CATEGORIES,
  ONCHAIN_OVERRIDE_CATEGORIES,
  LABEL_VERDICT_KEEP,
  LABEL_VERDICT_OPTIONS,
  formatLedgerCategory,
  labelVerdictKind,
  labelVerdictNeedsName,
} from '../utils/dataLabels';
import DataTable from './DataTable';
import FilterTabs from './FilterTabs';
import LoadingState from './LoadingState';
import { shortEthAddress } from './OnChainActivity';

const PAGE_SIZE = 100;

// The two dimensions that are worth a tab strip. Category has twenty values and
// belongs in a select; these have three each and are the ones a user flips
// between while draining the queue.
const SOURCE_OPTIONS = [
  { value: '', label: 'All' },
  { value: 'onchain', label: 'On-chain' },
  { value: 'exchange', label: 'Exchange' },
];

const STATUS_OPTIONS = [
  { value: '', label: 'All' },
  { value: 'true', label: 'Needs Review' },
  { value: 'false', label: 'Explained' },
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

// A uint256 token id runs to 78 digits and would blow the column out.
const shortTokenId = (id) => {
  const text = String(id);
  return text.length > 10 ? `${text.slice(0, 8)}…` : text;
};

// Eight places, not the formatter's default six: a real 0.00000042 ETH receipt
// is a row the user has to explain, and rendering it as "<0.000001" turns the
// one fact that identifies it into a shrug. Wide enough for ETH dust, still
// short enough that 1,832.412345 USDC reads at a glance.
const legText = (leg) => {
  const id = leg.token_id != null ? ` #${shortTokenId(leg.token_id)}` : '';
  return `${formatExactUnits(leg.amount, { maxFractionDigits: 8 })} ${leg.asset}${id}`;
};

// "0.5 ETH -> 1,832.4 USDC". One description built from netted legs, for both
// sources: an exchange trade's base/quote and an on-chain swap's netted legs
// arrive in the same shape from the API precisely so this reads them once.
const describeLegs = (legs) => {
  const out = (legs || []).filter((leg) => leg.direction === 'out').map(legText);
  const incoming = (legs || []).filter((leg) => leg.direction === 'in').map(legText);
  if (out.length && incoming.length) return `${out.join(' + ')} → ${incoming.join(' + ')}`;
  if (out.length) return `− ${out.join(' + ')}`;
  if (incoming.length) return `+ ${incoming.join(' + ')}`;
  return 'No net movement';
};

// A folded venue half contributes its own assets to the line: the on-chain legs
// alone describe half the event. Same shape as the API's legs, built from the
// record's signed base/quote exactly as the server builds an unfolded row's.
const matchLegs = (match) => {
  const legs = [];
  for (const [asset, amount] of [[match.base_asset, match.base_amount], [match.quote_asset, match.quote_amount]]) {
    if (!asset || amount == null || Number.parseFloat(amount) === 0) continue;
    const text = String(amount).trim();
    legs.push({ asset, direction: text.startsWith('-') ? 'out' : 'in', amount: text.replace(/^-/, '') });
  }
  return legs;
};

// A folded venue record outranks the bare address: it is PROOF of which venue
// the transaction was with, where an unlabeled 0xbbbb…bbbb is only a hex string
// nobody has judged. A user's own label still beats both.
const counterpartyText = (row) => {
  if (row.counterparty_name) return row.counterparty_name;
  if (row.exchange_matches?.length) return row.exchange_matches[0].account_name;
  if (row.counterparty_address) return shortEthAddress(row.counterparty_address);
  if (row.record_address) return row.record_address;
  return '—';
};

// Rows whose counterparty can carry a verdict. Gas-only rows have none, a
// zero-address mint/burn has no party to label, and an exchange record's
// counterparty IS the venue.
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
const isLabelable = (row) => row.source === 'onchain'
  && Boolean(row.counterparty_address)
  && row.counterparty_address !== ZERO_ADDRESS;

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
const CryptoLedger = ({ walletId = null, refreshKey = 0, onDataChanged }) => {
  const [rows, setRows] = useState([]);
  const [total, setTotal] = useState(0);
  const [summary, setSummary] = useState(null);
  const [exchangeAccounts, setExchangeAccounts] = useState([]);
  const [source, setSource] = useState('');
  const [status, setStatus] = useState('');
  const [category, setCategory] = useState('');
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState(null);
  const [expandedId, setExpandedId] = useState(null);
  const [reload, setReload] = useState(0);

  const filters = useMemo(() => ({
    ...(source ? { source } : {}),
    ...(category ? { category } : {}),
    ...(status ? { needsReview: status } : {}),
    ...(walletId != null ? { walletId } : {}),
  }), [source, category, status, walletId]);

  // Guards a Load More response that arrives after the filters moved on.
  const filtersRef = useRef(filters);
  useEffect(() => { filtersRef.current = filters; }, [filters]);

  const refresh = useCallback(() => setReload((n) => n + 1), []);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      setLoading(true);
      setError(null);
      try {
        const result = await cryptoAPI.getLedger({ ...filters, limit: PAGE_SIZE, offset: 0 });
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

  // The badge is deliberately unfiltered, so it reloads on its own schedule.
  useEffect(() => {
    let cancelled = false;
    cryptoAPI.getLedgerSummary()
      .then((result) => { if (!cancelled) setSummary(result.summary || null); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [reload, refreshKey]);

  // Completeness signals from the venue side. A ledger that claims to be the
  // whole history has to say when one of its sources is behind or disagrees
  // with the venue's own balances -- otherwise "everything is explained" and
  // "everything we managed to import is explained" look identical.
  useEffect(() => {
    let cancelled = false;
    exchangesAPI.getAll()
      .then((result) => { if (!cancelled) setExchangeAccounts(result.accounts || []); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [reload, refreshKey]);

  const incompleteAccounts = useMemo(() => exchangeAccounts.filter(
    (account) => account.last_sync_status === 'balance_mismatch'
      || account.last_sync_status === 'error'
      || account.balance_report?.backfill_pending
  ), [exchangeAccounts]);

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
    source: source || undefined,
    category: category || undefined,
    needs_review: status || undefined,
    wallet_id: walletId ?? undefined,
  });

  const enriched = useMemo(() => rows.map((row) => {
    const legs = [...(row.legs || []), ...(row.exchange_matches || []).flatMap(matchLegs)];
    return {
      ...row,
      allLegs: legs,
      description: describeLegs(legs),
      counterparty: counterpartyText(row),
      labelable: isLabelable(row),
    };
  }), [rows]);

  const columns = useMemo(() => [
    {
      id: 'date',
      accessorFn: (row) => row.occurred_at,
      header: 'Date',
      meta: { width: '7.5rem', cellClassName: 'whitespace-nowrap font-mono text-caption' },
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
              <Chip className="border-orange-500/30 bg-orange-500/10 text-orange-400" title={entry.review_reason || 'Flagged on import'}>
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
            {entry.exchange_matches?.length > 0 && (
              <Chip
                className="border-teal-500/20 bg-teal-500/10 text-teal-400"
                title="One event recorded on both sides; shown once"
              >
                <Link2 size={9} />
                Matched
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
      meta: { width: '9rem' },
      cell: ({ row }) => (
        <span
          className={`flex items-center gap-1 ${row.original.source === 'onchain' ? 'text-crypto' : 'text-teal-400'}`}
          title={row.original.wallet_label || row.original.source_label}
        >
          {row.original.source === 'onchain'
            ? <Wallet size={10} className="shrink-0" />
            : <Landmark size={10} className="shrink-0" />}
          <span className="truncate">{row.original.source_label}</span>
        </span>
      ),
    },
    {
      id: 'counterparty',
      accessorFn: (row) => row.counterparty,
      header: 'Counterparty',
      meta: { width: '10rem', cellClassName: 'truncate' },
      cell: ({ row }) => (
        <span title={row.original.counterparty_address || row.original.counterparty}>
          {row.original.counterparty}
        </span>
      ),
    },
    {
      id: 'fee',
      accessorFn: (row) => row.fee_amount || '',
      header: 'Fee',
      meta: { width: '8rem', align: 'right', headerClassName: 'text-right', cellClassName: 'whitespace-nowrap text-right' },
      cell: ({ row }) => {
        const entry = row.original;
        if (!entry.fee_amount || Number.parseFloat(entry.fee_amount) === 0) {
          return <span className="text-tertiary">—</span>;
        }
        return (
          <span className="font-money text-tertiary">
            {formatExactUnits(entry.fee_amount)} {entry.fee_asset}
          </span>
        );
      },
    },
  ], [expandedId]);

  const table = useReactTable({
    data: enriched,
    columns,
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

  return (
    <section>
      <div className="mb-3 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-xs font-bold uppercase tracking-wide text-secondary">Unified Ledger</h2>
          <p className="mt-0.5 text-caption text-tertiary">
            {summary
              ? `${summary.total.toLocaleString()} events · ${summary.onchain_count.toLocaleString()} on-chain · ${summary.exchange_count.toLocaleString()} exchange${summary.matched_count ? ` · ${summary.matched_count.toLocaleString()} matched` : ''}`
              : 'Loading…'}
            {rangeText ? ` · ${rangeText}` : ''}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {summary && (
            <span
              className={`inline-flex items-center gap-1.5 border px-2 py-1 text-[10px] font-bold uppercase tracking-wide ${
                summary.needs_review_count > 0
                  ? 'border-orange-500/30 bg-orange-500/10 text-orange-400'
                  : 'border-gain/20 bg-gain/10 text-gain'
              }`}
            >
              <AlertTriangle size={11} />
              {summary.needs_review_count > 0
                ? `${summary.needs_review_count.toLocaleString()} need review`
                : 'Nothing unexplained'}
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

      <div className="mb-3 grid gap-3 md:grid-cols-2">
        <FilterTabs
          id="crypto-ledger-source"
          label="Source"
          options={SOURCE_OPTIONS}
          value={source}
          onChange={(next) => { setSource(next); setExpandedId(null); }}
        />
        <FilterTabs
          id="crypto-ledger-status"
          label="Status"
          options={STATUS_OPTIONS}
          value={status}
          onChange={(next) => { setStatus(next); setExpandedId(null); }}
        />
      </div>

      {/* A select, not a third strip: twenty categories cannot be a tab bar,
          and the server 400s an unknown value, so the options are the shared
          vocabulary rather than free text. */}
      <label className="mb-3 flex min-w-0 items-center gap-2">
        <span className="shrink-0 text-caption font-semibold uppercase tracking-wide text-tertiary">Category</span>
        <select
          value={category}
          onChange={(event) => { setCategory(event.target.value); setExpandedId(null); }}
          aria-label="Ledger category"
          className="h-9 w-full min-w-0 border border-border bg-surface px-2 text-body-sm text-primary sm:w-[240px]"
        >
          <option value="">All categories</option>
          {LEDGER_CATEGORIES.map(([value, label]) => (
            <option key={value} value={value}>{label}</option>
          ))}
        </select>
      </label>

      {incompleteAccounts.length > 0 && (
        <div className="mb-3 flex flex-wrap items-center gap-2 border border-orange-500/20 bg-orange-500/5 p-2 text-body-sm text-orange-400">
          <AlertTriangle size={14} className="shrink-0" />
          <span>
            {incompleteAccounts.length} exchange {incompleteAccounts.length === 1 ? 'account has' : 'accounts have'} not
            finished syncing, or did not reconcile with the venue&apos;s own balances — this ledger may be incomplete.
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
          breakpoint="md"
          emptyMessage="No ledger entries match these filters."
          onRowClick={toggleRow}
          rowClassName={() => 'cursor-pointer'}
          renderRowDetail={(row) => (expandedId === row.original.id ? (
            <LedgerRowDetail
              row={row.original}
              onError={setError}
              onChanged={() => { refresh(); onDataChanged?.(); }}
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
              <div key={row.id} className="bg-surface p-4" onClick={() => toggleRow(entry)}>
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="truncate font-money text-sm font-semibold text-primary">{entry.description}</p>
                    <div className="mt-1 flex flex-wrap items-center gap-2 text-[10px] uppercase tracking-wider text-tertiary">
                      <span>{formatDateDisplay(entry.occurred_at)}</span>
                      <span>{entry.source_label}</span>
                    </div>
                  </div>
                  <Chip className={categoryChipClass(entry.category)}>
                    {formatLedgerCategory(entry.category)}
                  </Chip>
                </div>
                {entry.needs_review && (
                  <p className="mt-2 text-[10px] uppercase tracking-wider text-orange-400">Needs review</p>
                )}
                {open && (
                  <div onClick={(event) => event.stopPropagation()}>
                    <LedgerRowDetail
                      row={entry}
                      onError={setError}
                      onChanged={() => { refresh(); onDataChanged?.(); }}
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
const LedgerRowDetail = ({ row, onError, onChanged }) => {
  const onChain = row.source === 'onchain';
  const [category, setCategory] = useState(row.category);
  const [note, setNote] = useState(row.override_note || '');
  const [saving, setSaving] = useState(null);
  const [labelOpen, setLabelOpen] = useState(false);
  const [labelName, setLabelName] = useState(row.counterparty_name || '');
  const [labelVerdict, setLabelVerdict] = useState(LABEL_VERDICT_KEEP);
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

  const run = async (key, action) => {
    if (saving) return;
    setSaving(key);
    onError(null);
    try {
      await action();
      onChanged();
    } catch (err) {
      onError(err.response?.data?.error || 'That action failed');
    } finally {
      setSaving(null);
    }
  };

  const saveOverride = () => run('override', () => ethAPI.setActivityOverride({
    walletId: row.wallet_id,
    txHash: row.tx_hash,
    chainId: row.chain_id,
    category,
    note: note.trim() || undefined,
  }));

  const revertOverride = () => run('revert', () => ethAPI.clearActivityOverride({
    walletId: row.wallet_id,
    txHash: row.tx_hash,
    chainId: row.chain_id,
  }));

  const saveLabel = (event) => {
    event.preventDefault();
    const name = labelName.trim();
    if (!name && labelVerdictNeedsName(labelVerdict)) return;
    run('label', async () => {
      await ethAPI.labelAddress(row.counterparty_address, name || null, { kind: labelVerdictKind(labelVerdict) });
      setLabelOpen(false);
    });
  };

  const resolveRecord = (accountId, recordId) => run(
    `resolve:${recordId}`,
    () => exchangesAPI.resolveRecord(accountId, recordId)
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
            ? `${formatExactUnits(row.fee_amount, { maxFractionDigits: 8 })} ${row.fee_asset}`
            : '—'}
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
        {row.external_id && <DetailField label="Exchange record">{row.external_id}</DetailField>}
        {row.review_reason && <DetailField label="Why flagged">{row.review_reason}</DetailField>}
        {row.override_note && <DetailField label="Note">{row.override_note}</DetailField>}
      </div>

      {row.exchange_matches?.length > 0 && (
        <div className="border border-teal-500/20 bg-teal-500/5 p-2">
          <p className="text-[9px] font-bold uppercase tracking-wide text-teal-400">
            Matched exchange {row.exchange_matches.length === 1 ? 'record' : 'records'}
          </p>
          {row.exchange_matches.map((match) => (
            <div key={match.id} className="mt-1 flex flex-wrap items-center gap-2 text-body-sm text-secondary">
              <span className="font-money">{describeLegs(matchLegs(match))}</span>
              <span className="text-tertiary">· {match.account_name} · {match.record_type}</span>
              {match.needs_review && (
                <button
                  type="button"
                  onClick={() => resolveRecord(match.exchange_account_id, match.id)}
                  disabled={saving != null}
                  className="inline-flex h-7 items-center gap-1 rounded border border-gain/30 bg-gain/10 px-2 text-[9px] font-bold uppercase tracking-wide text-gain transition-all hover:bg-gain/20 disabled:opacity-40"
                >
                  {saving === `resolve:${match.id}` && <RefreshCw size={10} className="animate-spin" />}
                  Mark reviewed
                </button>
              )}
            </div>
          ))}
        </div>
      )}

      {onChain && legs !== null && legs.length > 0 && (
        <div>
          <p className="text-[9px] font-bold uppercase tracking-wide text-tertiary">Transfer legs</p>
          <ul className="mt-1 space-y-0.5">
            {legs.map((leg) => (
              <li key={leg.id} className="font-mono text-caption text-tertiary">
                {leg.transfer_type}
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
                {ONCHAIN_OVERRIDE_CATEGORIES.map(([value, label]) => (
                  <option key={value} value={value}>{label}</option>
                ))}
              </select>
            </label>
            <input
              type="text"
              value={note}
              onChange={(event) => setNote(event.target.value)}
              placeholder="Note (optional)"
              aria-label="Correction note"
              className="h-8 w-40 min-w-0 rounded border border-input-border bg-surface-2 px-2 text-body-sm text-primary outline-none focus:ring-1 focus:ring-accent"
            />
            <button
              type="button"
              onClick={saveOverride}
              disabled={saving != null}
              className="inline-flex h-8 items-center gap-1.5 rounded border border-accent/30 bg-accent/10 px-2.5 text-[9px] font-bold uppercase tracking-wide text-accent transition-all hover:bg-accent/20 disabled:opacity-40"
            >
              {saving === 'override' && <RefreshCw size={10} className="animate-spin" />}
              Save correction
            </button>
            {row.is_overridden && (
              <button
                type="button"
                onClick={revertOverride}
                disabled={saving != null}
                title="Uncover the derived verdict again"
                className="inline-flex h-8 items-center gap-1.5 rounded border border-border bg-surface-3 px-2.5 text-[9px] font-bold uppercase tracking-wide text-tertiary transition-all hover:text-primary disabled:opacity-40"
              >
                {saving === 'revert' ? <RefreshCw size={10} className="animate-spin" /> : <Undo2 size={10} />}
                Revert
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
        ) : row.needs_review ? (
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
      </div>

      {labelOpen && (
        <form onSubmit={saveLabel} className="flex flex-wrap items-end gap-2 border-t border-border pt-3">
          <input
            type="text"
            value={labelName}
            onChange={(event) => setLabelName(event.target.value)}
            maxLength={64}
            autoFocus
            placeholder={labelVerdictNeedsName(labelVerdict) ? 'e.g. Coinbase' : 'Name (optional)'}
            aria-label="Label name"
            className="h-8 w-40 min-w-0 rounded border border-input-border bg-surface-2 px-2 text-body-sm text-primary outline-none focus:ring-1 focus:ring-accent"
          />
          {/* The verdict is the point, not a detail: without it every label
              written here votes 'exchange', and a wrong builtin could never be
              corrected from the row that shows its effect. */}
          <select
            value={labelVerdict}
            onChange={(event) => setLabelVerdict(event.target.value)}
            aria-label="Counterparty verdict"
            className="h-8 min-w-0 rounded border border-input-border bg-surface-2 px-2 text-[11px] text-primary outline-none focus:ring-1 focus:ring-accent"
          >
            {LABEL_VERDICT_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>{option.label}</option>
            ))}
          </select>
          <button
            type="submit"
            disabled={saving != null || (labelVerdictNeedsName(labelVerdict) && !labelName.trim())}
            className="inline-flex h-8 items-center gap-1.5 rounded border border-teal-500/30 bg-teal-500/10 px-2.5 text-[9px] font-bold uppercase tracking-wide text-teal-400 transition-all hover:bg-teal-500/20 disabled:opacity-40"
          >
            {saving === 'label' && <RefreshCw size={10} className="animate-spin" />}
            Save label
          </button>
          <button
            type="button"
            onClick={() => setLabelOpen(false)}
            className="inline-flex h-8 items-center rounded border border-border bg-surface-3 px-2 text-[9px] font-bold uppercase tracking-wide text-tertiary transition-all hover:text-primary"
          >
            <X size={10} />
          </button>
        </form>
      )}
    </div>
  );
};

export default CryptoLedger;

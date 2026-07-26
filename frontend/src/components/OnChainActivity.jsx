import React, { useState, useEffect, useMemo, useRef } from 'react';
import { useReactTable, getCoreRowModel } from '@tanstack/react-table';
import { Activity, X, ExternalLink, EyeOff, RefreshCw, Tag, Wallet } from 'lucide-react';
import { eth as ethAPI } from '../utils/api';
import { formatCurrency, formatDateDisplay } from '../utils/format';
import { explorerTxUrl } from '../utils/chains';
import {
  LABEL_VERDICT_KEEP,
  LABEL_VERDICT_OPTIONS,
  labelVerdictKind,
  labelVerdictNeedsName,
} from '../utils/dataLabels';
import DataTable from './DataTable';
import FilterTabs from './FilterTabs';
import LoadingState from './LoadingState';

export const shortEthAddress = (address) => (address ? `${address.slice(0, 6)}…${address.slice(-4)}` : 'unknown');

export const EthWalletBadge = () => (
  <span
    className="inline-flex h-5 w-5 items-center justify-center bg-crypto-bg text-crypto border border-crypto-border shrink-0"
    title="Ethereum wallet account"
    aria-label="Ethereum wallet account"
  >
    <Wallet size={10} />
  </span>
);

const TRANSFER_PAGE_SIZE = 100;

const TRANSFER_TYPE_OPTIONS = [
  { value: '', label: 'All' },
  { value: 'external', label: 'External' },
  { value: 'exchange', label: 'Exchange' },
  { value: 'self', label: 'Self' },
  { value: 'gas', label: 'Gas' },
  { value: 'token', label: 'Tokens' },
];

const TRANSFER_CHIP_STYLES = {
  Self: 'bg-accent/10 text-accent border-accent/20',
  External: 'bg-blue-500/10 text-blue-400 border-blue-500/20',
  Exchange: 'bg-teal-500/10 text-teal-400 border-teal-500/20',
  Gas: 'bg-orange-500/10 text-orange-400 border-orange-500/20',
  Token: 'bg-crypto-bg text-crypto border-crypto-border',
  NFT: 'bg-crypto-bg-strong text-crypto border-crypto-border',
};

const NFT_TRANSFER_TYPES = new Set(['nft', 'nft1155']);

// from = 0x0 is a mint, to = 0x0 is a burn. Both are real endpoints worth
// showing, but neither is a counterparty anyone can label.
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

const transferChipLabel = (transfer) => {
  if (transfer.transfer_type === 'gas') return 'Gas';
  // Ahead of self/exchange: what moved is the useful fact about an NFT row,
  // and every mint reads as "External" otherwise.
  if (NFT_TRANSFER_TYPES.has(transfer.transfer_type)) return 'NFT';
  if (transfer.counterparty_is_own) return 'Self';
  if (transfer.counterparty_exchange) return 'Exchange';
  return transfer.transfer_type === 'token' ? 'Token' : 'External';
};

// A uint256 token id is up to 78 digits and would blow out the column.
const shortTokenId = (id) => {
  const text = String(id);
  return text.length > 10 ? `${text.slice(0, 8)}…` : text;
};

const formatTransferQuantity = (transfer) => {
  // NFT rows carry a COUNT OF UNITS in value_wei, not a scaled amount, so the
  // 1e18 divide below would render every one of them as 0. ERC-721 is always
  // one unit; ERC-1155 can move several copies of an id.
  if (NFT_TRANSFER_TYPES.has(transfer.transfer_type)) {
    const units = Number(transfer.value_wei);
    const label = `${transfer.token_symbol || 'NFT'}${transfer.token_id != null ? ` #${shortTokenId(transfer.token_id)}` : ''}`;
    return units > 1 ? `${units} × ${label}` : label;
  }
  const decimals = transfer.transfer_type === 'token'
    ? (transfer.token_decimals != null ? Number(transfer.token_decimals) : 18)
    : 18;
  const quantity = Number(transfer.value_wei) / 10 ** decimals;
  const symbol = transfer.transfer_type === 'token' ? (transfer.token_symbol || 'TOKEN') : 'ETH';
  return `${quantity.toLocaleString(undefined, { maximumFractionDigits: 6 })} ${symbol}`;
};

// What the row was worth ON ITS OWN DATE (#73), read off the valuation the
// server already stored -- the client never multiplies a quantity by a price.
//
// Three distinct states, and conflating any two of them is the bug this
// replaces:
//   a figure      -- valued from the dated series (exact, or carried across a
//                    gap of a few days in a 24/7 market)
//   No USD value  -- the asset has no close on that date. NOT $0: an unpriced
//                    token is unknown, not worthless. Same wording the
//                    counterparty triage queue already uses for the same reason.
//   nothing       -- the row has no dollar meaning at all: an NFT leg's
//                    value_wei is a count of units, and a reverted transfer
//                    moved nothing.
const formatTransferUsd = (transfer) => {
  if (transfer.usd_basis === 'not_applicable') return null;
  if (transfer.usd_at_time == null) return 'No USD value';
  const usd = Math.abs(Number(transfer.usd_at_time));
  if (!Number.isFinite(usd)) return 'No USD value';
  // Sub-cent amounts round to $0 through the normal formatter, which reads as
  // worthless rather than as tiny.
  if (usd > 0 && usd < 0.01) return '< $0.01';
  // BOTH bounds. maximumFractionDigits alone leaves the minimum at 0, so one
  // column renders $1,234.5, $1,234 and $0.5 next to each other and the decimal
  // points stop lining up -- in a money column, where scanning down the point is
  // the whole reason the column is monospaced.
  return formatCurrency(usd, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
};

// Dedicated on-chain ledger for wallet-linked accounts, fed by the raw
// eth_transfers feed rather than the mirrored transactions table.
//
// `walletId` narrows to one wallet; omit it for the merged feed across every
// wallet. `walletNames` maps wallet id -> label, used to tag rows in the
// merged feed where a row's address alone doesn't say which wallet it is.
//
// `onDataChanged` fires after a mutation that re-derives server-side data the
// parent also renders -- ignoring a token deletes its holding row, labelling an
// address rewrites the mirrored transactions. Refreshing only this feed would
// leave the holdings and totals around it showing what the user just removed.
const OnChainActivity = ({ walletId = null, walletNames, onDataChanged }) => {
  const [rows, setRows] = useState([]);
  const [total, setTotal] = useState(0);
  const [typeFilter, setTypeFilter] = useState('');
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState(null);
  const [ignoringContract, setIgnoringContract] = useState(null);
  const [labelingId, setLabelingId] = useState(null);
  const [labelName, setLabelName] = useState('');
  // null = follow the default ("keep") -- the server resolves the address's
  // current verdict, hidden pack rows included. Set once the user picks.
  const [labelVerdictChoice, setLabelVerdictChoice] = useState(null);
  const [savingLabel, setSavingLabel] = useState(false);
  const [labelNames, setLabelNames] = useState([]);
  const [refreshKey, setRefreshKey] = useState(0);
  // Guards Load More responses that arrive after the filter changed.
  const typeFilterRef = useRef(typeFilter);
  useEffect(() => { typeFilterRef.current = typeFilter; }, [typeFilter]);

  useEffect(() => {
    let cancelled = false;
    const fetchTransfers = async () => {
      setLoading(true);
      setError(null);
      try {
        const result = await ethAPI.getTransfers({
          walletId,
          type: typeFilter || undefined,
          limit: TRANSFER_PAGE_SIZE,
          offset: 0,
        });
        if (cancelled) return;
        setRows(result.data || []);
        setTotal(result.pagination?.total || 0);
      } catch (err) {
        if (!cancelled) setError(err.response?.data?.error || 'Failed to load on-chain activity');
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    fetchTransfers();
    return () => { cancelled = true; };
  }, [walletId, typeFilter, refreshKey]);

  const loadMore = async () => {
    const filterAtCall = typeFilter;
    setLoadingMore(true);
    try {
      const result = await ethAPI.getTransfers({
        walletId,
        type: filterAtCall || undefined,
        limit: TRANSFER_PAGE_SIZE,
        offset: rows.length,
      });
      if (typeFilterRef.current !== filterAtCall) return;
      setRows((prev) => [...prev, ...(result.data || [])]);
      setTotal(result.pagination?.total || 0);
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to load more transfers');
    } finally {
      setLoadingMore(false);
    }
  };

  const handleIgnoreToken = async (transfer) => {
    setIgnoringContract(transfer.token_contract);
    setError(null);
    try {
      await ethAPI.ignoreToken(transfer.token_contract, transfer.token_symbol || undefined);
      setRefreshKey((key) => key + 1);
      onDataChanged?.();
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to ignore token');
    } finally {
      setIgnoringContract(null);
    }
  };

  // Known exchange names feed the inline form's datalist for one-tap reuse.
  // Exchange kinds only: the typeahead is for naming an exchange, and
  // 'external'/'own' rows default their name to a bare 0x1234…abcd, which
  // would otherwise fill it with noise.
  //
  // The same response also says WHICH addresses already have a verdict, which
  // is what picks the form's default (keep vs. exchange). It cannot see the
  // scraped pack -- findAllForUser hides those rows -- so a packed address
  // reads as unlabeled and defaults to Exchange, which is exactly what the
  // insert would have done anyway.
  useEffect(() => {
    let cancelled = false;
    ethAPI.getAddressLabels()
      .then((result) => {
        if (cancelled) return;
        const labels = result.labels || [];
        setLabelNames([...new Set(
          labels
            .filter((label) => !label.kind || label.kind === 'exchange')
            .map((label) => label.name)
        )]);
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [refreshKey]);

  // The form always defaults to "keep": the server resolves it to the
  // address's current verdict -- the user's row, else any builtin's (the
  // scraped pack is hidden from getAddressLabels, so this page cannot see
  // it) -- and to 'exchange' only for an address nobody has judged.
  // Defaulting from what this page can see re-voted hidden pack 'external'
  // gateways to 'exchange' on a plain rename.
  const handleLabelAddress = async (event, counterparty) => {
    event.preventDefault();
    const verdict = labelVerdictChoice || LABEL_VERDICT_KEEP;
    const name = labelName.trim();
    // External/own names never reach classification, so the server fills in a
    // short address; only an exchange name has to be typed.
    if (savingLabel || (!name && labelVerdictNeedsName(verdict))) return;
    setSavingLabel(true);
    setError(null);
    try {
      await ethAPI.labelAddress(counterparty, name || null, { kind: labelVerdictKind(verdict) });
      setLabelingId(null);
      setLabelName('');
      setLabelVerdictChoice(null);
      setRefreshKey((key) => key + 1);
      onDataChanged?.();
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to label address');
    } finally {
      setSavingLabel(false);
    }
  };

  // Direction, counterparty and label-ability are derived once per row rather
  // than inside each cell. Direction is per row, not per feed: a merged feed
  // spans addresses, so asking "did I send this?" against a single wallet's
  // address would invert the sign of every row belonging to a different wallet.
  const enrichedRows = useMemo(() => rows.map((transfer) => {
    const outbound = transfer.transfer_type === 'gas'
      || transfer.from_address === transfer.wallet_address;
    const counterparty = transfer.transfer_type === 'gas'
      ? null
      : outbound ? transfer.to_address : transfer.from_address;
    const exchangeName = !transfer.counterparty_is_own ? transfer.counterparty_exchange : null;
    return {
      ...transfer,
      outbound,
      counterparty,
      exchangeName,
      chip: transferChipLabel(transfer),
      walletName: walletNames?.get(transfer.wallet_id),
      quantity: formatTransferQuantity(transfer),
      usdAtTime: formatTransferUsd(transfer),
      // A carried close is a real valuation, but it is not the day's own close,
      // and a ledger that cannot say which is which cannot be reconciled
      // against a tax record.
      usdCarried: transfer.usd_basis === 'carried',
      description: transfer.transfer_type === 'gas'
        ? 'Gas fee'
        : `${outbound ? 'To' : 'From'} ${exchangeName || shortEthAddress(counterparty)}`,
      // Rows already showing an exchange name stay labelable: the scraped
      // pack is low-confidence and hidden from the Settings list, so this
      // button is the only two-click path to correct a wrong pack verdict.
      labelable: transfer.transfer_type !== 'gas'
        && !transfer.counterparty_is_own
        && counterparty && counterparty !== ZERO_ADDRESS,
    };
  }), [rows, walletNames]);

  // Only the merged feed needs a wallet column; with one wallet selected every
  // row would repeat the same name.
  const showWalletColumn = Boolean(walletNames);

  const columns = useMemo(() => [
    {
      id: 'date',
      accessorFn: (row) => row.block_time,
      header: 'Date',
      meta: { width: '7rem', cellClassName: 'whitespace-nowrap font-mono text-caption' },
      cell: ({ getValue }) => formatDateDisplay(getValue()),
    },
    {
      id: 'description',
      accessorFn: (row) => row.description,
      header: 'Description',
      meta: { cellClassName: 'min-w-0' },
      cell: ({ row }) => (
        <div className="flex min-w-0 items-center gap-2">
          <span
            className="truncate text-body-sm font-semibold text-primary"
            title={row.original.counterparty || undefined}
          >
            {row.original.description}
          </span>
          {row.original.is_error && (
            <span className="shrink-0 border border-loss/20 bg-loss/10 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide text-loss">
              Failed
            </span>
          )}
          {/* A hash only exists on its own chain: an Arbitrum tx looked up on
              etherscan.io is simply not found, which reads as "this never
              happened" rather than as a broken link. */}
          <a
            href={explorerTxUrl(row.original.tx_hash, row.original.chain_id)}
            target="_blank"
            rel="noreferrer"
            title={row.original.tx_hash}
            className="shrink-0 text-tertiary transition-colors hover:text-accent"
          >
            <ExternalLink size={11} />
          </a>
        </div>
      ),
    },
    {
      id: 'type',
      accessorFn: (row) => row.chip,
      header: 'Type',
      meta: { width: '7rem' },
      cell: ({ row }) => (
        <span className={`inline-flex items-center border px-2 py-0.5 text-[9px] font-bold uppercase tracking-wide ${TRANSFER_CHIP_STYLES[row.original.chip]}`}>
          {row.original.chip}
        </span>
      ),
    },
    ...(showWalletColumn ? [{
      id: 'wallet',
      accessorFn: (row) => row.walletName || '',
      header: 'Wallet',
      meta: { width: '11rem' },
      // flex (block-level) so the cell's fixed width bounds it and the inner
      // span ellipsizes; an inline-flex sizes to its content and the label just
      // gets chopped mid-word against the next column.
      cell: ({ row }) => (row.original.walletName ? (
        <span className="flex items-center gap-1 text-crypto" title={row.original.walletName}>
          <Wallet size={10} className="shrink-0" />
          <span className="truncate">{row.original.walletName}</span>
        </span>
      ) : <span className="text-tertiary">—</span>),
    }] : []),
    {
      id: 'amount',
      accessorFn: (row) => row.quantity,
      header: 'Amount',
      meta: { width: '11rem', align: 'right', headerClassName: 'text-right', cellClassName: 'whitespace-nowrap text-right' },
      // The crypto amount leads because it is the stable fact -- the dollars
      // are derived from it, at the price on the transfer's own date.
      cell: ({ row }) => (
        <div className="flex flex-col items-end">
          <span className={`font-money font-bold ${row.original.outbound ? 'text-loss' : 'text-gain'}`}>
            {row.original.outbound ? '-' : '+'}{row.original.quantity}
          </span>
          {row.original.usdAtTime && (
            <span
              className="font-money text-[10px] text-tertiary"
              title={row.original.usdCarried
                ? 'Valued at the most recent close before this date'
                : 'Valued at the price on the transaction date'}
            >
              {row.original.usdAtTime}
              {row.original.usdCarried && <span className="ml-0.5">*</span>}
            </span>
          )}
        </div>
      ),
    },
    {
      id: 'actions',
      header: '',
      meta: { width: '13rem', align: 'right', headerClassName: 'text-right', cellClassName: 'text-right' },
      cell: ({ row }) => {
        const transfer = row.original;
        if (labelingId === transfer.id) {
          // The verdict is the point of this form, not a detail: without it
          // every label written here votes 'exchange', and an address the pack
          // got wrong could never be corrected from the screen that shows the
          // wrong transfer. Stacked rather than inline -- the cell is 13rem.
          const verdict = labelVerdictChoice || LABEL_VERDICT_KEEP;
          const nameRequired = labelVerdictNeedsName(verdict);
          return (
            <form
              onSubmit={(event) => handleLabelAddress(event, transfer.counterparty)}
              className="flex flex-col items-stretch gap-1.5"
            >
              <input
                type="text"
                value={labelName}
                onChange={(event) => setLabelName(event.target.value)}
                list="eth-label-names"
                maxLength={64}
                placeholder={nameRequired ? 'e.g. Coinbase' : 'Name (optional)'}
                autoFocus
                aria-label="Label name"
                className="h-7 w-full min-w-0 rounded border border-input-border bg-surface-2 px-2 text-body-sm text-primary outline-none focus:ring-1 focus:ring-accent"
              />
              <select
                value={verdict}
                onChange={(event) => setLabelVerdictChoice(event.target.value)}
                aria-label="Counterparty verdict"
                className="h-7 w-full min-w-0 rounded border border-input-border bg-surface-2 px-1 text-[11px] text-primary outline-none focus:ring-1 focus:ring-accent"
              >
                {LABEL_VERDICT_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>{option.label}</option>
                ))}
              </select>
              <div className="flex items-center justify-end gap-1.5">
                <button
                  type="submit"
                  disabled={savingLabel || (nameRequired && !labelName.trim())}
                  className="inline-flex h-7 items-center gap-1 rounded border border-teal-500/30 bg-teal-500/10 px-2 text-[9px] font-bold uppercase tracking-wide text-teal-400 transition-all hover:bg-teal-500/20 disabled:opacity-40"
                >
                  {savingLabel && <RefreshCw size={10} className="animate-spin" />}
                  Save
                </button>
                <button
                  type="button"
                  onClick={() => { setLabelingId(null); setLabelName(''); setLabelVerdictChoice(null); }}
                  className="inline-flex h-7 items-center rounded border border-border bg-surface-3 px-2 text-[9px] font-bold uppercase tracking-wide text-tertiary transition-all hover:text-primary"
                >
                  <X size={10} />
                </button>
              </div>
            </form>
          );
        }
        return (
          <div className="flex items-center justify-end gap-1.5">
            {transfer.labelable && (
              <button
                onClick={() => { setLabelingId(transfer.id); setLabelName(transfer.exchangeName || ''); setLabelVerdictChoice(null); }}
                title={transfer.exchangeName
                  ? 'Correct or rename this label (exchange, outside party, or yours)'
                  : 'Label this address and say how to treat it (exchange, outside party, or yours)'}
                className="inline-flex h-7 items-center gap-1.5 rounded border border-border bg-surface-3 px-2 text-[9px] font-bold uppercase tracking-wide text-tertiary transition-all hover:border-teal-500/30 hover:text-teal-400"
              >
                <Tag size={10} />
                {transfer.exchangeName ? 'Relabel' : 'Label'}
              </button>
            )}
            {transfer.token_contract && (
              <button
                onClick={() => handleIgnoreToken(transfer)}
                disabled={ignoringContract === transfer.token_contract}
                title="Ignore this token everywhere"
                className="inline-flex h-7 items-center gap-1.5 rounded border border-border bg-surface-3 px-2 text-[9px] font-bold uppercase tracking-wide text-tertiary transition-all hover:border-loss/30 hover:text-loss disabled:opacity-40"
              >
                {ignoringContract === transfer.token_contract
                  ? <RefreshCw size={10} className="animate-spin" />
                  : <EyeOff size={10} />}
                Ignore
              </button>
            )}
          </div>
        );
      },
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
  ], [showWalletColumn, labelingId, labelName, labelVerdictChoice, savingLabel, ignoringContract]);

  const table = useReactTable({
    data: enrichedRows,
    columns,
    // The feed arrives block-ordered from the API and pages in via Load More;
    // sorting a partial page client-side would reorder only what is loaded.
    enableSorting: false,
    getCoreRowModel: getCoreRowModel(),
  });

  return (
    <section>
      <div className="flex items-center gap-2 mb-4">
        <Activity className="text-accent w-4 h-4" />
        <h2 className="text-xs font-bold uppercase tracking-wide text-secondary">On-chain Activity</h2>
      </div>

      <FilterTabs
        id="eth-transfer-type"
        label="Transfer type"
        className="mb-3"
        options={TRANSFER_TYPE_OPTIONS}
        value={typeFilter}
        onChange={setTypeFilter}
      />
      <datalist id="eth-label-names">
        {labelNames.map((name) => <option key={name} value={name} />)}
      </datalist>

      {error && (
        <div className="mb-3 flex items-center gap-2 border border-loss/20 bg-loss-bg p-2 text-body-sm text-loss">
          <X size={16} />
          {error}
        </div>
      )}

      {loading ? (
        <LoadingState label="Fetching on-chain activity" className="min-h-[300px]" />
      ) : (
        <DataTable
          table={table}
          breakpoint="md"
          emptyMessage="No transfers found."
          header={rows.length > 0 && (
            <div className="flex items-center justify-between border-b border-border p-4">
              <div className="flex items-center gap-2">
                <Activity size={15} className="text-accent" />
                <span className="text-[10px] font-bold uppercase tracking-wide text-tertiary">Transfers</span>
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
            const transfer = row.original;
            return (
              <div key={row.id} className="bg-surface p-4">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="truncate text-sm font-semibold text-primary">{transfer.description}</span>
                      {transfer.is_error && (
                        <span className="shrink-0 border border-loss/20 bg-loss/10 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide text-loss">
                          Failed
                        </span>
                      )}
                    </div>
                    <div className="mt-1 flex flex-wrap items-center gap-2 text-[10px] uppercase tracking-wider text-tertiary">
                      <span>{formatDateDisplay(transfer.block_time)}</span>
                      <span>{transfer.chip}</span>
                    </div>
                  </div>
                  {/* Mirrors the desktop Amount cell exactly: a mobile view
                      that silently omits the at-the-time dollars would be a
                      different ledger on a smaller screen. */}
                  <div className="flex shrink-0 flex-col items-end">
                    <div className={`font-money text-sm font-bold ${transfer.outbound ? 'text-loss' : 'text-gain'}`}>
                      {transfer.outbound ? '-' : '+'}{transfer.quantity}
                    </div>
                    {transfer.usdAtTime && (
                      <div className="font-money text-[10px] text-tertiary">
                        {transfer.usdAtTime}{transfer.usdCarried && '*'}
                      </div>
                    )}
                  </div>
                </div>
                {transfer.walletName && (
                  <div className="mt-2 truncate text-[10px] text-crypto">{transfer.walletName}</div>
                )}
              </div>
            );
          }}
        />
      )}
    </section>
  );
};

export default OnChainActivity;

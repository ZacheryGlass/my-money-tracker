import React, { useState, useEffect, useRef } from 'react';
import { Activity, X, ExternalLink, EyeOff, RefreshCw, Tag, Wallet } from 'lucide-react';
import { eth as ethAPI } from '../utils/api';
import { formatDateDisplay } from '../utils/format';
import FilterTabs from './FilterTabs';
import LoadingState from './LoadingState';

export const shortEthAddress = (address) => (address ? `${address.slice(0, 6)}…${address.slice(-4)}` : 'unknown');

export const EthWalletBadge = () => (
  <span
    className="inline-flex h-5 w-5 items-center justify-center bg-purple-500/10 text-purple-400 border border-purple-500/20 shrink-0"
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
  Token: 'bg-purple-500/10 text-purple-400 border-purple-500/20',
};

const transferChipLabel = (transfer) => {
  if (transfer.transfer_type === 'gas') return 'Gas';
  if (transfer.counterparty_is_own) return 'Self';
  if (transfer.counterparty_exchange) return 'Exchange';
  return transfer.transfer_type === 'token' ? 'Token' : 'External';
};

const formatTransferQuantity = (transfer) => {
  const decimals = transfer.transfer_type === 'token'
    ? (transfer.token_decimals != null ? Number(transfer.token_decimals) : 18)
    : 18;
  const quantity = Number(transfer.value_wei) / 10 ** decimals;
  const symbol = transfer.transfer_type === 'token' ? (transfer.token_symbol || 'TOKEN') : 'ETH';
  return `${quantity.toLocaleString(undefined, { maximumFractionDigits: 6 })} ${symbol}`;
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
  // Exchange kinds only: this form labels exchanges, and the triage queue's
  // one-click verdicts mint 'external'/'own' rows whose names default to a bare
  // 0x1234…abcd, which would otherwise fill the typeahead with noise.
  useEffect(() => {
    let cancelled = false;
    ethAPI.getAddressLabels()
      .then((result) => {
        if (cancelled) return;
        const names = [...new Set(
          (result.labels || [])
            .filter((label) => !label.kind || label.kind === 'exchange')
            .map((label) => label.name)
        )];
        setLabelNames(names);
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [refreshKey]);

  const handleLabelAddress = async (event, counterparty) => {
    event.preventDefault();
    const name = labelName.trim();
    if (!name || savingLabel) return;
    setSavingLabel(true);
    setError(null);
    try {
      await ethAPI.labelAddress(counterparty, name);
      setLabelingId(null);
      setLabelName('');
      setRefreshKey((key) => key + 1);
      onDataChanged?.();
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to label address');
    } finally {
      setSavingLabel(false);
    }
  };

  return (
    <section>
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <Activity className="text-accent w-4 h-4" />
          <h2 className="text-xs font-bold uppercase tracking-wide text-secondary">On-chain Activity</h2>
        </div>
        {total > 0 && (
          <span className="text-[10px] font-bold text-accent px-2 py-0.5 rounded bg-accent/10 border border-accent/20">
            {total} Total
          </span>
        )}
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
        <LoadingState label="Fetching on-chain activity" className="py-12 card" />
      ) : rows.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-12 gap-2 card opacity-50">
          <Activity size={32} className="text-tertiary" />
          <p className="text-[10px] font-bold uppercase tracking-wide text-tertiary">No transfers found</p>
        </div>
      ) : (
        <>
          <div className="card divide-y divide-border overflow-hidden">
            {rows.map((transfer) => {
              // Per row, not per feed: a merged feed spans addresses, so asking
              // "did I send this?" against one wallet's address would invert the
              // direction of every row belonging to a different wallet.
              const outbound = transfer.transfer_type === 'gas'
                || transfer.from_address === transfer.wallet_address;
              const walletName = walletNames?.get(transfer.wallet_id);
              const chip = transferChipLabel(transfer);
              const counterparty = transfer.transfer_type === 'gas'
                ? null
                : outbound ? transfer.to_address : transfer.from_address;
              const exchangeName = !transfer.counterparty_is_own ? transfer.counterparty_exchange : null;
              const labelable = transfer.transfer_type !== 'gas'
                && !transfer.counterparty_is_own && !exchangeName && counterparty;
              return (
                <div key={transfer.id} className="px-4 py-3">
                <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                  <div className="flex min-w-0 items-center gap-3">
                    <span className={`inline-flex shrink-0 items-center px-2 py-0.5 text-[9px] font-bold uppercase tracking-wide border ${TRANSFER_CHIP_STYLES[chip]}`}>
                      {chip}
                    </span>
                    <div className="min-w-0">
                      <div className="flex min-w-0 items-center gap-2">
                        <span className="truncate text-sm font-bold text-primary" title={counterparty || undefined}>
                          {transfer.transfer_type === 'gas'
                            ? 'Gas fee'
                            : `${outbound ? 'To' : 'From'} ${exchangeName || shortEthAddress(counterparty)}`}
                        </span>
                        {transfer.is_error && (
                          <span className="inline-flex shrink-0 items-center px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide border border-loss/20 bg-loss/10 text-loss">
                            Failed
                          </span>
                        )}
                      </div>
                      <div className="mt-0.5 flex flex-wrap items-center gap-3 text-[10px] text-tertiary">
                        <span className="font-mono">{formatDateDisplay(transfer.block_time)}</span>
                        {walletName && (
                          <span
                            className="inline-flex max-w-[14rem] items-center gap-1 truncate text-purple-400"
                            title={walletName}
                          >
                            <Wallet size={10} className="shrink-0" />
                            {walletName}
                          </span>
                        )}
                        <a
                          href={`https://etherscan.io/tx/${transfer.tx_hash}`}
                          target="_blank"
                          rel="noreferrer"
                          className="inline-flex items-center gap-1 font-mono hover:text-accent transition-colors"
                          title={transfer.tx_hash}
                        >
                          {`${transfer.tx_hash.slice(0, 10)}…`}
                          <ExternalLink size={10} />
                        </a>
                      </div>
                    </div>
                  </div>

                  <div className="flex shrink-0 items-center gap-3 sm:justify-end">
                    <span className={`font-mono text-sm font-bold ${outbound ? 'text-loss' : 'text-gain'}`}>
                      {outbound ? '-' : '+'}{formatTransferQuantity(transfer)}
                    </span>
                    {labelable && (
                      <button
                        onClick={() => {
                          setLabelingId(labelingId === transfer.id ? null : transfer.id);
                          setLabelName('');
                        }}
                        title="Label this address (e.g. an exchange deposit address)"
                        className="inline-flex h-7 items-center justify-center gap-1.5 rounded border border-border bg-surface-3 px-2 text-[9px] font-bold uppercase tracking-wide text-tertiary transition-all hover:border-teal-500/30 hover:text-teal-400"
                      >
                        <Tag size={10} />
                        Label
                      </button>
                    )}
                    {transfer.transfer_type === 'token' && transfer.token_contract && (
                      <button
                        onClick={() => handleIgnoreToken(transfer)}
                        disabled={ignoringContract === transfer.token_contract}
                        title="Ignore this token everywhere"
                        className="inline-flex h-7 items-center justify-center gap-1.5 rounded border border-border bg-surface-3 px-2 text-[9px] font-bold uppercase tracking-wide text-tertiary transition-all hover:border-loss/30 hover:text-loss disabled:opacity-40"
                      >
                        {ignoringContract === transfer.token_contract
                          ? <RefreshCw size={10} className="animate-spin" />
                          : <EyeOff size={10} />}
                        Ignore
                      </button>
                    )}
                  </div>
                </div>
                {labelingId === transfer.id && (
                  <form
                    onSubmit={(event) => handleLabelAddress(event, counterparty)}
                    className="mt-2 flex items-center gap-2"
                  >
                    <input
                      type="text"
                      value={labelName}
                      onChange={(event) => setLabelName(event.target.value)}
                      list="eth-label-names"
                      maxLength={64}
                      placeholder="e.g. Coinbase"
                      autoFocus
                      className="h-8 w-44 min-w-0 rounded border border-input-border bg-surface-2 px-2 text-body-sm text-primary outline-none focus:ring-1 focus:ring-accent"
                    />
                    <button
                      type="submit"
                      disabled={savingLabel || !labelName.trim()}
                      className="inline-flex h-8 items-center justify-center gap-1.5 rounded border border-teal-500/30 bg-teal-500/10 px-3 text-[9px] font-bold uppercase tracking-wide text-teal-400 transition-all hover:bg-teal-500/20 disabled:opacity-40"
                    >
                      {savingLabel && <RefreshCw size={10} className="animate-spin" />}
                      Save
                    </button>
                    <button
                      type="button"
                      onClick={() => { setLabelingId(null); setLabelName(''); }}
                      className="inline-flex h-8 items-center justify-center rounded border border-border bg-surface-3 px-3 text-[9px] font-bold uppercase tracking-wide text-tertiary transition-all hover:text-primary"
                    >
                      Cancel
                    </button>
                  </form>
                )}
                </div>
              );
            })}
          </div>

          <div className="mt-3 flex items-center justify-between px-1">
            <span className="text-[10px] font-bold uppercase tracking-wide text-tertiary">
              Showing {rows.length} of {total}
            </span>
            {rows.length < total && (
              <button
                onClick={loadMore}
                disabled={loadingMore}
                className="inline-flex h-9 items-center justify-center gap-2 rounded border border-border bg-surface-3 px-4 text-xs font-bold uppercase tracking-wider text-secondary transition-all hover:border-accent hover:text-accent disabled:opacity-50"
              >
                {loadingMore && <RefreshCw size={12} className="animate-spin" />}
                Load More
              </button>
            )}
          </div>
        </>
      )}
    </section>
  );
};

export default OnChainActivity;

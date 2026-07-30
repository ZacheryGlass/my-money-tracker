import React, { useMemo, useState } from 'react';
import { motion as Motion, AnimatePresence } from 'framer-motion';
import { useReactTable, getCoreRowModel, getSortedRowModel } from '@tanstack/react-table';
import { AlertTriangle, ChevronDown, ChevronRight, History, Plus, RefreshCw, Unlink, Wallet } from 'lucide-react';
import { eth as ethAPI } from '../../utils/api';
import { formatExactUnits, formatRelativeTime, shortEthAddress as shortEthAddressOrUnknown } from '../../utils/format';
import { getAccountDisplayName } from '../../utils/accountDisplay';
import { explorerAddressUrl } from '../../utils/chains';
import DataTable from '../DataTable';
import { useIsMobile } from '../../hooks/useMediaQuery';

const ETH_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

// Addresses render inside fallback chains and sentences composed here, so a
// missing value must contribute nothing rather than 'unknown'.
const shortEthAddress = (address) => shortEthAddressOrUnknown(address, '');

const RECONCILIATION_SKIP_TEXT = {
  feed_gap: 'a data feed this chain could not serve',
  chain_unavailable: 'this chain is not readable with your Etherscan key',
  chain_error: 'this chain failed to sync',
  never_synced: 'this chain has not synced yet',
  lookup_budget: 'checked on a later sync',
  // Distinct from lookup_budget: without a key no later sync can check it.
  no_api_key: 'no Etherscan key is configured',
  live_fetch_failed: 'the balance lookup failed',
};

// The balance audit for one wallet: does the stored transfer ledger reproduce
// the balance the chain itself reports?
//
// Silence is the failure mode this exists to break, so the three outcomes look
// deliberately different: a clean audit says so in one muted line, an ETH delta
// is a loud alert (sync starts at block 0, so it can only mean a movement was
// never recorded), and a token delta is stated plainly with the offending
// contract named -- rebasing and fee-on-transfer tokens do this legitimately, so
// alarming about them would train the user to ignore the ETH case too.
const splitAuditIssues = (report) => ({
  nativeDrift: report.issues.filter((row) => row.status === 'mismatch' && row.asset_type === 'native'),
  tokenDrift: report.issues.filter((row) => row.status === 'mismatch' && row.asset_type === 'token'),
  unchecked: report.issues.filter((row) => row.status === 'skipped' || row.status === 'unavailable'),
});

// A signed base-unit string, negated -- the adjustment that zeroes a delta is
// its negation, and these values exceed Number precision, so this stays string
// arithmetic end to end.
const negateUnits = (units) => {
  const text = String(units ?? '');
  return text.startsWith('-') ? text.slice(1) : `-${text}`;
};

export function WalletReconciliation({ report, chainNames, walletId, onChanged, onError }) {
  // The adjustment form's state. Declared before the early return -- hooks
  // must run on every render.
  const [adjusting, setAdjusting] = useState(null);
  const [adjustAmount, setAdjustAmount] = useState('');
  const [adjustNote, setAdjustNote] = useState('');
  const [savingAdjustment, setSavingAdjustment] = useState(false);
  if (!report) return null;
  const chainName = (chainId) => chainNames?.get(Number(chainId)) || `Chain ${chainId}`;
  const { nativeDrift, tokenDrift, unchecked } = splitAuditIssues(report);
  const clean = !nativeDrift.length && !tokenDrift.length;

  // Every digit, never six. A drift under 1e-6 rendered at the default
  // precision prints as '0' (or '-0'), so the row would claim the ledger is
  // "0 ETH off" and then print the derived and chain figures identically --
  // three numbers that all say nothing is wrong, on a row that exists only
  // because something is.
  const amount = (row) => formatExactUnits(row.delta_units, row.token_decimals ?? 18) ?? '?';
  // The server names every asset it audits, native rows included (POL on
  // Polygon, ETH everywhere else), so this renders what it was told rather
  // than assuming the chain's native asset is ether.
  const symbolOf = (row) => row.token_symbol || (row.asset_type === 'native' ? 'ETH' : 'tokens');

  // Adjustments are keyed like verdict rows; a native key is a symbol, a token
  // key a contract. A token adjustment's decimals are not stored on it, so it
  // renders in base units rather than guessing a scale.
  const adjustmentAmount = (adj) => (adj.asset_key.startsWith('0x')
    ? `${adj.amount_wei} base units of ${shortEthAddress(adj.asset_key)}`
    : `${formatExactUnits(adj.amount_wei, 18)} ${adj.asset_key}`);

  const canAdjust = walletId != null && typeof onChanged === 'function';
  const amountValid = /^-?\d+$/.test(adjustAmount.trim()) && !/^-?0+$/.test(adjustAmount.trim());

  // The server's delta already includes adjustments, but derived_units stays
  // the RAW ledger figure -- so once an adjustment exists, delta beside raw
  // derived/live is three numbers whose arithmetic visibly fails. Sum this
  // row's adjustments as BigInt (these values exceed Number precision) and
  // show the adjusted derived beside the raw one, only where one exists.
  const adjustedDerived = (row) => {
    const forKey = (report.adjustments || []).filter(
      (adj) => Number(adj.chain_id) === Number(row.chain_id) && adj.asset_key === row.asset_key
    );
    if (!forKey.length) return null;
    try {
      return forKey.reduce((sum, adj) => sum + BigInt(adj.amount_wei), BigInt(row.derived_units)).toString();
    } catch {
      return null;
    }
  };

  const openAdjustForm = (row) => {
    setAdjusting(row);
    // Prefilled from the row's current delta: the adjustment that zeroes it is
    // the delta negated, so absorbing a known, explained drift is one note away.
    setAdjustAmount(negateUnits(row.delta_units));
    setAdjustNote('');
  };

  const submitAdjustment = async (event) => {
    event.preventDefault();
    if (savingAdjustment || !amountValid || !adjustNote.trim()) return;
    setSavingAdjustment(true);
    try {
      await ethAPI.addReconciliationAdjustment({
        walletId,
        chainId: adjusting.chain_id,
        assetKey: adjusting.asset_key,
        amountWei: adjustAmount.trim(),
        note: adjustNote.trim(),
      });
      setAdjusting(null);
      await onChanged();
    } catch (err) {
      onError?.(err.response?.data?.error || 'Failed to save the adjustment');
    } finally {
      setSavingAdjustment(false);
    }
  };

  const removeAdjustment = async (adjustment) => {
    try {
      await ethAPI.removeReconciliationAdjustment(adjustment.id);
      await onChanged();
    } catch (err) {
      onError?.(err.response?.data?.error || 'Failed to remove the adjustment');
    }
  };

  return (
    <div className="mt-5 space-y-3">
      {nativeDrift.length > 0 && (
        <div className="rounded border border-loss/20 bg-loss/5 p-4 text-xs leading-relaxed text-loss">
          <div className="flex items-start gap-3">
            <AlertTriangle size={14} className="mt-0.5 flex-shrink-0" />
            <div className="min-w-0">
              <p className="font-bold uppercase tracking-wide">Balance audit: coins unaccounted for</p>
              <p className="mt-1">
                Transfer history is synced from the first block, so the balance it adds up to should match
                the chain exactly. It does not, which means a movement is missing from the ledger.
              </p>
              <ul className="mt-2 space-y-1 font-mono text-[11px]">
                {nativeDrift.map((row) => {
                  const adjusted = adjustedDerived(row);
                  return (
                  <li key={`${row.chain_id}-${row.asset_key}`}>
                    {chainName(row.chain_id)}: ledger is {amount(row)} {symbolOf(row)} off
                    {' '}(derived {formatExactUnits(row.derived_units, 18)}
                    {adjusted != null ? `, with adjustments ${formatExactUnits(adjusted, 18)}` : ''}
                    , chain {formatExactUnits(row.live_units, 18)})
                    {canAdjust && (
                      <button
                        type="button"
                        onClick={() => openAdjustForm(row)}
                        className="ml-2 rounded border border-loss/30 px-1.5 py-0.5 font-sans text-[9px] font-bold uppercase tracking-wide hover:bg-loss/10"
                      >
                        Adjust
                      </button>
                    )}
                  </li>
                  );
                })}
              </ul>
              {adjusting && (
                // A documented correction to the AUDIT ONLY: holdings, the
                // ledger and spending never read it. The note is mandatory --
                // an adjustment without its explanation is indistinguishable
                // from fudging the audit until it stops talking.
                <form onSubmit={submitAdjustment} className="mt-3 space-y-2 rounded border border-loss/20 bg-surface p-3 text-secondary">
                  <p className="text-[11px]">
                    Absorb a known, explained drift on {chainName(adjusting.chain_id)} ({adjusting.asset_key}).
                    This adjusts the balance audit only; holdings and spending are untouched.
                  </p>
                  <label className="block text-[10px] uppercase tracking-wide text-tertiary">
                    Amount (base units, signed)
                    <input
                      type="text"
                      value={adjustAmount}
                      onChange={(event) => setAdjustAmount(event.target.value)}
                      spellCheck={false}
                      className="mt-1 block w-full rounded border border-input-border bg-surface-2 px-2 py-1 font-mono text-caption text-primary outline-none focus:ring-1 focus:ring-accent"
                    />
                  </label>
                  {/* The prefill is deliberately the WHOLE gap, and it must say
                      so: a large real loss should not be one unlabeled click
                      from being absorbed as "explained". */}
                  <p className="text-[10px] text-tertiary">
                    Prefilled with the amount that absorbs the entire remaining drift.
                    Lower it if only part of the gap is explained &mdash; the rest stays on display.
                  </p>
                  <label className="block text-[10px] uppercase tracking-wide text-tertiary">
                    Why (required)
                    <input
                      type="text"
                      value={adjustNote}
                      onChange={(event) => setAdjustNote(event.target.value)}
                      maxLength={500}
                      placeholder="e.g. Arbitrum classic-era fees Etherscan does not report"
                      className="mt-1 block w-full rounded border border-input-border bg-surface-2 px-2 py-1 text-caption text-primary outline-none focus:ring-1 focus:ring-accent"
                    />
                  </label>
                  <div className="flex gap-2">
                    <button
                      type="submit"
                      disabled={savingAdjustment || !amountValid || !adjustNote.trim()}
                      className="rounded border border-border bg-surface-3 px-2 py-1 text-[9px] font-bold uppercase tracking-wide text-secondary hover:border-accent hover:text-accent disabled:opacity-40"
                    >
                      Save adjustment
                    </button>
                    <button
                      type="button"
                      onClick={() => setAdjusting(null)}
                      className="rounded px-2 py-1 text-[9px] font-bold uppercase tracking-wide text-tertiary hover:text-primary"
                    >
                      Cancel
                    </button>
                  </div>
                </form>
              )}
            </div>
          </div>
        </div>
      )}

      {tokenDrift.length > 0 && (
        <div className="rounded border border-border bg-surface-3 p-4 text-xs leading-relaxed text-secondary">
          <p className="font-bold uppercase tracking-wide text-primary">Token balances that do not add up</p>
          <p className="mt-1">
            Rebasing and fee-on-transfer tokens change a balance without a transfer to record, so this is
            often harmless. If one of these is spam, ignore it on the Labels tab and it drops out of the audit.
          </p>
          <ul className="mt-2 space-y-1">
            {tokenDrift.map((row) => (
              <li key={`${row.chain_id}-${row.asset_key}`} className="font-mono text-[11px]">
                <span className="text-primary">{symbolOf(row)}</span>{' '}
                {/* The contract, not just a number: "your DAI is off by 3" is
                    unactionable when four contracts call themselves DAI. */}
                <span title={row.asset_key}>{shortEthAddress(row.asset_key)}</span>{' '}
                on {chainName(row.chain_id)} is {amount(row)} off
              </li>
            ))}
          </ul>
        </div>
      )}

      {clean && report.assets_checked > 0 && (
        <p className="text-[10px] font-bold uppercase tracking-wide text-tertiary">
          Balance audit: ledger matches the chain across {report.matched + report.dust} of{' '}
          {report.assets_checked} assets &middot; {formatRelativeTime(report.checked_at)}
        </p>
      )}

      {report.adjustments?.length > 0 && (
        // Always on display, matched rows included: a verdict that only
        // matches because of a correction must show the correction and its
        // note beside it, or the audit reads as having simply passed.
        <div className="rounded border border-border bg-surface-3 p-4 text-xs leading-relaxed text-secondary">
          <p className="font-bold uppercase tracking-wide text-primary">Audit adjustments</p>
          <p className="mt-1">
            Documented corrections summed into the audit&apos;s derived figure. They change the
            balance audit only; holdings, the ledger and spending never read them.
          </p>
          <ul className="mt-2 space-y-1">
            {report.adjustments.map((adjustment) => (
              <li key={adjustment.id} className="font-mono text-[11px]">
                {chainName(adjustment.chain_id)}: {adjustmentAmount(adjustment)}
                <span className="font-sans text-tertiary"> &mdash; {adjustment.note}</span>
                {canAdjust && (
                  <button
                    type="button"
                    onClick={() => removeAdjustment(adjustment)}
                    className="ml-2 rounded border border-border px-1.5 py-0.5 font-sans text-[9px] font-bold uppercase tracking-wide text-tertiary hover:border-loss/40 hover:text-loss"
                  >
                    Remove
                  </button>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      {unchecked.length > 0 && (
        // Stated rather than hidden. An audit that quietly omits what it could
        // not check reads as "everything is fine", which is the one thing it
        // must never say by accident.
        <p className="text-[10px] text-tertiary">
          Not checked this run:{' '}
          {unchecked.slice(0, 4).map((row) => (
            `${symbolOf(row)} on ${chainName(row.chain_id)} (${RECONCILIATION_SKIP_TEXT[row.skip_reason] || 'not compared'})`
          )).join('; ')}
          {unchecked.length > 4 ? ` and ${unchecked.length - 4} more` : ''}
          {report.truncated ? '. More assets are listed in the audit API.' : ''}
        </p>
      )}
    </div>
  );
}

// One line per wallet answering "can I trust this wallet's numbers?". The row
// carries the verdict and the expanded panel carries the evidence -- a table
// cannot hold the audit's several lines, but it must never round the audit down
// to silence either, so every state has words rather than only a colour.
const walletStatus = (wallet) => {
  if (wallet.error_code) return { label: 'Sync failed', tone: 'text-loss' };
  const report = wallet.reconciliation;
  if (!report) return { label: 'Not audited', tone: 'text-tertiary' };
  const { nativeDrift, tokenDrift } = splitAuditIssues(report);
  // Sync starts at block 0, so an ETH gap can only mean a movement was never
  // recorded. Token drift is often a rebasing contract, hence the quieter tone.
  if (nativeDrift.length) return { label: 'ETH unaccounted for', tone: 'text-loss' };
  if (tokenDrift.length) return { label: 'Token drift', tone: 'text-secondary' };
  if (report.assets_checked > 0) return { label: 'Matches chain', tone: 'text-tertiary' };
  return { label: 'Not audited', tone: 'text-tertiary' };
};

// A chain that is off keeps its history, so it is not counted as live here.
// The warning covers a chain this key cannot serve as well as one that failed:
// both mean the figures derived from it are incomplete, not merely stale.
const chainSummary = (wallet) => {
  const chains = wallet.chains || [];
  const live = chains.filter((chain) => chain.enabled);
  return {
    label: chains.length === 0 ? '—'
      : live.length === 1 ? live[0].name
      : `${live.length} chains`,
    degraded: chains.some((chain) => chain.enabled && (chain.error_code || chain.unsupported_feeds?.length > 0)),
  };
};

const ROW_ACTION_CLASS = 'inline-flex h-7 items-center gap-1.5 rounded border border-border bg-surface-3 px-2 text-[9px] font-bold uppercase tracking-wide text-tertiary transition-all hover:border-accent hover:text-accent disabled:opacity-40';

// The tracked-wallet list and everything that changes it: add, sync, disconnect.
// Moved off Settings with #75 -- a wallet is crypto data, not an app preference,
// and the add form was three clicks from the feed it fills.
function WalletsPanel({ wallets, onChanged, onError, showSuccess }) {
  const [addOpen, setAddOpen] = useState(false);
  const [walletAddress, setWalletAddress] = useState('');
  const [walletLabel, setWalletLabel] = useState('');
  const [formError, setFormError] = useState(null);
  const [bulkResults, setBulkResults] = useState(null);
  const [adding, setAdding] = useState(false);
  const [syncingId, setSyncingId] = useState(null);
  const [recapturing, setRecapturing] = useState(null);
  const [recaptureStartingId, setRecaptureStartingId] = useState(null);
  const [disconnecting, setDisconnecting] = useState(null);
  const [removeData, setRemoveData] = useState(true);
  const [expandedId, setExpandedId] = useState(null);
  const [sorting, setSorting] = useState([{ id: 'eth', desc: true }]);
  const isMobile = useIsMobile();

  // Same split the submit handler uses, so the count in the label and the
  // number of wallets actually created can never disagree.
  const addressCount = walletAddress.split(/[\s,;]+/).filter(Boolean).length;

  const openAddModal = () => {
    setWalletAddress('');
    setWalletLabel('');
    setFormError(null);
    setBulkResults(null);
    setAddOpen(true);
  };

  const handleAdd = async (event) => {
    event.preventDefault();
    if (adding) return;
    // One address per line is the documented format, but a pasted list often
    // arrives comma- or space-separated; an address contains neither, so
    // splitting on any of them cannot merge or truncate one.
    const entries = walletAddress.split(/[\s,;]+/).map((line) => line.trim()).filter(Boolean);
    if (entries.length === 0) {
      setFormError('Enter at least one EVM address');
      return;
    }
    const invalid = entries.filter((entry) => !ETH_ADDRESS_RE.test(entry));
    if (invalid.length) {
      setFormError(entries.length === 1
        ? 'Enter a valid EVM address (0x followed by 40 hex characters)'
        : `Not a valid EVM address: ${invalid.slice(0, 3).join(', ')}${invalid.length > 3 ? ` (+${invalid.length - 3} more)` : ''}`);
      return;
    }
    setAdding(true);
    setFormError(null);
    setBulkResults(null);
    try {
      if (entries.length === 1) {
        await ethAPI.addWallet(entries[0], walletLabel.trim() || undefined);
        // The first sync runs in the background; its result surfaces on the
        // wallet card (balance, last-synced, or an error badge).
        showSuccess('Wallet added. Syncing on-chain history in the background.');
        setAddOpen(false);
        setWalletAddress('');
        setWalletLabel('');
      } else {
        const { summary, results } = await ethAPI.addWallets(entries);
        if (summary.added) {
          showSuccess(`${summary.added} wallet${summary.added === 1 ? '' : 's'} added. Syncing on-chain history in the background.`);
        }
        if (summary.duplicate || summary.failed) {
          // Keep the modal open on a partial result: the per-address verdicts
          // are the only place the skipped lines are named.
          setBulkResults(results.filter((r) => r.status !== 'added'));
        } else {
          setAddOpen(false);
          setWalletAddress('');
          setWalletLabel('');
        }
      }
      await onChanged();
    } catch (err) {
      setFormError(err.response?.data?.error || 'Failed to add wallet');
      // A retried POST can land on DUPLICATE_WALLET after the first attempt
      // actually succeeded; refresh so the list reflects the existing wallet.
      if (err.response?.status === 409) await onChanged();
    } finally {
      setAdding(false);
    }
  };

  const handleSync = async (id) => {
    setSyncingId(id);
    onError(null);
    try {
      await ethAPI.syncWallet(id);
      showSuccess('Wallet synced successfully');
      await onChanged();
    } catch (err) {
      onError(err.response?.data?.error || 'Failed to sync wallet');
    } finally {
      setSyncingId(null);
    }
  };

  const handleRecaptureConfirm = async () => {
    const wallet = recapturing;
    setRecapturing(null);
    setRecaptureStartingId(wallet.id);
    onError(null);
    try {
      const result = await ethAPI.recaptureWallet(wallet.id);
      showSuccess(result.started
        ? 'Full-history recapture started. Notes and review decisions are preserved.'
        : 'That wallet is already being recaptured.');
      await onChanged();
    } catch (err) {
      onError(err.response?.data?.error || 'Failed to start full-history recapture');
    } finally {
      setRecaptureStartingId(null);
    }
  };

  const handleDisconnectConfirm = async () => {
    const id = disconnecting.id;
    const purge = removeData;
    setDisconnecting(null);
    try {
      await ethAPI.removeWallet(id, { removeData: purge });
      showSuccess(purge
        ? 'Wallet disconnected and data removed.'
        : 'Wallet disconnected. The account and its holdings were kept.');
      await onChanged();
    } catch (err) {
      onError(err.response?.data?.error || 'Failed to disconnect wallet');
    }
  };

  const walletName = (wallet) => wallet.label
    || (wallet.account ? getAccountDisplayName(wallet.account) : shortEthAddress(wallet.address));

  const toggleRow = (wallet) => setExpandedId((open) => (open === wallet.id ? null : wallet.id));

  // Every action sits inside a row that expands on click, so each one stops
  // the click reaching the row -- syncing a wallet and opening its audit are
  // different intentions.
  const rowActions = (wallet) => (
    <div className="flex items-center justify-end gap-1" onClick={(event) => event.stopPropagation()}>
      {/* One address, several chains: the wallet has no single chain to link
          against, and an address page exists on every explorer anyway. */}
      <a
        href={explorerAddressUrl(wallet.address)}
        target="_blank"
        rel="noreferrer"
        className={ROW_ACTION_CLASS}
      >
        Explorer
      </a>
      <button
        type="button"
        onClick={() => handleSync(wallet.id)}
        disabled={syncingId === wallet.id}
        aria-label={`Sync ${walletName(wallet)}`}
        className={ROW_ACTION_CLASS}
      >
        <RefreshCw size={10} className={syncingId === wallet.id ? 'animate-spin' : ''} />
        Sync
      </button>
      <button
        type="button"
        onClick={() => setRecapturing(wallet)}
        disabled={syncingId === wallet.id || recaptureStartingId === wallet.id}
        aria-label={`Recapture full history for ${walletName(wallet)}`}
        className={ROW_ACTION_CLASS}
        title="Re-fetch every chain from genesis while preserving notes and review decisions"
      >
        <History size={10} />
        Recapture
      </button>
      <button
        type="button"
        onClick={() => { setRemoveData(true); setDisconnecting(wallet); }}
        aria-label={`Disconnect ${walletName(wallet)}`}
        className="rounded border border-transparent p-1.5 text-tertiary transition-all hover:bg-loss/10 hover:text-loss"
        title="Disconnect Wallet"
      >
        <Unlink size={14} />
      </button>
    </div>
  );

  const columns = useMemo(() => [
    {
      id: 'wallet',
      accessorFn: (wallet) => walletName(wallet),
      header: 'Wallet',
      meta: { cellClassName: 'min-w-0' },
      cell: ({ row }) => {
        const wallet = row.original;
        return (
          <div className="flex min-w-0 items-center gap-1.5">
            {expandedId === wallet.id
              ? <ChevronDown size={11} className="shrink-0 text-accent" />
              : <ChevronRight size={11} className="shrink-0 text-tertiary" />}
            <div className="min-w-0">
              <span className="block truncate text-body-sm font-semibold text-primary">{walletName(wallet)}</span>
              <span className="block truncate font-mono text-[10px] text-tertiary" title={wallet.address}>
                {shortEthAddress(wallet.address)}
              </span>
            </div>
          </div>
        );
      },
    },
    {
      id: 'chains',
      accessorFn: (wallet) => chainSummary(wallet).label,
      header: 'Chains',
      meta: { width: '9rem', cellClassName: 'whitespace-nowrap' },
      cell: ({ row }) => {
        const { label, degraded } = chainSummary(row.original);
        return (
          <span className={`inline-flex items-center gap-1.5 text-caption ${degraded ? 'text-loss' : 'text-secondary'}`}>
            {degraded && <AlertTriangle size={11} className="shrink-0" />}
            {label}
          </span>
        );
      },
    },
    {
      id: 'eth',
      accessorFn: (wallet) => (wallet.eth_quantity != null ? parseFloat(wallet.eth_quantity) : null),
      header: 'ETH',
      meta: { width: '8rem', align: 'right', headerClassName: 'text-right', cellClassName: 'whitespace-nowrap text-right' },
      cell: ({ getValue }) => {
        const quantity = getValue();
        return quantity != null
          ? <span className="font-money text-body-sm text-secondary">{quantity.toLocaleString(undefined, { maximumFractionDigits: 4 })}</span>
          : <span className="text-tertiary">—</span>;
      },
    },
    {
      id: 'synced',
      accessorFn: (wallet) => wallet.last_synced_at || '',
      header: 'Synced',
      meta: { width: '8rem', cellClassName: 'whitespace-nowrap text-caption text-tertiary' },
      cell: ({ row }) => formatRelativeTime(row.original.last_synced_at),
    },
    {
      id: 'status',
      accessorFn: (wallet) => walletStatus(wallet).label,
      header: 'Status',
      meta: { width: '11rem', cellClassName: 'whitespace-nowrap' },
      cell: ({ row }) => {
        const status = walletStatus(row.original);
        return <span className={`text-caption ${status.tone}`}>{status.label}</span>;
      },
    },
    {
      id: 'actions',
      header: '',
      enableSorting: false,
      meta: { width: '13rem', headerClassName: 'text-right', cellClassName: 'text-right' },
      cell: ({ row }) => rowActions(row.original),
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
  ], [expandedId, syncingId]);

  const table = useReactTable({
    data: wallets,
    columns,
    state: { sorting },
    onSortingChange: setSorting,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
  });

  // Everything a row cannot hold: the per-chain strip, the sync error in full,
  // and the balance audit. The row states the verdict; this states the case.
  const walletDetail = (wallet) => (
    <div className="space-y-3 px-4 py-4">
      {wallet.chains?.length > 0 && (
        <div className="flex flex-wrap items-center gap-2">
          {wallet.chains.map((chain) => (
            <span
              key={chain.chain_id}
              title={chain.error_message
                || (chain.enabled ? `Last synced ${formatRelativeTime(chain.last_synced_at)}` : 'Chain turned off; stored history kept')}
              className={`inline-flex items-center gap-1.5 px-2 py-1 rounded border text-[10px] font-bold uppercase tracking-wide ${
                !chain.enabled ? 'bg-surface-3 border-border text-tertiary'
                  : chain.error_code ? 'bg-loss/5 border-loss/20 text-loss'
                  : 'bg-surface-3 border-border text-secondary'
              }`}
            >
              {chain.enabled && chain.error_code && <AlertTriangle size={10} />}
              {chain.name}
              {!chain.enabled && <span className="font-normal normal-case">off</span>}
              {chain.unsupported_feeds?.length > 0 && (
                <span className="font-normal normal-case">
                  no {chain.unsupported_feeds.join(', ')}
                </span>
              )}
            </span>
          ))}
        </div>
      )}

      {wallet.error_code && (
        <div className="rounded border border-loss/20 bg-loss/5 p-3 text-xs leading-relaxed text-loss">
          <div className="flex items-start gap-3">
            <AlertTriangle size={14} className="mt-0.5 flex-shrink-0" />
            <p>{wallet.error_message || `Wallet sync reported an error: ${wallet.error_code}`}</p>
          </div>
        </div>
      )}

      {/* The audit rides along on the wallets response, so this needs no second
          request and cannot disagree with the row's status. Chain names come
          from the wallet's own chain rows, which the server already labelled
          from the registry. */}
      {wallet.reconciliation ? (
        <WalletReconciliation
          report={wallet.reconciliation}
          chainNames={new Map((wallet.chains || []).map((chain) => [Number(chain.chain_id), chain.name]))}
          walletId={wallet.id}
          onChanged={onChanged}
          onError={onError}
        />
      ) : (
        // Never audited and audited-clean are different claims, and the row
        // says "Not audited" for both a fresh wallet and one whose audit
        // failed -- so the panel says which.
        <p className="text-[10px] text-tertiary">
          No balance audit yet. It runs with the wallet&apos;s next sync.
        </p>
      )}
    </div>
  );

  return (
    <section>
      <div className="mb-3 flex flex-wrap items-end justify-between gap-3 px-2">
        <div>
          <h2 className="text-lg font-bold uppercase tracking-tight text-primary">EVM Wallets</h2>
          <p className="mt-1 text-xs text-secondary">Track any EVM address across configured chain explorers: native and token balances, transfers between your own wallets, external transfers, and gas fees.</p>
        </div>
        {wallets.length > 0 && (
          <button
            onClick={openAddModal}
            className="inline-flex items-center justify-center gap-2 rounded border border-crypto-border bg-crypto-bg px-4 py-2.5 text-xs font-bold uppercase tracking-wider text-crypto transition-all hover:bg-crypto-bg-hover hover:text-crypto-hover"
          >
            <Plus size={14} />
            Add Wallet
          </button>
        )}
      </div>

      {wallets.length === 0 ? (
        <div className="card p-12 text-center border-dashed border-2 border-border bg-transparent">
          <Wallet size={40} className="mx-auto text-tertiary mb-4 opacity-20" />
          <h3 className="text-lg font-bold text-primary mb-2 uppercase tracking-tight">No Wallets Tracked</h3>
          <p className="text-sm text-secondary max-w-md mx-auto leading-relaxed mb-5">
            Add an EVM address to pull its balance and full transfer history. Transfers between your
            own tracked wallets are recognized automatically.
          </p>
          <button
            onClick={openAddModal}
            className="inline-flex items-center justify-center gap-2 px-5 py-2.5 rounded text-xs font-bold uppercase tracking-wider text-crypto bg-crypto-bg border border-crypto-border hover:bg-crypto-bg-hover hover:text-crypto-hover transition-all"
          >
            <Wallet size={14} />
            Connect Crypto
          </button>
        </div>
      ) : (
        <DataTable
          table={table}
          breakpoint="md"
          emptyMessage="No wallets tracked."
          onRowClick={toggleRow}
          rowClassName={() => 'cursor-pointer'}
          // ONE mount, never two. DataTable keeps the desktop table and the
          // mobile list both in the DOM and hides one with CSS, so rendering
          // the panel from both paths would duplicate every aria label in it.
          renderRowDetail={(row) => (!isMobile && expandedId === row.original.id
            ? walletDetail(row.original)
            : null)}
          renderMobileRow={(row) => {
            const wallet = row.original;
            const status = walletStatus(wallet);
            const open = expandedId === wallet.id;
            return (
              <div key={row.id} className="bg-surface p-3" onClick={() => toggleRow(wallet)}>
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="truncate text-body-sm font-semibold text-primary">{walletName(wallet)}</p>
                    <p className="truncate font-mono text-[10px] text-tertiary">{shortEthAddress(wallet.address)}</p>
                  </div>
                  <div className="shrink-0 text-right">
                    {wallet.eth_quantity != null && (
                      <p className="font-money text-body-sm text-secondary">
                        {parseFloat(wallet.eth_quantity).toLocaleString(undefined, { maximumFractionDigits: 4 })} ETH
                      </p>
                    )}
                    <p className={`text-[10px] ${status.tone}`}>{status.label}</p>
                  </div>
                </div>
                <div className="mt-2 flex items-center justify-between gap-2">
                  <span className="text-[10px] uppercase tracking-wider text-tertiary">
                    {formatRelativeTime(wallet.last_synced_at)}
                  </span>
                  {rowActions(wallet)}
                </div>
                {open && isMobile && (
                  <div onClick={(event) => event.stopPropagation()}>{walletDetail(wallet)}</div>
                )}
              </div>
            );
          }}
        />
      )}

      {/* Connect Crypto Modal */}
      <AnimatePresence>
        {addOpen && (
          <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-center sm:p-4">
            <Motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="absolute inset-0 bg-black/70" onClick={() => setAddOpen(false)} />
            <Motion.div initial={{ opacity: 0, scale: 0.9, y: 20 }} animate={{ opacity: 1, scale: 1, y: 0 }} exit={{ opacity: 0, scale: 0.9, y: 20 }} role="dialog" aria-modal="true" aria-labelledby="crypto-modal-title" className="relative max-h-[100dvh] w-full max-w-lg overflow-y-auto border border-border bg-surface shadow-2xl sm:max-h-[92vh] sm:rounded-3xl">
              <form onSubmit={handleAdd}>
                <div className="p-5 pb-3 text-center sm:p-8 sm:pb-4">
                  <div className="w-16 h-16 bg-crypto-bg text-crypto rounded-full flex items-center justify-center mx-auto mb-6">
                    <Wallet size={28} />
                  </div>
                  <h2 id="crypto-modal-title" className="text-2xl font-bold text-primary mb-2 tracking-tight">Connect Crypto Wallet</h2>
                  <p className="text-sm text-secondary leading-relaxed">
                    Paste an EVM address to track its balances and transfer history across configured chains. Paste several, one per line, to add them all at once.
                  </p>
                </div>

                <div className="space-y-4 p-5 sm:p-8 sm:pt-2">
                  {/* A 42-character address on one line is what makes a pasted
                      list scannable, so the type steps down from the form
                      default and wrapping is off outright: at a larger text
                      scale it would wrap again, and half an address on the
                      next line reads as another entry. */}
                  <label className="block text-caption text-tertiary">
                    {addressCount > 1 ? `Addresses (${addressCount})` : 'Address'}
                    <textarea
                      value={walletAddress}
                      onChange={(event) => setWalletAddress(event.target.value)}
                      placeholder="0x…&#10;0x… (one per line)"
                      spellCheck={false}
                      autoComplete="off"
                      autoFocus
                      rows={addressCount > 1 ? 6 : 3}
                      wrap="off"
                      className="mt-1 block w-full min-w-0 resize-y overflow-x-auto rounded border border-input-border bg-surface-2 px-3 py-2 font-mono text-caption text-primary outline-none focus:ring-1 focus:ring-accent"
                      disabled={adding}
                    />
                  </label>
                  {/* A label names ONE wallet, so it is disabled for a pasted
                      batch rather than applied to every address in it. */}
                  <label className="block text-caption text-tertiary">
                    Label (optional)
                    <input
                      type="text"
                      value={walletLabel}
                      onChange={(event) => setWalletLabel(event.target.value)}
                      maxLength={100}
                      placeholder={addressCount > 1 ? 'Not used when adding several addresses' : 'Cold storage'}
                      className="mt-1 block h-11 w-full min-w-0 rounded border border-input-border bg-surface-2 px-3 text-body-sm text-primary outline-none focus:ring-1 focus:ring-accent disabled:opacity-40"
                      disabled={adding || addressCount > 1}
                    />
                  </label>

                  {formError && (
                    <div role="alert" className="flex items-start gap-2 rounded border border-loss/20 bg-loss/5 p-3 text-caption text-loss">
                      <AlertTriangle size={14} className="mt-0.5 shrink-0" />
                      <span>{formError}</span>
                    </div>
                  )}

                  {bulkResults?.length > 0 && (
                    <div role="alert" className="space-y-1 rounded border border-border bg-surface-2 p-3 text-caption text-tertiary">
                      <p className="text-secondary">These addresses were not added:</p>
                      {bulkResults.map((result) => (
                        <p key={result.address} className="flex flex-wrap items-baseline gap-2">
                          <span className="font-mono text-primary">{result.address}</span>
                          <span>{result.error}</span>
                        </p>
                      ))}
                    </div>
                  )}

                  <p className="text-caption text-tertiary">
                    The first sync runs in the background; a busy wallet can take a few minutes to appear complete. Use Sync on the wallet card to refresh.
                  </p>
                </div>

                <div className="sticky bottom-0 flex gap-3 bg-surface p-5 pt-0 sm:static sm:p-8 sm:pt-0">
                  <button
                    type="button"
                    onClick={() => setAddOpen(false)}
                    className="flex-1 py-4 bg-surface-3 text-secondary hover:text-primary rounded text-xs font-bold uppercase tracking-wider transition-all"
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    disabled={adding}
                    className="flex-1 inline-flex items-center justify-center gap-2 py-4 bg-crypto-bg-hover text-crypto border border-crypto-border rounded text-xs font-bold uppercase tracking-wider hover:bg-crypto-bg-strong hover:text-crypto-hover transition-all disabled:opacity-40"
                  >
                    {adding ? <RefreshCw size={14} className="animate-spin" /> : <Plus size={14} />}
                    {addressCount > 1 ? `Track ${addressCount} Wallets` : 'Track Wallet'}
                  </button>
                </div>
              </form>
            </Motion.div>
          </div>
        )}
      </AnimatePresence>

      {/* Wallet Disconnect Confirm Modal */}
      <AnimatePresence>
        {disconnecting && (
          <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-center sm:p-4">
            <Motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="absolute inset-0 bg-black/70" onClick={() => setDisconnecting(null)} />
            <Motion.div initial={{ opacity: 0, scale: 0.9, y: 20 }} animate={{ opacity: 1, scale: 1, y: 0 }} exit={{ opacity: 0, scale: 0.9, y: 20 }} className="relative max-h-[100dvh] w-full max-w-lg overflow-y-auto border border-border bg-surface shadow-2xl sm:max-h-[92vh] sm:rounded-3xl">
              <div className="p-5 pb-3 text-center sm:p-8 sm:pb-4">
                <div className="w-16 h-16 bg-loss/10 text-loss rounded-full flex items-center justify-center mx-auto mb-6">
                  <Unlink size={28} />
                </div>
                <h2 className="text-2xl font-bold text-primary mb-2 tracking-tight">Disconnect Wallet</h2>
                <p className="text-sm text-secondary leading-relaxed">
                  You are about to stop tracking <span className="font-mono text-primary font-bold">{shortEthAddress(disconnecting.address)}</span>. How should we handle existing data?
                </p>
              </div>

              <div className="space-y-3 p-5 sm:p-8">
                <button
                  onClick={() => setRemoveData(true)}
                  className={`w-full flex items-start gap-4 p-4 rounded border text-left transition-all ${removeData ? 'border-accent bg-accent/5 ring-1 ring-accent/20' : 'border-border hover:border-border-hover bg-surface-2'}`}
                >
                  <div className={`mt-1 w-4 h-4 rounded-full border-2 flex items-center justify-center ${removeData ? 'border-accent' : 'border-tertiary'}`}>
                    {removeData && <div className="w-2 h-2 rounded-full bg-accent" />}
                  </div>
                  <div>
                    <p className="text-sm font-bold text-primary">Full Purge (Recommended)</p>
                    <p className="text-[11px] text-secondary mt-0.5">Delete the account, holdings, transfer history, and historical data for this wallet.</p>
                  </div>
                </button>

                <button
                  onClick={() => setRemoveData(false)}
                  className={`w-full flex items-start gap-4 p-4 rounded border text-left transition-all ${!removeData ? 'border-accent bg-accent/5 ring-1 ring-accent/20' : 'border-border hover:border-border-hover bg-surface-2'}`}
                >
                  <div className={`mt-1 w-4 h-4 rounded-full border-2 flex items-center justify-center ${!removeData ? 'border-accent' : 'border-tertiary'}`}>
                    {!removeData && <div className="w-2 h-2 rounded-full bg-accent" />}
                  </div>
                  <div>
                    <p className="text-sm font-bold text-primary">Unlink &amp; Keep Data</p>
                    <p className="text-[11px] text-secondary mt-0.5">Stop syncing. The account and its current holdings become manual entries; on-chain transfer history is removed.</p>
                  </div>
                </button>
              </div>

              <div className="sticky bottom-0 flex gap-3 bg-surface p-5 pt-0 sm:static sm:p-8 sm:pt-0">
                <button
                  onClick={() => setDisconnecting(null)}
                  className="flex-1 py-4 bg-surface-3 text-secondary hover:text-primary rounded text-xs font-bold uppercase tracking-wider transition-all"
                >
                  Cancel
                </button>
                <button
                  onClick={handleDisconnectConfirm}
                  className="flex-1 py-4 bg-loss text-white rounded text-xs font-bold uppercase tracking-wider hover:opacity-90 transition-all"
                >
                  Confirm Disconnect
                </button>
              </div>
            </Motion.div>
          </div>
        )}
      </AnimatePresence>

      {/* Full-history replay is safe for annotations but expensive enough to
          require a deliberate second click. It resets no wallet row and
          deletes no source evidence until a replacement feed has succeeded. */}
      <AnimatePresence>
        {recapturing && (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
            <Motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="absolute inset-0 bg-black/70" onClick={() => setRecapturing(null)} />
            <Motion.div initial={{ opacity: 0, scale: 0.97 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.97 }} className="relative w-full max-w-lg rounded border border-border bg-surface p-6 shadow-2xl">
              <h2 className="mb-2 text-2xl font-bold tracking-tight text-primary">Recapture full history?</h2>
              <p className="mb-5 text-sm text-secondary">
                Every enabled chain for {walletName(recapturing)} will be re-fetched from genesis.
                Transaction notes, address notes, labels, category overrides, spam decisions, and
                reconciliation adjustments are preserved.
              </p>
              <div className="flex justify-end gap-3">
                <button type="button" onClick={() => setRecapturing(null)} className="rounded border border-border px-4 py-2 text-sm font-semibold text-secondary hover:text-primary">
                  Cancel
                </button>
                <button type="button" onClick={handleRecaptureConfirm} className="rounded bg-accent px-4 py-2 text-sm font-bold text-white hover:bg-accent-hover">
                  Start recapture
                </button>
              </div>
            </Motion.div>
          </div>
        )}
      </AnimatePresence>
    </section>
  );
}

export default WalletsPanel;

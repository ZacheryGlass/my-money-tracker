import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Check, ChevronDown, ChevronRight, ExternalLink, RefreshCw, Tag, Undo2 } from 'lucide-react';
import { crypto as cryptoAPI, eth as ethAPI } from '../../../utils/api';
import { formatDateDisplay, formatUsdAtTime } from '../../../utils/format';
import { formatLedgerCategory } from '../../../utils/dataLabels';
import { explorerTxUrl, networkName } from '../../../utils/chains';
import LoadingState from '../../../components/LoadingState';
import { ConfirmDialog } from '../../../components/Modal';
import { LedgerRowDetail } from '../../../components/CryptoLedger';
import { enrichLedgerRow } from '../ledgerRows';
import LoadFailed from '../LoadFailed';
import CounterpartyVerdictForm from '../CounterpartyVerdictForm';
import { fixStatesReason, groupReviewRows, suggestedFix } from './grouping';
import { markRowReviewed, undoMarkReviewed } from './markReviewed';

// The server caps a page at 500; a queue longer than that drains page by page.
const QUEUE_LIMIT = 500;
const UNDO_MS = 15_000;
// Small groups open by default: two rows are faster to read than to expand.
const AUTO_OPEN_SIZE = 3;

// The ledger's composite id: an on-chain row_id is eth_activity.id, which a
// rebuild (every label write and sync) renumbers -- keying on it closed the
// open row after every save.
const rowKey = (row) => row.id || `${row.source}:${row.row_id}`;

// The Review page's transaction queue: every unexplained ledger row, grouped
// so a run of identical problems is one decision rather than sixteen. Each
// group says what would explain it and offers that action; any row still opens
// into the ledger's own detail panel for a one-off correction.
export default function TransactionQueue({
  refreshKey = 0,
  addressNotes = [],
  exchangeNameOptions = [],
  onDataChanged,
  // The row detail calls this unguarded, so it always has to be a function.
  onError = () => {},
  showSuccess,
  onOpenExchanges,
  onOpenBridges,
}) {
  const [rows, setRows] = useState(undefined);
  const [reload, setReload] = useState(0);
  const [openGroups, setOpenGroups] = useState(() => new Set());
  const [openRowKey, setOpenRowKey] = useState(null);
  const [labelingGroup, setLabelingGroup] = useState(null);
  const [labelBusy, setLabelBusy] = useState(false);
  const [confirmGroup, setConfirmGroup] = useState(null);
  const [progress, setProgress] = useState(null);
  const [undo, setUndo] = useState(null);
  const undoTimer = useRef(null);
  const notes = useMemo(() => new Map(addressNotes.map((item) => [item.address, item.note])), [addressNotes]);

  const load = useCallback(async () => {
    try {
      const result = await cryptoAPI.getLedger({ needsReview: 'true', limit: QUEUE_LIMIT, offset: 0 });
      setRows((result.data || []).map(enrichLedgerRow));
    } catch {
      setRows((current) => (current === undefined ? null : current));
    }
  }, []);
  useEffect(() => { load(); }, [load, reload, refreshKey]);
  useEffect(() => () => clearTimeout(undoTimer.current), []);

  const groups = useMemo(() => groupReviewRows(rows || []), [rows]);

  // A resolve re-derives what the rest of the page shows (badges, counts), so
  // the parent refreshes too; the queue reloads itself first so the row
  // disappears under the user's hand rather than after the page catches up.
  const changed = useCallback(async () => {
    setReload((n) => n + 1);
    await onDataChanged?.();
  }, [onDataChanged]);

  const markGroup = async (group) => {
    setConfirmGroup(null);
    const targets = [];
    setProgress({ key: group.key, done: 0, total: group.rows.length });
    onError?.(null);
    let failed = 0;
    for (const [index, row] of group.rows.entries()) {
      try {
        const target = await markRowReviewed(row);
        if (target) targets.push(target);
      } catch {
        failed += 1;
      }
      setProgress({ key: group.key, done: index + 1, total: group.rows.length });
    }
    setProgress(null);
    const marked = group.rows.length - failed;
    if (failed) onError?.(`${failed} of ${group.rows.length} could not be marked reviewed; they are still in the queue.`);
    if (marked) {
      clearTimeout(undoTimer.current);
      setUndo({ count: marked, targets });
      undoTimer.current = setTimeout(() => setUndo(null), UNDO_MS);
    }
    await changed();
  };

  const undoMarked = async () => {
    const pending = undo;
    setUndo(null);
    clearTimeout(undoTimer.current);
    try {
      for (const target of pending.targets) await undoMarkReviewed(target);
      showSuccess?.(`${pending.targets.length} returned to the queue`);
    } catch (err) {
      onError?.(err.response?.data?.error || 'Could not undo all of them');
    }
    await changed();
  };

  const labelGroup = async (group, { name, kind }) => {
    setLabelBusy(true);
    onError?.(null);
    try {
      await ethAPI.labelAddress(group.counterpartyAddress, name || null, { kind });
      setLabelingGroup(null);
      showSuccess?.(`Labeled ${name || 'the address'}; its transfers were reclassified`);
      await changed();
    } catch (err) {
      onError?.(err.response?.data?.error || 'Failed to label that address');
    } finally {
      setLabelBusy(false);
    }
  };

  const toggleGroup = (key) => setOpenGroups((current) => {
    const next = new Set(current);
    if (next.has(key)) next.delete(key); else next.add(key);
    return next;
  });

  if (rows === undefined) return <LoadingState label="Loading transactions to review" className="min-h-[160px]" />;
  if (rows === null) return <LoadFailed message="Couldn't load the transactions to review." onRetry={load} />;

  // Above everything, the empty state included: the last group marked is the
  // one most likely to need its undo.
  const undoBanner = undo && (
    <div role="status" className="flex flex-wrap items-center justify-between gap-2 border border-gain/20 bg-gain-bg p-3 text-body-sm text-gain">
      <span>Marked {undo.count} reviewed.</span>
      {undo.targets.length > 0 && (
        <button type="button" onClick={undoMarked} className="inline-flex items-center gap-1 text-caption font-semibold underline hover:text-primary">
          <Undo2 size={12} /> Undo
        </button>
      )}
    </div>
  );

  if (groups.length === 0) {
    return (
      <section className="space-y-3" aria-label="Transactions to review">
        {undoBanner}
        <div className="card flex items-center gap-2 p-6 text-body-sm text-gain">
          <Check size={14} />
          Every transaction is explained.
        </div>
      </section>
    );
  }

  return (
    <section className="space-y-3" aria-label="Transactions to review">
      {undoBanner}
      {rows.length >= QUEUE_LIMIT && (
        <p className="text-caption text-tertiary">Showing the first {QUEUE_LIMIT}; more appear as these are resolved.</p>
      )}

      {groups.map((group) => {
        const open = openGroups.has(group.key) || group.rows.length <= AUTO_OPEN_SIZE;
        const busy = progress?.key === group.key;
        const exchangeFlow = group.source === 'onchain'
          && (group.category === 'exchange_deposit' || group.category === 'exchange_withdrawal');
        const bridgeFlow = group.category === 'bridge_out' || group.category === 'bridge_in';
        const labelable = group.perParty && group.rows[0]?.labelable && group.counterpartyAddress;
        return (
          <article key={group.key} className="card overflow-hidden">
            <div className="space-y-2 p-4">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <h3 className="text-body-sm font-semibold text-primary">
                  {group.rows.length} × {formatLedgerCategory(group.category)}
                  <span className="font-normal text-secondary">
                    {' · '}{group.parties.slice(0, 3).join(', ')}{group.parties.length > 3 ? `, +${group.parties.length - 3} more` : ''}
                  </span>
                </h3>
                <span className="font-money text-body-sm text-secondary">
                  {group.usdTotal > 0 ? formatUsdAtTime(group.usdTotal, 'exact') : ''}
                  {group.unpriced > 0 ? <span className="text-tertiary">{group.usdTotal > 0 ? ' + ' : ''}{group.unpriced} without a price</span> : null}
                </span>
              </div>
              {group.reason && !fixStatesReason(group) && <p className="text-caption text-tertiary">{group.reason}</p>}
              <p className="text-body-sm text-secondary">{suggestedFix(group)}</p>

              <div className="flex flex-wrap items-center gap-2 pt-1">
                {labelable && labelingGroup !== group.key && (
                  <button
                    type="button"
                    onClick={() => setLabelingGroup(group.key)}
                    className="inline-flex h-8 items-center gap-1.5 rounded border border-teal-500/30 bg-teal-500/10 px-3 text-[10px] font-bold uppercase tracking-wide text-teal-400 hover:bg-teal-500/20"
                  >
                    <Tag size={11} /> Label <span className="font-mono normal-case">{group.parties[0]}</span>
                  </button>
                )}
                {exchangeFlow && onOpenExchanges && (
                  <button
                    type="button"
                    onClick={() => onOpenExchanges()}
                    className="inline-flex h-8 items-center gap-1.5 rounded border border-border bg-surface-3 px-3 text-[10px] font-bold uppercase tracking-wide text-secondary hover:border-accent hover:text-accent"
                  >
                    Open Exchanges
                  </button>
                )}
                {bridgeFlow && onOpenBridges && (
                  <button
                    type="button"
                    onClick={() => onOpenBridges()}
                    className="inline-flex h-8 items-center gap-1.5 rounded border border-border bg-surface-3 px-3 text-[10px] font-bold uppercase tracking-wide text-secondary hover:border-accent hover:text-accent"
                  >
                    Open Bridges
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => setConfirmGroup(group)}
                  disabled={progress != null}
                  className="inline-flex h-8 items-center gap-1.5 rounded border border-gain/30 bg-gain/10 px-3 text-[10px] font-bold uppercase tracking-wide text-gain hover:bg-gain/20 disabled:opacity-40"
                >
                  {busy ? <RefreshCw size={11} className="animate-spin" /> : <Check size={11} />}
                  {busy
                    ? `Marking ${progress.done} of ${progress.total}…`
                    : group.rows.length === 1 ? 'Mark reviewed' : `Mark all ${group.rows.length} reviewed`}
                </button>
                {group.rows.length > AUTO_OPEN_SIZE && (
                  <button
                    type="button"
                    onClick={() => toggleGroup(group.key)}
                    aria-expanded={open}
                    className="inline-flex h-8 items-center gap-1 px-1 text-caption text-tertiary hover:text-primary"
                  >
                    {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                    {open ? 'Hide' : 'Show'} {group.rows.length} transactions
                  </button>
                )}
              </div>

              {labelingGroup === group.key && (
                <div className="border-t border-border pt-3">
                  <CounterpartyVerdictForm
                    allowKeep={false}
                    nameOptions={exchangeNameOptions}
                    busy={labelBusy}
                    submitLabel={`Label and explain ${group.rows.length}`}
                    onSubmit={(values) => labelGroup(group, values)}
                    onCancel={() => setLabelingGroup(null)}
                  />
                </div>
              )}
            </div>

            {open && (
              <ul className="divide-y divide-border border-t border-border">
                {group.rows.map((row) => {
                  const key = rowKey(row);
                  const rowOpen = openRowKey === key;
                  const href = row.source === 'onchain' && row.tx_hash ? explorerTxUrl(row.tx_hash, row.chain_id) : null;
                  const usd = formatUsdAtTime(row.usd_value, row.usd_basis);
                  return (
                    <li key={key}>
                      <div className="flex items-center gap-2 px-4 py-2">
                        <button
                          type="button"
                          onClick={() => setOpenRowKey(rowOpen ? null : key)}
                          aria-expanded={rowOpen}
                          className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-3 gap-y-0.5 text-left"
                        >
                          <span className="font-mono text-caption text-tertiary">{formatDateDisplay(row.occurred_at)}</span>
                          <span className="font-money text-body-sm font-semibold text-primary">{row.description}</span>
                          <span className="text-caption text-tertiary">
                            {row.source === 'onchain' ? networkName(row.chain_id) : row.source_label}
                            {row.wallet_label ? ` · ${row.wallet_label}` : ''}
                          </span>
                        </button>
                        {usd && <span className={`shrink-0 font-money text-body-sm ${row.usd_value == null ? 'text-tertiary' : 'text-secondary'}`}>{usd}</span>}
                        {href && (
                          <a href={href} target="_blank" rel="noreferrer" title={row.tx_hash} className="shrink-0 text-tertiary hover:text-accent">
                            <ExternalLink size={12} />
                          </a>
                        )}
                      </div>
                      {rowOpen && (
                        <div className="border-t border-border bg-surface-2 px-4 py-3">
                          <LedgerRowDetail
                            row={row}
                            onError={onError}
                            onChanged={changed}
                            addressNote={notes.get(row.counterparty_address) || ''}
                          />
                        </div>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </article>
        );
      })}

      <ConfirmDialog
        open={Boolean(confirmGroup)}
        title={confirmGroup?.rows.length === 1 ? 'Mark this transaction reviewed?' : `Mark all ${confirmGroup?.rows.length} reviewed?`}
        confirmLabel="Mark reviewed"
        tone="primary"
        onConfirm={() => markGroup(confirmGroup)}
        onCancel={() => setConfirmGroup(null)}
      >
        {confirmGroup && (
          <p>
            Each keeps its category ({formatLedgerCategory(confirmGroup.category)}) and leaves the queue.
            {confirmGroup.source === 'exchange'
              ? ' Exchange records cannot be put back in the queue afterwards.'
              : confirmGroup.rows.some((row) => row.exchange_match?.needs_review)
                ? ' Some include an exchange record, which cannot be put back in the queue afterwards.'
                : ' You can undo this for a few seconds afterwards, or revert any one of them from Activity.'}
          </p>
        )}
      </ConfirmDialog>
    </section>
  );
}

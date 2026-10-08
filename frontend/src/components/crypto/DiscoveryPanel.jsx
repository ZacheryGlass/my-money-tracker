import React, { useCallback, useEffect, useState } from 'react';
import { Check, Play, X } from 'lucide-react';
import { eth as ethAPI } from '../../utils/api';
import { formatDateDisplay, shortEthAddress } from '../../utils/format';
import { explorerTxUrl, networkName } from '../../utils/chains';
import { humanize } from '../../features/crypto/plainText';
import LoadingState from '../LoadingState';
import LoadFailed from '../../features/crypto/LoadFailed';
import { ConfirmDialog } from '../Modal';

const DISCOVERY_RECEIPT_TEXT = {
  complete: 'Checked',
  contract: 'A contract, not a wallet',
  high_traffic: 'Too busy to be a personal wallet',
  dust: 'Only dust',
  truncated: 'Stopped early; run again',
  failed: 'Failed',
};

const DiscoveryPanel = ({ onChanged, onError, showSuccess }) => {
  const [candidates, setCandidates] = useState([]);
  const [receipts, setReceipts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);
  const [running, setRunning] = useState(false);

  const load = useCallback(async () => {
    try {
      const [result, receiptResult] = await Promise.all([
        ethAPI.getDiscoveryCandidates({ status: 'pending' }),
        ethAPI.getDiscoveryReceipts({ limit: 100 }),
      ]);
      setCandidates(result.candidates || []);
      setReceipts(receiptResult.receipts || []);
      setLoadFailed(false);
    } catch {
      setLoadFailed(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const run = async () => {
    setRunning(true);
    try {
      const result = await ethAPI.runDiscovery();
      showSuccess?.(`${result.candidates_found || 0} discovery candidates found`);
      await load();
    } catch (error) {
      onError?.(error.response?.data?.error || 'Failed to run wallet discovery');
    } finally {
      setRunning(false);
    }
  };

  // One decision at a time, and no double-click: each one writes durable state
  // (a tracked wallet, an `own` label that reclassifies history, or a dismissal
  // a later seed never overturns).
  const [deciding, setDeciding] = useState(null);
  const [pending, setPending] = useState(null);
  const decide = async (candidate, decision) => {
    setDeciding(candidate.id);
    try {
      await ethAPI.decideDiscovery(candidate.id, decision);
      showSuccess?.(decision === 'external' ? 'Candidate dismissed' : 'Ownership decision saved');
      setPending(null);
      await Promise.all([load(), onChanged?.()]);
    } catch (error) {
      setPending(null);
      onError?.(error.response?.data?.error || 'Failed to save discovery decision');
    } finally {
      setDeciding(null);
    }
  };

  return (
    <section className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-bold uppercase tracking-tight text-primary">Find forgotten wallets</h2>
          <p className="mt-1 text-xs text-secondary">
            Addresses that may be yours, found by following where your wallets and exchange withdrawals sent
            money. Nothing is added until you decide.
          </p>
        </div>
        <button type="button" onClick={run} disabled={running} className="inline-flex items-center gap-2 rounded border border-accent/30 bg-accent/10 px-3 py-2 text-xs font-semibold text-accent">
          <Play size={13} /> {running ? 'Running…' : 'Run checks'}
        </button>
      </div>
      {loading ? <LoadingState label="Loading candidates" className="min-h-[120px]" /> : null}
      {!loading && loadFailed ? <LoadFailed message="Couldn't load discovery candidates." onRetry={load} /> : null}
      {!loading && !loadFailed && candidates.length === 0 ? <p className="rounded border border-dashed border-border p-6 text-center text-body-sm text-tertiary">No pending candidates.</p> : null}
      <div className="space-y-3">
        {candidates.map((candidate) => (
          <article key={candidate.id} className="rounded border border-border bg-surface-2 p-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <p className="font-mono text-sm text-primary">{shortEthAddress(candidate.address)}</p>
                <p className="text-caption text-tertiary">
                  {candidate.source === 'exchange_withdrawal' ? 'You withdrew to it from an exchange' : 'One of your wallets sent to it'}
                  {Number(candidate.chain_id) > 0 ? ` · ${networkName(candidate.chain_id)}` : ' · network unknown'}
                  {candidate.score != null && (
                    <span title="How strongly the evidence suggests this address is yours">
                      {` · ${(Number(candidate.score) * 100).toFixed(0)}% likely`}
                    </span>
                  )}
                </p>
              </div>
              <div className="flex gap-2">
                <button type="button" disabled={deciding != null} onClick={() => decide(candidate, 'track')} className="inline-flex items-center gap-1 rounded border border-gain/30 bg-gain/10 px-2.5 py-1.5 text-xs font-semibold text-gain disabled:opacity-40"><Check size={12} /> Mine, track</button>
                <button type="button" disabled={deciding != null} onClick={() => setPending({ candidate, decision: 'own' })} className="rounded border border-accent/30 bg-accent/10 px-2.5 py-1.5 text-xs font-semibold text-accent disabled:opacity-40">Mine, don&apos;t track</button>
                <button type="button" disabled={deciding != null} onClick={() => setPending({ candidate, decision: 'external' })} className="inline-flex items-center gap-1 rounded border border-border px-2.5 py-1.5 text-xs font-semibold text-secondary disabled:opacity-40"><X size={12} /> Not mine</button>
              </div>
            </div>
            <details className="mt-3 text-xs text-secondary">
              <summary className="cursor-pointer text-tertiary">Why it was suggested</summary>
              <ul className="mt-2 space-y-1">
                {(Array.isArray(candidate.evidence) ? candidate.evidence : [candidate.evidence]).filter(Boolean).map((item, index) => {
                  const href = item.tx_hash && Number(candidate.chain_id) > 0 ? explorerTxUrl(item.tx_hash, candidate.chain_id) : null;
                  return (
                    // Evidence is an ordered path with no ids of its own.
                    <li key={`${item.tx_hash || item.type || 'evidence'}:${index}`} className="flex flex-wrap items-baseline gap-x-2 font-mono text-[11px]">
                      {item.block_time && <span className="font-sans text-tertiary">{formatDateDisplay(item.block_time)}</span>}
                      {item.from_address && <span>{shortEthAddress(item.from_address)} → {shortEthAddress(item.to_address)}</span>}
                      {item.token_symbol && <span className="font-sans">{item.token_symbol}</span>}
                      {!item.from_address && <span className="font-sans">{humanize(item.type || item.source || 'evidence')}</span>}
                      {href && <a href={href} target="_blank" rel="noreferrer" className="font-sans text-accent hover:underline">transaction ↗</a>}
                    </li>
                  );
                })}
              </ul>
              <details className="mt-2">
                <summary className="cursor-pointer text-[10px] text-tertiary">Raw evidence</summary>
                <pre className="mt-1 max-h-64 overflow-auto whitespace-pre-wrap rounded bg-surface-1 p-2 font-mono text-[10px]">{JSON.stringify(candidate.evidence, null, 2)}</pre>
              </details>
            </details>
          </article>
        ))}
      </div>
      {receipts.length > 0 && (
        <details className="rounded border border-border bg-surface-2 p-4">
          <summary className="cursor-pointer text-sm font-semibold text-primary">
            Check results ({receipts.length})
          </summary>
          <p className="mt-1 text-xs text-tertiary">
            What each address check found, and which ones need a retry.
          </p>
          <div className="mt-3 space-y-2">
            {receipts.map((receipt) => (
              <div key={receipt.id} className="flex flex-wrap items-center justify-between gap-2 border-t border-border pt-2 text-xs">
                <span className="font-mono text-secondary">
                  {shortEthAddress(receipt.address)} · {networkName(receipt.chain_id)} · {receipt.depth} {Number(receipt.depth) === 1 ? 'step' : 'steps'} from your wallets
                </span>
                <span className={`font-semibold uppercase tracking-wide ${receipt.status === 'failed' ? 'text-loss' : receipt.status === 'complete' ? 'text-gain' : 'text-accent'}`}>
                  {DISCOVERY_RECEIPT_TEXT[receipt.status] || humanize(receipt.status)}{receipt.rows_fetched != null ? ` · ${receipt.rows_fetched} transactions read` : ''}
                </span>
                {receipt.error_message && <span className="basis-full text-tertiary">{receipt.error_message}</span>}
              </div>
            ))}
          </div>
        </details>
      )}

      <ConfirmDialog
        open={Boolean(pending)}
        title={pending?.decision === 'own' ? 'Mark this address as yours?' : 'Dismiss this candidate?'}
        confirmLabel={pending?.decision === 'own' ? 'Mark as mine' : 'Not mine'}
        tone={pending?.decision === 'own' ? 'primary' : 'danger'}
        busy={deciding != null}
        onConfirm={() => decide(pending.candidate, pending.decision)}
        onCancel={() => setPending(null)}
      >
        {pending && (
          <p>
            {pending.decision === 'own'
              ? `Transfers with ${shortEthAddress(pending.candidate.address)} become transfers between your own addresses, and past activity is reclassified. It is not synced as a wallet.`
              : `${shortEthAddress(pending.candidate.address)} is labeled an outside party and dismissed for good: later discovery runs will not suggest it again.`}
          </p>
        )}
      </ConfirmDialog>
    </section>
  );
};

export default DiscoveryPanel;

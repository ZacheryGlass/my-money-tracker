import React, { useCallback, useEffect, useState } from 'react';
import { Check, Play, X } from 'lucide-react';
import { eth as ethAPI } from '../../utils/api';
import { shortEthAddress } from '../../utils/format';

const DiscoveryPanel = ({ onChanged, onError, showSuccess }) => {
  const [candidates, setCandidates] = useState([]);
  const [receipts, setReceipts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);

  const load = useCallback(async () => {
    try {
      const [result, receiptResult] = await Promise.all([
        ethAPI.getDiscoveryCandidates({ status: 'pending' }),
        ethAPI.getDiscoveryReceipts({ limit: 100 }),
      ]);
      setCandidates(result.candidates || []);
      setReceipts(receiptResult.receipts || []);
    } catch (error) {
      onError?.(error.response?.data?.error || 'Failed to load wallet discovery candidates');
    } finally {
      setLoading(false);
    }
  }, [onError]);

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

  const decide = async (candidate, decision) => {
    try {
      await ethAPI.decideDiscovery(candidate.id, decision);
      showSuccess?.(decision === 'external' ? 'Candidate dismissed' : 'Ownership decision saved');
      await Promise.all([load(), onChanged?.()]);
    } catch (error) {
      onError?.(error.response?.data?.error || 'Failed to save discovery decision');
    }
  };

  return (
    <section className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-primary">Forgotten-wallet discovery</h2>
          <p className="text-body-sm text-tertiary">
            Evidence-backed candidates from known-wallet paths and exchange withdrawals.
            Nothing is added to your inventory until you decide.
          </p>
        </div>
        <button type="button" onClick={run} disabled={running} className="inline-flex items-center gap-2 rounded border border-accent/30 bg-accent/10 px-3 py-2 text-xs font-semibold text-accent">
          <Play size={13} /> {running ? 'Running…' : 'Run checks'}
        </button>
      </div>
      {loading ? <p className="text-body-sm text-tertiary">Loading candidates…</p> : null}
      {!loading && candidates.length === 0 ? <p className="rounded border border-dashed border-border p-6 text-center text-body-sm text-tertiary">No pending candidates.</p> : null}
      <div className="space-y-3">
        {candidates.map((candidate) => (
          <article key={candidate.id} className="rounded border border-border bg-surface-2 p-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <p className="font-mono text-sm text-primary">{shortEthAddress(candidate.address)}</p>
                <p className="text-caption uppercase tracking-wide text-tertiary">
                  {candidate.source === 'exchange_withdrawal' ? 'Exchange withdrawal' : 'One-hop value path'}
                  {candidate.chain_id ? ` · chain ${candidate.chain_id}` : ' · chain not identified'}
                  {candidate.score != null ? ` · ${(Number(candidate.score) * 100).toFixed(0)}% score` : ''}
                </p>
              </div>
              <div className="flex gap-2">
                <button type="button" onClick={() => decide(candidate, 'track')} className="inline-flex items-center gap-1 rounded border border-gain/30 bg-gain/10 px-2.5 py-1.5 text-xs font-semibold text-gain"><Check size={12} /> Mine, track</button>
                <button type="button" onClick={() => decide(candidate, 'own')} className="rounded border border-accent/30 bg-accent/10 px-2.5 py-1.5 text-xs font-semibold text-accent">Mine, don&apos;t track</button>
                <button type="button" onClick={() => decide(candidate, 'external')} className="inline-flex items-center gap-1 rounded border border-border px-2.5 py-1.5 text-xs font-semibold text-secondary"><X size={12} /> Not mine</button>
              </div>
            </div>
            <details className="mt-3 text-xs text-secondary">
              <summary className="cursor-pointer text-tertiary">Show evidence</summary>
              <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap rounded bg-surface-1 p-2 font-mono text-[10px]">{JSON.stringify(candidate.evidence, null, 2)}</pre>
            </details>
          </article>
        ))}
      </div>
      {receipts.length > 0 && (
        <details className="rounded border border-border bg-surface-2 p-4">
          <summary className="cursor-pointer text-sm font-semibold text-primary">
            Provider receipts ({receipts.length})
          </summary>
          <p className="mt-1 text-xs text-tertiary">
            These durable outcomes explain which bounded checks completed, were skipped, or need a retry.
          </p>
          <div className="mt-3 space-y-2">
            {receipts.map((receipt) => (
              <div key={receipt.id} className="flex flex-wrap items-center justify-between gap-2 border-t border-border pt-2 text-xs">
                <span className="font-mono text-secondary">{shortEthAddress(receipt.address)} · chain {receipt.chain_id} · depth {receipt.depth}</span>
                <span className={`font-semibold uppercase tracking-wide ${receipt.status === 'failed' ? 'text-loss' : receipt.status === 'complete' ? 'text-gain' : 'text-accent'}`}>
                  {receipt.status.replace('_', ' ')}{receipt.rows_fetched != null ? ` · ${receipt.rows_fetched} rows` : ''}
                </span>
                {receipt.error_message && <span className="basis-full text-tertiary">{receipt.error_message}</span>}
              </div>
            ))}
          </div>
        </details>
      )}
    </section>
  );
};

export default DiscoveryPanel;

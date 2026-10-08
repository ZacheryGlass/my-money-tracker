import React, { useCallback, useEffect, useState } from 'react';
import { Check, RefreshCw, Undo2, X } from 'lucide-react';
import { crypto as cryptoAPI } from '../../../utils/api';
import { shortEthAddress } from '../../../utils/format';
import { networkName } from '../../../utils/chains';
import { humanize } from '../plainText';
import { describeHopPair } from '../bridgeText';
import LoadingState from '../../../components/LoadingState';
import LoadFailed from '../LoadFailed';

const BRIDGE_STATUS_LABELS = {
  protocol_verified: 'Proven by the bridge',
  user_confirmed: 'Confirmed by you',
  pending: 'Pending',
  refunded: 'Refunded',
  failed: 'Failed',
  unsupported: 'Not supported yet',
  invalidated: 'Undone',
};
const bridgeStatusLabel = (status) => BRIDGE_STATUS_LABELS[status] || humanize(status) || 'Not supported yet';

const bridgeSuggestionKey = (suggestion) => [
  suggestion.out_wallet_id, suggestion.out_chain_id, suggestion.out_tx_hash,
  suggestion.in_wallet_id, suggestion.in_chain_id, suggestion.in_tx_hash,
  suggestion.suggestion_reason,
].join(':');

const StatusChip = ({ failed, children }) => (
  <span className={`inline-flex shrink-0 items-center gap-1 border px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide ${
    failed ? 'bg-loss/20 text-loss border-loss/30' : 'bg-surface-3 text-tertiary border-border'
  }`}>
    {children}
  </span>
);

const isSettled = (movement) => ['protocol_verified', 'user_confirmed', 'invalidated'].includes(movement.status);

// Bridge transfers the app could not pair on its own, and the evidence behind
// the ones it did. Lives on Review because every actionable row here is a
// decision; the Activity ledger only shows the folded result.
export default function BridgeEvidencePanel({ refreshKey = 0, onChanged, onError, onCountChange }) {
  const [bridgeAudit, setBridgeAudit] = useState(undefined);
  const [bridgeJudging, setBridgeJudging] = useState(null);
  const [bridgeSuggestionsLoading, setBridgeSuggestionsLoading] = useState(false);

  const load = useCallback(async () => {
    try {
      setBridgeAudit(await cryptoAPI.getBridgeAudit());
    } catch {
      setBridgeAudit(null);
    }
  }, []);
  useEffect(() => { load(); }, [load, refreshKey]);
  useEffect(() => {
    if (bridgeAudit) onCountChange?.(bridgeAudit.summary?.suggestions || 0);
  }, [bridgeAudit, onCountChange]);


  const judgeBridgeSuggestion = async (suggestion, verdict) => {
    const key = `${suggestion.id}:${verdict}`;
    if (bridgeJudging) return;
    setBridgeJudging(key);
    onError?.(null);
    try {
      await cryptoAPI.setBridgeVerdict({
        outWalletId: suggestion.out_wallet_id,
        outChainId: suggestion.out_chain_id,
        outTxHash: suggestion.out_tx_hash,
        inWalletId: suggestion.in_wallet_id,
        inChainId: suggestion.in_chain_id,
        inTxHash: suggestion.in_tx_hash,
        verdict,
      });
      await load();
      await onChanged?.();
    } catch (err) {
      onError?.(err.response?.data?.error || 'Failed to save the bridge verdict');
    } finally {
      setBridgeJudging(null);
    }
  };

  const loadMoreBridgeSuggestions = async () => {
    const page = bridgeAudit?.pagination?.suggestions;
    if (!page?.has_more || bridgeSuggestionsLoading) return;
    setBridgeSuggestionsLoading(true);
    onError?.(null);
    try {
      const result = await cryptoAPI.getBridgeAudit({
        suggestion_limit: page.limit || 500,
        suggestion_offset: (bridgeAudit.suggestions || []).length,
        suggestion_generation: page.generation,
        // The other collections have independent first-page controls and are
        // ignored here; keep this continuation response small.
        limit: 1,
      });
      setBridgeAudit((current) => {
        if (!current) return result;
        const seen = new Set((current.suggestions || []).map(bridgeSuggestionKey));
        const additions = (result.suggestions || []).filter(
          (suggestion) => !seen.has(bridgeSuggestionKey(suggestion))
        );
        return {
          ...current,
          suggestions: [...(current.suggestions || []), ...additions],
          summary: result.summary || current.summary,
          pagination: {
            ...current.pagination,
            suggestions: result.pagination?.suggestions || page,
          },
        };
      });
    } catch (err) {
      if (err.response?.status === 409) {
        try {
          const fresh = await cryptoAPI.getBridgeAudit();
          setBridgeAudit(fresh);
          onError?.('The bridge matches changed while you were reviewing, so the list started over.');
          return;
        } catch (refreshError) {
          onError?.(refreshError.response?.data?.error || 'Failed to restart changed bridge alternatives');
          return;
        }
      }
      onError?.(err.response?.data?.error || 'Failed to load every bridge alternative');
    } finally {
      setBridgeSuggestionsLoading(false);
    }
  };

  const clearBridgeVerdict = async (verdict) => {
    const key = `clear:${verdict.id}`;
    if (bridgeJudging) return;
    setBridgeJudging(key);
    onError?.(null);
    try {
      await cryptoAPI.clearBridgeVerdict({
        outWalletId: verdict.out_wallet_id,
        outChainId: verdict.out_chain_id,
        outTxHash: verdict.out_tx_hash,
        inWalletId: verdict.in_wallet_id,
        inChainId: verdict.in_chain_id,
        inTxHash: verdict.in_tx_hash,
      });
      await load();
      await onChanged?.();
    } catch (err) {
      onError?.(err.response?.data?.error || 'Failed to clear the bridge verdict');
    } finally {
      setBridgeJudging(null);
    }
  };


  if (bridgeAudit === undefined) return <LoadingState label="Loading bridge transfers" className="min-h-[120px]" />;
  if (bridgeAudit === null) return <LoadFailed message="Couldn't load bridge transfers." onRetry={load} />;

  const otherCount = (bridgeAudit.movements || []).filter((movement) => !isSettled(movement)).length
    + (bridgeAudit.receipt_failures || []).length
    + (bridgeAudit.verdicts || []).length;

  return (
        <div className="border border-border bg-surface">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-3 py-2">
            <div>
              <p className="text-[9px] font-bold uppercase tracking-wide text-secondary">Bridge transfers</p>
              <p className="mt-0.5 text-caption text-tertiary">
                {(bridgeAudit.summary?.protocol_verified || 0).toLocaleString()} proven by the bridge · {(bridgeAudit.summary?.user_confirmed || 0).toLocaleString()} confirmed by you · {(bridgeAudit.summary?.suggestions || 0).toLocaleString()} waiting for you · {(bridgeAudit.summary?.receipt_failures || 0).toLocaleString()} lookups failed
              </p>
            </div>
            <span className="text-caption text-tertiary">Matching amounts alone never pair two transfers.</span>
          </div>
          {(bridgeAudit.suggestions || []).length > 0 && (
            <ul className="divide-y divide-border">
              {bridgeAudit.suggestions.map((suggestion) => (
                <li key={suggestion.id} className="flex flex-wrap items-center justify-between gap-3 px-3 py-2">
                  <div className="min-w-0 text-caption text-secondary">
                    <p>
                      {suggestion.protocol ? humanize(suggestion.protocol) : 'Possible bridge'} · {networkName(suggestion.out_chain_id)} {shortEthAddress(suggestion.out_tx_hash)} → {networkName(suggestion.in_chain_id)} {shortEthAddress(suggestion.in_tx_hash)}
                    </p>
                    <p className="mt-0.5 text-tertiary">
                      {suggestion.ambiguous ? 'More than one transfer could be the other side; check each' : humanize(suggestion.suggestion_reason)} · needs your confirmation
                    </p>
                  </div>
                  <div className="flex gap-2">
                    <button
                      type="button"
                      disabled={bridgeJudging != null}
                      onClick={() => judgeBridgeSuggestion(suggestion, 'confirmed')}
                      className="inline-flex h-7 items-center gap-1 rounded border border-gain/30 bg-gain/10 px-2 text-[9px] font-bold uppercase tracking-wide text-gain disabled:opacity-40"
                    >
                      {bridgeJudging === `${suggestion.id}:confirmed` ? <RefreshCw size={10} className="animate-spin" /> : <Check size={10} />}
                      Confirm
                    </button>
                    <button
                      type="button"
                      disabled={bridgeJudging != null}
                      onClick={() => judgeBridgeSuggestion(suggestion, 'rejected')}
                      className="inline-flex h-7 items-center gap-1 rounded border border-loss/30 bg-loss/10 px-2 text-[9px] font-bold uppercase tracking-wide text-loss disabled:opacity-40"
                    >
                      {bridgeJudging === `${suggestion.id}:rejected` ? <RefreshCw size={10} className="animate-spin" /> : <X size={10} />}
                      Not the same
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
          {bridgeAudit.pagination?.suggestions?.has_more && (
            <div className="flex flex-wrap items-center justify-between gap-2 border-t border-orange-500/30 bg-orange-500/5 px-3 py-2 text-caption text-orange-400">
              <span>
                Showing {(bridgeAudit.suggestions || []).length.toLocaleString()} of {Number(bridgeAudit.pagination.suggestions.total || bridgeAudit.summary?.suggestions || 0).toLocaleString()} plausible alternatives. Hidden alternatives remain unmatched.
              </span>
              <button
                type="button"
                disabled={bridgeSuggestionsLoading}
                onClick={loadMoreBridgeSuggestions}
                className="inline-flex h-7 items-center gap-1 rounded border border-orange-500/30 bg-surface-3 px-2 text-[9px] font-bold uppercase tracking-wide text-orange-400 disabled:opacity-40"
              >
                {bridgeSuggestionsLoading && <RefreshCw size={10} className="animate-spin" />}
                Show more alternatives
              </button>
            </div>
          )}
          {otherCount > 0 && (
            <details className="border-t border-border">
              <summary className="cursor-pointer px-3 py-2 text-caption text-tertiary hover:text-primary">
                Other bridge transfers ({otherCount.toLocaleString()}): in progress, unsupported, failed lookups and your past decisions
              </summary>
              {(bridgeAudit.movements || []).some((movement) => (
                !['protocol_verified', 'user_confirmed', 'invalidated'].includes(movement.status)
              )) && (
                <ul className="divide-y divide-border border-t border-border">
                  {bridgeAudit.movements.filter((movement) => (
                    !['protocol_verified', 'user_confirmed', 'invalidated'].includes(movement.status)
                  )).map((movement) => (
                    <li key={`movement:${movement.id}`} className="flex flex-wrap items-center justify-between gap-3 px-3 py-2">
                      <div className="min-w-0 text-caption text-secondary">
                        <p title={movement.family_version || undefined}>{humanize(movement.protocol)}</p>
                        <p className="mt-0.5 text-tertiary">
                          {(movement.members || []).map((member) => (
                            `${networkName(member.chain_id)} ${shortEthAddress(member.tx_hash)}`
                          )).join(' → ') || 'The arriving side has not been found'}
                        </p>
                        {movement.evidence?.ambiguity === 'awaiting_chain_finality' && (
                          <p className="mt-0.5 text-tertiary">
                            Both sides found; waiting for the networks to finalize them.
                          </p>
                        )}
                        {movement.protocol === 'hop' && movement.evidence?.hop_pair && (
                          <p className="mt-0.5 break-words text-tertiary" title={movement.evidence.hop_pair.transfer_id || undefined}>
                            {describeHopPair({ protocol: 'hop', evidence: { hop_pair: movement.evidence.hop_pair } })}
                          </p>
                        )}
                        {movement.evidence?.ambiguity && movement.evidence.ambiguity !== 'awaiting_chain_finality' && (
                          <p className="mt-0.5 text-tertiary">
                            {humanize(movement.evidence.ambiguity)}.
                          </p>
                        )}
                      </div>
                      <StatusChip failed={movement.status === 'failed'}>
                        {bridgeStatusLabel(movement.status)}
                      </StatusChip>
                    </li>
                  ))}
                </ul>
              )}
              {(bridgeAudit.receipt_failures || []).length > 0 && (
                <ul className="divide-y divide-border border-t border-border">
                  {bridgeAudit.receipt_failures.map((failure) => (
                    <li key={`receipt:${failure.id}`} className="flex flex-wrap items-center justify-between gap-3 px-3 py-2">
                      <div className="min-w-0 text-caption text-secondary">
                        <p>
                          Couldn&apos;t look up this transfer · {networkName(failure.chain_id)} {shortEthAddress(failure.tx_hash)}
                        </p>
                        <p className="mt-0.5 text-tertiary" title={failure.error_code || undefined}>
                          {failure.provider} · retried at the next sync
                        </p>
                      </div>
                      <StatusChip failed={failure.status === 'failed'}>
                        {bridgeStatusLabel(failure.status)}
                      </StatusChip>
                    </li>
                  ))}
                </ul>
              )}
              {(bridgeAudit.verdicts || []).length > 0 && (
                <ul className="divide-y divide-border border-t border-border">
                  {bridgeAudit.verdicts.map((verdict) => (
                    <li key={`verdict:${verdict.id}`} className="flex flex-wrap items-center justify-between gap-3 px-3 py-2">
                      <div className="min-w-0 text-caption text-secondary">
                        <p>
                          {verdict.verdict === 'confirmed' ? 'You confirmed' : 'You rejected'} · {networkName(verdict.out_chain_id)} {shortEthAddress(verdict.out_tx_hash)} → {networkName(verdict.in_chain_id)} {shortEthAddress(verdict.in_tx_hash)}
                        </p>
                        <p className="mt-0.5 text-tertiary">Kept through every sync until you undo it</p>
                      </div>
                      <button
                        type="button"
                        disabled={bridgeJudging != null}
                        onClick={() => clearBridgeVerdict(verdict)}
                        className="inline-flex h-7 items-center gap-1 rounded border border-border bg-surface-3 px-2 text-[9px] font-bold uppercase tracking-wide text-secondary disabled:opacity-40"
                      >
                        {bridgeJudging === `clear:${verdict.id}` ? <RefreshCw size={10} className="animate-spin" /> : <Undo2 size={10} />}
                        Undo
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </details>
          )}
        </div>
  );
}

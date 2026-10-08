import React, { useState } from 'react';
import { AlertTriangle, Check, RefreshCw } from 'lucide-react';
import { exchanges as exchangesAPI } from '../../utils/api';
import { formatDateDisplay, formatDecimalAmount } from '../../utils/format';
import LoadingState from '../LoadingState';
import { getCryptoMeta } from '../../features/crypto/meta';

// The reviewable explanations, from the server's reconciliation policy (crypto
// meta store), as [value, label] pairs.
const exceptionCategories = () => (getCryptoMeta()?.vocabulary?.exchangeExceptionCategories || [])
  .map(({ value, label }) => [value, label]);

const categoryLabel = (value) => exceptionCategories().find(([key]) => key === value)?.[1] || value || 'Unclassified';

const STATUS_LABELS = { open: 'Needs a decision', accepted: 'Explained' };

// Every digit: these are the figures the decision is about, and a rounded
// pair that prints identically beside a nonzero difference says nothing.
const exact = (value) => formatDecimalAmount(value, { maxFractionDigits: 18 }) ?? '—';

function ExceptionRow({ exception, showAccount, onOpenAccount, onSaved, onError, showSuccess }) {
  const [category, setCategory] = useState(exception.category || '');
  const [evidence, setEvidence] = useState(exception.evidence || '');
  const [adjustment, setAdjustment] = useState(exception.adjustment || '0');
  const [busy, setBusy] = useState(false);

  const save = async (status) => {
    setBusy(true);
    onError?.(null);
    try {
      await exchangesAPI.updateBalanceException(exception.id, {
        version: exception.version,
        status,
        category: category || null,
        evidence,
        adjustment,
      });
      showSuccess?.(status === 'accepted' ? 'Balance exception accepted' : 'Balance exception reopened');
      await onSaved?.();
    } catch (error) {
      onError?.(error.response?.data?.error || 'Failed to update this balance exception');
    } finally {
      setBusy(false);
    }
  };

  return (
    <li className="space-y-3 p-4" data-testid={`exchange-balance-exception-${exception.id}`}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-mono text-body-sm font-semibold text-primary">{exception.canonical_asset}</span>
            <span className={`inline-flex items-center border px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide ${exception.status === 'open' ? 'border-loss/20 bg-loss/10 text-loss' : 'border-orange-500/30 bg-orange-500/10 text-orange-400'}`}>
              {STATUS_LABELS[exception.status] || exception.status}
            </span>
            {exception.category && <span className="text-[10px] uppercase tracking-wider text-tertiary">{categoryLabel(exception.category)}</span>}
            {showAccount && (
              <button
                type="button"
                onClick={() => onOpenAccount?.(exception.exchange_account_id)}
                className="text-[10px] text-accent hover:underline"
              >
                {exception.account_name || 'Exchange account'}
              </button>
            )}
          </div>
          <p className="mt-1 text-caption text-tertiary">
            The exchange calls it{' '}
            <span>{(exception.provider_asset_codes || []).join(', ') || 'by no code it returned'}</span>
            {' · '}checked {formatDateDisplay(exception.calculated_at)}
          </p>
        </div>
        <dl className="grid grid-cols-[auto_auto] gap-x-3 text-right font-mono text-[10px] text-secondary">
          <dt className="font-sans text-tertiary">Records add up to</dt><dd>{exact(exception.derived_balance)}</dd>
          <dt className="font-sans text-tertiary">Exchange reports</dt><dd>{exact(exception.live_balance)}</dd>
          <dt className="font-sans text-loss">Difference</dt><dd className="text-loss">{exact(exception.delta)}</dd>
          {exception.adjustment !== '0' && (
            <><dt className="font-sans text-accent">After adjustment</dt><dd className="text-accent">{exact(exception.adjusted_delta)}</dd></>
          )}
        </dl>
      </div>

      {exception.evidence && (
        <p className="rounded border border-border bg-surface-2 px-3 py-2 text-caption text-secondary">{exception.evidence}</p>
      )}

      <div className="grid items-end gap-2 md:grid-cols-[11rem_1fr_10rem_auto]">
        <label className="sr-only" htmlFor={`exception-category-${exception.id}`}>Category</label>
        <select
          id={`exception-category-${exception.id}`}
          value={category}
          onChange={(event) => setCategory(event.target.value)}
          className="h-9 rounded border border-border bg-surface-3 px-2 text-xs text-primary"
        >
          <option value="">What explains it?</option>
          {exceptionCategories().map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </select>
        <label className="sr-only" htmlFor={`exception-evidence-${exception.id}`}>Evidence</label>
        <input
          id={`exception-evidence-${exception.id}`}
          value={evidence}
          onChange={(event) => setEvidence(event.target.value)}
          placeholder="How you know (required to accept)"
          className="h-9 rounded border border-border bg-surface-3 px-2 text-xs text-primary placeholder:text-tertiary"
        />
        <label className="sr-only" htmlFor={`exception-adjustment-${exception.id}`}>Adjustment</label>
        <input
          id={`exception-adjustment-${exception.id}`}
          value={adjustment}
          onChange={(event) => setAdjustment(event.target.value)}
          inputMode="decimal"
          placeholder="Adjustment (0)"
          title="Optional: an amount that closes the difference in this balance check only"
          className="h-9 rounded border border-border bg-surface-3 px-2 font-mono text-xs text-primary placeholder:text-tertiary"
        />
        {exception.status === 'accepted' ? (
          <button
            type="button"
            onClick={() => save('open')}
            disabled={busy}
            className="inline-flex h-9 items-center justify-center gap-1.5 rounded border border-border bg-surface-3 px-3 text-[9px] font-bold uppercase tracking-wide text-tertiary hover:border-accent hover:text-accent disabled:opacity-40"
          >
            {busy ? <RefreshCw size={11} className="animate-spin" /> : <AlertTriangle size={11} />}
            Reopen
          </button>
        ) : (
          <button
            type="button"
            onClick={() => save('accepted')}
            // The copy has always said "accept only with a category and
            // evidence"; the button now holds it to that.
            disabled={busy || !category || !evidence.trim()}
            title={!category || !evidence.trim() ? 'Choose what explains it and say how you know' : undefined}
            className="inline-flex h-9 items-center justify-center gap-1.5 rounded border border-accent/40 bg-accent/10 px-3 text-[9px] font-bold uppercase tracking-wide text-accent hover:bg-accent/20 disabled:opacity-40"
          >
            {busy ? <RefreshCw size={11} className="animate-spin" /> : <Check size={11} />}
            Accept
          </button>
        )}
      </div>
      <p className="text-[10px] text-tertiary">An adjustment only changes this balance check; holdings and records stay as they are.</p>
    </li>
  );
}

export default function ExchangeBalanceExceptionQueue({
  data,
  loading = false,
  error = null,
  onRetry,
  onSaved,
  onOpenAccount,
  onError,
  showSuccess,
  title = 'Exchange balance exceptions',
  description,
  showAccount = false,
}) {
  const rows = data?.data || [];
  return (
    <section aria-labelledby="exchange-balance-exceptions-heading">
      <div className="mb-3 px-2">
        <h2 id="exchange-balance-exceptions-heading" className="text-lg font-bold uppercase tracking-tight text-primary">{title}</h2>
        {description && <p className="mt-1 text-xs text-secondary">{description}</p>}
      </div>
      <div className="card overflow-hidden">
        {loading ? (
          <LoadingState label="Loading balance checks" className="min-h-[120px]" />
        ) : error ? (
          <div className="flex flex-wrap items-center justify-between gap-3 p-4 text-sm text-secondary">
            <span className="flex items-center gap-2 text-loss"><AlertTriangle size={14} /> {error}</span>
            <button type="button" onClick={onRetry} className="inline-flex h-8 items-center gap-1.5 rounded border border-border bg-surface-3 px-3 text-[9px] font-bold uppercase tracking-wide text-tertiary hover:border-accent hover:text-accent"><RefreshCw size={10} /> Retry</button>
          </div>
        ) : rows.length === 0 ? (
          <div className="p-6 text-center text-sm text-secondary">Every exchange balance matches its records.</div>
        ) : (
          <ul className="divide-y divide-border">
            {rows.map((exception) => (
              <ExceptionRow
                key={exception.id}
                exception={exception}
                showAccount={showAccount}
                onOpenAccount={onOpenAccount}
                onSaved={onSaved}
                onError={onError}
                showSuccess={showSuccess}
              />
            ))}
          </ul>
        )}
      </div>
      {data?.pagination?.total > rows.length && (
        <p className="mt-2 text-right text-[10px] uppercase tracking-wider text-tertiary">
          Showing {rows.length} of {data.pagination.total}
        </p>
      )}
    </section>
  );
}

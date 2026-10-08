import React, { useId, useState } from 'react';
import { RefreshCw, X } from 'lucide-react';
import {
  LABEL_VERDICT_KEEP,
  labelVerdictKind,
  labelVerdictNeedsName,
  labelVerdictOptions,
} from '../../utils/dataLabels';

// The one "what is this address?" form: a verdict (the point, not a detail --
// without it every label would vote 'exchange'), and a name, required only for
// the verdicts that print it in the ledger. A label write reclassifies history,
// which takes a while, so the busy state says so instead of only spinning.
//
// onSubmit({ name, kind }) receives `kind` already resolved for the API:
// undefined means "keep the address's current verdict".
export default function CounterpartyVerdictForm({
  initialName = '',
  initialVerdict = LABEL_VERDICT_KEEP,
  allowKeep = true,
  nameOptions = [],
  busy = false,
  submitLabel = 'Save label',
  stacked = false,
  onSubmit,
  onCancel,
}) {
  const listId = useId();
  const [name, setName] = useState(initialName);
  const [verdict, setVerdict] = useState(allowKeep ? initialVerdict : (initialVerdict === LABEL_VERDICT_KEEP ? 'external' : initialVerdict));
  const nameRequired = labelVerdictNeedsName(verdict);
  const options = labelVerdictOptions().filter((option) => allowKeep || option.value !== LABEL_VERDICT_KEEP);

  const submit = (event) => {
    event.preventDefault();
    if (busy || (nameRequired && !name.trim())) return;
    onSubmit?.({ name: name.trim(), kind: labelVerdictKind(verdict) });
  };

  const control = 'h-8 min-w-0 rounded border border-input-border bg-surface-2 px-2 text-body-sm text-primary outline-none focus:ring-1 focus:ring-accent';
  return (
    <form onSubmit={submit} className={stacked ? 'flex flex-col items-stretch gap-1.5' : 'flex flex-wrap items-end gap-2'}>
      <select
        value={verdict}
        onChange={(event) => setVerdict(event.target.value)}
        aria-label="Counterparty verdict"
        className={`${control} text-[11px]`}
        disabled={busy}
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>{option.label}</option>
        ))}
      </select>
      <input
        type="text"
        value={name}
        onChange={(event) => setName(event.target.value)}
        list={nameOptions.length ? listId : undefined}
        maxLength={64}
        autoFocus
        placeholder={nameRequired ? 'Name, e.g. Coinbase' : 'Name (optional)'}
        aria-label="Label name"
        className={`${control} ${stacked ? 'w-full' : 'w-44'}`}
        disabled={busy}
      />
      {nameOptions.length > 0 && (
        <datalist id={listId}>
          {nameOptions.map((option) => <option key={option} value={option} />)}
        </datalist>
      )}
      <div className="flex items-center gap-1.5">
        <button
          type="submit"
          disabled={busy || (nameRequired && !name.trim())}
          className="inline-flex h-8 items-center gap-1.5 rounded border border-teal-500/30 bg-teal-500/10 px-2.5 text-[9px] font-bold uppercase tracking-wide text-teal-400 transition-all hover:bg-teal-500/20 disabled:opacity-40"
        >
          {busy && <RefreshCw size={10} className="animate-spin" />}
          {submitLabel}
        </button>
        {onCancel && (
          <button
            type="button"
            onClick={onCancel}
            disabled={busy}
            aria-label="Cancel"
            className="inline-flex h-8 items-center rounded border border-border bg-surface-3 px-2 text-[9px] font-bold uppercase tracking-wide text-tertiary transition-all hover:text-primary"
          >
            <X size={10} />
          </button>
        )}
      </div>
      {busy && (
        <p role="status" className="basis-full text-[10px] text-tertiary">Reclassifying past transfers, about 15 seconds…</p>
      )}
    </form>
  );
}

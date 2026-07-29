import React, { useMemo, useState } from 'react';
import { ChevronDown, EyeOff, RefreshCw, Tag, Undo2 } from 'lucide-react';
import { eth as ethAPI } from '../../utils/api';
import {
  LABEL_VERDICT_KEEP,
  LABEL_VERDICT_OPTIONS,
  labelVerdictKind,
  labelVerdictNeedsName,
} from '../../utils/dataLabels';

const ETH_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

function AddressNoteEditor({ address, initialNote = '', onChanged, onError, showSuccess }) {
  const [note, setNote] = useState(initialNote);
  const [saving, setSaving] = useState(false);

  const save = async () => {
    setSaving(true);
    onError(null);
    try {
      if (note.trim()) await ethAPI.saveAddressNote(address, note.trim());
      else if (initialNote) await ethAPI.deleteAddressNote(address);
      showSuccess(note.trim() ? 'Address note saved' : 'Address note removed');
      await onChanged();
    } catch (err) {
      onError(err.response?.data?.error || 'Failed to save address note');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="mt-2 flex min-w-0 items-center gap-2">
      <textarea
        value={note}
        onChange={(event) => setNote(event.target.value)}
        rows={2}
        placeholder="What this address is and how you know"
        aria-label={`Note for ${address}`}
        className="min-h-12 flex-1 resize-y rounded border border-input-border bg-surface-2 px-2 py-1.5 text-body-sm text-primary outline-none focus:ring-1 focus:ring-accent"
      />
      <button
        type="button"
        onClick={save}
        disabled={saving || note === initialNote}
        className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded border border-border bg-surface-3 px-2 text-[9px] font-bold uppercase tracking-wide text-secondary transition-all hover:text-primary disabled:opacity-40"
      >
        {saving && <RefreshCw size={10} className="animate-spin" />}
        Save note
      </button>
    </div>
  );
}

// The two reference lists a user maintains by hand: who an address is, and
// which tokens to pretend do not exist. Both change how every past transfer is
// read, which is why they sit together and away from the queues on Review.
function LabelsPanel({
  addressLabels,
  addressNotes = [],
  ignoredTokens,
  onChanged,
  onError,
  showSuccess,
}) {
  const [labelAddressInput, setLabelAddressInput] = useState('');
  const [labelNameInput, setLabelNameInput] = useState('');
  const [labelNoteInput, setLabelNoteInput] = useState('');
  // null = follow the default for the typed address. Only a deliberate pick
  // sets it, so the default can keep tracking what the user types.
  const [labelVerdictChoice, setLabelVerdictChoice] = useState(null);
  const [updatingLabels, setUpdatingLabels] = useState(false);
  const [showExternalLabels, setShowExternalLabels] = useState(false);
  const [ignoreContract, setIgnoreContract] = useState('');
  const [ignoreSymbol, setIgnoreSymbol] = useState('');
  const [updatingIgnoreList, setUpdatingIgnoreList] = useState(false);

  // The verdict the form will send: the user's pick, or -- until they make
  // one -- "keep", which the server resolves to the address's current verdict
  // (the user's row, else any builtin's, the hidden scraped pack included)
  // and to 'exchange' only for an address nobody has judged. Deriving the
  // default from what this list can see re-voted pack 'external' gateways to
  // 'exchange' on a plain rename, silently rewriting that spending as an
  // internal transfer.
  const labelVerdict = labelVerdictChoice || LABEL_VERDICT_KEEP;
  const notesByAddress = useMemo(
    () => new Map(addressNotes.map((item) => [item.address, item.note])),
    [addressNotes]
  );
  const labeledAddresses = useMemo(
    () => new Set(addressLabels.map((label) => label.address)),
    [addressLabels]
  );
  const noteOnlyAddresses = useMemo(
    () => addressNotes.filter((item) => !labeledAddresses.has(item.address)),
    [addressNotes, labeledAddresses]
  );

  // Rows written before migration 031 have no kind and meant "exchange".
  // 'own' rows stay in the main list -- a cold-storage address is worth seeing.
  // 'external' rows are dismissals and get collapsed; after one airdrop wave
  // they would otherwise bury the handful of labels the user actually cares about.
  const [primaryLabels, externalLabels] = useMemo(() => {
    const primary = [];
    const external = [];
    for (const label of addressLabels) {
      (label.kind === 'external' ? external : primary).push(label);
    }
    return [primary, external];
  }, [addressLabels]);

  const handleLabelAddress = async (event) => {
    event.preventDefault();
    const address = labelAddressInput.trim();
    const name = labelNameInput.trim();
    if (!ETH_ADDRESS_RE.test(address)) {
      onError('Enter the counterparty address (0x followed by 40 hex characters)');
      return;
    }
    // An exchange name is the text the ledger shows AND the claim that turns
    // spending into an internal transfer, so it has to be typed. The other
    // verdicts never show their name, and the server falls back to a short
    // address.
    if (!name && labelVerdictNeedsName(labelVerdict)) {
      onError('Enter a name for the address (e.g. Coinbase)');
      return;
    }
    setUpdatingLabels(true);
    onError(null);
    try {
      await ethAPI.labelAddress(address, name || null, { kind: labelVerdictKind(labelVerdict) });
      if (labelNoteInput.trim()) await ethAPI.saveAddressNote(address, labelNoteInput.trim());
      showSuccess('Address labeled');
      setLabelAddressInput('');
      setLabelNameInput('');
      setLabelNoteInput('');
      setLabelVerdictChoice(null);
      await onChanged();
    } catch (err) {
      onError(err.response?.data?.error || 'Failed to label address');
    } finally {
      setUpdatingLabels(false);
    }
  };

  const handleUnlabelAddress = async (address) => {
    setUpdatingLabels(true);
    onError(null);
    try {
      await ethAPI.unlabelAddress(address);
      showSuccess('Address label removed');
      await onChanged();
    } catch (err) {
      onError(err.response?.data?.error || 'Failed to remove address label');
    } finally {
      setUpdatingLabels(false);
    }
  };

  const handleIgnoreToken = async (event) => {
    event.preventDefault();
    const contract = ignoreContract.trim();
    if (!ETH_ADDRESS_RE.test(contract)) {
      onError('Enter the token contract address (0x followed by 40 hex characters)');
      return;
    }
    setUpdatingIgnoreList(true);
    onError(null);
    try {
      await ethAPI.ignoreToken(contract, ignoreSymbol.trim() || undefined);
      showSuccess('Token ignored');
      setIgnoreContract('');
      setIgnoreSymbol('');
      await onChanged();
    } catch (err) {
      onError(err.response?.data?.error || 'Failed to ignore token');
    } finally {
      setUpdatingIgnoreList(false);
    }
  };

  const handleUnignoreToken = async (contractAddress) => {
    setUpdatingIgnoreList(true);
    onError(null);
    try {
      await ethAPI.unignoreToken(contractAddress);
      showSuccess('Token no longer ignored');
      await onChanged();
    } catch (err) {
      onError(err.response?.data?.error || 'Failed to unignore token');
    } finally {
      setUpdatingIgnoreList(false);
    }
  };

  // Shared by the main list and the collapsed outside-party group. A label with
  // no kind predates migration 031 and meant "exchange", which needs no pill.
  const renderAddressLabelRow = (label) => {
    const pill = label.source === 'builtin' ? 'Built-in'
      // The bridge pack (migration 044) is small, hand-verified against each
      // protocol's own deployment docs, and listed rather than hidden like the
      // 5k scraped rows -- a wrong bridge address has to be correctable, and
      // you cannot correct what you cannot see. Its rows show 'Bridge', the
      // verdict, rather than their provenance: source 'builtin-bridge' always
      // arrives with kind 'bridge', so this branch claims every one of them and
      // there is no 'builtin-bridge' source pill to fall through to.
      : label.kind === 'bridge' ? 'Bridge'
      : label.kind === 'service' ? 'Swap service'
      : label.kind === 'own' ? 'Yours'
      : label.kind === 'external' ? 'Outside party'
      : null;
    return (
      <div key={label.address} className="px-4 py-3">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0 flex-1">
          <span className="flex items-center gap-2 text-body-sm font-semibold text-primary">
            {label.name}
            {pill && (
              <span className="inline-flex shrink-0 items-center px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide rounded-full border border-border bg-surface-3 text-tertiary" title={label.note || undefined}>
                {pill}
              </span>
            )}
          </span>
          <span className="block truncate font-mono text-[10px] text-tertiary" title={label.address}>
            {label.address}
          </span>
            {label.note && (
              <p className="mt-1 text-[10px] leading-relaxed text-tertiary">{label.note}</p>
            )}
          </div>
          {label.source !== 'builtin' && (
            <button
              onClick={() => handleUnlabelAddress(label.address)}
              disabled={updatingLabels}
              className="inline-flex h-9 shrink-0 items-center justify-center gap-2 rounded border border-border bg-surface-3 px-3 text-xs font-bold uppercase tracking-wider text-secondary transition-all hover:text-primary disabled:opacity-40"
            >
              <Undo2 size={14} />
              Remove
            </button>
          )}
        </div>
        <AddressNoteEditor
          key={`${label.address}:${notesByAddress.get(label.address) || ''}`}
          address={label.address}
          initialNote={notesByAddress.get(label.address) || ''}
          onChanged={onChanged}
          onError={onError}
          showSuccess={showSuccess}
        />
      </div>
    );
  };

  return (
    <>
      <section aria-labelledby="eth-labeled-addresses-heading">
        <div className="mb-3 px-2">
          <h2 id="eth-labeled-addresses-heading" className="text-lg font-bold uppercase tracking-tight text-primary">Labeled Addresses</h2>
          <p className="mt-1 text-xs text-secondary">Transfers to or from an exchange address, or one marked as yours, count as internal movements instead of external activity. Major exchanges&apos; shared hot wallets are recognized automatically; a deposit address the exchange assigned you has to be labeled by hand. If a recognized address is wrong &mdash; a shop or payment processor treated as an exchange, say &mdash; label it here with the right verdict: yours always wins over the built-in one, and past transfers are reclassified. Removing a label puts the address back in Needs Review.</p>
        </div>

        <div className="card overflow-hidden">
          <form onSubmit={handleLabelAddress} className="border-b border-border p-4">
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-[minmax(0,1.8fr)_minmax(0,1fr)_minmax(0,1.1fr)_auto] sm:items-end">
              <label className="min-w-0 text-caption text-tertiary">
                Address
                <input
                  type="text"
                  value={labelAddressInput}
                  onChange={(event) => setLabelAddressInput(event.target.value)}
                  placeholder="0x…"
                  spellCheck={false}
                  autoComplete="off"
                  className="mt-1 block h-10 w-full min-w-0 border border-input-border bg-surface-2 px-2 font-mono text-body-sm text-primary"
                  disabled={updatingLabels}
                />
              </label>
              <label className="min-w-0 text-caption text-tertiary">
                {labelVerdictNeedsName(labelVerdict) ? 'Name' : 'Name (optional)'}
                <input
                  type="text"
                  value={labelNameInput}
                  onChange={(event) => setLabelNameInput(event.target.value)}
                  maxLength={64}
                  placeholder="Coinbase"
                  className="mt-1 block h-10 w-full min-w-0 border border-input-border bg-surface-2 px-2 text-body-sm text-primary"
                  disabled={updatingLabels}
                />
              </label>
              {/* The verdict, not just a name. An address the built-in pack
                  called an exchange is corrected here: 'External' or 'My own
                  address' writes a user row that shadows the builtin and
                  reclassifies the history behind it. */}
              <label className="min-w-0 text-caption text-tertiary">
                Verdict
                <select
                  value={labelVerdict}
                  onChange={(event) => setLabelVerdictChoice(event.target.value)}
                  className="mt-1 block h-10 w-full min-w-0 border border-input-border bg-surface-2 px-2 text-body-sm text-primary"
                  disabled={updatingLabels}
                >
                  {LABEL_VERDICT_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>{option.label}</option>
                  ))}
                </select>
              </label>
              <button
                type="submit"
                disabled={updatingLabels}
                className="inline-flex h-10 items-center justify-center gap-2 bg-surface-3 border border-border px-4 text-button font-semibold text-secondary transition-colors hover:border-accent hover:text-accent disabled:opacity-40"
              >
                {updatingLabels ? <RefreshCw size={14} className="animate-spin" /> : <Tag size={14} />}
                Label Address
              </button>
            </div>
            <label className="mt-2 block min-w-0 text-caption text-tertiary">
              Note (optional)
              <textarea
                value={labelNoteInput}
                onChange={(event) => setLabelNoteInput(event.target.value)}
                rows={2}
                placeholder="What this address is and what its transactions represent"
                className="mt-1 block min-h-14 w-full resize-y border border-input-border bg-surface-2 px-2 py-1.5 text-body-sm text-primary"
                disabled={updatingLabels}
              />
            </label>
          </form>

          {addressLabels.length === 0 ? (
            <div className="p-6 text-center text-sm text-secondary">No addresses are labeled.</div>
          ) : (
            <div className="divide-y divide-border">
              {primaryLabels.map(renderAddressLabelRow)}
            </div>
          )}

          {noteOnlyAddresses.length > 0 && (
            <div className="border-t border-border">
              <div className="bg-surface-2 px-4 py-2">
                <p className="text-[10px] font-bold uppercase tracking-wide text-tertiary">
                  Notes awaiting a verdict
                </p>
              </div>
              <div className="divide-y divide-border">
                {noteOnlyAddresses.map((item) => (
                  <div key={item.address} className="px-4 py-3">
                    <span className="block font-mono text-[10px] text-tertiary">{item.address}</span>
                    <AddressNoteEditor
                      key={`${item.address}:${item.note}`}
                      address={item.address}
                      initialNote={item.note}
                      onChanged={onChanged}
                      onError={onError}
                      showSuccess={showSuccess}
                    />
                  </div>
                ))}
              </div>
            </div>
          )}

          {externalLabels.length > 0 && (
            // Every dismissal is a permanent row, so one airdrop wave would
            // otherwise bury the handful of exchanges the user actually cares
            // about under dozens of "not an exchange" entries.
            <>
              <button
                type="button"
                aria-expanded={showExternalLabels}
                onClick={() => setShowExternalLabels((open) => !open)}
                className="flex w-full items-center justify-between gap-2 border-t border-border px-4 py-3 text-caption text-tertiary transition-colors hover:text-primary"
              >
                <span>{externalLabels.length} reviewed as outside parties</span>
                <ChevronDown size={14} className={showExternalLabels ? 'rotate-180 transition-transform' : 'transition-transform'} />
              </button>
              {showExternalLabels && (
                <div className="divide-y divide-border">
                  {externalLabels.map(renderAddressLabelRow)}
                </div>
              )}
            </>
          )}
        </div>
      </section>

      <section>
        <div className="mb-3 px-2">
          <h2 className="text-lg font-bold uppercase tracking-tight text-primary">Ignored Tokens</h2>
          <p className="mt-1 text-xs text-secondary">Scam and airdrop tokens you cannot send stay in your wallet forever. Ignoring a token removes it from holdings and activity everywhere.</p>
        </div>

        <div className="card overflow-hidden">
          <form onSubmit={handleIgnoreToken} className="border-b border-border p-4">
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_auto] sm:items-end">
              <label className="min-w-0 text-caption text-tertiary">
                Token contract address
                <input
                  type="text"
                  value={ignoreContract}
                  onChange={(event) => setIgnoreContract(event.target.value)}
                  placeholder="0x…"
                  spellCheck={false}
                  autoComplete="off"
                  className="mt-1 block h-10 w-full min-w-0 border border-input-border bg-surface-2 px-2 font-mono text-body-sm text-primary"
                  disabled={updatingIgnoreList}
                />
              </label>
              <label className="min-w-0 text-caption text-tertiary">
                Symbol (optional)
                <input
                  type="text"
                  value={ignoreSymbol}
                  onChange={(event) => setIgnoreSymbol(event.target.value)}
                  maxLength={64}
                  placeholder="SCAM"
                  className="mt-1 block h-10 w-full min-w-0 border border-input-border bg-surface-2 px-2 text-body-sm text-primary"
                  disabled={updatingIgnoreList}
                />
              </label>
              <button
                type="submit"
                disabled={updatingIgnoreList}
                className="inline-flex h-10 items-center justify-center gap-2 bg-surface-3 border border-border px-4 text-button font-semibold text-secondary transition-colors hover:border-loss/30 hover:text-loss disabled:opacity-40"
              >
                {updatingIgnoreList ? <RefreshCw size={14} className="animate-spin" /> : <EyeOff size={14} />}
                Ignore Token
              </button>
            </div>
          </form>

          {ignoredTokens.length === 0 ? (
            <div className="p-6 text-center text-sm text-secondary">No tokens are ignored.</div>
          ) : (
            <div className="divide-y divide-border">
              {ignoredTokens.map((token) => (
                <div key={token.contract_address} className="flex items-center justify-between gap-4 px-4 py-3">
                  <div className="min-w-0">
                    <span className="block text-body-sm font-semibold text-primary">{token.symbol || 'Unknown token'}</span>
                    <span className="block truncate font-mono text-[10px] text-tertiary" title={token.contract_address}>
                      {token.contract_address}
                    </span>
                  </div>
                  <button
                    onClick={() => handleUnignoreToken(token.contract_address)}
                    disabled={updatingIgnoreList}
                    className="inline-flex h-9 shrink-0 items-center justify-center gap-2 rounded border border-border bg-surface-3 px-3 text-xs font-bold uppercase tracking-wider text-secondary transition-all hover:text-primary disabled:opacity-40"
                  >
                    <Undo2 size={14} />
                    Unignore
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      </section>
    </>
  );
}

export default LabelsPanel;

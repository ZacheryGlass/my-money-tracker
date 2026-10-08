import React, { useMemo, useState } from 'react';
import { ChevronDown, EyeOff, RefreshCw, Tag, Undo2 } from 'lucide-react';
import { eth as ethAPI } from '../../utils/api';
import LoadFailed from '../../features/crypto/LoadFailed';
import CounterpartyVerdictForm from '../../features/crypto/CounterpartyVerdictForm';
import SegmentedControl from '../SegmentedControl';
import { networkName } from '../../utils/chains';
import { ConfirmDialog } from '../Modal';
import HowThisWorks from '../../features/crypto/HowThisWorks';
import {
  LABEL_VERDICT_KEEP,
  labelVerdictOptions,
  labelVerdictKind,
  labelVerdictNeedsName,
} from '../../utils/dataLabels';

const ETH_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

// A note is read far more than it is written, so it shows as text with an
// Edit button; the textarea opens only on request. Forty open textareas made
// the label list a form to scroll through rather than a list to read.
function AddressNoteEditor({ address, initialNote = '', onChanged, onError, showSuccess }) {
  const [editing, setEditing] = useState(false);
  const [note, setNote] = useState(initialNote);
  const [saving, setSaving] = useState(false);

  const save = async () => {
    setSaving(true);
    onError(null);
    try {
      if (note.trim()) await ethAPI.saveAddressNote(address, note.trim());
      else if (initialNote) await ethAPI.deleteAddressNote(address);
      showSuccess(note.trim() ? 'Address note saved' : 'Address note removed');
      setEditing(false);
      await onChanged();
    } catch (err) {
      onError(err.response?.data?.error || 'Failed to save address note');
    } finally {
      setSaving(false);
    }
  };

  if (!editing) {
    return (
      <div className="mt-1.5 flex min-w-0 items-start gap-2">
        {initialNote && <p className="min-w-0 flex-1 whitespace-pre-wrap text-body-sm text-secondary">{initialNote}</p>}
        <button
          type="button"
          onClick={() => { setNote(initialNote); setEditing(true); }}
          aria-label={`${initialNote ? 'Edit' : 'Add a'} note for ${address}`}
          className="shrink-0 text-caption text-accent hover:underline"
        >
          {initialNote ? 'Edit note' : 'Add note'}
        </button>
      </div>
    );
  }

  return (
    <div className="mt-2 flex min-w-0 items-center gap-2">
      <textarea
        value={note}
        onChange={(event) => setNote(event.target.value)}
        rows={2}
        autoFocus
        placeholder="What this address is and how you know"
        aria-label={`Note for ${address}`}
        className="min-h-12 flex-1 resize-y rounded border border-input-border bg-surface-2 px-2 py-1.5 text-body-sm text-primary outline-none focus:ring-1 focus:ring-accent"
      />
      <div className="flex shrink-0 flex-col gap-1">
        <button
          type="button"
          onClick={save}
          disabled={saving || note === initialNote}
          className="inline-flex h-8 items-center gap-1.5 rounded border border-border bg-surface-3 px-2 text-[9px] font-bold uppercase tracking-wide text-secondary transition-all hover:text-primary disabled:opacity-40"
        >
          {saving && <RefreshCw size={10} className="animate-spin" />}
          Save note
        </button>
        <button
          type="button"
          onClick={() => setEditing(false)}
          disabled={saving}
          className="text-[10px] text-tertiary hover:text-primary"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

// A built-in label's note is provenance ("Cross-chain bridge on chain 59144.
// Source: https://..."): the network by name, and the source as a link.
function LabelNote({ text }) {
  const parts = String(text).replace(/\bchain (\d+)\b/g, (match, id) => networkName(Number(id))).split(/(https?:\/\/\S+)/);
  return (
    <p className="mt-1 text-[10px] leading-relaxed text-tertiary">
      {parts.map((part, index) => (/^https?:\/\//.test(part)
        ? <a key={index} href={part.replace(/[.,)]$/, '')} target="_blank" rel="noreferrer" className="text-accent hover:underline">{part.replace(/[.,)]$/, '')}</a>
        : <React.Fragment key={index}>{part}</React.Fragment>))}
    </p>
  );
}

const LABEL_FILTERS = [
  { value: 'all', label: 'All' },
  { value: 'own', label: 'Yours' },
  { value: 'exchange', label: 'Exchanges' },
  { value: 'bridge', label: 'Bridges' },
  { value: 'service', label: 'Services' },
  { value: 'external', label: 'Outside' },
  { value: 'builtin', label: 'Built-in' },
];
// Rows from before migration 031 have no kind and meant "exchange".
const labelMatchesFilter = (label, filter) => {
  if (filter === 'all') return true;
  if (filter === 'builtin') return Boolean(label.builtin);
  return (label.kind || 'exchange') === filter;
};

// The two reference lists a user maintains by hand: who an address is, and
// which tokens to pretend do not exist. Both change how every past transfer is
// read, which is why they sit together and away from the queues on Review.
function LabelsPanel({
  addressLabels,
  addressNotes = [],
  exchangeAccounts = [],
  ignoredTokens,
  labelsLoadFailed = false,
  ignoredLoadFailed = false,
  onRetry,
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
  const [exchangeAccountIdInput, setExchangeAccountIdInput] = useState('');
  const [updatingLabels, setUpdatingLabels] = useState(false);
  const [showExternalLabels, setShowExternalLabels] = useState(false);
  const [labelFilter, setLabelFilter] = useState('all');
  const [labelSearch, setLabelSearch] = useState('');
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
    // The user's own labels first: forty built-in bridge endpoints listed
    // above them put the ones the user wrote out of sight.
    const userFirst = (a, b) => Number(Boolean(a.builtin)) - Number(Boolean(b.builtin));
    return [primary.sort(userFirst), external.sort(userFirst)];
  }, [addressLabels]);

  // A filter or a search turns the grouped list into one flat list of matches.
  const searchText = labelSearch.trim().toLowerCase();
  const narrowed = labelFilter !== 'all' || Boolean(searchText);
  const narrowedLabels = useMemo(() => addressLabels.filter((label) => labelMatchesFilter(label, labelFilter)
    && (!searchText || `${label.name} ${label.address}`.toLowerCase().includes(searchText))), [addressLabels, labelFilter, searchText]);

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
      const labelKind = labelVerdictKind(labelVerdict);
      const exchangeAccountId = labelKind === 'exchange' && exchangeAccountIdInput
        ? Number(exchangeAccountIdInput) : undefined;
      await ethAPI.labelAddress(address, name || null, {
        kind: labelKind,
        // Send an explicit null when the user selects None so a previously
        // linked unavailable account can be detached. Non-exchange verdicts
        // also clear any stale linkage on the server.
        exchange_account_id: exchangeAccountId ?? null,
      });
      if (labelNoteInput.trim()) await ethAPI.saveAddressNote(address, labelNoteInput.trim());
      showSuccess('Address labeled');
      setLabelAddressInput('');
      setLabelNameInput('');
      setLabelNoteInput('');
      setLabelVerdictChoice(null);
      setExchangeAccountIdInput('');
      await onChanged();
    } catch (err) {
      onError(err.response?.data?.error || 'Failed to label address');
    } finally {
      setUpdatingLabels(false);
    }
  };

  // Both of these rewrite history (a removed label reclassifies every past
  // transfer with that address; an ignored token leaves every wallet's
  // holdings and activity), so each asks first, naming what it touches.
  const [pendingUnlabel, setPendingUnlabel] = useState(null);
  const [pendingIgnore, setPendingIgnore] = useState(null);
  const [editingLabel, setEditingLabel] = useState(null);

  const handleEditLabel = async (label, { name, kind }) => {
    setUpdatingLabels(true);
    onError(null);
    try {
      await ethAPI.labelAddress(label.address, name || null, { kind });
      showSuccess(label.builtin ? 'Built-in label overridden; past transfers were reclassified' : 'Label updated');
      setEditingLabel(null);
      await onChanged();
    } catch (err) {
      onError(err.response?.data?.error || 'Failed to update the label');
    } finally {
      setUpdatingLabels(false);
    }
  };

  const handleUnlabelAddress = async () => {
    const { address } = pendingUnlabel;
    setUpdatingLabels(true);
    onError(null);
    try {
      await ethAPI.unlabelAddress(address);
      showSuccess('Address label removed');
      setPendingUnlabel(null);
      await onChanged();
    } catch (err) {
      setPendingUnlabel(null);
      onError(err.response?.data?.error || 'Failed to remove address label');
    } finally {
      setUpdatingLabels(false);
    }
  };

  const handleIgnoreToken = (event) => {
    event.preventDefault();
    const contract = ignoreContract.trim();
    if (!ETH_ADDRESS_RE.test(contract)) {
      onError('Enter the token contract address (0x followed by 40 hex characters)');
      return;
    }
    setPendingIgnore({ contract, symbol: ignoreSymbol.trim() || undefined });
  };

  const confirmIgnoreToken = async () => {
    setUpdatingIgnoreList(true);
    onError(null);
    try {
      await ethAPI.ignoreToken(pendingIgnore.contract, pendingIgnore.symbol);
      showSuccess('Token ignored');
      setIgnoreContract('');
      setIgnoreSymbol('');
      setPendingIgnore(null);
      await onChanged();
    } catch (err) {
      setPendingIgnore(null);
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
      : label.source === 'builtin-polymarket' ? 'Polymarket'
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
            {label.note && <LabelNote text={label.note} />}
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            {/* A built-in label cannot be changed in place, only overridden:
                the override is a row of the user's own, which then wins. */}
            <button
              type="button"
              onClick={() => setEditingLabel(editingLabel === label.address ? null : label.address)}
              disabled={updatingLabels}
              className="inline-flex h-9 items-center justify-center rounded border border-border bg-surface-3 px-3 text-xs font-bold uppercase tracking-wider text-secondary transition-all hover:text-primary disabled:opacity-40"
            >
              {label.builtin ? 'Override' : 'Edit'}
            </button>
            {/* Shared builtin rows cannot be removed (the API answers 409); the
                server says which rows those are. */}
            {!label.builtin && (
              <button
                onClick={() => setPendingUnlabel(label)}
                disabled={updatingLabels}
                className="inline-flex h-9 shrink-0 items-center justify-center gap-2 rounded border border-border bg-surface-3 px-3 text-xs font-bold uppercase tracking-wider text-secondary transition-all hover:text-primary disabled:opacity-40"
              >
                <Undo2 size={14} />
                Remove
              </button>
            )}
          </div>
        </div>
        {editingLabel === label.address && (
          <div className="mt-2 border-t border-border pt-2">
            <CounterpartyVerdictForm
              initialName={label.name}
              initialVerdict={label.kind || 'exchange'}
              allowKeep={false}
              busy={updatingLabels}
              submitLabel={label.builtin ? 'Save override' : 'Save'}
              onSubmit={(values) => handleEditLabel(label, values)}
              onCancel={() => setEditingLabel(null)}
            />
          </div>
        )}
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
          <p className="mt-1 text-xs text-secondary">Say what an address is. Transfers with an exchange or with one of your own addresses count as moving your money, not spending it.</p>
          <HowThisWorks>
            Major exchanges&apos; shared wallets are recognized automatically; a deposit address an exchange
            assigned you has to be labeled by hand. If a recognized address is wrong (a shop or payment
            processor treated as an exchange, say), label it here: your label always wins over the built-in
            one, and past transfers are reclassified. Removing a label puts the address back in Needs Review.
          </HowThisWorks>
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
                  {labelVerdictOptions().map((option) => (
                    <option key={option.value} value={option.value}>{option.label}</option>
                  ))}
                </select>
              </label>
              {labelVerdictKind(labelVerdict) === 'exchange' && (
                <label className="min-w-0 text-caption text-tertiary">
                  Exchange account with no records (optional)
                  <select
                    value={exchangeAccountIdInput}
                    onChange={(event) => setExchangeAccountIdInput(event.target.value)}
                    className="mt-1 block h-10 w-full min-w-0 border border-input-border bg-surface-2 px-2 text-body-sm text-primary"
                    disabled={updatingLabels}
                  >
                    <option value="">None</option>
                    {exchangeAccounts.filter((account) => account.records_unavailable).map((account) => (
                      <option key={account.id} value={account.id}>{account.name}</option>
                    ))}
                  </select>
                </label>
              )}
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

          {addressLabels.length > 0 && !labelsLoadFailed && (
            <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-border bg-surface-2 px-4 py-2">
              <SegmentedControl
                label="Show"
                value={labelFilter}
                onChange={setLabelFilter}
                options={LABEL_FILTERS}
                mobile="select"
              />
              <input
                type="search"
                value={labelSearch}
                onChange={(event) => setLabelSearch(event.target.value)}
                placeholder="Name or address"
                aria-label="Search labels"
                className="h-8 w-full min-w-0 rounded border border-input-border bg-surface px-2 text-body-sm text-primary placeholder:text-tertiary sm:w-56"
              />
            </div>
          )}
          {labelsLoadFailed ? (
            <LoadFailed message="Couldn't load your address labels." onRetry={onRetry} />
          ) : addressLabels.length === 0 ? (
            <div className="p-6 text-center text-sm text-secondary">No addresses are labeled.</div>
          ) : narrowed ? (
            narrowedLabels.length === 0 ? (
              <div className="p-6 text-center text-sm text-secondary">No labels match.</div>
            ) : (
              <div className="divide-y divide-border">
                {narrowedLabels.map(renderAddressLabelRow)}
              </div>
            )
          ) : (
            <div className="divide-y divide-border">
              {primaryLabels.map(renderAddressLabelRow)}
            </div>
          )}

          {!narrowed && noteOnlyAddresses.length > 0 && (
            <div className="border-t border-border">
              <div className="bg-surface-2 px-4 py-2">
                <p className="text-[10px] font-bold uppercase tracking-wide text-tertiary">
                  Notes on addresses with no label yet
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

          {!narrowed && externalLabels.length > 0 && (
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

          {ignoredLoadFailed ? (
            <LoadFailed message="Couldn't load your ignored tokens." onRetry={onRetry} />
          ) : ignoredTokens.length === 0 ? (
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

      <ConfirmDialog
        open={Boolean(pendingUnlabel)}
        title="Remove this label?"
        confirmLabel="Remove label"
        busy={updatingLabels}
        onConfirm={handleUnlabelAddress}
        onCancel={() => setPendingUnlabel(null)}
      >
        {pendingUnlabel && (
          <p>
            {pendingUnlabel.name ? `${pendingUnlabel.name} (${pendingUnlabel.address})` : pendingUnlabel.address} goes
            back to Needs Review, and every past transfer with it is reclassified. This takes about 15 seconds.
          </p>
        )}
      </ConfirmDialog>

      <ConfirmDialog
        open={Boolean(pendingIgnore)}
        title="Ignore this token?"
        confirmLabel="Ignore token"
        busy={updatingIgnoreList}
        onConfirm={confirmIgnoreToken}
        onCancel={() => setPendingIgnore(null)}
      >
        {pendingIgnore && (
          <p>
            {pendingIgnore.symbol || pendingIgnore.contract} is removed from holdings and activity in every
            wallet. You can undo this from the ignored tokens list below.
          </p>
        )}
      </ConfirmDialog>
    </>
  );
}

export default LabelsPanel;

import React, { useState } from 'react';
import { AlertTriangle, Check, ChevronDown, RefreshCw, Undo2 } from 'lucide-react';
import { eth as ethAPI } from '../../utils/api';
import {
  formatCompactCurrency, formatDateDisplay, formatRelativeTime,
  shortEthAddress as shortEthAddressOrUnknown,
} from '../../utils/format';
import { explorerAddressUrl, explorerTxUrl } from '../../utils/chains';
import { spamReasonLabel } from '../../utils/dataLabels';

const shortEthAddress = (address) => shortEthAddressOrUnknown(address, '');

// One page of the spam quarantine (#74). The section is the only place the
// "Not spam" button exists, so the list has to be walkable to the end rather
// than truncated at a round number: during a spam wave the transaction worth
// rescuing is exactly the one a cap would hide.
export const SPAM_PAGE_SIZE = 50;
// GET /api/eth/activity clamps `limit` to 500, so a refetch cannot restore more
// than that in one request however many pages are open. Beyond it the appended
// pages are re-walked by offset instead; the clamp only bounds the single call.
export const SPAM_MAX_LIMIT = 500;

const TRIAGE_ACTION_CLASS = 'inline-flex h-7 items-center gap-1.5 rounded border border-border bg-surface-3 px-2 text-[9px] font-bold uppercase tracking-wide text-tertiary transition-all disabled:opacity-40';

// Every verdict a counterparty row can record, as ONE list -- the row used to
// carry a button per verdict, which pushed the heavier ones ("track this as a
// wallet", "ignore this token everywhere") into second-level panels where they
// read as afterthoughts. Flattened here so the choice is made once and the
// submit is the only click that writes anything.
//
// `own` and `track` are separate entries rather than one "It's mine" that then
// asks again: they are genuinely different actions (a label vs. an account plus
// a full history sync), and a dropdown can say so up front.
const VERDICT_OPTIONS = [
  { value: 'external', label: 'Outside party' },
  { value: 'exchange', label: "It's an exchange" },
  { value: 'service', label: 'Swap service' },
  { value: 'own', label: "Mine — don't track it" },
  { value: 'track', label: 'Mine — track as a wallet' },
];

// Which verdicts take a name, and whether it is required. An exchange name
// becomes the counterparty text AND the internal-transfer assertion, so it is
// mandatory; every other name is display only.
const NAME_FIELDS = {
  exchange: { required: true, placeholder: 'e.g. Coinbase', datalist: true },
  service: { required: false, placeholder: 'Optional name, e.g. Changelly', datalist: true },
  own: { required: false, placeholder: 'Optional name, e.g. Ledger cold storage', datalist: false },
  track: { required: false, placeholder: 'Optional name, e.g. Ledger cold storage', datalist: false },
};

const VERDICT_HINTS = {
  service: 'For an instant-swap deposit address (Changelly, ShapeShift). What you sent was sold, so it books as a trade rather than as a transfer between your own accounts — and what you bought will not appear on this chain.',
  own: 'Labelling only stops its transfers counting as spending — use that for addresses on another chain, ones already counted elsewhere, or ones you would rather not sync.',
  track: 'Tracking creates an account, pulls the full history, and counts the balance toward net worth.',
};

// One unreviewed counterparty. Defined at module scope, not inside the panel:
// a component redefined every render remounts, which would close the open
// naming panel on each keystroke.
// busy disables EVERY row while any verdict is in flight -- the handlers take
// one at a time, so leaving other rows clickable produced silent no-ops in the
// exact rapid-triage workflow this feature is built around. active spins only
// the row actually being worked on.
export function CounterpartyRow({
  counterparty,
  busy,
  active,
  onTriage,
  onTrackAsWallet,
  onIgnoreToken,
  onSaveNote,
}) {
  const [verdict, setVerdict] = useState('');
  const [name, setName] = useState('');
  const [note, setNote] = useState(counterparty.note || '');
  const short = shortEthAddress(counterparty.address);
  const symbol = counterparty.token_symbols?.[0];
  const nameField = NAME_FIELDS[verdict];
  // Ignoring a token is a verdict on the TOKEN, not on the address, and it is
  // the one entry here with no undo, so it is only offered where it is actually
  // actionable.
  const canIgnoreToken = Boolean(counterparty.sole_token_contract);
  const hint = verdict === 'ignore'
    ? `Ignoring ${symbol || 'this token'} removes it from holdings and activity in every wallet, not just this counterparty. If you also hold it legitimately, that position disappears too.`
    : VERDICT_HINTS[verdict];

  const submit = (event) => {
    event.preventDefault();
    if (busy || !verdict) return;
    const trimmed = name.trim();
    if (verdict === 'ignore') onIgnoreToken(counterparty);
    else if (verdict === 'track') onTrackAsWallet(counterparty.address, trimmed);
    else if (verdict === 'exchange') { if (trimmed) onTriage(counterparty.address, 'exchange', trimmed); }
    else onTriage(counterparty.address, verdict, trimmed);
  };

  return (
    <div className="px-4 py-3">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <span className="font-mono text-body-sm font-semibold text-primary" title={counterparty.address}>{short}</span>
            {/* Counterparties are chain-agnostic (one verdict covers every
                chain the address is reached on), so there is no chain here to
                key the explorer on: mainnet it is. */}
            <a
              href={explorerAddressUrl(counterparty.address)}
              target="_blank"
              rel="noreferrer"
              className="text-[10px] text-tertiary transition-colors hover:text-accent"
            >
              Etherscan
            </a>
            {counterparty.sent_count > 0 && (
              // The single most decision-relevant fact on the row: you cannot
              // receive a scam airdrop that you sent.
              <span className="inline-flex shrink-0 items-center rounded-full border border-accent/20 bg-accent/10 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide text-accent">
                You sent
              </span>
            )}
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-3 text-[10px] text-tertiary">
            <span className="font-mono">
              {counterparty.transfer_count} transfer{counterparty.transfer_count === 1 ? '' : 's'}
            </span>
            {/* Unpriced is not the same as worthless -- never render this as $0. */}
            <span className="font-mono">
              {Number(counterparty.usd_volume) > 0
                ? formatCompactCurrency(Number(counterparty.usd_volume))
                : 'No USD value'}
            </span>
            {counterparty.token_symbols?.length > 0 && (
              <span className="font-mono">{counterparty.token_symbols.slice(0, 3).join(' · ')}</span>
            )}
            <span>{formatDateDisplay(counterparty.first_seen)} → {formatRelativeTime(counterparty.last_seen)}</span>
          </div>
        </div>

        {/* One verdict picker, one submit. The name field appears beside it
            only for the verdicts that take one, so the row stays a single
            line for the common case and never hides an action behind a
            first click that records nothing. */}
        <form className="flex shrink-0 flex-wrap items-center gap-2" onSubmit={submit}>
          <select
            value={verdict}
            disabled={busy}
            aria-label={`Verdict for ${short}`}
            onChange={(event) => { setVerdict(event.target.value); setName(''); }}
            className="h-8 min-w-0 rounded border border-input-border bg-surface-2 px-2 text-body-sm text-primary outline-none focus:ring-1 focus:ring-accent disabled:opacity-40"
          >
            <option value="">What is this address?</option>
            {VERDICT_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>{option.label}</option>
            ))}
            {canIgnoreToken && <option value="ignore">Ignore {symbol || 'token'} everywhere</option>}
          </select>

          {nameField && (
            <input
              type="text"
              value={name}
              onChange={(event) => setName(event.target.value)}
              list={nameField.datalist ? 'crypto-eth-label-names' : undefined}
              maxLength={64}
              placeholder={nameField.placeholder}
              aria-label={`Name for ${short}`}
              className="h-8 w-44 min-w-0 rounded border border-input-border bg-surface-2 px-2 text-body-sm text-primary outline-none focus:ring-1 focus:ring-accent"
            />
          )}

          <button
            type="submit"
            disabled={busy || !verdict || (nameField?.required && !name.trim())}
            aria-label={`Apply verdict — ${short}`}
            className={`inline-flex h-8 items-center gap-1.5 rounded border px-3 text-[9px] font-bold uppercase tracking-wide transition-all disabled:opacity-40 ${
              verdict === 'ignore'
                ? 'border-loss/30 bg-loss-bg text-loss'
                : 'border-accent/30 bg-accent/10 text-accent hover:bg-accent/20'
            }`}
          >
            {active ? <RefreshCw size={10} className="animate-spin" /> : <Check size={10} />} Apply
          </button>
        </form>
      </div>

      {/* The consequence of the selected verdict, before it is applied. The
          heavy ones -- tracking creates an account and runs a full sync,
          ignoring a token is user-global with no undo -- were previously
          gated behind a confirm panel; choosing them here shows the same
          warning while Apply is still unpressed. */}
      {hint && (
        <p className="mt-2 text-[10px] leading-relaxed text-tertiary">{hint}</p>
      )}
      <div className="mt-2 flex items-center gap-2">
        <textarea
          value={note}
          onChange={(event) => setNote(event.target.value)}
          rows={2}
          placeholder="Add evidence or a reminder without choosing a verdict"
          aria-label={`Note for ${short}`}
          className="min-h-12 min-w-0 flex-1 resize-y rounded border border-input-border bg-surface-2 px-2 py-1.5 text-body-sm text-primary outline-none focus:ring-1 focus:ring-accent"
        />
        <button
          type="button"
          onClick={() => onSaveNote(counterparty.address, note)}
          disabled={busy || note === (counterparty.note || '')}
          className={TRIAGE_ACTION_CLASS}
        >
          {active ? <RefreshCw size={10} className="animate-spin" /> : <Check size={10} />}
          Save note
        </button>
      </div>
    </div>
  );
}

// The two triage queues, side by side because they are the same job: deciding
// what an unexplained counterparty was. Needs Review is what the ladder could
// not name; Quarantined is what the spam heuristics named for you and might
// have got wrong.
function ReviewPanel({
  counterpartyData,
  spamActivity,
  onSpamPageLoaded,
  exchangeNameOptions,
  hasWallets,
  onChanged,
  onError,
  showSuccess,
  onRetry,
}) {
  const [triagingAddress, setTriagingAddress] = useState(null);
  const [showDust, setShowDust] = useState(false);
  const [showSpam, setShowSpam] = useState(false);
  const [unquarantiningTx, setUnquarantiningTx] = useState(null);
  const [loadingMoreSpam, setLoadingMoreSpam] = useState(false);

  const rows = counterpartyData?.data || [];
  const materialCounterparties = rows.filter((cp) => cp.material);
  const dustCounterparties = rows.filter((cp) => !cp.material);

  // Triage verdicts. All of them are label writes and all are reversible with
  // one click from the Labels tab, so none of them confirms -- matching the
  // label list's Remove. The full refetch is mandatory: one action drops a
  // queue row, adds a label row, and moves the tab badge.
  //
  // The message names the verdict that was recorded, so every kind needs its
  // own arm: a default that says "outside party" for anything unrecognised
  // reports the wrong verdict rather than none.
  const TRIAGE_MESSAGES = {
    exchange: (short, name) => `Labeled ${short} as ${name}`,
    own: (short) => `${short} marked as yours`,
    service: (short, name) => `${short} marked as a swap service${name ? ` (${name})` : ''}`,
    external: (short) => `${short} marked as an outside party`,
  };

  const handleTriage = async (address, kind, name) => {
    if (triagingAddress) return;
    setTriagingAddress(address);
    onError(null);
    try {
      await ethAPI.labelAddress(address, name || null, { kind });
      const short = shortEthAddress(address);
      showSuccess((TRIAGE_MESSAGES[kind] || TRIAGE_MESSAGES.external)(short, name));
      await onChanged();
    } catch (err) {
      onError(err.response?.data?.error || 'Failed to review counterparty');
    } finally {
      setTriagingAddress(null);
    }
  };

  const handleSaveNote = async (address, note) => {
    if (triagingAddress) return;
    setTriagingAddress(address);
    onError(null);
    try {
      if (note.trim()) await ethAPI.saveAddressNote(address, note.trim());
      else if (rows.find((item) => item.address === address)?.note) await ethAPI.deleteAddressNote(address);
      showSuccess(note.trim() ? `Note saved for ${shortEthAddress(address)}` : 'Address note removed');
      await onChanged();
    } catch (err) {
      onError(err.response?.data?.error || 'Failed to save address note');
    } finally {
      setTriagingAddress(null);
    }
  };

  // The heavy verdict: creates an account, pulls full history, and counts the
  // balance toward net worth. Reuses the normal add-wallet path, which already
  // reclassifies every existing transfer against the new own-address.
  const handleTrackAsWallet = async (address, label) => {
    if (triagingAddress) return;
    setTriagingAddress(address);
    onError(null);
    try {
      await ethAPI.addWallet(address, label || null);
      showSuccess(`Now tracking ${shortEthAddress(address)} as a wallet`);
      await onChanged();
    } catch (err) {
      onError(err.response?.data?.error || 'Failed to track that address as a wallet');
    } finally {
      setTriagingAddress(null);
    }
  };

  const handleIgnoreCounterpartyToken = async (counterparty) => {
    if (triagingAddress) return;
    setTriagingAddress(counterparty.address);
    onError(null);
    try {
      await ethAPI.ignoreToken(counterparty.sole_token_contract, counterparty.token_symbols?.[0] || undefined);
      showSuccess('Token ignored');
      await onChanged();
    } catch (err) {
      onError(err.response?.data?.error || 'Failed to ignore token');
    } finally {
      setTriagingAddress(null);
    }
  };

  // One click, and the transaction comes back exactly as it was: the ladder's
  // category, its legs, its dollars and its review flag. The verdict is written
  // to the overrides table, so it outlives every resync -- and the counterparty
  // rejoins the triage queue, which is where it belongs the moment the user
  // says this was not junk.
  const handleUnquarantine = async (row) => {
    if (unquarantiningTx) return;
    setUnquarantiningTx(row.tx_hash);
    onError(null);
    try {
      await ethAPI.setActivitySpam(row.wallet_id, row.tx_hash, false, { chainId: row.chain_id });
      showSuccess('Restored to the ledger');
      await onChanged();
    } catch (err) {
      onError(err.response?.data?.error || 'Failed to restore that transaction');
    } finally {
      setUnquarantiningTx(null);
    }
  };

  // The next page of the quarantine, appended. Offset pagination against the
  // feed the section already uses -- no new endpoint, and the header keeps
  // reporting summary.spam_count, so "showing 100 of 412" stays true throughout.
  //
  // De-duplicated on the way in: the feed is ordered, but a row rescued from an
  // earlier page shifts everything below it up by one, and the same transaction
  // arriving twice is a duplicate React key and a second "Not spam" button for
  // a transaction already restored.
  const handleShowMoreSpam = async () => {
    if (loadingMoreSpam) return;
    const loaded = spamActivity?.data || [];
    setLoadingMoreSpam(true);
    onError(null);
    try {
      const next = await ethAPI.getActivity({
        spam: 'only', limit: SPAM_PAGE_SIZE, offset: loaded.length,
      });
      const seen = new Set(loaded.map((row) => `${row.chain_id}:${row.tx_hash}`));
      const added = (next.data || []).filter((row) => !seen.has(`${row.chain_id}:${row.tx_hash}`));
      onSpamPageLoaded({ ...next, data: [...loaded, ...added] });
    } catch (err) {
      onError(err.response?.data?.error || 'Failed to load more quarantined transactions');
    } finally {
      setLoadingMoreSpam(false);
    }
  };

  if (!hasWallets) {
    return (
      <p className="text-body-sm text-tertiary">
        Nothing to review yet. Counterparties and quarantined transactions appear once a wallet has synced.
      </p>
    );
  }

  return (
    <>
      <section aria-labelledby="eth-review-heading">
        <div className="mb-3 px-2">
          <h2 id="eth-review-heading" className="text-lg font-bold uppercase tracking-tight text-primary">Needs Review</h2>
          <p className="mt-1 text-xs text-secondary">
            Addresses you have transacted with but never given a verdict on. Until you do, their transfers
            count as external activity — so a hot wallet an exchange rotated to, or one of your own
            addresses, quietly reads as real spending. Marking an address as an exchange or as yours takes
            its transfers out of spending, which is only right if that money is still counted somewhere
            else: a linked account, or a wallet tracked here.
          </p>
        </div>

        <datalist id="crypto-eth-label-names">
          {exchangeNameOptions.map((name) => <option key={name} value={name} />)}
        </datalist>

        <div className="card overflow-hidden">
          {!counterpartyData ? (
            // Loaded-and-empty and failed-to-load must not look alike. Showing
            // "all reviewed" after a failed request is the same silence this
            // whole section exists to break, and the badge drops too.
            <div className="flex flex-wrap items-center justify-between gap-3 p-4 text-sm text-secondary">
              <span className="flex items-center gap-2 text-loss">
                <AlertTriangle size={14} />
                Couldn&apos;t load the review queue.
              </span>
              <button
                type="button"
                onClick={onRetry}
                className="inline-flex h-8 items-center gap-1.5 rounded border border-border bg-surface-3 px-3 text-[9px] font-bold uppercase tracking-wide text-tertiary transition-all hover:border-accent hover:text-accent"
              >
                <RefreshCw size={10} /> Retry
              </button>
            </div>
          ) : materialCounterparties.length === 0 && dustCounterparties.length === 0 ? (
            <div className="p-6 text-center text-sm text-secondary">Every counterparty has been reviewed.</div>
          ) : (
            <div className="divide-y divide-border">
              {materialCounterparties.map((counterparty) => (
                <CounterpartyRow
                  key={counterparty.address}
                  counterparty={counterparty}
                  busy={Boolean(triagingAddress)}
                  active={triagingAddress === counterparty.address}
                  onTriage={handleTriage}
                  onTrackAsWallet={handleTrackAsWallet}
                  onIgnoreToken={handleIgnoreCounterpartyToken}
                  onSaveNote={handleSaveNote}
                />
              ))}
            </div>
          )}

          {dustCounterparties.length > 0 && (
            // Collapsed rather than paginated: the distribution is bimodal
            // (a few real counterparties, a long tail of $0 inbound-only
            // airdrop senders), and pagination would interleave the two.
            <>
              <button
                type="button"
                aria-expanded={showDust}
                onClick={() => setShowDust((open) => !open)}
                className="flex w-full items-center justify-between gap-2 border-t border-border px-4 py-3 text-caption text-tertiary transition-colors hover:text-primary"
              >
                {/* The server's count, not the page's: the response is capped,
                    so the rendered array can be smaller than the real total. */}
                <span>{counterpartyData?.summary?.dust_count ?? dustCounterparties.length} low-value counterparties</span>
                <ChevronDown size={14} className={showDust ? 'rotate-180 transition-transform' : 'transition-transform'} />
              </button>
              {showDust && (
                <div className="divide-y divide-border">
                  {dustCounterparties.map((counterparty) => (
                    <CounterpartyRow
                      key={counterparty.address}
                      counterparty={counterparty}
                      busy={Boolean(triagingAddress)}
                      active={triagingAddress === counterparty.address}
                      onTriage={handleTriage}
                      onTrackAsWallet={handleTrackAsWallet}
                      onIgnoreToken={handleIgnoreCounterpartyToken}
                      onSaveNote={handleSaveNote}
                    />
                  ))}
                </div>
              )}
            </>
          )}
        </div>
      </section>

      <section aria-labelledby="eth-spam-heading">
        <div className="mb-3 px-2">
          <h2 id="eth-spam-heading" className="text-lg font-bold uppercase tracking-tight text-primary">Quarantined wallet transactions</h2>
          <p className="mt-1 text-xs text-secondary">
            Address-poisoning attempts, dust and scam airdrops, recognized automatically and kept out of
            Needs Review — a queue that fills with junk faster than anyone can drain it is a queue that gets
            ignored. Nothing is deleted: these transactions keep their amounts and still count toward the
            balance checks, they are just out of the way. If one of them is real, restore it in a click and
            the choice sticks through every future sync.
          </p>
          <p className="mt-1 text-xs text-tertiary">
            Counted per wallet transaction: a transfer that touched two of your wallets is listed once for
            each. The Ledger folds those into single movements, so its quarantine count can be lower.
          </p>
        </div>

        <div className="card overflow-hidden">
          {!spamActivity ? (
            // Loaded-and-empty and failed-to-load must not look alike here
            // either: "nothing was hidden" is exactly the claim a failed
            // request must not be allowed to make.
            <div className="flex flex-wrap items-center justify-between gap-3 p-4 text-sm text-secondary">
              <span className="flex items-center gap-2 text-loss">
                <AlertTriangle size={14} />
                Couldn&apos;t load the quarantine.
              </span>
              <button
                type="button"
                onClick={onRetry}
                className="inline-flex h-8 items-center gap-1.5 rounded border border-border bg-surface-3 px-3 text-[9px] font-bold uppercase tracking-wide text-tertiary transition-all hover:border-accent hover:text-accent"
              >
                <RefreshCw size={10} /> Retry
              </button>
            </div>
          ) : (spamActivity.summary?.spam_count || 0) === 0 ? (
            <div className="p-6 text-center text-sm text-secondary">Nothing has been quarantined.</div>
          ) : (
            <>
              <button
                type="button"
                aria-expanded={showSpam}
                onClick={() => setShowSpam((open) => !open)}
                className="flex w-full items-center justify-between gap-2 px-4 py-3 text-caption text-tertiary transition-colors hover:text-primary"
              >
                {/* The server's count, not the page's: the list is capped, so
                    the rendered array can be smaller than the real total. */}
                <span>
                  {/* Per WALLET-transaction, which is the unit
                      /api/eth/activity counts. The unified ledger collapses
                      cross-wallet duplicates, so its count is not this one --
                      see the BOOL_AND note in models/CryptoLedger.js. */}
                  {spamActivity.summary.spam_count} quarantined wallet transaction{spamActivity.summary.spam_count === 1 ? '' : 's'}
                </span>
                <ChevronDown size={14} className={showSpam ? 'rotate-180 transition-transform' : 'transition-transform'} />
              </button>
              {showSpam && (
                <div className="divide-y divide-border border-t border-border">
                  {(spamActivity.data || []).map((row) => {
                    const reason = spamReasonLabel(row.spam_reason);
                    return (
                      <div key={`${row.chain_id}:${row.tx_hash}`} className="flex flex-wrap items-start justify-between gap-3 p-4">
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className={`inline-flex items-center border px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide ${reason.warn ? 'border-loss/20 bg-loss/10 text-loss' : 'border-border bg-surface-3 text-tertiary'}`}>
                              {reason.title}
                            </span>
                            <span className="text-[10px] uppercase tracking-wider text-tertiary">
                              {formatDateDisplay(row.block_time)}
                            </span>
                            <a
                              href={explorerTxUrl(row.tx_hash, row.chain_id)}
                              target="_blank"
                              rel="noreferrer"
                              title={row.tx_hash}
                              className="font-mono text-[10px] text-tertiary transition-colors hover:text-accent"
                            >
                              {row.tx_hash.slice(0, 10)}…
                            </a>
                          </div>
                          <p className="mt-1 text-xs text-secondary">{reason.detail}</p>
                          {/* What actually moved is still on the row, and
                              saying so is the difference between a hidden
                              transaction and a deleted one. */}
                          {(row.legs || []).length > 0 && (
                            <p className="mt-1 font-mono text-[10px] text-tertiary">
                              {row.legs.map((legRow) => `${legRow.direction === 'out' ? '-' : '+'}${legRow.amount} ${legRow.asset}`).join(', ')}
                            </p>
                          )}
                        </div>
                        <button
                          type="button"
                          onClick={() => handleUnquarantine(row)}
                          disabled={Boolean(unquarantiningTx)}
                          className="inline-flex h-9 shrink-0 items-center justify-center gap-2 rounded border border-border bg-surface-3 px-3 text-xs font-bold uppercase tracking-wider text-secondary transition-all hover:text-primary disabled:opacity-40"
                        >
                          {unquarantiningTx === row.tx_hash
                            ? <RefreshCw size={14} className="animate-spin" />
                            : <Undo2 size={14} />}
                          Not spam
                        </button>
                      </div>
                    );
                  })}
                  {/* The list is walkable to the end, not truncated: this is
                      the only surface carrying "Not spam", so a transaction
                      the heuristics got wrong has to stay reachable however
                      much junk arrived above it. */}
                  {(spamActivity.pagination?.total || 0) > (spamActivity.data || []).length && (
                    <div className="flex flex-wrap items-center justify-between gap-3 p-3">
                      <span className="text-[10px] uppercase tracking-wider text-tertiary">
                        Showing the {(spamActivity.data || []).length} most recent of {spamActivity.pagination.total}
                      </span>
                      <button
                        type="button"
                        onClick={handleShowMoreSpam}
                        disabled={loadingMoreSpam}
                        className="inline-flex h-8 items-center gap-1.5 rounded border border-border bg-surface-3 px-3 text-[9px] font-bold uppercase tracking-wide text-tertiary transition-all hover:border-accent hover:text-accent disabled:opacity-40"
                      >
                        {loadingMoreSpam && <RefreshCw size={10} className="animate-spin" />}
                        Show more
                      </button>
                    </div>
                  )}
                </div>
              )}
            </>
          )}
        </div>
      </section>
    </>
  );
}

export default ReviewPanel;

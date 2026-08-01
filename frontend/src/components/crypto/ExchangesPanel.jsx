import React, { useEffect, useRef, useState } from 'react';
import { motion as Motion } from 'framer-motion';
import {
  AlertTriangle, ArrowLeftRight, Check, ChevronDown, Clock, Link2, Pencil, Plus,
  RefreshCw, Save, ShieldCheck, Trash2, Unlink, Upload, X,
} from 'lucide-react';
import { exchanges as exchangesAPI } from '../../utils/api';
import { formatDateDisplay, formatRelativeTime } from '../../utils/format';

// The venues the backend accepts. Coinbase covers both the retail export and a
// Coinbase Pro / Exchange statement -- the importer recognizes which is which
// from the file's own header, so the user never has to say.
const EXCHANGE_VENUES = [
  { id: 'coinbase', label: 'Coinbase' },
  { id: 'kraken', label: 'Kraken' },
  { id: 'binance_us', label: 'Binance.US' },
  { id: 'other', label: 'Other' },
];
const EXCHANGE_VENUE_LABELS = Object.fromEntries(EXCHANGE_VENUES.map((v) => [v.id, v.label]));
const IMPORT_FORMAT_LABELS = {
  coinbase_retail: 'Coinbase transactions export',
  coinbase_pro: 'Coinbase Pro account statement',
  kraken: 'Kraken ledgers export',
  binance_us: 'Binance.US account activity export',
  generic: 'generic column mapping',
};

// Why a record is in the review queue. The importer does not store a reason --
// it stores the source row -- so this reads the shape of what it produced. A
// queue of rows with no stated reason is a queue nobody works through.
const exchangeReviewReason = (record) => {
  const raw = record?.raw || {};
  const rows = Array.isArray(raw.rows) ? raw.rows : null;
  const sourceType = raw['Transaction Type'] || raw.type || rows?.[0]?.type || null;

  if (record?.base_amount === null || record?.base_amount === undefined) {
    return 'the amount in this row could not be read';
  }
  if (record?.record_type === 'fee') {
    return 'a fee with no trade in the file to attach it to';
  }
  if ((record?.record_type === 'trade' || record?.record_type === 'conversion') && !record?.quote_asset) {
    return 'only one side of this trade is in the file';
  }
  return sourceType ? `unrecognized row type "${sourceType}"` : 'flagged while importing';
};

const exchangeRecordAmount = (record) => {
  if (record?.base_amount === null || record?.base_amount === undefined) return '—';
  const amount = Number(record.base_amount);
  if (!Number.isFinite(amount)) return record.base_amount;
  return amount.toLocaleString(undefined, { maximumFractionDigits: 8 });
};

// Exchange accounts: read-only API keys, CSV imports, and the per-account queue
// of records the importer could not fully read.
function ExchangesPanel({
  accounts,
  loadFailed,
  credentialFields,
  encryptionConfigured,
  onChanged,
  onError,
  showSuccess,
  onRetry,
}) {
  const [nameInput, setNameInput] = useState('');
  const [venue, setVenue] = useState('coinbase');
  const [adding, setAdding] = useState(false);
  const [formError, setFormError] = useState(null);
  const [importingId, setImportingId] = useState(null);
  // Per account, so one failed upload does not blank another account's receipt.
  const [importResults, setImportResults] = useState({});
  const [deletingId, setDeletingId] = useState(null);
  const [renamingId, setRenamingId] = useState(null);
  const [renameValue, setRenameValue] = useState('');
  // Which account's connect form is open, plus its two (never pre-filled)
  // inputs. A stored key never comes back from the server, so there is nothing
  // to pre-fill with and an empty form is the honest one.
  const [connectingId, setConnectingId] = useState(null);
  const [credentialInputs, setCredentialInputs] = useState({ apiKey: '', apiSecret: '' });
  const [savingCredentialsId, setSavingCredentialsId] = useState(null);
  const [disconnectingId, setDisconnectingId] = useState(null);
  const [testingId, setTestingId] = useState(null);
  const [syncingIds, setSyncingIds] = useState(() => new Set());
  // Per account, so one account's failure does not blank another's receipt.
  const [syncResults, setSyncResults] = useState({});
  // Durable server-side job snapshots. These survive a page reload because the
  // status endpoint returns the latest completed job as well as active work.
  const [syncStatuses, setSyncStatuses] = useState({});
  const completionNotifiedRef = useRef(new Set());
  const syncingIdsRef = useRef(syncingIds);
  const syncStatusesRef = useRef(syncStatuses);
  syncingIdsRef.current = syncingIds;
  syncStatusesRef.current = syncStatuses;
  const [statusPollNonce, setStatusPollNonce] = useState(0);
  // Per account: the flagged records, once the user opens the disclosure.
  const [reviewQueues, setReviewQueues] = useState({});
  const [openReviewAccountId, setOpenReviewAccountId] = useState(null);
  const [resolvingRecordId, setResolvingRecordId] = useState(null);
  const [matchAudit, setMatchAudit] = useState(null);
  const [loadingMatchAudit, setLoadingMatchAudit] = useState(false);

  // Poll only while there is an active job. The first read also restores a
  // completed receipt after a reload, and the server's durable status means a
  // browser tab closing cannot make an in-flight provider walk look lost.
  useEffect(() => {
    if (typeof exchangesAPI.getSyncStatus !== 'function') return undefined;
    let cancelled = false;
    let timer = null;
    let statusReadFailures = 0;

    const poll = async () => {
      const connected = accounts.filter((account) => account.credentials?.configured);
      const snapshots = await Promise.all(connected.map(async (account) => {
        try {
          const response = await exchangesAPI.getSyncStatus(account.id);
          return { accountId: account.id, job: response.job || null };
        } catch {
          // A transient status read failure must not erase a visible active
          // state or claim the server has completed the backfill.
          return null;
        }
      }));
      if (cancelled) return;

      const usable = snapshots.filter(Boolean);
      const failedReads = usable.length < connected.length;
      if (failedReads) statusReadFailures += 1;
      else statusReadFailures = 0;
      const active = usable.filter(({ job }) => job && ['queued', 'running', 'backoff'].includes(job.status));
      setSyncStatuses((previous) => {
        const next = { ...previous };
        usable.forEach(({ accountId, job }) => { next[accountId] = job; });
        return next;
      });
      setSyncingIds((previous) => {
        const next = new Set(previous);
        const successfulIds = new Set(usable.map(({ accountId }) => accountId));
        const connectedIds = new Set(connected.map((account) => account.id));
        for (const id of next) {
          if (!connectedIds.has(id)) next.delete(id);
        }
        connected.forEach((account) => {
          if (!successfulIds.has(account.id)) return;
          if (active.some(({ accountId }) => accountId === account.id)) next.add(account.id);
          else next.delete(account.id);
        });
        return next;
      });

      const completed = usable.filter(({ accountId, job }) => (
        job?.status === 'completed'
          && !completionNotifiedRef.current.has(`${accountId}:${job.id}`)
      ));
      if (completed.length > 0) {
        completed.forEach(({ accountId, job }) => completionNotifiedRef.current.add(`${accountId}:${job.id}`));
        // Refresh record counts and the review badge once, after the worker's
        // final batch commits. Polling itself remains read-only.
        void onChanged();
      }
      const localActive = connected.some((account) => {
        const local = syncingIdsRef.current.has(account.id);
        const prior = syncStatusesRef.current[account.id];
        return local || (prior && ['queued', 'running', 'backoff'].includes(prior.status));
      });
      const backoffDelays = active
        .filter(({ job }) => job.status === 'backoff' && job.next_run_at)
        .map(({ job }) => Math.max(2500, new Date(job.next_run_at).getTime() - Date.now()));
      const validBackoffDelays = backoffDelays.filter(Number.isFinite);
      const nextDelay = validBackoffDelays.length > 0 ? Math.min(...validBackoffDelays) : 2500;
      // A backoff can last 15 minutes; polling every 2.5s would hit the app's
      // own request limit. A failed status read still gets retried, but only
      // while a local or previously observed active job needs it. On a page
      // reload, also give a short-lived network hiccup a few read-only retries
      // so an active server job is not lost before the first successful poll.
      if (active.length > 0) timer = setTimeout(poll, nextDelay);
      else if (failedReads && (localActive || statusReadFailures <= 3)) timer = setTimeout(poll, 5000);
    };

    void poll();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [accounts, onChanged, statusPollNonce]);

  const handleAddAccount = async (event) => {
    event.preventDefault();
    if (adding) return;
    const name = nameInput.trim();
    if (!name) {
      setFormError('Enter a name for this exchange account');
      return;
    }
    setAdding(true);
    setFormError(null);
    try {
      await exchangesAPI.create(name, venue);
      showSuccess('Exchange account added');
      setNameInput('');
      await onChanged();
    } catch (err) {
      setFormError(err.response?.data?.error || 'Failed to add exchange account');
    } finally {
      setAdding(false);
    }
  };

  const handleImport = async (account, event) => {
    const file = event.target.files?.[0];
    // Cleared immediately so picking the same file again re-fires onChange --
    // otherwise a failed upload cannot be retried without choosing another file.
    event.target.value = '';
    if (!file) return;

    setImportingId(account.id);
    setImportResults((prev) => ({ ...prev, [account.id]: null }));
    try {
      const text = await file.text();
      const result = await exchangesAPI.importCsv(account.id, text);
      setImportResults((prev) => ({ ...prev, [account.id]: { ...result, fileName: file.name } }));
      await onChanged();
    } catch (err) {
      setImportResults((prev) => ({
        ...prev,
        // The server's message names the format problem; it is the only thing
        // that tells the user which export to reach for instead.
        [account.id]: { error: err.response?.data?.error || 'Failed to import this file', fileName: file.name },
      }));
    } finally {
      setImportingId(null);
    }
  };

  const handleDeleteAccount = async (account) => {
    setDeletingId(null);
    try {
      await exchangesAPI.remove(account.id);
      showSuccess('Exchange account deleted');
      await onChanged();
    } catch (err) {
      onError(err.response?.data?.error || 'Failed to delete exchange account');
    }
  };

  const handleRenameAccount = async (account) => {
    const name = renameValue.trim();
    if (!name || name === account.name) {
      setRenamingId(null);
      return;
    }
    try {
      await exchangesAPI.update(account.id, { name });
      showSuccess('Exchange account renamed');
      setRenamingId(null);
      await onChanged();
    } catch (err) {
      onError(err.response?.data?.error || 'Failed to rename exchange account');
    }
  };

  const openConnectForm = (account) => {
    setConnectingId(account.id);
    // Always empty. The server never returns a stored key, so a pre-filled
    // field could only ever be a lie about what is saved.
    setCredentialInputs({ apiKey: '', apiSecret: '' });
    setSyncResults((prev) => ({ ...prev, [account.id]: null }));
  };

  const handleSaveCredentials = async (account, event) => {
    event.preventDefault();
    if (savingCredentialsId) return;
    const apiKey = credentialInputs.apiKey.trim();
    const apiSecret = credentialInputs.apiSecret.trim();
    const fields = credentialFields[account.exchange] || {};
    if (!apiKey || !apiSecret) {
      setSyncResults((prev) => ({
        ...prev,
        [account.id]: { error: `Enter both the ${fields.keyLabel || 'API key'} and the ${fields.secretLabel || 'secret'}.` },
      }));
      return;
    }
    setSavingCredentialsId(account.id);
    try {
      await exchangesAPI.setCredentials(account.id, apiKey, apiSecret);
      // Cleared immediately: the plaintext key has no reason to stay in
      // component state once the server has it.
      setCredentialInputs({ apiKey: '', apiSecret: '' });
      setConnectingId(null);
      setSyncingIds((previous) => {
        const next = new Set(previous);
        next.delete(account.id);
        return next;
      });
      setSyncStatuses((previous) => {
        const next = { ...previous };
        delete next[account.id];
        return next;
      });
      setSyncResults((previous) => ({ ...previous, [account.id]: null }));
      completionNotifiedRef.current = new Set(
        [...completionNotifiedRef.current].filter((key) => !key.startsWith(`${account.id}:`))
      );
      showSuccess('API key saved');
      await onChanged();
    } catch (err) {
      setSyncResults((prev) => ({
        ...prev,
        [account.id]: { error: err.response?.data?.error || 'Failed to save the API key' },
      }));
    } finally {
      setSavingCredentialsId(null);
    }
  };

  const handleDisconnect = async (account) => {
    setDisconnectingId(null);
    try {
      await exchangesAPI.clearCredentials(account.id);
      setSyncingIds((previous) => {
        const next = new Set(previous);
        next.delete(account.id);
        return next;
      });
      setSyncStatuses((previous) => {
        const next = { ...previous };
        delete next[account.id];
        return next;
      });
      setSyncResults((previous) => ({ ...previous, [account.id]: null }));
      showSuccess('API key removed; imported records were kept');
      await onChanged();
    } catch (err) {
      onError(err.response?.data?.error || 'Failed to remove the API key');
    }
  };

  const handleTestConnection = async (account) => {
    setTestingId(account.id);
    setSyncResults((prev) => ({ ...prev, [account.id]: null }));
    try {
      const result = await exchangesAPI.testConnection(account.id);
      setSyncResults((prev) => ({ ...prev, [account.id]: { tested: result.detail } }));
    } catch (err) {
      // The provider's own refusal names the permission that was forgotten, so
      // it reaches the screen verbatim rather than as "connection failed".
      setSyncResults((prev) => ({
        ...prev,
        [account.id]: { error: err.response?.data?.error || 'Could not reach the exchange' },
      }));
    } finally {
      setTestingId(null);
    }
  };

  const handleSync = async (account) => {
    setSyncingIds((previous) => new Set(previous).add(account.id));
    setSyncResults((prev) => ({ ...prev, [account.id]: null }));
    try {
      // New clients enqueue a durable backfill. The fallback keeps older
      // embedded/test clients working while they roll forward.
      const result = typeof exchangesAPI.startSync === 'function'
        ? await exchangesAPI.startSync(account.id)
        : await exchangesAPI.sync(account.id);
      if (result?.job) {
        setSyncStatuses((previous) => ({ ...previous, [account.id]: result.job }));
        setSyncResults((prev) => ({ ...prev, [account.id]: { job: result.job } }));
        setStatusPollNonce((nonce) => nonce + 1);
        // Counts are unchanged until a batch commits; the poller refreshes
        // them once the durable job reaches completed.
        return;
      }
      // Compatibility receipt from the legacy bounded endpoint.
      setSyncingIds((previous) => {
        const next = new Set(previous);
        next.delete(account.id);
        return next;
      });
      setSyncResults((prev) => ({ ...prev, [account.id]: { sync: result } }));
      await onChanged();
    } catch (err) {
      setSyncResults((prev) => ({
        ...prev,
        [account.id]: { error: err.response?.data?.error || 'Failed to sync from the exchange' },
      }));
      setSyncingIds((previous) => {
        const next = new Set(previous);
        next.delete(account.id);
        return next;
      });
    } finally {
      // A queued job stays disabled until polling observes completed/failed.
      // The legacy synchronous fallback has already finished here.
      if (typeof exchangesAPI.startSync !== 'function') {
        setSyncingIds((previous) => {
          const next = new Set(previous);
          next.delete(account.id);
          return next;
        });
      }
    }
  };

  // Fetched on open rather than with the page: most accounts have nothing
  // flagged, and the queue is the one list that must be current when read.
  const loadReviewQueue = async (accountId) => {
    setReviewQueues((prev) => ({ ...prev, [accountId]: { ...prev[accountId], loading: true, error: null } }));
    try {
      const data = await exchangesAPI.getRecords(accountId, { needs_review: true, limit: 100 });
      setReviewQueues((prev) => ({
        ...prev,
        [accountId]: { records: data.data || [], total: data.pagination?.total ?? 0, loading: false, error: null },
      }));
    } catch (err) {
      setReviewQueues((prev) => ({
        ...prev,
        [accountId]: {
          records: [], total: 0, loading: false,
          error: err.response?.data?.error || 'Failed to load the flagged records',
        },
      }));
    }
  };

  const handleToggleReviewQueue = async (account) => {
    if (openReviewAccountId === account.id) {
      setOpenReviewAccountId(null);
      return;
    }
    setOpenReviewAccountId(account.id);
    await loadReviewQueue(account.id);
  };

  const handleResolveRecord = async (account, record) => {
    setResolvingRecordId(record.id);
    try {
      await exchangesAPI.resolveRecord(account.id, record.id);
      // Dropped from the list rather than re-fetched: the row is gone from the
      // queue by definition, and the account's badge is refreshed below.
      setReviewQueues((prev) => {
        const queue = prev[account.id];
        if (!queue) return prev;
        return {
          ...prev,
          [account.id]: {
            ...queue,
            records: queue.records.filter((row) => row.id !== record.id),
            total: Math.max((queue.total ?? 1) - 1, 0),
          },
        };
      });
      await onChanged();
    } catch (err) {
      onError(err.response?.data?.error || 'Failed to mark this record reviewed');
    } finally {
      setResolvingRecordId(null);
    }
  };

  const handleLoadMatchAudit = async () => {
    if (loadingMatchAudit) return;
    setLoadingMatchAudit(true);
    try {
      setMatchAudit(await exchangesAPI.getMatches({ limit: 100 }));
    } catch (err) {
      onError(err.response?.data?.error || 'Failed to load exchange match audit');
    } finally {
      setLoadingMatchAudit(false);
    }
  };

  return (
    <section aria-labelledby="exchange-accounts-heading">
      <div className="mb-3 px-2">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 id="exchange-accounts-heading" className="text-lg font-bold uppercase tracking-tight text-primary">Exchange Accounts</h2>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={handleLoadMatchAudit}
              disabled={loadingMatchAudit}
              className="inline-flex h-8 items-center gap-1.5 rounded border border-border bg-surface-3 px-3 text-[9px] font-bold uppercase tracking-wide text-tertiary transition-all hover:border-accent hover:text-accent disabled:opacity-40"
            >
              <Link2 size={11} /> {loadingMatchAudit ? 'Loading…' : 'Match audit'}
            </button>
            <a
              href={exchangesAPI.matchesExportUrl()}
              className="inline-flex h-8 items-center gap-1.5 rounded border border-border bg-surface-3 px-3 text-[9px] font-bold uppercase tracking-wide text-tertiary transition-all hover:border-accent hover:text-accent"
            >
              <Upload size={11} /> Export pairings
            </a>
          </div>
        </div>
        <p className="mt-1 text-xs text-secondary">
          Trades, moves between exchanges and fiat on and off ramps never touch a tracked wallet, so no
          on-chain source can show them. Connect a <span className="font-semibold text-primary">read-only
          API key</span> to a live Kraken or Coinbase account and it stays current on its own; upload a
          CSV export for anything else — a closed account, an unsupported exchange, or history that
          predates the key. Coinbase, Coinbase Pro and Kraken exports are read directly; other files are
          matched by column name, and a timestamp with no time zone in it is read as UTC. The two sources
          mix freely: records are keyed by the event the exchange recorded, so nothing lands twice, and a
          trade an earlier date-limited export could only half describe is completed rather than
          duplicated.
        </p>
      </div>

      {matchAudit && (
        <div className="card mb-4 overflow-hidden border-border">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-5 py-4">
            <div>
              <h3 className="text-sm font-bold uppercase tracking-tight text-primary">Exchange match audit</h3>
              <p className="mt-1 text-xs text-secondary">Pairings are derived evidence; confirm or reject them from the ledger before treating them as final.</p>
            </div>
            <button type="button" onClick={() => setMatchAudit(null)} className="rounded border border-transparent p-1.5 text-tertiary hover:text-primary" aria-label="Close match audit"><X size={15} /></button>
          </div>
          <div className="grid grid-cols-2 gap-3 border-b border-border px-5 py-4 text-xs md:grid-cols-4">
            <div><p className="text-tertiary">Matched</p><p className="mt-1 font-mono font-semibold text-primary">{(matchAudit.summary?.matched || 0).toLocaleString()}</p></div>
            <div><p className="text-tertiary">Unmatched exchange</p><p className="mt-1 font-mono font-semibold text-loss">{(matchAudit.summary?.unmatchedRecords || 0).toLocaleString()}</p></div>
            <div><p className="text-tertiary">Unmatched on-chain</p><p className="mt-1 font-mono font-semibold text-loss">{(matchAudit.summary?.unmatchedActivities || 0).toLocaleString()}</p></div>
            <div><p className="text-tertiary">Shown below</p><p className="mt-1 font-mono font-semibold text-primary">{(matchAudit.data || []).length.toLocaleString()}</p></div>
          </div>
          {(matchAudit.data || []).length > 0 ? (
            <ul className="divide-y divide-border">
              {matchAudit.data.map((match) => (
                <li key={match.id} className="flex flex-wrap items-center justify-between gap-3 px-5 py-3 text-xs">
                  <div className="min-w-0">
                    <p className="text-primary">{formatDateDisplay(match.occurred_at)} · {match.exchange_account_name} · {match.record_type} · {match.base_amount} {match.base_asset}</p>
                    <p className="mt-0.5 text-caption text-tertiary">{match.match_method} · {match.confidence} · {match.category || 'venue-only movement'}</p>
                  </div>
                  <span className={`rounded px-2 py-1 text-[9px] font-bold uppercase tracking-wide ${match.verdict === 'confirmed' ? 'bg-gain/10 text-gain' : match.verdict === 'rejected' ? 'bg-loss/10 text-loss' : 'bg-surface-3 text-tertiary'}`}>{match.verdict || 'unreviewed'}</span>
                </li>
              ))}
            </ul>
          ) : <p className="px-5 py-4 text-xs text-secondary">No derived pairings yet. The unmatched counts above are the current gaps.</p>}
        </div>
      )}

      <form onSubmit={handleAddAccount} className="card mb-4 p-4">
        <div className="flex flex-col gap-3 md:flex-row md:items-end">
          <label className="min-w-0 flex-1 text-caption text-tertiary">
            Account name
            <input
              type="text"
              value={nameInput}
              onChange={(event) => setNameInput(event.target.value)}
              placeholder="Kraken Spot"
              maxLength={120}
              className="mt-1 block h-10 w-full min-w-0 border border-input-border bg-surface-2 px-2 text-body-sm text-primary"
              disabled={adding}
            />
          </label>
          <label className="min-w-0 text-caption text-tertiary">
            Exchange
            <select
              value={venue}
              onChange={(event) => setVenue(event.target.value)}
              className="mt-1 block h-10 w-full min-w-0 border border-input-border bg-surface-2 px-2 text-body-sm text-primary"
              disabled={adding}
            >
              {EXCHANGE_VENUES.map((option) => (
                <option key={option.id} value={option.id}>{option.label}</option>
              ))}
            </select>
          </label>
          <button
            type="submit"
            disabled={adding}
            className="inline-flex h-10 items-center justify-center gap-2 border border-border bg-surface-3 px-4 text-button font-semibold text-secondary transition-colors hover:border-accent hover:text-accent disabled:opacity-40"
          >
            {adding ? <RefreshCw size={14} className="animate-spin" /> : <Plus size={14} />}
            Add Account
          </button>
        </div>
        {formError && <p className="mt-2 text-body-sm text-loss">{formError}</p>}
      </form>

      {loadFailed ? (
        // A failed request must not read as "you have no exchange accounts":
        // that invites adding a duplicate of one that already exists, and
        // hides every record already imported into it.
        <div className="card flex flex-wrap items-center justify-between gap-3 p-4 text-sm text-secondary">
          <span className="flex items-center gap-2 text-loss">
            <AlertTriangle size={14} />
            Couldn&apos;t load your exchange accounts.
          </span>
          <button
            type="button"
            onClick={onRetry}
            className="inline-flex h-8 items-center gap-1.5 rounded border border-border bg-surface-3 px-3 text-[9px] font-bold uppercase tracking-wide text-tertiary transition-all hover:border-accent hover:text-accent"
          >
            <RefreshCw size={10} /> Retry
          </button>
        </div>
      ) : accounts.length === 0 ? (
        <div className="card border-2 border-dashed border-border bg-transparent p-12 text-center">
          <ArrowLeftRight size={40} className="mx-auto mb-4 text-tertiary opacity-20" />
          <h3 className="mb-2 text-lg font-bold uppercase tracking-tight text-primary">No Exchange Accounts</h3>
          <p className="mx-auto mb-5 max-w-md text-sm leading-relaxed text-secondary">
            Add an account above — one per exchange, including ones you have closed — then upload its CSV
            export. A closed account&apos;s history is exactly the part no live connection can ever recover.
          </p>
        </div>
      ) : (
        <div className="space-y-4">
          {accounts.map((account) => {
            const result = importResults[account.id];
            const importing = importingId === account.id;
            const reviewQueue = reviewQueues[account.id];
            const fields = credentialFields[account.exchange];
            // No connector for this venue means no endpoint to call, so the
            // account is CSV-only and is not offered a form it cannot use.
            const canConnect = Boolean(fields);
            const connected = Boolean(account.credentials?.configured);
            const syncResult = syncResults[account.id];
            const syncJob = syncStatuses[account.id];
            const jobActive = Boolean(syncJob && ['queued', 'running', 'backoff'].includes(syncJob.status));
            const syncing = syncingIds.has(account.id) || jobActive;
            const receiptJob = syncResult?.job;
            const visibleJob = receiptJob && syncJob && receiptJob.id !== syncJob.id
              ? (new Date(receiptJob.requested_at || 0).getTime() >= new Date(syncJob.requested_at || 0).getTime()
                ? receiptJob : syncJob)
              : syncJob || receiptJob;
            const testing = testingId === account.id;
            return (
              <Motion.div layout key={account.id} className="card overflow-hidden border-border">
                <div className="p-5 md:p-6">
                  <div className="flex flex-col justify-between gap-6 md:flex-row md:items-center">
                    <div className="flex min-w-0 items-center gap-4">
                      <div className="flex h-12 w-12 flex-shrink-0 items-center justify-center rounded border border-border bg-surface-3 shadow-sm">
                        <ArrowLeftRight size={24} className="text-accent" />
                      </div>
                      <div className="min-w-0">
                        <h3 className="truncate text-base font-bold leading-tight text-primary">{account.name}</h3>
                        <div className="mt-1 flex flex-wrap items-center gap-4">
                          <span className="rounded-full bg-surface-3 px-2 py-0.5 text-[9px] font-bold uppercase tracking-wide text-tertiary">
                            {EXCHANGE_VENUE_LABELS[account.exchange] || account.exchange}
                          </span>
                          <span className="font-mono text-[10px] font-bold text-secondary">
                            {(account.record_count ?? 0).toLocaleString()} records
                          </span>
                          {account.needs_review_count > 0 && (
                            <span className="text-[10px] font-bold uppercase tracking-wide text-loss">
                              {account.needs_review_count} need review
                            </span>
                          )}
                          <span className="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wide text-tertiary">
                            <Clock size={12} />
                            {account.last_import_at ? formatRelativeTime(account.last_import_at) : 'Never imported'}
                          </span>
                          {connected && (
                            // Masked, always. The stored key never leaves the
                            // server, so the last four characters are the
                            // most the browser can ever be told.
                            <span className="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wide text-gain">
                              <ShieldCheck size={12} />
                              Key {account.credentials.key_masked}
                            </span>
                          )}
                          {connected && account.last_sync_at && (
                            <span className="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wide text-tertiary">
                              <RefreshCw size={12} />
                              Synced {formatRelativeTime(account.last_sync_at)}
                            </span>
                          )}
                          {jobActive && (
                            <span className="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wide text-accent">
                              <RefreshCw size={12} className="animate-spin" />
                              {syncJob.status === 'backoff' ? 'Rate-limit pause' : 'Sync in progress'}
                            </span>
                          )}
                        </div>
                      </div>
                    </div>

                    <div className="flex flex-wrap items-center gap-2">
                      {connected && (
                        <>
                          <button
                            type="button"
                            onClick={() => handleSync(account)}
                            disabled={syncing}
                            aria-label={`Sync ${account.name} now`}
                            className="inline-flex items-center justify-center gap-2 rounded border border-border bg-surface-3 px-4 py-2.5 text-xs font-bold uppercase tracking-wider text-secondary transition-all hover:border-accent hover:text-accent disabled:opacity-40"
                          >
                            <RefreshCw size={14} className={syncing ? 'animate-spin' : ''} />
                            {syncing ? 'Syncing…' : 'Sync Now'}
                          </button>
                          <button
                            type="button"
                            onClick={() => handleTestConnection(account)}
                            disabled={testing}
                            aria-label={`Test connection for ${account.name}`}
                            className="inline-flex items-center justify-center gap-2 rounded border border-border bg-surface-3 px-3 py-2.5 text-xs font-bold uppercase tracking-wider text-tertiary transition-all hover:border-accent hover:text-accent disabled:opacity-40"
                          >
                            <ShieldCheck size={14} />
                            {testing ? 'Testing…' : 'Test'}
                          </button>
                        </>
                      )}
                      {canConnect && !connected && (
                        <button
                          type="button"
                          onClick={() => openConnectForm(account)}
                          aria-label={`Connect ${account.name} with an API key`}
                          className="inline-flex items-center justify-center gap-2 rounded border border-border bg-surface-3 px-4 py-2.5 text-xs font-bold uppercase tracking-wider text-secondary transition-all hover:border-accent hover:text-accent"
                        >
                          <Link2 size={14} />
                          Connect API Key
                        </button>
                      )}
                      <label className={`flex cursor-pointer items-center justify-center gap-2 rounded border border-border bg-surface-3 px-4 py-2.5 text-xs font-bold uppercase tracking-wider text-secondary transition-all hover:border-accent hover:text-accent ${importing ? 'pointer-events-none opacity-50' : ''}`}>
                        <Upload size={14} className={importing ? 'animate-pulse' : ''} />
                        {importing ? 'Importing…' : 'Import CSV'}
                        <input
                          type="file"
                          accept=".csv,text/csv"
                          aria-label={`Import CSV for ${account.name}`}
                          className="hidden"
                          disabled={importing}
                          onChange={(event) => handleImport(account, event)}
                        />
                      </label>
                      {renamingId === account.id ? (
                        <form
                          onSubmit={(event) => { event.preventDefault(); handleRenameAccount(account); }}
                          className="flex items-center gap-2"
                        >
                          <input
                            type="text"
                            value={renameValue}
                            onChange={(event) => setRenameValue(event.target.value)}
                            maxLength={80}
                            autoFocus
                            aria-label={`New name for ${account.name}`}
                            className="h-10 w-44 rounded border border-input-border bg-surface-2 px-3 text-sm text-primary outline-none focus:ring-1 focus:ring-accent"
                          />
                          <button
                            type="submit"
                            className="rounded border border-border bg-surface-3 px-3 py-2.5 text-xs font-bold uppercase tracking-wider text-secondary transition-all hover:border-accent hover:text-accent"
                          >
                            Save
                          </button>
                          <button
                            type="button"
                            onClick={() => setRenamingId(null)}
                            className="rounded border border-transparent p-2.5 text-tertiary transition-all hover:text-primary"
                            title="Cancel rename"
                          >
                            <X size={18} />
                          </button>
                        </form>
                      ) : (
                        <button
                          onClick={() => { setRenamingId(account.id); setRenameValue(account.name); }}
                          className="rounded border border-transparent p-2.5 text-tertiary transition-all hover:bg-surface-3 hover:text-primary"
                          title="Rename exchange account"
                        >
                          <Pencil size={18} />
                        </button>
                      )}
                      {connected && (disconnectingId === account.id ? (
                        <>
                          <button
                            onClick={() => handleDisconnect(account)}
                            disabled={syncing}
                            className="rounded border border-loss/30 bg-loss/10 px-3 py-2.5 text-xs font-bold uppercase tracking-wider text-loss transition-all"
                          >
                            {/* Naming what survives is the point: the records
                                are exactly the part no live connection can
                                ever recover once the key is gone. */}
                            Remove key, keep records
                          </button>
                          <button
                            onClick={() => setDisconnectingId(null)}
                            className="rounded border border-border bg-surface-3 px-3 py-2.5 text-xs font-bold uppercase tracking-wider text-secondary transition-all"
                          >
                            Cancel
                          </button>
                        </>
                      ) : (
                        <button
                          onClick={() => setDisconnectingId(account.id)}
                          className="rounded border border-transparent p-2.5 text-tertiary transition-all hover:bg-surface-3 hover:text-primary"
                          title="Disconnect API key"
                        >
                          <Unlink size={18} />
                        </button>
                      ))}
                      {deletingId === account.id ? (
                        <>
                          <button
                            onClick={() => handleDeleteAccount(account)}
                            className="rounded border border-loss/30 bg-loss/10 px-3 py-2.5 text-xs font-bold uppercase tracking-wider text-loss transition-all"
                          >
                            Delete {(account.record_count ?? 0).toLocaleString()} records
                          </button>
                          <button
                            onClick={() => setDeletingId(null)}
                            className="rounded border border-border bg-surface-3 px-3 py-2.5 text-xs font-bold uppercase tracking-wider text-secondary transition-all"
                          >
                            Cancel
                          </button>
                        </>
                      ) : (
                        <button
                          onClick={() => setDeletingId(account.id)}
                          className="rounded border border-transparent p-2.5 text-tertiary transition-all hover:bg-loss/10 hover:text-loss"
                          title="Delete exchange account"
                        >
                          <Trash2 size={18} />
                        </button>
                      )}
                    </div>
                  </div>

                  {connectingId === account.id && fields && (
                    <form
                      onSubmit={(event) => handleSaveCredentials(account, event)}
                      className="mt-5 rounded border border-border bg-surface-2 p-4"
                    >
                      {/* The permissions come from the server, alongside the
                          connector that depends on them, so this can never
                          tell the user to grant a set the code does not use. */}
                      <p className="mb-3 text-xs leading-relaxed text-secondary">
                        <span className="font-semibold text-primary">Create a read-only key.</span>{' '}
                        {fields.help} This app only ever calls read endpoints — it cannot place an order
                        or move funds, whatever the key allows.
                      </p>
                      <p className="mb-3 text-caption text-tertiary">
                        Permissions needed: {fields.permissions.join(', ')}.
                      </p>
                      <div className="flex flex-col gap-3 md:flex-row md:items-end">
                        <label className="min-w-0 flex-1 text-caption text-tertiary">
                          {fields.keyLabel}
                          <input
                            type="text"
                            autoComplete="off"
                            spellCheck={false}
                            value={credentialInputs.apiKey}
                            onChange={(event) => setCredentialInputs((prev) => ({ ...prev, apiKey: event.target.value }))}
                            aria-label={`${fields.keyLabel} for ${account.name}`}
                            className="mt-1 block h-10 w-full min-w-0 border border-input-border bg-surface-3 px-2 font-mono text-body-sm text-primary"
                          />
                        </label>
                        <label className="min-w-0 flex-1 text-caption text-tertiary">
                          {fields.secretLabel}
                          <textarea
                            rows={2}
                            autoComplete="off"
                            spellCheck={false}
                            value={credentialInputs.apiSecret}
                            onChange={(event) => setCredentialInputs((prev) => ({ ...prev, apiSecret: event.target.value }))}
                            aria-label={`${fields.secretLabel} for ${account.name}`}
                            className="mt-1 block w-full min-w-0 border border-input-border bg-surface-3 px-2 py-1.5 font-mono text-body-sm text-primary"
                          />
                        </label>
                        <div className="flex items-center gap-2">
                          <button
                            type="submit"
                            disabled={savingCredentialsId === account.id || !encryptionConfigured}
                            className="inline-flex h-10 items-center justify-center gap-2 border border-border bg-surface-3 px-4 text-button font-semibold text-secondary transition-colors hover:border-accent hover:text-accent disabled:opacity-40"
                          >
                            <Save size={14} />
                            Save Key
                          </button>
                          <button
                            type="button"
                            onClick={() => setConnectingId(null)}
                            className="rounded border border-transparent p-2.5 text-tertiary transition-all hover:text-primary"
                            title="Cancel"
                          >
                            <X size={18} />
                          </button>
                        </div>
                      </div>
                      {!encryptionConfigured && (
                        // Said before the paste, not after: without the
                        // encryption key the save can only ever be a 503, and
                        // learning that from a failed request is worse.
                        <p className="mt-3 flex items-start gap-2 text-body-sm text-loss">
                          <AlertTriangle size={14} className="mt-0.5 shrink-0" />
                          The server is missing SECRETS_ENCRYPTION_KEY, so API keys cannot be stored yet.
                          CSV import still works.
                        </p>
                      )}
                    </form>
                  )}

                  {visibleJob && (
                    <div className={`mt-5 rounded border p-4 text-xs leading-relaxed ${
                      visibleJob.status === 'failed'
                        ? 'border-loss/20 bg-loss/5 text-loss'
                        : visibleJob.status === 'completed'
                          ? 'border-gain/20 bg-gain/5 text-gain'
                          : 'border-accent/20 bg-accent/5 text-secondary'
                    }`}>
                      <div className="flex items-start gap-3">
                        <RefreshCw size={14} className={jobActive ? 'mt-0.5 flex-shrink-0 animate-spin' : 'mt-0.5 flex-shrink-0'} />
                        <div>
                          {visibleJob.status === 'completed' ? (
                            <>
                              <p>
                                Sync complete — read {Number(visibleJob.fetched || 0).toLocaleString()} ledger rows:{' '}
                                <span className="font-semibold">{Number(visibleJob.imported || 0).toLocaleString()} new</span>
                                {Number(visibleJob.duplicates || 0) > 0 && `, ${Number(visibleJob.duplicates).toLocaleString()} already held`}
                                {Number(visibleJob.flagged || 0) > 0 && `, ${Number(visibleJob.flagged).toLocaleString()} flagged for review`}.
                              </p>
                              {visibleJob.last_batch?.coverage_limitations?.length > 0 && (
                                <p className="mt-1 text-loss">
                                  Known coverage limits remain: {visibleJob.last_batch.coverage_limitations.join(' ')}
                                </p>
                              )}
                            </>
                          ) : visibleJob.status === 'failed' ? (
                            <p>Sync stopped: {visibleJob.last_error?.message || 'the exchange backfill failed'}.</p>
                          ) : visibleJob.status === 'backoff' ? (
                            <p>
                              Sync is in progress but the exchange is temporarily unavailable or rate-limited. We&apos;ll retry automatically
                              {visibleJob.next_run_at ? ` around ${formatDateDisplay(visibleJob.next_run_at)}` : ' soon'};
                              {' '}no duplicate rows will be created.
                            </p>
                          ) : (
                            <p>
                              Sync in progress — {Number(visibleJob.fetched || 0).toLocaleString()} rows read across{' '}
                              {Number(visibleJob.batches || 0).toLocaleString()} batch(es). This continues automatically in the background;
                              {' '}you can leave this page open or come back later.
                            </p>
                          )}
                        </div>
                      </div>
                    </div>
                  )}

                  {syncResult?.error && (
                    <div className="mt-5 rounded border border-loss/20 bg-loss/5 p-4 text-xs leading-relaxed text-loss">
                      <div className="flex items-start gap-3">
                        <AlertTriangle size={14} className="mt-0.5 flex-shrink-0" />
                        <p>{syncResult.error}</p>
                      </div>
                    </div>
                  )}

                  {syncResult?.tested && (
                    <div className="mt-5 rounded border border-gain/20 bg-gain/5 p-4 text-xs leading-relaxed text-gain">
                      <div className="flex items-start gap-3">
                        <ShieldCheck size={14} className="mt-0.5 flex-shrink-0" />
                        <p>{syncResult.tested}</p>
                      </div>
                    </div>
                  )}

                  {syncResult?.sync && (
                    <div className="mt-5 rounded border border-border bg-surface-2 p-4 text-xs leading-relaxed text-secondary">
                      <p>
                        Read {syncResult.sync.fetched.toLocaleString()} ledger rows:{' '}
                        <span className="font-semibold text-primary">{syncResult.sync.imported.toLocaleString()} new</span>
                        {syncResult.sync.upgraded > 0 && `, ${syncResult.sync.upgraded.toLocaleString()} completed from an earlier partial import`}
                        {syncResult.sync.duplicates > 0 && `, ${syncResult.sync.duplicates.toLocaleString()} already held`}
                        {syncResult.sync.chain_details_filled > 0 && `, ${syncResult.sync.chain_details_filled.toLocaleString()} gained an on-chain address`}
                        {syncResult.sync.needs_review > 0 && (
                          <span className="text-loss">, {syncResult.sync.needs_review.toLocaleString()} flagged for review</span>
                        )}
                        .
                      </p>
                      {/* A truncated walk looks exactly like a complete one
                          from the outside. Saying so is what stops the user
                          reading a partial history as the whole of it. */}
                      {syncResult.sync.backfill_pending && (
                        <p className="mt-1 text-tertiary">
                          More history is still to come — the background worker will keep working backwards
                          automatically. No second click is needed.
                        </p>
                      )}
                      {syncResult.sync.status === 'balance_mismatch' && (
                        <p className="mt-1 flex items-start gap-2 text-loss">
                          <AlertTriangle size={14} className="mt-0.5 shrink-0" />
                          {syncResult.sync.balance_report.mismatch_count} asset(s) do not match the balance the
                          exchange reports, so some activity is missing or misread:{' '}
                          {syncResult.sync.balance_report.mismatches.map((m) => m.asset).join(', ')}.
                        </p>
                      )}
                      {syncResult.sync.coverage_limitations?.length > 0 && (
                        <p className="mt-1 text-loss">
                          Known coverage limits remain: {syncResult.sync.coverage_limitations.join(' ')}
                        </p>
                      )}
                    </div>
                  )}

                  {/* Persisted from the last run, so a mismatch found by the
                      nightly job is visible without pressing anything. */}
                  {!syncResult && account.last_sync_status === 'balance_mismatch' && (
                    <div className="mt-5 flex items-start gap-3 rounded border border-loss/20 bg-loss/5 p-4 text-xs leading-relaxed text-loss">
                      <AlertTriangle size={14} className="mt-0.5 flex-shrink-0" />
                      <p>
                        The last sync&apos;s derived balances disagree with the exchange for{' '}
                        {(account.balance_report?.mismatches || []).map((m) => m.asset).join(', ') || 'some assets'}.
                        Some activity is missing or was misread.
                      </p>
                    </div>
                  )}

                  {!syncResult && (account.last_sync_status === 'coverage_limited'
                    || account.balance_report?.balances_incomplete
                    || account.balance_report?.coverage_limitations?.length > 0) && (
                    <div className="mt-5 flex items-start gap-3 rounded border border-loss/20 bg-loss/5 p-4 text-xs leading-relaxed text-loss">
                      <AlertTriangle size={14} className="mt-0.5 flex-shrink-0" />
                      <p>
                        The exchange API has known history limits for this account. Review the imported records and
                        retain an export for any activity the API does not expose.
                        {account.balance_report?.coverage_limitations?.length > 0
                          ? ` ${account.balance_report.coverage_limitations.join(' ')}` : ''}
                      </p>
                    </div>
                  )}

                  {!syncResult && account.last_sync_status === 'error' && account.last_sync_error && (
                    <div className="mt-5 flex items-start gap-3 rounded border border-loss/20 bg-loss/5 p-4 text-xs leading-relaxed text-loss">
                      <AlertTriangle size={14} className="mt-0.5 flex-shrink-0" />
                      <p>Last sync failed: {account.last_sync_error}</p>
                    </div>
                  )}

                  {result?.error && (
                    <div className="mt-5 rounded border border-loss/20 bg-loss/5 p-4 text-xs leading-relaxed text-loss">
                      <div className="flex items-start gap-3">
                        <AlertTriangle size={14} className="mt-0.5 flex-shrink-0" />
                        <p>{result.fileName ? `${result.fileName}: ` : ''}{result.error}</p>
                      </div>
                    </div>
                  )}

                  {result && !result.error && (
                    <div className="mt-5 rounded border border-border bg-surface-2 p-4 text-xs leading-relaxed text-secondary">
                      <p>
                        Read {result.fileName} as a {IMPORT_FORMAT_LABELS[result.format] || result.format}:{' '}
                        <span className="font-semibold text-primary">{result.imported.toLocaleString()} new</span>
                        {/* A record an earlier, shorter export could only half
                            describe, completed by this file. Neither new nor
                            a duplicate, and worth saying out loud: it is the
                            only sign the second upload was worth making. */}
                        {result.upgraded > 0 && `, ${result.upgraded.toLocaleString()} completed from an earlier partial export`}
                        {result.duplicates > 0 && `, ${result.duplicates.toLocaleString()} already imported`}
                        {result.needs_review > 0 && (
                          <span className="text-loss">, {result.needs_review.toLocaleString()} flagged for review</span>
                        )}
                        .
                      </p>
                      {(result.skipped_header_rows > 0 || result.skipped_noise_rows > 0) && (
                        <p className="mt-1 text-tertiary">
                          Skipped {result.skipped_header_rows + result.skipped_noise_rows} repeated header or
                          preamble line(s) inside the file.
                        </p>
                      )}
                    </div>
                  )}
                </div>

                {/* The flagged rows themselves. Without somewhere to see and
                    clear them the count can only ever go up, and a badge that
                    cannot reach zero is one the user learns to ignore --
                    taking the rows it was pointing at with it. */}
                {account.needs_review_count > 0 && (
                  <>
                    <button
                      type="button"
                      aria-expanded={openReviewAccountId === account.id}
                      onClick={() => handleToggleReviewQueue(account)}
                      className="flex w-full items-center justify-between gap-2 border-t border-border px-5 py-3 text-caption text-tertiary transition-colors hover:text-primary md:px-6"
                    >
                      <span>Needs review ({account.needs_review_count.toLocaleString()})</span>
                      <ChevronDown
                        size={14}
                        className={openReviewAccountId === account.id ? 'rotate-180 transition-transform' : 'transition-transform'}
                      />
                    </button>

                    {openReviewAccountId === account.id && (
                      <div className="border-t border-border">
                        {reviewQueue?.loading ? (
                          <div className="p-4 text-body-sm text-secondary">Loading flagged records…</div>
                        ) : reviewQueue?.error ? (
                          <div className="flex items-center gap-2 p-4 text-body-sm text-loss">
                            <AlertTriangle size={14} /> {reviewQueue.error}
                          </div>
                        ) : (reviewQueue?.records?.length ?? 0) === 0 ? (
                          <div className="p-4 text-body-sm text-secondary">Nothing left to review here.</div>
                        ) : (
                          <ul className="divide-y divide-border">
                            {reviewQueue.records.map((record) => (
                              <li key={record.id} className="flex flex-wrap items-center justify-between gap-3 px-5 py-3 md:px-6">
                                <div className="min-w-0">
                                  <p className="text-body-sm text-primary">
                                    <span className="text-tertiary">{formatDateDisplay(record.occurred_at)}</span>
                                    {' · '}
                                    <span className="uppercase tracking-wide">{record.record_type}</span>
                                    {' · '}
                                    <span className="font-money">{exchangeRecordAmount(record)}</span>
                                    {record.base_asset ? ` ${record.base_asset}` : ''}
                                  </p>
                                  <p className="mt-0.5 text-caption text-tertiary">{exchangeReviewReason(record)}</p>
                                </div>
                                <button
                                  type="button"
                                  disabled={resolvingRecordId === record.id}
                                  onClick={() => handleResolveRecord(account, record)}
                                  aria-label={`Mark record ${record.id} reviewed`}
                                  className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded border border-border bg-surface-3 px-3 text-[9px] font-bold uppercase tracking-wide text-tertiary transition-all hover:border-accent hover:text-accent disabled:opacity-40"
                                >
                                  <Check size={10} /> Mark reviewed
                                </button>
                              </li>
                            ))}
                          </ul>
                        )}
                      </div>
                    )}
                  </>
                )}
              </Motion.div>
            );
          })}
        </div>
      )}
    </section>
  );
}

export default ExchangesPanel;

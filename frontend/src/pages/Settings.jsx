import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { usePlaidLink } from 'react-plaid-link';
import { motion as Motion, AnimatePresence } from 'framer-motion';
import { Link2, RefreshCw, Unlink, AlertTriangle, Building2, Plus, Clock, Trash2, ShieldCheck, ChevronRight, ChevronDown, X, Check, Save, Undo2, Eye, EyeOff, Download, Upload, Wallet, Landmark, TrendingUp, Briefcase, Receipt, Tag, Pencil, ArrowLeftRight } from 'lucide-react';
import { plaid as plaidAPI, eth as ethAPI, exchanges as exchangesAPI, accounts as accountsAPI, holdings as holdingsAPI, exportData, history as historyAPI, keys as keysAPI, admin as adminAPI } from '../utils/api';
import { getAccountDisplayName, hasAccountDisplayName } from '../utils/accountDisplay';
import useAppearancePreferences from '../hooks/useAppearancePreferences';
import { APPEARANCE_THEMES, APPEARANCE_FONT_SIZES, APPEARANCE_FONT_FAMILIES } from '../utils/appearancePreferences';
import HoldingForm from '../components/HoldingForm';
import FilterTabs from '../components/FilterTabs';
import LoadingState from '../components/LoadingState';
import useTransientMessage from '../hooks/useTransientMessage';
import { formatRelativeTime, formatCompactCurrency, formatDateDisplay, formatExactUnits } from '../utils/format';
import { explorerAddressUrl, explorerTxUrl } from '../utils/chains';
import {
  LABEL_VERDICT_KEEP,
  LABEL_VERDICT_OPTIONS,
  labelVerdictKind,
  labelVerdictNeedsName,
  spamReasonLabel,
} from '../utils/dataLabels';

const SETTINGS_TABS = [
  { id: 'appearance', label: 'Appearance' },
  { id: 'data-tools', label: 'Data Tools' },
  { id: 'institutions', label: 'Institutions' },
  { id: 'ethereum', label: 'Ethereum' },
  { id: 'exchanges', label: 'Exchanges' },
  { id: 'api-keys', label: 'API Keys' },
  { id: 'accounts', label: 'Accounts' },
];
// Rendered only for the admin (the overview endpoint 403s for everyone else).
const SERVER_TAB = { id: 'server', label: 'Server' };

// Mapping from job-status keys to their manual trigger route names.
const JOB_TRIGGER_NAMES = {
  'plaid-sync': 'plaid-sync',
  'expense-sync': 'expense-sync',
  'eth-sync': 'eth-sync',
  'exchange-sync': 'exchange-sync',
  'price-update': 'price-update',
  'benchmark-update': 'benchmark-update',
  'snapshot-creation': 'snapshot',
};

// Rows on the API Keys tab. Plaid/Etherscan pull the signed-in user's own
// financial data; the price keys are shared app-wide (prices are global).
const USER_KEY_ROWS = [
  { service: 'plaid_client_id', label: 'Plaid Client ID' },
  { service: 'plaid_secret', label: 'Plaid Secret' },
  { service: 'etherscan', label: 'Etherscan API Key' },
];
const APP_KEY_ROWS = [
  { service: 'cg_api_key', label: 'CoinGecko API Key' },
  { service: 'cmc_api_key', label: 'CoinMarketCap API Key' },
];

// 'db_unreadable' is a stored row whose ciphertext no longer decrypts (the
// server's encryption key changed). It must not read as a working key, and it
// must still offer Clear -- that row is otherwise unreachable from the UI.
const isStoredKey = (status) => status?.source === 'db' || status?.source === 'db_unreadable';
const keyStatusLabel = (status) => {
  if (status?.source === 'db') return status.masked;
  if (status?.source === 'db_unreadable') return `${status.masked} · unreadable`;
  if (status?.source === 'env') return 'Using server default';
  return 'Not set';
};

const ETH_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

// One page of the spam quarantine (#74). The section is the only place the
// "Not spam" button exists, so the list has to be walkable to the end rather
// than truncated at a round number: during a spam wave the transaction worth
// rescuing is exactly the one a cap would hide.
const SPAM_PAGE_SIZE = 50;
// GET /api/eth/activity clamps `limit` to 500, so a refetch cannot restore more
// than that in one request however many pages are open. Beyond it the appended
// pages are re-walked by offset instead; the clamp only bounds the single call.
const SPAM_MAX_LIMIT = 500;

// The venues the backend accepts. Coinbase covers both the retail export and a
// Coinbase Pro / Exchange statement -- the importer recognizes which is which
// from the file's own header, so the user never has to say.
const EXCHANGE_VENUES = [
  { id: 'coinbase', label: 'Coinbase' },
  { id: 'kraken', label: 'Kraken' },
  { id: 'other', label: 'Other' },
];
const EXCHANGE_VENUE_LABELS = Object.fromEntries(EXCHANGE_VENUES.map((v) => [v.id, v.label]));
const IMPORT_FORMAT_LABELS = {
  coinbase_retail: 'Coinbase transactions export',
  coinbase_pro: 'Coinbase Pro account statement',
  kraken: 'Kraken ledgers export',
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

const shortEthAddress = (address) => (address ? `${address.slice(0, 6)}…${address.slice(-4)}` : '');

const MANUAL_ENTRY_TYPES = {
  asset: {
    label: 'Asset',
    description: 'Investment, crypto, property, or other asset',
    accountTypes: new Set(['investment', 'crypto', 'property', 'other']),
  },
  cash: {
    label: 'Cash',
    description: 'Checking, savings, or other depository balance',
    accountTypes: new Set(['depository']),
  },
  liability: {
    label: 'Liability',
    description: 'Credit card or loan balance',
    accountTypes: new Set(['credit', 'loan']),
  },
  salary: {
    label: 'Salary Record',
    description: 'Compensation, equity, and role changes',
    path: '/salary-history',
    entryType: 'salary',
  },
};

const downloadPortfolioCsv = (rows) => {
  const escapeCsv = (value) => {
    const text = String(value ?? '');
    return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
  };
  const csv = [
    ['Date', 'Total Value'],
    ...rows.map((row) => [row.snapshot_date, row.total_value]),
  ].map((row) => row.map(escapeCsv).join(',')).join('\n');
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8;' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = `portfolio-history-${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
};

function PlaidLinkButton({ onSuccess, onError, disabled }) {
  const [linkToken, setLinkToken] = useState(null);
  const [loading, setLoading] = useState(false);

  const fetchLinkToken = async () => {
    setLoading(true);
    onError?.(null);
    try {
      const data = await plaidAPI.createLinkToken();
      setLinkToken(data.link_token);
    } catch (err) {
      setLinkToken(null);
      onError?.(err.response?.data?.error || 'Failed to create Plaid Link token');
    } finally {
      setLoading(false);
    }
  };

  const { open, ready } = usePlaidLink({
    token: linkToken,
    onSuccess: (publicToken, metadata) => {
      setLinkToken(null);
      onSuccess(publicToken, metadata);
    },
    onExit: () => {
      setLinkToken(null);
    },
  });

  useEffect(() => {
    if (linkToken && ready) {
      open();
    }
  }, [linkToken, ready, open]);

  return (
    <button
      onClick={fetchLinkToken}
      disabled={disabled || loading}
      className="flex items-center gap-2 px-6 py-4 bg-accent text-white hover:bg-accent-hover rounded text-sm font-bold transition-all disabled:opacity-50"
    >
      {loading ? (
        <RefreshCw size={18} className="animate-spin" />
      ) : (
        <Plus size={18} />
      )}
      Connect New Institution
    </button>
  );
}

function UpdateLinkButton({ itemId, onSuccess, onError }) {
  const [linkToken, setLinkToken] = useState(null);
  const [loading, setLoading] = useState(false);

  const fetchUpdateToken = async () => {
    setLoading(true);
    onError?.(null);
    try {
      const data = await plaidAPI.createUpdateLinkToken(itemId);
      setLinkToken(data.link_token);
    } catch (err) {
      setLinkToken(null);
      onError?.(err.response?.data?.error || 'Failed to create Plaid re-link token');
    } finally {
      setLoading(false);
    }
  };

  const { open, ready } = usePlaidLink({
    token: linkToken,
    onSuccess: () => {
      setLinkToken(null);
      onSuccess(itemId);
    },
    onExit: () => setLinkToken(null),
  });

  useEffect(() => {
    if (linkToken && ready) open();
  }, [linkToken, ready, open]);

  return (
    <button
      onClick={fetchUpdateToken}
      disabled={loading}
      className="flex items-center gap-1.5 px-4 py-2 rounded text-xs font-bold text-white bg-accent hover:bg-accent-hover transition-all shadow-sm"
    >
      {loading ? <RefreshCw size={14} className="animate-spin" /> : <Link2 size={14} />}
      Re-link
    </button>
  );
}

const buildInstitutionSummary = (items, consentItems) => {
  const consentRequired = items.filter((item) => consentItems.has(item.id));
  const errored = items.filter((item) => item.error_code && !consentItems.has(item.id));
  const neverSynced = items.filter((item) => !item.last_synced_at && !item.error_code && !consentItems.has(item.id));
  const attentionItems = [...consentRequired, ...errored];
  const latestSynced = items
    .filter((item) => item.last_synced_at)
    .sort((a, b) => new Date(b.last_synced_at) - new Date(a.last_synced_at))[0];

  return {
    attentionItems,
    attentionCount: attentionItems.length,
    consentRequired,
    errored,
    healthyCount: Math.max(items.length - attentionItems.length, 0),
    latestSynced,
    neverSynced,
  };
};

// Why an asset could not be compared this run, in the user's terms. Codes come
// from EthReconciliationService.SKIP_REASONS; an unrecognized one falls through
// to a generic line rather than rendering a raw enum.
const RECONCILIATION_SKIP_TEXT = {
  feed_gap: 'a data feed this chain could not serve',
  chain_unavailable: 'this chain is not readable with your Etherscan key',
  chain_error: 'this chain failed to sync',
  never_synced: 'this chain has not synced yet',
  lookup_budget: 'checked on a later sync',
  // Distinct from lookup_budget: without a key no later sync can check it.
  no_api_key: 'no Etherscan key is configured',
  live_fetch_failed: 'the balance lookup failed',
};

// The balance audit for one wallet: does the stored transfer ledger reproduce
// the balance the chain itself reports?
//
// Silence is the failure mode this exists to break, so the three outcomes look
// deliberately different: a clean audit says so in one muted line, an ETH delta
// is a loud alert (sync starts at block 0, so it can only mean a movement was
// never recorded), and a token delta is stated plainly with the offending
// contract named -- rebasing and fee-on-transfer tokens do this legitimately, so
// alarming about them would train the user to ignore the ETH case too.
function WalletReconciliation({ report, chainNames }) {
  if (!report) return null;
  const chainName = (chainId) => chainNames?.get(Number(chainId)) || `Chain ${chainId}`;
  const nativeDrift = report.issues.filter((row) => row.status === 'mismatch' && row.asset_type === 'native');
  const tokenDrift = report.issues.filter((row) => row.status === 'mismatch' && row.asset_type === 'token');
  const unchecked = report.issues.filter((row) => row.status === 'skipped' || row.status === 'unavailable');
  const clean = !nativeDrift.length && !tokenDrift.length;

  // Every digit, never six. A drift under 1e-6 rendered at the default
  // precision prints as '0' (or '-0'), so the row would claim the ledger is
  // "0 ETH off" and then print the derived and chain figures identically --
  // three numbers that all say nothing is wrong, on a row that exists only
  // because something is.
  const amount = (row) => formatExactUnits(row.delta_units, row.token_decimals ?? 18) ?? '?';
  const symbolOf = (row) => row.token_symbol || 'tokens';

  return (
    <div className="mt-5 space-y-3">
      {nativeDrift.length > 0 && (
        <div className="rounded border border-loss/20 bg-loss/5 p-4 text-xs leading-relaxed text-loss">
          <div className="flex items-start gap-3">
            <AlertTriangle size={14} className="mt-0.5 flex-shrink-0" />
            <div className="min-w-0">
              <p className="font-bold uppercase tracking-wide">Balance audit: ETH unaccounted for</p>
              <p className="mt-1">
                Transfer history is synced from the first block, so the ETH it adds up to should match the
                chain exactly. It does not, which means a movement is missing from the ledger.
              </p>
              <ul className="mt-2 space-y-1 font-mono text-[11px]">
                {nativeDrift.map((row) => (
                  <li key={`${row.chain_id}-${row.asset_key}`}>
                    {chainName(row.chain_id)}: ledger is {amount(row)} ETH off
                    {' '}(derived {formatExactUnits(row.derived_units, 18)}, chain {formatExactUnits(row.live_units, 18)})
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </div>
      )}

      {tokenDrift.length > 0 && (
        <div className="rounded border border-border bg-surface-3 p-4 text-xs leading-relaxed text-secondary">
          <p className="font-bold uppercase tracking-wide text-primary">Token balances that do not add up</p>
          <p className="mt-1">
            Rebasing and fee-on-transfer tokens change a balance without a transfer to record, so this is
            often harmless. If one of these is spam, ignore it below and it drops out of the audit.
          </p>
          <ul className="mt-2 space-y-1">
            {tokenDrift.map((row) => (
              <li key={`${row.chain_id}-${row.asset_key}`} className="font-mono text-[11px]">
                <span className="text-primary">{symbolOf(row)}</span>{' '}
                {/* The contract, not just a number: "your DAI is off by 3" is
                    unactionable when four contracts call themselves DAI. */}
                <span title={row.asset_key}>{shortEthAddress(row.asset_key)}</span>{' '}
                on {chainName(row.chain_id)} is {amount(row)} off
              </li>
            ))}
          </ul>
        </div>
      )}

      {clean && report.assets_checked > 0 && (
        <p className="text-[10px] font-bold uppercase tracking-wide text-tertiary">
          Balance audit: ledger matches the chain across {report.matched + report.dust} of{' '}
          {report.assets_checked} assets &middot; {formatRelativeTime(report.checked_at)}
        </p>
      )}

      {unchecked.length > 0 && (
        // Stated rather than hidden. An audit that quietly omits what it could
        // not check reads as "everything is fine", which is the one thing it
        // must never say by accident.
        <p className="text-[10px] text-tertiary">
          Not checked this run:{' '}
          {unchecked.slice(0, 4).map((row) => (
            `${row.asset_type === 'native' ? 'ETH' : symbolOf(row)} on ${chainName(row.chain_id)} (${RECONCILIATION_SKIP_TEXT[row.skip_reason] || 'not compared'})`
          )).join('; ')}
          {unchecked.length > 4 ? ` and ${unchecked.length - 4} more` : ''}
          {report.truncated ? '. More assets are listed in the audit API.' : ''}
        </p>
      )}
    </div>
  );
}

const TRIAGE_ACTION_CLASS = 'inline-flex h-7 items-center gap-1.5 rounded border border-border bg-surface-3 px-2 text-[9px] font-bold uppercase tracking-wide text-tertiary transition-all disabled:opacity-40';

// One unreviewed counterparty. Defined at module scope, not inside Settings:
// a component redefined every render remounts, which would close the open
// naming panel on each keystroke.
// busy disables EVERY row while any verdict is in flight -- the handlers take
// one at a time, so leaving other rows clickable produced silent no-ops in the
// exact rapid-triage workflow this feature is built around. active spins only
// the row actually being worked on.
function CounterpartyRow({ counterparty, busy, active, onTriage, onTrackAsWallet, onIgnoreToken }) {
  const [panel, setPanel] = useState(null); // 'exchange' | 'mine' | null
  const [name, setName] = useState('');
  const short = shortEthAddress(counterparty.address);
  const openPanel = (next) => { setPanel((prev) => (prev === next ? null : next)); setName(''); };
  const symbol = counterparty.token_symbols?.[0];

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

        <div className="flex shrink-0 flex-wrap items-center gap-2">
          <button
            type="button"
            disabled={busy}
            aria-label={`It's an exchange — ${short}`}
            onClick={() => openPanel('exchange')}
            className={`${TRIAGE_ACTION_CLASS} hover:border-teal-500/30 hover:text-teal-400`}
          >
            <Tag size={10} /> It&apos;s an exchange
          </button>
          <button
            type="button"
            disabled={busy}
            aria-label={`It's mine — ${short}`}
            onClick={() => openPanel('mine')}
            className={`${TRIAGE_ACTION_CLASS} hover:border-accent hover:text-accent`}
          >
            <Wallet size={10} /> It&apos;s mine
          </button>
          <button
            type="button"
            disabled={busy}
            aria-label={`Outside party — ${short}`}
            onClick={() => onTriage(counterparty.address, 'external')}
            className={`${TRIAGE_ACTION_CLASS} hover:border-accent hover:text-accent`}
          >
            {active ? <RefreshCw size={10} className="animate-spin" /> : <Check size={10} />} Outside party
          </button>
          {counterparty.sole_token_contract && (
            // Airdrop spam arrives from many addresses but one contract, so
            // ignoring the token clears a whole class at once. Confirmed, not
            // one-click: sole_token_contract only says THIS counterparty deals
            // in one token, while the ignore list is user-global -- if the same
            // token was also acquired legitimately elsewhere, ignoring it
            // deletes that real holding and drops net worth with no undo.
            <button
              type="button"
              disabled={busy}
              aria-label={`Ignore ${symbol || 'token'} — ${short}`}
              onClick={() => openPanel('ignore')}
              className={`${TRIAGE_ACTION_CLASS} hover:border-loss/30 hover:text-loss`}
            >
              <EyeOff size={10} /> Ignore {symbol || 'token'}
            </button>
          )}
        </div>
      </div>

      {panel === 'exchange' && (
        <form
          className="mt-3 flex flex-wrap items-center gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (name.trim()) onTriage(counterparty.address, 'exchange', name.trim());
          }}
        >
          <input
            type="text"
            value={name}
            onChange={(event) => setName(event.target.value)}
            list="settings-eth-label-names"
            maxLength={64}
            placeholder="e.g. Coinbase"
            aria-label={`Exchange name for ${short}`}
            className="h-8 w-44 min-w-0 rounded border border-input-border bg-surface-2 px-2 text-body-sm text-primary outline-none focus:ring-1 focus:ring-accent"
          />
          <button
            type="submit"
            disabled={busy || !name.trim()}
            className="inline-flex h-8 items-center gap-1.5 rounded border border-teal-500/30 bg-teal-500/10 px-3 text-[9px] font-bold uppercase tracking-wide text-teal-400 disabled:opacity-40"
          >
            {active && <RefreshCw size={10} className="animate-spin" />} Save
          </button>
          <button type="button" onClick={() => setPanel(null)} className={TRIAGE_ACTION_CLASS}>Cancel</button>
        </form>
      )}

      {panel === 'mine' && (
        // "Mine" means two different things, and the split matters: tracking
        // keeps the value in net worth, the label only stops the transfer
        // counting as spending. This panel is also the confirmation step for
        // tracking, which is far heavier than the other verdicts (creates an
        // account, full Etherscan sync, can fail on rate limits).
        <div className="mt-3 space-y-2 border-t border-border pt-3">
          <input
            type="text"
            value={name}
            onChange={(event) => setName(event.target.value)}
            maxLength={64}
            placeholder="Optional name, e.g. Ledger cold storage"
            aria-label={`Name for ${short}`}
            className="h-8 w-full min-w-0 rounded border border-input-border bg-surface-2 px-2 text-body-sm text-primary outline-none focus:ring-1 focus:ring-accent sm:w-72"
          />
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              disabled={busy}
              aria-label={`Track as a wallet — ${short}`}
              onClick={() => onTrackAsWallet(counterparty.address, name.trim())}
              className="inline-flex h-8 items-center gap-1.5 rounded border border-accent/30 bg-accent/10 px-3 text-[9px] font-bold uppercase tracking-wide text-accent transition-all hover:bg-accent/20 disabled:opacity-40"
            >
              {active ? <RefreshCw size={10} className="animate-spin" /> : <Plus size={10} />} Track as a wallet
            </button>
            <button
              type="button"
              disabled={busy}
              aria-label={`Mine, don't track it — ${short}`}
              onClick={() => onTriage(counterparty.address, 'own', name.trim())}
              className={`${TRIAGE_ACTION_CLASS} h-8 px-3 hover:border-accent hover:text-accent`}
            >
              Mine, don&apos;t track it
            </button>
            <button type="button" onClick={() => setPanel(null)} className={`${TRIAGE_ACTION_CLASS} h-8 px-3`}>Cancel</button>
          </div>
          <p className="text-[10px] leading-relaxed text-tertiary">
            Tracking creates an account, pulls the full history, and counts the balance toward net worth.
            Labelling it only stops its transfers counting as spending — use that for addresses on another
            chain, ones already counted elsewhere, or ones you would rather not sync.
          </p>
        </div>
      )}

      {panel === 'ignore' && (
        <div className="mt-3 space-y-2 border-t border-border pt-3">
          <p className="text-[10px] leading-relaxed text-tertiary">
            Ignoring {symbol || 'this token'} removes it from holdings and activity in <strong>every</strong> wallet,
            not just this counterparty. If you also hold it legitimately, that position disappears too.
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              disabled={busy}
              aria-label={`Ignore ${symbol || 'token'} everywhere — ${short}`}
              onClick={() => onIgnoreToken(counterparty)}
              className="inline-flex h-8 items-center gap-1.5 rounded border border-loss/30 bg-loss-bg px-3 text-[9px] font-bold uppercase tracking-wide text-loss transition-all disabled:opacity-40"
            >
              {active ? <RefreshCw size={10} className="animate-spin" /> : <EyeOff size={10} />} Ignore everywhere
            </button>
            <button type="button" onClick={() => setPanel(null)} className={`${TRIAGE_ACTION_CLASS} h-8 px-3`}>Cancel</button>
          </div>
        </div>
      )}
    </div>
  );
}

function AppearanceOptions({ options, value, onChange, ariaLabel, previewFont = false }) {
  return (
    <div
      role="group"
      aria-label={ariaLabel}
      className="flex shrink-0 flex-wrap gap-px overflow-hidden rounded border border-border bg-border"
    >
      {options.map((option) => {
        const active = value === option.id;
        return (
          <button
            key={option.id}
            type="button"
            aria-pressed={active}
            onClick={() => onChange(option.id)}
            style={previewFont ? { fontFamily: option.stack } : undefined}
            className={`px-4 py-2 text-caption font-semibold transition-colors ${
              active ? 'bg-accent text-white' : 'bg-surface-2 text-tertiary hover:text-primary'
            }`}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

const Settings = ({ user }) => {
  const navigate = useNavigate();
  const location = useLocation();
  // Authorization comes from the identity /api/me already returned, not from
  // whether an admin-only request happened to succeed.
  const isAdmin = Boolean(user?.isAdmin);
  const {
    preferences: appearance,
    setTheme,
    setFontScale,
    setFontFamily,
  } = useAppearancePreferences();
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [successMessage, showSuccess] = useTransientMessage();
  const [syncingId, setSyncingId] = useState(null);
  const [disconnectingItem, setDisconnectingItem] = useState(null);
  const [removeDataOnDisconnect, setRemoveDataOnDisconnect] = useState(true);
  const [connecting, setConnecting] = useState(false);
  const [expandedItem, setExpandedItem] = useState(null);
  const [consentItems, setConsentItems] = useState(new Set());
  const [allAccounts, setAllAccounts] = useState([]);
  const [displayNameDrafts, setDisplayNameDrafts] = useState({});
  const [savingDisplayNameId, setSavingDisplayNameId] = useState(null);
  const [savingVisibilityId, setSavingVisibilityId] = useState(null);
  const [deletingAccount, setDeletingAccount] = useState(null);
  const [deletingAccountId, setDeletingAccountId] = useState(null);
  const [manualEntryType, setManualEntryType] = useState(null);
  const [exportStartDate, setExportStartDate] = useState('');
  const [exportEndDate, setExportEndDate] = useState('');
  const [exporting, setExporting] = useState(null);
  const [mobileEditingAccountId, setMobileEditingAccountId] = useState(null);
  const [ethWallets, setEthWallets] = useState([]);
  const [ignoredTokens, setIgnoredTokens] = useState([]);
  const [cryptoModalOpen, setCryptoModalOpen] = useState(false);
  const [walletAddress, setWalletAddress] = useState('');
  const [walletLabel, setWalletLabel] = useState('');
  const [walletFormError, setWalletFormError] = useState(null);
  const [addingWallet, setAddingWallet] = useState(false);
  const [ethSyncingId, setEthSyncingId] = useState(null);
  const [disconnectingWallet, setDisconnectingWallet] = useState(null);
  const [removeDataOnWalletDisconnect, setRemoveDataOnWalletDisconnect] = useState(true);
  const [ignoreContract, setIgnoreContract] = useState('');
  const [ignoreSymbol, setIgnoreSymbol] = useState('');
  const [updatingIgnoreList, setUpdatingIgnoreList] = useState(false);
  const [addressLabels, setAddressLabels] = useState([]);
  const [labelAddressInput, setLabelAddressInput] = useState('');
  const [labelNameInput, setLabelNameInput] = useState('');
  // null = follow the default for the typed address. Only a deliberate pick
  // sets it, so the default can keep tracking what the user types.
  const [labelVerdictChoice, setLabelVerdictChoice] = useState(null);
  const [updatingLabels, setUpdatingLabels] = useState(false);
  // null = not loaded or the fetch failed; [] = loaded and genuinely empty.
  // The distinction matters: never claim "all clear" on a failed request.
  const [counterpartyData, setCounterpartyData] = useState(null);
  const [triagingAddress, setTriagingAddress] = useState(null);
  const [showDustCounterparties, setShowDustCounterparties] = useState(false);
  // Quarantined spam (#74). null = not loaded or the fetch failed, same rule as
  // counterpartyData: "nothing was hidden" must never be the way a failed
  // request looks, because the whole promise of a quarantine is that it says
  // what it swallowed.
  const [spamActivity, setSpamActivity] = useState(null);
  const [showSpamActivity, setShowSpamActivity] = useState(false);
  const [unquarantiningTx, setUnquarantiningTx] = useState(null);
  const [loadingMoreSpam, setLoadingMoreSpam] = useState(false);
  // How many pages of the quarantine are currently on screen. A REF, not state:
  // fetchItems reads it, and putting it in that useCallback's deps would make
  // "show more" refetch the entire Settings page instead of one list.
  //
  // It also has to survive the refetch that follows a "Not spam" click. This is
  // the ONLY surface with that button, so a wave that buried a real transaction
  // at row 200 must not spring back to row 50 the moment the user rescues
  // something above it.
  const spamPagesRef = useRef(1);
  const [showExternalLabels, setShowExternalLabels] = useState(false);
  const [exchangeAccounts, setExchangeAccounts] = useState([]);
  // Loaded-and-empty and failed-to-load must not look alike: "No Exchange
  // Accounts" after a failed request invites the user to add one they already
  // have, and hides the imports they made.
  const [exchangeLoadFailed, setExchangeLoadFailed] = useState(false);
  // Per account: the flagged records, once the user opens the disclosure.
  const [reviewQueues, setReviewQueues] = useState({});
  const [openReviewAccountId, setOpenReviewAccountId] = useState(null);
  const [resolvingRecordId, setResolvingRecordId] = useState(null);
  const [exchangeNameInput, setExchangeNameInput] = useState('');
  const [exchangeVenue, setExchangeVenue] = useState('coinbase');
  const [addingExchange, setAddingExchange] = useState(false);
  const [exchangeFormError, setExchangeFormError] = useState(null);
  const [importingExchangeId, setImportingExchangeId] = useState(null);
  // Per account, so one failed upload does not blank another account's receipt.
  const [exchangeImportResults, setExchangeImportResults] = useState({});
  const [deletingExchangeId, setDeletingExchangeId] = useState(null);
  const [renamingExchangeId, setRenamingExchangeId] = useState(null);
  const [exchangeRenameValue, setExchangeRenameValue] = useState('');
  // What each venue's credential form should ask for, and which read-only
  // permissions to grant. Served by the API rather than hardcoded here so the
  // guidance cannot drift from the connector that depends on it.
  const [credentialFields, setCredentialFields] = useState({});
  const [exchangeEncryptionConfigured, setExchangeEncryptionConfigured] = useState(true);
  // Which account's connect form is open, plus its two (never pre-filled)
  // inputs. A stored key never comes back from the server, so there is nothing
  // to pre-fill with and an empty form is the honest one.
  const [connectingExchangeId, setConnectingExchangeId] = useState(null);
  const [credentialInputs, setCredentialInputs] = useState({ apiKey: '', apiSecret: '' });
  const [savingCredentialsId, setSavingCredentialsId] = useState(null);
  const [disconnectingExchangeId, setDisconnectingExchangeId] = useState(null);
  const [testingExchangeId, setTestingExchangeId] = useState(null);
  const [syncingExchangeId, setSyncingExchangeId] = useState(null);
  // Per account, so one account's failure does not blank another's receipt.
  const [exchangeSyncResults, setExchangeSyncResults] = useState({});
  const [keyStatuses, setKeyStatuses] = useState(null);
  const [keyInputs, setKeyInputs] = useState({});
  const [savingKeyService, setSavingKeyService] = useState(null);
  const [adminOverview, setAdminOverview] = useState(null);
  const [triggeringJob, setTriggeringJob] = useState(null);
  const [activeTab, setActiveTab] = useState(() =>
    SETTINGS_TABS.some((t) => t.id === location.state?.tab) ? location.state.tab : 'appearance'
  );

  const institutionSummary = useMemo(
    () => buildInstitutionSummary(items, consentItems),
    [items, consentItems]
  );
  const [materialCounterparties, dustCounterparties] = useMemo(() => {
    const rows = counterpartyData?.data || [];
    return [rows.filter((cp) => cp.material), rows.filter((cp) => !cp.material)];
  }, [counterpartyData]);

  // Material only, deliberately. A badge that cannot reach zero -- because a
  // single airdrop wave parked 40 dust counterparties behind it -- teaches the
  // user to ignore the badge, which also destroys its value for wallet sync
  // errors, the genuinely urgent case it already carries.
  //
  // A wallet whose ETH ledger does not reproduce the chain's balance counts
  // here too, but only ONCE even when it also carries a sync error -- the two
  // are the same wallet asking for the same look. Token drift deliberately does
  // not count: rebasing and fee-on-transfer contracts drift with no missed
  // transfer behind it, so badging them would pin the number above zero for
  // anyone who ever held one.
  const ethAttentionCount = useMemo(
    () => ethWallets.filter((wallet) => wallet.error_code || wallet.reconciliation?.needs_review).length
      + (counterpartyData?.summary?.count || 0),
    [ethWallets, counterpartyData]
  );
  // Summed from the accounts already loaded: flagged records deserve the same
  // first-class badge as the Ethereum triage queue, not a count discovered
  // only after navigating into the tab.
  const exchangeAttentionCount = useMemo(
    () => exchangeAccounts.reduce((sum, account) => sum + (account.needs_review_count || 0), 0),
    [exchangeAccounts]
  );

  // Typeahead keeps every exchange name, builtins included.
  const exchangeNameOptions = useMemo(
    () => [...new Set(addressLabels.filter((l) => !l.kind || l.kind === 'exchange').map((l) => l.name))],
    [addressLabels]
  );

  // The verdict the form will send: the user's pick, or -- until they make
  // one -- "keep", which the server resolves to the address's current verdict
  // (the user's row, else any builtin's, the hidden scraped pack included)
  // and to 'exchange' only for an address nobody has judged. Deriving the
  // default from what this list can see re-voted pack 'external' gateways to
  // 'exchange' on a plain rename, silently rewriting that spending as an
  // internal transfer.
  const labelVerdict = labelVerdictChoice || LABEL_VERDICT_KEEP;

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
  const manualEntryAccounts = useMemo(() => {
    if (!manualEntryType) return [];
    const allowedTypes = MANUAL_ENTRY_TYPES[manualEntryType].accountTypes;
    if (!allowedTypes) return [];
    return allAccounts.filter((account) => !account.is_hidden && allowedTypes.has(account.type));
  }, [allAccounts, manualEntryType]);

  const fetchItems = useCallback(async () => {
    try {
      // Ethereum data is fetched alongside but must not fail the whole page:
      // a wallet-side error should degrade only the Ethereum tab.
      const [plaidData, accountsData, ethResult, ignoredResult, labelsResult, counterpartyResult, spamResult, exchangeResult, keysResult] = await Promise.all([
        plaidAPI.getItems(),
        accountsAPI.getAll({ includeHidden: true }),
        ethAPI.getWallets().catch(() => null),
        ethAPI.getIgnoredTokens().catch(() => null),
        ethAPI.getAddressLabels().catch(() => null),
        ethAPI.getUnreviewedCounterparties().catch(() => null),
        // Paged, not capped: the first page is all anyone usually needs, and
        // "Show more" walks the rest (see handleShowMoreSpam). summary.spam_count
        // is the honest total and the header renders it, not the array's length.
        ethAPI.getActivity({
          spam: 'only',
          limit: Math.min(SPAM_PAGE_SIZE * spamPagesRef.current, SPAM_MAX_LIMIT),
        }).catch(() => null),
        exchangesAPI.getAll().catch(() => null),
        keysAPI.getAll().catch(() => null),
      ]);
      const loadedItems = plaidData.items || [];
      setEthWallets(ethResult?.wallets || []);
      setExchangeAccounts(exchangeResult?.accounts || []);
      setExchangeLoadFailed(!exchangeResult);
      setCredentialFields(exchangeResult?.credential_fields || {});
      // Only treated as unavailable on a response that actually said so: a
      // failed request must not read as "the server cannot store keys".
      setExchangeEncryptionConfigured(exchangeResult ? exchangeResult.encryption_configured !== false : true);
      setIgnoredTokens(ignoredResult?.tokens || []);
      setAddressLabels(labelsResult?.labels || []);
      setCounterpartyData(counterpartyResult || null);
      setSpamActivity(spamResult || null);
      setKeyStatuses(keysResult || null);
      setItems(loadedItems);
      setConsentItems(new Set(
        loadedItems
          .filter(item => item.error_code === 'ADDITIONAL_CONSENT_REQUIRED')
          .map(item => item.id)
      ));
      const allAccounts = accountsData.accounts || [];
      setAllAccounts(allAccounts);
      setDisplayNameDrafts(
        Object.fromEntries(allAccounts.map((account) => [account.id, account.display_name || '']))
      );
      setError(null);
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to load connected accounts');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchItems(); }, [fetchItems]);

  // Loaded separately from the page data: the identity arrives after mount, so
  // folding this into fetchItems would refetch everything a second time when
  // isAdmin flips. Requested only for admins -- probing it and reading the 403
  // made every non-admin fire a request that could only fail.
  useEffect(() => {
    if (!isAdmin) {
      setAdminOverview(null);
      return undefined;
    }
    let cancelled = false;
    adminAPI.getOverview()
      .catch(() => null)
      .then((data) => { if (!cancelled) setAdminOverview(data || null); });
    return () => { cancelled = true; };
  }, [isAdmin]);

  const handlePlaidSuccess = async (publicToken, metadata) => {
    setConnecting(true);
    setError(null);
    try {
      await plaidAPI.exchangeToken(publicToken, metadata);
      showSuccess('Account connected successfully');
      await fetchItems();
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to connect account');
    } finally {
      setConnecting(false);
    }
  };

  const handleSync = async (id) => {
    setSyncingId(id);
    setError(null);
    try {
      const result = await plaidAPI.syncItem(id);
      if (result.sync?.consentRequired) {
        setConsentItems((prev) => new Set(prev).add(id));
        // Either investments or liabilities can raise this; the per-item banner
        // below carries the backend's product-specific wording.
        setError('This institution requires additional authorization. Click "Re-link" to authorize.');
      } else {
        setConsentItems((prev) => { const next = new Set(prev); next.delete(id); return next; });
        showSuccess('Account synced successfully');
      }
      await fetchItems();
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to sync account');
    } finally {
      setSyncingId(null);
    }
  };

  const handleRelink = async (itemId) => {
    setError(null);
    try {
      await plaidAPI.syncItem(itemId);
      setConsentItems((prev) => { const next = new Set(prev); next.delete(itemId); return next; });
      showSuccess('Account re-linked and synced successfully');
      await fetchItems();
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to sync after re-link');
    }
  };

  const handleDisconnectConfirm = async () => {
    const id = disconnectingItem.id;
    const removeData = removeDataOnDisconnect;
    setDisconnectingItem(null);
    try {
      await plaidAPI.removeItem(id, { removeData });
      showSuccess(removeData
        ? 'Account disconnected and data removed.'
        : 'Account disconnected. Holdings kept as manual entries.');
      await fetchItems();
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to disconnect account');
    }
  };

  const openCryptoModal = () => {
    setWalletAddress('');
    setWalletLabel('');
    setWalletFormError(null);
    setCryptoModalOpen(true);
  };

  const handleAddWallet = async (event) => {
    event.preventDefault();
    if (addingWallet) return;
    const address = walletAddress.trim();
    if (!ETH_ADDRESS_RE.test(address)) {
      setWalletFormError('Enter a valid Ethereum address (0x followed by 40 hex characters)');
      return;
    }
    setAddingWallet(true);
    setWalletFormError(null);
    try {
      await ethAPI.addWallet(address, walletLabel.trim() || undefined);
      // The first sync runs in the background; its result surfaces on the
      // wallet card (balance, last-synced, or an error badge).
      showSuccess('Wallet added. Syncing on-chain history in the background.');
      setCryptoModalOpen(false);
      setWalletAddress('');
      setWalletLabel('');
      await fetchItems();
    } catch (err) {
      setWalletFormError(err.response?.data?.error || 'Failed to add wallet');
      // A retried POST can land on DUPLICATE_WALLET after the first attempt
      // actually succeeded; refresh so the list reflects the existing wallet.
      if (err.response?.status === 409) await fetchItems();
    } finally {
      setAddingWallet(false);
    }
  };

  const handleEthSync = async (id) => {
    setEthSyncingId(id);
    setError(null);
    try {
      await ethAPI.syncWallet(id);
      showSuccess('Wallet synced successfully');
      await fetchItems();
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to sync wallet');
    } finally {
      setEthSyncingId(null);
    }
  };

  const handleWalletDisconnectConfirm = async () => {
    const id = disconnectingWallet.id;
    const removeData = removeDataOnWalletDisconnect;
    setDisconnectingWallet(null);
    try {
      await ethAPI.removeWallet(id, { removeData });
      showSuccess(removeData
        ? 'Wallet disconnected and data removed.'
        : 'Wallet disconnected. The account and its holdings were kept.');
      await fetchItems();
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to disconnect wallet');
    }
  };

  const handleAddExchangeAccount = async (event) => {
    event.preventDefault();
    if (addingExchange) return;
    const name = exchangeNameInput.trim();
    if (!name) {
      setExchangeFormError('Enter a name for this exchange account');
      return;
    }
    setAddingExchange(true);
    setExchangeFormError(null);
    try {
      await exchangesAPI.create(name, exchangeVenue);
      showSuccess('Exchange account added');
      setExchangeNameInput('');
      await fetchItems();
    } catch (err) {
      setExchangeFormError(err.response?.data?.error || 'Failed to add exchange account');
    } finally {
      setAddingExchange(false);
    }
  };

  const handleExchangeImport = async (account, event) => {
    const file = event.target.files?.[0];
    // Cleared immediately so picking the same file again re-fires onChange --
    // otherwise a failed upload cannot be retried without choosing another file.
    event.target.value = '';
    if (!file) return;

    setImportingExchangeId(account.id);
    setExchangeImportResults((prev) => ({ ...prev, [account.id]: null }));
    try {
      const text = await file.text();
      const result = await exchangesAPI.importCsv(account.id, text);
      setExchangeImportResults((prev) => ({ ...prev, [account.id]: { ...result, fileName: file.name } }));
      await fetchItems();
    } catch (err) {
      setExchangeImportResults((prev) => ({
        ...prev,
        // The server's message names the format problem; it is the only thing
        // that tells the user which export to reach for instead.
        [account.id]: { error: err.response?.data?.error || 'Failed to import this file', fileName: file.name },
      }));
    } finally {
      setImportingExchangeId(null);
    }
  };

  const handleDeleteExchangeAccount = async (account) => {
    setDeletingExchangeId(null);
    try {
      await exchangesAPI.remove(account.id);
      showSuccess('Exchange account deleted');
      await fetchItems();
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to delete exchange account');
    }
  };

  const handleRenameExchangeAccount = async (account) => {
    const name = exchangeRenameValue.trim();
    if (!name || name === account.name) {
      setRenamingExchangeId(null);
      return;
    }
    try {
      await exchangesAPI.update(account.id, { name });
      showSuccess('Exchange account renamed');
      setRenamingExchangeId(null);
      await fetchItems();
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to rename exchange account');
    }
  };

  const openConnectForm = (account) => {
    setConnectingExchangeId(account.id);
    // Always empty. The server never returns a stored key, so a pre-filled
    // field could only ever be a lie about what is saved.
    setCredentialInputs({ apiKey: '', apiSecret: '' });
    setExchangeSyncResults((prev) => ({ ...prev, [account.id]: null }));
  };

  const handleSaveCredentials = async (account, event) => {
    event.preventDefault();
    if (savingCredentialsId) return;
    const apiKey = credentialInputs.apiKey.trim();
    const apiSecret = credentialInputs.apiSecret.trim();
    const fields = credentialFields[account.exchange] || {};
    if (!apiKey || !apiSecret) {
      setExchangeSyncResults((prev) => ({
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
      setConnectingExchangeId(null);
      showSuccess('API key saved');
      await fetchItems();
    } catch (err) {
      setExchangeSyncResults((prev) => ({
        ...prev,
        [account.id]: { error: err.response?.data?.error || 'Failed to save the API key' },
      }));
    } finally {
      setSavingCredentialsId(null);
    }
  };

  const handleDisconnectExchange = async (account) => {
    setDisconnectingExchangeId(null);
    try {
      await exchangesAPI.clearCredentials(account.id);
      showSuccess('API key removed; imported records were kept');
      await fetchItems();
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to remove the API key');
    }
  };

  const handleTestExchangeConnection = async (account) => {
    setTestingExchangeId(account.id);
    setExchangeSyncResults((prev) => ({ ...prev, [account.id]: null }));
    try {
      const result = await exchangesAPI.testConnection(account.id);
      setExchangeSyncResults((prev) => ({ ...prev, [account.id]: { tested: result.detail } }));
    } catch (err) {
      // The provider's own refusal names the permission that was forgotten, so
      // it reaches the screen verbatim rather than as "connection failed".
      setExchangeSyncResults((prev) => ({
        ...prev,
        [account.id]: { error: err.response?.data?.error || 'Could not reach the exchange' },
      }));
    } finally {
      setTestingExchangeId(null);
    }
  };

  const handleSyncExchange = async (account) => {
    setSyncingExchangeId(account.id);
    setExchangeSyncResults((prev) => ({ ...prev, [account.id]: null }));
    try {
      const result = await exchangesAPI.sync(account.id);
      setExchangeSyncResults((prev) => ({ ...prev, [account.id]: { sync: result } }));
      await fetchItems();
    } catch (err) {
      setExchangeSyncResults((prev) => ({
        ...prev,
        [account.id]: { error: err.response?.data?.error || 'Failed to sync from the exchange' },
      }));
    } finally {
      setSyncingExchangeId(null);
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
      await fetchItems();
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to mark this record reviewed');
    } finally {
      setResolvingRecordId(null);
    }
  };

  const handleIgnoreToken = async (event) => {
    event.preventDefault();
    const contract = ignoreContract.trim();
    if (!ETH_ADDRESS_RE.test(contract)) {
      setError('Enter the token contract address (0x followed by 40 hex characters)');
      return;
    }
    setUpdatingIgnoreList(true);
    setError(null);
    try {
      await ethAPI.ignoreToken(contract, ignoreSymbol.trim() || undefined);
      showSuccess('Token ignored');
      setIgnoreContract('');
      setIgnoreSymbol('');
      await fetchItems();
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to ignore token');
    } finally {
      setUpdatingIgnoreList(false);
    }
  };

  const handleUnignoreToken = async (contractAddress) => {
    setUpdatingIgnoreList(true);
    setError(null);
    try {
      await ethAPI.unignoreToken(contractAddress);
      showSuccess('Token no longer ignored');
      await fetchItems();
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to unignore token');
    } finally {
      setUpdatingIgnoreList(false);
    }
  };

  const handleLabelAddress = async (event) => {
    event.preventDefault();
    const address = labelAddressInput.trim();
    const name = labelNameInput.trim();
    if (!ETH_ADDRESS_RE.test(address)) {
      setError('Enter the counterparty address (0x followed by 40 hex characters)');
      return;
    }
    // An exchange name is the text the ledger shows AND the claim that turns
    // spending into an internal transfer, so it has to be typed. The other
    // verdicts never show their name, and the server falls back to a short
    // address.
    if (!name && labelVerdictNeedsName(labelVerdict)) {
      setError('Enter a name for the address (e.g. Coinbase)');
      return;
    }
    setUpdatingLabels(true);
    setError(null);
    try {
      await ethAPI.labelAddress(address, name || null, { kind: labelVerdictKind(labelVerdict) });
      showSuccess('Address labeled');
      setLabelAddressInput('');
      setLabelNameInput('');
      setLabelVerdictChoice(null);
      await fetchItems();
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to label address');
    } finally {
      setUpdatingLabels(false);
    }
  };

  const handleUnlabelAddress = async (address) => {
    setUpdatingLabels(true);
    setError(null);
    try {
      await ethAPI.unlabelAddress(address);
      showSuccess('Address label removed');
      await fetchItems();
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to remove address label');
    } finally {
      setUpdatingLabels(false);
    }
  };

  // Triage verdicts. All three are label writes and all three are reversible
  // with one click from the Labeled Addresses list below, so none of them
  // confirms -- matching handleUnlabelAddress. The full refetch is mandatory:
  // one action drops a queue row, adds a label row, and moves the tab badge.
  const handleTriageCounterparty = async (address, kind, name) => {
    if (triagingAddress) return;
    setTriagingAddress(address);
    setError(null);
    try {
      await ethAPI.labelAddress(address, name || null, { kind });
      showSuccess(
        kind === 'exchange' ? `Labeled ${shortEthAddress(address)} as ${name}`
          : kind === 'own' ? `${shortEthAddress(address)} marked as yours`
          : `${shortEthAddress(address)} marked as an outside party`
      );
      await fetchItems();
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to review counterparty');
    } finally {
      setTriagingAddress(null);
    }
  };

  // The heavy verdict: creates an account, pulls full history, and counts the
  // balance toward net worth. Reuses the normal add-wallet path, which already
  // reclassifies every existing transfer against the new own-address.
  const handleTrackCounterpartyAsWallet = async (address, label) => {
    if (triagingAddress) return;
    setTriagingAddress(address);
    setError(null);
    try {
      await ethAPI.addWallet(address, label || null);
      showSuccess(`Now tracking ${shortEthAddress(address)} as a wallet`);
      await fetchItems();
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to track that address as a wallet');
    } finally {
      setTriagingAddress(null);
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
      : label.kind === 'own' ? 'Yours'
      : label.kind === 'external' ? 'Outside party'
      : null;
    return (
      <div key={label.address} className="flex items-center justify-between gap-4 px-4 py-3">
        <div className="min-w-0">
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
    );
  };

  const handleIgnoreCounterpartyToken = async (counterparty) => {
    if (triagingAddress) return;
    setTriagingAddress(counterparty.address);
    setError(null);
    try {
      await ethAPI.ignoreToken(counterparty.sole_token_contract, counterparty.token_symbols?.[0] || undefined);
      showSuccess('Token ignored');
      await fetchItems();
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to ignore token');
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
    setError(null);
    try {
      await ethAPI.setActivitySpam(row.wallet_id, row.tx_hash, false, { chainId: row.chain_id });
      showSuccess('Restored to the ledger');
      await fetchItems();
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to restore that transaction');
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
    setError(null);
    try {
      const next = await ethAPI.getActivity({
        spam: 'only', limit: SPAM_PAGE_SIZE, offset: loaded.length,
      });
      const seen = new Set(loaded.map((row) => `${row.chain_id}:${row.tx_hash}`));
      const added = (next.data || []).filter((row) => !seen.has(`${row.chain_id}:${row.tx_hash}`));
      spamPagesRef.current += 1;
      setSpamActivity({ ...next, data: [...loaded, ...added] });
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to load more quarantined transactions');
    } finally {
      setLoadingMoreSpam(false);
    }
  };

  const refreshKeyStatuses = async () => {
    try {
      setKeyStatuses(await keysAPI.getAll());
    } catch {
      setKeyStatuses(null);
    }
  };

  const handleSaveKey = async (event, service) => {
    event.preventDefault();
    const value = (keyInputs[service] || '').trim();
    if (!value || savingKeyService) return;
    setSavingKeyService(service);
    setError(null);
    try {
      await keysAPI.set(service, value);
      showSuccess('API key saved');
      setKeyInputs((prev) => ({ ...prev, [service]: '' }));
      await refreshKeyStatuses();
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to save API key');
    } finally {
      setSavingKeyService(null);
    }
  };

  const handleClearKey = async (service) => {
    if (savingKeyService) return;
    setSavingKeyService(service);
    setError(null);
    try {
      await keysAPI.clear(service);
      showSuccess('API key removed');
      await refreshKeyStatuses();
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to remove API key');
    } finally {
      setSavingKeyService(null);
    }
  };

  const handleTriggerJob = async (statusKey) => {
    if (triggeringJob) return;
    setTriggeringJob(statusKey);
    setError(null);
    try {
      await adminAPI.triggerJob(JOB_TRIGGER_NAMES[statusKey] || statusKey);
      showSuccess('Job completed');
      // Keep the previous overview if the refresh fails: clearing it used to
      // unmount the tab the user is standing on and leave a blank page.
      const refreshed = await adminAPI.getOverview().catch(() => null);
      if (refreshed) setAdminOverview(refreshed);
    } catch (err) {
      setError(err.response?.data?.error || 'Job trigger failed');
    } finally {
      setTriggeringJob(null);
    }
  };

  const handleDisplayNameChange = (accountId, value) => {
    setDisplayNameDrafts((prev) => ({ ...prev, [accountId]: value }));
  };

  const handleSaveDisplayName = async (account) => {
    const draft = displayNameDrafts[account.id] ?? '';
    const normalizedName = draft.trim() || null;
    setSavingDisplayNameId(account.id);
    setError(null);
    try {
      await accountsAPI.updateDisplayName(account.id, normalizedName);
      showSuccess(normalizedName ? `"${normalizedName}" saved` : `"${account.name}" restored`);
      setMobileEditingAccountId(null);
      await fetchItems();
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to update display name');
    } finally {
      setSavingDisplayNameId(null);
    }
  };

  const handleClearDisplayName = async (account) => {
    setSavingDisplayNameId(account.id);
    setError(null);
    try {
      await accountsAPI.updateDisplayName(account.id, null);
      showSuccess(`"${account.name}" restored`);
      await fetchItems();
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to clear display name');
    } finally {
      setSavingDisplayNameId(null);
    }
  };

  const handleDeleteConfirm = async () => {
    const account = deletingAccount;
    setDeletingAccount(null);
    setDeletingAccountId(account.id);
    setError(null);
    try {
      await accountsAPI.delete(account.id);
      showSuccess(`"${getAccountDisplayName(account)}" deleted`);
      await fetchItems();
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to delete account');
    } finally {
      setDeletingAccountId(null);
    }
  };

  const handleVisibilityChange = async (account, isHidden) => {
    setSavingVisibilityId(account.id);
    setError(null);
    try {
      await accountsAPI.updateVisibility(account.id, isHidden);
      showSuccess(isHidden ? `"${getAccountDisplayName(account)}" hidden from UI` : `"${getAccountDisplayName(account)}" visible in UI`);
      await fetchItems();
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to update account visibility');
    } finally {
      setSavingVisibilityId(null);
    }
  };

  const handleManualEntrySave = async (data) => {
    try {
      await holdingsAPI.create(data);
      showSuccess(`${MANUAL_ENTRY_TYPES[manualEntryType]?.label || 'Manual entry'} added`);
      setManualEntryType(null);
      await fetchItems();
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to add manual entry');
      throw err;
    }
  };

  const handleManualEntryAction = (key) => {
    const entry = MANUAL_ENTRY_TYPES[key];
    if (entry.path) {
      navigate(entry.path, { state: { openAdd: entry.entryType } });
      return;
    }
    setManualEntryType(key);
  };

  const runExport = async (key, action, successText) => {
    setExporting(key);
    setError(null);
    try {
      await action();
      showSuccess(successText);
    } catch (err) {
      setError(err.response?.data?.error || err.message || 'Failed to export data');
    } finally {
      setExporting(null);
    }
  };

  const handlePortfolioExport = async () => {
    if (exportStartDate && exportEndDate && exportStartDate > exportEndDate) {
      setError('Portfolio export start date must be before the end date');
      return;
    }
    await runExport('portfolio', async () => {
      const response = await historyAPI.getPortfolio({
        startDate: exportStartDate || undefined,
        endDate: exportEndDate || undefined,
        limit: 10000,
        withCount: false,
      });
      const rows = response.data || [];
      if (rows.length === 0) throw new Error('No portfolio history exists for that date range');
      downloadPortfolioCsv(rows);
    }, 'Portfolio history exported');
  };

  if (loading) {
    return <LoadingState label="Initializing Settings" />;
  }

  return (
    <div className="mx-auto w-full max-w-[1180px] px-3 py-5 sm:px-4 md:py-8">
      {/* Hero Section */}
      <div className="mb-6 flex flex-col justify-between gap-4 md:mb-10 md:flex-row md:items-end md:gap-6">
        <div>
          <div className="flex items-center gap-2 mb-2">
            <ShieldCheck className="text-accent w-5 h-5" />
            <span className="text-[10px] font-bold uppercase tracking-wide text-secondary">Portfolio Settings</span>
          </div>
          <h1 className="text-3xl md:text-5xl font-bold text-primary tracking-tighter leading-none mb-2">
            Settings
          </h1>
          <p className="text-sm text-secondary">Manage data tools, institution connections, display names, and visibility</p>
        </div>

        <div className="flex flex-col gap-3 sm:flex-row sm:items-center [&>button]:w-full sm:[&>button]:w-auto">
          <PlaidLinkButton onSuccess={handlePlaidSuccess} onError={setError} disabled={connecting} />
          <button
            onClick={openCryptoModal}
            className="flex items-center justify-center gap-2 px-6 py-4 rounded text-sm font-bold text-crypto bg-crypto-bg border border-crypto-border hover:bg-crypto-bg-hover hover:text-crypto-hover transition-all"
          >
            <Wallet size={18} />
            Connect Crypto
          </button>
        </div>
      </div>

      {successMessage && (
        <Motion.div initial={{ opacity: 0, y: -10 }} animate={{ opacity: 1, y: 0 }} className="mb-6 p-4 bg-gain-bg border border-gain/20 text-gain rounded text-xs flex items-center gap-3">
          <Check size={16} />
          {successMessage}
        </Motion.div>
      )}
      {error && (
        <Motion.div initial={{ opacity: 0, y: -10 }} animate={{ opacity: 1, y: 0 }} className="mb-6 p-4 bg-loss-bg border border-loss/20 text-loss rounded text-xs flex items-center gap-3">
          <AlertTriangle size={16} />
          <span className="flex-1">{error}</span>
          <button onClick={() => setError(null)}><X size={14} /></button>
        </Motion.div>
      )}

      {connecting && (
        <div className="card mb-6 p-8 flex flex-col items-center justify-center gap-4 animate-fade-in border-accent/20 bg-accent/5">
          <RefreshCw size={32} className="animate-spin text-accent" />
          <p className="text-sm font-bold uppercase tracking-wide text-accent">Exchanging tokens and syncing data...</p>
        </div>
      )}

      <FilterTabs
        id="settings-section"
        label="Section"
        className="mb-6"
        value={activeTab}
        onChange={setActiveTab}
        options={(isAdmin ? [...SETTINGS_TABS, SERVER_TAB] : SETTINGS_TABS).map((t) => {
          const attentionCount = t.id === 'institutions'
            ? institutionSummary.attentionCount
            : t.id === 'ethereum'
              ? ethAttentionCount
              : t.id === 'exchanges'
                ? exchangeAttentionCount
                : 0;
          const attention = attentionCount > 0;
          return {
            value: t.id,
            label: t.label,
            selectLabel: attention ? `${t.label} (${attentionCount})` : t.label,
            badge: attention && (
              <span className="ml-1.5 inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-loss px-1 font-mono text-[10px] font-bold leading-none text-white">
                {attentionCount}
              </span>
            ),
          };
        })}
      />

      {activeTab === 'appearance' && (
      <section className="mb-8">
        <div className="mb-3 px-2">
          <h2 className="text-lg font-bold uppercase tracking-tight text-primary">Appearance</h2>
          <p className="mt-1 text-xs text-secondary">Theme, text size, and interface font apply across the entire app.</p>
        </div>

        <div className="card divide-y divide-border overflow-hidden">
          <div className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="min-w-0">
              <h3 className="text-body-sm font-semibold text-primary">Theme</h3>
              <p className="text-caption text-tertiary">Pick a color scheme or follow your system setting.</p>
            </div>
            <AppearanceOptions
              options={APPEARANCE_THEMES}
              value={appearance.theme}
              onChange={setTheme}
              ariaLabel="Theme"
            />
          </div>

          <div className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="min-w-0">
              <h3 className="text-body-sm font-semibold text-primary">Text Size</h3>
              <p className="text-caption text-tertiary">Scale the interface text. Default keeps the dense layout.</p>
            </div>
            <AppearanceOptions
              options={APPEARANCE_FONT_SIZES}
              value={appearance.fontScale}
              onChange={setFontScale}
              ariaLabel="Text size"
            />
          </div>

          <div className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="min-w-0">
              <h3 className="text-body-sm font-semibold text-primary">Interface Font</h3>
              <p className="text-caption text-tertiary">Financial figures always stay in the monospace font.</p>
            </div>
            <AppearanceOptions
              options={APPEARANCE_FONT_FAMILIES}
              value={appearance.fontFamily}
              onChange={setFontFamily}
              ariaLabel="Interface font"
              previewFont
            />
          </div>
        </div>
      </section>
      )}

      {activeTab === 'data-tools' && (
      <section className="mb-8">
        <div className="mb-3 px-2">
          <h2 className="text-lg font-bold uppercase tracking-tight text-primary">Data Tools</h2>
          <p className="mt-1 text-xs text-secondary">Add manual records and export data without cluttering the main pages.</p>
        </div>

        <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
          <div className="card overflow-hidden">
            <div className="border-b border-border bg-surface-2 px-4 py-3">
              <h3 className="text-body-sm font-bold uppercase tracking-wide text-primary">Manual Entries</h3>
              <p className="mt-1 text-caption text-tertiary">Choose the kind of balance or holding you want to add.</p>
            </div>
            <div className="divide-y divide-border">
              {Object.entries(MANUAL_ENTRY_TYPES).map(([key, entry]) => {
                const accountCount = entry.accountTypes
                  ? allAccounts.filter((account) => !account.is_hidden && entry.accountTypes.has(account.type)).length
                  : null;
                const Icon = key === 'asset'
                  ? TrendingUp
                  : key === 'cash'
                    ? Wallet
                    : key === 'liability'
                      ? Landmark
                      : key === 'salary'
                        ? Briefcase
                        : Receipt;
                return (
                  <button
                    key={key}
                    type="button"
                    onClick={() => handleManualEntryAction(key)}
                    disabled={accountCount === 0}
                    className="flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-surface-2 disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    <span className="flex h-9 w-9 shrink-0 items-center justify-center border border-accent/20 bg-accent-muted text-accent">
                      <Icon size={16} />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block text-body-sm font-semibold text-primary">Add Manual {entry.label}</span>
                      <span className="block truncate text-caption text-tertiary">{entry.description}</span>
                    </span>
                    {accountCount !== null && (
                      <span className="hidden shrink-0 text-caption text-tertiary sm:inline">{accountCount} account{accountCount === 1 ? '' : 's'}</span>
                    )}
                    <Plus size={15} className="shrink-0 text-accent" />
                  </button>
                );
              })}
            </div>
          </div>

          <div className="card overflow-hidden">
            <div className="border-b border-border bg-surface-2 px-4 py-3">
              <h3 className="text-body-sm font-bold uppercase tracking-wide text-primary">CSV Exports</h3>
              <p className="mt-1 text-caption text-tertiary">Download a local copy of holdings or historical values.</p>
            </div>
            <div className="grid grid-cols-1 gap-px bg-border sm:grid-cols-3">
              {[
                ['holdings', 'Holdings', () => exportData.downloadHoldings(), 'Holdings exported'],
                ['accounts', 'Account History', () => exportData.downloadHistory('accounts'), 'Account history exported'],
                ['tickers', 'Ticker History', () => exportData.downloadHistory('tickers'), 'Ticker history exported'],
              ].map(([key, label, action, successText]) => (
                <button
                  key={key}
                  type="button"
                  onClick={() => runExport(key, action, successText)}
                  disabled={Boolean(exporting)}
                  className="flex items-center justify-center gap-2 bg-surface px-3 py-3 text-caption font-semibold text-secondary transition-colors hover:bg-surface-2 hover:text-primary disabled:opacity-40"
                >
                  {exporting === key ? <RefreshCw size={14} className="animate-spin" /> : <Download size={14} />}
                  {label}
                </button>
              ))}
            </div>
            <div className="border-t border-border p-4">
              <div className="mb-3 flex items-start justify-between gap-3">
                <div>
                  <h4 className="text-body-sm font-semibold text-primary">Portfolio History</h4>
                  <p className="text-caption text-tertiary">Leave dates blank to export all history.</p>
                </div>
                <Download size={16} className="mt-0.5 shrink-0 text-accent" />
              </div>
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
                <label className="min-w-0 text-caption text-tertiary">
                  Start date
                  <input
                    type="date"
                    value={exportStartDate}
                    onChange={(event) => setExportStartDate(event.target.value)}
                    className="mt-1 block h-10 w-full min-w-0 border border-input-border bg-surface-2 px-2 text-body-sm text-primary"
                  />
                </label>
                <label className="min-w-0 text-caption text-tertiary">
                  End date
                  <input
                    type="date"
                    value={exportEndDate}
                    onChange={(event) => setExportEndDate(event.target.value)}
                    className="mt-1 block h-10 w-full min-w-0 border border-input-border bg-surface-2 px-2 text-body-sm text-primary"
                  />
                </label>
                <button
                  type="button"
                  onClick={handlePortfolioExport}
                  disabled={Boolean(exporting)}
                  className="inline-flex h-10 items-center justify-center gap-2 bg-accent px-4 text-button font-semibold text-white transition-colors hover:bg-accent-hover disabled:opacity-40"
                >
                  {exporting === 'portfolio' ? <RefreshCw size={14} className="animate-spin" /> : <Download size={14} />}
                  Export
                </button>
              </div>
            </div>
          </div>
        </div>
      </section>
      )}

      {activeTab === 'institutions' && (
      <>
      <section className="mb-8">
        <div className="mb-3 px-2">
          <h2 className="text-lg font-bold uppercase tracking-tight text-primary">Institution Health</h2>
          <p className="mt-1 text-xs text-secondary">Authorization status, sync activity, and connection errors.</p>
        </div>

        <div className="grid grid-cols-1 gap-px bg-border md:grid-cols-3">
          <div className="bg-surface p-4">
            <p className="text-[10px] font-bold uppercase tracking-wide text-tertiary">Needs Attention</p>
            <p className={`mt-2 font-mono text-2xl font-bold ${institutionSummary.attentionCount > 0 ? 'text-loss' : 'text-gain'}`}>
              {institutionSummary.attentionCount}
            </p>
          </div>
          <div className="bg-surface p-4">
            <p className="text-[10px] font-bold uppercase tracking-wide text-tertiary">Healthy Connections</p>
            <p className="mt-2 font-mono text-2xl font-bold text-primary">{institutionSummary.healthyCount}</p>
          </div>
          <div className="bg-surface p-4">
            <p className="text-[10px] font-bold uppercase tracking-wide text-tertiary">Latest Sync</p>
            <p className="mt-2 font-mono text-lg font-bold text-primary">
              {institutionSummary.latestSynced ? formatRelativeTime(institutionSummary.latestSynced.last_synced_at) : 'Never'}
            </p>
          </div>
        </div>

        {institutionSummary.attentionItems.length > 0 && (
          <div className="mt-3 space-y-2">
            {institutionSummary.attentionItems.map((item) => (
              <div key={item.id} className="flex flex-col gap-3 border border-loss/20 bg-loss/5 p-4 md:flex-row md:items-center md:justify-between">
                <div className="flex gap-3">
                  <AlertTriangle size={16} className="mt-0.5 shrink-0 text-loss" />
                  <div>
                    <h3 className="text-sm font-bold text-primary">{item.institution_name || 'Financial Institution'}</h3>
                    <p className="mt-1 text-xs leading-relaxed text-secondary">
                      {consentItems.has(item.id)
                        ? 'Additional authorization is required before holdings and investment data can sync.'
                        : (item.error_message || `Institution reported an error: ${item.error_code}`)}
                    </p>
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  {consentItems.has(item.id) && <UpdateLinkButton itemId={item.id} onSuccess={handleRelink} onError={setError} />}
                  <button
                    onClick={() => handleSync(item.id)}
                    disabled={syncingId === item.id}
                    className="inline-flex items-center justify-center gap-2 rounded border border-border bg-surface-3 px-4 py-2.5 text-xs font-bold uppercase tracking-wider text-secondary transition-all hover:border-accent hover:text-accent disabled:opacity-50"
                  >
                    <RefreshCw size={14} className={syncingId === item.id ? 'animate-spin' : ''} />
                    Sync
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}

        {institutionSummary.attentionItems.length === 0 && items.length > 0 && (
          <div className="mt-3 flex items-center gap-3 border border-gain/20 bg-gain-bg p-4 text-gain">
            <ShieldCheck size={16} />
            <p className="text-xs font-bold uppercase tracking-wide">All linked institutions are ready.</p>
          </div>
        )}

        {institutionSummary.neverSynced.length > 0 && (
          <p className="mt-3 px-2 text-xs text-tertiary">
            {institutionSummary.neverSynced.length} institution{institutionSummary.neverSynced.length === 1 ? '' : 's'} have not completed an initial sync yet.
          </p>
        )}
      </section>

      <section className="mb-8 space-y-4">
        <div className="px-2">
          <h2 className="text-lg font-bold uppercase tracking-tight text-primary">Institutions</h2>
          <p className="mt-1 text-xs text-secondary">Review linked Plaid connections, sync status, and disconnect actions.</p>
        </div>

        {items.length === 0 && !connecting ? (
          <div className="card p-12 text-center border-dashed border-2 border-border bg-transparent">
            <Building2 size={40} className="mx-auto text-tertiary mb-4 opacity-20" />
            <h3 className="text-lg font-bold text-primary mb-2 uppercase tracking-tight">No Institutions Linked</h3>
            <p className="text-sm text-secondary max-w-md mx-auto leading-relaxed">
              Link your brokerage or depository accounts to automatically pull balance and performance history.
            </p>
          </div>
        ) : (
          items.map((item) => (
            <Motion.div layout key={item.id} className="card overflow-hidden border-border">
              <div className="p-5 md:p-6">
                <div className="flex flex-col md:flex-row md:items-center justify-between gap-6">
                  <div className="flex items-center gap-4 min-w-0">
                    <div className="w-12 h-12 rounded bg-surface-3 border border-border flex items-center justify-center flex-shrink-0 shadow-sm">
                      <Building2 size={24} className="text-accent" />
                    </div>
                    <div className="min-w-0">
                      <h3 className="text-base font-bold text-primary truncate leading-tight">
                        {item.institution_name || 'Financial Institution'}
                      </h3>
                      <div className="flex items-center gap-4 mt-1">
                        <span className="text-[10px] font-bold uppercase tracking-wide text-tertiary">
                          {item.accounts?.length || 0} Account{(item.accounts?.length || 0) !== 1 ? 's' : ''}
                        </span>
                        <span className="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wide text-tertiary">
                          <Clock size={12} />
                          {formatRelativeTime(item.last_synced_at)}
                        </span>
                      </div>
                    </div>
                  </div>

                  <div className="flex items-center gap-2">
                    {consentItems.has(item.id) && (
                      <UpdateLinkButton itemId={item.id} onSuccess={handleRelink} onError={setError} />
                    )}
                    <button
                      onClick={() => handleSync(item.id)}
                      disabled={syncingId === item.id}
                      className="flex items-center justify-center gap-2 px-4 py-2.5 rounded text-xs font-bold uppercase tracking-wider text-secondary bg-surface-3 border border-border hover:border-accent hover:text-accent transition-all disabled:opacity-50"
                    >
                      <RefreshCw size={14} className={syncingId === item.id ? 'animate-spin' : ''} />
                      Sync
                    </button>
                    <button
                      onClick={() => { setRemoveDataOnDisconnect(true); setDisconnectingItem(item); }}
                      className="p-2.5 rounded text-tertiary hover:text-loss hover:bg-loss/10 border border-transparent transition-all"
                      title="Disconnect Institution"
                    >
                      <Unlink size={18} />
                    </button>
                  </div>
                </div>

                {(item.error_code || consentItems.has(item.id)) && (
                  <div className={`mt-5 p-4 rounded border text-xs leading-relaxed ${consentItems.has(item.id) ? 'bg-accent/5 border-accent/20 text-accent' : 'bg-loss/5 border-loss/20 text-loss'}`}>
                    <div className="flex items-start gap-3">
                      <AlertTriangle size={14} className="mt-0.5 flex-shrink-0" />
                      <p>
                        {/* The backend names the product that needs consent
                            (investments or liabilities); only fall back to
                            generic wording when it sent nothing. */}
                        {consentItems.has(item.id)
                          ? `${item.error_message || 'This institution requires additional authorization.'} Click "Re-link" to grant permission.`
                          : (item.error_message || `Institution reported an error: ${item.error_code}`)}
                      </p>
                    </div>
                  </div>
                )}

                {/* Sub-accounts Grid */}
                {item.accounts?.length > 0 && (
                  <div className="mt-6 pt-5 border-t border-border">
                    <button
                      onClick={() => setExpandedItem(expandedItem === item.id ? null : item.id)}
                      className="flex items-center gap-2 text-[10px] font-bold uppercase tracking-wide text-tertiary hover:text-primary transition-colors group"
                    >
                      <span>{expandedItem === item.id ? 'Collapse' : 'View'} Internal Accounts</span>
                      <ChevronRight size={12} className={`transition-transform duration-200 ${expandedItem === item.id ? 'rotate-90' : ''}`} />
                    </button>

                    <AnimatePresence>
                      {expandedItem === item.id && (
                        <Motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }} className="overflow-hidden">
                          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 mt-4">
                            {item.accounts.map((acct) => (
                              <div key={acct.id} className="flex items-center justify-between gap-4 px-4 py-3 rounded  border border-transparent hover:border-border transition-colors">
                                <div className="flex items-center gap-3 min-w-0">
                                  <Link2 size={12} className="text-accent opacity-60 flex-shrink-0" />
                                  <span className="text-xs font-bold text-primary truncate">{getAccountDisplayName(acct)}</span>
                                  {acct.is_hidden && <EyeOff size={12} className="text-loss flex-shrink-0" />}
                                </div>
                                <span className="text-[9px] font-bold text-tertiary uppercase tracking-wide px-2 py-0.5 rounded-full bg-surface-3">{acct.type}</span>
                              </div>
                            ))}
                          </div>
                        </Motion.div>
                      )}
                    </AnimatePresence>
                  </div>
                )}
              </div>
            </Motion.div>
          ))
        )}
      </section>
      </>
      )}

      {activeTab === 'ethereum' && (
      <>
      <section className="mb-8">
        <div className="mb-3 px-2">
          <h2 className="text-lg font-bold uppercase tracking-tight text-primary">Ethereum Wallets</h2>
          <p className="mt-1 text-xs text-secondary">Track any Ethereum address via Etherscan: ETH and token balances, transfers between your own wallets, external transfers, and gas fees.</p>
        </div>

        {ethWallets.length === 0 ? (
          <div className="card p-12 text-center border-dashed border-2 border-border bg-transparent">
            <Wallet size={40} className="mx-auto text-tertiary mb-4 opacity-20" />
            <h3 className="text-lg font-bold text-primary mb-2 uppercase tracking-tight">No Wallets Tracked</h3>
            <p className="text-sm text-secondary max-w-md mx-auto leading-relaxed mb-5">
              Use <span className="font-semibold text-primary">Connect Crypto</span> to add an Ethereum address and pull its balance and full transfer history. Transfers between your own tracked wallets are recognized automatically.
            </p>
            <button
              onClick={openCryptoModal}
              className="inline-flex items-center justify-center gap-2 px-5 py-2.5 rounded text-xs font-bold uppercase tracking-wider text-crypto bg-crypto-bg border border-crypto-border hover:bg-crypto-bg-hover hover:text-crypto-hover transition-all"
            >
              <Wallet size={14} />
              Connect Crypto
            </button>
          </div>
        ) : (
          <div className="space-y-4">
            {ethWallets.map((wallet) => (
              <Motion.div layout key={wallet.id} className="card overflow-hidden border-border">
                <div className="p-5 md:p-6">
                  <div className="flex flex-col md:flex-row md:items-center justify-between gap-6">
                    <div className="flex items-center gap-4 min-w-0">
                      <div className="w-12 h-12 rounded bg-surface-3 border border-border flex items-center justify-center flex-shrink-0 shadow-sm">
                        <Wallet size={24} className="text-accent" />
                      </div>
                      <div className="min-w-0">
                        <h3 className="text-base font-bold text-primary truncate leading-tight">
                          {wallet.label || (wallet.account ? getAccountDisplayName(wallet.account) : shortEthAddress(wallet.address))}
                        </h3>
                        <div className="flex flex-wrap items-center gap-4 mt-1">
                          <span className="font-mono text-[10px] text-tertiary" title={wallet.address}>
                            {shortEthAddress(wallet.address)}
                          </span>
                          {wallet.eth_quantity != null && (
                            <span className="font-mono text-[10px] font-bold text-secondary">
                              {parseFloat(wallet.eth_quantity).toLocaleString(undefined, { maximumFractionDigits: 4 })} ETH
                            </span>
                          )}
                          <span className="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wide text-tertiary">
                            <Clock size={12} />
                            {formatRelativeTime(wallet.last_synced_at)}
                          </span>
                        </div>
                      </div>
                    </div>

                    <div className="flex items-center gap-2">
                      {/* One address, several chains: the wallet has no single
                          chain to link against, and an address page exists on
                          every explorer anyway. */}
                      <a
                        href={explorerAddressUrl(wallet.address)}
                        target="_blank"
                        rel="noreferrer"
                        className="flex items-center justify-center gap-2 px-4 py-2.5 rounded text-xs font-bold uppercase tracking-wider text-secondary bg-surface-3 border border-border hover:border-accent hover:text-accent transition-all"
                      >
                        Etherscan
                      </a>
                      <button
                        onClick={() => handleEthSync(wallet.id)}
                        disabled={ethSyncingId === wallet.id}
                        className="flex items-center justify-center gap-2 px-4 py-2.5 rounded text-xs font-bold uppercase tracking-wider text-secondary bg-surface-3 border border-border hover:border-accent hover:text-accent transition-all disabled:opacity-50"
                      >
                        <RefreshCw size={14} className={ethSyncingId === wallet.id ? 'animate-spin' : ''} />
                        Sync
                      </button>
                      <button
                        onClick={() => { setRemoveDataOnWalletDisconnect(true); setDisconnectingWallet(wallet); }}
                        className="p-2.5 rounded text-tertiary hover:text-loss hover:bg-loss/10 border border-transparent transition-all"
                        title="Disconnect Wallet"
                      >
                        <Unlink size={18} />
                      </button>
                    </div>
                  </div>

                  {/* Per-chain sync state. The wallet badge above deliberately
                      carries only transient failures, so a chain (or a feed on
                      one) that this Etherscan key simply cannot serve would be
                      invisible without this -- and an unfetched feed means the
                      figures derived from it are incomplete, not just stale.

                      Shown for a multi-chain wallet, and ALWAYS when any chain
                      row carries a gap: a mainnet-only wallet (ETH_CHAINS=1)
                      whose one chain is degraded still has to say so, and
                      gating purely on chain count hid exactly that case. */}
                  {(wallet.chains?.length > 1
                    || wallet.chains?.some((chain) => chain.error_code || chain.unsupported_feeds?.length > 0)) && (
                    <div className="mt-4 flex flex-wrap items-center gap-2">
                      {wallet.chains.map((chain) => (
                        <span
                          key={chain.chain_id}
                          title={chain.error_message
                            || (chain.enabled ? `Last synced ${formatRelativeTime(chain.last_synced_at)}` : 'Chain turned off; stored history kept')}
                          className={`inline-flex items-center gap-1.5 px-2 py-1 rounded border text-[10px] font-bold uppercase tracking-wide ${
                            !chain.enabled ? 'bg-surface-3 border-border text-tertiary'
                              : chain.error_code ? 'bg-loss/5 border-loss/20 text-loss'
                              : 'bg-surface-3 border-border text-secondary'
                          }`}
                        >
                          {chain.enabled && chain.error_code && <AlertTriangle size={10} />}
                          {chain.name}
                          {!chain.enabled && <span className="font-normal normal-case">off</span>}
                          {chain.unsupported_feeds?.length > 0 && (
                            <span className="font-normal normal-case">
                              no {chain.unsupported_feeds.join(', ')}
                            </span>
                          )}
                        </span>
                      ))}
                    </div>
                  )}

                  {wallet.error_code && (
                    <div className="mt-5 p-4 rounded border text-xs leading-relaxed bg-loss/5 border-loss/20 text-loss">
                      <div className="flex items-start gap-3">
                        <AlertTriangle size={14} className="mt-0.5 flex-shrink-0" />
                        <p>{wallet.error_message || `Wallet sync reported an error: ${wallet.error_code}`}</p>
                      </div>
                    </div>
                  )}

                  {/* The audit rides along on the wallets response, so this
                      needs no second request and cannot disagree with the badge
                      above it. Chain names come from the wallet's own chain
                      rows, which the server already labelled from the registry. */}
                  <WalletReconciliation
                    report={wallet.reconciliation}
                    chainNames={new Map((wallet.chains || []).map((chain) => [Number(chain.chain_id), chain.name]))}
                  />
                </div>
              </Motion.div>
            ))}
          </div>
        )}
      </section>

      {ethWallets.length > 0 && (
        <section className="mb-8" aria-labelledby="eth-review-heading">
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

          <datalist id="settings-eth-label-names">
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
                  onClick={() => fetchItems()}
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
                    onTriage={handleTriageCounterparty}
                    onTrackAsWallet={handleTrackCounterpartyAsWallet}
                    onIgnoreToken={handleIgnoreCounterpartyToken}
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
                  aria-expanded={showDustCounterparties}
                  onClick={() => setShowDustCounterparties((open) => !open)}
                  className="flex w-full items-center justify-between gap-2 border-t border-border px-4 py-3 text-caption text-tertiary transition-colors hover:text-primary"
                >
                  {/* The server's count, not the page's: the response is capped,
                      so the rendered array can be smaller than the real total. */}
                  <span>{counterpartyData?.summary?.dust_count ?? dustCounterparties.length} low-value counterparties</span>
                  <ChevronDown size={14} className={showDustCounterparties ? 'rotate-180 transition-transform' : 'transition-transform'} />
                </button>
                {showDustCounterparties && (
                  <div className="divide-y divide-border">
                    {dustCounterparties.map((counterparty) => (
                      <CounterpartyRow
                        key={counterparty.address}
                        counterparty={counterparty}
                        busy={Boolean(triagingAddress)}
                        active={triagingAddress === counterparty.address}
                        onTriage={handleTriageCounterparty}
                        onTrackAsWallet={handleTrackCounterpartyAsWallet}
                        onIgnoreToken={handleIgnoreCounterpartyToken}
                      />
                    ))}
                  </div>
                )}
              </>
            )}
          </div>
        </section>
      )}

      {ethWallets.length > 0 && (
        <section className="mb-8" aria-labelledby="eth-spam-heading">
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
                  onClick={() => fetchItems()}
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
                  aria-expanded={showSpamActivity}
                  onClick={() => setShowSpamActivity((open) => !open)}
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
                  <ChevronDown size={14} className={showSpamActivity ? 'rotate-180 transition-transform' : 'transition-transform'} />
                </button>
                {showSpamActivity && (
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
      )}

      <section className="mb-8" aria-labelledby="eth-labeled-addresses-heading">
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
          </form>

          {addressLabels.length === 0 ? (
            <div className="p-6 text-center text-sm text-secondary">No addresses are labeled.</div>
          ) : (
            <div className="divide-y divide-border">
              {primaryLabels.map(renderAddressLabelRow)}
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

      <section className="mb-8">
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
      )}

      {activeTab === 'exchanges' && (
      <section className="mb-8" aria-labelledby="exchange-accounts-heading">
        <div className="mb-3 px-2">
          <h2 id="exchange-accounts-heading" className="text-lg font-bold uppercase tracking-tight text-primary">Exchange Accounts</h2>
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

        <form onSubmit={handleAddExchangeAccount} className="card mb-4 p-4">
          <div className="flex flex-col gap-3 md:flex-row md:items-end">
            <label className="min-w-0 flex-1 text-caption text-tertiary">
              Account name
              <input
                type="text"
                value={exchangeNameInput}
                onChange={(event) => setExchangeNameInput(event.target.value)}
                placeholder="Kraken Spot"
                maxLength={120}
                className="mt-1 block h-10 w-full min-w-0 border border-input-border bg-surface-2 px-2 text-body-sm text-primary"
                disabled={addingExchange}
              />
            </label>
            <label className="min-w-0 text-caption text-tertiary">
              Exchange
              <select
                value={exchangeVenue}
                onChange={(event) => setExchangeVenue(event.target.value)}
                className="mt-1 block h-10 w-full min-w-0 border border-input-border bg-surface-2 px-2 text-body-sm text-primary"
                disabled={addingExchange}
              >
                {EXCHANGE_VENUES.map((venue) => (
                  <option key={venue.id} value={venue.id}>{venue.label}</option>
                ))}
              </select>
            </label>
            <button
              type="submit"
              disabled={addingExchange}
              className="inline-flex h-10 items-center justify-center gap-2 border border-border bg-surface-3 px-4 text-button font-semibold text-secondary transition-colors hover:border-accent hover:text-accent disabled:opacity-40"
            >
              {addingExchange ? <RefreshCw size={14} className="animate-spin" /> : <Plus size={14} />}
              Add Account
            </button>
          </div>
          {exchangeFormError && <p className="mt-2 text-body-sm text-loss">{exchangeFormError}</p>}
        </form>

        {exchangeLoadFailed ? (
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
              onClick={() => fetchItems()}
              className="inline-flex h-8 items-center gap-1.5 rounded border border-border bg-surface-3 px-3 text-[9px] font-bold uppercase tracking-wide text-tertiary transition-all hover:border-accent hover:text-accent"
            >
              <RefreshCw size={10} /> Retry
            </button>
          </div>
        ) : exchangeAccounts.length === 0 ? (
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
            {exchangeAccounts.map((account) => {
              const result = exchangeImportResults[account.id];
              const importing = importingExchangeId === account.id;
              const reviewQueue = reviewQueues[account.id];
              const fields = credentialFields[account.exchange];
              // No connector for this venue means no endpoint to call, so the
              // account is CSV-only and is not offered a form it cannot use.
              const canConnect = Boolean(fields);
              const connected = Boolean(account.credentials?.configured);
              const syncResult = exchangeSyncResults[account.id];
              const syncing = syncingExchangeId === account.id;
              const testing = testingExchangeId === account.id;
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
                          </div>
                        </div>
                      </div>

                      <div className="flex flex-wrap items-center gap-2">
                        {connected && (
                          <>
                            <button
                              type="button"
                              onClick={() => handleSyncExchange(account)}
                              disabled={syncing}
                              aria-label={`Sync ${account.name} now`}
                              className="inline-flex items-center justify-center gap-2 rounded border border-border bg-surface-3 px-4 py-2.5 text-xs font-bold uppercase tracking-wider text-secondary transition-all hover:border-accent hover:text-accent disabled:opacity-40"
                            >
                              <RefreshCw size={14} className={syncing ? 'animate-spin' : ''} />
                              {syncing ? 'Syncing…' : 'Sync Now'}
                            </button>
                            <button
                              type="button"
                              onClick={() => handleTestExchangeConnection(account)}
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
                            onChange={(event) => handleExchangeImport(account, event)}
                          />
                        </label>
                        {renamingExchangeId === account.id ? (
                          <form
                            onSubmit={(event) => { event.preventDefault(); handleRenameExchangeAccount(account); }}
                            className="flex items-center gap-2"
                          >
                            <input
                              type="text"
                              value={exchangeRenameValue}
                              onChange={(event) => setExchangeRenameValue(event.target.value)}
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
                              onClick={() => setRenamingExchangeId(null)}
                              className="rounded border border-transparent p-2.5 text-tertiary transition-all hover:text-primary"
                              title="Cancel rename"
                            >
                              <X size={18} />
                            </button>
                          </form>
                        ) : (
                          <button
                            onClick={() => { setRenamingExchangeId(account.id); setExchangeRenameValue(account.name); }}
                            className="rounded border border-transparent p-2.5 text-tertiary transition-all hover:bg-surface-3 hover:text-primary"
                            title="Rename exchange account"
                          >
                            <Pencil size={18} />
                          </button>
                        )}
                        {connected && (disconnectingExchangeId === account.id ? (
                          <>
                            <button
                              onClick={() => handleDisconnectExchange(account)}
                              className="rounded border border-loss/30 bg-loss/10 px-3 py-2.5 text-xs font-bold uppercase tracking-wider text-loss transition-all"
                            >
                              {/* Naming what survives is the point: the records
                                  are exactly the part no live connection can
                                  ever recover once the key is gone. */}
                              Remove key, keep records
                            </button>
                            <button
                              onClick={() => setDisconnectingExchangeId(null)}
                              className="rounded border border-border bg-surface-3 px-3 py-2.5 text-xs font-bold uppercase tracking-wider text-secondary transition-all"
                            >
                              Cancel
                            </button>
                          </>
                        ) : (
                          <button
                            onClick={() => setDisconnectingExchangeId(account.id)}
                            className="rounded border border-transparent p-2.5 text-tertiary transition-all hover:bg-surface-3 hover:text-primary"
                            title="Disconnect API key"
                          >
                            <Unlink size={18} />
                          </button>
                        ))}
                        {deletingExchangeId === account.id ? (
                          <>
                            <button
                              onClick={() => handleDeleteExchangeAccount(account)}
                              className="rounded border border-loss/30 bg-loss/10 px-3 py-2.5 text-xs font-bold uppercase tracking-wider text-loss transition-all"
                            >
                              Delete {(account.record_count ?? 0).toLocaleString()} records
                            </button>
                            <button
                              onClick={() => setDeletingExchangeId(null)}
                              className="rounded border border-border bg-surface-3 px-3 py-2.5 text-xs font-bold uppercase tracking-wider text-secondary transition-all"
                            >
                              Cancel
                            </button>
                          </>
                        ) : (
                          <button
                            onClick={() => setDeletingExchangeId(account.id)}
                            className="rounded border border-transparent p-2.5 text-tertiary transition-all hover:bg-loss/10 hover:text-loss"
                            title="Delete exchange account"
                          >
                            <Trash2 size={18} />
                          </button>
                        )}
                      </div>
                    </div>

                    {connectingExchangeId === account.id && fields && (
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
                              disabled={savingCredentialsId === account.id || !exchangeEncryptionConfigured}
                              className="inline-flex h-10 items-center justify-center gap-2 border border-border bg-surface-3 px-4 text-button font-semibold text-secondary transition-colors hover:border-accent hover:text-accent disabled:opacity-40"
                            >
                              <Save size={14} />
                              Save Key
                            </button>
                            <button
                              type="button"
                              onClick={() => setConnectingExchangeId(null)}
                              className="rounded border border-transparent p-2.5 text-tertiary transition-all hover:text-primary"
                              title="Cancel"
                            >
                              <X size={18} />
                            </button>
                          </div>
                        </div>
                        {!exchangeEncryptionConfigured && (
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
                            More history is still to come — the nightly sync will keep working backwards, or
                            press Sync Now again.
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
      )}

      {activeTab === 'api-keys' && (
      <>
      {keyStatuses && !keyStatuses.encryptionConfigured && (
        <div className="mb-4 flex items-start gap-2 border border-loss/20 bg-loss/5 p-3 text-body-sm text-loss">
          <AlertTriangle size={16} className="mt-0.5 shrink-0" />
          <span>
            The server is missing SECRETS_ENCRYPTION_KEY, so keys cannot be stored here yet.
            Integrations keep using the server&apos;s environment variables.
          </span>
        </div>
      )}
      {!keyStatuses && (
        <div className="mb-4 border border-border bg-surface-2 p-3 text-body-sm text-secondary">
          Key status is unavailable right now. Try reloading the page.
        </div>
      )}

      <section className="mb-8">
        <div className="mb-3 px-2">
          <h2 className="text-lg font-bold uppercase tracking-tight text-primary">Your Keys</h2>
          <p className="mt-1 text-xs text-secondary">Credentials for pulling your own financial data. Stored encrypted; only the last four characters are ever shown. When unset, the server&apos;s environment value (if any) is used.</p>
        </div>
        <div className="card divide-y divide-border overflow-hidden">
          {USER_KEY_ROWS.map(({ service, label }) => {
            const status = keyStatuses?.userKeys?.[service];
            return (
              <form key={service} onSubmit={(event) => handleSaveKey(event, service)} className="grid grid-cols-1 gap-2 p-4 sm:grid-cols-[minmax(140px,0.8fr)_minmax(110px,0.5fr)_minmax(0,1.4fr)_auto] sm:items-center">
                <span className="text-body-sm font-semibold text-primary">{label}</span>
                <span className="font-mono text-caption text-tertiary">
                  {keyStatusLabel(status)}
                </span>
                <input
                  type="password"
                  value={keyInputs[service] || ''}
                  onChange={(event) => setKeyInputs((prev) => ({ ...prev, [service]: event.target.value }))}
                  placeholder={isStoredKey(status) ? 'Replace key…' : 'Paste key…'}
                  autoComplete="off"
                  className="h-10 w-full min-w-0 border border-input-border bg-surface-2 px-2 font-mono text-body-sm text-primary"
                  disabled={keyStatuses?.encryptionConfigured === false || savingKeyService !== null}
                />
                <div className="flex gap-2">
                  <button
                    type="submit"
                    disabled={keyStatuses?.encryptionConfigured === false || savingKeyService !== null || !(keyInputs[service] || '').trim()}
                    className="inline-flex h-10 items-center justify-center gap-2 border border-border bg-surface-3 px-4 text-button font-semibold text-secondary transition-colors hover:border-accent hover:text-accent disabled:opacity-40"
                  >
                    {savingKeyService === service ? <RefreshCw size={14} className="animate-spin" /> : <Save size={14} />}
                    Save
                  </button>
                  {isStoredKey(status) && (
                    <button
                      type="button"
                      onClick={() => handleClearKey(service)}
                      disabled={savingKeyService !== null}
                      className="inline-flex h-10 items-center justify-center gap-2 border border-border bg-surface-3 px-3 text-button font-semibold text-secondary transition-colors hover:border-loss/30 hover:text-loss disabled:opacity-40"
                    >
                      <Trash2 size={14} />
                      Clear
                    </button>
                  )}
                </div>
              </form>
            );
          })}
        </div>
      </section>

      </>
      )}

      {activeTab === 'server' && isAdmin && !adminOverview && (
        <section className="card p-4 text-body-sm text-secondary">
          Server details could not be loaded. Reload the page to try again.
        </section>
      )}

      {activeTab === 'server' && adminOverview && (
      <>
      <section className="mb-8">
        <div className="mb-3 px-2">
          <h2 className="text-lg font-bold uppercase tracking-tight text-primary">Market Data Keys</h2>
          <p className="mt-1 text-xs text-secondary">App-wide keys for the shared price pipeline (only you can see or change these). Both are optional: without them, price lookups fall back to keyless sources. A value stored here overrides the server environment variable.</p>
        </div>
        <div className="card divide-y divide-border overflow-hidden">
          {APP_KEY_ROWS.map(({ service, label }) => {
            const status = keyStatuses?.appSettings?.[service];
            return (
              <form key={service} onSubmit={(event) => handleSaveKey(event, service)} className="grid grid-cols-1 gap-2 p-4 sm:grid-cols-[minmax(140px,0.8fr)_minmax(110px,0.5fr)_minmax(0,1.4fr)_auto] sm:items-center">
                <span className="text-body-sm font-semibold text-primary">{label}</span>
                <span className="font-mono text-caption text-tertiary">
                  {keyStatusLabel(status)}
                </span>
                <input
                  type="password"
                  value={keyInputs[service] || ''}
                  onChange={(event) => setKeyInputs((prev) => ({ ...prev, [service]: event.target.value }))}
                  placeholder={isStoredKey(status) ? 'Replace key…' : 'Paste key…'}
                  autoComplete="off"
                  className="h-10 w-full min-w-0 border border-input-border bg-surface-2 px-2 font-mono text-body-sm text-primary"
                  disabled={keyStatuses?.encryptionConfigured === false || savingKeyService !== null}
                />
                <div className="flex gap-2">
                  <button
                    type="submit"
                    disabled={keyStatuses?.encryptionConfigured === false || savingKeyService !== null || !(keyInputs[service] || '').trim()}
                    className="inline-flex h-10 items-center justify-center gap-2 border border-border bg-surface-3 px-4 text-button font-semibold text-secondary transition-colors hover:border-accent hover:text-accent disabled:opacity-40"
                  >
                    {savingKeyService === service ? <RefreshCw size={14} className="animate-spin" /> : <Save size={14} />}
                    Save
                  </button>
                  {isStoredKey(status) && (
                    <button
                      type="button"
                      onClick={() => handleClearKey(service)}
                      disabled={savingKeyService !== null}
                      className="inline-flex h-10 items-center justify-center gap-2 border border-border bg-surface-3 px-3 text-button font-semibold text-secondary transition-colors hover:border-loss/30 hover:text-loss disabled:opacity-40"
                    >
                      <Trash2 size={14} />
                      Clear
                    </button>
                  )}
                </div>
              </form>
            );
          })}
        </div>
      </section>

      <section className="mb-8">
        <div className="mb-3 px-2">
          <h2 className="text-lg font-bold uppercase tracking-tight text-primary">Environment</h2>
          <p className="mt-1 text-xs text-secondary">Read-only view of the server configuration. Secrets show only their last four characters; changing any of these means updating the server environment (Azure app settings or backend/.env).</p>
        </div>
        <div className="card divide-y divide-border overflow-hidden">
          {adminOverview.env.map((entry) => (
            <div key={entry.name} className="flex items-center justify-between gap-4 px-4 py-3">
              <span className="font-mono text-body-sm text-primary">{entry.name}</span>
              <span className="min-w-0 truncate text-right font-mono text-caption text-tertiary">
                {entry.name === 'SECRETS_ENCRYPTION_KEY' && entry.set && !entry.valid
                  ? 'Set but invalid (must be 32 bytes of base64)'
                  : entry.masked ? entry.masked
                  : entry.host ? entry.host
                  : entry.value ? entry.value
                  : entry.set ? 'Set' : 'Not set'}
              </span>
            </div>
          ))}
        </div>
      </section>

      <section className="mb-8">
        <div className="mb-3 px-2">
          <h2 className="text-lg font-bold uppercase tracking-tight text-primary">Users</h2>
          <p className="mt-1 text-xs text-secondary">Everyone with access (view-only). New users are added by putting their email in ALLOWED_PRINCIPALS; their account is created on first sign-in.</p>
        </div>
        <div className="card divide-y divide-border overflow-hidden">
          {adminOverview.users.map((account) => (
            <div key={account.id} className="grid grid-cols-1 gap-2 px-4 py-3 sm:grid-cols-[minmax(0,1.2fr)_minmax(0,1.4fr)_minmax(0,1fr)] sm:items-center">
              <div className="flex min-w-0 items-center gap-2">
                <span className="truncate text-body-sm font-semibold text-primary">{account.display_name || account.username}</span>
                {account.is_admin && (
                  <span className="inline-flex shrink-0 items-center rounded-full border border-accent/20 bg-accent/10 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide text-accent">
                    Admin
                  </span>
                )}
              </div>
              <span className="min-w-0 truncate font-mono text-caption text-tertiary">
                {(account.emails || []).join(', ') || 'no linked email'}
              </span>
              <span className="text-caption text-tertiary sm:text-right">
                {account.account_count} accounts · {account.plaid_item_count} Plaid · {account.wallet_count} wallets
                {(account.configured_keys || []).length > 0 && ` · keys: ${account.configured_keys.join(', ')}`}
              </span>
            </div>
          ))}
        </div>
      </section>

      <section className="mb-8">
        <div className="mb-3 px-2">
          <h2 className="text-lg font-bold uppercase tracking-tight text-primary">Scheduled Jobs</h2>
          <p className="mt-1 text-xs text-secondary">Nightly pipeline (all times UTC). Manual runs execute immediately with your permissions.</p>
        </div>
        <div className="card divide-y divide-border overflow-hidden">
          {Object.entries(adminOverview.jobs?.jobs || {}).map(([name, job]) => (
            <div key={name} className="grid grid-cols-1 gap-2 px-4 py-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,1.6fr)_auto] sm:items-center">
              <div className="min-w-0">
                <span className="block text-body-sm font-semibold text-primary">{name}</span>
                <span className="block font-mono text-[10px] text-tertiary">{job.schedule} UTC</span>
              </div>
              <span className="min-w-0 truncate text-caption text-tertiary">
                {job.lastRun
                  ? `Last run ${formatRelativeTime(job.lastRun.completed_at || job.lastRun.started_at)} — ${job.lastRun.status}`
                  : 'Never run'}
              </span>
              <button
                type="button"
                onClick={() => handleTriggerJob(name)}
                disabled={triggeringJob !== null}
                className="inline-flex h-9 items-center justify-center gap-2 rounded border border-border bg-surface-3 px-3 text-xs font-bold uppercase tracking-wider text-secondary transition-all hover:border-accent hover:text-accent disabled:opacity-40"
              >
                {triggeringJob === name ? <RefreshCw size={12} className="animate-spin" /> : <RefreshCw size={12} />}
                Run Now
              </button>
            </div>
          ))}
        </div>
      </section>

      <section className="mb-8">
        <div className="mb-3 px-2">
          <h2 className="text-lg font-bold uppercase tracking-tight text-primary">Health</h2>
        </div>
        <div className="card divide-y divide-border overflow-hidden">
          <div className="flex items-center justify-between px-4 py-3">
            <span className="text-body-sm text-primary">Database</span>
            <span className={`text-caption font-bold ${adminOverview.health.dbReachable ? 'text-gain' : 'text-loss'}`}>
              {adminOverview.health.dbReachable ? 'Reachable' : 'Unreachable'}
            </span>
          </div>
          <div className="flex items-center justify-between px-4 py-3">
            <span className="text-body-sm text-primary">Key encryption</span>
            <span className={`text-caption font-bold ${adminOverview.health.encryptionConfigured ? 'text-gain' : 'text-loss'}`}>
              {adminOverview.health.encryptionConfigured ? 'Configured' : 'Not configured'}
            </span>
          </div>
          <div className="flex items-center justify-between px-4 py-3">
            <span className="text-body-sm text-primary">Latest price fetch</span>
            <span className="font-mono text-caption text-tertiary">
              {adminOverview.health.latestPriceFetchedAt ? formatRelativeTime(adminOverview.health.latestPriceFetchedAt) : 'never'}
            </span>
          </div>
          <div className="flex items-center justify-between px-4 py-3">
            <span className="text-body-sm text-primary">Migrations on disk</span>
            <span className="font-mono text-caption text-tertiary">{adminOverview.health.migrationCount ?? 'unknown'}</span>
          </div>
        </div>
      </section>
      </>
      )}

      {activeTab === 'accounts' && (
      <>
      <section className="mb-8">
        <div className="px-2 mb-4">
          <h2 className="text-lg font-bold text-primary uppercase tracking-tight">Account Display</h2>
          <p className="mt-1 text-xs text-secondary">Rename accounts for readability and hide accounts that should stay out of the main views. Manual accounts can be deleted; Plaid accounts are removed by disconnecting their institution.</p>
        </div>

        <div className="card overflow-hidden divide-y divide-border border-border">
          {allAccounts.length === 0 ? (
            <div className="p-8 text-center text-sm text-secondary">No accounts available.</div>
          ) : (
            allAccounts.map((account) => {
              const draft = displayNameDrafts[account.id] ?? '';
              const savedDisplayName = account.display_name || '';
              const isDirty = draft.trim() !== savedDisplayName.trim();
              const isSaving = savingDisplayNameId === account.id;
              const isSavingVisibility = savingVisibilityId === account.id;

              return (
                <div
                  key={account.id}
                  className={`p-4 md:p-5 grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_minmax(260px,0.9fr)_minmax(150px,0.45fr)_auto] gap-4 items-center ${account.is_hidden ? 'bg-surface-2' : ''}`}
                >
                  <div className="flex min-w-0 items-start justify-between gap-3 lg:col-start-1 lg:row-start-1 lg:block">
                    <div className="min-w-0">
                      <div className="mb-1 flex min-w-0 items-center gap-2">
                        <span className="min-w-0 truncate text-sm font-bold text-primary">{getAccountDisplayName(account)}</span>
                        {account.is_hidden && (
                          <span className="inline-flex items-center gap-1 px-2 py-0.5 text-[9px] font-bold uppercase tracking-wider rounded-full bg-loss/10 text-loss border border-loss/20">
                            <EyeOff size={10} />
                            Hidden
                          </span>
                        )}
                        {account.plaid_item_id && (
                          <span className="inline-flex items-center gap-1 px-2 py-0.5 text-[9px] font-bold uppercase tracking-wider rounded-full bg-accent/10 text-accent border border-accent/20">
                            <Link2 size={10} />
                            Plaid
                          </span>
                        )}
                        {account.eth_wallet_id && (
                          <span className="inline-flex items-center gap-1 px-2 py-0.5 text-[9px] font-bold uppercase tracking-wider rounded-full bg-crypto-bg text-crypto border border-crypto-border">
                            <Wallet size={10} />
                            Wallet
                          </span>
                        )}
                      </div>
                      <div className="flex flex-wrap items-center gap-2 text-[10px] font-bold uppercase tracking-wide text-tertiary">
                        <span>{account.type}</span>
                        {hasAccountDisplayName(account) && <span className="truncate normal-case tracking-normal font-medium">Source: {account.name}</span>}
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={() => setMobileEditingAccountId(mobileEditingAccountId === account.id ? null : account.id)}
                      className="inline-flex min-h-10 shrink-0 items-center justify-center border border-border bg-surface-3 px-3 text-caption font-semibold uppercase text-secondary lg:hidden"
                      aria-expanded={mobileEditingAccountId === account.id}
                    >
                      {mobileEditingAccountId === account.id ? 'Done' : 'Edit'}
                    </button>
                  </div>

                  {/* The input keeps its own wrapper so nodes injected next to it by
                      password-manager extensions land inside the cell instead of
                      becoming a grid item that shifts every column. */}
                  <div className={`${mobileEditingAccountId === account.id ? 'block' : 'hidden'} min-w-0 lg:col-start-2 lg:row-start-1 lg:block`}>
                    <input
                      type="text"
                      value={draft}
                      onChange={(e) => handleDisplayNameChange(account.id, e.target.value)}
                      maxLength={100}
                      placeholder={account.name}
                      className="h-11 w-full rounded border border-border bg-surface-2 px-3 text-sm text-primary outline-none placeholder:text-tertiary focus:ring-1 focus:ring-accent"
                      disabled={isSaving}
                    />
                  </div>

                  <button
                    type="button"
                    role="switch"
                    aria-checked={Boolean(account.is_hidden)}
                    aria-label={`Hide ${getAccountDisplayName(account)} from UI`}
                    onClick={() => handleVisibilityChange(account, !account.is_hidden)}
                    disabled={isSavingVisibility}
                    className={`${mobileEditingAccountId === account.id ? 'flex' : 'hidden'} h-11 items-center justify-between gap-3 rounded border px-3 text-left transition-all disabled:opacity-50 lg:col-start-3 lg:row-start-1 lg:flex ${
                      account.is_hidden
                        ? 'border-loss/30 bg-loss/10 text-loss'
                        : 'border-border bg-surface-2 text-secondary hover:text-primary'
                    }`}
                  >
                    <span className="inline-flex items-center gap-2 text-xs font-bold uppercase tracking-wider">
                      {isSavingVisibility ? (
                        <RefreshCw size={14} className="animate-spin" />
                      ) : account.is_hidden ? (
                        <EyeOff size={14} />
                      ) : (
                        <Eye size={14} />
                      )}
                      {account.is_hidden ? 'Hidden' : 'Visible'}
                    </span>
                    <span className={`h-5 w-9 rounded-full p-0.5 transition-colors ${account.is_hidden ? 'bg-loss/70' : 'bg-surface-3'}`}>
                      <span className={`block h-4 w-4 rounded-full bg-white shadow-sm transition-transform ${account.is_hidden ? 'translate-x-4' : ''}`} />
                    </span>
                  </button>

                  <div className={`${mobileEditingAccountId === account.id ? 'flex' : 'hidden'} items-center gap-2 lg:col-start-4 lg:row-start-1 lg:flex lg:justify-end`}>
                    {(isDirty || isSaving) ? (
                      <button
                        onClick={() => handleSaveDisplayName(account)}
                        disabled={isSaving || !isDirty}
                        className="inline-flex h-10 items-center justify-center gap-2 rounded bg-accent px-4 text-xs font-bold uppercase tracking-wider text-white transition-all hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-40"
                      >
                        {isSaving ? <RefreshCw size={14} className="animate-spin" /> : <Save size={14} />}
                        Save
                      </button>
                    ) : (
                      <span className="inline-flex h-10 items-center justify-center gap-2 px-3 text-xs font-bold uppercase tracking-wider text-tertiary">
                        <Check size={14} />
                        Saved
                      </span>
                    )}
                    {(hasAccountDisplayName(account) || draft.trim()) && (
                      <button
                        onClick={() => handleClearDisplayName(account)}
                        disabled={isSaving}
                        className="inline-flex h-10 items-center justify-center gap-2 rounded border border-border bg-surface-3 px-3 text-xs font-bold uppercase tracking-wider text-secondary transition-all hover:text-primary disabled:cursor-not-allowed disabled:opacity-40"
                      >
                        <Undo2 size={14} />
                        Clear
                      </button>
                    )}
                    {!account.plaid_item_id && !account.eth_wallet_id && (
                      <button
                        onClick={() => setDeletingAccount(account)}
                        disabled={deletingAccountId === account.id}
                        className="inline-flex h-10 items-center justify-center gap-2 rounded border border-border bg-surface-3 px-3 text-xs font-bold uppercase tracking-wider text-secondary transition-all hover:border-loss/30 hover:bg-loss/10 hover:text-loss disabled:cursor-not-allowed disabled:opacity-40"
                      >
                        {deletingAccountId === account.id ? <RefreshCw size={14} className="animate-spin" /> : <Trash2 size={14} />}
                        Delete
                      </button>
                    )}
                  </div>
                </div>
              );
            })
          )}
        </div>
      </section>

      </>
      )}

      <HoldingForm
        isOpen={Boolean(manualEntryType)}
        onClose={() => setManualEntryType(null)}
        onSave={handleManualEntrySave}
        holding={null}
        accounts={manualEntryAccounts}
        title={manualEntryType ? `Add Manual ${MANUAL_ENTRY_TYPES[manualEntryType].label}` : undefined}
      />

      {/* Delete Account Confirm Modal */}
      <AnimatePresence>
        {deletingAccount && (
          <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-center sm:p-4">
            <Motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="absolute inset-0 bg-black/70" onClick={() => setDeletingAccount(null)} />
            <Motion.div initial={{ opacity: 0, scale: 0.9, y: 20 }} animate={{ opacity: 1, scale: 1, y: 0 }} exit={{ opacity: 0, scale: 0.9, y: 20 }} className="relative w-full max-w-lg border border-border bg-surface shadow-2xl sm:rounded-3xl">
              <div className="p-5 pb-3 text-center sm:p-8 sm:pb-4">
                <div className="w-16 h-16 bg-loss/10 text-loss rounded-full flex items-center justify-center mx-auto mb-6">
                  <Trash2 size={28} />
                </div>
                <h2 className="text-2xl font-bold text-primary mb-2 tracking-tight">Delete Account</h2>
                <p className="text-sm text-secondary leading-relaxed">
                  You are about to permanently delete <span className="text-primary font-bold">{getAccountDisplayName(deletingAccount)}</span> along with its holdings and all historical value points. This cannot be undone.
                </p>
              </div>
              <div className="sticky bottom-0 flex gap-3 bg-surface p-5 sm:static sm:p-8 sm:pt-6">
                <button
                  onClick={() => setDeletingAccount(null)}
                  className="flex-1 py-4 bg-surface-3 text-secondary hover:text-primary rounded text-xs font-bold uppercase tracking-wider transition-all"
                >
                  Cancel
                </button>
                <button
                  onClick={handleDeleteConfirm}
                  className="flex-1 py-4 bg-loss text-white rounded text-xs font-bold uppercase tracking-wider hover:opacity-90 transition-all"
                >
                  Confirm Delete
                </button>
              </div>
            </Motion.div>
          </div>
        )}
      </AnimatePresence>

      {/* Connect Crypto Modal */}
      <AnimatePresence>
        {cryptoModalOpen && (
          <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-center sm:p-4">
            <Motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="absolute inset-0 bg-black/70" onClick={() => setCryptoModalOpen(false)} />
            <Motion.div initial={{ opacity: 0, scale: 0.9, y: 20 }} animate={{ opacity: 1, scale: 1, y: 0 }} exit={{ opacity: 0, scale: 0.9, y: 20 }} role="dialog" aria-modal="true" aria-labelledby="crypto-modal-title" className="relative max-h-[100dvh] w-full max-w-lg overflow-y-auto border border-border bg-surface shadow-2xl sm:max-h-[92vh] sm:rounded-3xl">
              <form onSubmit={handleAddWallet}>
                <div className="p-5 pb-3 text-center sm:p-8 sm:pb-4">
                  <div className="w-16 h-16 bg-crypto-bg text-crypto rounded-full flex items-center justify-center mx-auto mb-6">
                    <Wallet size={28} />
                  </div>
                  <h2 id="crypto-modal-title" className="text-2xl font-bold text-primary mb-2 tracking-tight">Connect Crypto Wallet</h2>
                  <p className="text-sm text-secondary leading-relaxed">
                    Paste an Ethereum address to track its balance and full transfer history via Etherscan.
                  </p>
                </div>

                <div className="space-y-4 p-5 sm:p-8 sm:pt-2">
                  <label className="block text-caption text-tertiary">
                    Address
                    <input
                      type="text"
                      value={walletAddress}
                      onChange={(event) => setWalletAddress(event.target.value)}
                      placeholder="0x…"
                      spellCheck={false}
                      autoComplete="off"
                      autoFocus
                      className="mt-1 block h-11 w-full min-w-0 rounded border border-input-border bg-surface-2 px-3 font-mono text-body-sm text-primary outline-none focus:ring-1 focus:ring-accent"
                      disabled={addingWallet}
                    />
                  </label>
                  <label className="block text-caption text-tertiary">
                    Label (optional)
                    <input
                      type="text"
                      value={walletLabel}
                      onChange={(event) => setWalletLabel(event.target.value)}
                      maxLength={100}
                      placeholder="Cold storage"
                      className="mt-1 block h-11 w-full min-w-0 rounded border border-input-border bg-surface-2 px-3 text-body-sm text-primary outline-none focus:ring-1 focus:ring-accent"
                      disabled={addingWallet}
                    />
                  </label>

                  {walletFormError && (
                    <div role="alert" className="flex items-start gap-2 rounded border border-loss/20 bg-loss/5 p-3 text-caption text-loss">
                      <AlertTriangle size={14} className="mt-0.5 shrink-0" />
                      <span>{walletFormError}</span>
                    </div>
                  )}

                  <p className="text-caption text-tertiary">
                    The first sync runs in the background; a busy wallet can take a few minutes to appear complete. Use Sync on the wallet card to refresh.
                  </p>
                </div>

                <div className="sticky bottom-0 flex gap-3 bg-surface p-5 pt-0 sm:static sm:p-8 sm:pt-0">
                  <button
                    type="button"
                    onClick={() => setCryptoModalOpen(false)}
                    className="flex-1 py-4 bg-surface-3 text-secondary hover:text-primary rounded text-xs font-bold uppercase tracking-wider transition-all"
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    disabled={addingWallet}
                    className="flex-1 inline-flex items-center justify-center gap-2 py-4 bg-crypto-bg-hover text-crypto border border-crypto-border rounded text-xs font-bold uppercase tracking-wider hover:bg-crypto-bg-strong hover:text-crypto-hover transition-all disabled:opacity-40"
                  >
                    {addingWallet ? <RefreshCw size={14} className="animate-spin" /> : <Plus size={14} />}
                    Track Wallet
                  </button>
                </div>
              </form>
            </Motion.div>
          </div>
        )}
      </AnimatePresence>

      {/* Wallet Disconnect Confirm Modal */}
      <AnimatePresence>
        {disconnectingWallet && (
          <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-center sm:p-4">
            <Motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="absolute inset-0 bg-black/70" onClick={() => setDisconnectingWallet(null)} />
            <Motion.div initial={{ opacity: 0, scale: 0.9, y: 20 }} animate={{ opacity: 1, scale: 1, y: 0 }} exit={{ opacity: 0, scale: 0.9, y: 20 }} className="relative max-h-[100dvh] w-full max-w-lg overflow-y-auto border border-border bg-surface shadow-2xl sm:max-h-[92vh] sm:rounded-3xl">
              <div className="p-5 pb-3 text-center sm:p-8 sm:pb-4">
                <div className="w-16 h-16 bg-loss/10 text-loss rounded-full flex items-center justify-center mx-auto mb-6">
                  <Unlink size={28} />
                </div>
                <h2 className="text-2xl font-bold text-primary mb-2 tracking-tight">Disconnect Wallet</h2>
                <p className="text-sm text-secondary leading-relaxed">
                  You are about to stop tracking <span className="font-mono text-primary font-bold">{shortEthAddress(disconnectingWallet.address)}</span>. How should we handle existing data?
                </p>
              </div>

              <div className="space-y-3 p-5 sm:p-8">
                <button
                  onClick={() => setRemoveDataOnWalletDisconnect(true)}
                  className={`w-full flex items-start gap-4 p-4 rounded border text-left transition-all ${removeDataOnWalletDisconnect ? 'border-accent bg-accent/5 ring-1 ring-accent/20' : 'border-border hover:border-border-hover bg-surface-2'}`}
                >
                  <div className={`mt-1 w-4 h-4 rounded-full border-2 flex items-center justify-center ${removeDataOnWalletDisconnect ? 'border-accent' : 'border-tertiary'}`}>
                    {removeDataOnWalletDisconnect && <div className="w-2 h-2 rounded-full bg-accent" />}
                  </div>
                  <div>
                    <p className="text-sm font-bold text-primary">Full Purge (Recommended)</p>
                    <p className="text-[11px] text-secondary mt-0.5">Delete the account, holdings, transfer history, and historical data for this wallet.</p>
                  </div>
                </button>

                <button
                  onClick={() => setRemoveDataOnWalletDisconnect(false)}
                  className={`w-full flex items-start gap-4 p-4 rounded border text-left transition-all ${!removeDataOnWalletDisconnect ? 'border-accent bg-accent/5 ring-1 ring-accent/20' : 'border-border hover:border-border-hover bg-surface-2'}`}
                >
                  <div className={`mt-1 w-4 h-4 rounded-full border-2 flex items-center justify-center ${!removeDataOnWalletDisconnect ? 'border-accent' : 'border-tertiary'}`}>
                    {!removeDataOnWalletDisconnect && <div className="w-2 h-2 rounded-full bg-accent" />}
                  </div>
                  <div>
                    <p className="text-sm font-bold text-primary">Unlink & Keep Data</p>
                    <p className="text-[11px] text-secondary mt-0.5">Stop syncing. The account and its current holdings become manual entries; on-chain transfer history is removed.</p>
                  </div>
                </button>
              </div>

              <div className="sticky bottom-0 flex gap-3 bg-surface p-5 pt-0 sm:static sm:p-8 sm:pt-0">
                <button
                  onClick={() => setDisconnectingWallet(null)}
                  className="flex-1 py-4 bg-surface-3 text-secondary hover:text-primary rounded text-xs font-bold uppercase tracking-wider transition-all"
                >
                  Cancel
                </button>
                <button
                  onClick={handleWalletDisconnectConfirm}
                  className="flex-1 py-4 bg-loss text-white rounded text-xs font-bold uppercase tracking-wider hover:opacity-90 transition-all"
                >
                  Confirm Disconnect
                </button>
              </div>
            </Motion.div>
          </div>
        )}
      </AnimatePresence>

      {/* Disconnect Confirm Modal */}
      <AnimatePresence>
        {disconnectingItem && (
          <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-center sm:p-4">
            <Motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="absolute inset-0 bg-black/70 " onClick={() => setDisconnectingItem(null)} />
            <Motion.div initial={{ opacity: 0, scale: 0.9, y: 20 }} animate={{ opacity: 1, scale: 1, y: 0 }} exit={{ opacity: 0, scale: 0.9, y: 20 }} className="relative max-h-[100dvh] w-full max-w-lg overflow-y-auto border border-border bg-surface shadow-2xl sm:max-h-[92vh] sm:rounded-3xl">
              <div className="p-5 pb-3 text-center sm:p-8 sm:pb-4">
                <div className="w-16 h-16 bg-loss/10 text-loss rounded-full flex items-center justify-center mx-auto mb-6">
                  <Unlink size={28} />
                </div>
                <h2 className="text-2xl font-bold text-primary mb-2 tracking-tight">Disconnect Institution</h2>
                <p className="text-sm text-secondary leading-relaxed">
                  You are about to disconnect <span className="text-primary font-bold">{disconnectingItem.institution_name}</span>. How should we handle existing data?
                </p>
              </div>

              <div className="space-y-3 p-5 sm:p-8">
                <button 
                  onClick={() => setRemoveDataOnDisconnect(true)}
                  className={`w-full flex items-start gap-4 p-4 rounded border text-left transition-all ${removeDataOnDisconnect ? 'border-accent bg-accent/5 ring-1 ring-accent/20' : 'border-border hover:border-border-hover bg-surface-2'}`}
                >
                  <div className={`mt-1 w-4 h-4 rounded-full border-2 flex items-center justify-center ${removeDataOnDisconnect ? 'border-accent' : 'border-tertiary'}`}>
                    {removeDataOnDisconnect && <div className="w-2 h-2 rounded-full bg-accent" />}
                  </div>
                  <div>
                    <p className="text-sm font-bold text-primary">Full Purge (Recommended)</p>
                    <p className="text-[11px] text-secondary mt-0.5">Delete all accounts, current holdings, and historical data associated with this link.</p>
                  </div>
                </button>

                <button 
                  onClick={() => setRemoveDataOnDisconnect(false)}
                  className={`w-full flex items-start gap-4 p-4 rounded border text-left transition-all ${!removeDataOnDisconnect ? 'border-accent bg-accent/5 ring-1 ring-accent/20' : 'border-border hover:border-border-hover bg-surface-2'}`}
                >
                  <div className={`mt-1 w-4 h-4 rounded-full border-2 flex items-center justify-center ${!removeDataOnDisconnect ? 'border-accent' : 'border-tertiary'}`}>
                    {!removeDataOnDisconnect && <div className="w-2 h-2 rounded-full bg-accent" />}
                  </div>
                  <div>
                    <p className="text-sm font-bold text-primary">Unlink & Keep Data</p>
                    <p className="text-[11px] text-secondary mt-0.5">Stop automatic syncing. Current holdings will be converted to manual entries you can update yourself.</p>
                  </div>
                </button>
              </div>

              <div className="sticky bottom-0 flex gap-3 bg-surface p-5 pt-0 sm:static sm:p-8 sm:pt-0">
                <button
                  onClick={() => setDisconnectingItem(null)}
                  className="flex-1 py-4 bg-surface-3 text-secondary hover:text-primary rounded text-xs font-bold uppercase tracking-wider transition-all"
                >
                  Cancel
                </button>
                <button
                  onClick={handleDisconnectConfirm}
                  className="flex-1 py-4 bg-loss text-white rounded text-xs font-bold uppercase tracking-wider hover:opacity-90 transition-all"
                >
                  Confirm Disconnect
                </button>
              </div>
            </Motion.div>
          </div>
        )}
      </AnimatePresence>
    </div>
  );
};

export default Settings;

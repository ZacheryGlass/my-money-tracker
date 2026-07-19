import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { usePlaidLink } from 'react-plaid-link';
import { motion as Motion, AnimatePresence } from 'framer-motion';
import { Link2, RefreshCw, Unlink, AlertTriangle, Building2, Plus, Clock, Trash2, ShieldCheck, ChevronRight, X, Check, Save, Undo2, Eye, EyeOff, Download, Wallet, Landmark, TrendingUp, Briefcase, Receipt } from 'lucide-react';
import { plaid as plaidAPI, accounts as accountsAPI, holdings as holdingsAPI, exportData, history as historyAPI } from '../utils/api';
import { getAccountDisplayName, hasAccountDisplayName } from '../utils/accountDisplay';
import useAppearancePreferences from '../hooks/useAppearancePreferences';
import { APPEARANCE_THEMES, APPEARANCE_FONT_SIZES, APPEARANCE_FONT_FAMILIES } from '../utils/appearancePreferences';
import HoldingForm from '../components/HoldingForm';
import FilterTabs from '../components/FilterTabs';
import LoadingState from '../components/LoadingState';
import useTransientMessage from '../hooks/useTransientMessage';
import { formatRelativeTime } from '../utils/format';

const SETTINGS_TABS = [
  { id: 'appearance', label: 'Appearance' },
  { id: 'data-tools', label: 'Data Tools' },
  { id: 'institutions', label: 'Institutions' },
  { id: 'accounts', label: 'Accounts' },
];

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
  subscription: {
    label: 'Subscription',
    description: 'Recurring service or membership',
    path: '/monthly-expenses',
    entryType: 'subscription',
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

const Settings = () => {
  const navigate = useNavigate();
  const location = useLocation();
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
  const [activeTab, setActiveTab] = useState(() =>
    SETTINGS_TABS.some((t) => t.id === location.state?.tab) ? location.state.tab : 'appearance'
  );

  const institutionSummary = useMemo(
    () => buildInstitutionSummary(items, consentItems),
    [items, consentItems]
  );
  const manualEntryAccounts = useMemo(() => {
    if (!manualEntryType) return [];
    const allowedTypes = MANUAL_ENTRY_TYPES[manualEntryType].accountTypes;
    if (!allowedTypes) return [];
    return allAccounts.filter((account) => !account.is_hidden && allowedTypes.has(account.type));
  }, [allAccounts, manualEntryType]);

  const fetchItems = useCallback(async () => {
    try {
      const [plaidData, accountsData] = await Promise.all([
        plaidAPI.getItems(),
        accountsAPI.getAll({ includeHidden: true }),
      ]);
      const loadedItems = plaidData.items || [];
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
        setError('Additional consent required for investment data. Click "Re-link" to authorize.');
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

        <div className="flex items-center gap-4 [&>button]:w-full sm:[&>button]:w-auto">
          <PlaidLinkButton onSuccess={handlePlaidSuccess} onError={setError} disabled={connecting} />
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
        options={SETTINGS_TABS.map((t) => {
          const attention = t.id === 'institutions' && institutionSummary.attentionCount > 0;
          return {
            value: t.id,
            label: t.label,
            selectLabel: attention ? `${t.label} (${institutionSummary.attentionCount})` : t.label,
            badge: attention && (
              <span className="ml-1.5 inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-loss px-1 font-mono text-[10px] font-bold leading-none text-white">
                {institutionSummary.attentionCount}
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
                        {consentItems.has(item.id)
                          ? 'This institution requires additional authorization to provide investment and holdings data. Please click "Re-link" to grant permission.'
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
                  <div className="flex min-w-0 items-start justify-between gap-3 lg:block">
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

                  <input
                    type="text"
                    value={draft}
                    onChange={(e) => handleDisplayNameChange(account.id, e.target.value)}
                    maxLength={100}
                    placeholder={account.name}
                    className={`${mobileEditingAccountId === account.id ? 'block' : 'hidden'} h-11 w-full rounded border border-border bg-surface-2 px-3 text-sm text-primary outline-none placeholder:text-tertiary focus:ring-1 focus:ring-accent lg:block`}
                    disabled={isSaving}
                  />

                  <button
                    type="button"
                    role="switch"
                    aria-checked={Boolean(account.is_hidden)}
                    aria-label={`Hide ${getAccountDisplayName(account)} from UI`}
                    onClick={() => handleVisibilityChange(account, !account.is_hidden)}
                    disabled={isSavingVisibility}
                    className={`${mobileEditingAccountId === account.id ? 'flex' : 'hidden'} h-11 items-center justify-between gap-3 rounded border px-3 text-left transition-all disabled:opacity-50 lg:flex ${
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

                  <div className={`${mobileEditingAccountId === account.id ? 'flex' : 'hidden'} items-center gap-2 lg:flex lg:justify-end`}>
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
                    {!account.plaid_item_id && (
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

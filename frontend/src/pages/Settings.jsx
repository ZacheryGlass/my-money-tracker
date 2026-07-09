import React, { useState, useEffect, useCallback } from 'react';
import { usePlaidLink } from 'react-plaid-link';
import { motion as Motion, AnimatePresence } from 'framer-motion';
import { Link2, RefreshCw, Unlink, AlertTriangle, Building2, Plus, Clock, Trash2, ShieldCheck, ChevronRight, X, Check, Save, Undo2, Eye, EyeOff } from 'lucide-react';
import { plaid as plaidAPI, accounts as accountsAPI } from '../utils/api';
import { getAccountDisplayName, hasAccountDisplayName } from '../utils/accountDisplay';

function PlaidLinkButton({ onSuccess, disabled }) {
  const [linkToken, setLinkToken] = useState(null);
  const [loading, setLoading] = useState(false);

  const fetchLinkToken = async () => {
    setLoading(true);
    try {
      const data = await plaidAPI.createLinkToken();
      setLinkToken(data.link_token);
    } catch {
      setLinkToken(null);
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

function UpdateLinkButton({ itemId, onSuccess }) {
  const [linkToken, setLinkToken] = useState(null);
  const [loading, setLoading] = useState(false);

  const fetchUpdateToken = async () => {
    setLoading(true);
    try {
      const data = await plaidAPI.createUpdateLinkToken(itemId);
      setLinkToken(data.link_token);
    } catch {
      setLinkToken(null);
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

function formatSyncTime(timestamp) {
  if (!timestamp) return 'Never';
  const date = new Date(timestamp);
  const now = new Date();
  const diffMs = now - date;
  const diffMins = Math.floor(diffMs / 60000);
  if (diffMins < 1) return 'Just now';
  if (diffMins < 60) return `${diffMins}m ago`;
  const diffHours = Math.floor(diffMins / 60);
  if (diffHours < 24) return `${diffHours}h ago`;
  const diffDays = Math.floor(diffHours / 24);
  return `${diffDays}d ago`;
}

const Settings = () => {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [successMessage, setSuccessMessage] = useState('');
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
  const [orphanedAccounts, setOrphanedAccounts] = useState([]);
  const [deletingAccountId, setDeletingAccountId] = useState(null);

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
      setOrphanedAccounts(
        allAccounts.filter(a => !a.plaid_item_id && a.type === 'investment' && a.name.includes(' - '))
      );
      setError(null);
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to load connected accounts');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchItems(); }, [fetchItems]);

  const showSuccess = (msg) => {
    setSuccessMessage(msg);
    setTimeout(() => setSuccessMessage(''), 3000);
  };

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

  if (loading) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[400px] gap-4">
        <div className="w-6 h-6 border-2 border-accent border-t-transparent rounded-full animate-spin" />
        <span className="text-xs font-bold tracking-wide uppercase text-tertiary ">Initializing Settings</span>
      </div>
    );
  }

  return (
    <div className="container mx-auto px-4 py-6 md:py-8 max-w-[1000px]">
      {/* Hero Section */}
      <div className="flex flex-col md:flex-row md:items-end justify-between mb-10 gap-6">
        <div>
          <div className="flex items-center gap-2 mb-2">
            <ShieldCheck className="text-accent w-5 h-5" />
            <span className="text-[10px] font-bold uppercase tracking-wide text-secondary">Data Integrity</span>
          </div>
          <h1 className="text-3xl md:text-5xl font-bold text-primary tracking-tighter leading-none mb-2">
            Linked Accounts
          </h1>
          <p className="text-sm text-secondary">Manage institution connections and data synchronization</p>
        </div>

        <div className="flex items-center gap-4">
          <PlaidLinkButton onSuccess={handlePlaidSuccess} disabled={connecting} />
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
        <div className="card p-8 flex flex-col items-center justify-center gap-4 animate-fade-in border-accent/20 bg-accent/5">
          <RefreshCw size={32} className="animate-spin text-accent" />
          <p className="text-sm font-bold uppercase tracking-wide text-accent">Exchanging tokens and syncing data...</p>
        </div>
      )}

      <section className="mb-12">
        <div className="px-2 mb-4">
          <h2 className="text-lg font-bold text-primary uppercase tracking-tight">Account Display</h2>
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
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 mb-1">
                      <span className="text-sm font-bold text-primary truncate">{getAccountDisplayName(account)}</span>
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

                  <input
                    type="text"
                    value={draft}
                    onChange={(e) => handleDisplayNameChange(account.id, e.target.value)}
                    maxLength={100}
                    placeholder={account.name}
                    className="w-full h-11 px-3 bg-surface-2 border border-border rounded text-sm text-primary placeholder:text-tertiary focus:ring-1 focus:ring-accent outline-none"
                    disabled={isSaving}
                  />

                  <button
                    type="button"
                    role="switch"
                    aria-checked={Boolean(account.is_hidden)}
                    aria-label={`Hide ${getAccountDisplayName(account)} from UI`}
                    onClick={() => handleVisibilityChange(account, !account.is_hidden)}
                    disabled={isSavingVisibility}
                    className={`flex h-11 items-center justify-between gap-3 rounded border px-3 text-left transition-all disabled:opacity-50 ${
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
                      <span className={`block h-4 w-4 rounded-full bg-white transition-transform ${account.is_hidden ? 'translate-x-4' : ''}`} />
                    </span>
                  </button>

                  <div className="flex items-center gap-2 lg:justify-end">
                    <button
                      onClick={() => handleSaveDisplayName(account)}
                      disabled={isSaving || !isDirty}
                      className="inline-flex items-center justify-center gap-2 h-10 px-4 rounded bg-accent text-white text-xs font-bold uppercase tracking-wider hover:bg-accent-hover transition-all disabled:opacity-40 disabled:cursor-not-allowed"
                    >
                      {isSaving ? <RefreshCw size={14} className="animate-spin" /> : <Save size={14} />}
                      Save
                    </button>
                    <button
                      onClick={() => handleClearDisplayName(account)}
                      disabled={isSaving || (!hasAccountDisplayName(account) && !draft.trim())}
                      className="inline-flex items-center justify-center gap-2 h-10 px-3 rounded bg-surface-3 text-secondary border border-border text-xs font-bold uppercase tracking-wider hover:text-primary transition-all disabled:opacity-40 disabled:cursor-not-allowed"
                    >
                      <Undo2 size={14} />
                      Clear
                    </button>
                  </div>
                </div>
              );
            })
          )}
        </div>
      </section>

      <div className="space-y-4">
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
                          {formatSyncTime(item.last_synced_at)}
                        </span>
                      </div>
                    </div>
                  </div>

                  <div className="flex items-center gap-2">
                    {consentItems.has(item.id) && (
                      <UpdateLinkButton itemId={item.id} onSuccess={handleRelink} />
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
      </div>

      {/* Orphaned Accounts */}
      {orphanedAccounts.length > 0 && (
        <Motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="mt-12 space-y-6">
          <div className="px-2">
            <h2 className="text-lg font-bold text-primary uppercase tracking-tight">Manual / Orphaned Entries</h2>
            <p className="text-xs text-secondary mt-1">These accounts are not linked to Plaid. Deleting removes the account and all its historical value points.</p>
          </div>
          
          <div className="card overflow-hidden divide-y divide-border border-border">
            {orphanedAccounts.map((acct) => (
              <div key={acct.id} className="flex items-center justify-between p-5 hover:bg-surface-2 transition-colors group">
                <div className="min-w-0">
                  <span className="text-sm font-bold text-primary truncate block">{getAccountDisplayName(acct)}</span>
                  {hasAccountDisplayName(acct) && (
                    <span className="text-[10px] text-tertiary uppercase tracking-tight truncate block mt-1">{acct.name}</span>
                  )}
                  <span className="text-[10px] font-bold text-tertiary uppercase tracking-wide mt-1 block">
                    {acct.holdings_count || 0} Assets • Manual Tracking
                  </span>
                </div>
                <button
                  onClick={async () => {
                    setDeletingAccountId(acct.id);
                    try {
                      await accountsAPI.delete(acct.id);
                      showSuccess(`"${getAccountDisplayName(acct)}" deleted`);
                      await fetchItems();
                    } catch (err) {
                      setError(err.response?.data?.error || 'Failed to delete account');
                    } finally {
                      setDeletingAccountId(null);
                    }
                  }}
                  disabled={deletingAccountId === acct.id}
                  className="p-2.5 rounded text-tertiary hover:text-loss hover:bg-loss/10 transition-all opacity-0 group-hover:opacity-100"
                >
                  <Trash2 size={18} />
                </button>
              </div>
            ))}
          </div>
        </Motion.div>
      )}

      {/* Disconnect Confirm Modal */}
      <AnimatePresence>
        {disconnectingItem && (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
            <Motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="absolute inset-0 bg-black/70 " onClick={() => setDisconnectingItem(null)} />
            <Motion.div initial={{ opacity: 0, scale: 0.9, y: 20 }} animate={{ opacity: 1, scale: 1, y: 0 }} exit={{ opacity: 0, scale: 0.9, y: 20 }} className="relative bg-surface rounded-3xl border border-border shadow-2xl max-w-lg w-full overflow-hidden">
              <div className="p-8 pb-4 text-center">
                <div className="w-16 h-16 bg-loss/10 text-loss rounded-full flex items-center justify-center mx-auto mb-6">
                  <Unlink size={28} />
                </div>
                <h2 className="text-2xl font-bold text-primary mb-2 tracking-tight">Disconnect Institution</h2>
                <p className="text-sm text-secondary leading-relaxed">
                  You are about to disconnect <span className="text-primary font-bold">{disconnectingItem.institution_name}</span>. How should we handle existing data?
                </p>
              </div>

              <div className="p-8 space-y-3">
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

              <div className="p-8 pt-0 flex gap-3">
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

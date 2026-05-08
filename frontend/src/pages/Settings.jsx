import React, { useState, useEffect, useCallback } from 'react';
import { usePlaidLink } from 'react-plaid-link';
import { motion, AnimatePresence } from 'framer-motion';
import { Link2, RefreshCw, Unlink, AlertTriangle, Building2, Plus, Clock, Trash2, ShieldCheck, ChevronRight, X, Check } from 'lucide-react';
import { plaid as plaidAPI, accounts as accountsAPI } from '../utils/api';

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
      className="flex items-center gap-2 px-6 py-4 bg-accent text-inverse hover:bg-accent-hover rounded-2xl text-sm font-bold transition-all shadow-glow disabled:opacity-50"
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
      className="flex items-center gap-1.5 px-4 py-2 rounded-xl text-xs font-bold text-inverse bg-accent hover:bg-accent-hover transition-all shadow-sm"
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
  const [orphanedAccounts, setOrphanedAccounts] = useState([]);
  const [deletingAccountId, setDeletingAccountId] = useState(null);

  const fetchItems = useCallback(async () => {
    try {
      const [plaidData, accountsData] = await Promise.all([
        plaidAPI.getItems(),
        accountsAPI.getAll(),
      ]);
      const loadedItems = plaidData.items || [];
      setItems(loadedItems);
      setConsentItems(new Set(
        loadedItems
          .filter(item => item.error_code === 'ADDITIONAL_CONSENT_REQUIRED')
          .map(item => item.id)
      ));
      const allAccounts = accountsData.accounts || [];
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

  if (loading) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[400px] gap-4">
        <div className="w-10 h-10 border-4 border-accent border-t-transparent rounded-full animate-spin shadow-glow" />
        <span className="text-xs font-bold tracking-widest uppercase text-tertiary animate-pulse">Initializing Settings</span>
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
            <span className="text-[10px] font-bold uppercase tracking-widest text-secondary">Data Integrity</span>
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
        <motion.div initial={{ opacity: 0, y: -10 }} animate={{ opacity: 1, y: 0 }} className="mb-6 p-4 bg-gain-bg border border-gain/20 text-gain rounded-xl text-xs flex items-center gap-3">
          <Check size={16} />
          {successMessage}
        </motion.div>
      )}
      {error && (
        <motion.div initial={{ opacity: 0, y: -10 }} animate={{ opacity: 1, y: 0 }} className="mb-6 p-4 bg-loss-bg border border-loss/20 text-loss rounded-xl text-xs flex items-center gap-3">
          <AlertTriangle size={16} />
          <span className="flex-1">{error}</span>
          <button onClick={() => setError(null)}><X size={14} /></button>
        </motion.div>
      )}

      {connecting && (
        <div className="card p-8 flex flex-col items-center justify-center gap-4 animate-fade-in border-accent/20 bg-accent/5">
          <RefreshCw size={32} className="animate-spin text-accent" />
          <p className="text-sm font-bold uppercase tracking-widest text-accent">Exchanging tokens and syncing data...</p>
        </div>
      )}

      <div className="space-y-4">
        {items.length === 0 && !connecting ? (
          <div className="card p-12 text-center border-dashed border-2 border-border/50 bg-transparent">
            <Building2 size={40} className="mx-auto text-tertiary mb-4 opacity-20" />
            <h3 className="text-lg font-bold text-primary mb-2 uppercase tracking-tight">No Institutions Linked</h3>
            <p className="text-sm text-secondary max-w-md mx-auto leading-relaxed">
              Link your brokerage or depository accounts to automatically pull balance and performance history.
            </p>
          </div>
        ) : (
          items.map((item) => (
            <motion.div layout key={item.id} className="card overflow-hidden border-border/50">
              <div className="p-5 md:p-6">
                <div className="flex flex-col md:flex-row md:items-center justify-between gap-6">
                  <div className="flex items-center gap-4 min-w-0">
                    <div className="w-12 h-12 rounded-2xl bg-surface-3 border border-border flex items-center justify-center flex-shrink-0 shadow-sm">
                      <Building2 size={24} className="text-accent" />
                    </div>
                    <div className="min-w-0">
                      <h3 className="text-base font-bold text-primary truncate leading-tight">
                        {item.institution_name || 'Financial Institution'}
                      </h3>
                      <div className="flex items-center gap-4 mt-1">
                        <span className="text-[10px] font-bold uppercase tracking-widest text-tertiary">
                          {item.accounts?.length || 0} Account{(item.accounts?.length || 0) !== 1 ? 's' : ''}
                        </span>
                        <span className="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-widest text-tertiary">
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
                      className="flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl text-xs font-bold uppercase tracking-wider text-secondary bg-surface-3 border border-border hover:border-accent hover:text-accent transition-all disabled:opacity-50"
                    >
                      <RefreshCw size={14} className={syncingId === item.id ? 'animate-spin' : ''} />
                      Sync
                    </button>
                    <button
                      onClick={() => { setRemoveDataOnDisconnect(true); setDisconnectingItem(item); }}
                      className="p-2.5 rounded-xl text-tertiary hover:text-loss hover:bg-loss/10 border border-transparent transition-all"
                      title="Disconnect Institution"
                    >
                      <Unlink size={18} />
                    </button>
                  </div>
                </div>

                {(item.error_code || consentItems.has(item.id)) && (
                  <div className={`mt-5 p-4 rounded-xl border text-xs leading-relaxed ${consentItems.has(item.id) ? 'bg-accent/5 border-accent/20 text-accent' : 'bg-loss/5 border-loss/20 text-loss'}`}>
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
                  <div className="mt-6 pt-5 border-t border-border/50">
                    <button
                      onClick={() => setExpandedItem(expandedItem === item.id ? null : item.id)}
                      className="flex items-center gap-2 text-[10px] font-bold uppercase tracking-widest text-tertiary hover:text-primary transition-colors group"
                    >
                      <span>{expandedItem === item.id ? 'Collapse' : 'View'} Internal Accounts</span>
                      <ChevronRight size={12} className={`transition-transform duration-200 ${expandedItem === item.id ? 'rotate-90' : ''}`} />
                    </button>
                    
                    <AnimatePresence>
                      {expandedItem === item.id && (
                        <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }} className="overflow-hidden">
                          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 mt-4">
                            {item.accounts.map((acct) => (
                              <div key={acct.id} className="flex items-center justify-between gap-4 px-4 py-3 rounded-xl bg-surface-2/50 border border-transparent hover:border-border transition-colors">
                                <div className="flex items-center gap-3 min-w-0">
                                  <Link2 size={12} className="text-accent opacity-60 flex-shrink-0" />
                                  <span className="text-xs font-bold text-primary truncate">{acct.name}</span>
                                </div>
                                <span className="text-[9px] font-bold text-tertiary uppercase tracking-widest px-2 py-0.5 rounded-full bg-surface-3">{acct.type}</span>
                              </div>
                            ))}
                          </div>
                        </motion.div>
                      )}
                    </AnimatePresence>
                  </div>
                )}
              </div>
            </motion.div>
          ))}
        </div>
      )}

      {/* Orphaned Accounts */}
      {orphanedAccounts.length > 0 && (
        <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="mt-12 space-y-6">
          <div className="px-2">
            <h2 className="text-lg font-bold text-primary uppercase tracking-tight">Manual / Orphaned Entries</h2>
            <p className="text-xs text-secondary mt-1">These accounts are not linked to Plaid. Deleting removes the account and all its historical value points.</p>
          </div>
          
          <div className="card overflow-hidden divide-y divide-border border-border/50">
            {orphanedAccounts.map((acct) => (
              <div key={acct.id} className="flex items-center justify-between p-5 hover:bg-surface-2 transition-colors group">
                <div className="min-w-0">
                  <span className="text-sm font-bold text-primary truncate block">{acct.name}</span>
                  <span className="text-[10px] font-bold text-tertiary uppercase tracking-widest mt-1 block">
                    {acct.holdings_count || 0} Assets • Manual Tracking
                  </span>
                </div>
                <button
                  onClick={async () => {
                    setDeletingAccountId(acct.id);
                    try {
                      await accountsAPI.delete(acct.id);
                      showSuccess(`"${acct.name}" deleted`);
                      await fetchItems();
                    } catch (err) {
                      setError(err.response?.data?.error || 'Failed to delete account');
                    } finally {
                      setDeletingAccountId(null);
                    }
                  }}
                  disabled={deletingAccountId === acct.id}
                  className="p-2.5 rounded-xl text-tertiary hover:text-loss hover:bg-loss/10 transition-all opacity-0 group-hover:opacity-100"
                >
                  <Trash2 size={18} />
                </button>
              </div>
            ))}
          </div>
        </motion.div>
      )}

      {/* Disconnect Confirm Modal */}
      <AnimatePresence>
        {disconnectingItem && (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
            <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="absolute inset-0 bg-black/70 backdrop-blur-md" onClick={() => setDisconnectingItem(null)} />
            <motion.div initial={{ opacity: 0, scale: 0.9, y: 20 }} animate={{ opacity: 1, scale: 1, y: 0 }} exit={{ opacity: 0, scale: 0.9, y: 20 }} className="relative bg-surface rounded-3xl border border-border shadow-2xl max-w-lg w-full overflow-hidden">
              <div className="p-8 pb-4 text-center">
                <div className="w-16 h-16 bg-loss/10 text-loss rounded-full flex items-center justify-center mx-auto mb-6 shadow-glow-sm">
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
                  className={`w-full flex items-start gap-4 p-4 rounded-2xl border text-left transition-all ${removeDataOnDisconnect ? 'border-accent bg-accent/5 ring-1 ring-accent/20' : 'border-border hover:border-border-hover bg-surface-2'}`}
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
                  className={`w-full flex items-start gap-4 p-4 rounded-2xl border text-left transition-all ${!removeDataOnDisconnect ? 'border-accent bg-accent/5 ring-1 ring-accent/20' : 'border-border hover:border-border-hover bg-surface-2'}`}
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
                  className="flex-1 py-4 bg-surface-3 text-secondary hover:text-primary rounded-2xl text-xs font-bold uppercase tracking-wider transition-all"
                >
                  Cancel
                </button>
                <button
                  onClick={handleDisconnectConfirm}
                  className="flex-1 py-4 bg-loss text-inverse rounded-2xl text-xs font-bold uppercase tracking-wider hover:opacity-90 transition-all shadow-glow-sm"
                >
                  Confirm Disconnect
                </button>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>
    </div>
  );
};

export default Settings;

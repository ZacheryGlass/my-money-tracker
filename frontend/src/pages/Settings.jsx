import React, { useState, useEffect, useCallback } from 'react';
import { usePlaidLink } from 'react-plaid-link';
import { plaid as plaidAPI, accounts as accountsAPI } from '../utils/api';
import { Link2, RefreshCw, Unlink, AlertTriangle, Building2, Plus, Clock, Trash2 } from 'lucide-react';

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
      className="flex items-center gap-2 px-4 py-2.5 bg-accent text-inverse hover:bg-accent-hover rounded-lg text-sm font-medium transition-colors duration-200 min-h-[44px] touch-manipulation disabled:opacity-50"
    >
      {loading ? (
        <RefreshCw size={16} className="animate-spin" />
      ) : (
        <Plus size={16} />
      )}
      Connect Account
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
      className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium text-inverse bg-accent hover:bg-accent-hover transition-colors duration-200 min-h-[44px] touch-manipulation disabled:opacity-50"
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
      <div className="flex items-center justify-center min-h-[400px]">
        <div className="w-8 h-8 border-4 border-accent border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  return (
    <div className="p-4 md:p-6 lg:p-8 max-w-[1000px] mx-auto space-y-6">
      {/* Hero */}
      <div className="animate-fade-in">
        <p className="text-[10px] font-semibold tracking-widest uppercase text-secondary mb-1">
          Account Settings
        </p>
        <h1 className="text-3xl font-bold text-primary leading-none">
          Connected Accounts
        </h1>
        <p className="text-sm text-secondary mt-2">
          Link your financial accounts to automatically sync balances and holdings.
        </p>
      </div>

      {successMessage && (
        <div className="bg-gain-bg text-gain border border-gain/20 rounded-lg p-3 animate-fade-in">
          {successMessage}
        </div>
      )}
      {error && (
        <div className="bg-loss-bg text-loss border border-loss/20 rounded-lg p-3 animate-fade-in">
          {error}
          <button onClick={() => setError(null)} className="ml-2 underline text-xs">Dismiss</button>
        </div>
      )}

      {/* Connect button */}
      <div className="flex justify-end">
        <PlaidLinkButton onSuccess={handlePlaidSuccess} disabled={connecting} />
      </div>

      {connecting && (
        <div className="card p-6 flex items-center justify-center gap-3 animate-fade-in">
          <RefreshCw size={20} className="animate-spin text-accent" />
          <span className="text-sm text-secondary">Connecting and syncing account data...</span>
        </div>
      )}

      {/* Items list */}
      {items.length === 0 && !connecting ? (
        <div className="card p-12 text-center animate-slide-up">
          <Building2 size={40} className="mx-auto text-tertiary mb-4" />
          <h3 className="text-lg font-semibold text-primary mb-2">No accounts connected</h3>
          <p className="text-sm text-secondary max-w-md mx-auto">
            Connect your bank, brokerage, or retirement accounts to automatically sync your portfolio.
          </p>
        </div>
      ) : (
        <div className="space-y-3 animate-slide-up">
          {items.map((item) => (
            <div key={item.id} className="card overflow-hidden">
              <div className="p-4 md:p-5">
                <div className="flex items-start justify-between gap-4">
                  <div className="flex items-center gap-3 min-w-0">
                    <div className="w-10 h-10 rounded-lg bg-accent/10 border border-accent/20 flex items-center justify-center flex-shrink-0">
                      <Building2 size={20} className="text-accent" />
                    </div>
                    <div className="min-w-0">
                      <h3 className="text-sm font-semibold text-primary truncate">
                        {item.institution_name || 'Connected Account'}
                      </h3>
                      <div className="flex items-center gap-3 mt-0.5">
                        <span className="text-xs text-secondary">
                          {item.accounts?.length || 0} account{(item.accounts?.length || 0) !== 1 ? 's' : ''}
                        </span>
                        <span className="flex items-center gap-1 text-xs text-tertiary">
                          <Clock size={10} />
                          {formatSyncTime(item.last_synced_at)}
                        </span>
                      </div>
                    </div>
                  </div>

                  <div className="flex items-center gap-1.5 flex-shrink-0">
                    {consentItems.has(item.id) ? (
                      <UpdateLinkButton itemId={item.id} onSuccess={handleRelink} />
                    ) : item.error_code ? (
                      <span className="flex items-center gap-1 px-2 py-1 rounded-md bg-loss/10 text-loss text-xs font-medium">
                        <AlertTriangle size={12} />
                        Error
                      </span>
                    ) : null}
                    <button
                      onClick={() => handleSync(item.id)}
                      disabled={syncingId === item.id}
                      className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium text-secondary hover:text-accent hover:bg-accent/10 transition-colors duration-200 min-h-[44px] touch-manipulation disabled:opacity-50"
                      title="Sync now"
                    >
                      <RefreshCw size={14} className={syncingId === item.id ? 'animate-spin' : ''} />
                      Sync
                    </button>
                    <button
                      onClick={() => { setRemoveDataOnDisconnect(true); setDisconnectingItem(item); }}
                      className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium text-secondary hover:text-loss hover:bg-loss/10 transition-colors duration-200 min-h-[44px] touch-manipulation"
                      title="Disconnect"
                    >
                      <Unlink size={14} />
                    </button>
                  </div>
                </div>

                {item.error_code && !consentItems.has(item.id) && (
                  <div className="mt-3 px-3 py-2 rounded-md bg-loss/5 border border-loss/10 text-xs text-loss">
                    {item.error_message || `Error: ${item.error_code}`}
                  </div>
                )}
                {consentItems.has(item.id) && (
                  <div className="mt-3 px-3 py-2 rounded-md bg-[var(--color-accent)]/5 border border-[var(--color-accent)]/10 text-xs text-accent">
                    Investment data requires additional authorization. Click "Re-link" to grant access.
                  </div>
                )}

                {/* Expandable accounts list */}
                {item.accounts?.length > 0 && (
                  <div className="mt-3">
                    <button
                      onClick={() => setExpandedItem(expandedItem === item.id ? null : item.id)}
                      className="text-xs text-secondary hover:text-accent transition-colors duration-150"
                    >
                      {expandedItem === item.id ? 'Hide' : 'Show'} accounts
                    </button>
                    {expandedItem === item.id && (
                      <div className="mt-2 space-y-1.5 animate-fade-in">
                        {item.accounts.map((acct) => (
                          <div key={acct.id} className="flex items-center gap-2 px-3 py-2 rounded-md bg-surface-2/50">
                            <Link2 size={12} className="text-tertiary flex-shrink-0" />
                            <span className="text-xs text-primary truncate">{acct.name}</span>
                            <span className="text-[10px] text-tertiary uppercase tracking-wider ml-auto flex-shrink-0">{acct.type}</span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Orphaned Accounts */}
      {orphanedAccounts.length > 0 && (
        <div className="animate-slide-up">
          <h2 className="text-lg font-bold text-primary mb-3">Empty Accounts</h2>
          <p className="text-xs text-secondary mb-3">
            These accounts are not linked to Plaid. Deleting removes the account and all its holdings.
          </p>
          <div className="card overflow-hidden">
            <div className="divide-y divide-border">
              {orphanedAccounts.map((acct) => (
                <div key={acct.id} className="flex items-center justify-between px-4 py-3">
                  <div className="min-w-0">
                    <span className="text-sm text-primary truncate block">{acct.name}</span>
                    {acct.holdings_count > 0 && (
                      <span className="text-xs text-secondary">{acct.holdings_count} holding{acct.holdings_count !== 1 ? 's' : ''}</span>
                    )}
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
                    className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium text-secondary hover:text-loss hover:bg-loss/10 transition-colors duration-200 min-h-[36px] touch-manipulation disabled:opacity-50 flex-shrink-0"
                  >
                    <Trash2 size={14} />
                    Delete
                  </button>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Disconnect Confirm Modal */}
      {disconnectingItem && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 animate-fade-in">
          <div className="bg-surface rounded-card border border-border shadow-xl max-w-md w-full mx-4 p-6 animate-slide-up">
            <h2 className="text-lg font-bold mb-2 text-primary">Disconnect Account</h2>
            <p className="text-sm text-secondary mb-4">
              Disconnect {disconnectingItem.institution_name || 'this account'}?
            </p>
            <div className="space-y-2 mb-6">
              <label className={`flex items-start gap-3 p-3 rounded-lg border cursor-pointer transition-colors duration-150 ${removeDataOnDisconnect ? 'border-accent/40 bg-accent/5' : 'border-border hover:border-border/80'}`}>
                <input
                  type="radio"
                  name="disconnect-mode"
                  checked={removeDataOnDisconnect}
                  onChange={() => setRemoveDataOnDisconnect(true)}
                  className="mt-0.5 accent-[var(--color-accent)]"
                />
                <div>
                  <span className="text-sm font-medium text-primary">Remove all data</span>
                  <p className="text-xs text-secondary mt-0.5">Delete linked accounts, holdings, and history.</p>
                </div>
              </label>
              <label className={`flex items-start gap-3 p-3 rounded-lg border cursor-pointer transition-colors duration-150 ${!removeDataOnDisconnect ? 'border-accent/40 bg-accent/5' : 'border-border hover:border-border/80'}`}>
                <input
                  type="radio"
                  name="disconnect-mode"
                  checked={!removeDataOnDisconnect}
                  onChange={() => setRemoveDataOnDisconnect(false)}
                  className="mt-0.5 accent-[var(--color-accent)]"
                />
                <div>
                  <span className="text-sm font-medium text-primary">Keep data</span>
                  <p className="text-xs text-secondary mt-0.5">Holdings become manual entries you can manage yourself.</p>
                </div>
              </label>
            </div>
            <div className="flex justify-end gap-2">
              <button
                onClick={() => setDisconnectingItem(null)}
                className="px-4 py-2 bg-surface-3 text-secondary hover:bg-surface-3/80 rounded-md transition-colors duration-200 min-h-[44px]"
              >
                Cancel
              </button>
              <button
                onClick={handleDisconnectConfirm}
                className="px-4 py-2 bg-loss text-inverse rounded-md hover:opacity-90 transition-opacity duration-200 min-h-[44px]"
              >
                Disconnect
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default Settings;

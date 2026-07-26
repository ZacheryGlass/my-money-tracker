import axios from 'axios';

// Same-origin by default: the Vite dev proxy forwards /api in development,
// and in production the backend serves the app and API from one origin.
// Auth is handled upstream by Azure Easy Auth (session cookie, no tokens).
const API_URL = import.meta.env.VITE_API_URL || '';

const api = axios.create({
  baseURL: API_URL,
  headers: {
    'Content-Type': 'application/json',
  },
});

// Handle auth errors and retry on 5xx / network errors (1 retry, 500ms backoff)
api.interceptors.response.use(
  (response) => response,
  async (error) => {
    const config = error.config;

    if (error.response?.status === 401) {
      // Easy Auth session expired; a full page load lets the platform
      // redirect through login and back.
      window.location.reload();
      return Promise.reject(error);
    }

    const isRetryable = !error.response || error.response.status >= 500;
    if (isRetryable && !config._retried) {
      config._retried = true;
      await new Promise((resolve) => setTimeout(resolve, 500));
      return api(config);
    }

    return Promise.reject(error);
  }
);

// Identity (display name for the sidebar)
export const me = async () => {
  const response = await api.get('/api/me');
  return response.data;
};

// Holdings API
export const holdings = {
  getAll: async () => {
    const response = await api.get('/api/holdings');
    return response.data;
  },
  getById: async (id) => {
    const response = await api.get(`/api/holdings/${id}`);
    return response.data;
  },
  create: async (data) => {
    const response = await api.post('/api/holdings', data);
    return response.data;
  },
  update: async (id, data) => {
    const response = await api.put(`/api/holdings/${id}`, data);
    return response.data;
  },
  delete: async (id) => {
    const response = await api.delete(`/api/holdings/${id}`);
    return response.data;
  },
  bulkImport: async (csvData) => {
    const response = await api.post('/api/holdings/bulk-import', csvData, {
      headers: {
        'Content-Type': 'text/csv',
      },
    });
    return response.data;
  },
  bulkImportConfirm: async (rows, skipDuplicates = false) => {
    const response = await api.post('/api/holdings/bulk-import/confirm', { rows, skipDuplicates });
    return response.data;
  },
};

// Accounts API
export const accounts = {
  getAll: async ({ includeHidden = false } = {}) => {
    const response = await api.get(`/api/accounts${includeHidden ? '?include_hidden=true' : ''}`);
    return response.data;
  },
  create: async (data) => {
    const response = await api.post('/api/accounts', data);
    return response.data;
  },
  updateDisplayName: async (id, displayName) => {
    const response = await api.patch(`/api/accounts/${id}/display-name`, { display_name: displayName });
    return response.data;
  },
  updateVisibility: async (id, isHidden) => {
    const response = await api.patch(`/api/accounts/${id}/visibility`, { is_hidden: isHidden });
    return response.data;
  },
  delete: async (id) => {
    const response = await api.delete(`/api/accounts/${id}`);
    return response.data;
  },
};

// Dashboard API
export const dashboard = {
  getPortfolio: async () => {
    const response = await api.get('/api/dashboard');
    return response.data;
  },
  refreshPrices: async () => {
    const response = await api.post('/api/jobs/trigger/price-update');
    return response.data;
  },
};

// History API
export const history = {
  getPortfolio: async (params = {}) => {
    const queryParams = new URLSearchParams();
    if (params.startDate) queryParams.append('startDate', params.startDate);
    if (params.endDate) queryParams.append('endDate', params.endDate);
    if (params.limit) queryParams.append('limit', params.limit);
    if (params.offset) queryParams.append('offset', params.offset);
    if (params.withCount === false) queryParams.append('withCount', 'false');

    const queryString = queryParams.toString();
    const url = `/api/history/portfolio${queryString ? `?${queryString}` : ''}`;
    const response = await api.get(url);
    return response.data;
  },
  getTickers: async (params = {}) => {
    const queryParams = new URLSearchParams();
    if (params.ticker) queryParams.append('ticker', params.ticker);
    if (params.account_id) queryParams.append('account_id', params.account_id);
    if (params.startDate) queryParams.append('startDate', params.startDate);
    if (params.endDate) queryParams.append('endDate', params.endDate);
    if (params.limit) queryParams.append('limit', params.limit);
    if (params.offset) queryParams.append('offset', params.offset);
    if (params.withCount === false) queryParams.append('withCount', 'false');

    const queryString = queryParams.toString();
    const url = `/api/history/tickers${queryString ? `?${queryString}` : ''}`;
    const response = await api.get(url);
    return response.data;
  },
  getAccounts: async (params = {}) => {
    const queryParams = new URLSearchParams();
    if (params.account_id) queryParams.append('account_id', params.account_id);
    if (params.startDate) queryParams.append('startDate', params.startDate);
    if (params.endDate) queryParams.append('endDate', params.endDate);
    if (params.limit) queryParams.append('limit', params.limit);
    if (params.offset) queryParams.append('offset', params.offset);
    if (params.withCount === false) queryParams.append('withCount', 'false');

    const queryString = queryParams.toString();
    const url = `/api/history/accounts${queryString ? `?${queryString}` : ''}`;
    const response = await api.get(url);
    return response.data;
  },
};

// Transactions API
export const transactions = {
  getAll: async (params = {}) => {
    const queryParams = new URLSearchParams();
    if (params.account_id) queryParams.append('account_id', params.account_id);
    if (params.startDate) queryParams.append('startDate', params.startDate);
    if (params.endDate) queryParams.append('endDate', params.endDate);
    if (params.sort) queryParams.append('sort', params.sort);
    if (params.direction) queryParams.append('direction', params.direction);
    if (params.view) queryParams.append('view', params.view);
    if (params.limit) queryParams.append('limit', params.limit);
    if (params.offset) queryParams.append('offset', params.offset);

    const queryString = queryParams.toString();
    const url = `/api/transactions${queryString ? `?${queryString}` : ''}`;
    const response = await api.get(url);
    return response.data;
  },
};

// Export API
export const exportData = {
  downloadHoldings: async () => {
    try {
      const response = await api.get('/api/export/holdings', {
        responseType: 'blob',
      });

      const url = window.URL.createObjectURL(new Blob([response.data]));
      const link = document.createElement('a');
      link.href = url;
      link.setAttribute('download', 'holdings.csv');
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.URL.revokeObjectURL(url);
    } catch (error) {
      console.error('Export error:', error);
      throw error;
    }
  },
  downloadHistory: async (type = 'tickers', format = 'csv') => {
    try {
      const response = await api.get(`/api/export/history?type=${type}&format=${format}`, {
        responseType: 'blob',
      });

      const url = window.URL.createObjectURL(new Blob([response.data]));
      const link = document.createElement('a');
      link.href = url;
      const filename = `${type}_history.${format}`;
      link.setAttribute('download', filename);
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.URL.revokeObjectURL(url);
    } catch (error) {
      console.error('Export error:', error);
      throw error;
    }
  },
};

// Salary History API
export const salary = {
  getAll: async () => {
    const response = await api.get('/api/salary');
    return response.data;
  },
  create: async (data) => {
    const response = await api.post('/api/salary', data);
    return response.data;
  },
  update: async (id, data) => {
    const response = await api.put(`/api/salary/${id}`, data);
    return response.data;
  },
  delete: async (id) => {
    const response = await api.delete(`/api/salary/${id}`);
    return response.data;
  },
};

// Recurring Expenses API
export const expenses = {
  getAll: async () => {
    const response = await api.get('/api/expenses');
    return response.data;
  },
  // scope is 'expenses' (Monthly Expenses list) or 'merchants' (Top Merchants
  // ranking) — each page has its own independent ignore list.
  getIgnored: async (scope) => {
    const response = await api.get('/api/expenses/ignored', { params: { scope } });
    return response.data;
  },
  getTransactions: async (id) => {
    const response = await api.get(`/api/expenses/${id}/transactions`);
    return response.data;
  },
  setTag: async (id, tag) => {
    const response = await api.patch(`/api/expenses/${id}/tag`, { tag });
    return response.data;
  },
  ignore: async (id) => {
    const response = await api.delete(`/api/expenses/${id}`);
    return response.data;
  },
  restoreIgnored: async (merchantKey, scope) => {
    const response = await api.delete('/api/expenses/ignored', { params: { key: merchantKey, scope } });
    return response.data;
  },
  // Top Merchants page. Merchant keys travel as query params (they can
  // contain '/'; see the restoreIgnored route comment).
  getMerchants: async (days) => {
    const response = await api.get('/api/expenses/merchants', { params: { days } });
    return response.data;
  },
  getMerchantTransactions: async (merchantKey, days) => {
    const response = await api.get('/api/expenses/merchants/transactions', { params: { key: merchantKey, days } });
    return response.data;
  },
  ignoreMerchant: async (merchantKey) => {
    const response = await api.post('/api/expenses/ignored', { key: merchantKey });
    return response.data;
  },
};

// Plaid API
export const plaid = {
  createLinkToken: async () => {
    const response = await api.post('/api/plaid/link-token');
    return response.data;
  },
  exchangeToken: async (publicToken, metadata) => {
    const response = await api.post('/api/plaid/exchange-token', { public_token: publicToken, metadata });
    return response.data;
  },
  getItems: async () => {
    const response = await api.get('/api/plaid/items');
    return response.data;
  },
  syncItem: async (id) => {
    const response = await api.post(`/api/plaid/items/${id}/sync`);
    return response.data;
  },
  createUpdateLinkToken: async (id) => {
    const response = await api.post(`/api/plaid/items/${id}/update-link-token`);
    return response.data;
  },
  removeItem: async (id, { removeData = false } = {}) => {
    const response = await api.delete(`/api/plaid/items/${id}${removeData ? '?removeData=true' : ''}`);
    return response.data;
  },
};

// Ethereum wallet API
export const eth = {
  addWallet: async (address, label) => {
    const response = await api.post('/api/eth/wallets', { address, label });
    return response.data;
  },
  getWallets: async () => {
    const response = await api.get('/api/eth/wallets');
    return response.data;
  },
  syncWallet: async (id) => {
    const response = await api.post(`/api/eth/wallets/${id}/sync`);
    return response.data;
  },
  removeWallet: async (id, { removeData = false } = {}) => {
    const response = await api.delete(`/api/eth/wallets/${id}${removeData ? '?removeData=true' : ''}`);
    return response.data;
  },
  // Omit walletId for the merged feed across every wallet.
  getTransfers: async ({ walletId, ...params } = {}) => {
    const response = await api.get('/api/eth/transfers', {
      params: { ...params, ...(walletId != null ? { wallet_id: walletId } : {}) },
    });
    return response.data;
  },
  getIgnoredTokens: async () => {
    const response = await api.get('/api/eth/ignored-tokens');
    return response.data;
  },
  ignoreToken: async (contractAddress, symbol, note) => {
    const response = await api.post('/api/eth/ignored-tokens', { contract_address: contractAddress, symbol, note });
    return response.data;
  },
  unignoreToken: async (contractAddress) => {
    const response = await api.delete(`/api/eth/ignored-tokens/${contractAddress}`);
    return response.data;
  },
  getAddressLabels: async () => {
    const response = await api.get('/api/eth/address-labels');
    return response.data;
  },
  // kind: 'exchange' (default) | 'external' | 'own'. A name is required only
  // for 'exchange', where it becomes the counterparty text in the ledger.
  labelAddress: async (address, name, { note, kind } = {}) => {
    const response = await api.post('/api/eth/address-labels', { address, name, note, kind });
    return response.data;
  },
  unlabelAddress: async (address) => {
    const response = await api.delete(`/api/eth/address-labels/${address}`);
    return response.data;
  },
  // The triage queue: addresses transacted with but never given a verdict.
  // Dust is fetched too and split client-side behind a disclosure -- the
  // attention badge reads summary.count, which stays material-only, so one
  // request serves both without a second round-trip when the user expands.
  getUnreviewedCounterparties: async () => {
    const response = await api.get('/api/eth/counterparties/unreviewed', { params: { include_dust: 'true' } });
    return response.data;
  },
  // The transaction-level feed. Overrides are resolved server-side, so a
  // corrected row reads and filters as the category the user chose.
  getActivity: async ({ walletId, ...params } = {}) => {
    const response = await api.get('/api/eth/activity', {
      params: { ...params, ...(walletId != null ? { wallet_id: walletId } : {}) },
    });
    return response.data;
  },
  // A manual correction. Stored apart from the derived table, so it survives
  // every resync and reclassification.
  setActivityOverride: async ({ walletId, txHash, chainId, category, note }) => {
    const response = await api.post('/api/eth/activity/override', {
      wallet_id: walletId, tx_hash: txHash, chain_id: chainId, category, note,
    });
    return response.data;
  },
  clearActivityOverride: async ({ walletId, txHash, chainId }) => {
    const response = await api.delete('/api/eth/activity/override', {
      params: { wallet_id: walletId, tx_hash: txHash, chain_id: chainId },
    });
    return response.data;
  },
  // The full balance audit: derived-from-transfers versus what the chain
  // reports, per (wallet, chain, asset). The wallets response already carries a
  // capped per-wallet summary, which is what the wallet card renders; this is
  // the unabridged list for a wallet whose summary says something is off.
  getReconciliation: async ({ walletId, status } = {}) => {
    const response = await api.get('/api/eth/reconciliation', {
      params: {
        ...(walletId != null ? { wallet_id: walletId } : {}),
        ...(status ? { status } : {}),
      },
    });
    return response.data;
  },
  // Assets the dated valuation could not price (#73). The ledger is this
  // enumeration's designated consumer: it shows USD per row, and a blank there
  // has to be explained as "no price for this asset" rather than read as $0.
  getUnpricedAssets: async () => {
    const response = await api.get('/api/eth/prices/unpriced');
    return response.data;
  },
};

// The unified crypto ledger (#63): on-chain activity and exchange records
// interleaved by time, with a matched pair rendered once.
export const crypto = {
  // filters: { category, source, needsReview, walletId, exchangeAccountId }.
  // An unknown category/source is a 400 server-side, so the client's filter
  // values come from utils/dataLabels LEDGER_CATEGORIES rather than free text.
  getLedger: async ({ needsReview, walletId, exchangeAccountId, ...params } = {}) => {
    const response = await api.get('/api/crypto/ledger', {
      params: {
        ...params,
        ...(needsReview != null ? { needs_review: String(needsReview) } : {}),
        ...(walletId != null ? { wallet_id: walletId } : {}),
        ...(exchangeAccountId != null ? { exchange_account_id: exchangeAccountId } : {}),
      },
    });
    return response.data;
  },
  // Unfiltered counts for the badge: a needs-review count that only saw the
  // rows currently on screen would read zero the moment they were filtered out.
  getLedgerSummary: async () => {
    const response = await api.get('/api/crypto/ledger/summary');
    return response.data;
  },
  // Built as a URL rather than fetched: the browser's own download handles the
  // Content-Disposition, and buffering an entire ledger through axios to
  // re-emit it as a Blob would only add a copy.
  ledgerExportUrl: (params = {}) => {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== null && value !== '') query.set(key, String(value));
    }
    const suffix = query.toString();
    return `${API_URL}/api/crypto/ledger/export${suffix ? `?${suffix}` : ''}`;
  },
};

// Exchange accounts and their CSV imports (Settings -> Exchanges). On-exchange
// activity never touches a tracked wallet, so it can only come from an export.
export const exchanges = {
  getAll: async () => {
    const response = await api.get('/api/exchanges');
    return response.data;
  },
  create: async (name, exchange) => {
    const response = await api.post('/api/exchanges', { name, exchange });
    return response.data;
  },
  update: async (id, payload) => {
    const response = await api.patch(`/api/exchanges/${id}`, payload);
    return response.data;
  },
  remove: async (id) => {
    const response = await api.delete(`/api/exchanges/${id}`);
    return response.data;
  },
  // Raw text/csv, matching the holdings bulk import. Re-uploading a fuller
  // export is safe: the server dedupes on the exchange's own row ids.
  importCsv: async (id, csvText, { format } = {}) => {
    const response = await api.post(`/api/exchanges/${id}/import`, csvText, {
      headers: { 'Content-Type': 'text/csv' },
      params: format ? { format } : undefined,
    });
    return response.data;
  },
  getRecords: async (id, params = {}) => {
    const response = await api.get(`/api/exchanges/${id}/records`, { params });
    return response.data;
  },
  // Clears needs_review on one record. Nothing else ever writes that flag to
  // false, so this is the only thing that can empty the review queue.
  resolveRecord: async (id, recordId) => {
    const response = await api.patch(`/api/exchanges/${id}/records/${recordId}/resolve`);
    return response.data;
  },
  // Derived pairings between an on-chain transfer and the venue's own record of
  // it (#61), with the counts behind the "how much is still unpaired" line.
  getMatches: async (params = {}) => {
    const response = await api.get('/api/exchanges/matches', { params });
    return response.data;
  },
  // Confirm or reject one pairing. A verdict names exactly ONE pair, in one of
  // 041's two shapes: wallet_id + tx_hash (+ chain_id) for an on-chain match,
  // or counter_record_id for a venue-to-venue one. Sending both, or neither, is
  // a 400 rather than a guess.
  setMatchVerdict: async ({ exchangeRecordId, walletId, txHash, chainId, counterRecordId, verdict, note }) => {
    const response = await api.post('/api/exchanges/matches/verdict', {
      exchange_record_id: exchangeRecordId,
      ...(counterRecordId != null
        ? { counter_record_id: counterRecordId }
        : { wallet_id: walletId, tx_hash: txHash, chain_id: chainId }),
      verdict,
      note,
    });
    return response.data;
  },
  clearMatchVerdict: async ({ exchangeRecordId, walletId, txHash, chainId, counterRecordId }) => {
    const response = await api.delete('/api/exchanges/matches/verdict', {
      params: {
        exchange_record_id: exchangeRecordId,
        ...(counterRecordId != null
          ? { counter_record_id: counterRecordId }
          : { wallet_id: walletId, tx_hash: txHash, chain_id: chainId }),
      },
    });
    return response.data;
  },
  // Read-only API credentials for one exchange account. The server stores them
  // encrypted and answers with a masked status; a plaintext key never comes
  // back out, so the form always starts empty rather than pre-filled.
  setCredentials: async (id, apiKey, apiSecret) => {
    const response = await api.put(`/api/exchanges/${id}/credentials`, {
      api_key: apiKey,
      api_secret: apiSecret,
    });
    return response.data;
  },
  // Disconnecting keeps every record already imported.
  clearCredentials: async (id) => {
    const response = await api.delete(`/api/exchanges/${id}/credentials`);
    return response.data;
  },
  // One authenticated read and nothing else, so "the key is stored" and "the
  // key works" are separable events.
  testConnection: async (id) => {
    const response = await api.post(`/api/exchanges/${id}/test`);
    return response.data;
  },
  sync: async (id) => {
    const response = await api.post(`/api/exchanges/${id}/sync`);
    return response.data;
  },
};

// API key management (Settings -> API Keys). Responses carry masked
// statuses only; plaintext secrets never round-trip to the client.
export const keys = {
  getAll: async () => {
    const response = await api.get('/api/keys');
    return response.data;
  },
  set: async (service, value) => {
    const response = await api.put(`/api/keys/${service}`, { value });
    return response.data;
  },
  clear: async (service) => {
    const response = await api.delete(`/api/keys/${service}`);
    return response.data;
  },
};

// Admin panel (Settings -> Server tab; admin only, 403 otherwise)
export const admin = {
  getOverview: async () => {
    const response = await api.get('/api/admin/overview');
    return response.data;
  },
  triggerJob: async (name) => {
    const response = await api.post(`/api/jobs/trigger/${name}`);
    return response.data;
  },
};

// Analytics API
export const analytics = {
  getBenchmarkHistory: async (params = {}) => {
    const queryParams = new URLSearchParams();
    if (params.symbol) queryParams.append('symbol', params.symbol);
    if (params.startDate) queryParams.append('startDate', params.startDate);
    if (params.endDate) queryParams.append('endDate', params.endDate);
    const queryString = queryParams.toString();
    const url = `/api/analytics/benchmark-history${queryString ? `?${queryString}` : ''}`;
    const response = await api.get(url);
    return response.data;
  },
};

export default api;

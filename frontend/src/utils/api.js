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

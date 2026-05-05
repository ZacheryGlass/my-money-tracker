import axios from 'axios';

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:3000';

const api = axios.create({
  baseURL: API_URL,
  headers: {
    'Content-Type': 'application/json',
  },
});

// Add token to requests
api.interceptors.request.use((config) => {
  const token = localStorage.getItem('token');
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

// Handle auth errors and retry on 5xx / network errors (1 retry, 500ms backoff)
api.interceptors.response.use(
  (response) => response,
  async (error) => {
    const config = error.config;

    if (error.response?.status === 401) {
      localStorage.removeItem('token');
      // Don't redirect when the login call itself fails — let the form display the error.
      // For other 401s (e.g. expired token), reload to '/' so AuthContext re-initializes.
      const isLoginCall = error.config?.url?.includes('/api/auth/login');
      if (!isLoginCall) {
        window.location.href = '/';
      }
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

// Auth API
export const auth = {
  login: async (username, password) => {
    const response = await api.post('/api/auth/login', { username, password });
    return response.data;
  },
  me: async () => {
    const response = await api.get('/api/auth/me');
    return response.data;
  },
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

// Accounts API (for dropdowns)
export const accounts = {
  getAll: async () => {
    const response = await api.get('/api/accounts');
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
  getAll: async (type) => {
    const url = type ? `/api/expenses?type=${type}` : '/api/expenses';
    const response = await api.get(url);
    return response.data;
  },
  getSummary: async () => {
    const response = await api.get('/api/expenses/summary');
    return response.data;
  },
  create: async (data) => {
    const response = await api.post('/api/expenses', data);
    return response.data;
  },
  update: async (id, data) => {
    const response = await api.put(`/api/expenses/${id}`, data);
    return response.data;
  },
  delete: async (id) => {
    const response = await api.delete(`/api/expenses/${id}`);
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
  removeItem: async (id) => {
    const response = await api.delete(`/api/plaid/items/${id}`);
    return response.data;
  },
};

export default api;

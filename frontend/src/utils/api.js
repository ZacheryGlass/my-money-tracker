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

// Handle auth errors
api.interceptors.response.use(
  (response) => response,
  (error) => {
    if (error.response?.status === 401) {
      localStorage.removeItem('token');
      window.location.href = '/login';
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
};

// Accounts API (for dropdowns)
export const accounts = {
  getAll: async () => {
    const response = await api.get('/api/accounts');
    return response.data;
  },
};

export default api;

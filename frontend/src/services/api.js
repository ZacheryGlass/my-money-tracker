import axios from 'axios';

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:3000';

const api = axios.create({
  baseURL: API_URL,
  headers: {
    'Content-Type': 'application/json',
  },
});

// Add token to requests if available
api.interceptors.request.use(
  (config) => {
    const token = localStorage.getItem('token');
    if (token) {
      config.headers.Authorization = `Bearer ${token}`;
    }
    return config;
  },
  (error) => {
    return Promise.reject(error);
  }
);

// Handle 401 errors (unauthorized)
api.interceptors.response.use(
  (response) => response,
  (error) => {
    if (error.response?.status === 401) {
      localStorage.removeItem('token');
      localStorage.removeItem('user');
      window.location.href = '/login';
    }
    return Promise.reject(error);
  }
);

// Auth endpoints
export const authAPI = {
  login: (username, password) => 
    api.post('/api/auth/login', { username, password }),
  getMe: () => 
    api.get('/api/auth/me'),
};

// Dashboard endpoints
export const dashboardAPI = {
  getPortfolio: () => 
    api.get('/api/dashboard'),
};

// Holdings endpoints
export const holdingsAPI = {
  getAll: () => 
    api.get('/api/holdings'),
  getById: (id) => 
    api.get(`/api/holdings/${id}`),
  create: (holding) => 
    api.post('/api/holdings', holding),
  update: (id, holding) => 
    api.put(`/api/holdings/${id}`, holding),
  delete: (id) => 
    api.delete(`/api/holdings/${id}`),
};

export default api;

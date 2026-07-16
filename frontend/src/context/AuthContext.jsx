import React, { createContext, useContext, useState, useEffect } from 'react';
import { auth as authAPI } from '../utils/api';

const AuthContext = createContext(null);
const developmentAuthBypassEnabled = import.meta.env.MODE === 'development'
  && import.meta.env.VITE_DEV_BYPASS_AUTH === 'true';

const storage = {
  getToken: () => {
    try {
      return globalThis.localStorage?.getItem('token') || null;
    } catch {
      return null;
    }
  },
  setToken: (token) => {
    try {
      globalThis.localStorage?.setItem('token', token);
    } catch {
      /* Ignore storage failures so auth still works in restricted browsers/tests. */
    }
  },
  removeToken: () => {
    try {
      globalThis.localStorage?.removeItem('token');
    } catch {
      /* Ignore storage failures so logout can still clear React state. */
    }
  },
};

export const AuthProvider = ({ children }) => {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const initAuth = async () => {
      const token = storage.getToken();
      if (token || developmentAuthBypassEnabled) {
        try {
          const userData = await authAPI.me();
          setUser(userData.user);
        } catch (error) {
          console.error('Auth init failed:', error);
          storage.removeToken();
        }
      }
      setLoading(false);
    };

    initAuth();
  }, []);

  const login = async (username, password) => {
    const data = await authAPI.login(username, password);
    storage.setToken(data.token);
    setUser(data.user);
    return data;
  };

  const logout = () => {
    if (developmentAuthBypassEnabled) return;
    storage.removeToken();
    setUser(null);
  };

  return (
    <AuthContext.Provider value={{ user, loading, login, logout }}>
      {children}
    </AuthContext.Provider>
  );
};

export const useAuth = () => {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within AuthProvider');
  }
  return context;
};

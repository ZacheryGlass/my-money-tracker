import React, { useState } from 'react';
import { useAuth } from '../context/AuthContext';

const Login = () => {
  const { login } = useAuth();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [isLoading, setIsLoading] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    setIsLoading(true);

    try {
      await login(username, password);
    } catch (err) {
      console.error('Login error:', err);
      setError(err.response?.data?.error || 'Login failed. Please check your credentials.');
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-base px-4" style={{ background: 'radial-gradient(ellipse at 50% 30%, rgba(0, 212, 170, 0.06) 0%, var(--bg-base) 70%)' }}>
      <div className="card p-6 md:p-8 w-full max-w-md animate-fade-in">
        <h1 className="text-2xl md:text-3xl font-bold mb-1 text-center text-primary">
          My Money Tracker
        </h1>
        <p className="text-sm text-secondary text-center mb-6">Sign in to your portfolio</p>

        <form onSubmit={handleSubmit}>
          <div className="mb-4">
            <label className="block text-sm font-medium text-secondary mb-1">
              Username
            </label>
            <input
              type="text"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              className="w-full px-3 py-2 rounded-md border border-input-border min-h-[44px] touch-manipulation"
              required
              disabled={isLoading}
            />
          </div>

          <div className="mb-6">
            <label className="block text-sm font-medium text-secondary mb-1">
              Password
            </label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full px-3 py-2 rounded-md border border-input-border min-h-[44px] touch-manipulation"
              required
              disabled={isLoading}
            />
          </div>

          {error && (
            <div className="mb-4 bg-loss-bg text-loss border border-loss/20 rounded-lg p-3 text-sm">
              {error}
            </div>
          )}

          <button
            type="submit"
            disabled={isLoading}
            className="w-full px-4 py-2 bg-accent text-inverse font-medium rounded-md hover:bg-accent-hover disabled:opacity-50 disabled:cursor-not-allowed min-h-[44px] touch-manipulation transition-colors"
            style={{ boxShadow: '0 0 20px rgba(0,212,170,0.15)' }}
          >
            {isLoading ? 'Logging in...' : 'Login'}
          </button>
        </form>

        {import.meta.env.DEV && (
          <p className="mt-4 text-xs text-tertiary text-center">
            Default credentials: zachery / changeme123
          </p>
        )}
      </div>
    </div>
  );
};

export default Login;

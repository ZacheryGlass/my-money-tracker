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
    <div className="min-h-screen flex items-center justify-center bg-base px-4">
      <div className="card p-6 w-full max-w-sm">
        <h1 className="text-display-md mb-1 text-center text-primary">
          My Money Tracker
        </h1>
        <p className="text-body-sm text-tertiary text-center mb-6">Sign in to your portfolio</p>

        <form onSubmit={handleSubmit}>
          <div className="mb-3">
            <label className="block text-body-sm font-semibold text-secondary mb-1">
              Username
            </label>
            <input
              type="text"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              className="w-full px-2 py-1.5 border border-input-border"
              required
              disabled={isLoading}
            />
          </div>

          <div className="mb-4">
            <label className="block text-body-sm font-semibold text-secondary mb-1">
              Password
            </label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full px-2 py-1.5 border border-input-border"
              required
              disabled={isLoading}
            />
          </div>

          {error && (
            <div className="mb-3 bg-loss-bg text-loss border border-loss/20 p-2 text-body-sm">
              {error}
            </div>
          )}

          <button
            type="submit"
            disabled={isLoading}
            className="w-full px-3 py-1.5 bg-accent text-white font-semibold rounded hover:bg-accent-hover disabled:opacity-50 disabled:cursor-not-allowed transition-colors text-button"
          >
            {isLoading ? 'Logging in...' : 'Login'}
          </button>
        </form>

        {import.meta.env.DEV && (
          <p className="mt-3 text-caption text-tertiary text-center">
            Default credentials: zachery / password
          </p>
        )}
      </div>
    </div>
  );
};

export default Login;

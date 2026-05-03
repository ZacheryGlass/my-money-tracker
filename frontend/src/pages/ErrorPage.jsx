import React from 'react';

const ErrorPage = ({ error, onReset }) => {
  return (
    <div className="min-h-screen bg-base flex items-center justify-center px-4">
      <div className="card p-8 max-w-md w-full text-center">
        <h1 className="text-2xl font-bold text-primary mb-2">Something went wrong</h1>
        {error && (
          <p className="text-sm text-secondary mb-6 font-mono bg-surface-2 rounded-lg p-3 text-left break-all">
            {error.message || String(error)}
          </p>
        )}
        <button
          onClick={onReset || (() => window.location.reload())}
          className="px-4 py-2 bg-accent text-inverse rounded-md hover:bg-accent-hover transition-colors"
        >
          Reload
        </button>
      </div>
    </div>
  );
};

export default ErrorPage;

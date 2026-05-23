import React from 'react';

const ErrorPage = ({ error, onReset }) => {
  return (
    <div className="min-h-screen bg-base flex items-center justify-center px-4">
      <div className="card p-6 max-w-md w-full text-center">
        <h1 className="text-display-md text-primary mb-2">Something went wrong</h1>
        {error && (
          <p className="text-body-sm text-secondary mb-4 font-mono bg-surface-3 p-2 text-left break-all">
            {error.message || String(error)}
          </p>
        )}
        <button
          onClick={onReset || (() => window.location.reload())}
          className="px-3 py-1.5 bg-accent text-white rounded text-button hover:bg-accent-hover transition-colors"
        >
          Reload
        </button>
      </div>
    </div>
  );
};

export default ErrorPage;

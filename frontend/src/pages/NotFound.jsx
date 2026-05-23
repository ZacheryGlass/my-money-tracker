import React from 'react';

const NotFound = () => {
  return (
    <div className="min-h-screen bg-base flex items-center justify-center px-4">
      <div className="card p-6 max-w-md w-full text-center">
        <h1 className="text-display-mega font-mono text-surface-3 mb-2">404</h1>
        <h2 className="text-display-sm text-primary mb-1">Page not found</h2>
        <p className="text-body-sm text-tertiary mb-4">The page you're looking for doesn't exist.</p>
        <button
          onClick={() => window.location.assign('/')}
          className="px-3 py-1.5 bg-accent text-white rounded text-button hover:bg-accent-hover transition-colors"
        >
          Go home
        </button>
      </div>
    </div>
  );
};

export default NotFound;

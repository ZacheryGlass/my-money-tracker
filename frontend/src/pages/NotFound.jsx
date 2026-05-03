import React from 'react';

const NotFound = () => {
  return (
    <div className="min-h-screen bg-base flex items-center justify-center px-4">
      <div className="card p-8 max-w-md w-full text-center">
        <h1 className="text-7xl font-bold text-surface-3 mb-4 font-mono">404</h1>
        <h2 className="text-xl font-bold text-primary mb-2">Page not found</h2>
        <p className="text-secondary text-sm mb-6">The page you're looking for doesn't exist.</p>
        <button
          onClick={() => window.location.assign('/')}
          className="px-4 py-2 bg-accent text-inverse rounded-md hover:bg-accent-hover transition-colors"
        >
          Go home
        </button>
      </div>
    </div>
  );
};

export default NotFound;

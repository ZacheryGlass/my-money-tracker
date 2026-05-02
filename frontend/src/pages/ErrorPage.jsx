import React from 'react';

const ErrorPage = ({ error, onReset }) => {
  return (
    <div className="min-h-screen bg-gray-50 flex items-center justify-center px-4">
      <div className="bg-white shadow-md rounded-lg p-8 max-w-md w-full text-center">
        <h1 className="text-2xl font-bold text-gray-900 mb-2">Something went wrong</h1>
        {error && (
          <p className="text-sm text-gray-500 mb-6 font-mono bg-gray-50 rounded p-2 text-left break-all">
            {error.message || String(error)}
          </p>
        )}
        <button
          onClick={onReset || (() => window.location.reload())}
          className="px-4 py-2 text-white bg-blue-600 rounded-md hover:bg-blue-700"
        >
          Reload
        </button>
      </div>
    </div>
  );
};

export default ErrorPage;

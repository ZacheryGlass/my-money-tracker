import React from 'react';

// Shared loading indicator. `className` sizes the container (defaults to the
// standard page-level height); pass a falsy `label` for a spinner-only state.
const LoadingState = ({ label = 'Loading', className = 'min-h-[400px]' }) => (
  <div className={`flex flex-col items-center justify-center gap-3 ${className}`}>
    <div className="h-6 w-6 animate-spin rounded-full border-2 border-accent border-t-transparent" />
    {label && <span className="text-caption font-semibold uppercase tracking-wide text-tertiary">{label}</span>}
  </div>
);

export default LoadingState;

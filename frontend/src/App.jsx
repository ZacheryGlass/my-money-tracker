import React, { useState, lazy, Suspense } from 'react';
import { useAuth } from './context/AuthContext';
import Login from './components/Login';
import ErrorBoundary from './components/ErrorBoundary';
import NotFound from './pages/NotFound';
import Sidebar, { HamburgerIcon } from './components/Sidebar';

const Dashboard = lazy(() => import('./components/Dashboard'));
const HoldingsTable = lazy(() => import('./components/HoldingsTable'));
const TickerHistory = lazy(() => import('./pages/TickerHistory'));
const AccountHistory = lazy(() => import('./pages/AccountHistory'));
const PortfolioTimeline = lazy(() => import('./pages/PortfolioTimeline'));
const StaticAssets = lazy(() => import('./pages/StaticAssets'));

const PageSpinner = () => (
  <div className="flex items-center justify-center min-h-[400px] bg-base">
    <div className="w-8 h-8 border-4 border-accent border-t-transparent rounded-full animate-spin" />
  </div>
);

const VALID_PAGES = ['dashboard', 'holdings', 'static-assets', 'ticker-history', 'account-history', 'portfolio-timeline'];

const navItems = [
  { id: 'dashboard', label: 'Dashboard' },
  { id: 'holdings', label: 'Holdings' },
  { id: 'static-assets', label: 'Static Assets' },
  { id: 'ticker-history', label: 'Ticker History' },
  { id: 'account-history', label: 'Account History' },
  { id: 'portfolio-timeline', label: 'Portfolio Timeline' },
];

function App() {
  const { user, loading, logout } = useAuth();
  const [currentPage, setCurrentPage] = useState('dashboard');
  const [mobileOpen, setMobileOpen] = useState(false);

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-base">
        <div className="text-sm text-secondary">Loading...</div>
      </div>
    );
  }

  if (!user) {
    return <Login />;
  }

  const renderPage = () => {
    if (!VALID_PAGES.includes(currentPage)) {
      return <NotFound />;
    }
    return (
      <>
        {currentPage === 'dashboard' && <Dashboard />}
        {currentPage === 'holdings' && <HoldingsTable />}
        {currentPage === 'static-assets' && <StaticAssets />}
        {currentPage === 'ticker-history' && <TickerHistory />}
        {currentPage === 'account-history' && <AccountHistory />}
        {currentPage === 'portfolio-timeline' && <PortfolioTimeline />}
      </>
    );
  };

  return (
    <div className="flex min-h-screen bg-base">
      <Sidebar
        currentPage={currentPage}
        onNavigate={setCurrentPage}
        user={user}
        onLogout={logout}
        mobileOpen={mobileOpen}
        onMobileClose={() => setMobileOpen(false)}
      />
      <div className="flex-1 flex flex-col min-w-0 overflow-x-hidden">
        <div className="lg:hidden flex items-center h-12 px-4 bg-surface-2 border-b border-border sticky top-0 z-10">
          <button
            onClick={() => setMobileOpen(true)}
            className="text-secondary hover:text-primary transition-colors"
            aria-label="Open menu"
          >
            <HamburgerIcon />
          </button>
          <span className="ml-3 text-sm font-medium text-primary">
            {navItems.find((n) => n.id === currentPage)?.label}
          </span>
        </div>
        <main className="flex-1 overflow-y-auto">
          <ErrorBoundary>
            <Suspense fallback={<PageSpinner />}>
              {renderPage()}
            </Suspense>
          </ErrorBoundary>
        </main>
      </div>
    </div>
  );
}

export default App;

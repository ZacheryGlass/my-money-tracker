import React, { useState, useEffect, Suspense } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { AnimatePresence } from 'framer-motion';
import { me } from './utils/api';
import lazyWithReload from './utils/lazyWithReload';
import ErrorBoundary from './components/ErrorBoundary';
import NotFound from './pages/NotFound';
import Sidebar from './components/Sidebar';
import LoadingState from './components/LoadingState';
import { Menu } from 'lucide-react';

const Dashboard = lazyWithReload(() => import('./components/Dashboard'));
const BalancesPage = lazyWithReload(() => import('./pages/BalancesPage'));
const AccountsPage = lazyWithReload(() => import('./pages/AccountsPage'));
const TickerHistory = lazyWithReload(() => import('./pages/TickerHistory'));
const AccountHistory = lazyWithReload(() => import('./pages/AccountHistory'));
const PortfolioTimeline = lazyWithReload(() => import('./pages/PortfolioTimeline'));
const SalaryHistory = lazyWithReload(() => import('./pages/SalaryHistory'));
const MonthlyExpenses = lazyWithReload(() => import('./pages/MonthlyExpenses'));
const Settings = lazyWithReload(() => import('./pages/Settings'));
const HoldingsAnalysis = lazyWithReload(() => import('./pages/HoldingsAnalysis'));
const Spending = lazyWithReload(() => import('./pages/Spending'));
const TopMerchants = lazyWithReload(() => import('./pages/TopMerchants'));

const navItems = [
  { id: 'dashboard', label: 'Dashboard', path: '/' },
  { id: 'assets', label: 'Assets', path: '/assets' },
  { id: 'cash', label: 'Cash', path: '/cash' },
  { id: 'liabilities', label: 'Liabilities', path: '/liabilities' },
  { id: 'accounts', label: 'Accounts', path: '/accounts' },
  { id: 'ticker-history', label: 'Ticker History', path: '/ticker-history' },
  { id: 'account-history', label: 'Account History', path: '/account-history' },
  { id: 'portfolio-timeline', label: 'Portfolio Timeline', path: '/portfolio-timeline' },
  { id: 'holdings-analysis', label: 'Holdings Analysis', path: '/holdings-analysis' },
  { id: 'spending', label: 'Spending', path: '/spending' },
  { id: 'top-merchants', label: 'Top Merchants', path: '/top-merchants' },
  { id: 'salary-history', label: 'Salary History', path: '/salary-history' },
  { id: 'monthly-expenses', label: 'Monthly Expenses', path: '/monthly-expenses' },
  { id: 'settings', label: 'Settings', path: '/settings' },
];

const pagePaths = Object.fromEntries(navItems.map((item) => [item.id, item.path]));
const pagesByPath = Object.fromEntries(navItems.map((item) => [item.path, item.id]));

// Assets, Cash and Liabilities are tabs of the combined Balances page; the
// sidebar shows a single "Balances" entry that lands on the assets tab.
const BALANCES_TABS = new Set(['assets', 'cash', 'liabilities']);
pagePaths.balances = pagePaths.assets;

function normalizePath(pathname) {
  return pathname.replace(/\/+$/, '') || '/';
}

function App() {
  // Login happens upstream (Azure Easy Auth); by the time this app loads the
  // user is already authenticated. /api/me only supplies the display name.
  const [user, setUser] = useState(null);
  const location = useLocation();
  const navigate = useNavigate();
  const [mobileOpen, setMobileOpen] = useState(false);
  const currentPage = pagesByPath[normalizePath(location.pathname)] || null;

  useEffect(() => {
    me()
      .then((data) => setUser(data.user))
      .catch(() => setUser(null));
  }, []);

  const handleNavigate = (page, state) => {
    const path = pagePaths[page];
    if (path) {
      navigate(path, state ? { state } : undefined);
    }
  };

  const handleLogout = () => {
    // Easy Auth session logout; no-op in dev where there is no login.
    if (import.meta.env.DEV) return;
    window.location.href = '/.auth/logout?post_logout_redirect_uri=/';
  };

  const renderPage = () => {
    if (!currentPage) {
      return <NotFound />;
    }
    return (
      <div key={BALANCES_TABS.has(currentPage) ? 'balances' : currentPage} className="w-full">
        {currentPage === 'dashboard' && <Dashboard onNavigate={handleNavigate} />}
        {BALANCES_TABS.has(currentPage) && <BalancesPage tab={currentPage} onTabChange={handleNavigate} />}
        {currentPage === 'accounts' && <AccountsPage />}
        {currentPage === 'ticker-history' && <TickerHistory />}
        {currentPage === 'account-history' && <AccountHistory />}
        {currentPage === 'portfolio-timeline' && <PortfolioTimeline />}
        {currentPage === 'holdings-analysis' && <HoldingsAnalysis />}
        {currentPage === 'spending' && <Spending />}
        {currentPage === 'top-merchants' && <TopMerchants />}
        {currentPage === 'salary-history' && <SalaryHistory />}
        {currentPage === 'monthly-expenses' && <MonthlyExpenses />}
        {currentPage === 'settings' && <Settings />}
      </div>
    );
  };

  return (
    <div className="flex min-h-screen bg-base font-sans">
      <Sidebar
        currentPage={BALANCES_TABS.has(currentPage) ? 'balances' : currentPage}
        onNavigate={handleNavigate}
        user={user}
        onLogout={handleLogout}
        mobileOpen={mobileOpen}
        onMobileClose={() => setMobileOpen(false)}
      />
      <div className="flex min-w-0 flex-1 flex-col overflow-x-hidden">
        {/* Mobile Header */}
        <div className="sticky top-0 z-30 flex h-12 items-center border-b border-border bg-surface px-2 lg:hidden">
          <button
            onClick={() => setMobileOpen(true)}
            className="flex h-11 w-11 items-center justify-center text-secondary transition-colors hover:bg-surface-2 hover:text-primary"
            aria-label="Open menu"
            aria-expanded={mobileOpen}
          >
            <Menu size={20} />
          </button>
          <span className="ml-1 min-w-0 truncate text-body-sm font-semibold text-primary">
            {navItems.find((n) => n.id === currentPage)?.label || 'Not Found'}
          </span>
        </div>

        <main className="relative min-w-0 flex-1 bg-base pb-[env(safe-area-inset-bottom)]">
          <ErrorBoundary>
            <Suspense fallback={<LoadingState />}>
              {renderPage()}
            </Suspense>
          </ErrorBoundary>
        </main>

      </div>
    </div>
  );
}

export default App;

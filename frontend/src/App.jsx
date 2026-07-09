import React, { useState, lazy, Suspense } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { AnimatePresence } from 'framer-motion';
import { useAuth } from './context/AuthContext';
import Login from './components/Login';
import ErrorBoundary from './components/ErrorBoundary';
import NotFound from './pages/NotFound';
import Sidebar from './components/Sidebar';
import { Menu } from 'lucide-react';

const Dashboard = lazy(() => import('./components/Dashboard'));
const HoldingsTable = lazy(() => import('./components/HoldingsTable'));
const CashPage = lazy(() => import('./pages/CashPage'));
const LiabilitiesPage = lazy(() => import('./pages/LiabilitiesPage'));
const AccountsPage = lazy(() => import('./pages/AccountsPage'));
const TickerHistory = lazy(() => import('./pages/TickerHistory'));
const AccountHistory = lazy(() => import('./pages/AccountHistory'));
const PortfolioTimeline = lazy(() => import('./pages/PortfolioTimeline'));
const SalaryHistory = lazy(() => import('./pages/SalaryHistory'));
const MonthlyExpenses = lazy(() => import('./pages/MonthlyExpenses'));
const Settings = lazy(() => import('./pages/Settings'));
const HoldingsAnalysis = lazy(() => import('./pages/HoldingsAnalysis'));
const SpendingAnalytics = lazy(() => import('./pages/SpendingAnalytics'));
const SpendingExplorer = lazy(() => import('./pages/SpendingExplorer'));
const YearInReview = lazy(() => import('./pages/YearInReview'));

const PageSpinner = () => (
  <div className="flex flex-col items-center justify-center min-h-[400px] gap-3">
    <div className="w-6 h-6 border-2 border-accent border-t-transparent rounded-full animate-spin" />
    <span className="text-caption text-tertiary">Loading...</span>
  </div>
);

const navItems = [
  { id: 'dashboard', label: 'Dashboard', path: '/' },
  { id: 'assets', label: 'Assets', path: '/assets' },
  { id: 'cash', label: 'Cash', path: '/cash' },
  { id: 'liabilities', label: 'Liabilities', path: '/liabilities' },
  { id: 'accounts', label: 'Accounts', path: '/accounts' },
  { id: 'ticker-history', label: 'Ticker History', path: '/ticker-history' },
  { id: 'account-history', label: 'Account History', path: '/account-history' },
  { id: 'portfolio-timeline', label: 'Portfolio Timeline', path: '/portfolio-timeline' },
  { id: 'holdings-analysis', label: 'Holdings Analysis', section: 'ANALYTICS', path: '/holdings-analysis' },
  { id: 'spending-analytics', label: 'Spending', path: '/spending' },
  { id: 'spending-explorer', label: 'Spending Explorer', path: '/spending-explorer' },
  { id: 'year-in-review', label: 'Year in Review', path: '/year-in-review' },
  { id: 'salary-history', label: 'Salary History', section: 'PLANNING', path: '/salary-history' },
  { id: 'monthly-expenses', label: 'Monthly Expenses', path: '/monthly-expenses' },
  { id: 'settings', label: 'Settings', path: '/settings' },
];

const pagePaths = Object.fromEntries(navItems.map((item) => [item.id, item.path]));
const pagesByPath = Object.fromEntries(navItems.map((item) => [item.path, item.id]));

function normalizePath(pathname) {
  return pathname.replace(/\/+$/, '') || '/';
}

function App() {
  const { user, loading, logout } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();
  const [mobileOpen, setMobileOpen] = useState(false);
  const currentPage = pagesByPath[normalizePath(location.pathname)] || null;

  const handleNavigate = (page) => {
    const path = pagePaths[page];
    if (path) {
      navigate(path);
    }
  };

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-base">
        <div className="flex flex-col items-center gap-3">
          <div className="w-6 h-6 border-2 border-accent border-t-transparent rounded-full animate-spin" />
          <div className="text-caption text-tertiary">Authenticating</div>
        </div>
      </div>
    );
  }

  if (!user) {
    return <Login />;
  }

  const renderPage = () => {
    if (!currentPage) {
      return <NotFound />;
    }
    return (
      <div key={currentPage} className="w-full">
        {currentPage === 'dashboard' && <Dashboard onNavigate={handleNavigate} />}
        {currentPage === 'assets' && <HoldingsTable pageFilter="assets" />}
        {currentPage === 'cash' && <CashPage />}
        {currentPage === 'liabilities' && <LiabilitiesPage />}
        {currentPage === 'accounts' && <AccountsPage />}
        {currentPage === 'ticker-history' && <TickerHistory />}
        {currentPage === 'account-history' && <AccountHistory />}
        {currentPage === 'portfolio-timeline' && <PortfolioTimeline />}
        {currentPage === 'holdings-analysis' && <HoldingsAnalysis />}
        {currentPage === 'spending-analytics' && <SpendingAnalytics />}
        {currentPage === 'spending-explorer' && <SpendingExplorer />}
        {currentPage === 'year-in-review' && <YearInReview />}
        {currentPage === 'salary-history' && <SalaryHistory />}
        {currentPage === 'monthly-expenses' && <MonthlyExpenses />}
        {currentPage === 'settings' && <Settings />}
      </div>
    );
  };

  return (
    <div className="flex min-h-screen bg-base font-sans">
      <Sidebar
        currentPage={currentPage}
        onNavigate={handleNavigate}
        user={user}
        onLogout={logout}
        mobileOpen={mobileOpen}
        onMobileClose={() => setMobileOpen(false)}
      />
      <div className="flex-1 flex flex-col min-w-0 overflow-x-hidden">
        {/* Mobile Header */}
        <div className="lg:hidden flex items-center h-[35px] px-3 bg-surface border-b border-border sticky top-0 z-30">
          <button
            onClick={() => setMobileOpen(true)}
            className="w-7 h-7 flex items-center justify-center text-secondary hover:text-primary transition-colors"
            aria-label="Open menu"
          >
            <Menu size={16} />
          </button>
          <span className="ml-2 text-body-sm font-semibold text-primary">
            {navItems.find((n) => n.id === currentPage)?.label || 'Not Found'}
          </span>
        </div>

        <main className="flex-1 relative bg-base">
          <ErrorBoundary>
            <Suspense fallback={<PageSpinner />}>
              {renderPage()}
            </Suspense>
          </ErrorBoundary>
        </main>

        {/* Status Bar */}
        <div className="h-[22px] bg-surface border-t border-border flex items-center px-3 text-body-sm text-tertiary flex-shrink-0">
          <span>My Money Tracker</span>
        </div>
      </div>
    </div>
  );
}

export default App;

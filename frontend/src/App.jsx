import React, { useState, lazy, Suspense } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { useAuth } from './context/AuthContext';
import Login from './components/Login';
import ErrorBoundary from './components/ErrorBoundary';
import NotFound from './pages/NotFound';
import Sidebar from './components/Sidebar';
import { Menu } from 'lucide-react';

const Dashboard = lazy(() => import('./components/Dashboard'));
const HoldingsTable = lazy(() => import('./components/HoldingsTable'));
const TickerHistory = lazy(() => import('./pages/TickerHistory'));
const AccountHistory = lazy(() => import('./pages/AccountHistory'));
const PortfolioTimeline = lazy(() => import('./pages/PortfolioTimeline'));
const StaticAssets = lazy(() => import('./pages/StaticAssets'));
const SalaryHistory = lazy(() => import('./pages/SalaryHistory'));
const MonthlyExpenses = lazy(() => import('./pages/MonthlyExpenses'));
const Settings = lazy(() => import('./pages/Settings'));

const PageSpinner = () => (
  <div className="flex flex-col items-center justify-center min-h-[400px] gap-4">
    <div className="w-10 h-10 border-4 border-accent border-t-transparent rounded-full animate-spin shadow-glow" />
    <span className="text-xs font-bold tracking-widest uppercase text-tertiary animate-pulse">Loading View</span>
  </div>
);

const VALID_PAGES = ['dashboard', 'holdings', 'static-assets', 'ticker-history', 'account-history', 'portfolio-timeline', 'salary-history', 'monthly-expenses', 'settings'];

const navItems = [
  { id: 'dashboard', label: 'Dashboard' },
  { id: 'holdings', label: 'Holdings' },
  { id: 'static-assets', label: 'Static Assets' },
  { id: 'ticker-history', label: 'Ticker History' },
  { id: 'account-history', label: 'Account History' },
  { id: 'portfolio-timeline', label: 'Portfolio Timeline' },
  { id: 'salary-history', label: 'Salary History', section: 'PLANNING' },
  { id: 'monthly-expenses', label: 'Monthly Expenses' },
];

function App() {
  const { user, loading, logout } = useAuth();
  const [currentPage, setCurrentPage] = useState('dashboard');
  const [mobileOpen, setMobileOpen] = useState(false);

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-base">
        <div className="flex flex-col items-center gap-4">
          <div className="w-12 h-12 border-4 border-accent border-t-transparent rounded-full animate-spin shadow-glow" />
          <div className="text-[10px] font-bold tracking-widest uppercase text-tertiary">Authenticating</div>
        </div>
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
      <motion.div
        key={currentPage}
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.3 }}
        className="w-full"
      >
        {currentPage === 'dashboard' && <Dashboard />}
        {currentPage === 'holdings' && <HoldingsTable />}
        {currentPage === 'static-assets' && <StaticAssets />}
        {currentPage === 'ticker-history' && <TickerHistory />}
        {currentPage === 'account-history' && <AccountHistory />}
        {currentPage === 'portfolio-timeline' && <PortfolioTimeline />}
        {currentPage === 'salary-history' && <SalaryHistory />}
        {currentPage === 'monthly-expenses' && <MonthlyExpenses />}
        {currentPage === 'settings' && <Settings />}
      </motion.div>
    );
  };

  return (
    <div className="flex min-h-screen bg-base font-sans selection:bg-accent/30">
      <Sidebar
        currentPage={currentPage}
        onNavigate={setCurrentPage}
        user={user}
        onLogout={logout}
        mobileOpen={mobileOpen}
        onMobileClose={() => setMobileOpen(false)}
      />
      <div className="flex-1 flex flex-col min-w-0 overflow-x-hidden">
        {/* Mobile Header */}
        <div className="lg:hidden flex items-center h-16 px-6 bg-surface border-b border-border sticky top-0 z-30">
          <button
            onClick={() => setMobileOpen(true)}
            className="w-10 h-10 flex items-center justify-center rounded-xl bg-surface-2 text-secondary hover:text-accent border border-border transition-all"
            aria-label="Open menu"
          >
            <Menu size={20} />
          </button>
          <span className="ml-4 text-sm font-bold tracking-tight text-primary">
            {navItems.find((n) => n.id === currentPage)?.label}
          </span>
        </div>

        <main className="flex-1 relative">
          <ErrorBoundary>
            <Suspense fallback={<PageSpinner />}>
              <AnimatePresence mode="wait">
                {renderPage()}
              </AnimatePresence>
            </Suspense>
          </ErrorBoundary>
        </main>
      </div>
    </div>
  );
}

export default App;

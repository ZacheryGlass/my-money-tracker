import React, { useState, useEffect, useCallback, useRef, Suspense } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { me, crypto as cryptoAPI, eth as ethAPI } from './utils/api';
import lazyWithReload from './utils/lazyWithReload';
import ErrorBoundary from './components/ErrorBoundary';
import NotFound from './pages/NotFound';
import Sidebar from './components/Sidebar';
import LoadingState from './components/LoadingState';
import { Menu } from 'lucide-react';

const Dashboard = lazyWithReload(() => import('./components/Dashboard'));
const BalancesPage = lazyWithReload(() => import('./pages/BalancesPage'));
const AccountsPage = lazyWithReload(() => import('./pages/AccountsPage'));
const CryptoPage = lazyWithReload(() => import('./pages/CryptoPage'));
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
  { id: 'crypto', label: 'Crypto Overview', path: '/crypto' },
  { id: 'crypto-holdings', label: 'Crypto Holdings', path: '/crypto/holdings' },
  { id: 'crypto-transactions', label: 'Crypto Activity', path: '/crypto/transactions' },
  { id: 'crypto-wallets', label: 'Crypto Wallets', path: '/crypto/wallets' },
  { id: 'crypto-exchanges', label: 'Crypto Exchanges', path: '/crypto/exchanges' },
  { id: 'crypto-review', label: 'Crypto Review', path: '/crypto/review' },
  { id: 'crypto-labels', label: 'Crypto Labels & Rules', path: '/crypto/labels' },
  // Compatibility alias. Discovery now belongs to the Wallets page, but this
  // route remains valid for saved links and highlights Wallets in the sidebar.
  { id: 'crypto-discovery', label: 'Crypto Wallet Discovery', path: '/crypto/discovery' },
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

// The pages in the Crypto sidebar section share one mounted workspace so
// filters, expanded ledger rows and loaded pages survive navigation between
// them. Discovery is a compatibility alias for the Wallets page.
const CRYPTO_PAGES = new Set([
  'crypto', 'crypto-holdings', 'crypto-transactions',
  'crypto-wallets', 'crypto-exchanges', 'crypto-review', 'crypto-labels',
  'crypto-discovery',
]);

// The remount key deliberately collapses all Crypto routes so switching pages
// keeps the shared workspace alive. Sidebar highlighting is separate now that
// each Crypto destination has its own entry.
function collapsePageId(page) {
  if (BALANCES_TABS.has(page)) return 'balances';
  if (CRYPTO_PAGES.has(page)) return 'crypto';
  return page;
}

function sidebarPageId(page) {
  if (BALANCES_TABS.has(page)) return 'balances';
  if (page === 'crypto-discovery') return 'crypto-wallets';
  return page;
}

function normalizePath(pathname) {
  return pathname.replace(/\/+$/, '') || '/';
}

function App() {
  // Login happens upstream (Azure Easy Auth); by the time this app loads the
  // user is already authenticated. /api/me supplies the display name and the
  // isAdmin flag that decides whether Settings offers the Server tab.
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

  // The sidebar's Crypto badge: the "something needs my attention" signal,
  // visible from anywhere without entering the page. Fetched once at boot for
  // the initial value; afterwards CryptoPage reports through onAttentionChange
  // every time its own data refetches, so draining the review queue moves the
  // badge live without polling. Both requests fail soft -- a badge may not
  // break the shell.
  const [cryptoAttention, setCryptoAttention] = useState({ errored: 0, needsReview: 0 });
  // A report carries null for a half whose fetch FAILED: unknown must not
  // downgrade a red badge to all-clear, so applying a report merges, keeping
  // the previous value for any null half.
  const applyCryptoAttention = useCallback((next) => {
    setCryptoAttention((prev) => ({
      errored: next.errored ?? prev.errored,
      needsReview: next.needsReview ?? prev.needsReview,
    }));
  }, []);
  // Once CryptoPage has reported live numbers, the boot fetch discards its
  // own response: on a direct /crypto load the two race, and the boot copy
  // (which can land late through the interceptor's 5xx retry) is the stale one.
  const liveAttentionRef = useRef(false);
  const handleCryptoAttention = useCallback((next) => {
    liveAttentionRef.current = true;
    applyCryptoAttention(next);
  }, [applyCryptoAttention]);
  useEffect(() => {
    let cancelled = false;
    Promise.all([
      cryptoAPI.getLedgerSummary().catch(() => null),
      ethAPI.getWallets().catch(() => null),
    ]).then(([ledger, wallets]) => {
      if (cancelled || liveAttentionRef.current) return;
      applyCryptoAttention({
        errored: wallets
          ? (wallets.wallets || []).filter((wallet) => (
            wallet.error_code || wallet.reconciliation?.needs_review
          )).length
          : null,
        needsReview: ledger ? (ledger.summary?.needs_review_count || 0) : null,
      });
    });
    return () => { cancelled = true; };
  }, [applyCryptoAttention]);

  // Route each kind of attention to the page where it can be resolved. These
  // are intentionally independent: a wallet problem must not hide review work.
  const cryptoBadges = {
    ...(cryptoAttention.errored > 0
      ? { 'crypto-wallets': { count: cryptoAttention.errored, tone: 'error' } }
      : {}),
    ...(cryptoAttention.needsReview > 0
      ? { 'crypto-review': { count: cryptoAttention.needsReview, tone: 'review' } }
      : {}),
  };

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
      <div key={collapsePageId(currentPage)} className="w-full">
        {currentPage === 'dashboard' && <Dashboard onNavigate={handleNavigate} />}
        {BALANCES_TABS.has(currentPage) && <BalancesPage tab={currentPage} onTabChange={handleNavigate} />}
        {currentPage === 'accounts' && <AccountsPage />}
        {CRYPTO_PAGES.has(currentPage) && (
          <CryptoPage
            tab={currentPage}
            onTabChange={handleNavigate}
            onAttentionChange={handleCryptoAttention}
          />
        )}
        {currentPage === 'ticker-history' && <TickerHistory />}
        {currentPage === 'account-history' && <AccountHistory />}
        {currentPage === 'portfolio-timeline' && <PortfolioTimeline />}
        {currentPage === 'holdings-analysis' && <HoldingsAnalysis />}
        {currentPage === 'spending' && <Spending />}
        {currentPage === 'top-merchants' && <TopMerchants />}
        {currentPage === 'salary-history' && <SalaryHistory />}
        {currentPage === 'monthly-expenses' && <MonthlyExpenses />}
        {currentPage === 'settings' && <Settings user={user} />}
      </div>
    );
  };

  return (
    <div className="flex min-h-screen bg-base font-sans">
      <Sidebar
        currentPage={sidebarPageId(currentPage)}
        onNavigate={handleNavigate}
        user={user}
        onLogout={handleLogout}
        mobileOpen={mobileOpen}
        onMobileClose={() => setMobileOpen(false)}
        badges={cryptoBadges}
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

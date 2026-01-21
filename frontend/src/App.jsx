import React, { useState } from 'react';
import { useAuth } from './context/AuthContext';
import Login from './components/Login';
import Dashboard from './components/Dashboard';
import HoldingsTable from './components/HoldingsTable';
import TickerHistory from './pages/TickerHistory';
import AccountHistory from './pages/AccountHistory';
import PortfolioTimeline from './pages/PortfolioTimeline';
import StaticAssets from './pages/StaticAssets';

function App() {
  const { user, loading, logout } = useAuth();
  const [currentPage, setCurrentPage] = useState('dashboard');
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="text-xl text-gray-600">Loading...</div>
      </div>
    );
  }

  if (!user) {
    return <Login />;
  }

  const navItems = [
    { id: 'dashboard', label: 'Dashboard' },
    { id: 'holdings', label: 'Holdings' },
    { id: 'static-assets', label: 'Static Assets' },
    { id: 'ticker-history', label: 'Ticker History' },
    { id: 'account-history', label: 'Account History' },
    { id: 'portfolio-timeline', label: 'Portfolio Timeline' },
  ];

  const handleNavClick = (pageId) => {
    setCurrentPage(pageId);
    setMobileMenuOpen(false);
  };

  return (
    <div className="min-h-screen bg-gray-50">
      <nav className="bg-white shadow-sm border-b border-gray-200">
        <div className="container mx-auto px-4 py-3 md:py-4">
          <div className="flex justify-between items-center">
            <div className="flex items-center gap-4 md:gap-6 flex-1 min-w-0">
              <h1 className="text-lg md:text-xl font-bold text-gray-900 truncate">My Money Tracker</h1>
              {/* Desktop Navigation */}
              <div className="hidden md:flex gap-2 flex-wrap">
                {navItems.map((item) => (
                  <button
                    key={item.id}
                    onClick={() => handleNavClick(item.id)}
                    className={`px-3 py-2 text-sm font-medium rounded-md transition-colors touch-manipulation min-h-[44px] ${
                      currentPage === item.id
                        ? 'bg-blue-100 text-blue-700'
                        : 'text-gray-600 hover:bg-gray-100 active:bg-gray-200'
                    }`}
                  >
                    {item.label}
                  </button>
                ))}
              </div>
            </div>
            <div className="flex items-center gap-2 md:gap-4 flex-shrink-0">
              <span className="hidden sm:inline text-sm md:text-base text-gray-600 truncate max-w-[120px]">
                {user.username}
              </span>
              <button
                onClick={logout}
                className="px-3 md:px-4 py-2 text-sm text-white bg-gray-600 rounded-md hover:bg-gray-700 active:bg-gray-800 touch-manipulation min-h-[44px]"
              >
                Logout
              </button>
              {/* Mobile Menu Button */}
              <button
                onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
                className="md:hidden p-2 text-gray-600 hover:bg-gray-100 active:bg-gray-200 rounded-md touch-manipulation min-w-[44px] min-h-[44px]"
                aria-label="Toggle menu"
              >
                <svg
                  className="w-6 h-6"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  {mobileMenuOpen ? (
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M6 18L18 6M6 6l12 12"
                    />
                  ) : (
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M4 6h16M4 12h16M4 18h16"
                    />
                  )}
                </svg>
              </button>
            </div>
          </div>
          {/* Mobile Navigation */}
          {mobileMenuOpen && (
            <div className="md:hidden mt-3 pt-3 border-t border-gray-200">
              <div className="flex flex-col gap-2">
                {navItems.map((item) => (
                  <button
                    key={item.id}
                    onClick={() => handleNavClick(item.id)}
                    className={`px-3 py-2 text-sm font-medium rounded-md transition-colors text-left touch-manipulation min-h-[44px] ${
                      currentPage === item.id
                        ? 'bg-blue-100 text-blue-700'
                        : 'text-gray-600 hover:bg-gray-100 active:bg-gray-200'
                    }`}
                  >
                    {item.label}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      </nav>
      {currentPage === 'dashboard' && <Dashboard />}
      {currentPage === 'holdings' && <HoldingsTable />}
      {currentPage === 'static-assets' && <StaticAssets />}
      {currentPage === 'ticker-history' && <TickerHistory />}
      {currentPage === 'account-history' && <AccountHistory />}
      {currentPage === 'portfolio-timeline' && <PortfolioTimeline />}
    </div>
  );
}

export default App;

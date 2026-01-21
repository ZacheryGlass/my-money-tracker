import React, { useState } from 'react';
import { useAuth } from './context/AuthContext';
import Login from './components/Login';
import HoldingsTable from './components/HoldingsTable';
import TickerHistory from './pages/TickerHistory';
import AccountHistory from './pages/AccountHistory';
import PortfolioTimeline from './pages/PortfolioTimeline';

function App() {
  const { user, loading, logout } = useAuth();
  const [currentPage, setCurrentPage] = useState('holdings');

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

  return (
    <div className="min-h-screen bg-gray-50">
      <nav className="bg-white shadow-sm border-b border-gray-200">
        <div className="container mx-auto px-4 py-4">
          <div className="flex justify-between items-center">
            <div className="flex items-center gap-6">
              <h1 className="text-xl font-bold text-gray-900">My Money Tracker</h1>
              <div className="flex gap-4">
                <button
                  onClick={() => setCurrentPage('holdings')}
                  className={`px-3 py-2 text-sm font-medium rounded-md transition-colors ${
                    currentPage === 'holdings'
                      ? 'bg-blue-100 text-blue-700'
                      : 'text-gray-600 hover:bg-gray-100'
                  }`}
                >
                  Holdings
                </button>
                <button
                  onClick={() => setCurrentPage('ticker-history')}
                  className={`px-3 py-2 text-sm font-medium rounded-md transition-colors ${
                    currentPage === 'ticker-history'
                      ? 'bg-blue-100 text-blue-700'
                      : 'text-gray-600 hover:bg-gray-100'
                  }`}
                >
                  Ticker History
                </button>
                <button
                  onClick={() => setCurrentPage('account-history')}
                  className={`px-3 py-2 text-sm font-medium rounded-md transition-colors ${
                    currentPage === 'account-history'
                      ? 'bg-blue-100 text-blue-700'
                      : 'text-gray-600 hover:bg-gray-100'
                  }`}
                >
                  Account History
                </button>
                <button
                  onClick={() => setCurrentPage('portfolio-timeline')}
                  className={`px-3 py-2 text-sm font-medium rounded-md transition-colors ${
                    currentPage === 'portfolio-timeline'
                      ? 'bg-blue-100 text-blue-700'
                      : 'text-gray-600 hover:bg-gray-100'
                  }`}
                >
                  Portfolio Timeline
                </button>
              </div>
            </div>
            <div className="flex items-center gap-4">
              <span className="text-gray-600">Welcome, {user.username}</span>
              <button
                onClick={logout}
                className="px-4 py-2 text-sm text-white bg-gray-600 rounded-md hover:bg-gray-700"
              >
                Logout
              </button>
            </div>
          </div>
        </div>
      </nav>
      {currentPage === 'holdings' && <HoldingsTable />}
      {currentPage === 'ticker-history' && <TickerHistory />}
      {currentPage === 'account-history' && <AccountHistory />}
      {currentPage === 'portfolio-timeline' && <PortfolioTimeline />}
    </div>
  );
}

export default App;

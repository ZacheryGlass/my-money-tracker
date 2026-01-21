import React from 'react';
import { useAuth } from './context/AuthContext';
import Login from './components/Login';
import HoldingsTable from './components/HoldingsTable';

function App() {
  const { user, loading, logout } = useAuth();

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
            <h1 className="text-xl font-bold text-gray-900">My Money Tracker</h1>
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
      <HoldingsTable />
    </div>
  );
}

export default App;

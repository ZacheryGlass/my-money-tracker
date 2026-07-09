import React, { useState, useEffect } from 'react';
import { AnimatePresence, motion as Motion } from 'framer-motion';
import {
  LayoutDashboard,
  PieChart,
  Wallet,
  TrendingUp,
  History,
  Calendar,
  Banknote,
  CreditCard,
  LogOut,
  ChevronLeft,
  ChevronRight,
  Menu,
  X,
  User as UserIcon,
  Settings,
  Landmark,
  Building2,
  Grid3X3,
  BarChart3,
  CalendarDays,
} from 'lucide-react';
import { useIsMobile, useIsDesktop } from '../hooks/useMediaQuery';

const NAV_ITEMS = [
  { id: 'dashboard', label: 'Dashboard', icon: LayoutDashboard },
  { id: 'assets', label: 'Assets', icon: PieChart },
  { id: 'cash', label: 'Cash', icon: Wallet },
  { id: 'liabilities', label: 'Liabilities', icon: Landmark },
  { id: 'accounts', label: 'Accounts', icon: Building2 },
  { id: 'ticker-history', label: 'Ticker History', icon: TrendingUp },
  { id: 'account-history', label: 'Account History', icon: History },
  { id: 'portfolio-timeline', label: 'Portfolio Timeline', icon: Calendar },
  { id: '_separator_analytics', section: 'ANALYTICS' },
  { id: 'holdings-analysis', label: 'Holdings Analysis', icon: Grid3X3 },
  { id: 'spending-analytics', label: 'Spending', icon: BarChart3 },
  { id: 'year-in-review', label: 'Year in Review', icon: CalendarDays },
  { id: '_separator_planning', section: 'PLANNING' },
  { id: 'salary-history', label: 'Salary History', icon: Banknote },
  { id: 'monthly-expenses', label: 'Monthly Expenses', icon: CreditCard },
];

function getStoredExpanded() {
  try {
    const val = localStorage.getItem('sidebar-expanded');
    return val === null ? true : val === 'true';
  } catch {
    return true;
  }
}

export default function Sidebar({ currentPage, onNavigate, user, onLogout, mobileOpen, onMobileClose }) {
  const isMobile = useIsMobile();
  const isDesktop = useIsDesktop();
  const [expanded, setExpanded] = useState(getStoredExpanded);

  const showExpanded = isDesktop && expanded;

  useEffect(() => {
    try {
      localStorage.setItem('sidebar-expanded', String(expanded));
    } catch {
      /* Ignore localStorage failures. */
    }
  }, [expanded]);

  const handleToggleExpand = () => {
    if (isDesktop) {
      setExpanded((prev) => !prev);
    }
  };

  const handleNavClick = (id) => {
    onNavigate(id);
    if (isMobile && onMobileClose) {
      onMobileClose();
    }
  };

  const sidebarContent = (
    <Motion.aside
      initial={false}
      animate={{ width: isMobile ? '240px' : (showExpanded ? '220px' : '48px') }}
      className="flex flex-col h-full bg-surface border-r border-border overflow-hidden z-50"
    >
      {/* Header */}
      <div className="flex items-center h-[35px] px-3 border-b border-border flex-shrink-0">
        <div className="w-5 h-5 rounded-sm bg-accent flex items-center justify-center flex-shrink-0">
          <Banknote className="text-white w-3 h-3" />
        </div>
        {(showExpanded || isMobile) && (
          <span className="ml-2 text-body-sm font-semibold text-secondary whitespace-nowrap">
            My Money Tracker
          </span>
        )}
      </div>

      {/* Navigation */}
      <nav className="flex-1 overflow-y-auto py-1 px-1">
        <div className="flex flex-col">
          {NAV_ITEMS.map((item) => {
            if (item.section) {
              return (showExpanded || isMobile) ? (
                <div key={item.id} className="mt-4 mb-1 px-2">
                  <span className="text-caption-upper uppercase text-tertiary">
                    {item.section}
                  </span>
                </div>
              ) : (
                <div key={item.id} className="my-2 border-t border-border mx-1" />
              );
            }

            const Icon = item.icon;
            const isActive = currentPage === item.id || (item.id === 'spending-analytics' && currentPage === 'spending-explorer');

            return (
              <button
                key={item.id}
                onClick={() => handleNavClick(item.id)}
                className={`
                  flex items-center gap-2 w-full px-2 py-[5px] text-left transition-colors relative
                  ${isActive
                    ? 'bg-[#3994BC26] text-primary'
                    : 'text-secondary hover:bg-surface-2 hover:text-primary'}
                `}
                title={(!showExpanded && !isMobile) ? item.label : undefined}
              >
                <Icon size={16} strokeWidth={isActive ? 2 : 1.5} className="flex-shrink-0" />

                {(showExpanded || isMobile) && (
                  <span className="text-body-sm whitespace-nowrap truncate">
                    {item.label}
                  </span>
                )}

                {isActive && (
                  <div className="absolute left-0 top-0 w-[2px] h-full bg-accent-focus" />
                )}
              </button>
            );
          })}
        </div>
      </nav>

      {/* Footer */}
      <div className="border-t border-border">
        <button
          onClick={() => handleNavClick('settings')}
          className={`flex items-center gap-2 w-full px-2 py-2 text-left transition-colors
            ${currentPage === 'settings' ? 'bg-[#3994BC26] text-primary' : 'text-secondary hover:bg-surface-2 hover:text-primary'}
            ${(!showExpanded && !isMobile) ? 'justify-center' : ''}`}
          title={(!showExpanded && !isMobile) ? 'Settings' : undefined}
        >
          <div className="w-5 h-5 rounded-full bg-surface-3 border border-border flex items-center justify-center flex-shrink-0">
            <UserIcon size={12} />
          </div>
          {(showExpanded || isMobile) && (
            <div className="flex flex-col min-w-0">
              <span className="text-body-sm font-semibold text-primary truncate">
                {user?.username}
              </span>
              <span className="text-caption text-tertiary">
                Settings
              </span>
            </div>
          )}
        </button>

        <button
          onClick={onLogout}
          className={`
            flex items-center gap-2 w-full px-2 py-2 text-left
            text-secondary hover:bg-loss-bg hover:text-loss transition-colors
            ${(!showExpanded && !isMobile) ? 'justify-center' : ''}
          `}
          title={(!showExpanded && !isMobile) ? 'Logout' : undefined}
        >
          <LogOut size={16} />
          {(showExpanded || isMobile) && (
            <span className="text-body-sm">Logout</span>
          )}
        </button>
      </div>

      {/* Collapse Toggle */}
      {isDesktop && (
        <button
          onClick={handleToggleExpand}
          className="flex items-center justify-center h-[22px] border-t border-border text-tertiary hover:text-primary hover:bg-surface-2 transition-colors"
        >
          {expanded ? <ChevronLeft size={14} /> : <ChevronRight size={14} />}
        </button>
      )}
    </Motion.aside>
  );

  if (isMobile) {
    return (
      <>
        <AnimatePresence>
          {mobileOpen && (
            <>
              <Motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                className="fixed inset-0 z-40 bg-black/60"
                onClick={onMobileClose}
              />
              <Motion.div
                initial={{ x: '-100%' }}
                animate={{ x: 0 }}
                exit={{ x: '-100%' }}
                transition={{ type: 'spring', damping: 25, stiffness: 200 }}
                className="fixed left-0 top-0 h-full z-50"
              >
                {sidebarContent}
              </Motion.div>
            </>
          )}
        </AnimatePresence>
      </>
    );
  }

  return (
    <div className="sticky top-0 h-screen flex-shrink-0 z-50">
      {sidebarContent}
    </div>
  );
}

export const HamburgerIcon = Menu;

import React, { useState, useEffect } from 'react';
import { motion as Motion, AnimatePresence } from 'framer-motion';
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
  Store,
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
  { id: 'spending-explorer', label: 'Spending Explorer', icon: Store },
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
      animate={{ width: isMobile ? '280px' : (showExpanded ? '260px' : '80px') }}
      className="flex flex-col h-full bg-surface border-r border-border transition-colors duration-300 ease-in-out overflow-hidden z-50"
    >
      {/* Header */}
      <div className="flex items-center h-16 px-5 border-b border-border flex-shrink-0">
        <div className="w-8 h-8 rounded-lg bg-accent flex items-center justify-center flex-shrink-0 shadow-glow">
          <Banknote className="text-inverse w-5 h-5" />
        </div>
        {(showExpanded || isMobile) && (
          <Motion.span
            initial={{ opacity: 0, x: -10 }}
            animate={{ opacity: 1, x: 0 }}
            className="ml-3 text-sm font-bold tracking-tight text-primary whitespace-nowrap"
          >
            My Money Tracker
          </Motion.span>
        )}
      </div>

      {/* Navigation */}
      <nav className="flex-1 overflow-y-auto py-6 px-3 custom-scrollbar">
        <div className="flex flex-col gap-1.5">
          {NAV_ITEMS.map((item) => {
            if (item.section) {
              return (showExpanded || isMobile) ? (
                <div key={item.id} className="mt-6 mb-2 px-4">
                  <span className="text-xs font-bold uppercase tracking-widest text-secondary">
                    {item.section}
                  </span>
                </div>
              ) : (
                <div key={item.id} className="my-4 border-t border-border/50 mx-2" />
              );
            }

            const Icon = item.icon;
            const isActive = currentPage === item.id;

            return (
              <button
                key={item.id}
                onClick={() => handleNavClick(item.id)}
                className={`
                  flex items-center gap-4 w-full rounded-xl px-3 py-3 text-left transition-all duration-200 group relative
                  ${isActive
                    ? 'bg-accent/10 text-accent'
                    : 'text-secondary hover:bg-surface-2 hover:text-primary'}
                `}
                title={(!showExpanded && !isMobile) ? item.label : undefined}
              >
                <div className={`
                  flex items-center justify-center transition-transform duration-200
                  ${isActive ? 'scale-110' : 'group-hover:scale-110'}
                `}>
                  <Icon size={22} strokeWidth={isActive ? 2.5 : 2} />
                </div>

                {(showExpanded || isMobile) && (
                  <Motion.span
                    initial={{ opacity: 0, x: -10 }}
                    animate={{ opacity: 1, x: 0 }}
                    className={`text-base font-semibold whitespace-nowrap transition-colors duration-200 ${isActive ? 'text-primary' : 'text-secondary group-hover:text-primary'}`}
                  >
                    {item.label}
                  </Motion.span>
                )}

                {isActive && (
                  <Motion.div
                    layoutId="active-pill"
                    className="absolute left-0 w-1 h-7 bg-accent rounded-full"
                    transition={{ type: 'spring', stiffness: 300, damping: 30 }}
                  />
                )}
              </button>
            );
          })}
        </div>
      </nav>

      {/* Footer / User Profile */}
      <div className="p-3 border-t border-border bg-surface-2/30">
        <button
          onClick={() => handleNavClick('settings')}
          className={`flex items-center gap-4 px-3 py-4 rounded-xl w-full text-left transition-all duration-200
            ${currentPage === 'settings' ? 'bg-accent/10 ring-1 ring-accent/30' : 'hover:bg-surface-2'}
            ${(!showExpanded && !isMobile) ? 'justify-center' : ''}`}
          title={(!showExpanded && !isMobile) ? 'Settings' : undefined}
        >
          <div className="w-10 h-10 rounded-full bg-surface-3 border border-border flex items-center justify-center flex-shrink-0 text-secondary relative">
            <UserIcon size={20} />
            <div className="absolute -bottom-0.5 -right-0.5 w-4 h-4 rounded-full bg-surface-2 border border-border flex items-center justify-center">
              <Settings size={10} className="text-tertiary" />
            </div>
          </div>
          {(showExpanded || isMobile) && (
            <div className="flex flex-col min-w-0">
              <span className="text-base font-semibold text-primary truncate leading-tight">
                {user?.username}
              </span>
              <span className="text-xs text-tertiary uppercase tracking-wider font-bold">
                Settings
              </span>
            </div>
          )}
        </button>

        <button
          onClick={onLogout}
          className={`
            flex items-center gap-4 w-full rounded-xl px-3 py-3 mt-2 text-left
            hover:bg-loss/10 transition-all duration-200 group
            ${(!showExpanded && !isMobile) ? 'justify-center' : ''}
          `}
          title={(!showExpanded && !isMobile) ? 'Logout' : undefined}
        >
          <LogOut size={22} className="text-secondary group-hover:text-loss group-hover:translate-x-0.5 transition-all" />
          {(showExpanded || isMobile) && (
            <span className="text-base font-medium text-secondary group-hover:text-loss transition-colors">Logout</span>
          )}
        </button>
      </div>

      {/* Collapse Toggle */}
      {isDesktop && (
        <button
          onClick={handleToggleExpand}
          className="flex items-center justify-center h-12 border-t border-border text-tertiary hover:text-primary hover:bg-surface-3 transition-all duration-200"
        >
          {expanded ? <ChevronLeft size={18} /> : <ChevronRight size={18} />}
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
                className="fixed inset-0 z-40 bg-black/60 backdrop-blur-sm"
                onClick={onMobileClose}
              />
              <Motion.div
                initial={{ x: '-100%' }}
                animate={{ x: 0 }}
                exit={{ x: '-100%' }}
                transition={{ type: 'spring', damping: 25, stiffness: 200 }}
                className="fixed left-0 top-0 h-full z-50 shadow-2xl"
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

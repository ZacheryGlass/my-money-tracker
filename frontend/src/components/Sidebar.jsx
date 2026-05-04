import React, { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  LayoutDashboard,
  PieChart,
  Building2,
  TrendingUp,
  History,
  Calendar,
  Banknote,
  CreditCard,
  LogOut,
  ChevronLeft,
  ChevronRight,
  Menu,
  User as UserIcon
} from 'lucide-react';
import { useIsMobile, useIsDesktop } from '../hooks/useMediaQuery';

const NAV_ITEMS = [
  { id: 'dashboard', label: 'Dashboard', icon: LayoutDashboard },
  { id: 'holdings', label: 'Holdings', icon: PieChart },
  { id: 'static-assets', label: 'Static Assets', icon: Building2 },
  { id: 'ticker-history', label: 'Ticker History', icon: TrendingUp },
  { id: 'account-history', label: 'Account History', icon: History },
  { id: 'portfolio-timeline', label: 'Portfolio Timeline', icon: Calendar },
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
    } catch {}
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
    <motion.aside
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
          <motion.span
            initial={{ opacity: 0, x: -10 }}
            animate={{ opacity: 1, x: 0 }}
            className="ml-3 text-sm font-bold tracking-tight text-primary whitespace-nowrap"
          >
            My Money Tracker
          </motion.span>
        )}
      </div>

      {/* Navigation */}
      <nav className="flex-1 overflow-y-auto py-6 px-3 custom-scrollbar">
        <div className="flex flex-col gap-1.5">
          {NAV_ITEMS.map((item) => {
            if (item.section) {
              return (showExpanded || isMobile) ? (
                <div key={item.id} className="mt-6 mb-2 px-4">
                  <span className="text-[10px] font-bold uppercase tracking-widest text-tertiary">
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
                  flex items-center gap-3 w-full rounded-xl px-3 py-2.5 text-left transition-all duration-200 group relative
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
                  <Icon size={20} strokeWidth={isActive ? 2.5 : 2} />
                </div>

                {(showExpanded || isMobile) && (
                  <motion.span
                    initial={{ opacity: 0, x: -10 }}
                    animate={{ opacity: 1, x: 0 }}
                    className="text-sm font-medium whitespace-nowrap"
                  >
                    {item.label}
                  </motion.span>
                )}

                {isActive && (
                  <motion.div
                    layoutId="active-pill"
                    className="absolute left-0 w-1 h-6 bg-accent rounded-full"
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
        <div className={`flex items-center gap-3 px-3 py-3 rounded-xl ${(!showExpanded && !isMobile) ? 'justify-center' : ''}`}>
          <div className="w-9 h-9 rounded-full bg-surface-3 border border-border flex items-center justify-center flex-shrink-0 text-secondary">
            <UserIcon size={18} />
          </div>
          {(showExpanded || isMobile) && (
            <span className="text-sm font-semibold text-primary truncate leading-tight">
              {user?.username}
            </span>
          )}
        </div>

        <button
          onClick={onLogout}
          className={`
            flex items-center gap-3 w-full rounded-xl px-3 py-2.5 mt-2 text-left text-secondary
            hover:bg-loss/10 hover:text-loss transition-all duration-200 group
            ${(!showExpanded && !isMobile) ? 'justify-center' : ''}
          `}
          title={(!showExpanded && !isMobile) ? 'Logout' : undefined}
        >
          <LogOut size={20} className="group-hover:translate-x-0.5 transition-transform" />
          {(showExpanded || isMobile) && (
            <span className="text-sm font-medium">Logout</span>
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
    </motion.aside>
  );

  if (isMobile) {
    return (
      <>
        <AnimatePresence>
          {mobileOpen && (
            <>
              <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                className="fixed inset-0 z-40 bg-black/60 backdrop-blur-sm"
                onClick={onMobileClose}
              />
              <motion.div
                initial={{ x: '-100%' }}
                animate={{ x: 0 }}
                exit={{ x: '-100%' }}
                transition={{ type: 'spring', damping: 25, stiffness: 200 }}
                className="fixed left-0 top-0 h-full z-50 shadow-2xl"
              >
                {sidebarContent}
              </motion.div>
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

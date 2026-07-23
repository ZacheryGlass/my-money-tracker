import React, { useState, useEffect } from 'react';
import {
  LayoutDashboard,
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
  Building2,
  Grid3X3,
  ReceiptText,
  Store,
} from 'lucide-react';
import { useMediaQuery, useIsDesktop } from '../hooks/useMediaQuery';

const NAV_ITEMS = [
  { id: 'dashboard', label: 'Dashboard', icon: LayoutDashboard },
  { id: 'balances', label: 'Balances', icon: Wallet },
  { id: 'accounts', label: 'Accounts', icon: Building2 },
  { id: '_separator_portfolio', section: 'PORTFOLIO' },
  { id: 'holdings-analysis', label: 'Holdings Analysis', icon: Grid3X3 },
  { id: 'portfolio-timeline', label: 'Portfolio Timeline', icon: Calendar },
  { id: 'account-history', label: 'Account History', icon: History },
  { id: 'ticker-history', label: 'Ticker History', icon: TrendingUp },
  { id: '_separator_spending', section: 'SPENDING' },
  { id: 'spending', label: 'Spending', icon: ReceiptText },
  { id: 'top-merchants', label: 'Top Merchants', icon: Store },
  { id: 'monthly-expenses', label: 'Monthly Expenses', icon: CreditCard },
  { id: '_separator_income', section: 'INCOME' },
  { id: 'salary-history', label: 'Salary History', icon: Banknote },
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
  const isMobile = useMediaQuery('(max-width: 1023px)');
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

  useEffect(() => {
    if (!isMobile || !mobileOpen) return undefined;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, [isMobile, mobileOpen]);

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

  const sidebarWidth = isMobile ? 'min(86vw, 320px)' : (showExpanded ? '220px' : '48px');

  const sidebarContent = (
    <aside
      style={{ width: sidebarWidth }}
      className="flex flex-col h-full bg-surface border-r border-border overflow-hidden z-50 transition-[width] duration-200 ease-out"
    >
      {/* Header */}
      <div className="flex h-12 flex-shrink-0 items-center border-b border-border px-3 lg:h-[35px]">
        <div className="w-5 h-5 rounded-sm bg-accent flex items-center justify-center flex-shrink-0">
          <Banknote className="text-white w-3 h-3" />
        </div>
        {(showExpanded || isMobile) && (
          <span className="ml-2 text-body-sm font-semibold text-secondary whitespace-nowrap">
            My Money Tracker
          </span>
        )}
        {isMobile && (
          <button
            type="button"
            onClick={onMobileClose}
            className="ml-auto flex h-10 w-10 items-center justify-center text-tertiary transition-colors hover:bg-surface-2 hover:text-primary"
            aria-label="Close menu"
          >
            <X size={20} />
          </button>
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
            const isActive = currentPage === item.id;

            return (
              <button
                key={item.id}
                onClick={() => handleNavClick(item.id)}
                className={`
                  relative flex min-h-11 w-full items-center gap-3 px-3 py-2 text-left transition-colors lg:min-h-0 lg:gap-2 lg:px-2 lg:py-[5px]
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
          className={`flex min-h-12 w-full items-center gap-3 px-3 py-2 text-left transition-colors lg:min-h-0 lg:gap-2 lg:px-2
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
            flex min-h-12 w-full items-center gap-3 px-3 py-2 text-left lg:min-h-0 lg:gap-2 lg:px-2
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
    </aside>
  );

  if (isMobile) {
    // Backdrop and drawer stay mounted; CSS transitions handle both enter and
    // exit as `mobileOpen` toggles (no framer-motion needed).
    return (
      <>
        <div
          className={`fixed inset-0 z-40 bg-black/60 transition-opacity duration-200 ${
            mobileOpen ? 'opacity-100' : 'opacity-0 pointer-events-none'
          }`}
          onClick={onMobileClose}
          aria-hidden={!mobileOpen}
        />
        <div
          className={`fixed left-0 top-0 h-full z-50 transition-transform duration-200 ease-out ${
            mobileOpen ? 'translate-x-0' : '-translate-x-full'
          }`}
          aria-hidden={!mobileOpen}
          inert={!mobileOpen}
        >
          {sidebarContent}
        </div>
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

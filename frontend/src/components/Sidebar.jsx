import React, { useState, useEffect } from 'react';
import { useIsMobile, useIsDesktop } from '../hooks/useMediaQuery';

const NAV_ITEMS = [
  {
    id: 'dashboard',
    label: 'Dashboard',
    icon: (
      <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <rect x="2" y="2" width="7" height="7" rx="1" />
        <rect x="11" y="2" width="7" height="7" rx="1" />
        <rect x="2" y="11" width="7" height="7" rx="1" />
        <rect x="11" y="11" width="7" height="7" rx="1" />
      </svg>
    ),
  },
  {
    id: 'holdings',
    label: 'Holdings',
    icon: (
      <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <line x1="3" y1="5" x2="17" y2="5" />
        <line x1="3" y1="10" x2="17" y2="10" />
        <line x1="3" y1="15" x2="17" y2="15" />
        <circle cx="3" cy="5" r="1" fill="currentColor" stroke="none" />
        <circle cx="3" cy="10" r="1" fill="currentColor" stroke="none" />
        <circle cx="3" cy="15" r="1" fill="currentColor" stroke="none" />
      </svg>
    ),
  },
  {
    id: 'static-assets',
    label: 'Static Assets',
    icon: (
      <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <path d="M3 9L10 3l7 6" />
        <path d="M5 9v8h10V9" />
        <rect x="8" y="13" width="4" height="4" />
      </svg>
    ),
  },
  {
    id: 'ticker-history',
    label: 'Ticker History',
    icon: (
      <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <polyline points="2,14 7,9 11,12 18,5" />
        <polyline points="14,5 18,5 18,9" />
      </svg>
    ),
  },
  {
    id: 'account-history',
    label: 'Account History',
    icon: (
      <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <rect x="2" y="12" width="3" height="6" />
        <rect x="7" y="8" width="3" height="10" />
        <rect x="12" y="5" width="3" height="13" />
        <rect x="17" y="2" width="3" height="16" />
      </svg>
    ),
  },
  {
    id: 'portfolio-timeline',
    label: 'Portfolio Timeline',
    icon: (
      <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <polyline points="2,17 6,11 10,13 14,7 18,3" />
        <line x1="2" y1="17" x2="18" y2="17" />
      </svg>
    ),
  },
];

const CollapseIcon = ({ expanded }) => (
  <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    {expanded ? (
      <polyline points="13,5 7,10 13,15" />
    ) : (
      <polyline points="7,5 13,10 7,15" />
    )}
  </svg>
);

const HamburgerIcon = () => (
  <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <line x1="3" y1="5" x2="17" y2="5" />
    <line x1="3" y1="10" x2="17" y2="10" />
    <line x1="3" y1="15" x2="17" y2="15" />
  </svg>
);

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
  const sidebarWidth = showExpanded ? '240px' : '64px';

  useEffect(() => {
    try {
      localStorage.setItem('sidebar-expanded', String(expanded));
    } catch {
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
    <aside
      style={{ width: isMobile ? '240px' : sidebarWidth }}
      className="flex flex-col h-full bg-surface-2 border-r border-border transition-all duration-200 ease-in-out overflow-hidden"
    >
      <div className="flex items-center h-14 px-4 border-b border-border flex-shrink-0">
        <span className="text-accent font-mono font-bold text-base flex-shrink-0">MMT</span>
        <span
          className="ml-3 text-sm font-semibold text-primary whitespace-nowrap overflow-hidden transition-all duration-200 ease-in-out"
          style={{ opacity: (showExpanded || isMobile) ? 1 : 0, width: (showExpanded || isMobile) ? 'auto' : 0 }}
        >
          My Money Tracker
        </span>
      </div>

      <nav className="flex flex-col gap-1 py-3 px-2 flex-shrink-0">
        {NAV_ITEMS.map((item) => {
          const isActive = currentPage === item.id;
          return (
            <button
              key={item.id}
              onClick={() => handleNavClick(item.id)}
              className={[
                'flex items-center gap-3 w-full rounded-md px-2 py-2.5 text-left transition-colors duration-150',
                isActive
                  ? 'bg-accent-muted text-accent border-l-[3px] border-accent pl-[5px]'
                  : 'text-secondary hover:bg-surface-3 hover:text-primary border-l-[3px] border-transparent pl-[5px]',
              ].join(' ')}
              title={(!showExpanded && !isMobile) ? item.label : undefined}
            >
              <span className="flex-shrink-0">{item.icon}</span>
              <span
                className="text-sm font-medium whitespace-nowrap overflow-hidden transition-all duration-200 ease-in-out"
                style={{ opacity: (showExpanded || isMobile) ? 1 : 0, width: (showExpanded || isMobile) ? 'auto' : 0 }}
              >
                {item.label}
              </span>
            </button>
          );
        })}
      </nav>

      <div className="flex-1" />

      <div className="px-2 pb-2 border-t border-border pt-3 flex-shrink-0">
        <div className="flex items-center gap-3 px-2 py-2">
          <div className="w-8 h-8 rounded-full bg-surface-3 flex items-center justify-center flex-shrink-0">
            <span className="text-xs font-semibold text-secondary uppercase">
              {user?.username?.[0] ?? '?'}
            </span>
          </div>
          <span
            className="text-sm text-secondary whitespace-nowrap overflow-hidden transition-all duration-200 ease-in-out flex-1 min-w-0 truncate"
            style={{ opacity: (showExpanded || isMobile) ? 1 : 0, width: (showExpanded || isMobile) ? 'auto' : 0 }}
          >
            {user?.username}
          </span>
        </div>
        <button
          onClick={onLogout}
          className="flex items-center gap-3 w-full rounded-md px-2 py-2.5 text-left text-secondary hover:bg-surface-3 hover:text-primary transition-colors duration-150 border-l-[3px] border-transparent pl-[5px]"
          title={(!showExpanded && !isMobile) ? 'Logout' : undefined}
        >
          <span className="flex-shrink-0">
            <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M13 5l4 5-4 5" />
              <path d="M17 10H7" />
              <path d="M7 3H4a1 1 0 00-1 1v12a1 1 0 001 1h3" />
            </svg>
          </span>
          <span
            className="text-sm font-medium whitespace-nowrap overflow-hidden transition-all duration-200 ease-in-out"
            style={{ opacity: (showExpanded || isMobile) ? 1 : 0, width: (showExpanded || isMobile) ? 'auto' : 0 }}
          >
            Logout
          </span>
        </button>
      </div>

      {isDesktop && (
        <button
          onClick={handleToggleExpand}
          className="flex items-center justify-center h-10 border-t border-border text-tertiary hover:text-secondary hover:bg-surface-3 transition-colors duration-150 flex-shrink-0"
          title={expanded ? 'Collapse sidebar' : 'Expand sidebar'}
        >
          <CollapseIcon expanded={expanded} />
        </button>
      )}
    </aside>
  );

  if (isMobile) {
    return (
      <>
        {mobileOpen && (
          <div
            className="fixed inset-0 z-40"
            style={{ backgroundColor: 'var(--bg-overlay)' }}
            onClick={onMobileClose}
          />
        )}
        <div
          className="fixed left-0 top-0 h-full z-50 transition-transform duration-200 ease-in-out"
          style={{ transform: mobileOpen ? 'translateX(0)' : 'translateX(-100%)' }}
        >
          {sidebarContent}
        </div>
      </>
    );
  }

  return (
    <div className="sticky top-0 h-screen flex-shrink-0" style={{ width: sidebarWidth, transition: 'width 200ms ease-in-out' }}>
      {sidebarContent}
    </div>
  );
}

export { HamburgerIcon };

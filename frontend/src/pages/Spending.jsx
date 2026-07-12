import React, { useEffect, useState } from 'react';
import { BarChart3, Search } from 'lucide-react';
import SpendingAnalytics from './SpendingAnalytics';
import SpendingExplorer from './SpendingExplorer';

const TABS = [
  {
    id: 'overview',
    label: 'Overview',
    description: 'Trends, categories, and cash-flow context',
    icon: BarChart3,
  },
  {
    id: 'explorer',
    label: 'Explorer',
    description: 'Stores, filters, rankings, and transactions',
    icon: Search,
  },
];

export default function Spending({ initialTab = 'overview' }) {
  const [activeTab, setActiveTab] = useState(initialTab);

  useEffect(() => {
    setActiveTab(initialTab);
  }, [initialTab]);

  return (
    <div className="container mx-auto max-w-[1600px] space-y-6 px-4 py-6 md:py-8">
      <div className="flex flex-col gap-4 xl:flex-row xl:items-end xl:justify-between">
        <div>
          <div className="mb-2 flex items-center gap-2">
            <BarChart3 className="h-5 w-5 text-accent" />
            <span className="text-[10px] font-bold uppercase tracking-wide text-secondary">Spending</span>
          </div>
          <h1 className="text-3xl font-bold tracking-tighter text-primary md:text-5xl">Spending</h1>
          <p className="mt-1 text-sm text-secondary">
            Analyze trends and drill into stores, categories, and transactions from one place
          </p>
        </div>

        <div className="grid gap-2 rounded border border-border bg-surface p-1 sm:grid-cols-2">
          {TABS.map((tab) => {
            const Icon = tab.icon;
            const active = activeTab === tab.id;
            return (
              <button
                key={tab.id}
                type="button"
                onClick={() => setActiveTab(tab.id)}
                className={`flex min-w-0 items-center gap-3 rounded px-3 py-2 text-left transition-colors ${
                  active
                    ? 'bg-accent/15 text-accent'
                    : 'text-secondary hover:bg-surface-2 hover:text-primary'
                }`}
                aria-pressed={active}
              >
                <Icon size={16} className="shrink-0" />
                <span className="min-w-0">
                  <span className="block text-xs font-bold uppercase tracking-wide">{tab.label}</span>
                  <span className="block truncate text-caption text-tertiary">{tab.description}</span>
                </span>
              </button>
            );
          })}
        </div>
      </div>

      {activeTab === 'overview' ? (
        <SpendingAnalytics embedded />
      ) : (
        <SpendingExplorer embedded />
      )}
    </div>
  );
}

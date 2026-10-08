import React, { useEffect, useState } from 'react';
import { crypto as cryptoAPI } from '../../../utils/api';
import { formatDecimalAmount, formatUsdAtTime } from '../../../utils/format';

// Staking rewards over the last year, per asset, in at-the-time dollars. A
// reward with no price is counted and said, so the total reads as a floor.
export default function StakingIncomeCard({ refreshKey = 0, onOpenActivity }) {
  const [income, setIncome] = useState(undefined);
  useEffect(() => {
    let cancelled = false;
    Promise.resolve().then(() => cryptoAPI.getStakingIncome())
      .then((result) => { if (!cancelled) setIncome(result?.income || null); })
      .catch(() => { if (!cancelled) setIncome(null); });
    return () => { cancelled = true; };
  }, [refreshKey]);

  if (!income || income.events === 0) return null;
  return (
    <section aria-labelledby="crypto-income-heading" className="card overflow-hidden">
      <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-border px-4 py-2">
        <h2 id="crypto-income-heading" className="text-caption-upper uppercase text-secondary">Staking income, last 12 months</h2>
        <span className="font-money text-body-sm font-semibold text-primary">
          {formatUsdAtTime(income.total_usd, 'exact')}
          {income.unpriced > 0 && <span className="text-tertiary"> + {income.unpriced.toLocaleString()} without a price</span>}
        </span>
      </div>
      <ul className="divide-y divide-border">
        {income.assets.slice(0, 6).map((entry) => (
          <li key={entry.asset} className="flex flex-wrap items-baseline justify-between gap-2 px-4 py-2 text-body-sm">
            <span className="font-mono font-semibold text-accent">{entry.asset}</span>
            <span className="font-money text-secondary">
              {formatDecimalAmount(entry.quantity, { maxFractionDigits: 8 })}
              <span className="ml-2 text-caption text-tertiary">{entry.events.toLocaleString()} rewards</span>
            </span>
            <span className="ml-auto font-money text-primary">
              {Number(entry.usd) > 0 ? formatUsdAtTime(entry.usd, 'exact') : <span className="text-tertiary">No USD value</span>}
            </span>
          </li>
        ))}
      </ul>
      {onOpenActivity && (
        <button type="button" onClick={onOpenActivity} className="w-full border-t border-border px-4 py-2 text-left text-caption text-accent hover:underline">
          See every reward in Activity
        </button>
      )}
    </section>
  );
}

import React, { useLayoutEffect, useRef, useState } from 'react';

const SummaryStats = ({ stats }) => {
  const statsRef = useRef(null);
  const [isWrapped, setIsWrapped] = useState(false);

  useLayoutEffect(() => {
    const statsElement = statsRef.current;
    const summaryElement = statsElement?.previousElementSibling;
    const headerElement = statsElement?.parentElement;
    if (!statsElement || !summaryElement || !headerElement) return undefined;

    const updateWrappedState = () => {
      const statsTop = statsElement.getBoundingClientRect().top;
      const summaryBottom = summaryElement.getBoundingClientRect().bottom;
      setIsWrapped(statsTop >= summaryBottom - 1);
    };

    updateWrappedState();
    const observer = new ResizeObserver(updateWrappedState);
    observer.observe(headerElement);
    return () => observer.disconnect();
  }, []);

  return (
    <div
      ref={statsRef}
      className={`flex flex-wrap items-center gap-2 ${isWrapped ? 'justify-start' : 'ml-auto justify-end'}`}
    >
      {stats.map(({ label, value, valueClassName = 'font-money font-semibold text-primary' }) => (
        <div key={label} className="border border-border bg-surface-3 p-2">
          <p className="mb-0.5 text-caption uppercase text-tertiary">{label}</p>
          <p className={valueClassName}>{value}</p>
        </div>
      ))}
    </div>
  );
};

export default SummaryStats;

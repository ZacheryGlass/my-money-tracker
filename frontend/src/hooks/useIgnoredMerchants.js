import { useState } from 'react';
import { expenses as expensesAPI } from '../utils/api';

// State + actions behind the shared Ignored panel (IgnoredMerchantsModal).
// One ignore list backs both the Monthly Expenses and Top Merchants pages.
// `onRestored(result, item)` runs after a successful restore so the host page
// can refresh its own data and show its own success copy; `onError(message)`
// surfaces failures in the page's error slot.
export default function useIgnoredMerchants({ onRestored, onError } = {}) {
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [restoringKey, setRestoringKey] = useState(null);

  const fetchIgnored = async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await expensesAPI.getIgnored();
      setItems(data.ignored || []);
    } catch (err) {
      setItems([]);
      setError(err.response?.data?.error || 'Failed to load ignored charges');
    } finally {
      setLoading(false);
    }
  };

  const openPanel = () => {
    setOpen(true);
    fetchIgnored();
  };

  const restore = async (item) => {
    setRestoringKey(item.merchant_key);
    try {
      const res = await expensesAPI.restoreIgnored(item.merchant_key);
      await onRestored?.(res, item);
      await fetchIgnored();
    } catch (err) {
      onError?.(err.response?.data?.error || 'Failed to restore');
    } finally {
      setRestoringKey(null);
    }
  };

  return { open, openPanel, closePanel: () => setOpen(false), items, loading, error, restoringKey, restore };
}

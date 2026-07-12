import { useCallback, useEffect, useState } from 'react';
import {
  CHART_PREFERENCES_EVENT,
  loadChartPreferences,
  saveChartPreferences,
} from '../utils/chartPreferences';

export default function useChartPreferences() {
  const [preferences, setPreferences] = useState(loadChartPreferences);

  useEffect(() => {
    const refresh = () => setPreferences(loadChartPreferences());
    globalThis.window?.addEventListener('storage', refresh);
    globalThis.window?.addEventListener(CHART_PREFERENCES_EVENT, refresh);
    return () => {
      globalThis.window?.removeEventListener('storage', refresh);
      globalThis.window?.removeEventListener(CHART_PREFERENCES_EVENT, refresh);
    };
  }, []);

  const setChartEnabled = useCallback((chartId, enabled) => {
    setPreferences((current) => {
      const next = { ...current, [chartId]: enabled };
      saveChartPreferences(next);
      return next;
    });
  }, []);

  return { preferences, setChartEnabled };
}

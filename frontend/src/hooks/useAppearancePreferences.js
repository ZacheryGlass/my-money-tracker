import { useCallback, useEffect, useState } from 'react';
import {
  APPEARANCE_PREFERENCES_EVENT,
  applyAppearancePreferences,
  loadAppearancePreferences,
  saveAppearancePreferences,
} from '../utils/appearancePreferences';

export default function useAppearancePreferences() {
  const [preferences, setPreferences] = useState(loadAppearancePreferences);

  // Keep in sync across tabs/components, re-applying to the DOM on change.
  useEffect(() => {
    const refresh = () => {
      const next = loadAppearancePreferences();
      setPreferences(next);
      applyAppearancePreferences(next);
    };
    globalThis.window?.addEventListener('storage', refresh);
    globalThis.window?.addEventListener(APPEARANCE_PREFERENCES_EVENT, refresh);
    return () => {
      globalThis.window?.removeEventListener('storage', refresh);
      globalThis.window?.removeEventListener(APPEARANCE_PREFERENCES_EVENT, refresh);
    };
  }, []);

  // When following the OS ('system'), react to light/dark changes live.
  useEffect(() => {
    if (preferences.theme !== 'system') return undefined;
    const media = globalThis.matchMedia?.('(prefers-color-scheme: light)');
    if (!media) return undefined;
    const onChange = () => applyAppearancePreferences(loadAppearancePreferences());
    media.addEventListener('change', onChange);
    return () => media.removeEventListener('change', onChange);
  }, [preferences.theme]);

  const setPreference = useCallback((key, value) => {
    setPreferences((current) => {
      const next = { ...current, [key]: value };
      saveAppearancePreferences(next);
      applyAppearancePreferences(next);
      return next;
    });
  }, []);

  const setTheme = useCallback((value) => setPreference('theme', value), [setPreference]);
  const setFontScale = useCallback((value) => setPreference('fontScale', value), [setPreference]);
  const setFontFamily = useCallback((value) => setPreference('fontFamily', value), [setPreference]);

  return { preferences, setTheme, setFontScale, setFontFamily };
}

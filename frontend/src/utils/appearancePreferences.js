// Appearance preferences: theme, UI font size, and UI font family.
// Persisted to localStorage and applied to the document root via CSS custom
// properties so the semantic design tokens (index.css / tailwind.config.js)
// flip the whole UI without per-component changes.

export const APPEARANCE_THEMES = [
  { id: 'dark', label: 'Dark' },
  { id: 'light', label: 'Light' },
  { id: 'system', label: 'System' },
];

export const APPEARANCE_FONT_SIZES = [
  { id: 'sm', label: 'Small', scale: 0.9 },
  { id: 'base', label: 'Default', scale: 1 },
  { id: 'lg', label: 'Large', scale: 1.15 },
];

export const APPEARANCE_FONT_FAMILIES = [
  {
    id: 'system',
    label: 'System',
    stack: "-apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, Roboto, sans-serif",
  },
  {
    id: 'hyperlegible',
    label: 'Atkinson Hyperlegible',
    stack: "'Atkinson Hyperlegible', -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif",
  },
  {
    id: 'serif',
    label: 'Serif',
    stack: "Georgia, Cambria, 'Times New Roman', Times, serif",
  },
];

const STORAGE_KEY = 'appearance-preferences';
export const APPEARANCE_PREFERENCES_EVENT = 'appearance-preferences-changed';

export const DEFAULT_APPEARANCE_PREFERENCES = {
  theme: 'dark',
  fontScale: 'base',
  fontFamily: 'hyperlegible',
};

export function loadAppearancePreferences() {
  try {
    const saved = globalThis.localStorage?.getItem(STORAGE_KEY);
    return saved
      ? { ...DEFAULT_APPEARANCE_PREFERENCES, ...JSON.parse(saved) }
      : { ...DEFAULT_APPEARANCE_PREFERENCES };
  } catch {
    return { ...DEFAULT_APPEARANCE_PREFERENCES };
  }
}

export function saveAppearancePreferences(preferences) {
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(preferences));
    globalThis.window?.dispatchEvent(new Event(APPEARANCE_PREFERENCES_EVENT));
  } catch {
    // Preferences remain active for the current session if storage is unavailable.
  }
}

// Resolves the effective theme, honouring the OS preference when 'system'.
export function resolveTheme(theme) {
  if (theme === 'system') {
    const prefersLight = globalThis.matchMedia?.('(prefers-color-scheme: light)').matches;
    return prefersLight ? 'light' : 'dark';
  }
  return theme === 'light' ? 'light' : 'dark';
}

// Writes the preferences onto <html> so the CSS tokens take effect.
export function applyAppearancePreferences(preferences = loadAppearancePreferences()) {
  const root = globalThis.document?.documentElement;
  if (!root) return;

  const resolvedTheme = resolveTheme(preferences.theme);
  root.setAttribute('data-theme', resolvedTheme);
  root.style.colorScheme = resolvedTheme;

  const size = APPEARANCE_FONT_SIZES.find((option) => option.id === preferences.fontScale)
    || APPEARANCE_FONT_SIZES.find((option) => option.id === DEFAULT_APPEARANCE_PREFERENCES.fontScale);
  root.style.setProperty('--font-scale', String(size.scale));

  const family = APPEARANCE_FONT_FAMILIES.find((option) => option.id === preferences.fontFamily)
    || APPEARANCE_FONT_FAMILIES.find((option) => option.id === DEFAULT_APPEARANCE_PREFERENCES.fontFamily);
  root.style.setProperty('--font-ui', family.stack);
}

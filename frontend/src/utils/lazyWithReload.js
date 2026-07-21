import { lazy } from 'react';

const RELOAD_KEY = 'chunk-reload-at';
// If a reload was attempted within this window and the import still fails, the
// chunk is genuinely missing (not merely stale) — stop reloading and let the
// error surface instead of looping.
const RELOAD_WINDOW_MS = 10_000;

function recentlyReloaded() {
  try {
    const at = Number(window.sessionStorage.getItem(RELOAD_KEY));
    return at > 0 && Date.now() - at < RELOAD_WINDOW_MS;
  } catch {
    return false;
  }
}

function markReloaded() {
  try {
    window.sessionStorage.setItem(RELOAD_KEY, String(Date.now()));
  } catch {
    // sessionStorage unavailable (private mode / disabled) — skip the guard.
  }
}

// Retries a failed dynamic import by reloading the page once. A failed import is
// the usual symptom of a stale chunk after a redeploy, where the already-loaded
// app references asset hashes that no longer exist on the server; a full reload
// fetches the fresh index.html and asset map. Guarded by a timestamp so a
// genuinely missing chunk can't reload-loop; a later independent failure can
// still retry. Exported for testing.
export function reloadOnImportFailure(factory) {
  return () =>
    factory().catch((error) => {
      if (!recentlyReloaded()) {
        markReloaded();
        window.location.reload();
        // Hang until the reload navigates away so Suspense keeps showing the
        // fallback instead of briefly flashing an error.
        return new Promise(() => {});
      }
      throw error;
    });
}

// Drop-in for React.lazy that adds the stale-chunk reload recovery above.
export default function lazyWithReload(factory) {
  return lazy(reloadOnImportFailure(factory));
}

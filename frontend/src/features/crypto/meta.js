// The crypto registry facts (networks, explorers, vocabulary, venues), loaded
// once per session from GET /api/crypto/meta. utils/chains.js and
// utils/dataLabels.js read from here, so the client keeps no copy of these
// lists. Before the first load every lookup answers "unknown": no explorer
// link, the ETH default symbol, empty pickers.
import { useSyncExternalStore } from 'react';

let current = null;
let inflight = null;
const listeners = new Set();

export function setCryptoMeta(meta) {
  current = meta || null;
  for (const listener of listeners) listener();
}

export function getCryptoMeta() {
  return current;
}

function subscribe(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

// Re-renders the caller once the meta arrives.
export function useCryptoMeta() {
  return useSyncExternalStore(subscribe, getCryptoMeta, getCryptoMeta);
}

// One request at a time; a failure clears the in-flight promise so the next
// call retries.
export function loadCryptoMeta(fetcher) {
  if (current) return Promise.resolve(current);
  if (!inflight) {
    inflight = fetcher()
      .then((meta) => { inflight = null; setCryptoMeta(meta); return meta; })
      .catch((error) => { inflight = null; throw error; });
  }
  return inflight;
}

// Retries until the meta lands: every crypto picker and explorer link reads
// from it, so one failed boot request must not leave them empty for the rest
// of the session. Backoff doubles up to maxDelayMs; the returned function
// stops it.
export function keepLoadingCryptoMeta(fetcher, { firstDelayMs = 1000, maxDelayMs = 30000 } = {}) {
  let stopped = false;
  let timer = null;
  let delay = firstDelayMs;
  const attempt = () => {
    loadCryptoMeta(fetcher).catch(() => {
      if (stopped) return;
      timer = setTimeout(attempt, delay);
      delay = Math.min(delay * 2, maxDelayMs);
    });
  };
  attempt();
  return () => {
    stopped = true;
    clearTimeout(timer);
  };
}

export function networkById(chainId) {
  if (!current || chainId === null || chainId === undefined) return null;
  return current.networks.find((network) => network.id === Number(chainId)) || null;
}

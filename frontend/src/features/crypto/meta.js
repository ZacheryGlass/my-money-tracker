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

// One request per session; a failure clears the in-flight promise so a later
// call retries.
export function loadCryptoMeta(fetcher) {
  if (current) return Promise.resolve(current);
  if (!inflight) {
    inflight = fetcher()
      .then((meta) => { setCryptoMeta(meta); return meta; })
      .catch((error) => { inflight = null; throw error; });
  }
  return inflight;
}

export function networkById(chainId) {
  if (!current || chainId === null || chainId === undefined) return null;
  return current.networks.find((network) => network.id === Number(chainId)) || null;
}

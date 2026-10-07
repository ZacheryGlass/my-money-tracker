'use strict';

// Query parameters that carry a credential or a value derived from one.
// Binance.US signs the query string itself (signature + timestamp), Etherscan
// takes its key as `apikey`; other providers use the remaining spellings.
const SENSITIVE_QUERY_KEYS = /^(?:signature|sign|apikey|api_key|key|access_key|token|access_token|secret|timestamp|nonce|recvwindow)$/i;

// The URL with every sensitive query VALUE replaced, names kept so the log
// still says which request it was. A URL that does not parse is redacted by
// pattern rather than passed through.
function redactUrl(url) {
  if (url === null || url === undefined) return url;
  const text = String(url);
  const queryStart = text.indexOf('?');
  if (queryStart === -1) return text;
  const base = text.slice(0, queryStart);
  const [query, fragment] = text.slice(queryStart + 1).split('#', 2);
  const redacted = query.split('&').map((pair) => {
    const separator = pair.indexOf('=');
    const name = separator === -1 ? pair : pair.slice(0, separator);
    let decoded = name;
    try { decoded = decodeURIComponent(name); } catch { /* keep the raw name */ }
    return SENSITIVE_QUERY_KEYS.test(decoded) && separator !== -1 ? `${name}=REDACTED` : pair;
  }).join('&');
  return `${base}?${redacted}${fragment !== undefined ? `#${fragment}` : ''}`;
}

module.exports = { redactUrl, SENSITIVE_QUERY_KEYS };

'use strict';

/**
 * Strip the request context off an axios error before it propagates.
 *
 * An AxiosError carries `config` (headers, body) and `request` on itself AND on
 * `error.response`. pino's default `err` serializer copies every own enumerable
 * property, so a single logger.error({ err }) on a timeout writes the Kraken
 * `API-Key`/`API-Sign` headers -- or the Coinbase `Authorization: Bearer <jwt>`
 * -- into the log stream verbatim. Redaction in the logger config is the second
 * line of defence; this is the first, because an error that never carries the
 * credential cannot leak it through a serializer nobody thought about.
 *
 * What survives is what anyone debugging actually needs: the message, the code,
 * the method and URL, the status, and the response body (the provider's own
 * error fields). The URL is kept because these clients never put a secret in
 * one -- Kraken signs a POST body and Coinbase signs a header.
 *
 * Mutates and returns the error so `throw scrubHttpError(err)` keeps the
 * original type, stack and `code` that call sites match on.
 */
function scrubHttpError(err) {
  if (!err || typeof err !== 'object') return err;

  const method = err.config && err.config.method ? String(err.config.method).toUpperCase() : null;
  const url = err.config ? err.config.url ?? null : null;
  const status = err.response ? err.response.status ?? null : null;
  const data = err.response ? err.response.data : undefined;

  delete err.config;
  delete err.request;
  if (err.response) {
    // Rebuilt as a plain object: the real response holds its own `config` and
    // `request` references, so deleting only the top-level ones leaves the
    // headers reachable one hop away.
    err.response = { status, statusText: err.response.statusText ?? null, data };
  }
  if (method || url || status !== null) {
    err.request_summary = { method, url, status };
  }
  return err;
}

module.exports = scrubHttpError;

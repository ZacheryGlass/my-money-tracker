'use strict';

const pino = require('pino');

// Defence in depth for axios errors. Every HTTP client here (Kraken, Coinbase,
// Etherscan, Plaid) throws AxiosErrors, and pino's default `err` serializer
// copies own enumerable properties -- which includes `config.headers`, where
// the Kraken API-Key/API-Sign and the Coinbase `Authorization: Bearer <jwt>`
// live. The exchange clients also strip these at the throw site; this catches
// the clients that do not.
const REDACT_PATHS = [
  'err.config.headers',
  'err.config.data',
  'err.request',
  'err.response.config.headers',
  'error.config.headers',
  'error.request',
  'error.response.config.headers',
  'req.headers.authorization',
  'req.headers.cookie',
];

const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  // `remove` rather than a censor string: a redacted placeholder in a log line
  // still tells a reader a credential was there, and nothing downstream reads
  // these paths.
  redact: { paths: REDACT_PATHS, remove: true },
  // Pretty-print in dev; plain JSON in production for Azure log streaming
  transport: process.env.NODE_ENV !== 'production'
    ? { target: 'pino-pretty', options: { colorize: true, translateTime: 'SYS:standard' } }
    : undefined,
});

module.exports = logger;

'use strict';

const crypto = require('crypto');
const { Configuration, PlaidApi, PlaidEnvironments } = require('plaid');
const SecretsService = require('../services/SecretsService');

// Plaid credentials are per-user (Settings -> API Keys, env fallback), so the
// old require-time singleton became a small factory. Clients are cached per
// credential pair; PLAID_ENV stays a process-wide setting.

// Bounded: the key includes the credentials, so a rotated secret never reuses
// an old client -- but it does leave one behind, and each carries its own axios
// instance. Evicting the oldest entry keeps rotations from accumulating dead
// clients for the process lifetime. The cap is far above one client per user.
const MAX_CACHED_CLIENTS = 32;
const clientCache = new Map();

function buildPlaidClient(clientId, secret) {
  const cacheKey = `${clientId}:${crypto.createHash('sha256').update(secret).digest('hex').slice(0, 16)}`;
  if (clientCache.has(cacheKey)) return clientCache.get(cacheKey);

  if (clientCache.size >= MAX_CACHED_CLIENTS) {
    clientCache.delete(clientCache.keys().next().value);
  }

  const configuration = new Configuration({
    basePath: PlaidEnvironments[process.env.PLAID_ENV || 'sandbox'],
    baseOptions: {
      headers: {
        'PLAID-CLIENT-ID': clientId,
        'PLAID-SECRET': secret,
        'Plaid-Version': '2020-09-14',
      },
    },
  });
  const client = new PlaidApi(configuration);
  clientCache.set(cacheKey, client);
  return client;
}

async function getPlaidCredentialsForUser(userId) {
  const [clientId, secret] = await Promise.all([
    SecretsService.getUserKey(userId, 'plaid_client_id'),
    SecretsService.getUserKey(userId, 'plaid_secret'),
  ]);
  return { clientId, secret };
}

async function isPlaidConfiguredFor(userId) {
  const { clientId, secret } = await getPlaidCredentialsForUser(userId);
  return Boolean(clientId && secret);
}

async function getPlaidClientForUser(userId) {
  const { clientId, secret } = await getPlaidCredentialsForUser(userId);
  if (!clientId || !secret) {
    const error = new Error('Plaid is not configured. Add your Plaid client ID and secret under Settings -> API Keys.');
    error.code = 'PLAID_NOT_CONFIGURED';
    throw error;
  }
  return buildPlaidClient(clientId, secret);
}

module.exports = { getPlaidClientForUser, isPlaidConfiguredFor, buildPlaidClient };

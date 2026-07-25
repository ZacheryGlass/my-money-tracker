'use strict';

const express = require('express');
const requireUser = require('../middleware/auth');
const SecretsService = require('../services/SecretsService');
const secretCrypto = require('../utils/secretCrypto');
const logger = require('../config/logger');

const router = express.Router();

router.use(requireUser);

// Plaintext secrets are never returned by any endpoint here -- only
// {source, masked} statuses built from the stored last4.

function isUserService(service) {
  return SecretsService.USER_SERVICES.includes(service);
}

function isAppKey(service) {
  return SecretsService.APP_KEYS.includes(service);
}

// Shared app-wide keys are the admin's concern (Settings -> Server tab);
// non-admins only ever see their own key statuses.
async function buildStatuses(userId, isAdmin) {
  const userKeys = {};
  for (const service of SecretsService.USER_SERVICES) {
    userKeys[service] = await SecretsService.getUserKeyStatus(userId, service);
  }
  const statuses = { encryptionConfigured: secretCrypto.isConfigured(), userKeys };
  if (isAdmin) {
    statuses.appSettings = {};
    for (const key of SecretsService.APP_KEYS) {
      statuses.appSettings[key] = await SecretsService.getAppSettingStatus(key);
    }
  }
  return statuses;
}

router.get('/', async (req, res) => {
  try {
    res.status(200).json(await buildStatuses(req.user.id, req.user.isAdmin));
  } catch (error) {
    logger.error({ err: error }, 'Get key statuses error');
    res.status(500).json({ error: 'Failed to retrieve key statuses' });
  }
});

router.put('/:service', async (req, res) => {
  const { service } = req.params;
  try {
    if (!isUserService(service) && !isAppKey(service)) {
      return res.status(400).json({ error: 'Unknown service' });
    }
    if (isAppKey(service) && !req.user.isAdmin) {
      return res.status(403).json({ error: 'Only the admin can change shared keys' });
    }
    const { value } = req.body || {};
    if (typeof value !== 'string' || !value.trim() || value.trim().length > 512) {
      return res.status(400).json({ error: 'value is required (max 512 characters)' });
    }

    const status = isUserService(service)
      ? await SecretsService.setUserKey(req.user.id, service, value.trim())
      : await SecretsService.setAppSetting(service, value.trim());
    res.status(200).json({ service, ...status });
  } catch (error) {
    if (error.code === 'SECRETS_NOT_CONFIGURED') {
      return res.status(503).json({ error: 'SECRETS_ENCRYPTION_KEY is not configured on the server' });
    }
    logger.error({ err: error, service }, 'Set key error');
    res.status(500).json({ error: 'Failed to save key' });
  }
});

router.delete('/:service', async (req, res) => {
  const { service } = req.params;
  try {
    if (!isUserService(service) && !isAppKey(service)) {
      return res.status(400).json({ error: 'Unknown service' });
    }
    if (isAppKey(service) && !req.user.isAdmin) {
      return res.status(403).json({ error: 'Only the admin can change shared keys' });
    }

    const status = isUserService(service)
      ? await SecretsService.deleteUserKey(req.user.id, service)
      : await SecretsService.deleteAppSetting(service);
    res.status(200).json({ service, ...status });
  } catch (error) {
    if (error.code === 'SECRETS_NOT_CONFIGURED') {
      return res.status(503).json({ error: 'SECRETS_ENCRYPTION_KEY is not configured on the server' });
    }
    logger.error({ err: error, service }, 'Delete key error');
    res.status(500).json({ error: 'Failed to remove key' });
  }
});

module.exports = router;

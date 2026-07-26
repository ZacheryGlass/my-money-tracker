'use strict';

const express = require('express');
const requireUser = require('../middleware/auth');
const ExchangeAccount = require('../models/ExchangeAccount');
const ExchangeRecord = require('../models/ExchangeRecord');
const ExchangeImportService = require('../services/ExchangeImportService');
const ExchangeSyncService = require('../services/ExchangeSyncService');
const { ImportFormatError, FORMATS } = require('../services/exchangeImport');
const { CREDENTIAL_FIELDS, connectorFor } = require('../services/exchangeSync');
const secretCrypto = require('../utils/secretCrypto');
const logger = require('../config/logger');

const router = express.Router();

router.use(requireUser);

// A stored API key must never round-trip to the browser, so responses carry
// only {configured, masked} built from the last four characters -- exactly the
// contract the API Keys tab has. The encrypted columns are not even selected
// by the account reads these routes use (ExchangeAccount.PUBLIC_COLUMNS).
function credentialStatus(account) {
  return {
    configured: Boolean(account.api_configured),
    key_masked: secretCrypto.mask(account.api_key_last4),
    secret_masked: secretCrypto.mask(account.api_secret_last4),
  };
}

// Every failure mode of a credential write, mapped to the status that tells
// the user what to do about it. A 500 here reads as "the server is broken" and
// the user retries the same paste forever.
function respondToSyncError(res, error, fallback) {
  if (error.code === 'EXCHANGE_ACCOUNT_NOT_FOUND') {
    return res.status(404).json({ error: 'Exchange account not found' });
  }
  if (error.code === 'SECRETS_NOT_CONFIGURED') {
    return res.status(503).json({ error: 'SECRETS_ENCRYPTION_KEY is not configured on the server' });
  }
  if (error.code === 'EXCHANGE_NOT_SUPPORTED') {
    return res.status(400).json({ error: error.message, code: error.code });
  }
  if (error.code === 'EXCHANGE_NOT_CONFIGURED' || error.code === 'EXCHANGE_CREDENTIAL_UNREADABLE') {
    return res.status(409).json({ error: error.message, code: error.code });
  }
  // The provider's own refusal is the only thing that tells the user which
  // permission they forgot to tick, so it survives to the client verbatim.
  if (['KRAKEN_AUTH_FAILED', 'COINBASE_AUTH_FAILED', 'COINBASE_KEY_FORMAT'].includes(error.code)) {
    return res.status(400).json({ error: error.message, code: error.code });
  }
  if (['KRAKEN_RATE_LIMITED', 'COINBASE_RATE_LIMITED'].includes(error.code)) {
    return res.status(429).json({ error: error.message, code: error.code });
  }
  if (['KRAKEN_API_ERROR', 'COINBASE_API_ERROR'].includes(error.code)) {
    return res.status(502).json({ error: error.message, code: error.code });
  }
  logger.error({ err: error }, fallback);
  return res.status(500).json({ error: fallback });
}

function parseId(raw) {
  const id = Number.parseInt(raw, 10);
  return Number.isInteger(id) && id > 0 ? id : null;
}

// Every :id route resolves the account against the caller first, so a foreign
// or unparseable id is a 404 before any record is read or written.
async function loadAccount(req, res) {
  const id = parseId(req.params.id);
  const account = id ? await ExchangeAccount.findByIdForUser(id, req.user.id) : null;
  if (!account) {
    res.status(404).json({ error: 'Exchange account not found' });
    return null;
  }
  return account;
}

function validateAccountInput({ name, exchange }, { partial = false } = {}) {
  if (name !== undefined) {
    if (typeof name !== 'string' || !name.trim()) return 'name is required';
    if (name.trim().length > 120) return 'name must be 120 characters or fewer';
  } else if (!partial) {
    return 'name is required';
  }
  if (exchange !== undefined) {
    if (typeof exchange !== 'string' || !ExchangeAccount.EXCHANGES.has(exchange)) {
      return `exchange must be one of: ${[...ExchangeAccount.EXCHANGES].join(', ')}`;
    }
  }
  return null;
}

router.get('/', async (req, res) => {
  try {
    const accounts = await ExchangeAccount.findAllByUser(req.user.id);
    // formats (and the import route's format/mapping overrides) are API-level
    // affordances: the Settings uploader auto-detects, but a direct API caller
    // gets to name a parser or map columns for an export no parser knows.
    res.status(200).json({
      accounts: accounts.map((account) => ({ ...account, credentials: credentialStatus(account) })),
      formats: FORMATS,
      // What each venue's credential form should ask for and which read-only
      // permissions to grant. Served rather than hardcoded in the UI so the
      // guidance cannot drift from the connector that depends on it.
      credential_fields: CREDENTIAL_FIELDS,
      // Whether key storage is possible at all. The UI uses this to explain
      // itself up front instead of letting the user paste a key and collect a
      // 503.
      encryption_configured: secretCrypto.isConfigured(),
    });
  } catch (error) {
    logger.error({ err: error }, 'Get exchange accounts error');
    res.status(500).json({ error: 'Failed to retrieve exchange accounts' });
  }
});

router.post('/', async (req, res) => {
  try {
    const { name, exchange } = req.body || {};
    const invalid = validateAccountInput({ name, exchange });
    if (invalid) return res.status(400).json({ error: invalid });

    const account = await ExchangeAccount.create(req.user.id, {
      name: name.trim(),
      exchange: exchange || 'other',
    });
    res.status(201).json({ account });
  } catch (error) {
    // The per-user unique name is what keeps re-imports landing on the same
    // account; a duplicate is the user's mistake, not a server failure.
    if (error.code === '23505') {
      return res.status(409).json({ error: 'An exchange account with that name already exists' });
    }
    logger.error({ err: error }, 'Create exchange account error');
    res.status(500).json({ error: 'Failed to create exchange account' });
  }
});

router.patch('/:id', async (req, res) => {
  try {
    const account = await loadAccount(req, res);
    if (!account) return undefined;

    const { name, exchange } = req.body || {};
    const invalid = validateAccountInput({ name, exchange }, { partial: true });
    if (invalid) return res.status(400).json({ error: invalid });

    const updated = await ExchangeAccount.update(account.id, req.user.id, {
      name: typeof name === 'string' ? name.trim() : undefined,
      exchange,
    });
    return res.status(200).json({ account: updated });
  } catch (error) {
    if (error.code === '23505') {
      return res.status(409).json({ error: 'An exchange account with that name already exists' });
    }
    logger.error({ err: error, accountId: req.params.id }, 'Update exchange account error');
    return res.status(500).json({ error: 'Failed to update exchange account' });
  }
});

router.delete('/:id', async (req, res) => {
  try {
    const account = await loadAccount(req, res);
    if (!account) return undefined;

    // exchange_records go with it via ON DELETE CASCADE.
    await ExchangeAccount.delete(account.id, req.user.id);
    return res.status(200).json({ message: 'Exchange account deleted' });
  } catch (error) {
    logger.error({ err: error, accountId: req.params.id }, 'Delete exchange account error');
    return res.status(500).json({ error: 'Failed to delete exchange account' });
  }
});

router.get('/:id/records', async (req, res) => {
  try {
    const account = await loadAccount(req, res);
    if (!account) return undefined;

    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 100, 1), 500);
    const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
    const needsReview = req.query.needs_review === 'true' ? true
      : req.query.needs_review === 'false' ? false : null;

    const { records, total } = await ExchangeRecord.findForAccount(account.id, req.user.id, {
      limit, offset, needsReview,
    });
    return res.status(200).json({ data: records, pagination: { total, limit, offset } });
  } catch (error) {
    logger.error({ err: error, accountId: req.params.id }, 'Get exchange records error');
    return res.status(500).json({ error: 'Failed to retrieve exchange records' });
  }
});

// CSV upload. Raw text/csv is how this app already uploads a CSV (see the
// holdings bulk import), and a JSON body is accepted too so a caller can send
// the file alongside a format or column mapping.
router.post('/:id/import', express.text({ type: 'text/csv', limit: '10mb' }), async (req, res) => {
  try {
    const account = await loadAccount(req, res);
    if (!account) return undefined;

    const payload = typeof req.body === 'string' ? { csv: req.body } : (req.body || {});
    const csvText = typeof payload.csv === 'string' ? payload.csv : null;
    if (!csvText || !csvText.trim()) {
      return res.status(400).json({ error: 'No CSV data provided' });
    }

    const format = req.query.format || payload.format || 'auto';
    const mapping = payload.mapping && typeof payload.mapping === 'object' ? payload.mapping : undefined;

    const result = await ExchangeImportService.importCsv(req.user.id, account.id, csvText, { format, mapping });
    return res.status(200).json({ ...result, account_id: account.id });
  } catch (error) {
    // A file we cannot read is a 400 with the importer's own message: the user
    // is the only one who can pick a different export.
    if (error instanceof ImportFormatError || error.code === 'UNRECOGNIZED_CSV_FORMAT') {
      return res.status(400).json({ error: error.message, code: 'UNRECOGNIZED_CSV_FORMAT' });
    }
    // A value the table cannot hold -- a quantity past NUMERIC(38,18), a NUL in
    // a note -- is a fact about the file. As a 500 it reads as "the server is
    // broken" and the user retries the same upload forever; named, they can go
    // look at the row. The import stays all-or-nothing either way.
    if (ExchangeRecord.BAD_VALUE_CODES.has(error.code)) {
      const named = error.exchangeRecordExternalId ? ` (record ${error.exchangeRecordExternalId})` : '';
      const detail = error.exchangeRecordDetail ? `: ${error.exchangeRecordDetail}` : '';
      logger.warn({ err: error, accountId: req.params.id }, 'Exchange CSV import rejected an unstorable value');
      return res.status(400).json({
        error: `This file has a value that cannot be stored${named}${detail}. Nothing was imported.`,
        code: 'UNSTORABLE_VALUE',
      });
    }
    logger.error({ err: error, accountId: req.params.id }, 'Exchange CSV import error');
    return res.status(500).json({ error: 'Failed to import exchange records' });
  }
});

// --- API sync -------------------------------------------------------------
//
// The app calls READ endpoints only. Neither connector has a code path that
// can place an order or move funds -- the allowlists in krakenClient and
// coinbaseClient enforce it -- and the UI tells the user to create a
// read-only key regardless.

router.put('/:id/credentials', async (req, res) => {
  try {
    const account = await loadAccount(req, res);
    if (!account) return undefined;

    const { api_key: apiKey, api_secret: apiSecret } = req.body || {};
    for (const [label, value] of [['api_key', apiKey], ['api_secret', apiSecret]]) {
      if (typeof value !== 'string' || !value.trim()) {
        return res.status(400).json({ error: `${label} is required` });
      }
      // Kraken private keys are ~88 chars; a Coinbase ECDSA PEM is ~240.
      if (value.trim().length > 4096) {
        return res.status(400).json({ error: `${label} is too long` });
      }
    }

    const updated = await ExchangeSyncService.setCredentials(req.user.id, account.id, {
      apiKey: apiKey.trim(),
      apiSecret: apiSecret.trim(),
    });
    return res.status(200).json({ account: updated, credentials: credentialStatus(updated) });
  } catch (error) {
    return respondToSyncError(res, error, 'Failed to save exchange credentials');
  }
});

// Disconnecting keeps every record already imported. The history is exactly
// the part no live connection can recover once the key is gone.
router.delete('/:id/credentials', async (req, res) => {
  try {
    const account = await loadAccount(req, res);
    if (!account) return undefined;

    const updated = await ExchangeSyncService.clearCredentials(req.user.id, account.id);
    return res.status(200).json({ account: updated, credentials: credentialStatus(updated) });
  } catch (error) {
    return respondToSyncError(res, error, 'Failed to remove exchange credentials');
  }
});

// One authenticated read and nothing else -- Kraken's Balance, Coinbase's
// accounts list. Separating "the key is stored" from "the key works" is the
// whole point: otherwise the first evidence of a bad key is a failed sync
// hours later, with no clue which permission was missing.
router.post('/:id/test', async (req, res) => {
  try {
    const account = await loadAccount(req, res);
    if (!account) return undefined;

    const result = await ExchangeSyncService.testConnection(req.user.id, account.id);
    return res.status(200).json(result);
  } catch (error) {
    return respondToSyncError(res, error, 'Failed to test the exchange connection');
  }
});

router.post('/:id/sync', async (req, res) => {
  try {
    const account = await loadAccount(req, res);
    if (!account) return undefined;
    if (!connectorFor(account.exchange)) {
      return res.status(400).json({
        error: `There is no API sync for "${account.exchange}" accounts; use CSV import instead`,
        code: 'EXCHANGE_NOT_SUPPORTED',
      });
    }

    // interactive: a request is waiting, so the page budget is sized to finish
    // inside a proxy timeout. A history longer than that budget comes back
    // with backfill_pending set rather than being silently cut short.
    const result = await ExchangeSyncService.syncAccount(req.user.id, account.id, { interactive: true });
    return res.status(200).json({ ...result, account_id: account.id });
  } catch (error) {
    return respondToSyncError(res, error, 'Failed to sync the exchange account');
  }
});

// Clearing the flag by hand is the only thing that empties the review queue:
// nothing else ever writes needs_review = false, so without this the badge is
// permanent and gets ignored, taking the flagged rows with it.
router.patch('/:id/records/:recordId/resolve', async (req, res) => {
  try {
    const account = await loadAccount(req, res);
    if (!account) return undefined;

    const recordId = parseId(req.params.recordId);
    // The UPDATE joins through the account, so a record belonging to another
    // account -- or another user -- matches nothing and looks like a typo.
    const record = recordId
      ? await ExchangeRecord.resolveReview(recordId, account.id, req.user.id)
      : null;
    if (!record) return res.status(404).json({ error: 'Exchange record not found' });

    return res.status(200).json({ record });
  } catch (error) {
    logger.error({ err: error, accountId: req.params.id, recordId: req.params.recordId },
      'Resolve exchange record error');
    return res.status(500).json({ error: 'Failed to resolve exchange record' });
  }
});

module.exports = router;

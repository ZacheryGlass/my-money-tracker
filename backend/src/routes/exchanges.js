'use strict';

const express = require('express');
const requireUser = require('../middleware/auth');
const ExchangeAccount = require('../models/ExchangeAccount');
const ExchangeRecord = require('../models/ExchangeRecord');
const ExchangeImportService = require('../services/ExchangeImportService');
const { ImportFormatError, FORMATS } = require('../services/exchangeImport');
const logger = require('../config/logger');

const router = express.Router();

router.use(requireUser);

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
    res.status(200).json({ accounts, formats: FORMATS });
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

'use strict';

const express = require('express');
const requireUser = require('../middleware/auth');
const ExchangeAccount = require('../models/ExchangeAccount');
const ExchangeRecord = require('../models/ExchangeRecord');
const ExchangeMatch = require('../models/ExchangeMatch');
const ExchangeSyncJob = require('../models/ExchangeSyncJob');
const ExchangeImportService = require('../services/ExchangeImportService');
const ExchangeSyncService = require('../services/ExchangeSyncService');
const ExchangeBackfillService = require('../services/ExchangeBackfillService');
const ExchangeMatchService = require('../services/ExchangeMatchService');
const ExchangeBalanceReconciliation = require('../models/ExchangeBalanceReconciliation');
const ExchangeFiatMatch = require('../models/ExchangeFiatMatch');
const chains = require('../config/chains');
const { ImportFormatError, FORMATS } = require('../services/exchangeImport');
const { CREDENTIAL_FIELDS, connectorFor } = require('../services/exchangeSync');
const secretCrypto = require('../utils/secretCrypto');
const { toCsv } = require('../utils/csv');
const { cleanAmount } = require('../services/exchangeImport/shared');
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
  if (error.code === 'EXCHANGE_NOT_CONFIGURED'
    || error.code === 'EXCHANGE_CREDENTIAL_UNREADABLE'
    || error.code === 'EXCHANGE_SYNC_IN_PROGRESS') {
    return res.status(409).json({ error: error.message, code: error.code });
  }
  // The provider's own refusal is the only thing that tells the user which
  // permission they forgot to tick, so it survives to the client verbatim.
  if (['KRAKEN_AUTH_FAILED', 'COINBASE_AUTH_FAILED', 'COINBASE_KEY_FORMAT', 'BINANCE_US_AUTH_FAILED'].includes(error.code)) {
    return res.status(400).json({ error: error.message, code: error.code });
  }
  if (['KRAKEN_RATE_LIMITED', 'COINBASE_RATE_LIMITED', 'BINANCE_US_RATE_LIMITED'].includes(error.code)) {
    return res.status(429).json({ error: error.message, code: error.code });
  }
  if (['KRAKEN_API_ERROR', 'COINBASE_API_ERROR', 'BINANCE_US_API_ERROR'].includes(error.code)) {
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

function validateAccountInput({ name, exchange, records_unavailable }, { partial = false } = {}) {
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
  if (records_unavailable !== undefined && typeof records_unavailable !== 'boolean') {
    return 'records_unavailable must be a boolean';
  }
  return null;
}

function validateExceptionUpdate(body) {
  const status = typeof body.status === 'string' ? body.status.trim().toLowerCase() : '';
  if (!['open', 'accepted'].includes(status)) {
    return { error: 'status must be open or accepted' };
  }
  const category = body.category === null || body.category === undefined || body.category === ''
    ? null : String(body.category).trim().toLowerCase();
  if (category && !ExchangeBalanceReconciliation.CATEGORIES.has(category)) {
    return { error: `category must be one of: ${[...ExchangeBalanceReconciliation.CATEGORIES].join(', ')}` };
  }
  const evidence = body.evidence === null || body.evidence === undefined
    ? null : body.evidence;
  if (evidence !== null && typeof evidence !== 'string') return { error: 'evidence must be a string' };
  const trimmedEvidence = evidence?.trim() || null;
  if (status === 'accepted' && (!category || !trimmedEvidence)) {
    return { error: 'category and evidence are required to accept an exception' };
  }
  if (!Number.isInteger(body.version) && !(typeof body.version === 'string' && /^[1-9]\d*$/.test(body.version))) {
    return { error: 'version must be a positive integer' };
  }
  const version = Number(body.version);
  if (!Number.isSafeInteger(version) || version < 1 || version > 2147483647) {
    return { error: 'version must be a positive integer' };
  }
  if (typeof body.adjustment !== 'string') {
    return { error: 'adjustment must be an exact decimal string' };
  }
  const adjustment = cleanAmount(body.adjustment);
  if (adjustment === null) return { error: 'adjustment must be a valid decimal amount' };
  const fractionLength = String(adjustment).split('.')[1]?.length || 0;
  const digitLength = String(adjustment).replace('-', '').replace('.', '').length;
  if (fractionLength > 18 || digitLength > 38) {
    return { error: 'adjustment exceeds the supported 38,18 precision' };
  }
  if (status === 'open' && adjustment !== '0') {
    return { error: 'adjustment can only be applied to an accepted exception' };
  }
  if (adjustment !== '0' && !trimmedEvidence) {
    return { error: 'a nonzero adjustment requires an evidence note' };
  }
  return {
    value: { version, status, category, evidence: trimmedEvidence, adjustment },
  };
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

// Durable balance exceptions are separate from the legacy balance_report. The
// default queue excludes system-cleared rows; callers can request one status
// explicitly for audit/history views.
router.get('/balance-exceptions', async (req, res) => {
  try {
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 500);
    const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
    const status = req.query.status ? String(req.query.status).trim().toLowerCase() : null;
    if (status && !['open', 'accepted', 'cleared'].includes(status)) {
      return res.status(400).json({ error: 'status must be open, accepted, or cleared' });
    }
    const [{ rows, total }, summary] = await Promise.all([
      ExchangeBalanceReconciliation.findForUser(req.user.id, { status, limit, offset }),
      ExchangeBalanceReconciliation.summaryForUser(req.user.id),
    ]);
    return res.status(200).json({
      data: rows,
      summary,
      pagination: { total, limit, offset },
    });
  } catch (error) {
    logger.error({ err: error }, 'Get exchange balance exceptions error');
    return res.status(500).json({ error: 'Failed to retrieve exchange balance exceptions' });
  }
});

router.get('/fiat-matches', async (req, res) => {
  try {
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 100, 1), 500);
    const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
    const result = await ExchangeFiatMatch.findForUser(req.user.id, { limit, offset });
    return res.status(200).json({ data: result.matches, pagination: { total: result.total, limit, offset } });
  } catch (error) {
    logger.error({ err: error }, 'Get exchange fiat matches error');
    return res.status(500).json({ error: 'Failed to retrieve exchange fiat matches' });
  }
});

router.patch('/balance-exceptions/:exceptionId', async (req, res) => {
  try {
    const exceptionId = parseId(req.params.exceptionId);
    if (!exceptionId) return res.status(404).json({ error: 'Exchange balance exception not found' });
    const parsed = validateExceptionUpdate(req.body || {});
    if (parsed.error) return res.status(400).json({ error: parsed.error });
    const result = await ExchangeBalanceReconciliation.updateForUser(
      req.user.id, exceptionId, parsed.value
    );
    if (result.stale) {
      return res.status(409).json({
        error: 'This exchange balance exception changed since it was opened; refresh before saving',
        code: 'EXCHANGE_BALANCE_EXCEPTION_STALE',
        version: result.currentVersion,
      });
    }
    if (!result.row) return res.status(404).json({ error: 'Exchange balance exception not found' });
    await ExchangeBalanceReconciliation.refreshAccountStatusForUser(req.user.id, result.row.exchange_account_id);
    const exception = await ExchangeBalanceReconciliation.findByIdForUser(req.user.id, exceptionId);
    return res.status(200).json({ exception });
  } catch (error) {
    logger.error({ err: error, exceptionId: req.params.exceptionId },
      'Update exchange balance exception error');
    return res.status(500).json({ error: 'Failed to update the exchange balance exception' });
  }
});

// --- matching (#61) --------------------------------------------------------
//
// Registered BEFORE the '/:id' routes: '/matches' is a literal that must never
// be read as an account id. It cannot be today (no route is a bare GET '/:id'),
// and this ordering is what keeps that true when one is added.

const VERDICTS = new Set(['confirmed', 'rejected']);
const TX_HASH_RE = /^0x[0-9a-f]{64}$/i;

// A verdict names exactly one pair, in one of the two shapes 041 allows: an
// on-chain match (wallet + chain + hash) or an exchange-to-exchange pair (the
// far record). Accepting both at once, or neither, is a 400 rather than a
// guess -- the CHECK constraint would reject it anyway, as a 500.
function parseVerdictTarget(source) {
  const exchangeRecordId = parseId(source.exchange_record_id);
  if (!exchangeRecordId) return { error: 'exchange_record_id is required' };

  const hasCounter = source.counter_record_id !== undefined && source.counter_record_id !== null && source.counter_record_id !== '';
  const hasOnChain = (source.wallet_id !== undefined && source.wallet_id !== null && source.wallet_id !== '')
    || (source.tx_hash !== undefined && source.tx_hash !== null && source.tx_hash !== '');

  if (hasCounter === hasOnChain) {
    return { error: 'Provide either counter_record_id (an exchange-to-exchange pair) or wallet_id + tx_hash (an on-chain match)' };
  }

  if (hasCounter) {
    const counterRecordId = parseId(source.counter_record_id);
    if (!counterRecordId) return { error: 'counter_record_id must be a positive integer' };
    if (counterRecordId === exchangeRecordId) {
      return { error: 'counter_record_id must be a different record' };
    }
    return { target: { exchangeRecordId, counterRecordId } };
  }

  const walletId = parseId(source.wallet_id);
  if (!walletId) return { error: 'wallet_id must be a positive integer' };
  const txHash = typeof source.tx_hash === 'string' ? source.tx_hash.trim().toLowerCase() : '';
  if (!TX_HASH_RE.test(txHash)) {
    return { error: 'tx_hash must be a 0x-prefixed 64-hex-character transaction hash' };
  }
  // Any positive integer, not just an enabled chain: rows from a since-disabled
  // chain stay stored, so their verdicts stay writable.
  const chainId = source.chain_id === undefined || source.chain_id === null || source.chain_id === ''
    ? chains.DEFAULT_CHAIN_ID
    : Number(source.chain_id);
  if (!Number.isInteger(chainId) || chainId < 1) {
    return { error: 'chain_id must be a positive integer' };
  }
  return { target: { exchangeRecordId, walletId, chainId, txHash } };
}

// Every active match plus the separate review suggestions, with both sides
// described. Only `data` is folded in the ledger; `suggestions` stays inert
// until the user confirms it. An active Coinbase -> Kraken transfer reads as
// ONE movement: the withdrawal and deposit side by side, with no on-chain leg
// because there never was one.
//
// The Crypto Exchanges panel consumes this list for its match-audit drawer;
// POST/DELETE /matches/verdict remain the durable confirm/reject controls.
router.get('/matches', async (req, res) => {
  try {
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 100, 1), 500);
    const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);

    const [{ matches, total }, { suggestions, total: suggestionTotal }, summary] = await Promise.all([
      ExchangeMatch.findForUser(req.user.id, { limit, offset }),
      ExchangeMatch.findSuggestionsForUser(req.user.id, { limit, offset }),
      ExchangeMatch.summaryForUser(req.user.id),
    ]);

    return res.status(200).json({
      data: matches,
      suggestions,
      summary,
      pagination: { total, suggestion_total: suggestionTotal, limit, offset },
    });
  } catch (error) {
    logger.error({ err: error }, 'Get exchange matches error');
    return res.status(500).json({ error: 'Failed to retrieve exchange matches' });
  }
});

// Immutable rebuild events explain why an older derived match disappeared.
router.get('/matches/events', async (req, res) => {
  try {
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 100, 1), 500);
    const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
    const { events, total } = await ExchangeMatch.eventsForUser(req.user.id, { limit, offset });
    return res.status(200).json({ data: events, pagination: { total, limit, offset } });
  } catch (error) {
    logger.error({ err: error }, 'Get exchange match events error');
    return res.status(500).json({ error: 'Failed to retrieve exchange match events' });
  }
});

// A repeatable, reviewable export of the derived pairings. Unmatched sides are
// intentionally not fabricated into rows here: the JSON summary beside this
// export reports those counts, while this file contains only pairings with the
// exact evidence the matcher stored. That keeps a spreadsheet audit from
// reading an unmatched exchange record as if it had an on-chain partner.
router.get('/matches/export', async (req, res) => {
  try {
    const { matches } = await ExchangeMatch.findForUser(req.user.id, { limit: 50000, offset: 0 });
    const headers = [
      ['id', 'match_id'],
      ['exchange_record_id', 'exchange_record_id'],
      ['counter_record_id', 'counter_record_id'],
      ['activity_id', 'activity_id'],
      ['match_method', 'match_method'],
      ['confidence', 'confidence'],
      ['rule_version', 'rule_version'],
      ['comparison_kind', 'comparison_kind'],
      ['comparison_left_amount', 'comparison_left_amount'],
      ['comparison_right_amount', 'comparison_right_amount'],
      ['fee_amount_applied', 'fee_amount_applied'],
      ['amount_delta', 'amount_delta'],
      ['amount_tolerance', 'amount_tolerance'],
      ['magnitude_ratio', 'magnitude_ratio'],
      ['address_match', 'address_match'],
      ['time_delta_seconds', 'time_delta_seconds'],
      ['verdict', 'verdict'],
      ['verdict_note', 'verdict_note'],
      ['record_type', 'record_type'],
      ['occurred_at', 'exchange_occurred_at'],
      ['base_asset', 'exchange_asset'],
      ['base_amount', 'exchange_amount'],
      ['record_tx_hash', 'exchange_tx_hash'],
      ['record_address', 'exchange_address'],
      ['record_network', 'exchange_network'],
      ['record_chain_id', 'exchange_chain_id'],
      ['exchange_account_name', 'exchange_account'],
      ['counter_record_type', 'counter_record_type'],
      ['counter_occurred_at', 'counter_occurred_at'],
      ['counter_base_asset', 'counter_asset'],
      ['counter_base_amount', 'counter_amount'],
      ['counter_account_name', 'counter_exchange_account'],
      ['wallet_id', 'wallet_id'],
      ['chain_id', 'on_chain_chain_id'],
      ['tx_hash', 'on_chain_tx_hash'],
      ['block_time', 'on_chain_block_time'],
      ['category', 'on_chain_category'],
    ];
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="exchange-match-audit.csv"');
    res.setHeader('X-Match-Count', String(matches.length));
    return res.status(200).send(toCsv(matches, headers));
  } catch (error) {
    logger.error({ err: error }, 'Export exchange matches error');
    return res.status(500).json({ error: 'Failed to export exchange matches' });
  }
});

// Confirm or reject a match. Stored in its own table so the rebuild cannot
// erase it -- the same reason eth_activity_overrides is a second table -- and
// re-derived immediately so the answer is visible on the next read.
router.post('/matches/verdict', async (req, res) => {
  try {
    const body = req.body || {};
    const { target, error: invalid } = parseVerdictTarget(body);
    if (invalid) return res.status(400).json({ error: invalid });

    const verdict = typeof body.verdict === 'string' ? body.verdict.trim().toLowerCase() : '';
    if (!VERDICTS.has(verdict)) {
      return res.status(400).json({ error: `verdict must be one of: ${[...VERDICTS].join(', ')}` });
    }
    if (body.note !== undefined && body.note !== null && typeof body.note !== 'string') {
      return res.status(400).json({ error: 'note must be a string' });
    }

    // A verdict about something the user cannot see would be stored and then
    // invisible forever -- exactly the trap the activity override route 404s
    // for. Both sides are checked, so a foreign record id is a 404 too.
    const { exists, records } = await ExchangeMatch.verdictTargetExists(req.user.id, target);
    if (!exists) {
      return res.status(404).json({ error: 'No match found for that record and transaction' });
    }

    // Shape, not just ownership. Only a transfer can be half of a movement: a
    // trade or a reward has no counterpart to be the same money as, and the
    // matcher would never propose one -- so confirming it stores an answer to a
    // question that cannot be asked. The derived side enforces this in SQL
    // (MATCHABLE_RECORD_TYPES); a manual verdict has to enforce it here.
    const matchable = new Set(ExchangeMatch.MATCHABLE_RECORD_TYPES);
    const anchor = records.get(target.exchangeRecordId);
    const counter = target.counterRecordId ? records.get(target.counterRecordId) : null;
    for (const record of [anchor, counter]) {
      if (record && !matchable.has(record.record_type)) {
        return res.status(400).json({
          error: `Only ${[...matchable].join(' and ')} records can be matched; record ${record.id} is a ${record.record_type}`,
        });
      }
    }
    // And a pair runs one way: money leaves the sending venue and arrives at
    // the receiving one. The derived pair query anchors on the WITHDRAWAL for
    // exactly this reason -- one identity per movement instead of two orderings
    // of the same two ids -- and a verdict stored the other way round would
    // never line up with the match it is supposed to confirm or suppress.
    if (counter && !(anchor?.record_type === 'withdrawal' && counter.record_type === 'deposit')) {
      return res.status(400).json({
        error: 'A pair runs withdrawal -> deposit: exchange_record_id must be the withdrawal and counter_record_id the deposit',
      });
    }

    // Two confirmations claiming the same record is the same money explained
    // twice. They sit under different unique keys, so the database takes both
    // and selectMatches then drops one by an ordering the user never sees.
    if (verdict === 'confirmed') {
      const conflict = await ExchangeMatch.findConflictingConfirmation(req.user.id, target);
      if (conflict) {
        return res.status(409).json({
          error: 'Another confirmed match already claims one of these records; remove that verdict first',
          conflict,
        });
      }
    }

    const saved = await ExchangeMatch.upsertVerdict(req.user.id, {
      ...target,
      verdict,
      note: body.note?.trim() || null,
    });
    if (!saved) return res.status(404).json({ error: 'Exchange record not found' });

    const result = await ExchangeMatchService.rebuildForUserSafely(req.user.id);
    return res.status(201).json({ verdict: saved, matches: result?.matches ?? null });
  } catch (error) {
    logger.error({ err: error }, 'Set exchange match verdict error');
    return res.status(500).json({ error: 'Failed to save the match verdict' });
  }
});

// Undoing a verdict uncovers whatever the matcher derives on its own.
router.delete('/matches/verdict', async (req, res) => {
  try {
    const { target, error: invalid } = parseVerdictTarget(req.query || {});
    if (invalid) return res.status(400).json({ error: invalid });

    const removed = await ExchangeMatch.deleteVerdict(req.user.id, target);
    if (!removed) return res.status(404).json({ error: 'Match verdict not found' });

    await ExchangeMatchService.rebuildForUserSafely(req.user.id);
    return res.status(200).json({ message: 'Match verdict removed' });
  } catch (error) {
    logger.error({ err: error }, 'Remove exchange match verdict error');
    return res.status(500).json({ error: 'Failed to remove the match verdict' });
  }
});

router.patch('/:id', async (req, res) => {
  try {
    const account = await loadAccount(req, res);
    if (!account) return undefined;

    const { name, exchange, records_unavailable: recordsUnavailable } = req.body || {};
    const invalid = validateAccountInput({ name, exchange, records_unavailable: recordsUnavailable }, { partial: true });
    if (invalid) return res.status(400).json({ error: invalid });
    if (exchange !== undefined && exchange !== account.exchange
      && await ExchangeSyncJob.hasActiveForAccount(account.id)) {
      return res.status(409).json({
        error: 'Wait for the exchange sync to finish before changing the provider',
        code: 'EXCHANGE_SYNC_IN_PROGRESS',
      });
    }

    const updated = await ExchangeAccount.update(account.id, req.user.id, {
      name: typeof name === 'string' ? name.trim() : undefined,
      exchange,
      recordsUnavailable,
    });
    if (!updated) {
      if (exchange !== undefined && exchange !== account.exchange) {
        return res.status(409).json({
          error: 'The exchange cannot be changed after credentials or records exist; create a new account instead',
          code: 'EXCHANGE_ACCOUNT_LOCKED',
        });
      }
      return res.status(404).json({ error: 'Exchange account not found' });
    }
    if (recordsUnavailable !== undefined) {
      // The account limitation is evidence used by the exchange-flow review
      // pass. Rebuild before responding so the UI's immediate refetch sees the
      // explained-with-gap state (or the review flag restored when reversed).
      await ExchangeMatchService.rebuildForUserSafely(req.user.id, {
        exchangeAccountId: account.id,
      });
    }
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

    // exchange_records go with it via ON DELETE CASCADE, and exchange_matches
    // with them -- so there is no such thing as a dangling link here.
    await ExchangeAccount.delete(account.id, req.user.id);
    // What the cascade CANNOT do is put the on-chain half back in the review
    // queue: those activity rows had needs_review cleared because a record
    // explained them, and that record is now gone. Re-deriving restores the
    // flag (#61's acceptance criterion) instead of leaving a transfer marked
    // explained by evidence that no longer exists.
    await ExchangeMatchService.rebuildForUserSafely(req.user.id, { exchangeAccountId: account.id });
    return res.status(200).json({ message: 'Exchange account deleted' });
  } catch (error) {
    logger.error({ err: error, accountId: req.params.id }, 'Delete exchange account error');
    return res.status(500).json({ error: 'Failed to delete exchange account' });
  }
});

router.get('/:id/balance-exceptions', async (req, res) => {
  try {
    const account = await loadAccount(req, res);
    if (!account) return undefined;
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 500);
    const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
    const status = req.query.status ? String(req.query.status).trim().toLowerCase() : null;
    if (status && !['open', 'accepted', 'cleared'].includes(status)) {
      return res.status(400).json({ error: 'status must be open, accepted, or cleared' });
    }
    const [{ rows, total }, summary] = await Promise.all([
      ExchangeBalanceReconciliation.findForUser(req.user.id, {
        exchangeAccountId: account.id, status, limit, offset,
      }),
      ExchangeBalanceReconciliation.summaryForUser(req.user.id, { exchangeAccountId: account.id }),
    ]);
    return res.status(200).json({
      account_id: account.id,
      data: rows,
      summary,
      pagination: { total, limit, offset },
    });
  } catch (error) {
    logger.error({ err: error, accountId: req.params.id }, 'Get account balance exceptions error');
    return res.status(500).json({ error: 'Failed to retrieve account balance exceptions' });
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
    if (error.code === 'EXCHANGE_SYNC_IN_PROGRESS') {
      return res.status(409).json({ error: error.message, code: error.code });
    }
    if (error.code === 'EXCHANGE_ACCOUNT_NOT_FOUND') {
      return res.status(404).json({ error: error.message, code: error.code });
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

    // A caller that cannot use the explicit /sync/start route can opt into the
    // same durable behavior without changing the legacy bounded response for
    // existing API clients.
    if (req.query.background === 'true') {
      const job = await ExchangeBackfillService.enqueue(req.user.id, account.id);
      return res.status(202).json({ job, account_id: account.id });
    }

    // interactive: a request is waiting, so the page budget is sized to finish
    // inside a proxy timeout. A history longer than that budget comes back
    // with backfill_pending set rather than being silently cut short.
    const result = await ExchangeSyncService.syncAccount(req.user.id, account.id, { interactive: true });
    // Preserve the old bounded receipt, but never strand a partial history for
    // API clients that still call this endpoint. The continuation is queued
    // only after the bounded pass releases the account lock.
    const continuation = result.backfill_pending
      ? await ExchangeBackfillService.enqueue(req.user.id, account.id)
      : null;
    return res.status(200).json({
      ...result,
      account_id: account.id,
      ...(continuation ? { job: continuation } : {}),
    });
  } catch (error) {
    return respondToSyncError(res, error, 'Failed to sync the exchange account');
  }
});

// The interactive endpoint above is deliberately retained for API clients
// that need one bounded pass and its detailed receipt. The app's Sync Now
// button uses the durable background contract below: the HTTP request only
// queues work, so a years-long history cannot be cut off by a proxy timeout.
router.post('/:id/sync/start', async (req, res) => {
  try {
    const account = await loadAccount(req, res);
    if (!account) return undefined;
    if (!connectorFor(account.exchange)) {
      return res.status(400).json({
        error: `There is no API sync for "${account.exchange}" accounts; use CSV import instead`,
        code: 'EXCHANGE_NOT_SUPPORTED',
      });
    }

    const job = await ExchangeBackfillService.enqueue(req.user.id, account.id);
    return res.status(202).json({ job, account_id: account.id });
  } catch (error) {
    return respondToSyncError(res, error, 'Failed to start the exchange backfill');
  }
});

// Pollable, user-scoped progress. A completed job is returned as well as an
// active one, which lets the UI say "done" after a reload instead of silently
// dropping back to the last account timestamp.
router.get('/:id/sync-status', async (req, res) => {
  try {
    const account = await loadAccount(req, res);
    if (!account) return undefined;
    const job = await ExchangeBackfillService.status(req.user.id, account.id);
    return res.status(200).json({ job, account_id: account.id });
  } catch (error) {
    return respondToSyncError(res, error, 'Failed to read the exchange backfill status');
  }
});

// A manual review accepts the imported event as stored. Candidate review also
// clears the candidate badge; derived matching evidence never owns this queue.
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

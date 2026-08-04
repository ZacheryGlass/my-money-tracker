'use strict';

const express = require('express');
const requireUser = require('../middleware/auth');
const CryptoLedger = require('../models/CryptoLedger');
const EthWallet = require('../models/EthWallet');
const ExchangeAccount = require('../models/ExchangeAccount');
const EthBridgeMovement = require('../models/EthBridgeMovement');
const BridgeMatchingService = require('../services/BridgeMatchingService');
const EthDerivedPipeline = require('../services/EthDerivedPipeline');
const pool = require('../config/database');
const chains = require('../config/chains');
const logger = require('../config/logger');
const { toCsv } = require('../utils/csv');
const { shortAddress } = require('../utils/ethAddress');

const router = express.Router();

router.use(requireUser);

const CATEGORIES = new Set(CryptoLedger.CATEGORIES);
const SOURCES = new Set(CryptoLedger.SOURCES);
// Three-valued, spelled exactly as GET /api/eth/activity spells it: the two
// screens read the same quarantined rows, and a vocabulary that drifted would
// 400 on one page and work on the other.
const SPAM_FILTERS = new Set(CryptoLedger.SPAM_FILTERS);

// The whole filtered ledger has to fit in memory to be serialized, so the
// export is capped and SAYS SO in the response headers when it truncates. A
// silent cut looks exactly like "that is all the history there is", which is
// the one thing a ledger export must never imply.
const EXPORT_LIMIT = 50000;

function parseId(raw) {
  const id = Number.parseInt(raw, 10);
  return Number.isInteger(id) && id > 0 ? id : null;
}

// Every filter is fail-closed: an unknown value is a 400, never a silently
// unfiltered feed. `?category=stakingreward` quietly returning EVERYTHING reads
// as "there is nothing else", which is the opposite of what a filter over a
// review queue promises. Same contract as GET /api/eth/activity.
//
// Returns { error } for a rejected request, { filters } otherwise.
async function parseFilters(req) {
  const filters = {
    category: null, needsReview: null, source: null, walletId: null, exchangeAccountId: null,
    // Quarantined spam (#74) is hidden by default -- that IS the quarantine --
    // and reachable with ?spam=only. The ledger is the flagship "no transaction
    // unexplained" screen, so rendering the noise 045 removed as ordinary
    // events here would undo the quarantine on the one page it matters most.
    spam: 'exclude',
  };

  if (req.query.spam !== undefined && req.query.spam !== '') {
    const spam = String(req.query.spam).trim().toLowerCase();
    if (!SPAM_FILTERS.has(spam)) {
      return { error: { status: 400, body: { error: `spam must be one of: ${[...SPAM_FILTERS].join(', ')}` } } };
    }
    filters.spam = spam;
  }

  if (req.query.category !== undefined && req.query.category !== '') {
    const category = String(req.query.category).trim().toLowerCase();
    if (!CATEGORIES.has(category)) {
      return { error: { status: 400, body: { error: `Unknown category '${category}'` } } };
    }
    filters.category = category;
  }

  if (req.query.source !== undefined && req.query.source !== '') {
    const source = String(req.query.source).trim().toLowerCase();
    if (!SOURCES.has(source)) {
      return { error: { status: 400, body: { error: `source must be one of: ${[...SOURCES].join(', ')}` } } };
    }
    filters.source = source;
  }

  if (req.query.needs_review !== undefined && req.query.needs_review !== '') {
    const raw = String(req.query.needs_review).trim().toLowerCase();
    if (raw !== 'true' && raw !== 'false') {
      return { error: { status: 400, body: { error: "needs_review must be 'true' or 'false'" } } };
    }
    filters.needsReview = raw === 'true';
  }

  // Both narrowing ids are checked against the caller BEFORE the query runs: an
  // unowned or unparseable id must 404 rather than silently widening the feed
  // back to everything the user owns.
  if (req.query.wallet_id !== undefined && req.query.wallet_id !== '') {
    const walletId = parseId(req.query.wallet_id);
    const wallet = walletId && await EthWallet.findByIdForUser(walletId, req.user.id);
    if (!wallet) return { error: { status: 404, body: { error: 'Wallet not found' } } };
    filters.walletId = walletId;
  }

  if (req.query.exchange_account_id !== undefined && req.query.exchange_account_id !== '') {
    const accountId = parseId(req.query.exchange_account_id);
    const account = accountId && await ExchangeAccount.findByIdForUser(accountId, req.user.id);
    if (!account) return { error: { status: 404, body: { error: 'Exchange account not found' } } };
    filters.exchangeAccountId = accountId;
  }

  return { filters };
}

// Where the row happened, in the words the user thinks in: a chain name for an
// on-chain row, the venue account's own name for a venue row. Resolved here
// rather than shipped per row from the registry so the CSV and the table agree.
function sourceLabel(row) {
  if (row.source === 'onchain') return chains.chainLabel(row.chain_id ?? chains.DEFAULT_CHAIN_ID);
  return row.account_name || row.exchange || 'Exchange';
}

// A folded bridge half names its chain the same way, resolved here rather than
// on the client: the client's chain map is explorer URLs only, and a second
// copy of the registry's names there would be a second thing to keep in step
// with config/chains.js.
function withBridgeLabel(row) {
  if (!row.bridge_match) return row;
  return {
    ...row,
    bridge_match: {
      ...row.bridge_match,
      chain_label: chains.chainLabel(row.bridge_match.chain_id ?? chains.DEFAULT_CHAIN_ID),
    },
  };
}

// GET /api/crypto/ledger
//
// The unified ledger: eth_activity and exchange_records interleaved by time,
// with an exchange record that carries a matched on-chain hash folded into that
// transaction's row rather than rendered a second time.
router.get('/ledger', async (req, res) => {
  try {
    const parsed = await parseFilters(req);
    if (parsed.error) return res.status(parsed.error.status).json(parsed.error.body);

    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 100, 1), 500);
    const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);

    const { rows, total } = await CryptoLedger.findForUser(req.user.id, {
      ...parsed.filters,
      limit,
      offset,
    });

    return res.status(200).json({
      data: rows.map((row) => ({ ...withBridgeLabel(row), source_label: sourceLabel(row) })),
      pagination: { total, limit, offset },
    });
  } catch (error) {
    logger.error({ err: error }, 'Get crypto ledger error');
    return res.status(500).json({ error: 'Failed to retrieve the crypto ledger' });
  }
});

// The badge and the "first transaction to today" range, without paging the
// feed. Every filter but ONE is ignored on purpose: a needs-review badge that
// only counted the rows matching the category currently on screen would read
// zero the moment the user filtered them away.
//
// `wallet_id` is the exception, because it is not a view filter -- it selects
// WHICH LEDGER this is. The header sentence sits above the rows, so a user-wide
// total over a one-wallet feed described a ledger that was not on screen.
// Validated by the same parseFilters as the feed, so an unowned id 404s here
// too rather than silently widening back to everything the user owns.
router.get('/ledger/summary', async (req, res) => {
  try {
    const parsed = await parseFilters(req);
    if (parsed.error) return res.status(parsed.error.status).json(parsed.error.body);

    const summary = await CryptoLedger.summaryForUser(req.user.id, {
      walletId: parsed.filters.walletId,
    });
    return res.status(200).json({ summary });
  } catch (error) {
    logger.error({ err: error }, 'Get crypto ledger summary error');
    return res.status(500).json({ error: 'Failed to retrieve the crypto ledger summary' });
  }
});

// CSV export, honouring the same filters as the feed. Columns, not a rendered
// sentence: this is the spreadsheet-shaped view of a spreadsheet-shaped thing,
// and a "0.5 ETH -> 1,832.40 USDC" string cannot be summed. The assets in and
// out are split into their own columns for the same reason.
const EXPORT_COLUMNS = [
  ['date', 'date'],
  ['source', 'source'],
  ['location', 'location'],
  ['category', 'category'],
  ['counterparty', 'counterparty'],
  ['assets_in', 'assets_in'],
  ['assets_out', 'assets_out'],
  ['fee_amount', 'fee_amount'],
  ['fee_asset', 'fee_asset'],
  // At-the-time dollars (043), with the basis beside them. An empty usd_value
  // is "no price for this asset on that date" and the basis says so -- a blank
  // that a spreadsheet would sum as zero has to be readable as a gap.
  ['usd_value', 'usd_value'],
  ['usd_fee', 'usd_fee'],
  ['usd_basis', 'usd_basis'],
  ['needs_review', 'needs_review'],
  // Only ever populated when the caller asked for ?spam=only or ?spam=all --
  // the export excludes the quarantine by default, exactly like the feed. It is
  // a column rather than nothing because a quarantined row that exported as an
  // ordinary line would be a hidden row silently re-entering the totals.
  ['quarantined', 'quarantined'],
  ['matched_with', 'matched_with'],
  ['tx_hash', 'tx_hash'],
  ['chain_id', 'chain_id'],
  ['external_id', 'external_id'],
  ['note', 'note'],
];

// Token symbols, NFT names and label names are attacker-authored: anyone can
// deploy a contract with symbol `=cmd|'/c calc'!A1`, and the builtin label pack
// is scraped. A cell that OPENS with a formula character is evaluated by Excel
// and Sheets on open, so the leading character is quoted off.
//
// '-' is in the set: Excel evaluates `-1+1` too. It costs nothing here because
// this is applied ONLY to the text columns -- the numeric ones never pass
// through it, so a negative amount stays a number to a spreadsheet.
const FORMULA_LEAD = /^[=+\-@\t\r]/;
const deformula = (text) => (FORMULA_LEAD.test(text) ? `'${text}` : text);

function legsText(legs, direction) {
  return (legs || [])
    .filter((leg) => leg.direction === direction)
    .map((leg) => `${leg.amount} ${leg.asset}${leg.token_id != null ? ` #${leg.token_id}` : ''}`)
    .map(deformula)
    .join('; ');
}

function exportRow(row) {
  // The folded half's legs are NOT added to these columns. #61 only ever pairs
  // a deposit with a withdrawal, so the other half is the SAME money seen from
  // the other side -- writing 1.25 ETH into assets_out (the wallet sent it) and
  // again into assets_in (the venue credited it) makes SUM(assets_in) stop
  // meaning "what arrived". The pairing is reported in `matched_with` instead,
  // where it explains the row without inflating it.
  const match = row.exchange_match;
  const legs = row.legs || [];

  return {
    date: row.occurred_at instanceof Date ? row.occurred_at.toISOString() : row.occurred_at,
    source: row.source,
    location: deformula(sourceLabel(row)),
    category: row.category,
    // A folded venue record outranks the bare address: it is PROOF of which
    // venue the transaction was with, where 0xbbbb…bbbb is only a hex string
    // nobody has judged yet. A user label still beats both.
    counterparty: deformula(row.counterparty_name
      || match?.account_name
      || (row.counterparty_address ? shortAddress(row.counterparty_address) : null)
      || row.record_address
      || ''),
    assets_in: legsText(legs, 'in'),
    assets_out: legsText(legs, 'out'),
    fee_amount: row.fee_amount ?? '',
    // Deformulated like every other text cell. A venue row's fee_asset comes
    // straight off an imported CSV, so it is attacker-authored in exactly the
    // same way a token symbol is -- "=cmd|'/c calc'!A1" in a Kraken export's
    // asset column landed here unprefixed.
    fee_asset: row.fee_amount ? deformula(row.fee_asset || '') : '',
    // Left EMPTY when unpriced rather than written as 0: this column gets
    // summed, and a fabricated zero is indistinguishable from a real one. The
    // basis column beside it is what tells the two apart.
    usd_value: row.usd_value ?? '',
    usd_fee: row.usd_fee ?? '',
    usd_basis: row.usd_basis || '',
    needs_review: row.needs_review ? 'yes' : 'no',
    // The reason code, not a bare 'yes': "hidden, and nobody can say on what
    // grounds" is the failure 045's paired CHECK exists to prevent, and an
    // export is the one place the reason cannot be hovered for.
    quarantined: row.spam ? (row.spam_reason || 'yes') : '',
    // Which other record this line already accounts for, and on what evidence.
    // A reader summing the ledger has to be able to see that the pair is one
    // movement and not two.
    // A folded bridge pair reports the same way, and for the same reason: the
    // arrival on the far chain is already accounted for by this ONE line (its
    // assets and dollars are deliberately not added in -- it is the same money
    // landing), so a reader summing the export has to be able to see that.
    matched_with: match
      ? deformula(`${match.account_name || match.exchange || 'exchange'} ${match.external_id || ''} (${match.match_method}${match.verdict ? `, ${match.verdict}` : ''})`.trim())
      : (row.bridge_match
        ? deformula(`${chains.chainLabel(row.bridge_match.chain_id)} ${row.bridge_match.tx_hash || ''} (bridge)`.trim())
        : ''),
    tx_hash: row.tx_hash || '',
    chain_id: row.chain_id ?? '',
    external_id: deformula(row.external_id || ''),
    note: deformula(row.override_note || ''),
  };
}

router.get('/ledger/export', async (req, res) => {
  try {
    const parsed = await parseFilters(req);
    if (parsed.error) return res.status(parsed.error.status).json(parsed.error.body);

    const rows = await CryptoLedger.findAllForUser(req.user.id, {
      ...parsed.filters,
      limit: EXPORT_LIMIT,
    });

    const exported = rows.map(exportRow);
    // Truncation is announced IN THE FILE, not only in a header. The export is
    // an <a href> download, so a browser discards the headers -- and a file
    // that stops at exactly the cap is indistinguishable from the whole
    // history, which is the one thing a ledger export must never imply.
    if (rows.length >= EXPORT_LIMIT) {
      exported.push({
        note: `TRUNCATED at ${EXPORT_LIMIT} rows. Narrow the filters and export again for the rest.`,
      });
    }

    const csv = toCsv(exported, EXPORT_COLUMNS);
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="crypto-ledger.csv"');
    // The same fact for an API caller, who does get to read headers.
    res.setHeader('X-Row-Count', String(rows.length));
    res.setHeader('X-Row-Limit', String(EXPORT_LIMIT));
    return res.status(200).send(csv);
  } catch (error) {
    logger.error({ err: error }, 'Export crypto ledger error');
    return res.status(500).json({ error: 'Failed to export the crypto ledger' });
  }
});

// Evidence-first bridge audit. Suggestions are inert alternatives; only
// protocol_verified/user_confirmed movements are folded into the ledger.
router.get('/bridges', async (req, res) => {
  try {
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 500, 1), 1000);
    const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
    const suggestionLimit = Math.min(
      Math.max(parseInt(req.query.suggestion_limit, 10) || 500, 1), 1000
    );
    const suggestionOffset = Math.max(parseInt(req.query.suggestion_offset, 10) || 0, 0);
    const suggestionGeneration = req.query.suggestion_generation == null
      ? null : String(req.query.suggestion_generation);
    if (suggestionGeneration != null && !/^[a-f0-9]{32}$/.test(suggestionGeneration)) {
      return res.status(400).json({ error: 'Invalid bridge suggestion generation' });
    }
    return res.status(200).json(await EthBridgeMovement.findAuditForUser(
      req.user.id, {
        limit, offset, suggestionLimit, suggestionOffset, suggestionGeneration,
      }
    ));
  } catch (error) {
    if (error.code === 'BRIDGE_SUGGESTION_GENERATION_REQUIRED') {
      return res.status(400).json({ error: error.message });
    }
    if (error.code === 'BRIDGE_SUGGESTION_PAGE_STALE') {
      return res.status(409).json({ error: error.message });
    }
    logger.error({ err: error }, 'Get bridge audit error');
    return res.status(500).json({ error: 'Failed to retrieve bridge evidence' });
  }
});

router.post('/bridges/verdict', async (req, res) => {
  try {
    const { verdict, rebuilt } = await EthDerivedPipeline.serializedForUser(req.user.id, async () => {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        // The cross-process lock must precede the verdict write as well as the
        // rebuild snapshot. Otherwise a stale rebuild can invalidate a fold
        // committed moments after it read the old verdict set.
        await BridgeMatchingService.lockForUser(req.user.id, client);
        const saved = await EthBridgeMovement.upsertVerdict(req.user.id, req.body || {}, client);
        const result = await BridgeMatchingService.rebuildForUser(
          req.user.id, { acquireReceipts: false, client }
        );
        await client.query('COMMIT');
        return { verdict: saved, rebuilt: result };
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    });
    return res.status(200).json({ verdict, rebuilt });
  } catch (error) {
    if (error.code === 'INVALID_BRIDGE_VERDICT') {
      return res.status(400).json({ error: error.message });
    }
    if (error.code === 'BRIDGE_VERDICT_NOT_FOUND') {
      return res.status(404).json({ error: error.message });
    }
    if (error.code === 'BRIDGE_VERDICT_CONFLICT' || error.code === '23505') {
      return res.status(409).json({ error: error.message });
    }
    logger.error({ err: error }, 'Set bridge verdict error');
    return res.status(500).json({ error: 'Failed to save the bridge verdict' });
  }
});

router.delete('/bridges/verdict', async (req, res) => {
  try {
    const result = await EthDerivedPipeline.serializedForUser(req.user.id, async () => {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await BridgeMatchingService.lockForUser(req.user.id, client);
        const removed = await EthBridgeMovement.deleteVerdict(req.user.id, req.body || {}, client);
        if (!removed) {
          const error = new Error('Bridge verdict not found');
          error.code = 'BRIDGE_VERDICT_NOT_FOUND';
          throw error;
        }
        const rebuilt = await BridgeMatchingService.rebuildForUser(
          req.user.id, { acquireReceipts: false, client }
        );
        await client.query('COMMIT');
        return { removed: true, rebuilt };
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    });
    return res.status(200).json(result);
  } catch (error) {
    if (error.code === 'BRIDGE_VERDICT_NOT_FOUND') {
      return res.status(404).json({ error: error.message });
    }
    logger.error({ err: error }, 'Delete bridge verdict error');
    return res.status(500).json({ error: 'Failed to remove the bridge verdict' });
  }
});

module.exports = router;
module.exports.EXPORT_COLUMNS = EXPORT_COLUMNS;

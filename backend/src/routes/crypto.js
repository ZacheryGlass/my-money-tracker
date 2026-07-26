'use strict';

const express = require('express');
const requireUser = require('../middleware/auth');
const CryptoLedger = require('../models/CryptoLedger');
const EthWallet = require('../models/EthWallet');
const ExchangeAccount = require('../models/ExchangeAccount');
const chains = require('../config/chains');
const logger = require('../config/logger');
const { toCsv } = require('../utils/csv');
const { shortAddress } = require('../utils/ethAddress');

const router = express.Router();

router.use(requireUser);

const CATEGORIES = new Set(CryptoLedger.CATEGORIES);
const SOURCES = new Set(CryptoLedger.SOURCES);

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
  const filters = { category: null, needsReview: null, source: null, walletId: null, exchangeAccountId: null };

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
      data: rows.map((row) => ({ ...row, source_label: sourceLabel(row) })),
      pagination: { total, limit, offset },
    });
  } catch (error) {
    logger.error({ err: error }, 'Get crypto ledger error');
    return res.status(500).json({ error: 'Failed to retrieve the crypto ledger' });
  }
});

// The badge and the "first transaction to today" range, without paging the
// feed. Unfiltered on purpose: a needs-review badge that only counted the rows
// matching the filters currently on screen would read zero the moment the user
// filtered them away.
router.get('/ledger/summary', async (req, res) => {
  try {
    const summary = await CryptoLedger.summaryForUser(req.user.id);
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
  ['needs_review', 'needs_review'],
  ['tx_hash', 'tx_hash'],
  ['chain_id', 'chain_id'],
  ['external_id', 'external_id'],
  ['note', 'note'],
];

// Token symbols, NFT names and label names are attacker-authored: anyone can
// deploy a contract with symbol `=cmd|'/c calc'!A1`, and the builtin label pack
// is scraped. A cell that OPENS with a formula character is evaluated by Excel
// and Sheets on open, so the leading character is quoted off. Applied only to
// the text columns -- the numeric ones must stay parseable, and a legitimate
// negative number starts with '-'.
const FORMULA_LEAD = /^[=+@\t\r]/;
const deformula = (text) => (FORMULA_LEAD.test(text) ? `'${text}` : text);

function legsText(legs, direction) {
  return (legs || [])
    .filter((leg) => leg.direction === direction)
    .map((leg) => `${leg.amount} ${leg.asset}${leg.token_id != null ? ` #${leg.token_id}` : ''}`)
    .map(deformula)
    .join('; ');
}

function exportRow(row) {
  // A folded pair is one line, and its venue half's assets belong on it -- the
  // on-chain legs alone would describe half the event.
  const foldedLegs = (row.exchange_matches || []).flatMap((match) => {
    const legs = [];
    for (const [asset, amount] of [[match.base_asset, match.base_amount], [match.quote_asset, match.quote_amount]]) {
      if (!asset || amount === null || amount === undefined || Number.parseFloat(amount) === 0) continue;
      const text = String(amount).trim();
      legs.push({
        asset,
        direction: text.startsWith('-') ? 'out' : 'in',
        amount: CryptoLedger.trimDecimal(text.replace(/^-/, '')),
      });
    }
    return legs;
  });
  const legs = [...(row.legs || []), ...foldedLegs];

  return {
    date: row.occurred_at instanceof Date ? row.occurred_at.toISOString() : row.occurred_at,
    source: row.source,
    location: deformula(sourceLabel(row)),
    category: row.category,
    // A folded venue record outranks the bare address: it is PROOF of which
    // venue the transaction was with, where 0xbbbb…bbbb is only a hex string
    // nobody has judged yet. A user label still beats both.
    counterparty: deformula(row.counterparty_name
      || (row.exchange_matches?.[0]?.account_name ?? null)
      || (row.counterparty_address ? shortAddress(row.counterparty_address) : null)
      || row.record_address
      || ''),
    assets_in: legsText(legs, 'in'),
    assets_out: legsText(legs, 'out'),
    fee_amount: row.fee_amount ?? '',
    fee_asset: row.fee_amount ? (row.fee_asset || '') : '',
    needs_review: row.needs_review ? 'yes' : 'no',
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

module.exports = router;
module.exports.EXPORT_COLUMNS = EXPORT_COLUMNS;

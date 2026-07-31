'use strict';

const KrakenClient = require('./krakenClient');
const { normalizeAsset, buildRecords } = require('../exchangeImport/krakenLedger');
const { cleanAmount, addAmounts } = require('../exchangeImport/shared');
const logger = require('../../config/logger');

// Kraken connector: POST /0/private/Ledgers is the everything-feed (trade legs,
// deposits, withdrawals, staking, earn moves, transfers), and the withdrawal /
// deposit status endpoints are the only place the destination address and the
// network txid appear -- the ledger feed carries neither.
//
//   Ledgers ........ https://docs.kraken.com/api/docs/rest-api/get-ledgers-info
//   WithdrawStatus . https://docs.kraken.com/api/docs/rest-api/get-status-recent-withdrawals
//   DepositStatus .. https://docs.kraken.com/api/docs/rest-api/get-status-recent-deposits
//   Balance ........ https://docs.kraken.com/api/docs/rest-api/get-account-balance

// "50 results are returned at a time" -- get-ledgers-info.
const LEDGER_PAGE_SIZE = 50;

// `start` is documented EXCLUSIVE, and two ledger rows can share a timestamp
// (time is a float, but four decimals of a second is not a unique key).
// Resuming from exactly the newest time seen would therefore drop any row that
// ties it. Rewinding an hour costs at most an extra page and the UNIQUE
// (exchange_account_id, external_id) upsert makes the overlap free -- the same
// bargain the ETH sync's REORG_OVERLAP_BLOCKS makes.
const RESUME_OVERLAP_SECONDS = 3600;

// A ledger call costs 2 against a counter that caps at 15 and decays at
// 0.33/sec on the Starter tier, so ~6 seconds per page. 25 pages is ~2.5
// minutes, which fits inside a request timeout; the nightly job passes a much
// larger budget because nothing is waiting on it.
const MAX_PAGES_INTERACTIVE = 25;
const MAX_PAGES_JOB = 200;

// Explicit on both, because the two endpoints have DIFFERENT documented
// defaults (500 for withdrawals, 25 for deposits) and relying on either is a
// silent truncation waiting to happen.
const FUNDING_PAGE_LIMIT = 500;

// Both status endpoints document a `cursor` parameter: send `true` on the
// first call and the response arrives WRAPPED ({withdrawal|deposit: [...],
// next_cursor}) instead of as a bare array; send the returned next_cursor to
// get the following page. Without the loop a first backfill spanning years
// stops at 500 rows, and the 1h steady-state windows never re-request the
// tx_hash/address that were missed -- silently, and forever, because the
// ledger rows themselves import fine.
// https://docs.kraken.com/api/docs/rest-api/get-status-recent-withdrawals
const FUNDING_MAX_PAGES = 25;

const EXCHANGE = 'kraken';

// The permissions the user must tick, named exactly as Kraken's key-creation
// UI names them. Read-only: no funds can move with any of these.
// https://support.kraken.com/articles/360000919966-how-to-create-an-api-key
const REQUIRED_PERMISSIONS = ['Query Funds', 'Query Ledger Entries', 'Query Closed Orders & Trades'];

function unixNow() {
  return Math.floor(Date.now() / 1000);
}

// Kraken hands back a bare array today, but the documented `cursor` parameter
// implies a wrapped {withdrawal|deposit: [...], next_cursor} shape, and the
// WithdrawStatus schema does not publish which. Accepting both costs three
// lines and is the difference between "no addresses" and a crash the day
// Kraken flips the default.
function fundingRows(result) {
  if (Array.isArray(result)) return result;
  if (result && Array.isArray(result.withdrawal)) return result.withdrawal;
  if (result && Array.isArray(result.deposit)) return result.deposit;
  return [];
}

/**
 * refid -> { txHash, address } for the funding events in a window.
 *
 * The join is `WithdrawStatus[].refid === ledgerEntry.refid`, which is what
 * lets a withdrawal record carry the address it went to. `info` is the
 * destination ("Method transaction information" -- Kraken's example shows a
 * bech32 address there) and `txid` is the on-chain id ("Method transaction
 * ID"). Both feed forgotten-wallet discovery.
 *
 * Best-effort on purpose: a funding-endpoint failure must not lose the ledger
 * rows that were already fetched. The records still import, just without an
 * address, and the next sync's overlap window has another go.
 */
async function fetchFundingDetails(client, { start, end }) {
  const byRefid = new Map();
  const coverageLimitations = [];
  for (const endpoint of ['WithdrawStatus', 'DepositStatus']) {
    try {
      // `true` asks for the paginated (wrapped) form; after that the cursor is
      // whatever the previous page returned.
      let cursor = true;
      let pages = 0;
      for (; pages < FUNDING_MAX_PAGES; pages += 1) {
        const result = await client.request(endpoint, {
          start, end, limit: FUNDING_PAGE_LIMIT, cursor,
        });
        const rows = fundingRows(result);
        for (const row of rows) {
          if (!row || !row.refid) continue;
          byRefid.set(row.refid, {
            txHash: row.txid ? String(row.txid) : null,
            address: row.info ? String(row.info) : null,
            method: row.method ?? null,
            network: row.network ?? null,
            status: row.status ?? null,
          });
        }

        const next = (result && !Array.isArray(result) && result.next_cursor) ? String(result.next_cursor) : null;
        if (!next) {
          // A bare array back means this deployment ignores `cursor`. A FULL
          // one is then indistinguishable from a truncated one, so it is said
          // out loud rather than assumed complete.
          if (Array.isArray(result) && rows.length >= FUNDING_PAGE_LIMIT) {
            logger.warn({ endpoint, rows: rows.length, limit: FUNDING_PAGE_LIMIT },
              'Kraken funding status returned a full page with no cursor; addresses beyond it are not read');
            coverageLimitations.push(`${endpoint} returned a full page without a continuation cursor; older funding addresses may be missing.`);
          }
          break;
        }
        cursor = next;
      }
      if (pages >= FUNDING_MAX_PAGES) {
        logger.warn({ endpoint, pages },
          'Kraken funding status hit the page budget; some records import without addresses this run');
        coverageLimitations.push(`${endpoint} hit its page budget; older funding addresses may be missing.`);
      }
    } catch (err) {
      logger.warn({ err, endpoint }, 'Kraken funding status fetch failed; records import without addresses');
      coverageLimitations.push(`${endpoint} could not be read; some funding addresses may be missing.`);
    }
  }
  return { byRefid, coverageLimitations };
}

/**
 * Walk the ledger for one window, newest first.
 *
 * `end` is pinned to the moment the sync started so that rows arriving mid-walk
 * cannot shift the offset window underneath us and push an unread row past the
 * page we already fetched.
 *
 * `startOffset` resumes a window that a previous run left part-walked. Paging
 * by offset across runs is only sound because the window is closed on both
 * ends and everything inside it is settled history, so it cannot re-order.
 */
async function fetchLedgerWindow(client, { start, end, maxPages, startOffset = 0 }) {
  const rows = [];
  let pages = 0;
  let truncated = false;
  let reachedOffset = startOffset;

  for (let ofs = startOffset; ; ofs += LEDGER_PAGE_SIZE) {
    reachedOffset = ofs;
    if (pages >= maxPages) { truncated = true; break; }
    const result = await client.request('Ledgers', {
      start: start > 0 ? start : undefined,
      end,
      ofs: ofs > 0 ? ofs : undefined,
    });
    pages += 1;

    // result.ledger is a MAP keyed by ledger id -- the id is the key, not a
    // field on the value, so an Object.values() reader silently loses it.
    const page = Object.entries(result.ledger || {});
    for (const [ledgerId, entry] of page) rows.push({ ledgerId, ...entry });
    if (page.length < LEDGER_PAGE_SIZE) break;
  }

  // Where the next run would carry on inside this same window: the offset of
  // the page after the last one read.
  const nextOffset = truncated ? reachedOffset : startOffset + rows.length;
  return { rows, pages, truncated, nextOffset };
}

// Kraken writes fiat and crypto quantities as strings for exactness; every
// number here stays a decimal string all the way into NUMERIC(38,18).
function toRecordRows(ledgerRows, fundingByRefid) {
  // Ascending by time so `line` (which orders the emitted records and picks a
  // paired record's timestamp) means the same thing it does on the CSV path.
  const ordered = [...ledgerRows].sort((a, b) => Number(a.time) - Number(b.time));

  return ordered.map((entry, index) => {
    const type = String(entry.type ?? '').toLowerCase();
    const funding = (type === 'withdrawal' || type === 'deposit')
      ? fundingByRefid.get(entry.refid)
      : null;
    const amountCell = entry.amount === undefined || entry.amount === null ? '' : String(entry.amount);

    return {
      line: index + 1,
      // The CSV's `txid` column and the REST map key are the same ledger entry
      // id, which is what makes both sources produce the same external_id.
      txid: entry.ledgerId,
      refid: entry.refid ? String(entry.refid) : '',
      // Kraken sends a float unix timestamp; the fractional part is real and
      // ordering depends on it, so it is not truncated before conversion.
      occurredAt: new Date(Number(entry.time) * 1000).toISOString(),
      type,
      subtype: String(entry.subtype ?? '').toLowerCase(),
      asset: normalizeAsset(entry.asset),
      amountCell,
      amount: cleanAmount(amountCell),
      fee: cleanAmount(entry.fee),
      txHash: funding?.txHash ?? null,
      address: funding?.address ?? null,
      network: funding?.network ?? null,
      raw: {
        _format: EXCHANGE,
        _source: 'api',
        ledger_id: entry.ledgerId,
        refid: entry.refid,
        time: entry.time,
        type: entry.type,
        subtype: entry.subtype,
        aclass: entry.aclass,
        asset: entry.asset,
        amount: entry.amount,
        fee: entry.fee,
        balance: entry.balance,
        ...(funding ? { funding } : {}),
      },
    };
  });
}

// Live balances, normalized the same way record assets are so the comparison
// is apples to apples. XETH, ETH2 and ETH2.S are three keys in one Balance
// response and one position in the ledger, so they are summed, not overwritten.
function normalizeBalances(balanceMap) {
  const balances = {};
  for (const [code, value] of Object.entries(balanceMap || {})) {
    const asset = normalizeAsset(code);
    const amount = cleanAmount(value);
    if (!asset || amount === null) continue;
    // Seeded from '0' rather than null so every sum runs through the exact
    // scaled path and comes out in one canonical form -- otherwise a single
    // asset would keep the exchange's own trailing zeros ("100.10") while a
    // summed one would not ("4.25"), and the comparison would be comparing
    // formatting as much as value.
    balances[asset] = addAmounts(balances[asset] ?? '0', amount);
  }
  return balances;
}

const krakenConnector = {
  EXCHANGE,
  REQUIRED_PERMISSIONS,

  client(credentials) {
    return new KrakenClient(credentials);
  },

  /**
   * Smallest authenticated read there is. Proves the key, the HMAC and the
   * Query Funds permission without touching any history -- which is exactly
   * what a Test Connection button should do.
   */
  async probe(credentials) {
    const client = new KrakenClient(credentials);
    const balances = normalizeBalances(await client.getBalance());
    return {
      ok: true,
      detail: `Authenticated. ${Object.keys(balances).length} asset balance(s) visible.`,
      assets: Object.keys(balances).sort(),
    };
  },

  /**
   * One sync pass.
   *
   * The cursor is a two-part resume point, not a single watermark:
   *
   *   { newestTime, pendingStart, pendingEnd, pendingOffset }
   *
   * Ledgers returns NEWEST FIRST within a window, so a page budget truncates
   * the OLD end of that window. A single "newest time seen" watermark would
   * therefore mark a partial backfill as complete and strand every row older
   * than the budget forever. `pendingEnd` carries the unfinished window's
   * oldest reached point, and the next run resumes from there before it looks
   * at the head again. `pendingOffset` handles the one case where shrinking
   * the window cannot make progress -- see the resume-point comment below.
   */
  async sync(credentials, { cursor = null, interactive = true } = {}) {
    const client = new KrakenClient(credentials);
    const maxPages = interactive ? MAX_PAGES_INTERACTIVE : MAX_PAGES_JOB;
    const state = cursor && typeof cursor === 'object' ? cursor : {};

    const resumingBackfill = Number.isFinite(state.pendingEnd);
    const start = resumingBackfill
      ? Math.max(0, Number(state.pendingStart) || 0)
      : Math.max(0, (Number(state.newestTime) || 0) - RESUME_OVERLAP_SECONDS);
    const end = resumingBackfill ? Math.ceil(Number(state.pendingEnd)) : unixNow();
    const startOffset = resumingBackfill && Number.isFinite(state.pendingOffset)
      ? Math.max(0, Number(state.pendingOffset)) : 0;

    const {
      rows, pages, truncated, nextOffset,
    } = await fetchLedgerWindow(client, {
      start, end, maxPages, startOffset,
    });

    const times = rows.map((row) => Number(row.time)).filter((time) => Number.isFinite(time));
    const oldestFetched = times.length ? Math.min(...times) : null;
    const newestFetched = times.length ? Math.max(...times) : null;

    const fundingResult = rows.length
      ? await fetchFundingDetails(client, { start, end })
      : { byRefid: new Map(), coverageLimitations: [] };
    const { records, unknownTypes } = buildRecords(toRecordRows(rows, fundingResult.byRefid));

    // Only ever advanced past rows that were actually read. A cursor that ran
    // ahead of the fetch would drop the gap silently and permanently.
    //
    // `end` is INCLUSIVE and `time` is a float, so the resume point rounds UP
    // to the oldest row read: that row is re-read and the upsert absorbs it,
    // which is the point. Rounding down instead (floor - 1) looks like a
    // one-second overlap and is actually a one-second GAP -- every row in
    // (floor(oldest)-1, oldest) falls between the two windows and is never
    // fetched by this run or any later one, because the resume point only ever
    // moves further down. That is worst for trades: Kraken's two legs share a
    // refid AND an identical time, so a cut between them strands the surviving
    // leg as a permanently half-known trade.
    //
    // When a whole page budget's worth of rows sits inside the TOP second of
    // the window, ceil(oldest) lands on `end` itself and shrinking the window
    // cannot make progress at all. The old code clamped the resume point to
    // end-1, which does make progress -- by silently stranding every remaining
    // row in that second. Instead the window is kept exactly as it is and the
    // OFFSET already reached is carried, so the next run picks up the next page
    // of the same window. Nothing is skipped and nothing loops.
    const ceilOldest = oldestFetched === null ? null : Math.ceil(oldestFetched);
    const stalled = truncated && ceilOldest !== null && ceilOldest >= end;
    if (stalled) {
      logger.info({ second: end, offset: nextOffset },
        'Kraken ledger has more rows in one second than one pass can page; resuming by offset');
    }
    const nextCursor = truncated && oldestFetched !== null
      ? {
        newestTime: Math.max(Number(state.newestTime) || 0, newestFetched ?? 0) || null,
        pendingStart: start,
        pendingEnd: stalled ? end : ceilOldest,
        // Only meaningful with an unshrunk window: once `end` moves down, the
        // offsets it counted no longer refer to the same rows.
        pendingOffset: stalled ? nextOffset : 0,
      }
      : {
        newestTime: Math.max(Number(state.newestTime) || 0, newestFetched ?? 0, resumingBackfill ? 0 : end) || null,
        pendingStart: null,
        pendingEnd: null,
        pendingOffset: 0,
      };

    return {
      records,
      cursor: nextCursor,
      balances: normalizeBalances(await client.getBalance()),
      stats: {
        rows: rows.length,
        pages,
        unknownTypes,
        // Surfaced rather than swallowed: a truncated walk looks exactly like
        // a complete one from the outside, and the balance check that follows
        // would blame the parser for rows nobody has fetched yet.
        backfillPending: Boolean(nextCursor.pendingEnd),
      },
      coverageLimitations: fundingResult.coverageLimitations,
    };
  },
};

module.exports = krakenConnector;
module.exports.MAX_PAGES_INTERACTIVE = MAX_PAGES_INTERACTIVE;
module.exports.RESUME_OVERLAP_SECONDS = RESUME_OVERLAP_SECONDS;
module.exports._internals = { toRecordRows, normalizeBalances, fundingRows, fetchLedgerWindow };

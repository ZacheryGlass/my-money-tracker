'use strict';

const CoinbaseClient = require('./coinbaseClient');
const {
  UNKNOWN_RECORD_TYPE,
  cleanAmount,
  absAmount,
  addAmounts,
  isNegativeAmount,
  parseTimestamp,
  finalizeRecord,
} = require('../exchangeImport/shared');
const logger = require('../../config/logger');

// Coinbase connector.
//
//   v3 accounts .... https://docs.cdp.coinbase.com/api-reference/advanced-trade-api/rest-api/accounts/list-accounts
//   v3 fills ....... https://docs.cdp.coinbase.com/api-reference/advanced-trade-api/rest-api/orders/list-fills
//   v2 accounts .... https://docs.cdp.coinbase.com/coinbase-app/track-apis/accounts
//   v2 transactions  https://docs.cdp.coinbase.com/coinbase-app/track-apis/transactions
//   v2 pagination .. https://docs.cdp.coinbase.com/coinbase-app/api-architecture/pagination
//
// WHY v2 TRANSACTIONS ARE THE RECORD SOURCE AND FILLS ARE NOT.
// An Advanced Trade fill shows up twice: once in
// /api/v3/brokerage/orders/historical/fills and once, per account, as a v2
// transaction of type `advanced_trade_fill`. Importing both would double every
// trade. The v2 feed is the canonical one because it is the only feed that
// covers EVERYTHING -- sends, receives, rewards, fiat ramps, conversions --
// and because the retail CSV export's ID column is the v2 transaction id, so
// keying records on it is what makes an API backfill and a CSV upload of the
// same period collapse onto the same rows instead of duplicating.
// Fills are fetched only to fill in the quote leg and the real commission on
// trades, which the v2 row alone does not always carry.

const EXCHANGE = 'coinbase';

// "The default limit is set to 25, but values up to 100 are permitted."
const V2_PAGE_LIMIT = 100;
// "The number of accounts to display per page. By default, displays 49 (max 250)."
const V3_ACCOUNT_LIMIT = 250;
// "The number of fills to be returned (default is 100)."
const FILL_PAGE_LIMIT = 100;

// 10,000 requests/hour is the documented ceiling (~2.8/sec); the client already
// paces to it. These caps bound a single pass so a first backfill cannot run
// for an hour behind an HTTP request.
const MAX_PAGES_INTERACTIVE = 30;
const MAX_PAGES_JOB = 400;

// A transaction can be amended after it is written (a pending send confirming
// and gaining its network hash is the common case), so an incremental sync
// re-reads a day rather than resuming from the exact watermark.
const RESUME_OVERLAP_MS = 24 * 60 * 60 * 1000;

// What the user must grant. CDP key permissions are view / trade / transfer,
// and `view` alone covers every endpoint this connector calls.
// https://docs.cdp.coinbase.com/coinbase-app/advanced-trade-apis/rest-api
const REQUIRED_PERMISSIONS = ['View (read-only)'];

// v2 transaction type -> record type. Enumerated from the current published
// table at https://docs.cdp.coinbase.com/coinbase-app/track-apis/transactions
// (28 values). Several types that used to exist -- exchange_deposit,
// pro_deposit, staking_reward, inflation_reward, interest -- are NOT in the
// current list and are deliberately absent here; the CSV importer still maps
// their export spellings, which is where they survive.
const TYPE_MAP = {
  // Trades. `buy`/`sell` are the retail ones; advanced_trade_fill is a fill on
  // the Advanced Trade book, which the retail CSV calls "Advanced Trade Buy".
  buy: 'trade',
  sell: 'trade',
  advanced_trade_fill: 'trade',
  fcm_futures_usdc_sell: 'trade',

  // `trade` is Coinbase's crypto-to-crypto Convert, and the retail export
  // calls it "Convert" -- a conversion, not a book trade.
  trade: 'conversion',
  wrap_asset: 'conversion',
  unwrap_asset: 'conversion',

  // Income.
  earn_payout: 'reward',
  incentives_rewards_payout: 'reward',
  subscription_rebate: 'reward',

  // Movement in and out of Coinbase itself.
  send: 'withdrawal',
  receive: 'deposit',
  fiat_deposit: 'deposit',
  fiat_withdrawal: 'withdrawal',

  // Moves between the user's own Coinbase surfaces. Nothing leaves Coinbase,
  // which is what 'transfer' already means here -- and, as with the CSV
  // importer, reading the name literally would book them backwards.
  vault_withdrawal: 'transfer',
  staking_transfer: 'transfer',
  unstaking_transfer: 'transfer',
  intx_deposit: 'transfer',
  intx_withdrawal: 'transfer',
  transfer: 'transfer',
  retail_simple_dust: 'transfer',
  derivatives_settlement: 'transfer',
  unsupported_asset_recovery: 'transfer',
  clawback: 'transfer',
  incentives_shared_clawback: 'transfer',
  fcm_futures_usdc_sell_additional_encumberment_rollup: 'transfer',

  subscription: 'fee',

  // `tx` is documented as "the default and uncategorized" type and `request`
  // as a payment request, so neither says what happened. Both are left OUT of
  // this map on purpose: they fall through to the unknown path and import
  // flagged, which is the honest answer.
};

const sortedEntries = (map) => Object.entries(map).sort(([a], [b]) => a.localeCompare(b));

// The two surfaces spell the same money hash differently: v2 writes
// {amount, currency} and v3's Amount writes {value, currency}. Reading only
// one of them silently yields a zero balance, which reconciles as "the ledger
// is wrong" against an account that is perfectly fine.
function amountOf(money) {
  if (!money || typeof money !== 'object') return null;
  return cleanAmount(money.amount ?? money.value);
}

function currencyOf(money) {
  if (!money || typeof money !== 'object') return null;
  const code = String(money.currency ?? '').trim().toUpperCase();
  return code || null;
}

// v2 pagination: "you know that you have paginated all the results when the
// response's next_uri is empty". starting_after takes the id of the last
// resource on the page.
//
// The JWT signs the bare path with no query string, so next_uri (which carries
// one) is never followed directly -- its starting_after is extracted and
// passed as a parameter instead.
async function pageV2(client, path, {
  limit = V2_PAGE_LIMIT, maxPages, order = 'desc', shouldStop, startAfter = null,
} = {}) {
  const collected = [];
  // Where to resume if the page budget runs out mid-walk. Returned to the
  // caller so an unfinished walk can be picked up exactly where it stopped
  // instead of restarting from the newest row and never reaching the old ones.
  let startingAfter = startAfter || undefined;
  let pages = 0;
  let truncated = false;

  for (;;) {
    if (pages >= maxPages) { truncated = true; break; }
    const body = await client.get(path, startingAfter
      ? { limit, order, starting_after: startingAfter }
      : { limit, order });
    pages += 1;

    const data = Array.isArray(body?.data) ? body.data : [];
    if (data.length === 0) break;

    let stopped = false;
    for (const row of data) {
      if (shouldStop && shouldStop(row)) { stopped = true; break; }
      collected.push(row);
    }
    // A descending walk that has reached rows older than the watermark is
    // done; everything past this point is already stored.
    if (stopped) break;

    const last = data[data.length - 1];
    if (!body.pagination || !body.pagination.next_uri) break;
    if (!last || !last.id) break;
    startingAfter = last.id;
  }

  return { rows: collected, pages, truncated, resumeAfter: truncated ? startingAfter ?? null : null };
}

// v3 accounts paginate with an explicit has_next flag; v3 fills do NOT have
// one and terminate on an empty cursor. Sharing a helper between them is how
// a fills loop ends up running forever.
async function pageV3Accounts(client, { maxPages = 20 } = {}) {
  const accounts = [];
  let cursor;
  for (let page = 0; page < maxPages; page += 1) {
    const body = await client.listBrokerageAccounts({ limit: V3_ACCOUNT_LIMIT, cursor });
    accounts.push(...body.accounts);
    if (!body.has_next || !body.cursor) break;
    cursor = body.cursor;
  }
  return accounts;
}

async function pageV3Fills(client, { startTime, maxPages }) {
  const fills = [];
  let cursor;
  let pages = 0;
  for (;;) {
    if (pages >= maxPages) break;
    const params = { limit: FILL_PAGE_LIMIT };
    if (startTime) params.start_sequence_timestamp = startTime;
    if (cursor) params.cursor = cursor;
    const body = await client.get('/api/v3/brokerage/orders/historical/fills', params);
    pages += 1;

    const page = Array.isArray(body?.fills) ? body.fills : [];
    fills.push(...page);
    // EU SCA: an unproofed key can be answered with an empty page and this
    // flag rather than data. Silently reporting "no trades" would be worse
    // than saying nothing at all.
    if (body?.proof_token_required) {
      logger.warn({ exchange: EXCHANGE }, 'Coinbase fills need a 2FA proof token; quote enrichment skipped');
      break;
    }
    // No has_next on this endpoint -- an empty cursor is the terminator.
    if (!body?.cursor || page.length === 0) break;
    cursor = body.cursor;
  }
  return fills;
}

/**
 * order_id -> aggregated fill figures.
 *
 * Only `FILL` rows are aggregated. trade_type also carries REVERSAL,
 * CORRECTION and SYNTHETIC for adjusted fills; folding those into the totals
 * would count an amended trade twice, so they are counted and reported instead
 * of being quietly averaged in.
 */
function summarizeFills(fills) {
  const byOrder = new Map();
  let adjusted = 0;
  for (const fill of fills) {
    if (!fill || !fill.order_id) continue;
    if (fill.trade_type && fill.trade_type !== 'FILL') { adjusted += 1; continue; }
    const [base, quote] = String(fill.product_id ?? '').split('-');
    const entry = byOrder.get(fill.order_id) || {
      baseAsset: base || null,
      quoteAsset: quote || null,
      commission: null,
      quoteAmount: null,
      sizeInQuote: Boolean(fill.size_in_quote),
      side: fill.side ?? null,
    };
    entry.commission = addAmounts(entry.commission, cleanAmount(fill.commission) ?? '0');
    // size_in_quote means `size` is already denominated in the quote currency,
    // so it is the quote leg outright; otherwise price * size would be needed
    // and that multiplication is left to whoever has the exact decimal type.
    if (fill.size_in_quote) {
      entry.quoteAmount = addAmounts(entry.quoteAmount, cleanAmount(fill.size) ?? '0');
    }
    byOrder.set(fill.order_id, entry);
  }
  return { byOrder, adjusted };
}

/**
 * One v2 transaction -> one exchange_records row.
 *
 * Keyed `cb:<transaction id>`, which is exactly what the retail CSV importer
 * builds from the export's ID column -- the two sources describe the same
 * event with the same id, so an overlapping CSV upload after an API backfill
 * dedupes instead of doubling.
 */
function recordFromTransaction(tx, { line, fillsByOrder }) {
  const rawType = String(tx.type ?? '').toLowerCase();
  const mapped = TYPE_MAP[rawType];
  const isUnknown = mapped === undefined;

  const occurredAt = parseTimestamp(tx.created_at);
  const baseAsset = currencyOf(tx.amount);
  const amountCell = tx.amount?.amount ?? '';
  const baseAmount = amountOf(tx.amount);

  // native_amount is the same event valued in the account's fiat currency, so
  // it is the quote leg for a buy/sell. For a Convert the counter-leg is a
  // separate transaction and is paired below, not here.
  let quoteAsset = null;
  let quoteAmount = null;
  if (mapped === 'trade') {
    quoteAsset = currencyOf(tx.native_amount);
    quoteAmount = amountOf(tx.native_amount);
  }

  let feeAsset = null;
  let feeAmount = null;
  const fill = tx.advanced_trade_fill;
  if (fill) {
    // "Commission per fill of the order. Always represented in quote currency."
    const commission = cleanAmount(fill.commission);
    if (commission && commission !== '0') {
      feeAsset = quoteAsset;
      feeAmount = absAmount(commission);
    }
    const summary = fill.order_id ? fillsByOrder.get(fill.order_id) : null;
    if (summary) {
      if (summary.quoteAsset) feeAsset = feeAsset ? summary.quoteAsset : feeAsset;
      if (!quoteAmount && summary.quoteAmount) {
        quoteAsset = summary.quoteAsset ?? quoteAsset;
        quoteAmount = summary.quoteAmount;
      }
    }
  }

  // "Hash for onchain transactions; ONLY provided when transaction is a SEND"
  // -- and even then it is absent while the send is pending, so it is treated
  // as nullable rather than expected.
  const network = tx.network || {};
  const to = tx.to || {};
  // `to` is polymorphic: an address for an on-chain send, but an email, a user
  // or another account otherwise. Only an address belongs in the address
  // column, which is what forgotten-wallet discovery reads.
  const address = typeof to.address === 'string' && to.address ? to.address : null;

  return finalizeRecord({
    record_type: mapped ?? UNKNOWN_RECORD_TYPE,
    occurred_at: occurredAt,
    base_asset: baseAsset,
    base_amount: baseAmount,
    quote_asset: quoteAsset,
    quote_amount: quoteAmount,
    fee_asset: feeAsset,
    fee_amount: feeAmount,
    tx_hash: typeof network.hash === 'string' && network.hash ? network.hash : null,
    address,
    external_id: `cb:${tx.id}`,
    // An uncategorized `tx`, a `request`, or a type Coinbase adds after this
    // was written all land here: stored, visible, and flagged -- never guessed
    // into income or a deposit, and never dropped.
    needs_review: isUnknown,
    raw: { _format: 'coinbase', _source: 'api', ...tx },
  }, { line, amountCell });
}

/**
 * Convert legs, folded into one record.
 *
 * A Coinbase Convert writes TWO v2 transactions of type `trade`, one in each
 * account, sharing a `trade.id`. Imported separately they read as two
 * unrelated moves and the direction is lost. The record is keyed on the
 * outgoing leg's own transaction id, which is what the retail CSV importer
 * does with a Convert pair too.
 */
function foldConversions(transactions) {
  const byTradeId = new Map();
  const singles = [];

  for (const tx of transactions) {
    const tradeId = String(tx.type ?? '').toLowerCase() === 'trade' ? tx.trade?.id : null;
    if (!tradeId) { singles.push(tx); continue; }
    if (!byTradeId.has(tradeId)) byTradeId.set(tradeId, []);
    byTradeId.get(tradeId).push(tx);
  }

  const pairs = [];
  for (const legs of byTradeId.values()) {
    if (legs.length !== 2) {
      // One leg fetched, or three: not a pair this code understands. They go
      // through as individual records and are flagged by the caller, rather
      // than being fused on a guess.
      singles.push(...legs.map((leg) => ({ ...leg, _unpairedConversion: true })));
      continue;
    }
    const from = legs.find((leg) => isNegativeAmount(amountOf(leg.amount) ?? '')) ?? legs[0];
    const to = legs.find((leg) => leg !== from);
    pairs.push({ from, to });
  }

  return { pairs, singles };
}

function recordFromConversion({ from, to }, { line }) {
  return finalizeRecord({
    record_type: 'conversion',
    occurred_at: parseTimestamp(from.created_at),
    base_asset: currencyOf(from.amount),
    base_amount: amountOf(from.amount),
    quote_asset: currencyOf(to.amount),
    quote_amount: amountOf(to.amount),
    fee_asset: null,
    fee_amount: null,
    tx_hash: null,
    address: null,
    external_id: `cb:${from.id}`,
    needs_review: false,
    raw: { _format: 'coinbase', _source: 'api', from, to },
  }, { line, amountCell: [from.amount?.amount ?? '', to.amount?.amount ?? ''] });
}

const coinbaseConnector = {
  EXCHANGE,
  REQUIRED_PERMISSIONS,
  TYPE_MAP,

  client(credentials) {
    return new CoinbaseClient(credentials);
  },

  // The Test Connection probe: one authenticated read against the Advanced
  // Trade accounts list, which proves the key name, the ES256 signature and
  // the `view` permission without reading a single transaction.
  async probe(credentials) {
    const client = new CoinbaseClient(credentials);
    const body = await client.listBrokerageAccounts({ limit: 1 });
    return {
      ok: true,
      detail: `Authenticated. ${body.size ?? body.accounts.length} portfolio account(s) visible.`,
      assets: body.accounts.map((account) => account.currency).filter(Boolean),
    };
  },

  /**
   * One sync pass.
   *
   * Cursor: { since: ISO timestamp, pending: { [v2AccountId]: startingAfterId } }.
   *
   * The v2 transaction feed is walked newest-first per account and stopped once
   * it reaches rows older than `since`, so steady-state cost is one page per
   * account. `pending` is what makes a first backfill CONVERGE: a history
   * longer than the page budget would otherwise restart from the newest row
   * every run, re-import the same first pages, and never once reach the old
   * ones. Each unfinished account keeps the id it stopped after, and `since`
   * only advances when every account has been walked to the end.
   */
  async sync(credentials, { cursor = null, interactive = true } = {}) {
    const client = new CoinbaseClient(credentials);
    const maxPages = interactive ? MAX_PAGES_INTERACTIVE : MAX_PAGES_JOB;
    const state = cursor && typeof cursor === 'object' ? cursor : {};

    const sinceMs = state.since ? Date.parse(state.since) : NaN;
    const watermark = Number.isFinite(sinceMs) ? sinceMs - RESUME_OVERLAP_MS : null;
    const startedAt = new Date().toISOString();

    // Advanced Trade balances -- the live figure the derived one is checked
    // against, and the same call the probe makes.
    const brokerageAccounts = await pageV3Accounts(client);

    const fills = await pageV3Fills(client, {
      startTime: watermark ? new Date(watermark).toISOString() : undefined,
      maxPages: Math.max(1, Math.floor(maxPages / 3)),
    }).catch((err) => {
      // Enrichment only. Losing it costs a trade's quote leg, not the trade.
      logger.warn({ err }, 'Coinbase fills fetch failed; trades import without fill enrichment');
      return [];
    });
    const { byOrder: fillsByOrder, adjusted } = summarizeFills(fills);

    const v2Accounts = await pageV2(client, '/v2/accounts', { maxPages: 10 });

    const pending = (state.pending && typeof state.pending === 'object') ? state.pending : {};
    const nextPending = {};
    const transactions = [];
    let truncated = false;
    let pagesUsed = 0;

    for (const account of v2Accounts.rows) {
      if (!account?.id) continue;
      const resumeAfter = pending[account.id] ?? null;
      if (pagesUsed >= maxPages) {
        // Out of budget before this account was touched at all. Carrying its
        // resume point forward unchanged is what stops the next run from
        // treating it as finished.
        truncated = true;
        if (resumeAfter) nextPending[account.id] = resumeAfter;
        continue;
      }
      const result = await pageV2(client, `/v2/accounts/${account.id}/transactions`, {
        maxPages: maxPages - pagesUsed,
        startAfter: resumeAfter,
        // While an account is still being backfilled the watermark must not
        // stop the walk: every remaining row is older than it by definition.
        shouldStop: watermark && !resumeAfter
          ? (row) => {
            const at = Date.parse(row?.created_at ?? '');
            return Number.isFinite(at) && at < watermark;
          }
          : null,
      });
      pagesUsed += result.pages;
      if (result.truncated) {
        truncated = true;
        if (result.resumeAfter) nextPending[account.id] = result.resumeAfter;
      }
      transactions.push(...result.rows);
    }

    const { pairs, singles } = foldConversions(transactions);

    const records = [];
    let unknownTypes = 0;
    let line = 0;

    for (const pair of pairs) {
      line += 1;
      records.push(recordFromConversion(pair, { line }));
    }
    for (const tx of singles) {
      line += 1;
      const record = recordFromTransaction(tx, { line, fillsByOrder });
      if (tx._unpairedConversion) record.needs_review = true;
      if (record.needs_review && TYPE_MAP[String(tx.type ?? '').toLowerCase()] === undefined) unknownTypes += 1;
      records.push(record);
    }

    const balances = {};
    for (const account of brokerageAccounts) {
      const asset = currencyOf(account.available_balance) ?? String(account.currency ?? '').toUpperCase();
      const available = amountOf(account.available_balance);
      const hold = amountOf(account.hold);
      if (!asset) continue;
      // available + hold is the total position; comparing the ledger against
      // `available` alone would flag every account with an open order.
      // Seeded from '0' rather than null so the sum always runs through the
      // exact scaled path and comes out in one canonical form -- "0.06" and
      // "0.0600" must not read as two different balances.
      balances[asset] = addAmounts(addAmounts(balances[asset] ?? '0', available ?? '0'), hold ?? '0');
    }

    return {
      records,
      // `since` only advances when every account was walked to the end. A
      // truncated pass keeps the old watermark and records where each
      // unfinished account stopped, so the next run continues rather than
      // starting over.
      cursor: truncated
        ? { since: state.since ?? null, pending: nextPending }
        : { since: startedAt, pending: {} },
      balances: Object.fromEntries(sortedEntries(balances)),
      stats: {
        rows: transactions.length,
        pages: pagesUsed,
        unknownTypes,
        adjustedFills: adjusted,
        backfillPending: truncated,
      },
    };
  },
};

module.exports = coinbaseConnector;
module.exports._internals = {
  pageV2, pageV3Fills, summarizeFills, foldConversions, recordFromTransaction, recordFromConversion,
};

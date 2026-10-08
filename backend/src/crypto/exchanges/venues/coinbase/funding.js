'use strict';

const {
  absAmount,
  negateAmount,
  addAmounts,
  subtractAmounts,
  compareAmounts,
  isNegativeAmount,
  finalizeRecord,
} = require('../../core/shared');

// The fiat side of a Coinbase retail buy or sell that settled at a bank or card.
//
// A retail buy names what paid for it: "USD Wallet", or an external payment
// method such as a bank account or a debit card. Both readers book the trade's
// quote leg against the fiat balance -- correct for a wallet-funded buy, whose
// USD really left the USD wallet, but wrong for a bank-funded one: that money
// went from the bank straight into the purchase and never touched the wallet.
// derivedBalances (base + quote - fee) then debits a USD wallet that never
// moved, by the full cost of every bank-funded buy, and credits it with every
// sale paid out to a bank.
//
// The trade record stays exactly as the provider described it (its quote leg is
// the cost basis), and this module emits the implied fiat movement beside it:
// a deposit of what was paid for a buy, a withdrawal of what was received for a
// sell. The wallet nets to zero, and the deposit or withdrawal is the same
// shape a bank transfer already has, so Plaid fiat linking (exchange_fiat_matches)
// sees the bank leg it is looking for.
//
// Identity is derived from the trade's own external id, so a replay of the
// trade replays its funding: the API reader keys `cb:<v2 transaction id>`, and
// a current retail CSV export carries that same id in its ID column, so both
// readers produce the same `cb:<id>:funding`. Legacy retail exports (24-hex
// ids) cannot agree with the v2 ids; for those the canonical fingerprint is
// the cross-source identity, exactly as for the trade itself.

const FORMAT = 'coinbase_implied_funding';
const FUNDING_SUFFIX = ':funding';

// "USD Wallet", "USDC Wallet", "LRC Wallet": a balance inside Coinbase, whose
// own transaction (or the trade's quote leg) already moves the money.
const WALLET_METHOD = /^\S+\s+wallet$/i;

// "Bought 0.01 BTC for 410 USD using bank account Test Bank ****1234"
// "Bought 0.01 BTC for 410 USD using Visa debit ****1234"
// The sell form ("... to <method>") is accepted for symmetry; exports that do
// not name a payout method ("Sold 1 ETH for 2000 USD") yield nothing, which
// leaves the trade exactly as it was booked before this module existed.
const CSV_TRADE_NOTE = /^(?:bought|sold)\s+\$?[\d,.]+\s+\S+\s+for\s+\$?[\d,.]+\s+\S+\s+(?:using|to)\s+(.+?)\s*$/i;
const BANK_ACCOUNT_PREFIX = /^bank account\s+/i;

function isWalletPaymentMethod(name) {
  return WALLET_METHOD.test(String(name ?? '').trim());
}

function paymentMethodFromNotes(notes) {
  const match = CSV_TRADE_NOTE.exec(String(notes ?? '').trim());
  if (!match) return null;
  // The API names the same method without the "bank account" lead-in.
  const name = match[1].replace(BANK_ACCOUNT_PREFIX, '').trim();
  return name || null;
}

// Only a retail buy or sell names a payment method. Advanced Trade fills settle
// against the portfolio's own balances, and a Convert has no fiat side.
function retailSide(raw) {
  if (!raw || typeof raw !== 'object') return null;
  let type = null;
  if (raw._format === 'coinbase') type = raw.type;
  else if (raw._format === 'coinbase_retail') type = raw['Transaction Type'];
  const side = String(type ?? '').trim().toLowerCase();
  return side === 'buy' || side === 'sell' ? side : null;
}

function paymentMethodOf(raw) {
  const side = retailSide(raw);
  if (!side) return null;
  if (raw._format === 'coinbase') {
    const name = raw[side]?.payment_method_name;
    return typeof name === 'string' && name.trim() ? name.trim() : null;
  }
  return paymentMethodFromNotes(raw.Notes);
}

// Stored rows arrive with a Date; a reader's rows with an ISO string. A Date
// handed to node-pg for a timestamp-without-time-zone column is written in the
// HOST's local time, so it is always turned back into UTC text here.
function occurredAtText(value) {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
  return value ?? null;
}

function fundingExternalId(tradeExternalId) {
  return tradeExternalId ? `${tradeExternalId}${FUNDING_SUFFIX}` : null;
}

// Which observation a stored trade's payload came from. A cross-source merge
// can leave a CSV payload on a row whose `source` column says 'api' (the column
// records the strongest source seen, not whose payload survived), and the
// funding derived from that payload has to carry the payload's provenance or a
// later replay from the other source cannot merge with it.
function payloadSource(trade) {
  const format = trade?.raw?._format;
  if (format === 'coinbase_retail') return 'csv';
  if (format === 'coinbase') return 'api';
  return trade?.source ?? null;
}

/**
 * The implied fiat deposit (bank-funded buy) or withdrawal (sale paid out to a
 * bank) for one normalized Coinbase trade record, or null when the trade's fiat
 * side stayed inside Coinbase or cannot be established.
 *
 * Fail-closed: no payment method, a wallet, a quote leg that contradicts the
 * provider's own buy/sell, or a non-positive amount all yield null, which
 * leaves the trade booked exactly as before.
 *
 * `source` is the observation the funding was derived from. The readers leave
 * it unset (their services stamp every record); the stored-row backfill passes
 * it explicitly.
 */
function impliedFundingRecord(trade, { line = null, source } = {}) {
  if (!trade || trade.record_type !== 'trade') return null;
  const raw = trade.raw;
  const side = retailSide(raw);
  const method = paymentMethodOf(raw);
  if (!side || !method || isWalletPaymentMethod(method)) return null;

  const quoteAsset = trade.quote_asset ? String(trade.quote_asset) : null;
  const quote = trade.quote_amount === null || trade.quote_amount === undefined
    ? null : String(trade.quote_amount);
  const base = trade.base_amount === null || trade.base_amount === undefined
    ? null : String(trade.base_amount);
  if (!quoteAsset || quote === null || base === null) return null;
  if (compareAmounts(quote, '0') === 0 || compareAmounts(base, '0') === 0) return null;

  // A buy spends the quote and receives the base; a sell the reverse. A row
  // whose legs disagree with the side the provider named is not guessed into a
  // bank movement.
  const buying = side === 'buy';
  if (isNegativeAmount(quote) !== buying || isNegativeAmount(base) === buying) return null;

  // What actually crossed the bank boundary: the cost plus a fee charged in
  // the same fiat for a buy, the proceeds less it for a sale. That is the
  // inverse of the trade's own fiat legs, so the wallet nets to zero.
  const fee = trade.fee_amount !== null && trade.fee_amount !== undefined
    && String(trade.fee_asset ?? '') === quoteAsset && compareAmounts(String(trade.fee_amount), '0') !== 0
    ? absAmount(String(trade.fee_amount)) : '0';
  const amount = buying
    ? addAmounts(absAmount(quote), fee)
    : subtractAmounts(absAmount(quote), fee);
  if (compareAmounts(amount, '0') <= 0) return null;

  const record = finalizeRecord({
    record_type: buying ? 'deposit' : 'withdrawal',
    occurred_at: occurredAtText(trade.occurred_at),
    base_asset: quoteAsset,
    base_amount: buying ? amount : negateAmount(amount),
    quote_asset: null,
    quote_amount: null,
    fee_asset: null,
    fee_amount: null,
    tx_hash: null,
    address: null,
    external_id: fundingExternalId(trade.external_id),
    needs_review: false,
    raw: {
      _format: FORMAT,
      _source: source ?? payloadSource(trade),
      implied_by: 'payment_method',
      payment_method_name: method,
      trade_side: side,
      trade_external_id: trade.external_id,
      trade_format: raw._format,
      trade_legs: {
        quote_asset: quoteAsset,
        quote_amount: quote,
        fee_asset: trade.fee_asset ?? null,
        fee_amount: trade.fee_amount === null || trade.fee_amount === undefined ? null : String(trade.fee_amount),
      },
    },
  }, { line });
  return source === undefined ? record : { ...record, source };
}

module.exports = {
  FORMAT,
  FUNDING_SUFFIX,
  isWalletPaymentMethod,
  paymentMethodFromNotes,
  paymentMethodOf,
  retailSide,
  fundingExternalId,
  payloadSource,
  impliedFundingRecord,
};

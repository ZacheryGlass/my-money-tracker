'use strict';

const BinanceUSClient = require('./binanceusClient');
const {
  cleanAmount,
  absAmount,
  negateAmount,
  addAmounts,
  parseTimestamp,
  contentId,
  finalizeRecord,
  normalizeNetwork,
} = require('../exchangeImport/shared');

// Binance.US exposes several independent historical feeds. The cursor below
// walks them in a fixed order and is advanced only after a successful page, so
// an interrupted job resumes at the exact symbol/coin/page it had reached.
// The API key is used for GETs only; this connector has no mutation endpoint.
const EXCHANGE = 'binance_us';
const PAGE_SIZE = 1000;
const MAX_REQUESTS_INTERACTIVE = 100;
const MAX_REQUESTS_JOB = 1000;
const MAX_SYMBOLS = 2000;

const REQUIRED_PERMISSIONS = ['Read (read-only)'];

const numericMillis = (value) => {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return null;
  // Binance timestamps are milliseconds. Accept seconds too for older exports
  // and test fixtures, but never pass a bare number to parseTimestamp.
  const millis = number < 100000000000 ? number * 1000 : number;
  return new Date(millis).toISOString();
};

function timestampOf(...values) {
  for (const value of values) {
    const parsed = typeof value === 'number' || /^\d+(?:\.\d+)?$/.test(String(value ?? '').trim())
      ? numericMillis(value)
      : parseTimestamp(value);
    if (parsed) return parsed;
  }
  return null;
}

function asset(value) {
  const text = String(value ?? '').trim().toUpperCase();
  return text || null;
}

function amount(value) {
  return cleanAmount(value);
}

function record(record, amountCell) {
  return finalizeRecord(record, { amountCell });
}

function rawRecord(source, row) {
  return { _format: EXCHANGE, _source: 'api', _source_endpoint: source, ...row };
}

function tradeRecord(row, symbolMap) {
  const symbol = String(row.symbol ?? '').toUpperCase();
  const info = symbolMap.get(symbol) || {};
  const baseAsset = asset(info.baseAsset || symbol.slice(0, -4));
  const quoteAsset = asset(info.quoteAsset || symbol.slice(-4));
  const qty = amount(row.qty);
  const quoteQty = amount(row.quoteQty);
  const buyer = row.isBuyer === true || row.isBuyer === 'true';
  const baseAmount = buyer ? qty : negateAmount(qty);
  const quoteAmount = buyer ? negateAmount(quoteQty) : quoteQty;
  const feeAmount = absAmount(amount(row.commission));
  const feeAsset = asset(row.commissionAsset);
  const occurredAt = timestampOf(row.time, row.transactTime, row.insertTime);
  const id = row.id ?? row.tradeId ?? row.orderId;
  const malformed = !occurredAt || !baseAsset || !quoteAsset || qty === null || quoteQty === null || id === undefined;
  return record({
    record_type: 'trade', occurred_at: occurredAt, base_asset: baseAsset,
    base_amount: baseAmount, quote_asset: quoteAsset, quote_amount: quoteAmount,
    fee_asset: feeAsset, fee_amount: feeAmount, tx_hash: null, address: null,
    network: null, chain_id: null,
    external_id: `binanceus:trade:${symbol}:${id ?? contentId('binanceus:trade', [symbol, row.time, row.qty, row.price])}`,
    needs_review: malformed, raw: rawRecord('/api/v3/myTrades', row),
  }, [row.qty, row.quoteQty]);
}

function capitalRecord(row, type) {
  const isDeposit = type === 'deposit';
  const coin = asset(row.coin || row.asset);
  const rawAmount = amount(row.amount);
  const fee = absAmount(amount(row.transactionFee ?? row.fee));
  const occurredAt = timestampOf(row.insertTime, row.applyTime, row.completeTime, row.successTime, row.createTime);
  const txHash = row.txId || row.txid || row.txHash || null;
  const external = row.id ?? row.withdrawOrderId ?? row.txId ?? row.txid
    ?? contentId(`binanceus:${type}`, [coin, row.amount, occurredAt, txHash, row.address]);
  const status = String(row.status ?? '').toLowerCase();
  const successful = !status || ['success', 'completed', '1', 'confirmed'].includes(status);
  const malformed = !occurredAt || !coin || rawAmount === null || !successful;
  return record({
    record_type: isDeposit ? 'deposit' : 'withdrawal', occurred_at: occurredAt,
    base_asset: coin, base_amount: isDeposit ? rawAmount : negateAmount(rawAmount),
    quote_asset: null, quote_amount: null, fee_asset: isDeposit ? null : coin,
    fee_amount: isDeposit ? null : fee, tx_hash: txHash, address: row.address || row.addressTag || null,
    network: normalizeNetwork(row.network || row.networkName), chain_id: row.chainId ?? null,
    external_id: `binanceus:${type}:${external}`, needs_review: malformed,
    raw: rawRecord(`/sapi/v1/capital/${type === 'deposit' ? 'deposit/hisrec' : 'withdraw/history'}`, row),
  }, row.amount);
}

function distributionRecord(row) {
  const coin = asset(row.asset || row.coin);
  const rawAmount = amount(row.amount);
  const occurredAt = timestampOf(row.divTime, row.insertTime, row.time);
  const id = row.tranId || row.id || contentId('binanceus:distribution', [coin, row.amount, occurredAt, row.category]);
  const category = String(row.category ?? '').toLowerCase();
  const recordType = category.includes('fee') ? 'fee' : 'reward';
  return record({
    record_type: recordType, occurred_at: occurredAt, base_asset: coin,
    base_amount: rawAmount, quote_asset: null, quote_amount: null,
    fee_asset: null, fee_amount: null, tx_hash: null, address: null,
    network: null, chain_id: null, external_id: `binanceus:distribution:${id}`,
    needs_review: !occurredAt || !coin || rawAmount === null,
    raw: rawRecord('/sapi/v1/asset/assetDistributionHistory', row),
  }, row.amount);
}

function dustRecord(row, parent) {
  const from = asset(row.fromAsset || row.asset);
  const to = asset(row.toAsset || row.targetAsset);
  const fromAmount = amount(row.amount ?? row.fromAmount);
  const toAmount = amount(row.transferredAmount ?? row.toAmount);
  const fee = absAmount(amount(row.serviceChargeAmount ?? row.fee));
  const occurredAt = timestampOf(row.operateTime, row.time);
  const id = row.tranId || row.id || contentId('binanceus:dust', [from, to, row.amount, row.transferredAmount, occurredAt]);
  return record({
    record_type: 'conversion', occurred_at: occurredAt, base_asset: from,
    base_amount: negateAmount(fromAmount), quote_asset: to, quote_amount: toAmount,
    fee_asset: fee ? from : null, fee_amount: fee, tx_hash: null, address: null,
    network: null, chain_id: null, external_id: `binanceus:dust:${id}`,
    needs_review: !occurredAt || !from || !to || fromAmount === null || toAmount === null,
    raw: rawRecord('/sapi/v1/asset/query/dust-logs', { parent, ...row }),
  }, [row.amount ?? row.fromAmount, row.transferredAmount ?? row.toAmount]);
}

function fiatRecord(row, type) {
  const isDeposit = type === 'deposit';
  const currency = asset(row.fiatCurrency || row.currency || row.asset);
  const rawAmount = amount(row.amount || row.fiatAmount);
  const occurredAt = timestampOf(row.createTime, row.updateTime, row.insertTime, row.successTime);
  const id = row.orderId || row.id || contentId(`binanceus:fiat_${type}`, [currency, row.amount, occurredAt, row.paymentMethod]);
  return record({
    record_type: isDeposit ? 'deposit' : 'withdrawal', occurred_at: occurredAt,
    base_asset: currency, base_amount: isDeposit ? rawAmount : negateAmount(rawAmount),
    quote_asset: null, quote_amount: null, fee_asset: null, fee_amount: null,
    tx_hash: null, address: null, network: null, chain_id: null,
    external_id: `binanceus:fiat_${type}:${id}`,
    needs_review: !occurredAt || !currency || rawAmount === null,
    raw: rawRecord(`/sapi/v1/fiatpayment/query/${type}/history`, row),
  }, row.amount);
}

function listCoins(config) {
  return (Array.isArray(config) ? config : []).map((row) => asset(row.coin || row.asset)).filter(Boolean);
}

function accountBalances(body) {
  const balances = {};
  for (const row of body?.balances || []) {
    const coin = asset(row.asset);
    if (!coin) continue;
    const total = addAmounts(amount(row.free) ?? '0', amount(row.locked) ?? '0');
    if (total !== null) balances[coin] = addAmounts(balances[coin] ?? '0', total);
  }
  return balances;
}

function emptyCursor() {
  return {
    version: 1, phase: 'trades', symbolIndex: 0, tradeFromId: null,
    coinIndex: 0, depositOffset: 0, withdrawalOffset: 0,
    fiatDepositStart: null, fiatWithdrawStart: null,
    distributionStart: null, dustStart: null,
  };
}

function normalizeCursor(cursor) {
  const base = emptyCursor();
  if (!cursor || typeof cursor !== 'object') return base;
  return { ...base, ...cursor, version: 1 };
}

function advancePhase(state, phase) {
  const order = ['trades', 'capital', 'fiat', 'distributions', 'dust'];
  const index = order.indexOf(phase);
  const next = order[index + 1];
  return next ? { ...state, phase: next } : { ...emptyCursor(), phase: 'trades' };
}

async function sync(credentials, { cursor = null, interactive = true } = {}) {
  const client = new BinanceUSClient(credentials);
  const budget = interactive ? MAX_REQUESTS_INTERACTIVE : MAX_REQUESTS_JOB;
  let requests = 0;
  const state = normalizeCursor(cursor);
  const records = [];
  let backfillPending = false;
  let unknownTypes = 0;
  let completedAllPhases = false;

  const call = async (path, params = {}, options = {}) => {
    requests += 1;
    return client.get(path, params, options);
  };

  const account = await call('/api/v3/account');
  const exchangeInfo = await call('/api/v3/exchangeInfo', {}, { signed: false });
  const symbols = (exchangeInfo.symbols || [])
    .filter((row) => row && row.symbol && row.baseAsset && row.quoteAsset)
    .slice(0, MAX_SYMBOLS);
  const symbolMap = new Map(symbols.map((row) => [String(row.symbol).toUpperCase(), {
    baseAsset: row.baseAsset, quoteAsset: row.quoteAsset,
  }]));
  const coins = listCoins(await call('/sapi/v1/capital/config/getall'));

  // Trades are symbol-specific. A page full of rows advances by trade id;
  // a short page completes that symbol. Delisted symbols are not in
  // exchangeInfo and are reported as an explicit coverage limitation.
  while (state.phase === 'trades' && requests < budget) {
    const row = symbols[state.symbolIndex];
    if (!row) { Object.assign(state, advancePhase(state, 'trades')); break; }
    const params = { symbol: row.symbol, limit: PAGE_SIZE };
    if (state.tradeFromId !== null) params.fromId = state.tradeFromId;
    const page = await call('/api/v3/myTrades', params);
    for (const item of Array.isArray(page) ? page : []) {
      const normalized = tradeRecord(item, symbolMap);
      if (normalized.needs_review) unknownTypes += 1;
      records.push(normalized);
    }
    if (!Array.isArray(page) || page.length < PAGE_SIZE) {
      state.symbolIndex += 1; state.tradeFromId = null;
    } else {
      const last = page[page.length - 1];
      const next = Number(last?.id);
      if (!Number.isSafeInteger(next)) {
        state.symbolIndex += 1; state.tradeFromId = null;
      } else state.tradeFromId = next + 1;
    }
  }
  if (state.phase === 'trades' && state.symbolIndex < symbols.length) backfillPending = true;

  // Deposit/withdrawal history is paged per coin by offset. Both endpoints
  // return at most 1000 rows and expose tx id/address/network for matching.
  while (state.phase === 'capital' && requests < budget) {
    const coin = coins[state.coinIndex];
    if (!coin) { Object.assign(state, advancePhase(state, 'capital')); break; }
    const deposits = await call('/sapi/v1/capital/deposit/hisrec', { coin, offset: state.depositOffset, limit: PAGE_SIZE });
    const withdrawals = await call('/sapi/v1/capital/withdraw/history', { coin, offset: state.withdrawalOffset, limit: PAGE_SIZE });
    for (const item of Array.isArray(deposits) ? deposits : []) records.push(capitalRecord(item, 'deposit'));
    for (const item of Array.isArray(withdrawals) ? withdrawals : []) records.push(capitalRecord(item, 'withdrawal'));
    const depositFull = Array.isArray(deposits) && deposits.length >= PAGE_SIZE;
    const withdrawalFull = Array.isArray(withdrawals) && withdrawals.length >= PAGE_SIZE;
    if (depositFull) state.depositOffset += PAGE_SIZE;
    else state.depositOffset = 0;
    if (withdrawalFull) state.withdrawalOffset += PAGE_SIZE;
    else state.withdrawalOffset = 0;
    if (!depositFull && !withdrawalFull) state.coinIndex += 1;
    if (requests >= budget && (depositFull || withdrawalFull)) backfillPending = true;
  }
  if (state.phase === 'capital' && state.coinIndex < coins.length) backfillPending = true;

  // Fiat and asset feeds use time windows/cursors that vary by account plan.
  // Fetch the newest bounded page on each steady-state pass; the cursor keeps
  // older pages reachable during the first backfill without claiming a full
  // history when the provider has no published retention guarantee.
  if (state.phase === 'fiat' && requests < budget) {
    const fiatDeposits = await call('/sapi/v1/fiatpayment/query/deposit/history', { page: 1, rows: PAGE_SIZE });
    const fiatWithdrawals = await call('/sapi/v1/fiatpayment/query/withdraw/history', { page: 1, rows: PAGE_SIZE });
    for (const item of Array.isArray(fiatDeposits?.data) ? fiatDeposits.data : (Array.isArray(fiatDeposits) ? fiatDeposits : [])) records.push(fiatRecord(item, 'deposit'));
    for (const item of Array.isArray(fiatWithdrawals?.data) ? fiatWithdrawals.data : (Array.isArray(fiatWithdrawals) ? fiatWithdrawals : [])) records.push(fiatRecord(item, 'withdrawal'));
    if ((fiatDeposits?.total || fiatWithdrawals?.total) > PAGE_SIZE) backfillPending = true;
    Object.assign(state, advancePhase(state, 'fiat'));
  }

  if (state.phase === 'distributions' && requests < budget) {
    const body = await call('/sapi/v1/asset/assetDistributionHistory', { limit: PAGE_SIZE });
    const rows = Array.isArray(body?.rows) ? body.rows : (Array.isArray(body) ? body : []);
    records.push(...rows.map(distributionRecord));
    if (rows.length >= PAGE_SIZE) backfillPending = true;
    Object.assign(state, advancePhase(state, 'distributions'));
  }

  if (state.phase === 'dust' && requests < budget) {
    const body = await call('/sapi/v1/asset/query/dust-logs', { limit: PAGE_SIZE });
    const groups = body?.userDustConvertHistory || body?.data || [];
    const rows = groups.flatMap((group) => group?.userAssetDribbletDetails || group?.rows || []);
    records.push(...rows.map((row) => dustRecord(row, groups.find((group) => group?.tranId === row.tranId) || null)));
    if (rows.length >= PAGE_SIZE) backfillPending = true;
    Object.assign(state, advancePhase(state, 'dust'));
    completedAllPhases = true;
  }

  // A complete generation starts a fresh incremental pass next time. If the
  // request budget stopped before a later phase, completedAllPhases is false;
  // retaining that phase is what prevents an apparently successful run from
  // skipping fiat, distribution, or dust history forever.
  if (completedAllPhases && !backfillPending) Object.assign(state, emptyCursor());

  return {
    records, cursor: state, balances: accountBalances(account), balancesComplete: true,
    stats: {
      rows: records.length, requests, unknownTypes,
      backfillPending: Boolean(backfillPending),
      symbols: symbols.length, coins: coins.length,
      coverageLimitations: [
        'Binance.US exchangeInfo omits delisted symbols; historical trades for those symbols require an export.',
        'Product-specific staking/Earn and internal venue-transfer history are not asserted by the generic feeds; retain an account export for those rows.',
      ],
    },
  };
}

const connector = {
  EXCHANGE, REQUIRED_PERMISSIONS,
  client(credentials) { return new BinanceUSClient(credentials); },
  async probe(credentials) {
    const body = await new BinanceUSClient(credentials).getAccount();
    return { ok: true, detail: `Authenticated. ${(body.balances || []).length} asset balance(s) visible.`, assets: (body.balances || []).map((row) => row.asset).filter(Boolean).sort() };
  },
  sync,
};

module.exports = connector;
module.exports.MAX_REQUESTS_INTERACTIVE = MAX_REQUESTS_INTERACTIVE;
module.exports._internals = {
  timestampOf, tradeRecord, capitalRecord, distributionRecord, dustRecord, fiatRecord,
  accountBalances, normalizeCursor, emptyCursor,
};

'use strict';

const crypto = require('node:crypto');
const BinanceUSClient = require('./binanceusClient');
const {
  cleanAmount,
  absAmount,
  negateAmount,
  addAmounts,
  compareAmounts,
  isNegativeAmount,
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
// Binance.US does not use one universal page size. Keep the provider limits
// beside the feed that owns them so a new endpoint cannot accidentally inherit
// an invalid value from another history feed.
const TRADE_PAGE_SIZE = 1000;
const CAPITAL_PAGE_SIZE = 1000;
const DISTRIBUTION_PAGE_SIZE = 500;
const CAPITAL_WINDOW_MS = 90 * 24 * 60 * 60 * 1000;
// Binance.US first accepted deposits in September 2019. Include that entire month.
const HISTORY_START = Date.UTC(2019, 8, 1);
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
  const successful = !status || ['success', 'completed', 'confirmed', isDeposit ? '1' : '6'].includes(status);
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

function distributionRecord(row, endpoint = '/sapi/v1/asset/assetDistributionHistory') {
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
    raw: rawRecord(endpoint, row),
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

function fiatRows(body) {
  // The current Binance.US response is { assetLogRecordList: [...] }.
  // Keep the older data/array shapes as a compatibility fallback for accounts
  // served by an older API deployment.
  if (Array.isArray(body?.assetLogRecordList)) return body.assetLogRecordList;
  if (Array.isArray(body?.data)) return body.data;
  return Array.isArray(body) ? body : [];
}

function listCoins(config) {
  return (Array.isArray(config) ? config : []).map((row) => asset(row.coin || row.asset)).filter(Boolean);
}

function accountBalances(body) {
  return accountBalanceDetails(body).balances;
}

function accountBalanceDetails(body, staking = null) {
  const balances = {};
  const balanceDetails = {};
  let complete = Array.isArray(body?.balances);
  for (const row of Array.isArray(body?.balances) ? body.balances : []) {
    const coin = asset(row.asset);
    const free = amount(row.free);
    const locked = amount(row.locked);
    if (!coin || free === null || locked === null) { complete = false; continue; }
    const total = addAmounts(free, locked);
    if (total !== null) {
      balances[coin] = addAmounts(balances[coin] ?? '0', total);
      const providerCode = String(row.asset).trim();
      const detail = balanceDetails[coin] || { provider_asset_codes: [], provider_balances: {} };
      detail.provider_asset_codes.push(providerCode);
      detail.provider_balances[providerCode] = addAmounts(
        detail.provider_balances[providerCode] ?? '0', total
      );
      balanceDetails[coin] = detail;
    }
  }
  // Staked funds live outside the spot free/locked balance. Pending rewards
  // are not credited holdings. An in-progress unstake has undocumented overlap
  // semantics, so retain the evidence but do not certify that snapshot.
  if (staking?.success !== true || staking.code !== '000000' || !Array.isArray(staking.data)) {
    complete = false;
  } else {
    const seen = new Set();
    for (const row of staking.data) {
      const coin = asset(row.asset);
      const staked = amount(row.stakingAmount);
      if (!coin || staked === null || isNegativeAmount(staked) || seen.has(coin)) {
        complete = false; continue;
      }
      seen.add(coin);
      const unstaking = amount(row.unstakeInProgress ?? '0');
      if (unstaking === null || compareAmounts(unstaking, '0') !== 0) complete = false;
      balances[coin] = addAmounts(balances[coin] ?? '0', staked);
      const detail = balanceDetails[coin] ||= { provider_asset_codes: [coin], provider_balances: {} };
      detail.provider_balances[coin] = addAmounts(detail.provider_balances[coin] ?? '0', staked);
      detail.staking = { amount: staked, unstake_in_progress: row.unstakeInProgress ?? null,
        pending_rewards: row.pendingRewards ?? null };
    }
  }
  for (const detail of Object.values(balanceDetails)) {
    detail.provider_asset_codes = [...new Set(detail.provider_asset_codes)].sort();
  }
  return { balances, balanceDetails, complete };
}

function emptyCursor(capitalThrough = {}) {
  return {
    version: 2, phase: 'trades', symbolIndex: 0, tradeFromId: null,
    coinIndex: 0, capitalCoins: null, capitalEnd: null, capitalStart: null,
    capitalFeed: 'deposit', capitalOffset: 0, capitalFingerprint: null, capitalThrough: { ...capitalThrough },
    rewardsPage: 1, rewardsEnd: null, rewardsFingerprint: null,
    fiatDepositDone: false, fiatWithdrawDone: false,
    distributionEnd: null, dustEnd: null,
  };
}

function normalizeCursor(cursor) {
  // v1 only queried the implicit recent capital window. Restart once rather
  // than reinterpret its offsets as proof of historical coverage. Replay IDs
  // make the other feeds safe to revisit too.
  return cursor?.version === 2 ? { ...emptyCursor(), ...cursor, capitalThrough: { ...cursor.capitalThrough } } : emptyCursor();
}

function pageFingerprint(rows) {
  return crypto.createHash('sha256').update(JSON.stringify(rows)).digest('hex');
}

function historyError(message) {
  const error = new Error(`Binance.US ${message}`);
  error.code = 'BINANCE_US_HISTORY_INCOMPLETE';
  return error;
}

function advancePhase(state, phase) {
  const order = ['trades', 'capital', 'fiat', 'distributions', 'dust'];
  const index = order.indexOf(phase);
  const next = order[index + 1];
  return next ? { ...state, phase: next } : { ...emptyCursor(state.capitalThrough), rewardsPage: state.rewardsPage,
    rewardsEnd: state.rewardsEnd, rewardsFingerprint: state.rewardsFingerprint };
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
  const feedLimitations = [];

  const call = async (path, params = {}, options = {}) => {
    requests += 1;
    return client.get(path, params, options);
  };

  const account = await call('/api/v3/account');
  // A staking permission/outage must not discard otherwise recoverable history
  // or publish a spot-only snapshot as the user's full holdings.
  const staking = await call('/sapi/v1/staking/stakingBalance').catch(() => null);
  const balanceObservedAt = new Date().toISOString();
  const exchangeInfo = await call('/api/v3/exchangeInfo', {}, { signed: false });
  const listedSymbols = Array.isArray(exchangeInfo.symbols) ? exchangeInfo.symbols : [];
  const tradeableSymbols = listedSymbols
    .filter((row) => row && row.symbol && row.baseAsset && row.quoteAsset);
  const symbolsTruncated = tradeableSymbols.length > MAX_SYMBOLS;
  const symbols = tradeableSymbols.slice(0, MAX_SYMBOLS);
  const symbolMap = new Map(symbols.map((row) => [String(row.symbol).toUpperCase(), {
    baseAsset: row.baseAsset, quoteAsset: row.quoteAsset,
  }]));
  const config = await call('/sapi/v1/capital/config/getall');
  if (!Array.isArray(config)) throw historyError('coin list is malformed');
  const coins = listCoins(config);

  // Read one rewards page on EVERY batch, including while the much larger
  // capital backfill is pending. Stable provider IDs are shared with CSV and
  // distribution records; staking principal and restakes never become income.
  try {
    const endTime = state.rewardsEnd ?? Date.now();
    const body = await call('/sapi/v1/staking/stakingRewardsHistory', {
      startTime: 0, endTime, page: state.rewardsPage, limit: DISTRIBUTION_PAGE_SIZE,
    });
    if (body?.success !== true || body.code !== '000000' || !Array.isArray(body.data)
        || !Number.isSafeInteger(body.total) || body.total < 0) {
      throw historyError('staking rewards response is malformed');
    }
    const rows = body.data;
    const read = (state.rewardsPage - 1) * DISTRIBUTION_PAGE_SIZE + rows.length;
    if (rows.length > DISTRIBUTION_PAGE_SIZE || read > body.total
        || (rows.length < DISTRIBUTION_PAGE_SIZE && read < body.total)
        || rows.some(row => !row || row.tranId === undefined || row.tranId === null)) {
      throw historyError('staking rewards page is incomplete');
    }
    const fingerprint = pageFingerprint(rows);
    if (rows.length && fingerprint === state.rewardsFingerprint) {
      throw historyError('staking rewards pagination repeated a page');
    }
    records.push(...rows.map(row => distributionRecord(row, '/sapi/v1/staking/stakingRewardsHistory')));
    if (read < body.total) {
      state.rewardsPage += 1;
      state.rewardsEnd = endTime;
      state.rewardsFingerprint = fingerprint;
      backfillPending = true;
    } else {
      state.rewardsPage = 1; state.rewardsEnd = null; state.rewardsFingerprint = null;
    }
  } catch (error) {
    backfillPending = true;
    feedLimitations.push(`Binance.US staking reward history is incomplete: ${error.message}`);
  }

  // Trades are symbol-specific. A page full of rows advances by trade id;
  // a short page completes that symbol. Delisted symbols are not in
  // exchangeInfo and are reported as an explicit coverage limitation.
  while (state.phase === 'trades' && requests < budget) {
    const row = symbols[state.symbolIndex];
    if (!row) { Object.assign(state, advancePhase(state, 'trades')); break; }
    const params = { symbol: row.symbol, limit: TRADE_PAGE_SIZE };
    if (state.tradeFromId !== null) params.fromId = state.tradeFromId;
    const page = await call('/api/v3/myTrades', params);
    for (const item of Array.isArray(page) ? page : []) {
      const normalized = tradeRecord(item, symbolMap);
      if (normalized.needs_review) unknownTypes += 1;
      records.push(normalized);
    }
    if (!Array.isArray(page) || page.length < TRADE_PAGE_SIZE) {
      state.symbolIndex += 1; state.tradeFromId = null;
    } else {
      const last = page[page.length - 1];
      const next = Number(last?.id);
      if (!Number.isSafeInteger(next)) {
        state.symbolIndex += 1; state.tradeFromId = null;
      } else {
        if (state.tradeFromId !== null && next + 1 <= state.tradeFromId) {
          const error = new Error(`Binance.US trade cursor stalled for ${row.symbol}`);
          error.code = 'BINANCE_US_CURSOR_STALLED';
          throw error;
        }
        state.tradeFromId = next + 1;
      }
    }
  }
  if (state.phase === 'trades' && state.symbolIndex < symbols.length) backfillPending = true;

  // Capital requires both a coin and explicit <=90-day windows. Freeze the
  // coin list and upper bound across batches; a changed provider list must not
  // make a saved numeric index skip a coin. Checkpoints survive generations.
  if (state.phase === 'capital' && state.capitalCoins === null) {
    state.capitalCoins = [...new Set([...coins, ...Object.keys(state.capitalThrough)])].sort();
    state.capitalEnd = Date.now();
  }
  while (state.phase === 'capital' && requests < budget) {
    const coin = state.capitalCoins[state.coinIndex];
    if (!coin) { Object.assign(state, advancePhase(state, 'capital')); break; }
    const startTime = state.capitalStart ?? Math.max(
      HISTORY_START, (state.capitalThrough[coin] ?? HISTORY_START) - CAPITAL_WINDOW_MS
    );
    const endTime = Math.min(startTime + CAPITAL_WINDOW_MS - 1, state.capitalEnd);
    const isDeposit = state.capitalFeed === 'deposit';
    const endpoint = isDeposit ? 'deposit/hisrec' : 'withdraw/history';
    const rows = await call(`/sapi/v1/capital/${endpoint}`, {
      coin, startTime, endTime, offset: state.capitalOffset, limit: CAPITAL_PAGE_SIZE,
    });
    if (!Array.isArray(rows) || rows.length > CAPITAL_PAGE_SIZE) {
      throw historyError(`${state.capitalFeed} history is malformed`);
    }
    const fingerprint = pageFingerprint(rows);
    if (rows.length && fingerprint === state.capitalFingerprint) {
      throw historyError(`${state.capitalFeed} pagination repeated a page`);
    }
    records.push(...rows.map(row => capitalRecord(row, isDeposit ? 'deposit' : 'withdrawal')));
    if (rows.length === CAPITAL_PAGE_SIZE) {
      state.capitalOffset += CAPITAL_PAGE_SIZE;
      state.capitalFingerprint = fingerprint;
      state.capitalStart = startTime;
    } else {
      state.capitalOffset = 0; state.capitalFingerprint = null;
      if (isDeposit) {
        state.capitalFeed = 'withdrawal'; state.capitalStart = startTime;
      } else {
        state.capitalFeed = 'deposit';
        state.capitalStart = endTime + 1;
        if (endTime === state.capitalEnd) {
          state.capitalThrough[coin] = endTime;
          state.coinIndex += 1; state.capitalStart = null;
        }
      }
    }
  }

  // Fiat history is not a generic page/rows endpoint. Binance.US exposes an
  // offset plus a provider-defined (currently 90-day) time window and returns
  // assetLogRecordList. Request the documented shape and retain the export
  // limitation for older fiat rows that the API does not expose in this pass.
  if (state.phase === 'fiat' && requests < budget) {
    if (!state.fiatDepositDone && requests < budget) {
      const body = await call('/sapi/v1/fiatpayment/query/deposit/history', { offset: 0 });
      const rows = fiatRows(body);
      rows.forEach((item) => records.push(fiatRecord(item, 'deposit')));
      state.fiatDepositDone = true;
    }
    if (!state.fiatWithdrawDone && requests < budget) {
      const body = await call('/sapi/v1/fiatpayment/query/withdraw/history', { offset: 0 });
      const rows = fiatRows(body);
      rows.forEach((item) => records.push(fiatRecord(item, 'withdrawal')));
      state.fiatWithdrawDone = true;
    }
    if (state.fiatDepositDone && state.fiatWithdrawDone) Object.assign(state, advancePhase(state, 'fiat'));
  }

  if (state.phase === 'distributions' && requests < budget) {
    const params = { limit: DISTRIBUTION_PAGE_SIZE };
    if (state.distributionEnd !== null && state.distributionEnd !== undefined) {
      params.endTime = state.distributionEnd;
    }
    const body = await call('/sapi/v1/asset/assetDistributionHistory', params);
    const rows = Array.isArray(body?.rows) ? body.rows : (Array.isArray(body) ? body : []);
    records.push(...rows.map(row => distributionRecord(row)));
    if (rows.length >= DISTRIBUTION_PAGE_SIZE) {
      const times = rows.map((row) => Date.parse(timestampOf(row.divTime, row.insertTime, row.time) || '')).filter(Number.isFinite);
      const oldest = times.length ? Math.min(...times) : null;
      if (oldest === null) {
        const error = new Error('Binance.US distribution history page has no usable timestamps; cannot resume safely');
        error.code = 'BINANCE_US_CURSOR_STALLED';
        throw error;
      } else {
        const nextEnd = Math.max(0, oldest - 1);
        if (state.distributionEnd !== null && nextEnd >= state.distributionEnd) {
          const error = new Error('Binance.US distribution history cursor did not move backwards');
          error.code = 'BINANCE_US_CURSOR_STALLED';
          throw error;
        }
        state.distributionEnd = nextEnd;
        backfillPending = true;
      }
    } else {
      state.distributionEnd = null;
      Object.assign(state, advancePhase(state, 'distributions'));
    }
  }

  if (state.phase === 'dust' && requests < budget) {
    // This endpoint has no limit parameter and requires both timestamps. A
    // zero start is the provider's documented way to request the full
    // available history; keep the old end cursor for a resumed pass.
    const params = {
      startTime: 0,
      endTime: state.dustEnd !== null && state.dustEnd !== undefined
        ? state.dustEnd : Date.now(),
    };
    const body = await call('/sapi/v1/asset/query/dust-logs', params);
    const groups = body?.userDustConvertHistory || body?.data || [];
    const rows = groups.flatMap((group) => group?.userAssetDribbletDetails || group?.rows || []);
    records.push(...rows.map((row) => dustRecord(row, groups.find((group) => group?.tranId === row.tranId) || null)));
    state.dustEnd = null;
    Object.assign(state, advancePhase(state, 'dust'));
    completedAllPhases = true;
  }

  // A complete generation starts a fresh incremental pass next time. If the
  // request budget stopped before a later phase, completedAllPhases is false;
  // retaining that phase is what prevents an apparently successful run from
  // skipping fiat, distribution, or dust history forever.
  // If the request budget stopped exactly after the last item of a phase, the
  // phase marker has not advanced yet. Treat that as pending too; the next
  // batch will advance it without skipping the following feed.
  if (!completedAllPhases) backfillPending = true;
  if (completedAllPhases && !backfillPending) Object.assign(state, emptyCursor(state.capitalThrough));

  const coverageLimitations = [
    'Binance.US exchangeInfo omits delisted symbols; historical trades for those symbols require an export.',
    'Staking rewards are fetched separately; staking allocations and internal venue transfers are not asserted as external flows or income.',
    ...feedLimitations,
    'Binance.US fiat history uses a provider-defined 90-day window; older fiat deposits or withdrawals require an account export.',
    ...(symbolsTruncated
      ? [`Binance.US returned more than ${MAX_SYMBOLS} symbols; the trade walk is capped at the first ${MAX_SYMBOLS}.`]
      : []),
  ];

  const normalizedBalances = accountBalanceDetails(account, staking);
  if (!normalizedBalances.complete) {
    coverageLimitations.push('Binance.US staking balances are unavailable, malformed, or include an unresolved unstake; total balance reconciliation is incomplete.');
  }
  return {
    records,
    cursor: state,
    balances: normalizedBalances.balances,
    balance_details: normalizedBalances.balanceDetails,
    balance_observed_at: balanceObservedAt,
    balancesComplete: normalizedBalances.complete,
    coverageLimitations,
    stats: {
      rows: records.length, requests, unknownTypes,
      backfillPending: Boolean(backfillPending),
      symbols: symbols.length, coins: coins.length,
      coverageLimitations,
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
  accountBalances, accountBalanceDetails, normalizeCursor, emptyCursor, HISTORY_START, CAPITAL_WINDOW_MS,
};

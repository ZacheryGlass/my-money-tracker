'use strict';

const pool = require('../config/database');
const logger = require('../config/logger');
const EthWallet = require('../models/EthWallet');
const PriceService = require('./PriceService');
const PriceCache = require('../models/PriceCache');
const { shortAddress } = require('../utils/ethAddress');

// Every address-label write runs refreshClassificationsForUser, which rebuilds
// each of that owner's wallets and so calls CoinGecko once per wallet. The
// triage queue makes rapid sequential
// labeling the normal workflow, so without this a handful of clicks will
// rate-limit a free-tier key. Token prices do not depend on labels, so reusing
// a recent response across back-to-back rebuilds is safe; the nightly sync
// benefits too. Keyed by the exact contract set, since that is what the URL is.
const TOKEN_PRICE_TTL_MS = 5 * 60 * 1000;
// Failures expire sooner so a transient rate-limit does not keep the ledger on
// stale amounts for the full window once the API recovers.
const TOKEN_PRICE_FAILURE_TTL_MS = 30 * 1000;
const TOKEN_PRICE_CACHE_MAX = 32;
const tokenPriceCache = new Map();

// transactions.amount is DECIMAL(15,2); clamp so one absurd scam-token price
// cannot fail the whole rebuild.
function toAmount(value) {
  const capped = Math.max(Math.min(value, 9999999999999.99), -9999999999999.99);
  return Math.round(capped * 100) / 100;
}

// Pure: one eth_transfers row -> a transactions row body, or null when the
// transfer should not appear in the ledger. Ledger sign convention is Plaid's:
// positive = money leaving the account.
//
// USD values use the CURRENT ETH/token price, not the price on the transfer
// date -- good enough for an activity ledger, not for tax reporting.
function buildMirrorRow(transfer, walletAddress, { ethPrice = 0, tokenPrices = {}, ignoredContracts = new Set(), priorAmounts = {} } = {}) {
  const wallet = walletAddress.toLowerCase();
  const outgoing = transfer.from_address === wallet;
  // Own beats exchange (reclassify also encodes this, belt and suspenders):
  // a tracked wallet that happens to be labeled stays a self-transfer.
  const exchange = transfer.counterparty_is_own ? null : transfer.counterparty_exchange || null;
  const exchangeCategory = outgoing ? 'CRYPTO_EXCHANGE_DEPOSIT' : 'CRYPTO_EXCHANGE_WITHDRAWAL';

  if (transfer.transfer_type === 'gas') {
    const eth = Number(transfer.value_wei) / 1e18;
    return {
      category: 'CRYPTO_GAS_FEE',
      name: 'Gas fee',
      amount: toAmount(eth * ethPrice),
    };
  }

  // Failed transfers moved no value; only their gas row (above) is real.
  if (transfer.is_error) return null;

  // NFTs stay out of the ledger. value_wei on these rows is a count of units,
  // not wei and not a scaled token amount, so the branches below would read a
  // 1-of-1 mint as 1e-18 ETH and post a bogus CRYPTO_EXTERNAL row for it. The
  // real economics of an NFT trade are already in the ETH leg and the gas row;
  // presenting the NFT itself is the activity layer's job (#56).
  if (transfer.transfer_type === 'nft' || transfer.transfer_type === 'nft1155') return null;

  if (transfer.transfer_type === 'token') {
    const contract = transfer.token_contract;
    if (!contract || ignoredContracts.has(contract)) return null;
    const decimals = transfer.token_decimals != null ? Number(transfer.token_decimals) : 18;
    const quantity = Number(transfer.value_wei) / 10 ** decimals;
    const price = Number(tokenPrices[contract]?.usd);
    // No price this round -- a rate-limited or unlisted token. Reuse whatever
    // this row was worth on the last successful rebuild: a stale amount beats a
    // fabricated $0, which would silently erase the token side of the ledger
    // until the next healthy sync. Falls back to 0 for genuinely new rows.
    const amount = Number.isFinite(price)
      ? toAmount(outgoing ? quantity * price : -(quantity * price))
      : Number(priorAmounts[transfer.id] ?? 0);
    const symbol = transfer.token_symbol || 'TOKEN';
    return {
      category: transfer.counterparty_is_own ? 'CRYPTO_SELF_TRANSFER'
        : exchange ? exchangeCategory
        : 'CRYPTO_TOKEN',
      name: outgoing
        ? `${symbol} → ${exchange || shortAddress(transfer.to_address)}`
        : `${symbol} ← ${exchange || shortAddress(transfer.from_address)}`,
      amount,
    };
  }

  const eth = Number(transfer.value_wei) / 1e18;
  const usd = eth * ethPrice;
  return {
    category: transfer.counterparty_is_own ? 'CRYPTO_SELF_TRANSFER'
      : exchange ? exchangeCategory
      : 'CRYPTO_EXTERNAL',
    name: outgoing
      ? `ETH → ${exchange || shortAddress(transfer.to_address)}`
      : `ETH ← ${exchange || shortAddress(transfer.from_address)}`,
    amount: toAmount(outgoing ? usd : -usd),
  };
}

class EthTransactionMirrorService {
  static async _getEthPrice() {
    const cached = await pool.query(
      "SELECT price_usd FROM price_cache WHERE UPPER(ticker) = 'ETH'"
    );
    if (cached.rows.length) return Number(cached.rows[0].price_usd);

    // First sync can land before the daily price job has ever run.
    const fetched = await PriceService.fetchPrice('ETH', 'Crypto');
    if (fetched) {
      await PriceCache.upsert('ETH', fetched.price, fetched.source);
      return fetched.price;
    }
    logger.warn('No ETH price available; mirrored transactions get $0 amounts until the next sync');
    return 0;
  }

  // Cached CoinGecko token lookup. On failure returns {} rather than throwing:
  // the caller then falls back to each row's previous amount, so a transient
  // rate-limit degrades to stale numbers instead of zeroing the ledger.
  static async _getTokenPrices(contracts, walletId) {
    if (!contracts.length) return {};
    const key = [...contracts].sort().join(',');
    const cached = tokenPriceCache.get(key);
    if (cached && Date.now() - cached.at < cached.ttl) return cached.prices;

    try {
      const prices = await PriceService.fetchCoinGeckoJson(
        `https://api.coingecko.com/api/v3/simple/token_price/ethereum?contract_addresses=${encodeURIComponent(key)}&vs_currencies=usd`
      );
      this._cacheTokenPrices(key, prices);
      return prices;
    } catch (err) {
      logger.warn({ walletId, err }, 'Token price lookup failed; token rows keep their previous amounts');
      // Cache the failure too, on a shorter TTL. Without this a rate-limit
      // storm re-hits CoinGecko on every wallet of every rebuild -- exactly the
      // scenario the cache exists to prevent, since the failure arrives fastest
      // and so recurs most often.
      this._cacheTokenPrices(key, {}, TOKEN_PRICE_FAILURE_TTL_MS);
      return {};
    }
  }

  static _cacheTokenPrices(key, prices, ttl = TOKEN_PRICE_TTL_MS) {
    // Evict the oldest single entry rather than clearing the map: Map preserves
    // insertion order, so the first key is the least recently written. Clearing
    // would throw away entries written moments ago and re-trigger the very
    // fetches this cache is meant to avoid.
    if (tokenPriceCache.size >= TOKEN_PRICE_CACHE_MAX) {
      tokenPriceCache.delete(tokenPriceCache.keys().next().value);
    }
    tokenPriceCache.set(key, { at: Date.now(), prices, ttl });
  }

  // Deterministic full rebuild of the wallet account's mirrored ledger rows.
  static async rebuildForWallet(walletId) {
    const wallet = await EthWallet.findById(walletId);
    if (!wallet) throw new Error(`EthWallet ${walletId} not found`);
    const account = await EthWallet.getAccountForWallet(walletId);
    if (!account) return { skipped: true };

    const [transfersResult, ignoredResult] = await Promise.all([
      pool.query('SELECT * FROM eth_transfers WHERE wallet_id = $1 ORDER BY block_number, id', [walletId]),
      pool.query('SELECT contract_address FROM eth_ignored_tokens WHERE user_id = $1', [wallet.user_id]),
    ]);
    const transfers = transfersResult.rows;
    const ignoredContracts = new Set(ignoredResult.rows.map((row) => row.contract_address));

    const ethPrice = await this._getEthPrice();

    const contracts = [...new Set(
      transfers
        .filter((t) => t.transfer_type === 'token' && t.token_contract && !ignoredContracts.has(t.token_contract))
        .map((t) => t.token_contract)
    )];
    const tokenPrices = await this._getTokenPrices(contracts, walletId);

    // Read the amounts this rebuild is about to overwrite, so a token whose
    // price is unavailable can keep its last known value instead of dropping
    // to $0. Must run before the DELETE below.
    const priorResult = await pool.query(
      'SELECT eth_transfer_id, amount FROM transactions WHERE account_id = $1 AND eth_transfer_id IS NOT NULL',
      [account.id]
    );
    const priorAmounts = Object.fromEntries(
      priorResult.rows.map((row) => [row.eth_transfer_id, row.amount])
    );

    const rows = [];
    for (const transfer of transfers) {
      const body = buildMirrorRow(transfer, wallet.address, { ethPrice, tokenPrices, ignoredContracts, priorAmounts });
      if (!body) continue;
      rows.push({
        eth_transfer_id: transfer.id,
        date: transfer.block_time,
        ...body,
      });
    }

    await pool.query(
      'DELETE FROM transactions WHERE account_id = $1 AND eth_transfer_id IS NOT NULL',
      [account.id]
    );

    const CHUNK = 500;
    for (let start = 0; start < rows.length; start += CHUNK) {
      const chunk = rows.slice(start, start + CHUNK);
      const values = [];
      const placeholders = chunk.map((row, i) => {
        const base = i * 5;
        values.push(row.eth_transfer_id, row.date, row.name, row.amount, row.category);
        return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, ${account.id}, 'USD', FALSE)`;
      });
      await pool.query(
        `INSERT INTO transactions (eth_transfer_id, date, name, amount, category, account_id, currency_code, pending)
         VALUES ${placeholders.join(', ')}
         ON CONFLICT (eth_transfer_id) WHERE eth_transfer_id IS NOT NULL DO NOTHING`,
        values
      );
    }

    logger.info({ walletId, mirrored: rows.length }, 'ETH transaction mirror rebuilt');
    return { mirrored: rows.length };
  }

}

module.exports = EthTransactionMirrorService;
module.exports.buildMirrorRow = buildMirrorRow;

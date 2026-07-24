'use strict';

const pool = require('../config/database');
const logger = require('../config/logger');
const EthWallet = require('../models/EthWallet');
const PriceService = require('./PriceService');
const PriceCache = require('../models/PriceCache');

function shortAddress(address) {
  return address ? `${address.slice(0, 6)}…${address.slice(-4)}` : 'unknown';
}

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
function buildMirrorRow(transfer, walletAddress, { ethPrice = 0, tokenPrices = {}, ignoredContracts = new Set() } = {}) {
  const wallet = walletAddress.toLowerCase();
  const outgoing = transfer.from_address === wallet;

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

  if (transfer.transfer_type === 'token') {
    const contract = transfer.token_contract;
    if (!contract || ignoredContracts.has(contract)) return null;
    const decimals = transfer.token_decimals != null ? Number(transfer.token_decimals) : 18;
    const quantity = Number(transfer.value_wei) / 10 ** decimals;
    const price = Number(tokenPrices[contract]?.usd);
    const usd = Number.isFinite(price) ? quantity * price : 0;
    const symbol = transfer.token_symbol || 'TOKEN';
    return {
      category: transfer.counterparty_is_own ? 'CRYPTO_SELF_TRANSFER' : 'CRYPTO_TOKEN',
      name: outgoing
        ? `${symbol} → ${shortAddress(transfer.to_address)}`
        : `${symbol} ← ${shortAddress(transfer.from_address)}`,
      amount: toAmount(outgoing ? usd : -usd),
    };
  }

  const eth = Number(transfer.value_wei) / 1e18;
  const usd = eth * ethPrice;
  return {
    category: transfer.counterparty_is_own ? 'CRYPTO_SELF_TRANSFER' : 'CRYPTO_EXTERNAL',
    name: outgoing
      ? `ETH → ${shortAddress(transfer.to_address)}`
      : `ETH ← ${shortAddress(transfer.from_address)}`,
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

  // Deterministic full rebuild of the wallet account's mirrored ledger rows.
  static async rebuildForWallet(walletId) {
    const wallet = await EthWallet.findById(walletId);
    if (!wallet) throw new Error(`EthWallet ${walletId} not found`);
    const account = await EthWallet.getAccountForWallet(walletId);
    if (!account) return { skipped: true };

    const [transfersResult, ignoredResult] = await Promise.all([
      pool.query('SELECT * FROM eth_transfers WHERE wallet_id = $1 ORDER BY block_number, id', [walletId]),
      pool.query('SELECT contract_address FROM eth_ignored_tokens'),
    ]);
    const transfers = transfersResult.rows;
    const ignoredContracts = new Set(ignoredResult.rows.map((row) => row.contract_address));

    const ethPrice = await this._getEthPrice();

    const contracts = [...new Set(
      transfers
        .filter((t) => t.transfer_type === 'token' && t.token_contract && !ignoredContracts.has(t.token_contract))
        .map((t) => t.token_contract)
    )];
    let tokenPrices = {};
    if (contracts.length) {
      try {
        tokenPrices = await PriceService.fetchCoinGeckoJson(
          `https://api.coingecko.com/api/v3/simple/token_price/ethereum?contract_addresses=${encodeURIComponent(contracts.join(','))}&vs_currencies=usd`
        );
      } catch (err) {
        logger.warn({ walletId, err }, 'Token price lookup failed; token rows mirror at $0');
        tokenPrices = {};
      }
    }

    const rows = [];
    for (const transfer of transfers) {
      const body = buildMirrorRow(transfer, wallet.address, { ethPrice, tokenPrices, ignoredContracts });
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

  static async rebuildAll() {
    const wallets = await EthWallet.findAll();
    const results = [];
    for (const wallet of wallets) {
      try {
        results.push({ walletId: wallet.id, ...(await this.rebuildForWallet(wallet.id)) });
      } catch (err) {
        logger.error({ walletId: wallet.id, err }, 'Failed to rebuild ETH transaction mirror');
        results.push({ walletId: wallet.id, error: err.message });
      }
    }
    return results;
  }
}

module.exports = EthTransactionMirrorService;
module.exports.buildMirrorRow = buildMirrorRow;

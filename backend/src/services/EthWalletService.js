'use strict';

const pool = require('../config/database');
const EtherscanService = require('./EtherscanService');
const EthTransactionMirrorService = require('./EthTransactionMirrorService');
const PriceService = require('./PriceService');
const TransactionClassificationService = require('./TransactionClassificationService');
const EthWallet = require('../models/EthWallet');
const EthTransfer = require('../models/EthTransfer');
const logger = require('../config/logger');

const ADDRESS_RE = /^0x[0-9a-f]{40}$/i;

// holdings.quantity is DECIMAL(20,8): 12 integer digits, 8 fractional.
// Scam-token airdrops mint absurd quantities that would overflow the column
// and break the whole sync, so quantities are clamped; the ignore list is the
// real remedy for those tokens.
const MAX_QUANTITY = '999999999999.99999999';

function unitsToDecimalString(value, decimals) {
  const v = BigInt(value);
  if (v <= 0n) return '0';
  const base = 10n ** BigInt(decimals);
  const whole = v / base;
  if (whole.toString().length > 12) return MAX_QUANTITY;
  const frac = (v % base).toString().padStart(Number(decimals), '0').slice(0, 8);
  return frac ? `${whole}.${frac}` : whole.toString();
}

function shortAddress(address) {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

// Sync resumes this many blocks before the stored cursor so a chain reorg
// near the tip is healed by the delete-then-reinsert ingest. Sized past
// Ethereum's finality window (~2 epochs = 64 blocks).
const REORG_OVERLAP_BLOCKS = 64;

// transactions/holdings rebuilds are delete-then-insert, so concurrent runs
// (cron job, manual sync, sync-on-add, ignore-list refresh) would corrupt
// derived data. All such work funnels through this in-process queue.
let derivedQueue = Promise.resolve();

function serialized(fn) {
  const run = derivedQueue.then(fn, fn);
  derivedQueue = run.then(() => undefined, () => undefined);
  return run;
}

function toTimestamp(unixSeconds) {
  return new Date(Number(unixSeconds) * 1000);
}

function maxBlock(rows) {
  let max = null;
  for (const row of rows) {
    const block = Number(row.blockNumber);
    if (max === null || block > max) max = block;
  }
  return max;
}

class EthWalletService {
  // Pure: raw Etherscan feed rows -> eth_transfers rows (without wallet_id).
  // Gas rows are synthesized here, one per normal tx sent by the wallet --
  // including failed txs, which still burn gas. Zero-value normal/internal
  // rows (contract calls, approvals) are dropped as noise; their economic
  // content is the gas row and/or the token row from the token feed.
  static normalizeFeeds(walletAddress, { normal = [], internal = [], token = [] } = {}) {
    const wallet = walletAddress.toLowerCase();
    const rows = [];
    const ordinals = new Map();

    const nextOrdinal = (transferType, txHash) => {
      const key = `${transferType}:${txHash}`;
      const ordinal = ordinals.get(key) || 0;
      ordinals.set(key, ordinal + 1);
      return ordinal;
    };

    const baseRow = (raw, transferType) => ({
      tx_hash: raw.hash,
      ordinal: nextOrdinal(transferType, raw.hash),
      transfer_type: transferType,
      block_number: Number(raw.blockNumber),
      block_time: toTimestamp(raw.timeStamp),
      from_address: (raw.from || '').toLowerCase(),
      to_address: raw.to ? raw.to.toLowerCase() : null,
      value_wei: '0',
      token_contract: null,
      token_symbol: null,
      token_decimals: null,
      is_error: raw.isError === '1',
    });

    for (const raw of normal) {
      if (raw.value !== '0') {
        rows.push({ ...baseRow(raw, 'native'), value_wei: raw.value });
      }
      if ((raw.from || '').toLowerCase() === wallet) {
        const fee = BigInt(raw.gasUsed || 0) * BigInt(raw.gasPrice || 0);
        rows.push({
          ...baseRow(raw, 'gas'),
          value_wei: fee.toString(),
          is_error: false,
        });
      }
    }

    for (const raw of internal) {
      if (raw.value === '0') continue;
      rows.push({ ...baseRow(raw, 'internal'), value_wei: raw.value });
    }

    for (const raw of token) {
      rows.push({
        ...baseRow(raw, 'token'),
        value_wei: raw.value,
        token_contract: (raw.contractAddress || '').toLowerCase() || null,
        token_symbol: raw.tokenSymbol || null,
        token_decimals: raw.tokenDecimal != null ? Number(raw.tokenDecimal) : null,
        is_error: false,
      });
    }

    return rows;
  }

  static syncWallet(walletId) {
    return serialized(() => this._syncWallet(walletId));
  }

  static async _syncWallet(walletId) {
    const wallet = await EthWallet.findById(walletId);
    if (!wallet) throw new Error(`EthWallet ${walletId} not found`);
    EtherscanService.ensureConfigured();

    try {
      const resume = {
        normal: Math.max(0, Number(wallet.last_block_normal) - REORG_OVERLAP_BLOCKS),
        internal: Math.max(0, Number(wallet.last_block_internal) - REORG_OVERLAP_BLOCKS),
        token: Math.max(0, Number(wallet.last_block_token) - REORG_OVERLAP_BLOCKS),
      };

      const normal = await EtherscanService.fetchNormalTxs(wallet.address, resume.normal);
      const internal = await EtherscanService.fetchInternalTxs(wallet.address, resume.internal);
      const token = await EtherscanService.fetchTokenTxs(wallet.address, resume.token);

      const rows = this.normalizeFeeds(wallet.address, { normal, internal, token })
        .map((row) => ({ ...row, wallet_id: walletId }));

      // Gas rows derive from the normal feed, so they share its resume block.
      await EthTransfer.deleteFromBlock(walletId, ['native', 'gas'], resume.normal);
      await EthTransfer.deleteFromBlock(walletId, ['internal'], resume.internal);
      await EthTransfer.deleteFromBlock(walletId, ['token'], resume.token);
      const inserted = await EthTransfer.bulkInsert(rows);

      await EthWallet.updateCursors(walletId, {
        normal: maxBlock(normal),
        internal: maxBlock(internal),
        token: maxBlock(token),
      });
      await EthTransfer.reclassifyOwnCounterparties();
      const holdings = await this.refreshHoldings(walletId);
      const mirror = await EthTransactionMirrorService.rebuildForWallet(walletId);
      await TransactionClassificationService.backfill();
      await EthWallet.clearError(walletId);
      await EthWallet.updateSyncTime(walletId);

      const results = {
        inserted,
        holdings,
        mirror,
        fetched: { normal: normal.length, internal: internal.length, token: token.length },
      };
      logger.info({ walletId, address: wallet.address, results }, 'ETH wallet sync completed');
      return results;
    } catch (err) {
      await EthWallet.setError(walletId, err.code || 'SYNC_ERROR', err.message);
      throw err;
    }
  }

  static async syncAllWallets() {
    const wallets = await EthWallet.findAll();
    const summary = { processed: 0, succeeded: 0, failed: 0, results: [] };

    for (const wallet of wallets) {
      summary.processed++;
      try {
        const result = await this.syncWallet(wallet.id);
        summary.succeeded++;
        summary.results.push({ walletId: wallet.id, address: wallet.address, ...result });
      } catch (err) {
        summary.failed++;
        summary.results.push({ walletId: wallet.id, address: wallet.address, error: err.message });
        logger.error({ walletId: wallet.id, err }, 'Failed to sync ETH wallet');
      }
    }

    return summary;
  }

  static async addWallet(address, label) {
    if (typeof address !== 'string' || !ADDRESS_RE.test(address.trim())) {
      const error = new Error('address must be a 0x-prefixed 40-hex-character Ethereum address');
      error.code = 'INVALID_ADDRESS';
      throw error;
    }
    // Fail fast: without an API key the wallet could be created but never
    // synced, which would just strand an empty account.
    EtherscanService.ensureConfigured();
    const normalized = address.trim().toLowerCase();

    const existing = await EthWallet.findByAddress(normalized);
    if (existing) {
      const error = new Error('That address is already tracked');
      error.code = 'DUPLICATE_WALLET';
      throw error;
    }

    // Wallet and account are created atomically: a wallet without its account
    // would make every holdings/mirror refresh silently skip it. The account's
    // stable name is derived from the address (unique by construction); the
    // user-facing label rides on display_name like every other renamed account.
    const client = await pool.connect();
    let wallet;
    let account;
    try {
      await client.query('BEGIN');
      const walletResult = await client.query(
        'INSERT INTO eth_wallets (address, label) VALUES ($1, $2) RETURNING *',
        [normalized, label?.trim() || null]
      );
      wallet = walletResult.rows[0];
      const accountResult = await client.query(
        `INSERT INTO accounts (name, type, display_name, eth_wallet_id)
         VALUES ($1, 'crypto', $2, $3)
         RETURNING *`,
        [`Ethereum ${shortAddress(normalized)}`, label?.trim() || null, wallet.id]
      );
      account = accountResult.rows[0];
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }

    // A new own-address can turn previously-external transfers into
    // self-transfers on other wallets, so their mirrored ledger rows must be
    // rebuilt too. Non-fatal: the wallet exists either way, and the first
    // sync re-derives all of this.
    try {
      await serialized(async () => {
        await EthTransfer.reclassifyOwnCounterparties();
        await EthTransactionMirrorService.rebuildAll();
        await TransactionClassificationService.backfill();
      });
    } catch (err) {
      logger.warn({ walletId: wallet.id, err }, 'Derived-data refresh after wallet add failed');
    }

    logger.info({ walletId: wallet.id, address: normalized }, 'ETH wallet added');
    return { wallet, account };
  }

  // Rebuilds the wallet account's holdings: an ETH position priced later by
  // the regular price job (ticker ETH -> price_cache), plus one row per
  // non-ignored token. Token symbols never become tickers -- a scam token
  // named "AAPL" must not inherit Apple's stock price -- so tokens are
  // NULL-ticker holdings valued via manual_value at sync time.
  static async refreshHoldings(walletId) {
    const wallet = await EthWallet.findById(walletId);
    if (!wallet) throw new Error(`EthWallet ${walletId} not found`);
    const account = await EthWallet.getAccountForWallet(walletId);
    if (!account) return { skipped: true };

    const wei = await EtherscanService.getEthBalance(wallet.address);
    const desired = [{
      ticker: 'ETH',
      name: 'Ethereum',
      quantity: unitsToDecimalString(wei, 18),
      manual_value: null,
    }];

    const deltas = await EthTransfer.tokenBalanceDeltas(walletId);
    const held = deltas.filter((d) => BigInt(d.balance_units) > 0n);

    let prices = {};
    if (held.length) {
      try {
        const contracts = held.map((d) => d.token_contract).join(',');
        prices = await PriceService.fetchCoinGeckoJson(
          `https://api.coingecko.com/api/v3/simple/token_price/ethereum?contract_addresses=${encodeURIComponent(contracts)}&vs_currencies=usd`
        );
      } catch (err) {
        logger.warn({ walletId, err }, 'Token price lookup failed; token holdings stay unvalued');
        prices = {};
      }
    }

    for (const delta of held) {
      const decimals = delta.token_decimals != null ? Number(delta.token_decimals) : 18;
      const quantity = unitsToDecimalString(delta.balance_units, decimals);
      const usd = Number(prices[delta.token_contract]?.usd);
      // Clamped like the mirror's toAmount: manual_value is DECIMAL(15,2) and
      // one absurd scam-token valuation must not abort the whole sync.
      const manualValue = Number.isFinite(usd)
        ? Math.min(Math.round(usd * Number(quantity) * 100) / 100, 9999999999999.99)
        : null;
      desired.push({
        ticker: null,
        name: `${delta.token_symbol || 'TOKEN'} ${shortAddress(delta.token_contract)}`,
        quantity,
        manual_value: manualValue,
      });
    }

    for (const holding of desired) {
      const matchClause = holding.ticker
        ? 'account_id = $1 AND UPPER(ticker) = UPPER($2)'
        : 'account_id = $1 AND ticker IS NULL AND name = $2';
      const matchParams = holding.ticker ? [account.id, holding.ticker] : [account.id, holding.name];
      const existing = await pool.query(`SELECT id FROM holdings WHERE ${matchClause}`, matchParams);
      if (existing.rows.length > 0) {
        await pool.query(
          `UPDATE holdings SET name = $1, quantity = $2, manual_value = $3, updated_at = CURRENT_TIMESTAMP
           WHERE id = $4`,
          [holding.name, holding.quantity, holding.manual_value, existing.rows[0].id]
        );
      } else {
        await pool.query(
          `INSERT INTO holdings (account_id, ticker, name, quantity, manual_value)
           VALUES ($1, $2, $3, $4, $5)`,
          [account.id, holding.ticker, holding.name, holding.quantity, holding.manual_value]
        );
      }
    }

    // The account exists solely for this wallet, so anything the sync did not
    // produce (sold-out positions, newly-ignored tokens) is stale.
    const identifiers = desired.map((h) => (h.ticker || h.name).toUpperCase());
    const placeholders = identifiers.map((_, i) => `$${i + 2}`).join(', ');
    await pool.query(
      `DELETE FROM holdings
       WHERE account_id = $1
       AND COALESCE(UPPER(ticker), UPPER(name)) NOT IN (${placeholders})`,
      [account.id, ...identifiers]
    );

    return { eth: desired[0].quantity, tokens: held.length };
  }

  static async removeWallet(walletId, { removeData = false } = {}) {
    const wallet = await EthWallet.findById(walletId);
    if (!wallet) throw new Error(`EthWallet ${walletId} not found`);

    await EthWallet.delete(walletId, { removeData });

    // Non-fatal: the wallet is already gone; a failure here must not report
    // the disconnect itself as failed.
    try {
      await serialized(async () => {
        await EthTransfer.reclassifyOwnCounterparties();
        await EthTransactionMirrorService.rebuildAll();
        await TransactionClassificationService.backfill();
      });
    } catch (err) {
      logger.warn({ walletId, err }, 'Derived-data refresh after wallet removal failed');
    }
    logger.info({ walletId, removeData }, 'ETH wallet disconnected');
  }

  // Ignore-list changes affect holdings and mirrored ledger rows for every
  // wallet; re-derive both without hitting Etherscan feeds again.
  static refreshAllDerived() {
    return serialized(async () => {
      const wallets = await EthWallet.findAll();
      for (const wallet of wallets) {
        try {
          await this.refreshHoldings(wallet.id);
          await EthTransactionMirrorService.rebuildForWallet(wallet.id);
        } catch (err) {
          logger.warn({ walletId: wallet.id, err }, 'Derived-data refresh failed');
        }
      }
      await TransactionClassificationService.backfill();
    });
  }
}

module.exports = EthWalletService;
module.exports.REORG_OVERLAP_BLOCKS = REORG_OVERLAP_BLOCKS;

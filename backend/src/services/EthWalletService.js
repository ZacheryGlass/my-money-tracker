'use strict';

const pool = require('../config/database');
const EtherscanService = require('./EtherscanService');
const SecretsService = require('./SecretsService');
const EthTransactionMirrorService = require('./EthTransactionMirrorService');
const PriceService = require('./PriceService');
const TransactionClassificationService = require('./TransactionClassificationService');
const EthWallet = require('../models/EthWallet');
const EthTransfer = require('../models/EthTransfer');
const logger = require('../config/logger');
const { shortAddress } = require('../utils/ethAddress');

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
  static normalizeFeeds(walletAddress, { normal = [], internal = [], token = [], nft = [], nft1155 = [] } = {}) {
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
      token_standard: null,
      token_id: null,
      is_error: raw.isError === '1',
    });

    // Shared by both NFT feeds. Neither reports isError -- an NFT log only
    // exists if the transfer succeeded. from = 0x0 (mint) and to = 0x0 (burn)
    // are deliberately preserved as-is: they are real, meaningful endpoints,
    // and the activity layer needs them to tell a mint from a purchase.
    const nftRow = (raw, transferType, tokenStandard, valueUnits) => ({
      ...baseRow(raw, transferType),
      // Units, not wei. See 033_nft_transfers.sql.
      value_wei: valueUnits,
      token_contract: (raw.contractAddress || '').toLowerCase() || null,
      token_symbol: raw.tokenSymbol || null,
      // Whole units. NULL would default to 18 in the shared unit helpers.
      token_decimals: 0,
      token_standard: tokenStandard,
      // uint256, past Number precision -- keep it a string end to end.
      token_id: raw.tokenID != null ? String(raw.tokenID) : null,
      is_error: false,
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
        // tokentx is ERC-20 only; the NFT standards have their own feeds.
        token_standard: 'erc20',
        is_error: false,
      });
    }

    // An ERC-721 is indivisible and tokennfttx carries no value field, so
    // every row is exactly one unit.
    for (const raw of nft) {
      rows.push(nftRow(raw, 'nft', 'erc721', '1'));
    }

    // tokenValue is how many copies of that id moved. Etherscan already emits
    // one row per id for a batch transfer, so a batch arrives pre-unbundled and
    // each row gets its own ordinal for free.
    for (const raw of nft1155) {
      rows.push(nftRow(raw, 'nft1155', 'erc1155', raw.tokenValue != null ? String(raw.tokenValue) : '1'));
    }

    return rows;
  }

  static syncWallet(walletId) {
    return serialized(() => this._syncWallet(walletId));
  }

  static async _syncWallet(walletId) {
    const wallet = await EthWallet.findById(walletId);
    if (!wallet) throw new Error(`EthWallet ${walletId} not found`);
    // Credentials belong to the wallet's owner (the nightly job has no
    // request context). Missing key -> ETHERSCAN_NOT_CONFIGURED.
    const apiKey = await SecretsService.getUserKey(wallet.user_id, 'etherscan');
    if (!apiKey) {
      const error = new Error('Etherscan is not configured. Add your Etherscan key under Settings -> API Keys.');
      error.code = 'ETHERSCAN_NOT_CONFIGURED';
      throw error;
    }

    try {
      const resume = {
        normal: Math.max(0, Number(wallet.last_block_normal) - REORG_OVERLAP_BLOCKS),
        internal: Math.max(0, Number(wallet.last_block_internal) - REORG_OVERLAP_BLOCKS),
        token: Math.max(0, Number(wallet.last_block_token) - REORG_OVERLAP_BLOCKS),
        nft: Math.max(0, Number(wallet.last_block_nft) - REORG_OVERLAP_BLOCKS),
        nft1155: Math.max(0, Number(wallet.last_block_1155) - REORG_OVERLAP_BLOCKS),
      };

      const normal = await EtherscanService.fetchNormalTxs(wallet.address, resume.normal, apiKey);
      const internal = await EtherscanService.fetchInternalTxs(wallet.address, resume.internal, apiKey);
      const token = await EtherscanService.fetchTokenTxs(wallet.address, resume.token, apiKey);
      const nft = await EtherscanService.fetchNftTxs(wallet.address, resume.nft, apiKey);
      const nft1155 = await EtherscanService.fetch1155Txs(wallet.address, resume.nft1155, apiKey);

      const rows = this.normalizeFeeds(wallet.address, { normal, internal, token, nft, nft1155 })
        .map((row) => ({ ...row, wallet_id: walletId }));

      // Gas rows derive from the normal feed, so they share its resume block.
      await EthTransfer.deleteFromBlock(walletId, ['native', 'gas'], resume.normal);
      await EthTransfer.deleteFromBlock(walletId, ['internal'], resume.internal);
      await EthTransfer.deleteFromBlock(walletId, ['token'], resume.token);
      await EthTransfer.deleteFromBlock(walletId, ['nft'], resume.nft);
      await EthTransfer.deleteFromBlock(walletId, ['nft1155'], resume.nft1155);
      const inserted = await EthTransfer.bulkInsert(rows);

      await EthWallet.updateCursors(walletId, {
        normal: maxBlock(normal),
        internal: maxBlock(internal),
        token: maxBlock(token),
        nft: maxBlock(nft),
        nft1155: maxBlock(nft1155),
      });
      await EthTransfer.reclassifyCounterparties(wallet.user_id);
      const holdings = await this.refreshHoldings(walletId);
      const mirror = await EthTransactionMirrorService.rebuildForWallet(walletId);
      await TransactionClassificationService.backfill();
      await EthWallet.clearError(walletId);
      await EthWallet.updateSyncTime(walletId);

      const results = {
        inserted,
        holdings,
        mirror,
        fetched: {
          normal: normal.length,
          internal: internal.length,
          token: token.length,
          nft: nft.length,
          nft1155: nft1155.length,
        },
      };
      logger.info({ walletId, address: wallet.address, results }, 'ETH wallet sync completed');
      return results;
    } catch (err) {
      await EthWallet.setError(walletId, err.code || 'SYNC_ERROR', err.message);
      throw err;
    }
  }

  static async syncAllWallets() {
    const wallets = await EthWallet.findAllForJobs();
    const summary = { processed: 0, succeeded: 0, failed: 0, results: [] };

    for (const wallet of wallets) {
      summary.processed++;
      try {
        const result = await this.syncWallet(wallet.id);
        summary.succeeded++;
        summary.results.push({ walletId: wallet.id, address: wallet.address, ...result });
      } catch (err) {
        if (err.code === 'ETHERSCAN_NOT_CONFIGURED') {
          summary.skipped = (summary.skipped || 0) + 1;
          summary.results.push({ walletId: wallet.id, address: wallet.address, skipped: 'not_configured' });
          logger.warn({ walletId: wallet.id, userId: wallet.user_id }, 'Skipping ETH wallet: owner has no Etherscan key');
          continue;
        }
        summary.failed++;
        summary.results.push({ walletId: wallet.id, address: wallet.address, error: err.message });
        logger.error({ walletId: wallet.id, err }, 'Failed to sync ETH wallet');
      }
    }

    return summary;
  }

  static async addWallet(userId, address, label) {
    if (typeof address !== 'string' || !ADDRESS_RE.test(address.trim())) {
      const error = new Error('address must be a 0x-prefixed 40-hex-character Ethereum address');
      error.code = 'INVALID_ADDRESS';
      throw error;
    }
    // Fail fast: without an API key the wallet could be created but never
    // synced, which would just strand an empty account.
    const apiKey = await SecretsService.getUserKey(userId, 'etherscan');
    if (!apiKey) {
      const error = new Error('Etherscan is not configured. Add your Etherscan key under Settings -> API Keys.');
      error.code = 'ETHERSCAN_NOT_CONFIGURED';
      throw error;
    }
    const normalized = address.trim().toLowerCase();

    const existing = await EthWallet.findByAddress(normalized, userId);
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
    const accountName = `Ethereum ${shortAddress(normalized)}`;
    const trimmedLabel = label?.trim() || null;
    let wallet;
    let account;
    try {
      await client.query('BEGIN');
      const walletResult = await client.query(
        'INSERT INTO eth_wallets (address, label, user_id) VALUES ($1, $2, $3) RETURNING *',
        [normalized, trimmedLabel, userId]
      );
      wallet = walletResult.rows[0];

      // Disconnecting a wallet with removeData=false detaches its account
      // (eth_wallet_id -> NULL) but keeps the row, name included. Re-adding the
      // same address must re-attach that account rather than insert a second
      // one: the name is unique per user, so inserting would violate
      // accounts_user_id_name_key, and re-attaching is what "keep data" was for
      // -- the account's snapshots, history, and display_name all survive.
      // Matching on name is exactly as precise as the constraint being avoided.
      const reattached = await client.query(
        `UPDATE accounts
            SET eth_wallet_id = $1,
                display_name = COALESCE($2, display_name),
                type = 'crypto',
                -- Un-hide deliberately. Hiding the leftover account is the
                -- natural response to a disconnect, and adopting it while
                -- hidden would exclude the wallet from net worth, holdings,
                -- history and exports -- every consumer filters
                -- is_hidden = FALSE -- with no error anywhere. Re-adding an
                -- address is an explicit "track this again"; a reappearing row
                -- is trivially re-hidden, a silently missing balance is not.
                is_hidden = FALSE
          WHERE user_id = $3 AND name = $4 AND eth_wallet_id IS NULL
          RETURNING *`,
        [wallet.id, trimmedLabel, userId, accountName]
      );
      if (reattached.rows.length) {
        account = reattached.rows[0];
      } else {
        const accountResult = await client.query(
          `INSERT INTO accounts (name, type, display_name, eth_wallet_id, user_id)
           VALUES ($1, 'crypto', $2, $3, $4)
           RETURNING *`,
          [accountName, trimmedLabel, wallet.id, userId]
        );
        account = accountResult.rows[0];
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      // Branch on the constraint, not just the code: the transaction's FIRST
      // statement inserts into eth_wallets, and the duplicate-address
      // pre-check above runs outside the transaction, so a double-submit or an
      // interceptor retry can race it. Reporting that as a name conflict would
      // send the user chasing an account rename for what is really "you
      // already track this address".
      if (err.code === '23505' && err.constraint === 'eth_wallets_user_id_address_key') {
        const duplicate = new Error('That address is already tracked');
        duplicate.code = 'DUPLICATE_WALLET';
        throw duplicate;
      }
      if (err.code === '23505') {
        // A live account already holds this name -- two distinct addresses
        // sharing a 6-and-4 abbreviation. Vanishingly rare, and there is no
        // API that renames an account, so the message must not tell the user
        // to go rename one; only display_name is editable.
        const conflict = new Error(`Another account is already named "${accountName}", so this address can't be added automatically.`);
        conflict.code = 'ACCOUNT_NAME_CONFLICT';
        throw conflict;
      }
      throw err;
    } finally {
      client.release();
    }

    // A new own-address can turn previously-external transfers into
    // self-transfers on other wallets, so their mirrored ledger rows must be
    // rebuilt too. Non-fatal: the wallet exists either way, and the first
    // sync re-derives all of this.
    try {
      await this.refreshClassificationsForUser(userId);
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

    const apiKey = await SecretsService.getUserKey(wallet.user_id, 'etherscan');
    if (!apiKey) {
      const error = new Error('Etherscan is not configured. Add your Etherscan key under Settings -> API Keys.');
      error.code = 'ETHERSCAN_NOT_CONFIGURED';
      throw error;
    }
    const wei = await EtherscanService.getEthBalance(wallet.address, apiKey);
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
      await this.refreshClassificationsForUser(wallet.user_id);
    } catch (err) {
      logger.warn({ walletId, err }, 'Derived-data refresh after wallet removal failed');
    }
    logger.info({ walletId, removeData }, 'ETH wallet disconnected');
  }

  // Classification changes (wallet add/remove, address-label change) flip
  // self/exchange/external on existing rows and their mirrored ledger rows.
  // Unlike refreshDerivedForUser this never touches Etherscan or holdings --
  // labels affect classification only.
  //
  // Scoped to the owner: wallets and labels only ever classify against their
  // own user's addresses, so rebuilding every user's rows was wasted work on an
  // edit they never made. The final backfill stays global -- it is an
  // account-keyed derivation over transactions, not an eth-wallet read.
  static refreshClassificationsForUser(userId) {
    return serialized(async () => {
      await EthTransfer.reclassifyCounterparties(userId);
      const wallets = await EthWallet.findAllByUser(userId);
      for (const wallet of wallets) {
        try {
          await EthTransactionMirrorService.rebuildForWallet(wallet.id);
        } catch (err) {
          logger.warn({ walletId: wallet.id, err }, 'Mirror rebuild failed during classification refresh');
        }
      }
      await TransactionClassificationService.backfill();
    });
  }

  // Ignore lists are per-user, so this re-derives only the owner's wallets.
  // Fanning out over every wallet would spend other owners' Etherscan and
  // CoinGecko quota (refreshHoldings resolves the wallet owner's key) and
  // rewrite their holdings rows on an edit they never made.
  static refreshDerivedForUser(userId) {
    return serialized(async () => {
      const wallets = await EthWallet.findAllByUser(userId);
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

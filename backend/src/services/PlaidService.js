'use strict';

const plaidClient = require('../config/plaid');
const { Products, CountryCode } = require('plaid');
const pool = require('../config/database');
const PlaidItem = require('../models/PlaidItem');
const PriceCache = require('../models/PriceCache');
const logger = require('../config/logger');

const ensurePlaidConfigured = () => {
  if (!process.env.PLAID_CLIENT_ID || !process.env.PLAID_SECRET) {
    const error = new Error(
      'Plaid is not configured. Add PLAID_CLIENT_ID and PLAID_SECRET to backend/.env, then restart the backend.'
    );
    error.code = 'PLAID_NOT_CONFIGURED';
    throw error;
  }
};

class PlaidService {
  static async createLinkToken(userId) {
    ensurePlaidConfigured();
    const request = {
      user: { client_user_id: String(userId) },
      client_name: 'My Money Tracker',
      products: [Products.Transactions],
      optional_products: [Products.Investments, Products.Liabilities],
      country_codes: [CountryCode.Us],
      language: 'en',
    };
    const response = await plaidClient.linkTokenCreate(request);
    return response.data.link_token;
  }

  static async createUpdateLinkToken(userId, plaidItemId) {
    ensurePlaidConfigured();
    const item = await PlaidItem.findById(plaidItemId);
    if (!item) throw new Error(`PlaidItem ${plaidItemId} not found`);
    const request = {
      user: { client_user_id: String(userId) },
      client_name: 'My Money Tracker',
      access_token: item.access_token,
      country_codes: [CountryCode.Us],
      language: 'en',
    };
    const response = await plaidClient.linkTokenCreate(request);
    return response.data.link_token;
  }

  static async exchangePublicToken(publicToken) {
    const exchangeResponse = await plaidClient.itemPublicTokenExchange({
      public_token: publicToken,
    });
    const { access_token, item_id } = exchangeResponse.data;

    let institutionId = null;
    let institutionName = null;
    try {
      const itemResponse = await plaidClient.itemGet({ access_token });
      institutionId = itemResponse.data.item.institution_id;
      if (institutionId) {
        const instResponse = await plaidClient.institutionsGetById({
          institution_id: institutionId,
          country_codes: [CountryCode.Us],
        });
        institutionName = instResponse.data.institution.name;
      }
    } catch (err) {
      logger.warn({ err }, 'Failed to fetch institution info');
    }

    const plaidItem = await PlaidItem.create(item_id, access_token, institutionId, institutionName);
    return plaidItem;
  }

  static async syncItem(plaidItemId) {
    const item = await PlaidItem.findById(plaidItemId);
    if (!item) throw new Error(`PlaidItem ${plaidItemId} not found`);

    const { access_token, institution_name } = item;
    const prefix = institution_name || 'Linked';

    let accountsResponse;
    try {
      accountsResponse = await plaidClient.accountsGet({ access_token });
    } catch (err) {
      await this._handlePlaidError(plaidItemId, err);
      throw err;
    }

    await PlaidItem.clearError(plaidItemId);
    const plaidAccounts = accountsResponse.data.accounts;
    const syncedAccountIds = [];
    const results = { accounts: 0, holdings: 0, balances: 0, removed: 0 };

    for (const pa of plaidAccounts) {
      const accountName = `${prefix} - ${pa.official_name || pa.name}`;
      const dbAccount = await this._upsertAccount(accountName, plaidItemId, pa.account_id, pa.type);
      syncedAccountIds.push(dbAccount.id);
      results.accounts++;
    }

    const investmentAccountIds = plaidAccounts
      .filter(pa => pa.type === 'investment')
      .map(pa => pa.account_id);

    if (investmentAccountIds.length > 0) {
      try {
        const holdingsResponse = await plaidClient.investmentsHoldingsGet({ access_token });
        const { holdings, securities } = holdingsResponse.data;
        const securityMap = new Map(securities.map(s => [s.security_id, s]));

        for (const holding of holdings) {
          const security = securityMap.get(holding.security_id);
          if (!security) continue;

          const accountId = await this._getAccountIdByPlaidAccountId(holding.account_id);
          if (!accountId) continue;

          const ticker = security.ticker_symbol || null;
          const name = security.name || 'Unknown Security';
          const quantity = holding.quantity;
          const manualValue = holding.institution_value ?? null;

          await this._upsertHolding(accountId, ticker, name, quantity, manualValue);

          if (ticker && security.close_price != null) {
            await PriceCache.upsert(ticker, security.close_price, 'plaid');
          }
          results.holdings++;
        }

        for (const plaidAccountId of investmentAccountIds) {
          const accountId = await this._getAccountIdByPlaidAccountId(plaidAccountId);
          if (!accountId) continue;

          const plaidTickers = holdings
            .filter(h => h.account_id === plaidAccountId)
            .map(h => {
              const sec = securityMap.get(h.security_id);
              return sec ? (sec.ticker_symbol || sec.name) : null;
            })
            .filter(Boolean);

          const removed = await this._removeStaleHoldings(accountId, plaidTickers);
          results.removed += removed;
        }
      } catch (err) {
        const errorCode = err.response?.data?.error_code;
        if (errorCode === 'PRODUCTS_NOT_SUPPORTED') {
          logger.info({ plaidItemId }, 'Institution does not support investments product');
        } else if (errorCode === 'ADDITIONAL_CONSENT_REQUIRED') {
          logger.info({ plaidItemId }, 'Additional consent required for investments — user must re-link');
          await PlaidItem.setError(plaidItemId, 'ADDITIONAL_CONSENT_REQUIRED', 'Additional consent required for investment data. Please re-link this account.');
          results.consentRequired = true;
        } else {
          logger.error({ plaidItemId, err }, 'Failed to sync investment holdings');
        }
      }
    }

    const nonInvestmentAccounts = plaidAccounts.filter(pa => pa.type !== 'investment');
    for (const pa of nonInvestmentAccounts) {
      const accountId = await this._getAccountIdByPlaidAccountId(pa.account_id);
      if (!accountId) continue;

      const balance = pa.balances.current;
      if (balance == null) continue;

      const holdingName = `${pa.official_name || pa.name} Balance`;
      const value = pa.type === 'credit' ? -Math.abs(balance) : balance;

      await this._upsertHolding(accountId, null, holdingName, null, value);
      results.balances++;
    }

    try {
      const txnResult = await this._syncTransactions(plaidItemId, access_token);
      results.transactions = txnResult;
    } catch (err) {
      const errorCode = err.response?.data?.error_code;
      if (errorCode === 'PRODUCTS_NOT_SUPPORTED') {
        logger.info({ plaidItemId }, 'Institution does not support transactions product');
      } else {
        logger.error({ plaidItemId, err }, 'Failed to sync transactions');
      }
    }

    if (investmentAccountIds.length > 0) {
      try {
        const invTxnResult = await this._syncInvestmentTransactions(plaidItemId, access_token);
        results.investmentTransactions = invTxnResult;
      } catch (err) {
        const errorCode = err.response?.data?.error_code;
        if (errorCode === 'PRODUCTS_NOT_SUPPORTED') {
          logger.info({ plaidItemId }, 'Institution does not support investment transactions');
        } else {
          logger.error({ plaidItemId, err }, 'Failed to sync investment transactions');
        }
      }
    }

    await PlaidItem.updateSyncTime(plaidItemId);
    logger.info({ plaidItemId, results }, 'Plaid sync completed');
    return results;
  }

  static async syncAllItems() {
    const items = await PlaidItem.findAll();
    const summary = { processed: 0, succeeded: 0, failed: 0, results: [] };

    for (const item of items) {
      summary.processed++;
      try {
        const result = await this.syncItem(item.id);
        summary.succeeded++;
        summary.results.push({ itemId: item.id, institution: item.institution_name, ...result });
      } catch (err) {
        summary.failed++;
        summary.results.push({ itemId: item.id, institution: item.institution_name, error: err.message });
        logger.error({ itemId: item.id, err }, 'Failed to sync Plaid item');
      }
    }

    return summary;
  }

  static async removeItem(plaidItemId, { removeData = false } = {}) {
    const item = await PlaidItem.findById(plaidItemId);
    if (!item) throw new Error(`PlaidItem ${plaidItemId} not found`);

    try {
      await plaidClient.itemRemove({ access_token: item.access_token });
    } catch (err) {
      logger.warn({ plaidItemId, err }, 'Failed to revoke access token at Plaid');
    }

    await PlaidItem.delete(plaidItemId, { removeData });
    logger.info({ plaidItemId, removeData }, 'Plaid item disconnected');
  }

  static _mapPlaidType(accountType) {
    const TYPE_MAP = {
      investment: 'investment',
      brokerage: 'investment',
      depository: 'depository',
      credit: 'credit',
      loan: 'loan',
      other: 'other',
    };
    return TYPE_MAP[accountType] || 'other';
  }

  static async _upsertAccount(name, plaidItemId, plaidAccountId, accountType) {
    const dbType = this._mapPlaidType(accountType);

    const existing = await pool.query(
      'SELECT * FROM accounts WHERE plaid_account_id = $1',
      [plaidAccountId]
    );

    if (existing.rows.length > 0) {
      const result = await pool.query(
        'UPDATE accounts SET plaid_item_id = $1, type = $2 WHERE plaid_account_id = $3 RETURNING *',
        [plaidItemId, dbType, plaidAccountId]
      );
      return result.rows[0];
    }

    const reclaimable = await pool.query(
      'SELECT * FROM accounts WHERE name = $1 AND plaid_account_id IS NULL',
      [name]
    );
    if (reclaimable.rows.length > 0) {
      const result = await pool.query(
        'UPDATE accounts SET plaid_item_id = $1, plaid_account_id = $2, type = $3 WHERE id = $4 RETURNING *',
        [plaidItemId, plaidAccountId, dbType, reclaimable.rows[0].id]
      );
      return result.rows[0];
    }

    const nameConflict = await pool.query(
      'SELECT id FROM accounts WHERE name = $1',
      [name]
    );
    const finalName = nameConflict.rows.length > 0 ? `${name} (Plaid)` : name;

    const result = await pool.query(
      'INSERT INTO accounts (name, type, plaid_item_id, plaid_account_id) VALUES ($1, $2, $3, $4) RETURNING *',
      [finalName, dbType, plaidItemId, plaidAccountId]
    );
    return result.rows[0];
  }

  static async _getAccountIdByPlaidAccountId(plaidAccountId) {
    const result = await pool.query(
      'SELECT id FROM accounts WHERE plaid_account_id = $1',
      [plaidAccountId]
    );
    return result.rows[0]?.id || null;
  }

  static async _upsertHolding(accountId, ticker, name, quantity, manualValue) {
    const matchClause = ticker
      ? 'account_id = $1 AND UPPER(ticker) = UPPER($2)'
      : 'account_id = $1 AND ticker IS NULL AND name = $2';
    const matchParams = ticker ? [accountId, ticker] : [accountId, name];

    const existing = await pool.query(
      `SELECT id FROM holdings WHERE ${matchClause}`,
      matchParams
    );

    if (existing.rows.length > 0) {
      await pool.query(
        `UPDATE holdings SET name = $1, quantity = $2, manual_value = $3,
         is_plaid_managed = TRUE, updated_at = CURRENT_TIMESTAMP
         WHERE id = $4`,
        [name, quantity, manualValue, existing.rows[0].id]
      );
    } else {
      await pool.query(
        `INSERT INTO holdings (account_id, ticker, name, quantity, manual_value, is_plaid_managed)
         VALUES ($1, $2, $3, $4, $5, TRUE)`,
        [accountId, ticker, name, quantity, manualValue]
      );
    }
  }

  static async _removeStaleHoldings(accountId, currentIdentifiers) {
    if (currentIdentifiers.length === 0) {
      const result = await pool.query(
        'DELETE FROM holdings WHERE account_id = $1 AND is_plaid_managed = TRUE',
        [accountId]
      );
      return result.rowCount;
    }

    const placeholders = currentIdentifiers.map((_, i) => `$${i + 2}`).join(', ');
    const result = await pool.query(
      `DELETE FROM holdings
       WHERE account_id = $1 AND is_plaid_managed = TRUE
       AND COALESCE(UPPER(ticker), UPPER(name)) NOT IN (${placeholders})`,
      [accountId, ...currentIdentifiers.map(id => id.toUpperCase())]
    );
    return result.rowCount;
  }

  static async _syncTransactions(plaidItemId, accessToken) {
    const cursorResult = await pool.query(
      'SELECT transactions_cursor FROM plaid_items WHERE id = $1',
      [plaidItemId]
    );
    let cursor = cursorResult.rows[0]?.transactions_cursor || '';
    let added = 0;
    let modified = 0;
    let removed = 0;
    let hasMore = true;

    while (hasMore) {
      const response = await plaidClient.transactionsSync({
        access_token: accessToken,
        cursor: cursor || undefined,
        count: 500,
      });
      const data = response.data;

      for (const txn of data.added) {
        const accountId = await this._getAccountIdByPlaidAccountId(txn.account_id);
        if (!accountId) continue;
        await this._upsertTransaction(accountId, txn);
        added++;
      }

      for (const txn of data.modified) {
        const accountId = await this._getAccountIdByPlaidAccountId(txn.account_id);
        if (!accountId) continue;
        await this._upsertTransaction(accountId, txn);
        modified++;
      }

      for (const txn of data.removed) {
        await pool.query(
          'DELETE FROM transactions WHERE plaid_transaction_id = $1',
          [txn.transaction_id]
        );
        removed++;
      }

      cursor = data.next_cursor;
      hasMore = data.has_more;

      await pool.query(
        'UPDATE plaid_items SET transactions_cursor = $1 WHERE id = $2',
        [cursor, plaidItemId]
      );
    }

    return { added, modified, removed };
  }

  static async _syncInvestmentTransactions(plaidItemId, accessToken) {
    const endDate = new Date().toISOString().split('T')[0];
    const startDate = '2000-01-01';
    let added = 0;
    let offset = 0;
    const count = 500;
    let total = Infinity;

    while (offset < total) {
      const response = await plaidClient.investmentsTransactionsGet({
        access_token: accessToken,
        start_date: startDate,
        end_date: endDate,
        options: { count, offset },
      });
      const data = response.data;
      total = data.total_investment_transactions;
      const securities = new Map(data.securities.map(s => [s.security_id, s]));

      for (const txn of data.investment_transactions) {
        const accountId = await this._getAccountIdByPlaidAccountId(txn.account_id);
        if (!accountId) continue;

        const security = txn.security_id ? securities.get(txn.security_id) : null;
        const ticker = security?.ticker_symbol || null;
        const description = ticker ? `${txn.name} (${ticker})` : txn.name;
        const category = txn.subtype || txn.type || null;

        await this._upsertInvestmentTransaction(accountId, txn, description, category);
        added++;
      }

      if (data.investment_transactions.length === 0) break;
      offset += data.investment_transactions.length;
    }

    return { added };
  }

  static async _upsertInvestmentTransaction(accountId, txn, description, category) {
    const existing = await pool.query(
      'SELECT id FROM transactions WHERE plaid_transaction_id = $1',
      [txn.investment_transaction_id]
    );

    if (existing.rows.length > 0) {
      await pool.query(
        `UPDATE transactions SET account_id = $1, date = $2, name = $3,
         amount = $4, currency_code = $5, category = $6, pending = FALSE
         WHERE plaid_transaction_id = $7`,
        [accountId, txn.date, description,
         txn.amount, txn.iso_currency_code || 'USD', category,
         txn.investment_transaction_id]
      );
    } else {
      await pool.query(
        `INSERT INTO transactions (account_id, plaid_transaction_id, date, name,
         amount, currency_code, category, pending)
         VALUES ($1, $2, $3, $4, $5, $6, $7, FALSE)`,
        [accountId, txn.investment_transaction_id, txn.date, description,
         txn.amount, txn.iso_currency_code || 'USD', category]
      );
    }
  }

  static async _upsertTransaction(accountId, txn) {
    const category = txn.personal_finance_category?.primary || null;
    const existing = await pool.query(
      'SELECT id FROM transactions WHERE plaid_transaction_id = $1',
      [txn.transaction_id]
    );

    if (existing.rows.length > 0) {
      await pool.query(
        `UPDATE transactions SET account_id = $1, date = $2, name = $3, merchant_name = $4,
         amount = $5, currency_code = $6, category = $7, pending = $8
         WHERE plaid_transaction_id = $9`,
        [accountId, txn.date, txn.name, txn.merchant_name || null,
         txn.amount, txn.iso_currency_code || 'USD', category, txn.pending,
         txn.transaction_id]
      );
    } else {
      await pool.query(
        `INSERT INTO transactions (account_id, plaid_transaction_id, date, name, merchant_name,
         amount, currency_code, category, pending)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [accountId, txn.transaction_id, txn.date, txn.name, txn.merchant_name || null,
         txn.amount, txn.iso_currency_code || 'USD', category, txn.pending]
      );
    }
  }

  static async _handlePlaidError(plaidItemId, err) {
    const errorCode = err.response?.data?.error_code;
    const errorMessage = err.response?.data?.error_message || err.message;
    if (errorCode) {
      await PlaidItem.setError(plaidItemId, errorCode, errorMessage);
      logger.warn({ plaidItemId, errorCode, errorMessage }, 'Plaid item error');
    }
  }
}

module.exports = PlaidService;

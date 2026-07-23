'use strict';

const plaidClient = require('../config/plaid');
const { Products, CountryCode } = require('plaid');
const pool = require('../config/database');
const PlaidItem = require('../models/PlaidItem');
const PriceCache = require('../models/PriceCache');
const Trade = require('../models/Trade');
const SecurityMaster = require('../models/SecurityMaster');
const logger = require('../config/logger');

// Plaid investment subtypes carry the tax treatment exactly; the app only needs
// to know whether gains are taxed now (taxable), on withdrawal (traditional),
// never (roth), or never-when-medical (hsa). Non-investment subtypes have no
// treatment, so they stay NULL rather than being forced into 'taxable'.
const TAX_TREATMENT_BY_SUBTYPE = {
  roth: 'roth',
  'roth 401k': 'roth',
  hsa: 'hsa',
  '401k': 'traditional',
  '401a': 'traditional',
  '403b': 'traditional',
  '457b': 'traditional',
  ira: 'traditional',
  'sep ira': 'traditional',
  'simple ira': 'traditional',
  sarsep: 'traditional',
  pension: 'traditional',
  keogh: 'traditional',
  'thrift savings plan': 'traditional',
};

function deriveTaxTreatment(subtype, accountType) {
  if (accountType !== 'investment' && accountType !== 'brokerage') return null;
  const key = String(subtype || '').toLowerCase().trim();
  // Plaid often returns a null subtype on the first accounts/get after linking
  // and fills it in later. Guessing here would be permanent: the sync only ever
  // fills a NULL tax_treatment, so a first-sync guess of 'taxable' would still
  // be there after the subtype resolves to '401k'.
  if (!key) return null;
  // An unrecognized investment subtype is far more likely to be a new flavor of
  // brokerage than a new flavor of retirement account.
  return TAX_TREATMENT_BY_SUBTYPE[key] || 'taxable';
}

// debt_terms.apr is a FRACTION (0.2349), not a percentage: runScenario uses it
// directly as a growth rate and renders it as apr * 100. Plaid reports
// percentages (23.49). Every APR path below must divide by 100.
//
// Number(null) is 0, so the null check cannot be left to Number.isFinite: a
// missing rate stored as 0 would survive the COALESCE in the upsert and
// overwrite a real APR with 0%.
function toAprFraction(percentage) {
  if (percentage === null || percentage === undefined || percentage === '') return null;
  const value = Number(percentage);
  return Number.isFinite(value) ? value / 100 : null;
}

function dayOfMonth(dateString) {
  if (!dateString) return null;
  const day = Number(String(dateString).slice(8, 10));
  return Number.isInteger(day) && day >= 1 && day <= 31 ? day : null;
}

// Flattens one Plaid liability object onto the debt_terms columns. `kind` is the
// key it arrived under: credit, mortgage or student. Exported for testing.
function mapLiabilityToDebtTerms(liability, kind) {
  const common = {
    nextPaymentDueDate: liability.next_payment_due_date || null,
    lastPaymentAmount: liability.last_payment_amount ?? null,
    lastPaymentDate: liability.last_payment_date || null,
    lastStatementBalance: liability.last_statement_balance ?? null,
    lastStatementDate: liability.last_statement_issue_date || null,
    isOverdue: liability.is_overdue ?? null,
    dueDay: dayOfMonth(liability.next_payment_due_date),
    maturityDate: null,
  };

  if (kind === 'credit') {
    const aprs = liability.aprs || [];
    // Cards carry several APRs (purchase, cash advance, balance transfer,
    // promotional) and Plaid does not guarantee their order. Only the purchase
    // APR applies to ordinary spending, and it is the one runScenario compares
    // against expected investment returns. There is deliberately no fallback:
    // a 0% intro transfer rate would report the card as free money and a cash
    // advance rate would overstate the case for paying it down. An unknown APR
    // is more useful than a confidently wrong one.
    const purchase = aprs.find(a => a.apr_type === 'purchase_apr') || null;
    return {
      ...common,
      apr: purchase ? toAprFraction(purchase.apr_percentage) : null,
      minimumPayment: liability.minimum_payment_amount ?? null,
    };
  }

  if (kind === 'mortgage') {
    return {
      ...common,
      apr: toAprFraction(liability.interest_rate?.percentage),
      minimumPayment: liability.next_monthly_payment ?? null,
      maturityDate: liability.maturity_date || null,
    };
  }

  return {
    ...common,
    apr: toAprFraction(liability.interest_rate_percentage),
    minimumPayment: liability.minimum_payment_amount ?? null,
    maturityDate: liability.expected_payoff_date || null,
  };
}

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

    // Items linked before a product was requested never consented to it, and
    // plain update mode does not change that -- it re-authorizes, it does not
    // widen scope. Re-listing a product the item already consented to is
    // accepted by Plaid; listing one the institution does not support is a hard
    // INVALID_FIELD, so the list is derived from the accounts actually held.
    const additional = await this._consentableProducts(plaidItemId);
    if (additional.length) request.additional_consented_products = additional;

    try {
      const response = await plaidClient.linkTokenCreate(request);
      return response.data.link_token;
    } catch (err) {
      // Holding a loan account does not prove the institution supports the
      // liabilities product (M1's margin loan is exactly that case), and update
      // mode is the recovery path for a broken item. Widening consent must
      // never be the reason an item cannot be re-linked at all.
      if (!request.additional_consented_products) throw err;
      logger.warn(
        { plaidItemId, additional, errorCode: err.response?.data?.error_code },
        'Update link token rejected with additional consent; retrying without it'
      );
      delete request.additional_consented_products;
      const response = await plaidClient.linkTokenCreate(request);
      return response.data.link_token;
    }
  }

  // Products this item could hold data for, judged by the accounts it has. Not
  // "missing" consent -- no consent state is stored to diff against, and Plaid
  // accepts a product that was already consented.
  static async _consentableProducts(plaidItemId) {
    const result = await pool.query(
      'SELECT DISTINCT type FROM accounts WHERE plaid_item_id = $1',
      [plaidItemId]
    );
    // An item whose first sync never completed has no account rows, and that is
    // precisely when re-link is the prescribed recovery. Ask for both and let
    // the retry above drop the list if the institution refuses.
    if (!result.rows.length) return [Products.Liabilities, Products.Investments];

    const types = new Set(result.rows.map(row => row.type));
    const products = [];
    if (types.has('credit') || types.has('loan')) products.push(Products.Liabilities);
    if (types.has('investment')) products.push(Products.Investments);
    return products;
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
    // Only set for items under OAuth consent windows (EU/UK today); NULL is the
    // normal case in the US and must not be treated as "expired".
    await PlaidItem.updateConsentExpiration(
      plaidItemId,
      accountsResponse.data.item?.consent_expiration_time || null
    );
    const plaidAccounts = accountsResponse.data.accounts;
    const syncedAccountIds = [];
    const results = { accounts: 0, holdings: 0, balances: 0, removed: 0 };

    for (const pa of plaidAccounts) {
      const accountName = `${prefix} - ${pa.official_name || pa.name}`;
      const dbAccount = await this._upsertAccount(accountName, plaidItemId, pa);
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
        await this._upsertSecurities(securities);

        for (const holding of holdings) {
          const security = securityMap.get(holding.security_id);
          if (!security) continue;

          const accountId = await this._getAccountIdByPlaidAccountId(holding.account_id);
          if (!accountId) continue;

          const ticker = security.ticker_symbol || null;
          const name = security.name || 'Unknown Security';
          const quantity = holding.quantity;
          const manualValue = holding.institution_value ?? null;

          await this._upsertHolding(accountId, ticker, name, quantity, manualValue, {
            costBasis: holding.cost_basis ?? null,
            price: holding.institution_price ?? null,
            priceAsOf: holding.institution_price_as_of ?? null,
          });

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
      // Plaid reports credit and loan balances as positive amounts owed;
      // store liabilities negative so snapshots and net worth stay consistent.
      const value = pa.type === 'credit' || pa.type === 'loan' ? -Math.abs(balance) : balance;

      await this._upsertHolding(accountId, null, holdingName, null, value);
      results.balances++;
    }

    if (plaidAccounts.some(pa => pa.type === 'credit' || pa.type === 'loan')) {
      results.liabilities = await this._syncLiabilities(plaidItemId, access_token);
      // Hoisted to the top level because that is where the Settings page reads
      // it to offer the re-link button; nested, the item would look healthy
      // while debt_terms stayed silently empty.
      if (results.liabilities.consentRequired) results.consentRequired = true;
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

  static async _upsertAccount(name, plaidItemId, pa) {
    const plaidAccountId = pa.account_id;
    const dbType = this._mapPlaidType(pa.type);
    const balances = pa.balances || {};
    // Raw Plaid convention: credit/loan balances are positive amounts owed.
    // The negation applied to the pseudo-holdings is deliberately not repeated.
    const detail = [
      pa.subtype || null,
      pa.mask || null,
      balances.available ?? null,
      balances.current ?? null,
      balances.limit ?? null,
      deriveTaxTreatment(pa.subtype, pa.type),
    ];
    // tax_treatment only fills a NULL: a manual override through the accounts
    // route must survive the next sync.
    const detailAssign = `subtype = $1, mask = $2, balance_available = $3,
       balance_current = $4, balance_limit = $5,
       tax_treatment = COALESCE(accounts.tax_treatment, $6)`;

    const existing = await pool.query(
      'SELECT id FROM accounts WHERE plaid_account_id = $1',
      [plaidAccountId]
    );

    if (existing.rows.length > 0) {
      const result = await pool.query(
        `UPDATE accounts SET ${detailAssign}, plaid_item_id = $7, type = $8
         WHERE plaid_account_id = $9 RETURNING *`,
        [...detail, plaidItemId, dbType, plaidAccountId]
      );
      return result.rows[0];
    }

    const reclaimable = await pool.query(
      'SELECT id FROM accounts WHERE name = $1 AND plaid_account_id IS NULL',
      [name]
    );
    if (reclaimable.rows.length > 0) {
      const result = await pool.query(
        `UPDATE accounts SET ${detailAssign}, plaid_item_id = $7, plaid_account_id = $8, type = $9
         WHERE id = $10 RETURNING *`,
        [...detail, plaidItemId, plaidAccountId, dbType, reclaimable.rows[0].id]
      );
      return result.rows[0];
    }

    const nameConflict = await pool.query(
      'SELECT id FROM accounts WHERE name = $1',
      [name]
    );
    const finalName = nameConflict.rows.length > 0 ? `${name} (Plaid)` : name;

    const result = await pool.query(
      `INSERT INTO accounts (subtype, mask, balance_available, balance_current, balance_limit,
       tax_treatment, name, type, plaid_item_id, plaid_account_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
      [...detail, finalName, dbType, plaidItemId, plaidAccountId]
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

  // `institution` carries what the brokerage itself reports for the position.
  // institution_cost_basis is the only basis available for positions opened
  // before Plaid's trade window, so tax lots fall back to it.
  static async _upsertHolding(accountId, ticker, name, quantity, manualValue, institution = {}) {
    const matchClause = ticker
      ? 'account_id = $1 AND UPPER(ticker) = UPPER($2)'
      : 'account_id = $1 AND ticker IS NULL AND name = $2';
    const matchParams = ticker ? [accountId, ticker] : [accountId, name];

    const existing = await pool.query(
      `SELECT id FROM holdings WHERE ${matchClause}`,
      matchParams
    );

    const institutionValues = [
      institution.costBasis ?? null,
      institution.price ?? null,
      institution.priceAsOf ?? null,
    ];

    if (existing.rows.length > 0) {
      await pool.query(
        `UPDATE holdings SET name = $1, quantity = $2, manual_value = $3,
         institution_cost_basis = $4, institution_price = $5, institution_price_as_of = $6,
         is_plaid_managed = TRUE, updated_at = CURRENT_TIMESTAMP
         WHERE id = $7`,
        [name, quantity, manualValue, ...institutionValues, existing.rows[0].id]
      );
    } else {
      await pool.query(
        `INSERT INTO holdings (account_id, ticker, name, quantity, manual_value,
         institution_cost_basis, institution_price, institution_price_as_of, is_plaid_managed)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, TRUE)`,
        [accountId, ticker, name, quantity, manualValue, ...institutionValues]
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

  // Liabilities are opt-in per institution and unavailable for many loan types
  // (M1's margin loan returns nothing at all). A miss here is normal, so the
  // whole step is isolated and never fails the sync.
  static async _syncLiabilities(plaidItemId, accessToken) {
    let updated = 0;
    try {
      const response = await plaidClient.liabilitiesGet({ access_token: accessToken });
      const liabilities = response.data.liabilities || {};
      for (const kind of ['credit', 'mortgage', 'student']) {
        for (const liability of liabilities[kind] || []) {
          const accountId = await this._getAccountIdByPlaidAccountId(liability.account_id);
          if (!accountId) continue;
          await this._upsertDebtTerms(accountId, mapLiabilityToDebtTerms(liability, kind));
          updated++;
        }
      }
    } catch (err) {
      // The whole body is inside the try, including the writes: syncItem calls
      // this before the transaction sync, so anything escaping here would cost
      // a day of transactions over an optional product.
      const errorCode = err.response?.data?.error_code;
      const expected = ['PRODUCTS_NOT_SUPPORTED', 'PRODUCT_NOT_READY', 'NO_LIABILITY_ACCOUNTS'];
      if (expected.includes(errorCode)) {
        logger.info({ plaidItemId, errorCode }, 'Liabilities not available for this item');
      } else if (errorCode === 'ADDITIONAL_CONSENT_REQUIRED') {
        // Persisted, not just returned: Settings rebuilds its consent set from
        // error_code on every load, so a transient flag on the sync response is
        // discarded before the re-link button can render. syncItem clears the
        // error at the top of each run, so this re-arms itself while it applies.
        logger.info({ plaidItemId }, 'Additional consent required for liabilities — user must re-link');
        await PlaidItem.setError(
          plaidItemId,
          'ADDITIONAL_CONSENT_REQUIRED',
          'Additional consent required for liability data. Please re-link this account.'
        );
        return { updated, consentRequired: true };
      } else {
        logger.error({ plaidItemId, err }, 'Failed to sync liabilities');
      }
      return { updated, error: errorCode || 'unknown' };
    }

    return { updated };
  }

  // Only the Plaid-owned columns are overwritten: is_tax_deductible and notes
  // are hand-maintained, and maturity_date is only supplied for mortgages and
  // student loans, so a NULL must not clear a manually entered one.
  static async _upsertDebtTerms(accountId, terms) {
    await pool.query(
      `INSERT INTO debt_terms (account_id, apr, minimum_payment, due_day, maturity_date,
       next_payment_due_date, last_statement_balance, last_statement_date,
       last_payment_amount, last_payment_date, is_overdue, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, CURRENT_TIMESTAMP)
       ON CONFLICT (account_id) DO UPDATE
       SET apr = COALESCE(EXCLUDED.apr, debt_terms.apr),
           minimum_payment = COALESCE(EXCLUDED.minimum_payment, debt_terms.minimum_payment),
           -- due_day is derived from next_payment_due_date, which is overwritten
           -- unconditionally below; preserving one and not the other would let
           -- the two disagree.
           due_day = EXCLUDED.due_day,
           maturity_date = COALESCE(EXCLUDED.maturity_date, debt_terms.maturity_date),
           next_payment_due_date = EXCLUDED.next_payment_due_date,
           last_statement_balance = EXCLUDED.last_statement_balance,
           last_statement_date = EXCLUDED.last_statement_date,
           last_payment_amount = EXCLUDED.last_payment_amount,
           last_payment_date = EXCLUDED.last_payment_date,
           is_overdue = EXCLUDED.is_overdue,
           updated_at = CURRENT_TIMESTAMP`,
      [accountId, terms.apr, terms.minimumPayment, terms.dueDay, terms.maturityDate,
       terms.nextPaymentDueDate, terms.lastStatementBalance, terms.lastStatementDate,
       terms.lastPaymentAmount, terms.lastPaymentDate, terms.isOverdue]
    );
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
    }

    // Persisted once, after the last page. Plaid invalidates a pagination run
    // when the item mutates mid-sync (TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION);
    // storing an intermediate cursor would make the abandoned run's pages look
    // consumed and silently drop the transactions on them.
    //
    // An empty next_cursor is never written over a real one: Plaid returns one
    // while an item's initial historical pull is still running, and storing it
    // would replay the item's entire history on the next sync.
    if (cursor) {
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
    let trades = 0;
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
      // Securities that have been fully sold out no longer appear in the holdings
      // response, so this feed is the only place their metadata shows up.
      await this._upsertSecurities(data.securities);

      for (const txn of data.investment_transactions) {
        const accountId = await this._getAccountIdByPlaidAccountId(txn.account_id);
        if (!accountId) continue;

        const security = txn.security_id ? securities.get(txn.security_id) : null;
        const ticker = security?.ticker_symbol || null;
        const description = ticker ? `${txn.name} (${ticker})` : txn.name;
        const category = txn.subtype || txn.type || null;

        await this._upsertInvestmentTransaction(accountId, txn, description, category);
        added++;
        if (await this._upsertTrade(accountId, txn, ticker)) trades++;
      }

      if (data.investment_transactions.length === 0) break;
      offset += data.investment_transactions.length;
    }

    return { added, trades };
  }

  static async _upsertSecurities(securities) {
    for (const security of securities || []) {
      if (!security.ticker_symbol) continue;
      await SecurityMaster.upsert(security);
    }
  }

  // Plaid's investment feed mixes security trades with cash events (dividends,
  // contributions, fees); only type buy/sell are trades, and the cash events
  // become investment_cash_flows instead. Quantity arrives negative on sells
  // while the trades CHECK requires it positive, so `side` carries direction.
  static async _upsertTrade(accountId, txn, ticker) {
    const side = txn.type === 'buy' ? 'buy' : (txn.type === 'sell' ? 'sell' : null);
    if (!side) return false;

    const context = { investmentTransactionId: txn.investment_transaction_id, name: txn.name };
    if (!ticker) {
      logger.warn(context, 'Investment trade has no ticker symbol; skipping trade record');
      return false;
    }

    const quantity = Math.abs(Number(txn.quantity) || 0);
    if (quantity <= 0) {
      logger.warn(context, 'Investment trade has no quantity; skipping trade record');
      return false;
    }

    await Trade.upsert({
      accountId,
      tradeDate: txn.date,
      symbol: ticker.toUpperCase(),
      side,
      quantity,
      price: Math.abs(Number(txn.price) || 0),
      fees: Math.abs(Number(txn.fees) || 0),
      externalId: txn.investment_transaction_id,
    });
    return true;
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
    const pfc = txn.personal_finance_category || {};
    const values = [
      accountId,
      txn.date,
      txn.name,
      txn.merchant_name || null,
      txn.amount,
      txn.iso_currency_code || 'USD',
      pfc.primary || null,
      txn.pending,
      pfc.detailed || null,
      pfc.confidence_level || null,
      txn.authorized_date || null,
      txn.payment_channel || null,
      txn.pending_transaction_id || null,
      txn.merchant_entity_id || null,
      txn.logo_url || null,
      txn.website || null,
    ];

    // A settled transaction supersedes the pending row it came from. Plaid only
    // sends a `removed` event for the pending row on the timeline that created
    // it, so a cursor reset (full history replay) would otherwise leave the
    // pending duplicate behind forever. Classifications cascade on delete.
    if (txn.pending_transaction_id) {
      await pool.query(
        'DELETE FROM transactions WHERE plaid_transaction_id = $1',
        [txn.pending_transaction_id]
      );
    }

    const existing = await pool.query(
      'SELECT id FROM transactions WHERE plaid_transaction_id = $1',
      [txn.transaction_id]
    );

    if (existing.rows.length > 0) {
      await pool.query(
        `UPDATE transactions SET account_id = $1, date = $2, name = $3, merchant_name = $4,
         amount = $5, currency_code = $6, category = $7, pending = $8,
         detailed_category = $9, category_confidence = $10, authorized_date = $11,
         payment_channel = $12, pending_transaction_id = $13, merchant_entity_id = $14,
         logo_url = $15, website = $16
         WHERE plaid_transaction_id = $17`,
        [...values, txn.transaction_id]
      );
    } else {
      await pool.query(
        `INSERT INTO transactions (account_id, date, name, merchant_name,
         amount, currency_code, category, pending,
         detailed_category, category_confidence, authorized_date,
         payment_channel, pending_transaction_id, merchant_entity_id,
         logo_url, website, plaid_transaction_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)`,
        [...values, txn.transaction_id]
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
module.exports.deriveTaxTreatment = deriveTaxTreatment;
module.exports.mapLiabilityToDebtTerms = mapLiabilityToDebtTerms;

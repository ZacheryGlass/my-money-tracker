'use strict';

const { canonicalAsset } = require('./exchangeImport/canonicalFingerprint');
const { addAmounts } = require('./exchangeImport/shared');

const VENUES = { coinbase: 'Coinbase', kraken: 'Kraken', binance_us: 'Binance.US' };
const FIAT = new Set(['USD', 'EUR', 'GBP', 'CAD', 'AUD', 'CHF', 'JPY', 'NZD', 'SEK', 'NOK', 'DKK', 'BRL', 'ARS', 'MXN', 'TRY', 'PLN']);

function snapshotHoldings(account, snapshot) {
  if (!account.user_id || snapshot?.complete !== true || snapshot.provider !== account.exchange
    || !snapshot.balances || typeof snapshot.balances !== 'object' || Array.isArray(snapshot.balances)
    || !Number.isFinite(Date.parse(snapshot.observed_at))) {
    throw new Error('Exchange holdings require a complete, dated, owner-scoped provider snapshot');
  }
  const generation = (value) => value ? new Date(value).toISOString() : null;
  if (generation(snapshot.credential_generation) !== generation(account.credentials_updated_at)) {
    throw new Error('Exchange holdings snapshot belongs to different credentials');
  }
  const balances = new Map();
  for (const [code, value] of Object.entries(snapshot.balances)) {
    const asset = canonicalAsset(account.exchange, code);
    const amount = String(value);
    if (!asset || asset.length > 20 || !/^[A-Z0-9._-]+$/.test(asset)
      || !/^-?\d{1,20}(\.\d{1,18})?$/.test(amount)) {
      throw new Error('Invalid asset or quantity in exchange holdings snapshot');
    }
    balances.set(asset, addAmounts(balances.get(asset) || '0', amount));
  }
  return [...balances].filter(([, quantity]) => quantity !== '0').map(([asset, quantity]) => ({
    // USD cash is valued directly; it must never enter the crypto price cache.
    ticker: FIAT.has(asset) ? null : asset,
    name: asset === 'USD' ? 'US Dollar' : asset,
    quantity,
    manual_value: asset === 'USD' ? quantity : null,
    // Non-USD fiat quantities remain visible but unvalued until FX is available.
    category: FIAT.has(asset) ? 'Cash' : 'Crypto',
  }));
}

class ExchangeHoldingsService {
  // Caller holds the exchange row lock. Projection and source snapshot commit
  // together; a failed/incomplete read never clears the last known holdings.
  static async syncSnapshot(account, snapshot, { client } = {}) {
    if (!client) throw new Error('Exchange holdings must be written inside the sync transaction');
    const rows = snapshotHoldings(account, snapshot);
    const result = await client.query(
      `INSERT INTO accounts (user_id, name, display_name, type, exchange_account_id, exchange_balance_as_of)
       VALUES ($1, $2, $3, 'crypto', $4, $5)
       ON CONFLICT (exchange_account_id) DO UPDATE
         SET exchange_balance_as_of = EXCLUDED.exchange_balance_as_of
       WHERE accounts.user_id = EXCLUDED.user_id
       RETURNING id`,
      [account.user_id, `${VENUES[account.exchange] || account.exchange} exchange ${account.id}`,
        account.name.slice(0, 100), account.id, snapshot.observed_at]
    );
    const accountId = result.rows[0]?.id;
    if (!accountId) throw new Error('Exchange portfolio account ownership changed');
    for (const row of rows) {
      // NULL tickers do not conflict under holdings' existing unique key.
      if (row.ticker === null) {
        const updated = await client.query(
          `UPDATE holdings SET quantity = $2, manual_value = $3, updated_at = $4
           WHERE account_id = $1 AND ticker IS NULL AND name = $5 RETURNING id`,
          [accountId, row.quantity, row.manual_value, snapshot.observed_at, row.name]
        );
        if (updated.rows.length) continue;
      }
      await client.query(
        `INSERT INTO holdings (account_id, ticker, name, quantity, manual_value, category, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (account_id, ticker, name) DO UPDATE
           SET quantity = EXCLUDED.quantity, manual_value = EXCLUDED.manual_value,
               category = EXCLUDED.category, updated_at = EXCLUDED.updated_at`,
        [accountId, row.ticker, row.name, row.quantity, row.manual_value, row.category, snapshot.observed_at]
      );
    }
    await client.query('DELETE FROM holdings WHERE account_id = $1 AND NOT (name = ANY($2::text[]))',
      [accountId, rows.map((row) => row.name)]);
    return { accountId, holdings: rows.length };
  }
}

module.exports = ExchangeHoldingsService;
module.exports.snapshotHoldings = snapshotHoldings;

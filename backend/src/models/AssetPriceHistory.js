'use strict';

const pool = require('../config/database');
const { NATIVE_ASSET_KEY } = require('../utils/assetPriceKey');
const chains = require('../config/chains');

// How far a close may be carried FORWARD to value a date that has none.
//
// Crypto trades every day, so a gap in a daily series is a provider hiccup, not
// a market holiday -- reaching back a few days is a repair. Reaching back
// further is a fabrication, and the bound is what keeps this from becoming the
// bug it replaces: carrying 2016's first close across a decade would be exactly
// as wrong as valuing 2016 at today's price, just quieter.
//
// Deliberately one-directional. A close is NEVER carried backward: the first
// price a token ever had says nothing about what it was worth before it
// existed, and an airdrop valued at its post-listing price is how a $0 position
// becomes a taxable event that never happened.
const MAX_CARRY_DAYS = 7;

// transactions.amount is DECIMAL(15,2) and the mirror clamps to this, so a leg
// valuation clamps to the same bound. Without it one scam token quoting a
// nonsense price would abort a whole wallet's valuation with a numeric
// overflow -- an error whose blast radius is every OTHER row in that UPDATE.
const USD_CLAMP = '9999999999999.99';

// A native leg's key, expressed in SQL and GENERATED FROM THE REGISTRY rather
// than written out: chains.nativeSymbol is the JS half of exactly this, and a
// hand-maintained second list is the drift this file's next comment warns
// about. Chains whose native asset is ETH need no arm -- they are the ELSE, so
// the emitted SQL is byte-identical to the pre-Polygon literal when no chain
// overrides it.
const nativeKeySql = (t) => {
  const overrides = chains
    .allChains()
    .filter((chain) => chain.nativeAsset !== NATIVE_ASSET_KEY);
  if (!overrides.length) return `'${NATIVE_ASSET_KEY}'`;
  const whens = overrides
    .map((chain) => `WHEN ${t}.chain_id = ${chain.id} THEN '${chain.nativeAsset}'`)
    .join(' ');
  return `CASE ${whens} ELSE '${NATIVE_ASSET_KEY}' END`;
};

// The asset key of an eth_transfers row, expressed in SQL. Mirrors
// utils/assetPriceKey.js assetKeyForTransfer exactly, and the tests assert the
// two agree: a drift here values every token row against a key nothing ever
// writes and silently unprices the lot.
const assetKeySql = (t = 't') => `
  CASE
    WHEN ${t}.transfer_type IN ('nft', 'nft1155') THEN NULL
    WHEN ${t}.transfer_type = 'token' THEN
      CASE WHEN ${t}.token_contract IS NULL THEN NULL
           ELSE 'erc20:' || ${t}.chain_id || ':' || LOWER(${t}.token_contract) END
    ELSE ${nativeKeySql(t)}
  END`;

// Whole units from base units. NFT legs never reach here (their key is NULL
// above); token legs use their own decimals, clamped to [0, 78] like
// legDecimals in services/ethActivity/legs.js so a malformed feed value cannot
// turn 10^decimals into an aborting exponent.
//
// The window function is the same repair the activity builder's netting loop
// makes, and it has to be: Etherscan omits `tokenDecimal` on some legs of a
// contract it fills in on others, and the activity builder upgrades a NULL leg
// to the first non-NULL value it sees for that contract. Scaling by a blind 18
// here instead would value a 6-decimals leg at 3e-12 tokens -- $0.00, stamped
// `exact` -- on the same row whose netted `amount` says 6 FOO. One notion of
// "how big is this token" has to feed both columns or they contradict each
// other in the UI.
const quantitySql = (t = 't') => `
  ${t}.value_wei / (10::numeric ^ (
    CASE WHEN ${t}.transfer_type = 'token'
         THEN LEAST(GREATEST(COALESCE(
                ${t}.token_decimals,
                MIN(${t}.token_decimals) OVER (PARTITION BY ${t}.chain_id, ${t}.token_contract),
                18), 0), 78)
         ELSE 18 END
  ))`;

// "The newest close at or before this leg's date, within the carry window."
//
// block_time is a timestamp without time zone holding the same wall clock the
// mirror stamps on transactions.date, so ::date here and the ledger's date can
// never disagree about which day a transfer happened on.
const priceLateralSql = (t = 't') => `
  LEFT JOIN LATERAL (
    SELECT p.price_usd, p.price_date
    FROM asset_price_history p
    WHERE p.asset_key = ${assetKeySql(t)}
      AND p.price_date <= ${t}.block_time::date
      AND p.price_date >= ${t}.block_time::date - ${MAX_CARRY_DAYS}
    ORDER BY p.price_date DESC
    LIMIT 1
  ) px ON TRUE`;

// Shared by the job's work list and the user-facing unpriced enumeration, so
// the two can never disagree about which rows have a priceable asset. NFT legs
// are out of scope; a 'token' row with no contract is malformed rather than
// native and must not be priced as ETH.
const PRICEABLE_LEG_SQL = `
  t.transfer_type NOT IN ('nft', 'nft1155')
  AND (t.transfer_type <> 'token' OR t.token_contract IS NOT NULL)`;

// Chain and contract describe TOKEN assets only. A native key is one asset
// across every chain that shares its symbol (ETH on mainnet, Arbitrum and
// Linea is one series), so aggregating a chain id onto it would label 'ETH'
// with whichever chain sorted first.
const TOKEN_FACET_SQL = `
  MIN(t.chain_id) FILTER (WHERE t.token_contract IS NOT NULL) AS chain_id,
  MIN(LOWER(t.token_contract)) AS contract_address`;

class AssetPriceHistory {
  // Idempotent by construction: the PK is (asset_key, price_date) and the
  // conflict arm overwrites, so a backfill can be re-run over a window it
  // already holds and a provisional close stored for TODAY is corrected by
  // tomorrow's run -- the same resume-inclusive convention BenchmarkService
  // uses for benchmark_prices.
  static async upsertMany(assetKey, points, source) {
    if (!points.length) return 0;
    const CHUNK = 500;
    let upserted = 0;
    for (let start = 0; start < points.length; start += CHUNK) {
      const chunk = points.slice(start, start + CHUNK);
      const values = [];
      const placeholders = chunk.map((point, i) => {
        const base = i * 4;
        values.push(assetKey, point.date, String(point.price), source);
        return `($${base + 1}, $${base + 2}, $${base + 3}::numeric, $${base + 4})`;
      });
      const result = await pool.query(
        `INSERT INTO asset_price_history (asset_key, price_date, price_usd, source)
         VALUES ${placeholders.join(', ')}
         ON CONFLICT (asset_key, price_date) DO UPDATE
         SET price_usd = EXCLUDED.price_usd,
             source = EXCLUDED.source,
             fetched_at = CURRENT_TIMESTAMP`,
        values
      );
      upserted += result.rowCount;
    }
    return upserted;
  }

  // The stored window for one asset. Drives the incremental fetch: the job asks
  // for what is missing at each end rather than re-downloading a decade nightly.
  static async coveredRange(assetKey) {
    const result = await pool.query(
      `SELECT MIN(price_date) AS earliest, MAX(price_date) AS latest, COUNT(*)::int AS points
       FROM asset_price_history WHERE asset_key = $1`,
      [assetKey]
    );
    const row = result.rows[0] || {};
    return {
      earliest: row.earliest || null,
      latest: row.latest || null,
      points: Number(row.points) || 0,
    };
  }

  // Every asset the ledger references, with the date span its rows need -- the
  // price job's work list.
  //
  // GLOBAL, across every user, exactly like the price-update and benchmark
  // jobs: asset_price_history is shared market data and one user's 2017 history
  // prices another user's 2017 history for free. Job-only entry point, named
  // ForJobs for the same reason Holding.findAllForJobs is; nothing user-facing
  // calls it.
  //
  // Ignored tokens are excluded. The user declared them noise, they produce no
  // mirror row, and spending a free-tier key on every airdropped scam contract
  // is how the assets that matter end up rate-limited out.
  static ledgerAssetsForJobs() {
    return this._ledgerAssets(null);
  }

  // The same work list for ONE wallet, so a freshly added wallet's history can
  // be priced during its first sync instead of staying unpriced until the
  // nightly job next runs. Not a scoping hole: it narrows the global list by
  // wallet id, and every caller has already resolved that wallet's owner.
  static ledgerAssetsForWallet(walletId) {
    return this._ledgerAssets(walletId);
  }

  static async _ledgerAssets(walletId) {
    const params = [];
    let scope = '';
    if (walletId != null) {
      params.push(walletId);
      scope = ' AND t.wallet_id = $1';
    }
    const result = await pool.query(
      `SELECT ${assetKeySql()} AS asset_key,
              MAX(t.token_symbol) AS asset_symbol,
              ${TOKEN_FACET_SQL},
              MIN(t.block_time)::date AS first_date,
              MAX(t.block_time)::date AS last_date,
              COUNT(*)::int AS transfer_count
       FROM eth_transfers t
       JOIN eth_wallets w ON w.id = t.wallet_id
       WHERE ${PRICEABLE_LEG_SQL}${scope}
         AND (t.token_contract IS NULL
              OR t.token_contract NOT IN (
                SELECT contract_address FROM eth_ignored_tokens WHERE user_id = w.user_id))
       GROUP BY 1
       ORDER BY COUNT(*) DESC, 1`,
      params
    );
    return result.rows;
  }

  // What the provider had to say about an asset, remembered so the next run
  // does not ask again. See 043: a dead EtherDelta-era token has no series
  // anywhere, and re-probing it nightly forever is the cost of not writing this
  // down.
  static async upsertCoverage(entry) {
    const result = await pool.query(
      `INSERT INTO asset_price_coverage
         (asset_key, asset_symbol, chain_id, contract_address, status, provider,
          earliest_date, latest_date, detail, checked_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, CURRENT_TIMESTAMP)
       ON CONFLICT (asset_key) DO UPDATE
       SET asset_symbol = COALESCE(EXCLUDED.asset_symbol, asset_price_coverage.asset_symbol),
           chain_id = COALESCE(EXCLUDED.chain_id, asset_price_coverage.chain_id),
           contract_address = COALESCE(EXCLUDED.contract_address, asset_price_coverage.contract_address),
           status = EXCLUDED.status,
           provider = EXCLUDED.provider,
           earliest_date = EXCLUDED.earliest_date,
           latest_date = EXCLUDED.latest_date,
           detail = EXCLUDED.detail,
           checked_at = CURRENT_TIMESTAMP
       RETURNING *`,
      [
        entry.assetKey,
        entry.assetSymbol ?? null,
        entry.chainId ?? null,
        entry.contractAddress ?? null,
        entry.status,
        entry.provider ?? null,
        entry.earliestDate ?? null,
        entry.latestDate ?? null,
        entry.detail ? String(entry.detail).slice(0, 300) : null,
      ]
    );
    return result.rows[0] || null;
  }

  static async coverageFor(assetKeys) {
    if (!assetKeys.length) return new Map();
    const result = await pool.query(
      'SELECT * FROM asset_price_coverage WHERE asset_key = ANY($1::varchar[])',
      [assetKeys]
    );
    return new Map(result.rows.map((row) => [row.asset_key, row]));
  }

  // THE valuation. One statement, exact NUMERIC throughout, rewritten wholesale
  // per wallet -- the same derive-and-replace contract as
  // reclassifyCounterparties and the activity rebuild, which is what makes "re-
  // running classification does not drift valuations" true by construction
  // rather than by hope. The mirror and the activity layer READ these columns;
  // neither one prices anything itself, so there is exactly one implementation.
  //
  // Every leg gets a verdict, including the ones with no dollar meaning, so
  // `usd_basis IS NULL` means "never valued" and is distinguishable from
  // "valued, and there is genuinely no price".
  static async applyToWallet(walletId) {
    const result = await pool.query(
      `UPDATE eth_transfers up
          SET usd_at_time = v.usd, usd_basis = v.basis
         FROM (
           SELECT t.id,
                  CASE
                    -- No USD meaning at all. An NFT leg's value_wei is a COUNT
                    -- OF UNITS (033) and a failed transfer moved nothing; both
                    -- would otherwise multiply out to a confident wrong number.
                    -- Gas legs are exempt from the failure arm: a reverted
                    -- transaction still burned a real fee, which is exactly why
                    -- gas legs are written is_error = FALSE.
                    WHEN t.transfer_type IN ('nft', 'nft1155') THEN NULL
                    WHEN t.is_error AND t.transfer_type <> 'gas' THEN NULL
                    WHEN px.price_usd IS NULL THEN NULL
                    ELSE ROUND(
                      GREATEST(LEAST(${quantitySql()} * px.price_usd, ${USD_CLAMP}::numeric),
                               -${USD_CLAMP}::numeric), 2)
                  END AS usd,
                  CASE
                    WHEN t.transfer_type IN ('nft', 'nft1155') THEN 'not_applicable'
                    WHEN t.is_error AND t.transfer_type <> 'gas' THEN 'not_applicable'
                    WHEN px.price_usd IS NULL THEN 'unpriced'
                    WHEN px.price_date = t.block_time::date THEN 'exact'
                    ELSE 'carried'
                  END AS basis
           FROM eth_transfers t
           ${priceLateralSql()}
           WHERE t.wallet_id = $1
         ) v
        WHERE up.id = v.id
          -- Skip the no-op rewrite. A wallet whose prices have not moved is the
          -- steady state and every classification refresh runs this pass.
          AND (up.usd_basis IS DISTINCT FROM v.basis OR up.usd_at_time IS DISTINCT FROM v.usd)`,
      [walletId]
    );
    return result.rowCount;
  }

  // The enumeration behind "unpriced tokens are enumerated, not silently zero".
  //
  // User-scoped through the wallet join, like every other ledger read: the
  // PRICES are global, but which assets a person's history contains is not.
  // Fail-closed -- an unscoped call throws rather than listing every user's
  // tokens.
  static async unpricedAssetsForUser(userId) {
    if (!userId) throw new Error('AssetPriceHistory.unpricedAssetsForUser requires a userId');
    const result = await pool.query(
      `SELECT ${assetKeySql()} AS asset_key,
              MAX(t.token_symbol) AS asset_symbol,
              ${TOKEN_FACET_SQL},
              COUNT(*)::int AS transfer_count,
              MIN(t.block_time) AS first_seen,
              MAX(t.block_time) AS last_seen
       FROM eth_transfers t
       JOIN eth_wallets w ON w.id = t.wallet_id
       WHERE w.user_id = $1
         -- NULL is "never valued", which the ledger ALSO renders as $0.00 --
         -- exactly the silently-zero state this endpoint exists to expose. It
         -- is the window between deploying 043 and the first valuation pass,
         -- and matching 043's index predicate keeps the two in step.
         AND (t.usd_basis IS NULL OR t.usd_basis = 'unpriced')
         AND ${PRICEABLE_LEG_SQL}
         AND (t.token_contract IS NULL
              OR t.token_contract NOT IN (
                SELECT contract_address FROM eth_ignored_tokens WHERE user_id = $1))
       GROUP BY 1
       ORDER BY COUNT(*) DESC, 1`,
      [userId]
    );

    const rows = result.rows;
    const coverage = await this.coverageFor(rows.map((row) => row.asset_key));
    return rows.map((row) => {
      const seen = coverage.get(row.asset_key) || null;
      return {
        ...row,
        // No coverage row means the price job has not reached this asset yet --
        // reported as 'pending' rather than as a verdict it never gave.
        coverage_status: seen ? seen.status : 'pending',
        coverage_detail: seen ? seen.detail : null,
        coverage_checked_at: seen ? seen.checked_at : null,
      };
    });
  }
}

module.exports = AssetPriceHistory;
module.exports.MAX_CARRY_DAYS = MAX_CARRY_DAYS;
module.exports.assetKeySql = assetKeySql;

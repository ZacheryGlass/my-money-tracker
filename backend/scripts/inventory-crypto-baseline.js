'use strict';

// Read-only baseline for the crypto refactor. One REPEATABLE READ READ ONLY
// snapshot answers the questions later steps are gated on:
//   - session TimeZone and whether DATABASE_URL is a Neon pooler host;
//   - bridge candidates per user (above 250 the receipt rebuild throws);
//   - user label rows shadowing a curated builtin-* pack row;
//   - Binance.US distribution categories seen so far;
//   - zero-count probes for every data fix that re-runs on boot.
//
//   node scripts/inventory-crypto-baseline.js --output /abs/private/path.json
//
// The output holds per-user counts and label names, so it is written 0600 to a
// gitignored path; stdout prints only the probe totals.

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { Client } = require('pg');
const { writePrivateReport } = require('../src/utils/privateReport');

const CURATED_BUILTIN_SOURCES = [
  'builtin', 'builtin-bridge', 'builtin-polymarket', 'builtin-etherdelta', 'builtin-opensea',
];

// Each probe mirrors the WHERE clause of a data fix that runs on every boot.
// A nonzero count means the fix still does work on each boot, so it cannot be
// retired to a run-once migration yet.
const BOOT_DATA_FIX_PROBES = {
  '082_eth_transfers': 'SELECT COUNT(*) AS n FROM eth_transfers WHERE chain_id = 8453',
  '082_eth_activity': 'SELECT COUNT(*) AS n FROM eth_activity WHERE chain_id = 8453',
  '082_eth_wallet_chains': 'SELECT COUNT(*) AS n FROM eth_wallet_chains WHERE chain_id = 8453',
  '082_holdings': 'SELECT COUNT(*) AS n FROM holdings WHERE chain_id = 8453',
  '082_transactions': 'SELECT COUNT(*) AS n FROM transactions WHERE chain_id = 8453',
  '082_eth_feed_coverage': 'SELECT COUNT(*) AS n FROM eth_feed_coverage WHERE chain_id = 8453',
  '082_eth_reconciliation': 'SELECT COUNT(*) AS n FROM eth_reconciliation WHERE chain_id = 8453',
  '082_eth_bridge_endpoints': "SELECT COUNT(*) AS n FROM eth_bridge_endpoints WHERE chain_id = 8453 OR protocol = 'base'",
  '082_eth_hop_bridge_routes': 'SELECT COUNT(*) AS n FROM eth_hop_bridge_routes WHERE source_chain_id = 8453 OR destination_chain_id = 8453',
  '082_evm_audit_scopes': 'SELECT COUNT(*) AS n FROM evm_audit_scopes WHERE chain_id = 8453',
  '082_user_api_keys_cdp': "SELECT COUNT(*) AS n FROM user_api_keys WHERE service = 'cdp'",
  '082_base_bridge_labels': `
    SELECT COUNT(*) AS n FROM eth_address_labels
     WHERE user_id IS NULL AND source = 'builtin-bridge'
       AND (name LIKE 'Base:%' OR name = 'Across: Base Spoke Pool')`,
  '082_op_stack_label_names': `
    SELECT COUNT(*) AS n FROM eth_address_labels
     WHERE user_id IS NULL AND source = 'builtin-bridge'
       AND name IN ('OP Stack: L2 Standard Bridge', 'OP Stack: L2 To L1 Message Passer')`,
  '082_exchange_records_chain_8453': 'SELECT COUNT(*) AS n FROM exchange_records WHERE chain_id = 8453',
  '062_kraken_asset_aliases': `
    SELECT COUNT(*) AS n
      FROM exchange_records er JOIN exchange_accounts ea ON ea.id = er.exchange_account_id
     WHERE ea.exchange = 'kraken'
       AND (er.base_asset IN ('SOL03', 'SOL03.S') OR er.quote_asset IN ('SOL03', 'SOL03.S')
            OR er.fee_asset IN ('SOL03', 'SOL03.S'))`,
  '090_coinbase_eth2_asset_alias': `
    SELECT COUNT(*) AS n
      FROM exchange_records er JOIN exchange_accounts ea ON ea.id = er.exchange_account_id
     WHERE ea.exchange = 'coinbase'
       AND (er.base_asset = 'ETH2' OR er.quote_asset = 'ETH2' OR er.fee_asset = 'ETH2')`,
  '092_correct_feed_provider_provenance': `
    SELECT COUNT(*) AS n FROM eth_feed_coverage
     WHERE (chain_id = 42170 AND feed IN ('internal', 'token', 'nft', 'nft1155', 'statesync')
            AND provider = 'Blockscout (https://arbitrum-nova.blockscout.com/api/v2/)')
        OR (chain_id = 100 AND feed IN ('token', 'nft', 'nft1155', 'statesync')
            AND provider = 'Blockscout (https://gnosisscan.io/api/v2/)')
        OR (chain_id = 10 AND feed IN ('token', 'nft', 'nft1155', 'statesync')
            AND provider = 'Blockscout (https://explorer.optimism.io/api/v2/)')`,
  // 068 is DO UPDATE: a row whose stored value differs from the seed is
  // rewritten on every boot.
  '068_evm_asset_identity_registry': `
    SELECT COUNT(*) AS n
      FROM (VALUES ('ETH', 'native:ETH', 'chain registry nativeAsset=ETH'),
                   ('MATIC', 'native:POL', 'chain registry MATIC to POL 1:1 rename'),
                   ('POL', 'native:POL', 'chain registry nativeAsset=POL'),
                   ('XDAI', 'native:XDAI', 'chain registry nativeAsset=XDAI')) AS seed(code, key, source)
      LEFT JOIN evm_asset_identity_registry r ON r.asset_code = seed.code
     WHERE r.asset_code IS NULL OR r.canonical_key <> seed.key OR r.source <> seed.source`,
};

// 087 is a CTE over raw Coinbase Pro product strings; re-use its own SELECT
// rather than restating it.
function probe087(sql) {
  const start = sql.indexOf('WITH');
  const update = sql.lastIndexOf('UPDATE exchange_records er');
  if (start === -1 || update === -1) return null;
  return `${sql.slice(start, update)}SELECT COUNT(*) AS n FROM corrections`;
}

async function main() {
  const outputIndex = process.argv.indexOf('--output');
  const output = outputIndex === -1 ? null : process.argv[outputIndex + 1];
  if (!output) throw new Error('--output /absolute/private/path.json is required');
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set');

  const host = new URL(url).hostname;
  const client = new Client({
    connectionString: url,
    ssl: /localhost|127\.0\.0\.1/.test(host) ? false : { rejectUnauthorized: false },
  });
  await client.connect();
  const report = { generated_at: new Date().toISOString(), database_host_is_neon_pooler: /-pooler\./.test(host) };
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    report.session = (await client.query(
      "SELECT current_setting('TimeZone') AS timezone, current_setting('server_version') AS server_version"
    )).rows[0];

    report.bridge_candidates_per_user = (await client.query(
      `SELECT w.user_id, COUNT(*)::int AS candidates
         FROM eth_activity a
         JOIN eth_wallets w ON w.id = a.wallet_id
         LEFT JOIN eth_activity_overrides o
           ON o.wallet_id = a.wallet_id AND o.chain_id = a.chain_id AND o.tx_hash = a.tx_hash
        WHERE COALESCE(o.category, a.category) IN ('bridge_out', 'bridge_in')
        GROUP BY w.user_id ORDER BY w.user_id`
    )).rows;

    report.user_rows_shadowing_curated_builtins = (await client.query(
      `SELECT u.user_id, b.source AS builtin_source, b.kind AS builtin_kind, b.name AS builtin_name,
              u.kind AS user_kind, u.name AS user_name, u.address
         FROM eth_address_labels b
         JOIN eth_address_labels u ON u.address = b.address AND u.user_id IS NOT NULL
        WHERE b.user_id IS NULL AND b.source = ANY($1::text[])
        ORDER BY u.user_id, b.source, b.name`,
      [CURATED_BUILTIN_SOURCES]
    )).rows;

    report.binanceus_distribution_categories = (await client.query(
      `SELECT er.raw->>'category' AS category, er.record_type, COUNT(*)::int AS records,
              BOOL_OR(er.needs_review) AS any_needs_review
         FROM exchange_records er JOIN exchange_accounts ea ON ea.id = er.exchange_account_id
        WHERE ea.exchange = 'binance_us' AND er.external_id LIKE 'binanceus:distribution:%'
        GROUP BY 1, 2 ORDER BY 3 DESC`
    )).rows;

    const probes = {};
    for (const [name, sql] of Object.entries(BOOT_DATA_FIX_PROBES)) {
      probes[name] = Number((await client.query(sql)).rows[0].n);
    }
    const sql087 = probe087(require('fs').readFileSync(
      require('path').join(__dirname, '..', 'migrations', '087_coinbase_pro_product_orientation.sql'), 'utf8'
    ));
    probes['087_coinbase_pro_product_orientation'] = sql087
      ? Number((await client.query(sql087)).rows[0].n) : null;
    report.boot_data_fix_probes = probes;
    await client.query('ROLLBACK');
  } finally {
    await client.end();
  }

  writePrivateReport(output, report);
  console.log(JSON.stringify({
    timezone: report.session.timezone,
    neon_pooler: report.database_host_is_neon_pooler,
    bridge_candidates_max: Math.max(0, ...report.bridge_candidates_per_user.map((r) => r.candidates)),
    shadowing_rows: report.user_rows_shadowing_curated_builtins.length,
    binanceus_categories: report.binanceus_distribution_categories.length,
    boot_data_fix_probes: report.boot_data_fix_probes,
  }, null, 2));
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});

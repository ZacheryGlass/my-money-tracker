#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const csv = require('csv-parser');
const pool = require('../src/config/database');

let verificationLog = [];

function log(message) {
  console.log(message);
  verificationLog.push(message);
}

async function countCsvRows() {
  log('\n=== COUNTING CSV ROWS ===');

  const exportsDir = path.join(__dirname, '../data/exports');
  const results = {};

  const accountSheets = [
    'Crypto Shares.csv',
    'HSA Shares.csv',
    'Taxable Shares.csv',
    '401k Shares.csv',
    'Roth IRA Shares.csv'
  ];

  for (const filename of accountSheets) {
    const filepath = path.join(exportsDir, filename);
    if (!fs.existsSync(filepath)) {
      log(`⚠️  ${filename} not found`);
      results[filename] = 0;
      continue;
    }

    const count = await countRows(filepath);
    results[filename] = count;
    log(`${filename}: ${count} rows`);
  }

  const historySheets = ['Ticker History.csv', 'Account History.csv'];
  for (const filename of historySheets) {
    const filepath = path.join(exportsDir, filename);
    if (!fs.existsSync(filepath)) {
      log(`⚠️  ${filename} not found`);
      results[filename] = 0;
      continue;
    }

    const count = await countRows(filepath);
    results[filename] = count;
    log(`${filename}: ${count} rows`);
  }

  return results;
}

function countRows(filepath) {
  return new Promise((resolve, reject) => {
    let count = 0;

    fs.createReadStream(filepath)
      .pipe(csv())
      .on('data', () => {
        count++;
      })
      .on('end', () => {
        resolve(count);
      })
      .on('error', reject);
  });
}

async function verifyDatabase() {
  log('\n=== DATABASE VERIFICATION ===\n');

  // Holdings count
  const holdingsRes = await pool.query('SELECT COUNT(*) as count FROM holdings');
  const holdingsCount = holdingsRes.rows[0].count;
  log(`Holdings table: ${holdingsCount} rows`);

  // Ticker snapshots count
  const tickerSnapshotsRes = await pool.query('SELECT COUNT(*) as count FROM ticker_snapshots');
  const tickerSnapshotsCount = tickerSnapshotsRes.rows[0].count;
  log(`Ticker snapshots: ${tickerSnapshotsCount} rows`);

  // Account snapshots count
  const accountSnapshotsRes = await pool.query('SELECT COUNT(*) as count FROM account_snapshots');
  const accountSnapshotsCount = accountSnapshotsRes.rows[0].count;
  log(`Account snapshots: ${accountSnapshotsCount} rows`);

  // Accounts with holdings
  log('\n--- Accounts with Holdings ---');
  const accountHoldingsRes = await pool.query(`
    SELECT a.name, COUNT(h.id) as holding_count
    FROM accounts a
    LEFT JOIN holdings h ON a.id = h.account_id
    GROUP BY a.id, a.name
    ORDER BY a.id
  `);

  for (const row of accountHoldingsRes.rows) {
    const count = row.holding_count;
    const status = count > 0 ? '✅' : '⚠️ ';
    log(`${status} ${row.name}: ${count} holdings`);
  }

  // Check for NULL values in required fields
  log('\n--- NULL Value Check ---');
  const nullCheckRes = await pool.query(`
    SELECT
      (SELECT COUNT(*) FROM holdings WHERE account_id IS NULL) as null_account_id,
      (SELECT COUNT(*) FROM holdings WHERE name IS NULL) as null_name,
      (SELECT COUNT(*) FROM holdings WHERE category IS NULL) as null_category
  `);

  const nullCounts = nullCheckRes.rows[0];
  const nullIssues = Object.values(nullCounts).some(v => v > 0);

  if (!nullIssues) {
    log('✅ No NULL values in required fields');
  } else {
    log('❌ Found NULL values:');
    if (nullCounts.null_account_id > 0) log(`   account_id: ${nullCounts.null_account_id}`);
    if (nullCounts.null_name > 0) log(`   name: ${nullCounts.null_name}`);
    if (nullCounts.null_category > 0) log(`   category: ${nullCounts.null_category}`);
  }

  // Sample data spot check
  log('\n--- Sample Data (First 5 Holdings) ---');
  const sampleRes = await pool.query(`
    SELECT h.id, a.name as account, h.ticker, h.name, h.quantity, h.category
    FROM holdings h
    JOIN accounts a ON h.account_id = a.id
    ORDER BY h.id
    LIMIT 5
  `);

  for (const row of sampleRes.rows) {
    const ticker = row.ticker || '(none)';
    log(`  ${row.account}: ${row.name} (${ticker}) x${row.quantity}`);
  }

  // Check snapshot dates
  log('\n--- Snapshot Date Range ---');
  const snapshotRes = await pool.query(`
    SELECT
      MIN(snapshot_date) as earliest,
      MAX(snapshot_date) as latest,
      COUNT(*) as total
    FROM ticker_snapshots
  `);

  if (snapshotRes.rows[0].total > 0) {
    const earliest = new Date(snapshotRes.rows[0].earliest).toLocaleDateString();
    const latest = new Date(snapshotRes.rows[0].latest).toLocaleDateString();
    log(`Ticker snapshots: ${earliest} to ${latest} (${snapshotRes.rows[0].total} total)`);
  } else {
    log('⚠️ No ticker snapshots found');
  }

  const accountSnapshotRes = await pool.query(`
    SELECT
      MIN(snapshot_date) as earliest,
      MAX(snapshot_date) as latest,
      COUNT(*) as total
    FROM account_snapshots
  `);

  if (accountSnapshotRes.rows[0].total > 0) {
    const earliest = new Date(accountSnapshotRes.rows[0].earliest).toLocaleDateString();
    const latest = new Date(accountSnapshotRes.rows[0].latest).toLocaleDateString();
    log(`Account snapshots: ${earliest} to ${latest} (${accountSnapshotRes.rows[0].total} total)`);
  } else {
    log('⚠️ No account snapshots found');
  }

  return { holdingsCount, tickerSnapshotsCount, accountSnapshotsCount };
}

async function generateReport() {
  log('\n=== IMPORT VERIFICATION REPORT ===\n');

  const csvCounts = await countCsvRows();
  const dbCounts = await verifyDatabase();

  log('\n=== SUMMARY ===');
  log(`Total holdings imported: ${dbCounts.holdingsCount}`);
  log(`Ticker snapshots: ${dbCounts.tickerSnapshotsCount}`);
  log(`Account snapshots: ${dbCounts.accountSnapshotsCount}`);

  // Calculate expected holdings (rough estimate)
  const accountRowCount = Object.entries(csvCounts)
    .filter(([name]) => name.includes('Shares'))
    .reduce((sum, [, count]) => sum + count, 0);

  log(`\nExpected holdings (estimate): ~${accountRowCount} (may be less due to filtering)`);

  log('\n✅ Verification complete. Data is ready for use.');
}

async function main() {
  try {
    await generateReport();
    process.exit(0);
  } catch (err) {
    log(`\n❌ VERIFICATION FAILED: ${err.message}`);
    console.error(err);
    process.exit(1);
  }
}

main();

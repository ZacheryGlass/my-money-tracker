#!/usr/bin/env node
'use strict';

// Rebuild derived exchange matches for one user (`--user-id N`) or every user
// with exchange records (no argument). This uses only the database-backed
// matcher: it never resolves credentials or contacts an exchange provider.
// User verdicts remain in exchange_match_verdicts and are read by
// ExchangeMatchService during every rebuild.

const pool = require('../src/config/database');
const ExchangeMatchService = require('../src/services/ExchangeMatchService');

async function run() {
  const userFlag = process.argv.indexOf('--user-id');
  let requestedUserId = null;
  if (userFlag !== -1) {
    requestedUserId = Number(process.argv[userFlag + 1]);
    if (!Number.isInteger(requestedUserId) || requestedUserId <= 0) {
      throw new Error('--user-id requires a positive integer');
    }
  }

  const result = await pool.query(
    `SELECT DISTINCT ea.user_id
       FROM exchange_accounts ea
       JOIN exchange_records er ON er.exchange_account_id = ea.id
      WHERE ($1::int IS NULL OR ea.user_id = $1)
      ORDER BY ea.user_id`,
    [requestedUserId]
  );

  if (requestedUserId && result.rows.length === 0) {
    throw new Error(`No exchange records found for user ${requestedUserId}`);
  }

  let failures = 0;
  for (const row of result.rows) {
    const userId = Number(row.user_id);
    try {
      const rebuilt = await ExchangeMatchService.rebuildForUser(userId);
      console.log(`user ${userId}: rebuilt ${rebuilt.matches} exchange match(es)`);
    } catch (error) {
      failures += 1;
      console.error(`user ${userId}: exchange match rebuild failed: ${error.message}`);
    }
  }

  if (failures > 0) {
    throw new Error(`${failures} user rebuild(s) failed`);
  }
}

run()
  .catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  })
  .finally(() => pool.end());

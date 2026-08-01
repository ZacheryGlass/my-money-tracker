'use strict';

const pool = require('../config/database');
const JobLog = require('../models/JobLog');
const ExchangeMatchService = require('../services/ExchangeMatchService');
const logger = require('../config/logger');

const JOB_NAME = 'exchange-match-policy-v3';
const RULE_VERSION = 'v3';

// This is a one-time migration of derived state, not a recurring matcher pass.
// A completed row makes subsequent boots cheap; a failed run remains retryable.
async function run() {
  const latest = await JobLog.getLatest(JOB_NAME);
  if (latest?.status === 'completed') {
    return { skipped: true, reason: 'already_completed' };
  }

  const jobLog = await JobLog.createIfNotRunning(JOB_NAME);
  if (!jobLog) return { skipped: true, reason: 'already_running' };

  let users;
  const results = [];
  let succeeded = 0;
  let failed = 0;

  try {
    users = await pool.query('SELECT id FROM users ORDER BY id');
    for (const user of users.rows) {
      try {
        const result = await ExchangeMatchService.rebuildForUser(user.id);
        results.push({ userId: user.id, ...result });
        succeeded += 1;
      } catch (error) {
        failed += 1;
        results.push({ userId: user.id, error: error.message });
        logger.warn({ userId: user.id, err: error }, 'Exchange match hardening rebuild failed for user');
      }
    }

    if (failed > 0) {
      const error = new Error('Exchange match hardening failed for ' + failed + ' user(s)');
      await JobLog.fail(jobLog.id, error.message, {
        ruleVersion: RULE_VERSION,
        processed: users.rows.length,
        succeeded,
        failed,
        results,
      });
      throw error;
    }

    await JobLog.complete(jobLog.id, users.rows.length, succeeded, failed, {
      ruleVersion: RULE_VERSION,
      results,
    });
    return { skipped: false, processed: users.rows.length, succeeded, failed, results };
  } catch (error) {
    if (failed === 0) {
      await JobLog.fail(jobLog.id, error.message, { ruleVersion: RULE_VERSION, results });
    }
    throw error;
  }
}

module.exports = { JOB_NAME, run };

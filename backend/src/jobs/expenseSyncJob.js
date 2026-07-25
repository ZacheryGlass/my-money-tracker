'use strict';

const pool = require('../config/database');
const JobLog = require('../models/JobLog');
const ExpenseSyncService = require('../services/ExpenseSyncService');
const TransactionClassificationService = require('../services/TransactionClassificationService');
const InvestmentCashFlowService = require('../services/InvestmentCashFlowService');
const TaxLotService = require('../services/TaxLotService');
const logger = require('../config/logger');

const JOB_NAME = 'expense-sync';

async function run() {
  logger.info({ job: JOB_NAME }, 'Starting expense sync job');

  const isAlreadyRunning = await JobLog.isRunning(JOB_NAME);
  if (isAlreadyRunning) {
    logger.info({ job: JOB_NAME }, 'Job already running, skipping');
    return { skipped: true, reason: 'concurrent_execution' };
  }

  const jobLog = await JobLog.create(JOB_NAME);

  try {
    const classification = await TransactionClassificationService.backfill();

    // Derived from the transactions the Plaid sync landed at 7:30, so this must
    // stay after classification and before the tax lot rebuild reads trades.
    // Isolated because investment analytics are a later addition to this job:
    // a failure here must not stop it refreshing recurring expenses, which is
    // what it existed for first.
    let cashFlows = { derived: 0, external: 0 };
    let taxLots = { lots: 0 };
    try {
      cashFlows = await InvestmentCashFlowService.backfill();
      taxLots = await TaxLotService.rebuild();
    } catch (error) {
      logger.error({ job: JOB_NAME, err: error }, 'Investment analytics refresh failed; continuing with expense sync');
    }

    // Recurring expenses and ignore lists are per-user, so the sync runs once
    // per user; one user's failure must not stop the rest.
    const users = await pool.query('SELECT id FROM users ORDER BY id');
    const results = [];
    let groupCount = 0;
    let updated = 0;
    const created = [];
    const skipped = [];
    for (const { id: userId } of users.rows) {
      try {
        const result = await ExpenseSyncService.run(userId);
        groupCount += result.groupCount;
        updated += result.refreshed.length + result.created.length;
        created.push(...result.created);
        skipped.push(...result.skipped);
        results.push({ userId, refreshed: result.refreshed.length, created: result.created.length });
      } catch (error) {
        logger.error({ job: JOB_NAME, userId, err: error }, 'Expense sync failed for user');
        results.push({ userId, error: error.message });
      }
    }

    await JobLog.complete(jobLog.id, groupCount, updated, 0, {
      classified: classification.classified,
      investmentCashFlows: cashFlows.derived,
      externalCashFlows: cashFlows.external,
      taxLots: taxLots.lots,
      perUser: results,
      created,
      skipped,
    });
    logger.info({ job: JOB_NAME, updated, created: created.length }, 'Expense sync job completed');
    return { perUser: results, groupCount, updated, created, skipped };
  } catch (error) {
    logger.error({ job: JOB_NAME, err: error }, 'Job failed');
    await JobLog.fail(jobLog.id, error.message, { stack: error.stack });
    throw error;
  }
}

module.exports = { run, JOB_NAME };

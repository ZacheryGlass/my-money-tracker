const pool = require('../config/database');

class JobLog {
  // Scheduled jobs are intentionally run by one application scheduler
  // instance. A process can be terminated while a job is awaiting a provider,
  // leaving its durable row at "running" forever even though no JavaScript
  // execution still owns it. At process boot, rows that predate this process
  // are therefore failed explicitly before any cron task is registered.
  static async failInterruptedRuns(before) {
    if (!(before instanceof Date) || Number.isNaN(before.getTime())) {
      throw new TypeError('before must be a valid Date');
    }
    const details = JSON.stringify({
      interrupted: true,
      reason: 'application_process_restarted',
    });
    const result = await pool.query(
      `UPDATE job_logs
       SET status = 'failed',
           completed_at = CURRENT_TIMESTAMP,
           duration_ms = EXTRACT(MILLISECONDS FROM (CURRENT_TIMESTAMP - started_at)),
           error_message = 'Application process restarted before the job completed',
           details = COALESCE(details, '{}'::jsonb) || $2::jsonb
       WHERE status = 'running'
         AND started_at < $1
       RETURNING id, job_name, started_at`,
      [before, details]
    );
    return result.rows;
  }

  static async create(jobName) {
    const result = await pool.query(
      'INSERT INTO job_logs (job_name, status, started_at) VALUES ($1, $2, CURRENT_TIMESTAMP) RETURNING *',
      [jobName, 'running']
    );
    return result.rows[0];
  }

  static async complete(id, processed, succeeded, failed, details = null) {
    const result = await pool.query(
      `UPDATE job_logs
       SET status = 'completed',
           completed_at = CURRENT_TIMESTAMP,
           duration_ms = EXTRACT(MILLISECONDS FROM (CURRENT_TIMESTAMP - started_at)),
           tickers_processed = $1,
           tickers_succeeded = $2,
           tickers_failed = $3,
           details = $4
       WHERE id = $5
       RETURNING *`,
      [processed, succeeded, failed, details ? JSON.stringify(details) : null, id]
    );
    return result.rows[0];
  }

  static async fail(id, errorMessage, details = null) {
    const result = await pool.query(
      `UPDATE job_logs
       SET status = 'failed',
           completed_at = CURRENT_TIMESTAMP,
           duration_ms = EXTRACT(MILLISECONDS FROM (CURRENT_TIMESTAMP - started_at)),
           error_message = $1,
           details = $2
       WHERE id = $3
       RETURNING *`,
      [errorMessage, details ? JSON.stringify(details) : null, id]
    );
    return result.rows[0];
  }

  static async getLatest(jobName) {
    const result = await pool.query(
      'SELECT * FROM job_logs WHERE job_name = $1 ORDER BY started_at DESC LIMIT 1',
      [jobName]
    );
    return result.rows[0];
  }

  static async getHistory(jobName, limit = 10) {
    const result = await pool.query(
      'SELECT * FROM job_logs WHERE job_name = $1 ORDER BY started_at DESC LIMIT $2',
      [jobName, limit]
    );
    return result.rows;
  }

  static async isRunning(jobName) {
    const result = await pool.query(
      "SELECT COUNT(*) as count FROM job_logs WHERE job_name = $1 AND status = 'running'",
      [jobName]
    );
    return parseInt(result.rows[0].count) > 0;
  }
}

module.exports = JobLog;

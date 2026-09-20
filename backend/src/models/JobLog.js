const pool = require('../config/database');

class JobLog {
  // Scheduled jobs are intentionally run by one application scheduler
  // instance. A process can be terminated while a job is awaiting a provider,
  // leaving its durable row at "running" forever even though no JavaScript
  // execution still owns it. At process boot, rows older than the caller's
  // recovery boundary are failed explicitly before any cron task is registered;
  // a rolling deployment must not fail a live row owned by another instance.
  static async failInterruptedRuns(staleAfterMs) {
    if (!Number.isSafeInteger(staleAfterMs) || staleAfterMs <= 0) {
      throw new TypeError('staleAfterMs must be a positive integer');
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
         AND COALESCE(heartbeat_at, started_at)
             < CURRENT_TIMESTAMP - make_interval(secs => $1::double precision / 1000)
       RETURNING id, job_name, started_at`,
      [staleAfterMs, details]
    );
    return result.rows;
  }

  static async create(jobName) {
    const result = await pool.query(
      `INSERT INTO job_logs (job_name, status, started_at, heartbeat_at)
       VALUES ($1, $2, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
       RETURNING *`,
      [jobName, 'running']
    );
    return result.rows[0];
  }

  // The partial unique index on (job_name) WHERE status='running' is the
  // cross-process claim. A caller that loses the race gets a normal skip
  // instead of throwing a scheduler error.
  static async createIfNotRunning(jobName) {
    try {
      return await this.create(jobName);
    } catch (error) {
      if (error.code === '23505') return null;
      throw error;
    }
  }

  static async heartbeat(id) {
    const result = await pool.query(
      `UPDATE job_logs
       SET heartbeat_at = CURRENT_TIMESTAMP
       WHERE id = $1 AND status = 'running'
       RETURNING id, status, heartbeat_at`,
      [id]
    );
    return result.rows[0] || null;
  }

  static async failIfStale(id, staleAfterMs, errorMessage) {
    if (!Number.isSafeInteger(staleAfterMs) || staleAfterMs <= 0) {
      throw new TypeError('staleAfterMs must be a positive integer');
    }
    const result = await pool.query(
      `UPDATE job_logs
       SET status = 'failed',
           completed_at = CURRENT_TIMESTAMP,
           duration_ms = EXTRACT(MILLISECONDS FROM (CURRENT_TIMESTAMP - started_at)),
           error_message = $1,
           details = COALESCE(details, '{}'::jsonb) || '{"lease_expired":true}'::jsonb
       WHERE id = $2
         AND status = 'running'
         AND COALESCE(heartbeat_at, started_at)
             < CURRENT_TIMESTAMP - make_interval(secs => $3::double precision / 1000)
       RETURNING *`,
      [errorMessage, id, staleAfterMs]
    );
    return result.rows[0] || null;
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
       WHERE id = $5 AND status = 'running'
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
       WHERE id = $3 AND status = 'running'
       RETURNING *`,
      [errorMessage, details ? JSON.stringify(details) : null, id]
    );
    return result.rows[0];
  }

  static async getLatest(jobName) {
    const result = await pool.query(
      'SELECT * FROM job_logs WHERE job_name = $1 ORDER BY started_at DESC, id DESC LIMIT 1',
      [jobName]
    );
    return result.rows[0];
  }

  static async getByIdAndName(id, jobName) {
    const result = await pool.query(
      'SELECT * FROM job_logs WHERE id = $1 AND job_name = $2 LIMIT 1',
      [id, jobName]
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

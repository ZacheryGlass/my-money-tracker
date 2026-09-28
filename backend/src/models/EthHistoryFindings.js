'use strict';

const pool = require('../config/database');
const chains = require('../config/chains');

const KINDS = new Set(['missing_history', 'unmatched_transfer', 'fee_evidence',
  'balance_comparison', 'balance_evidence', 'source_conflict']);
const fail = () => { throw new Error('Invalid ETH history findings manifest'); };
const text = (s) => typeof s === 'string' && s.trim().length > 0 && s.length <= 2000;
const timestamp = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?Z$/.test(s)
  && Number.isFinite(Date.parse(s)) && new Date(s).toISOString().slice(0, 19) === s.slice(0, 19);

// Explicit projection keeps raw report payloads, identifiers and local paths
// out of the API. Empty assessments mean "no documented issues", not verified.
function validate(manifest, userId) {
  if (!Number.isSafeInteger(userId) || userId < 1 || manifest?.user_id !== userId
      || !Array.isArray(manifest.scopes) || !manifest.scopes.length || manifest.scopes.length > 1000) fail();
  const seen = new Set();
  return manifest.scopes.map(({ scope, observed_at, issues }) => {
    if (typeof scope !== 'string' || !/^(exchange:[1-9]\d*|wallet:[1-9]\d*:[1-9]\d*)$/.test(scope)
        || seen.has(scope) || !timestamp(observed_at) || Date.parse(observed_at) > Date.now()
        || !Array.isArray(issues) || issues.length > 1000) fail();
    const parts = scope.split(':');
    if (parts.slice(1).some((v) => !Number.isSafeInteger(Number(v)) || Number(v) > 2147483647)
        || (parts[0] === 'wallet' && !chains.allChains().some((c) => c.id === Number(parts[2]) && c.nativeAsset === 'ETH'))) fail();
    seen.add(scope);
    return { scope, findings: { observed_at, issues: issues.map((issue) => {
      const { kind, count, from = null, through = null, summary, evidence_needed } = issue;
      if (!KINDS.has(kind) || !Number.isSafeInteger(count) || count < 1
          || !text(summary) || !text(evidence_needed)
          || (from !== null && !timestamp(from)) || (through !== null && !timestamp(through))
          || (from !== null && through !== null && Date.parse(from) > Date.parse(through))) fail();
      return { kind, count, from, through, summary, evidence_needed };
    }) } };
  });
}

class EthHistoryFindings {
  // Operator import only; no public mutation endpoint. All scopes are checked
  // and locked before committing, including on a dry run. A foreign ID rolls
  // the entire batch back. Replaying identical evidence is harmless.
  static async importForUser(userId, manifest, { apply = false } = {}) {
    const entries = validate(manifest, userId);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      for (const { scope, findings } of entries) {
        const [type, id, chainId] = scope.split(':');
        const current = type === 'exchange'
          ? await client.query('SELECT eth_history_findings FROM exchange_accounts WHERE id=$1 AND user_id=$2 FOR UPDATE', [id, userId])
          : await client.query(`SELECT c.eth_history_findings FROM eth_wallet_chains c
              JOIN eth_wallets w ON w.id=c.wallet_id
              WHERE c.wallet_id=$1 AND w.user_id=$2 AND c.chain_id=$3 FOR UPDATE OF c, w`, [id, userId, chainId]);
        if (current.rows.length !== 1) throw new Error('History findings scope not owned or not present');
        const previous = current.rows[0].eth_history_findings;
        if (previous && Date.parse(previous.observed_at) > Date.parse(findings.observed_at)) {
          throw new Error('Refusing to replace newer history findings');
        }
        if (apply) {
          if (type === 'exchange') {
            await client.query('UPDATE exchange_accounts SET eth_history_findings=$3 WHERE id=$1 AND user_id=$2', [id, userId, findings]);
          } else {
            await client.query(`UPDATE eth_wallet_chains c SET eth_history_findings=$4
              FROM eth_wallets w WHERE w.id=c.wallet_id AND c.wallet_id=$1 AND w.user_id=$2 AND c.chain_id=$3`, [id, userId, chainId, findings]);
          }
        }
      }
      await client.query(apply ? 'COMMIT' : 'ROLLBACK');
      return { applied: apply, scopes: entries.length, issue_groups: entries.reduce((n, e) => n + e.findings.issues.length, 0) };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally { client.release(); }
  }
}

module.exports = { EthHistoryFindings, validate };

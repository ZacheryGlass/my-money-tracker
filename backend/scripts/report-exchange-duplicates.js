#!/usr/bin/env node

'use strict';

require('dotenv').config();
const pool = require('../src/config/database');
const { conflictingDetails, fingerprintFor } = require('../src/services/exchangeImport/canonicalFingerprint');

function option(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? null : process.argv[index + 1] || null;
}

function numericOption(name) {
  const value = option(name);
  if (value === null) return null;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error(`${name} must be a positive integer`);
  return parsed;
}

function completeness(record) {
  return [
    record.tx_hash, record.address, record.network, record.chain_id,
    record.quote_asset, record.quote_amount, record.fee_asset, record.fee_amount,
  ].filter((value) => value !== null && value !== undefined && value !== '').length;
}

function csvCell(value) {
  const text = value === null || value === undefined ? '' : String(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function reportRows(groups) {
  return groups.flatMap((group) => group.records.map((record) => ({
    account_id: group.account_id,
    account_name: group.account_name,
    user_id: group.user_id,
    exchange: group.exchange,
    fingerprint: group.fingerprint,
    ambiguous: group.ambiguous,
    conflicts: group.conflicts.join('|'),
    record_id: record.id,
    external_id: record.external_id,
    source: record.source,
    occurred_at: record.occurred_at,
    record_type: record.record_type,
    base_asset: record.base_asset,
    base_amount: record.base_amount,
    quote_asset: record.quote_asset,
    quote_amount: record.quote_amount,
    tx_hash: record.tx_hash,
    address: record.address,
    needs_review: record.needs_review,
    suggested_survivor_id: group.suggested_survivor_id,
  })));
}

async function main() {
  const format = option('--format') || 'json';
  if (!['json', 'csv'].includes(format)) throw new Error('--format must be json or csv');
  const userId = numericOption('--user-id');
  const accountId = numericOption('--account-id');
  const filters = [];
  const params = [];
  if (userId) { params.push(userId); filters.push(`ea.user_id = $${params.length}`); }
  if (accountId) { params.push(accountId); filters.push(`ea.id = $${params.length}`); }

  const result = await pool.query(
    `SELECT er.*, ea.user_id, ea.exchange, ea.name AS account_name
     FROM exchange_records er
     JOIN exchange_accounts ea ON ea.id = er.exchange_account_id
     ${filters.length ? `WHERE ${filters.join(' AND ')}` : ''}
     ORDER BY ea.id, er.occurred_at, er.id`,
    params
  );

  const grouped = new Map();
  for (const record of result.rows) {
    const fingerprint = record.fingerprint || fingerprintFor(record.exchange, record);
    if (!fingerprint) continue;
    const key = `${record.exchange_account_id}:${fingerprint}`;
    const group = grouped.get(key) || {
      account_id: record.exchange_account_id,
      account_name: record.account_name,
      user_id: record.user_id,
      exchange: record.exchange,
      fingerprint,
      records: [],
    };
    group.records.push(record);
    grouped.set(key, group);
  }

  const groups = [...grouped.values()]
    .filter((group) => group.records.length > 1)
    .map((group) => {
      const conflicts = [];
      for (let i = 0; i < group.records.length; i += 1) {
        for (let j = i + 1; j < group.records.length; j += 1) {
          for (const field of conflictingDetails(group.records[i], group.records[j])) {
            if (!conflicts.includes(field)) conflicts.push(field);
          }
        }
      }
      const sources = new Set(group.records.map((record) => record.source || 'unknown'));
      const suggested = [...group.records].sort((left, right) => {
        const review = Number(left.needs_review) - Number(right.needs_review);
        return review || completeness(right) - completeness(left) || right.id - left.id;
      })[0];
      return {
        ...group,
        conflicts,
        ambiguous: conflicts.length > 0 || sources.size < 2 || group.records.length > 2,
        suggested_survivor_id: suggested.id,
      };
    });

  const output = {
    generated_at: new Date().toISOString(),
    read_only: true,
    records_scanned: result.rows.length,
    candidate_groups: groups.length,
    candidate_records: groups.reduce((sum, group) => sum + group.records.length, 0),
    groups: groups.map((group) => ({
      account_id: group.account_id,
      account_name: group.account_name,
      user_id: group.user_id,
      exchange: group.exchange,
      fingerprint: group.fingerprint,
      ambiguous: group.ambiguous,
      conflicts: group.conflicts,
      suggested_survivor_id: group.suggested_survivor_id,
      records: group.records.map((record) => ({
        id: record.id,
        external_id: record.external_id,
        source: record.source,
        occurred_at: record.occurred_at,
        record_type: record.record_type,
        base_asset: record.base_asset,
        base_amount: record.base_amount,
        quote_asset: record.quote_asset,
        quote_amount: record.quote_amount,
        fee_asset: record.fee_asset,
        fee_amount: record.fee_amount,
        tx_hash: record.tx_hash,
        address: record.address,
        network: record.network,
        chain_id: record.chain_id,
        needs_review: record.needs_review,
        duplicate_candidate: record.duplicate_candidate,
      })),
    })),
  };

  if (format === 'csv') {
    const rows = reportRows(groups);
    const headers = Object.keys(rows[0] || {
      account_id: '', account_name: '', user_id: '', exchange: '', fingerprint: '',
      ambiguous: '', conflicts: '', record_id: '', external_id: '', source: '',
      occurred_at: '', record_type: '', base_asset: '', base_amount: '', quote_asset: '',
      quote_amount: '', tx_hash: '', address: '', needs_review: '', suggested_survivor_id: '',
    });
    process.stdout.write(`${headers.join(',')}\n${rows.map((row) => headers.map((header) => csvCell(row[header])).join(',')).join('\n')}\n`);
  } else {
    process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
  }
}

main()
  .catch((error) => {
    console.error(`Duplicate report failed: ${error.message}`);
    process.exitCode = 1;
  })
  .finally(() => pool.end().catch(() => {}));

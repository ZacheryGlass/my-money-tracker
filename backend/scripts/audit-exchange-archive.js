#!/usr/bin/env node

'use strict';

require('dotenv').config();
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const pool = require('../src/config/database');
const { parseExchangeCsv } = require('../src/services/exchangeImport');
const { fingerprintFor, conflictingDetails } = require('../src/services/exchangeImport/canonicalFingerprint');

const CLASSIFICATIONS = new Set(['source', 'evidence', 'irrelevant']);
const ADAPTERS = new Set(['exchange_csv', 'exact_copy', 'zip_single_file', 'eth_address_inventory', 'none']);

function option(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? null : process.argv[index + 1] || null;
}

function requiredOption(name) {
  const value = option(name);
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function positiveInteger(value, name) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error(`${name} must be a positive integer`);
  return parsed;
}

function sha256(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function uniqueAddresses(text) {
  return [...new Set((text.match(/0x[0-9a-fA-F]{40}/g) || []).map((address) => address.toLowerCase()))];
}

function normalizeManifest(manifestPath) {
  const absoluteManifest = path.resolve(manifestPath);
  const base = path.dirname(absoluteManifest);
  const manifest = JSON.parse(fs.readFileSync(absoluteManifest, 'utf8'));
  if (!Array.isArray(manifest.files) || manifest.files.length === 0) {
    throw new Error('Manifest must contain a non-empty files array');
  }

  const seen = new Set();
  const files = manifest.files.map((entry, index) => {
    if (!entry || typeof entry !== 'object' || !entry.path) {
      throw new Error(`Manifest file ${index + 1} has no path`);
    }
    if (!CLASSIFICATIONS.has(entry.classification)) {
      throw new Error(`${entry.path}: classification must be source, evidence, or irrelevant`);
    }
    const adapter = entry.adapter || (entry.classification === 'irrelevant' ? 'none' : null);
    if (!ADAPTERS.has(adapter)) throw new Error(`${entry.path}: unsupported or missing adapter`);
    if (!entry.reason || !String(entry.reason).trim()) throw new Error(`${entry.path}: reason is required`);

    const absolutePath = path.resolve(base, entry.path);
    if (seen.has(absolutePath)) throw new Error(`${entry.path}: file is listed more than once`);
    seen.add(absolutePath);
    if (!fs.statSync(absolutePath).isFile()) throw new Error(`${entry.path}: not a regular file`);
    return { ...entry, adapter, absolutePath };
  });
  return { manifestPath: absoluteManifest, files };
}

function indexLedgerRows(rows) {
  const external = new Map();
  const fingerprints = new Map();
  for (const row of rows) {
    const exchange = String(row.exchange || '').toLowerCase();
    const externalKey = `${exchange}\0${row.external_id}`;
    const byExternal = external.get(externalKey) || [];
    byExternal.push(row);
    external.set(externalKey, byExternal);

    const fingerprint = row.fingerprint || fingerprintFor(exchange, row);
    if (!fingerprint) continue;
    const fingerprintKey = `${exchange}\0${fingerprint}`;
    const byFingerprint = fingerprints.get(fingerprintKey) || [];
    byFingerprint.push(row);
    fingerprints.set(fingerprintKey, byFingerprint);
  }
  return { external, fingerprints };
}

function matchExchangeRecord(exchange, record, indexes) {
  const externalMatches = indexes.external.get(`${exchange}\0${record.external_id}`) || [];
  if (externalMatches.length) return { method: 'external_id', rows: externalMatches, disagreements: [] };
  const fingerprint = fingerprintFor(exchange, record);
  const candidates = fingerprint
    ? indexes.fingerprints.get(`${exchange}\0${fingerprint}`) || []
    : [];
  const rows = candidates.filter((candidate) => conflictingDetails(candidate, record).length === 0);
  const disagreements = candidates
    .filter((candidate) => !rows.includes(candidate))
    .map((candidate) => ({
      ledger_record_id: candidate.id,
      fields: conflictingDetails(candidate, record),
    }));
  return { method: rows.length ? 'fingerprint' : null, rows, disagreements };
}

function publicPath(entry) {
  return entry.label || path.basename(entry.absolutePath);
}

async function auditExchangeCsv(entry, ledgerIndexes) {
  const parsed = parseExchangeCsv(fs.readFileSync(entry.absolutePath, 'utf8'), {
    format: entry.format || 'auto',
  });
  const exchange = entry.exchange || parsed.format;
  const missing = [];
  const ambiguous = [];
  const disagreements = [];
  const methodCounts = {};
  for (const record of parsed.records) {
    const match = matchExchangeRecord(exchange, record, ledgerIndexes);
    if (match.rows.length === 0 && match.disagreements.length) {
      disagreements.push({ external_id: record.external_id, candidates: match.disagreements });
    } else if (match.rows.length === 0) {
      missing.push({ external_id: record.external_id, occurred_at: record.occurred_at });
    } else if (match.rows.length > 1) {
      ambiguous.push({ external_id: record.external_id, ledger_record_ids: match.rows.map((row) => row.id) });
    } else {
      methodCounts[match.method] = (methodCounts[match.method] || 0) + 1;
    }
  }
  return {
    format: parsed.format,
    exchange,
    parsed_records: parsed.records.length,
    matched_records: parsed.records.length - missing.length - ambiguous.length,
    match_methods: methodCounts,
    missing_records: missing,
    ambiguous_records: ambiguous,
    disagreement_records: disagreements,
    unparseable_rows: parsed.stats?.rejectedRows || [],
    parser_stats: parsed.stats,
    passed: missing.length === 0 && ambiguous.length === 0 && disagreements.length === 0
      && (parsed.stats?.rejectedRows || []).length === 0,
  };
}

async function auditAddressInventory(entry, userId) {
  const addresses = uniqueAddresses(fs.readFileSync(entry.absolutePath, 'utf8'));
  const result = addresses.length
    ? await pool.query(
      'SELECT lower(address) AS address FROM eth_address_notes WHERE user_id = $1 AND lower(address) = ANY($2::text[])',
      [userId, addresses]
    )
    : { rows: [] };
  const found = new Set(result.rows.map((row) => row.address));
  const missing = addresses.filter((address) => !found.has(address));
  return {
    unique_addresses: addresses.length,
    addresses_with_notes: found.size,
    missing_address_notes: missing,
    unparseable_rows: [],
    passed: missing.length === 0,
  };
}

function auditExactCopy(entry, allEntries) {
  if (!entry.of) throw new Error(`${entry.path}: exact_copy requires an of path`);
  const targetPath = path.resolve(path.dirname(entry.absolutePath), entry.of);
  const target = allEntries.find((candidate) => candidate.absolutePath === targetPath);
  if (!target) throw new Error(`${entry.path}: exact_copy target is not listed in the manifest`);
  const actual = sha256(entry.absolutePath);
  const expected = sha256(target.absolutePath);
  return {
    copy_of: publicPath(target),
    content_sha256_matches: actual === expected,
    unparseable_rows: [],
    passed: actual === expected,
  };
}

function auditZipSingleFile(entry, allEntries) {
  if (!entry.of) throw new Error(`${entry.path}: zip_single_file requires an of path`);
  const targetPath = path.resolve(path.dirname(entry.absolutePath), entry.of);
  const target = allEntries.find((candidate) => candidate.absolutePath === targetPath);
  if (!target) throw new Error(`${entry.path}: zip_single_file target is not listed in the manifest`);
  const listing = execFileSync('unzip', ['-Z1', entry.absolutePath], { encoding: 'utf8' })
    .split(/\r?\n/).filter(Boolean);
  if (listing.length !== 1) throw new Error(`${entry.path}: expected one archived file, found ${listing.length}`);
  const extracted = execFileSync('unzip', ['-p', entry.absolutePath]);
  const actual = crypto.createHash('sha256').update(extracted).digest('hex');
  const expected = sha256(target.absolutePath);
  return {
    archived_file: listing[0],
    copy_of: publicPath(target),
    content_sha256_matches: actual === expected,
    unparseable_rows: [],
    passed: actual === expected,
  };
}

async function main() {
  const manifestArg = requiredOption('--manifest');
  const userId = positiveInteger(requiredOption('--user-id'), '--user-id');
  const outputPath = option('--output');
  const manifest = normalizeManifest(manifestArg);
  const ledgerResult = await pool.query(
    `SELECT er.*, ea.exchange, ea.name AS account_name
     FROM exchange_records er
     JOIN exchange_accounts ea ON ea.id = er.exchange_account_id
     WHERE ea.user_id = $1
     ORDER BY er.id`,
    [userId]
  );
  const ledgerIndexes = indexLedgerRows(ledgerResult.rows);
  const files = [];

  for (const entry of manifest.files) {
    let audit;
    try {
      if (entry.adapter === 'exchange_csv') audit = await auditExchangeCsv(entry, ledgerIndexes);
      else if (entry.adapter === 'eth_address_inventory') audit = await auditAddressInventory(entry, userId);
      else if (entry.adapter === 'exact_copy') audit = auditExactCopy(entry, manifest.files);
      else if (entry.adapter === 'zip_single_file') audit = auditZipSingleFile(entry, manifest.files);
      else audit = { unparseable_rows: [], passed: true };
    } catch (error) {
      audit = { passed: false, error: error.message, unparseable_rows: [] };
    }
    files.push({
      file: publicPath(entry),
      sha256: sha256(entry.absolutePath),
      bytes: fs.statSync(entry.absolutePath).size,
      classification: entry.classification,
      adapter: entry.adapter,
      reason: entry.reason,
      adjudication: entry.adjudication || null,
      ...audit,
    });
  }

  const failures = files.filter((file) => !file.passed);
  const report = {
    generated_at: new Date().toISOString(),
    code_revision: process.env.GIT_REVISION || null,
    read_only: true,
    user_id: userId,
    ledger_records_scanned: ledgerResult.rows.length,
    summary: {
      files: files.length,
      source_files: files.filter((file) => file.classification === 'source').length,
      evidence_files: files.filter((file) => file.classification === 'evidence').length,
      irrelevant_files: files.filter((file) => file.classification === 'irrelevant').length,
      parsed_records: files.reduce((sum, file) => sum + (file.parsed_records || 0), 0),
      matched_records: files.reduce((sum, file) => sum + (file.matched_records || 0), 0),
      unparseable_rows: files.reduce((sum, file) => sum + file.unparseable_rows.length, 0),
      unexplained_files: failures.length,
      verdict: failures.length === 0
        ? 'Every saved record in the manifest is explained by the ledger.'
        : `${failures.length} file(s) still contain unexplained evidence or source records.`,
    },
    files,
  };
  const rendered = `${JSON.stringify(report, null, 2)}\n`;
  if (outputPath) fs.writeFileSync(path.resolve(outputPath), rendered, { mode: 0o600 });
  else process.stdout.write(rendered);
  if (failures.length) process.exitCode = 2;
}

if (require.main === module) {
  main()
    .catch((error) => {
      console.error(`Archive audit failed: ${error.message}`);
      process.exitCode = 1;
    })
    .finally(() => pool.end().catch(() => {}));
}

module.exports = {
  uniqueAddresses,
  indexLedgerRows,
  matchExchangeRecord,
  normalizeManifest,
};

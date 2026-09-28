'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { validate } = require('../src/models/EthHistoryFindings');

const issue = { kind: 'unmatched_transfer', count: 3, from: '2024-01-01T00:00:00Z', through: null,
  summary: 'Recorded transfers lack a counterparty link.', evidence_needed: 'Provider-native transfer identifiers.' };
const manifest = () => ({ user_id: 9001, scopes: [{ scope: 'exchange:42', observed_at: '2025-01-01T00:00:00Z', issues: [{ ...issue }] }] });

test('history findings require explicit matching owner, valid scopes and dated evidence', () => {
  for (const owner of [undefined, null, 0, '9001', 2]) assert.throws(() => validate(manifest(), owner));
  for (const scope of ['exchange:0', 'exchange:42 OR TRUE', 'wallet:1:137', 'wallet:1:999999', 'exchange:999999999999']) {
    const m = manifest(); m.scopes[0].scope = scope;
    assert.throws(() => validate(m, 9001));
  }
  for (const date of [null, 'unknown', '2025-99-01T00:00:00Z', '2025-02-30T00:00:00Z', '2999-01-01T00:00:00Z']) {
    const m = manifest(); m.scopes[0].observed_at = date;
    assert.throws(() => validate(m, 9001));
  }
  const duplicate = manifest(); duplicate.scopes.push(duplicate.scopes[0]);
  assert.throws(() => validate(duplicate, 9001));
});

test('history findings cannot invent a verified category, negative counts or reversed periods', () => {
  for (const change of [{ kind: 'verified' }, { count: -1 }, { count: 0 }, { count: 1.5 },
    { evidence_needed: '' }, { through: '2023-01-01T00:00:00Z' }, { from: 'yesterday' }]) {
    const m = manifest(); Object.assign(m.scopes[0].issues[0], change);
    assert.throws(() => validate(m, 9001));
  }
});

test('history import projects display-only fields and preserves unknown dates', () => {
  const m = manifest(); m.scopes[0].issues[0].raw_provider_secret = 'synthetic-never-export';
  m.scopes[0].local_report_path = '/private/synthetic.json';
  assert.deepEqual(validate(m, 9001), [{ scope: 'exchange:42', findings: {
    observed_at: m.scopes[0].observed_at, issues: [issue],
  } }]);
});

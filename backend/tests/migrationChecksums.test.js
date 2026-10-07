'use strict';

// A migration file never changes after it is committed: the tracked runner
// will not run it again on any database that already applied it, so an edit
// reaches nobody (and the runner warns about drift at every boot). A change
// goes in a NEW migration. New files are added to the manifest with
// UPDATE_SNAPSHOTS=1; existing entries are never rewritten by that.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { migrationFiles, versionOf, checksumOf, MIGRATIONS_DIR } = require('../scripts/lib/migrationRunner');

const MANIFEST = path.join(__dirname, 'fixtures', 'snapshots', 'migration-checksums.json');

test('committed migrations are immutable and every file is in the manifest', () => {
  const manifest = fs.existsSync(MANIFEST) ? JSON.parse(fs.readFileSync(MANIFEST, 'utf8')) : {};
  const current = Object.fromEntries(migrationFiles().map((file) => [
    versionOf(file), checksumOf(fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8')),
  ]));
  const changed = Object.keys(manifest).filter((version) => current[version] && current[version] !== manifest[version]);
  const deleted = Object.keys(manifest).filter((version) => !current[version]);
  assert.deepEqual(changed, [], `applied migrations were edited (write a new migration instead): ${changed.join(', ')}`);
  assert.deepEqual(deleted, [], `applied migrations were deleted: ${deleted.join(', ')}`);

  const unrecorded = Object.keys(current).filter((version) => !manifest[version]);
  if (unrecorded.length && process.env.UPDATE_SNAPSHOTS === '1') {
    const next = { ...manifest };
    for (const version of unrecorded) next[version] = current[version];
    fs.mkdirSync(path.dirname(MANIFEST), { recursive: true });
    fs.writeFileSync(MANIFEST, `${JSON.stringify(next, null, 2)}\n`);
    return;
  }
  assert.deepEqual(unrecorded, [], `new migrations missing from the manifest (run with UPDATE_SNAPSHOTS=1): ${unrecorded.join(', ')}`);
});

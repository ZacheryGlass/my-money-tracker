'use strict';

// Seed generators append a NEW migration instead of rewriting an applied one.
//
// With tracked migrations (S2) an applied file never runs again, so editing its
// generated seed block would change its checksum and reach no existing
// database. Instead each generator renders its full block, compares it with
// the newest migration that carries the same markers (the cumulative state),
// and when they differ writes the next migration: the full block again (its
// inserts are ON CONFLICT DO NOTHING, so only new rows land) plus explicit
// UPDATEs for rows whose values changed and DELETE tombstones for rows that
// left the pack. Every builtin pack is scoped by a predicate (user_id IS NULL
// AND source = ...), so a tombstone can never touch a user's row.

const fs = require('fs');
const path = require('path');

const MIGRATIONS_DIR = path.join(__dirname, '..', '..', 'migrations');

function migrationFiles(dir = MIGRATIONS_DIR) {
  return fs.readdirSync(dir).filter((name) => name.endsWith('.sql')).sort();
}

// The newest migration containing `start`, and the block from `start` to
// `end` (inclusive), or to end of file when `end` is null.
function latestBlock(start, end = null, dir = MIGRATIONS_DIR) {
  for (const file of migrationFiles(dir).reverse()) {
    const text = fs.readFileSync(path.join(dir, file), 'utf8');
    const at = text.lastIndexOf(start);
    if (at < 0) continue;
    if (end === null) return { file, block: text.slice(at) };
    const stop = text.indexOf(end, at);
    if (stop < 0) throw new Error(`${file}: seed block has no end marker`);
    return { file, block: text.slice(at, stop + end.length) };
  }
  return null;
}

function nextMigrationPath(stem, dir = MIGRATIONS_DIR) {
  const highest = migrationFiles(dir)
    .map((name) => Number.parseInt(name.slice(0, 3), 10))
    .filter(Number.isFinite)
    .reduce((max, value) => Math.max(max, value), 0);
  return path.join(dir, `${String(highest + 1).padStart(3, '0')}_${stem}.sql`);
}

// One SQL VALUES tuple, split into literal tokens kept verbatim (so they can
// be re-emitted exactly): quoted strings with '' escapes and an optional
// ::cast, numbers, NULL, TRUE/FALSE.
function parseTuple(line) {
  const text = line.trim().replace(/[,;]$/, '');
  if (!text.startsWith('(') || !text.endsWith(')')) return null;
  const body = text.slice(1, -1);
  const tokens = [];
  let i = 0;
  while (i < body.length) {
    while (body[i] === ' ' || body[i] === ',') i += 1;
    if (i >= body.length) break;
    let token = '';
    if (body[i] === "'") {
      let j = i + 1;
      for (;;) {
        if (j >= body.length) throw new Error(`unterminated literal in ${line}`);
        if (body[j] === "'" && body[j + 1] === "'") { j += 2; continue; }
        if (body[j] === "'") break;
        j += 1;
      }
      token = body.slice(i, j + 1);
      i = j + 1;
      const cast = body.slice(i).match(/^::[a-z_]+/i);
      if (cast) { token += cast[0]; i += cast[0].length; }
    } else {
      const match = body.slice(i).match(/^[^,]+/);
      token = match[0].trim();
      i += match[0].length;
    }
    tokens.push(token);
  }
  return tokens;
}

// Every INSERT in a block, merged per table: { table, columns, rows: tokens[][] }.
// A large pack is chunked into several INSERTs of the same table and columns.
function insertSections(block) {
  const byTable = new Map();
  const pattern = /INSERT INTO\s+([a-z_]+)\s*\(([^)]*)\)\s*VALUES\s*\n([\s\S]*?)\nON CONFLICT/gi;
  for (const match of block.matchAll(pattern)) {
    const columns = match[2].split(',').map((column) => column.trim()).filter(Boolean);
    const rows = match[3].split('\n').map(parseTuple).filter(Boolean);
    for (const row of rows) {
      if (row.length !== columns.length) {
        throw new Error(`${match[1]}: a row has ${row.length} values for ${columns.length} columns`);
      }
    }
    const existing = byTable.get(match[1]);
    if (existing && existing.columns.join(',') !== columns.join(',')) {
      throw new Error(`${match[1]}: INSERT chunks disagree on columns`);
    }
    if (existing) existing.rows.push(...rows);
    else byTable.set(match[1], { table: match[1], columns, rows });
  }
  return [...byTable.values()];
}

// specs: { [table]: { key: [column...], scope: 'SQL predicate' } }.
// Returns the UPDATE/DELETE statements that turn `previous` into `desired`
// (the full INSERT block itself supplies the additions).
function deltaStatements(previousBlock, desiredBlock, specs) {
  const statements = [];
  const summary = { added: 0, changed: 0, removed: 0 };
  const previous = new Map(insertSections(previousBlock || '').map((s) => [s.table, s]));
  for (const section of insertSections(desiredBlock)) {
    const spec = specs[section.table];
    if (!spec) throw new Error(`no delta spec for ${section.table}`);
    const index = (s) => new Map(s.rows.map((row) => [
      spec.key.map((column) => row[s.columns.indexOf(column)]).join('\u0000'),
      row,
    ]));
    const before = previous.has(section.table) ? index(previous.get(section.table)) : new Map();
    const after = index(section);
    const prevColumns = previous.get(section.table)?.columns || section.columns;
    for (const [key, row] of after) {
      const old = before.get(key);
      if (!old) { summary.added += 1; continue; }
      const sets = section.columns
        .filter((column) => !spec.key.includes(column))
        .filter((column) => old[prevColumns.indexOf(column)] !== row[section.columns.indexOf(column)])
        .map((column) => `${column} = ${row[section.columns.indexOf(column)]}`);
      if (!sets.length) continue;
      summary.changed += 1;
      const where = spec.key.map((column) => `${column} = ${row[section.columns.indexOf(column)]}`);
      statements.push(`UPDATE ${section.table} SET ${sets.join(', ')}\n WHERE ${spec.scope} AND ${where.join(' AND ')};`);
    }
    const removed = [...before.keys()].filter((key) => !after.has(key));
    if (removed.length) {
      summary.removed += removed.length;
      const tuples = removed.map((key) => {
        const row = before.get(key);
        return `(${spec.key.map((column) => row[prevColumns.indexOf(column)]).join(', ')})`;
      });
      statements.push(
        `DELETE FROM ${section.table}\n WHERE ${spec.scope}\n   AND (${spec.key.join(', ')}) IN (VALUES\n  ${tuples.join(',\n  ')}\n);`
      );
    }
  }
  return { statements, summary };
}

// Compares the desired block with the newest applied one and, if they differ,
// writes the next migration. Returns { written: path|null, summary }.
function writeSeedDelta({ start, end = null, desiredBlock, stem, header, specs, dir = MIGRATIONS_DIR }) {
  const latest = latestBlock(start, end, dir);
  if (latest && latest.block.trim() === desiredBlock.trim()) {
    return { written: null, summary: { added: 0, changed: 0, removed: 0 }, latest: latest.file };
  }
  const { statements, summary } = deltaStatements(latest?.block, desiredBlock, specs);
  const target = nextMigrationPath(stem, dir);
  const body = [
    header.trim(),
    `-- Delta over ${latest ? latest.file : '(no earlier block)'}: ${summary.added} added, ${summary.changed} changed, ${summary.removed} removed.`,
    '',
    desiredBlock.trim(),
    '',
    ...statements.flatMap((statement) => [statement, '']),
  ].join('\n');
  fs.writeFileSync(target, `${body.trimEnd()}\n`);
  return { written: target, summary, latest: latest?.file || null };
}

module.exports = {
  MIGRATIONS_DIR, migrationFiles, latestBlock, nextMigrationPath, parseTuple, insertSections,
  deltaStatements, writeSeedDelta,
};

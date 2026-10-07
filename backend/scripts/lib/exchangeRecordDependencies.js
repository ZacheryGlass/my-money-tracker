'use strict';

// Every row that points at an exchange record, discovered from the catalog
// rather than hardcoded: any table that can reference an exchange record is a
// reason not to delete it, including tables added after a resolver was written
// (the overlap-review table was missed by two hand-written lists). Every such
// foreign key is ON DELETE CASCADE, so a missed reference would be silently
// destroyed, not merely orphaned. Shared by the duplicate resolvers.

function quoteIdent(name) {
  return `"${String(name).replace(/"/g, '""')}"`;
}

async function referencingColumns(client) {
  const result = await client.query(
    `SELECT c.conrelid::regclass::text AS table_name,
            a.attname AS column_name,
            array_length(c.conkey, 1) AS width
     FROM pg_constraint c
     JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1]
     WHERE c.contype = 'f' AND c.confrelid = 'exchange_records'::regclass
     ORDER BY 1, 2`
  );
  if (!result.rows.length) {
    throw new Error('No foreign keys reference exchange_records; refusing to trust an empty dependency check');
  }
  for (const row of result.rows) {
    if (Number(row.width) !== 1) {
      throw new Error(`${row.table_name} references exchange_records through a multi-column key; extend the dependency check first`);
    }
  }
  return result.rows;
}

// Map of record id (string) -> { 'table.column': count } for every reference.
async function dependencyCounts(client, references, recordIds) {
  if (!recordIds.length) return new Map();
  const counts = references.map((reference, index) => (
    `(SELECT COUNT(*) FROM ${reference.table_name} WHERE ${quoteIdent(reference.column_name)} = r.id) AS d${index}`
  ));
  const result = await client.query(
    `SELECT r.id::text AS id, ${counts.join(', ')}
     FROM unnest($1::bigint[]) AS r(id)`,
    [recordIds]
  );
  return new Map(result.rows.map((row) => [
    String(row.id),
    Object.fromEntries(references.map((reference, index) => [
      `${reference.table_name}.${reference.column_name}`,
      Number(row[`d${index}`]) || 0,
    ])),
  ]));
}

// The counts for one record, discovering the references first.
async function recordDependencies(client, recordId) {
  const references = await referencingColumns(client);
  return (await dependencyCounts(client, references, [String(recordId)])).get(String(recordId)) || {};
}

function dependencyTotal(counts) {
  return Object.values(counts || {}).reduce((total, value) => total + (Number(value) || 0), 0);
}

module.exports = {
  quoteIdent, referencingColumns, dependencyCounts, recordDependencies, dependencyTotal,
};

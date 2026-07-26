'use strict';

// Minimal RFC 4180 reader for whole-file-in-memory CSV text.
//
// The streaming csv-parser used by the holdings importer maps rows against a
// single header line, which exchange exports break: Coinbase's retail export
// puts three preamble lines above its header and can repeat that header
// mid-file, so the importers need the raw grid to decide what a line even is.
function parseCsv(text) {
  const rows = [];
  if (typeof text !== 'string' || text.length === 0) return rows;

  // A BOM survives Excel round-trips and would otherwise glue itself to the
  // first header cell, making every header match fail.
  const input = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;

  let row = [];
  let field = '';
  let quoted = false;
  let sawAnyChar = false;

  const endField = () => { row.push(field); field = ''; };
  const endRow = () => { endField(); rows.push(row); row = []; sawAnyChar = false; };

  for (let i = 0; i < input.length; i += 1) {
    const char = input[i];

    if (quoted) {
      if (char === '"') {
        if (input[i + 1] === '"') { field += '"'; i += 1; } else { quoted = false; }
      } else {
        field += char;
      }
      continue;
    }

    if (char === '"' && field === '') {
      quoted = true;
      sawAnyChar = true;
    } else if (char === ',') {
      endField();
      sawAnyChar = true;
    } else if (char === '\n') {
      endRow();
    } else if (char === '\r') {
      // CRLF: the \n closes the row. A lone \r (classic Mac) closes it here.
      if (input[i + 1] === '\n') { endRow(); i += 1; } else { endRow(); }
    } else {
      field += char;
      sawAnyChar = true;
    }
  }

  // A trailing newline leaves an empty pending row that is not a real record.
  if (field !== '' || row.length > 0 || sawAnyChar) endRow();

  return rows;
}

// A row is blank when every cell is empty -- Coinbase's preamble opens with one.
function isBlankRow(row) {
  return !row || row.every((cell) => String(cell ?? '').trim() === '');
}

module.exports = { parseCsv, isBlankRow };

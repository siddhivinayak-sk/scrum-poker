// RFC 4180 CSV serialization and a reference parser.
//
// This module is intentionally dependency free: it is loaded by the server Jest
// suite through `roots: ['<rootDir>/../shared']` and by the client Vitest suite
// through the `@shared/*` path alias, so it must not import anything.
//
// The existing `RetroSession.parseCSV` import pipeline is unrelated to this
// module and is left untouched.

/** RFC 4180 line terminator used between records. */
const ROW_TERMINATOR = '\r\n';

/**
 * Quotes a single field value for RFC 4180 output.
 *
 * A value is wrapped in double quotes when it contains a comma, a double quote
 * character, a carriage return or a line feed. Embedded double quote characters
 * are escaped by doubling them. Values without those characters are returned
 * unchanged.
 */
export function quoteCsvField(value: string): string {
  const needsQuoting =
    value.indexOf(',') !== -1 ||
    value.indexOf('"') !== -1 ||
    value.indexOf('\r') !== -1 ||
    value.indexOf('\n') !== -1;

  if (!needsQuoting) {
    return value;
  }

  return `"${value.replace(/"/g, '""')}"`;
}

/**
 * Joins already-quoted fields into one CSV record.
 *
 * Callers are responsible for passing each field through {@link quoteCsvField}
 * first; this function performs no quoting of its own.
 */
export function serializeCsvRow(fields: string[]): string {
  return fields.join(',');
}

/**
 * Joins already-quoted records into a CSV document separated by CRLF.
 *
 * As with {@link serializeCsvRow}, every field is expected to have been passed
 * through {@link quoteCsvField}. No terminator is emitted after the final
 * record, which RFC 4180 permits.
 */
export function serializeCsvDocument(rows: string[][]): string {
  return rows.map(serializeCsvRow).join(ROW_TERMINATOR);
}

/**
 * Parses a CSV document into records of raw (unquoted) field values.
 *
 * This is a reference RFC 4180 parser: it is the inverse of
 * {@link serializeCsvDocument} over documents whose fields were produced by
 * {@link quoteCsvField}. CR, LF and CRLF are all accepted as record
 * terminators, and a single terminator at the end of the document does not
 * produce an extra empty record. An empty document parses as one record
 * holding one empty field, which is what makes the quoting round trip exact for
 * a record consisting of a single empty field.
 */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  let atFieldStart = true;
  let index = 0;

  while (index < text.length) {
    const char = text[index];

    if (inQuotes) {
      if (char === '"') {
        if (text[index + 1] === '"') {
          // Escaped double quote inside a quoted field.
          field += '"';
          index += 2;
          continue;
        }
        inQuotes = false;
        index += 1;
        continue;
      }
      field += char;
      index += 1;
      continue;
    }

    if (char === '"' && atFieldStart) {
      inQuotes = true;
      atFieldStart = false;
      index += 1;
      continue;
    }

    if (char === ',') {
      row.push(field);
      field = '';
      atFieldStart = true;
      index += 1;
      continue;
    }

    if (char === '\r' || char === '\n') {
      row.push(field);
      field = '';
      rows.push(row);
      row = [];
      atFieldStart = true;
      index += char === '\r' && text[index + 1] === '\n' ? 2 : 1;
      continue;
    }

    field += char;
    atFieldStart = false;
    index += 1;
  }

  row.push(field);
  rows.push(row);

  // A terminator closing the final record leaves a phantom empty record behind.
  const lastRow = rows[rows.length - 1];
  if (rows.length > 1 && lastRow.length === 1 && lastRow[0] === '') {
    rows.pop();
  }

  return rows;
}

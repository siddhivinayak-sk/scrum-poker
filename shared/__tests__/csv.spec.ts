import { parseCsv, quoteCsvField, serializeCsvDocument, serializeCsvRow } from '../csv';

/**
 * Example unit tests for the pure RFC 4180 CSV module.
 *
 * Validates: Requirements 1.16, 14.1, 14.2
 *
 * `csv.property.spec.ts` already proves the writer/parser round trip over
 * generated field lists, so these examples deliberately pin the things a
 * round-trip invariant cannot see: the exact emitted text of each quoting
 * decision, the CRLF record terminator of `serializeCsvDocument` (a function
 * the property test does not touch), and the two boundary values called out in
 * the design — the empty field and the field that is only a quote character.
 */

/** RFC 4180 record terminator, spelled out so the assertions read literally. */
const CRLF = '\r\n';

describe('quoteCsvField', () => {
  describe('R1.16: values without structural characters pass through unchanged', () => {
    it('R1.16: returns a plain alphanumeric value unchanged', () => {
      expect(quoteCsvField('Checkout flow')).toBe('Checkout flow');
    });

    it('R1.16: returns an empty field unchanged, emitting no quotes', () => {
      expect(quoteCsvField('')).toBe('');
    });

    it('R1.16: leaves semicolons, tabs and unicode unquoted', () => {
      expect(quoteCsvField('3=2; 5=1\té😀')).toBe('3=2; 5=1\té😀');
    });
  });

  describe('R1.16: values containing a comma, a quote or a line break are quoted', () => {
    it('R1.16: wraps a value containing a comma in double quotes', () => {
      expect(quoteCsvField('Smith, John')).toBe('"Smith, John"');
    });

    it('R1.16: wraps a value containing a line feed in double quotes', () => {
      expect(quoteCsvField('line one\nline two')).toBe('"line one\nline two"');
    });

    it('R1.16: wraps a value containing a carriage return in double quotes', () => {
      expect(quoteCsvField('line one\rline two')).toBe('"line one\rline two"');
    });

    it('R1.16: wraps a value containing a CRLF pair in double quotes', () => {
      expect(quoteCsvField(`line one${CRLF}line two`)).toBe(`"line one${CRLF}line two"`);
    });

    it('R1.16: doubles an embedded double quote character and wraps the value', () => {
      expect(quoteCsvField('say "hi"')).toBe('"say ""hi"""');
    });

    it('R1.16: quotes a field that is only a quote character as four characters', () => {
      expect(quoteCsvField('"')).toBe('""""');
    });

    it('R1.16: doubles both characters of a field that is two quote characters', () => {
      expect(quoteCsvField('""')).toBe('""""""');
    });
  });
});

describe('serializeCsvRow', () => {
  it('R1.16: joins already-quoted fields with commas and quotes nothing itself', () => {
    const fields = ['Checkout flow', 'Smith, John', '5'].map(quoteCsvField);
    expect(serializeCsvRow(fields)).toBe('Checkout flow,"Smith, John",5');
  });

  it('R1.16: renders a row of empty fields as bare commas', () => {
    expect(serializeCsvRow(['', '', ''].map(quoteCsvField))).toBe(',,');
  });

  it('R1.16: renders a single empty field as the empty string', () => {
    expect(serializeCsvRow([quoteCsvField('')])).toBe('');
  });
});

describe('serializeCsvDocument', () => {
  it('R1.16: separates records with CRLF and emits no trailing terminator', () => {
    const rows = [
      ['Story', 'Name', 'Card'],
      ['Checkout flow', 'Ada', '5'],
      ['Checkout flow', 'Linus', 'No Vote'],
    ].map((row) => row.map(quoteCsvField));

    expect(serializeCsvDocument(rows)).toBe(
      `Story,Name,Card${CRLF}Checkout flow,Ada,5${CRLF}Checkout flow,Linus,No Vote`
    );
  });

  it('R1.16: keeps a quoted line break inside its field rather than starting a record', () => {
    const rows = [['Story'], ['line one\nline two'], ['next']].map((row) =>
      row.map(quoteCsvField)
    );
    const document = serializeCsvDocument(rows);

    expect(document).toBe(`Story${CRLF}"line one\nline two"${CRLF}next`);
    // Three records, not four: the embedded line feed is quoted, so the only
    // record boundaries in the document are the two CRLF pairs.
    expect(parseCsv(document)).toEqual([['Story'], ['line one\nline two'], ['next']]);
  });

  it('R1.16: emits a single record without any terminator', () => {
    expect(serializeCsvDocument([['a', 'b']])).toBe('a,b');
  });
});

describe('parseCsv', () => {
  it('R1.16: splits records on CRLF and fields on commas', () => {
    expect(parseCsv(`a,b${CRLF}c,d`)).toEqual([
      ['a', 'b'],
      ['c', 'd'],
    ]);
  });

  it('R1.16: accepts a bare LF and a bare CR as record terminators', () => {
    expect(parseCsv('a\nb\rc')).toEqual([['a'], ['b'], ['c']]);
  });

  it('R1.16: ignores a single terminator closing the final record', () => {
    expect(parseCsv(`a,b${CRLF}`)).toEqual([['a', 'b']]);
  });

  it('R1.16: reads an empty document as one record holding one empty field', () => {
    expect(parseCsv('')).toEqual([['']]);
  });

  it('R1.16: recovers empty fields between commas', () => {
    expect(parseCsv(',,')).toEqual([['', '', '']]);
  });

  it('R1.16: recovers a field that is only a quote character', () => {
    expect(parseCsv('""""')).toEqual([['"']]);
  });

  it('R1.16: recovers a quoted field containing a comma', () => {
    expect(parseCsv('"Smith, John",5')).toEqual([['Smith, John', '5']]);
  });

  it('R1.16: recovers a quoted field containing a CRLF pair', () => {
    expect(parseCsv(`"line one${CRLF}line two",5`)).toEqual([[`line one${CRLF}line two`, '5']]);
  });

  it('R1.16: recovers a quoted empty field as an empty string', () => {
    expect(parseCsv('"",a')).toEqual([['', 'a']]);
  });

  it('R1.16: treats a quote character inside an unquoted field as literal text', () => {
    expect(parseCsv('5" riser,x')).toEqual([['5" riser', 'x']]);
  });
});

describe('document round trip examples', () => {
  it('R1.16: a document whose fields hold every structural character parses back unchanged', () => {
    const rows = [
      ['Story', 'Average', 'Distribution'],
      ['Has,comma', '-', '3=2; 5=1'],
      ['Has"quote', '3.5', ''],
      [`Has${CRLF}break`, '8.0', '"'],
      ['', '', ''],
    ];

    const document = serializeCsvDocument(rows.map((row) => row.map(quoteCsvField)));

    expect(parseCsv(document)).toEqual(rows);
  });
});

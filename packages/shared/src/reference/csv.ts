/**
 * Minimal RFC 4180 CSV parser used for reference-data imports. Handles quoted
 * fields (commas, newlines and doubled quotes inside quotes), CRLF/LF line
 * endings and a leading UTF-8 byte-order mark. No dependencies so the same code
 * runs in the API, the seed and the browser (client-side preview).
 */

export interface CsvParseResult {
  /** Header cells, trimmed and lower-cased. */
  header: string[];
  /** Data records; `line` is the 1-based physical line where the record starts. */
  records: Array<{ line: number; cells: string[] }>;
  /** Structural problems (e.g. an unterminated quote). */
  errors: Array<{ line: number; message: string }>;
}

export function parseCsv(input: string): CsvParseResult {
  const text = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
  const rows: Array<{ line: number; cells: string[] }> = [];
  const errors: CsvParseResult['errors'] = [];

  let cells: string[] = [];
  let field = '';
  let inQuotes = false;
  let line = 1;
  let recordLine = 1;
  let fieldStarted = false;

  const endField = () => {
    cells.push(field);
    field = '';
    fieldStarted = false;
  };
  const endRecord = () => {
    endField();
    // Skip completely blank lines.
    if (!(cells.length === 1 && cells[0]!.trim() === '')) rows.push({ line: recordLine, cells });
    cells = [];
  };

  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        if (ch === '\n') line++;
        field += ch;
      }
      continue;
    }
    if (ch === '"' && !fieldStarted) {
      inQuotes = true;
      fieldStarted = true;
    } else if (ch === ',') {
      endField();
    } else if (ch === '\r') {
      // Ignore; the following \n ends the record. A lone \r also ends it.
      if (text[i + 1] !== '\n') {
        endRecord();
        line++;
        recordLine = line;
      }
    } else if (ch === '\n') {
      endRecord();
      line++;
      recordLine = line;
    } else {
      field += ch;
      fieldStarted = true;
    }
  }
  if (inQuotes) {
    errors.push({ line: recordLine, message: 'Unterminated quoted field' });
  }
  if (field !== '' || cells.length > 0) endRecord();

  const [head, ...records] = rows;
  return {
    header: head ? head.cells.map((h) => h.trim().toLowerCase()) : [],
    records,
    errors,
  };
}

/** Quote a value for CSV output when needed. */
export function csvEscape(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return '';
  const s = String(value);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(header: readonly string[], rows: ReadonlyArray<ReadonlyArray<string | number | null | undefined>>): string {
  return [header.join(','), ...rows.map((r) => r.map(csvEscape).join(','))].join('\n') + '\n';
}

import type { Cell, ExportDocument } from './document';

/** RFC 4180 cell with spreadsheet formula-injection protection. */
export function csvCell(value: Cell): string {
  if (value === null) return '';
  if (typeof value === 'number') return String(value);
  let s = value;
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  if (/[",\r\n]/.test(s)) s = `"${s.replace(/"/g, '""')}"`;
  return s;
}

/** Render the document as CSV: each section is introduced by a `# name` row. */
export function renderCsv(doc: ExportDocument): Buffer {
  const lines: string[] = [csvCell(doc.title), ''];
  for (const section of doc.sections) {
    lines.push(csvCell(`# ${section.name}`));
    if (section.kind === 'text') {
      for (const l of section.lines) lines.push(csvCell(l));
    } else {
      lines.push(section.header.map(csvCell).join(','));
      for (const row of section.rows) lines.push(row.map(csvCell).join(','));
    }
    lines.push('');
  }
  // UTF-8 BOM so spreadsheet tools detect the encoding of candidate names.
  return Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(lines.join('\r\n'), 'utf8')]);
}

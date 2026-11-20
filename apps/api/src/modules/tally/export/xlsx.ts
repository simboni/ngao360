import type { Cell, ExportDocument, Section } from './document';
import { createZip } from './zip';

function xmlEscape(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    // Strip characters not allowed in XML 1.0.
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');
}

function colName(index: number): string {
  let n = index + 1;
  let s = '';
  while (n > 0) {
    const m = (n - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

function cellXml(value: Cell, ref: string, bold = false): string {
  const style = bold ? ' s="1"' : '';
  if (value === null) return `<c r="${ref}"${style}/>`;
  if (typeof value === 'number') return `<c r="${ref}"${style}><v>${value}</v></c>`;
  return `<c r="${ref}" t="inlineStr"${style}><is><t xml:space="preserve">${xmlEscape(value)}</t></is></c>`;
}

function sheetXml(section: Section): string {
  const rows: string[] = [];
  const addRow = (cells: Cell[], bold = false) => {
    const r = rows.length + 1;
    rows.push(`<row r="${r}">${cells.map((c, i) => cellXml(c, `${colName(i)}${r}`, bold)).join('')}</row>`);
  };
  if (section.kind === 'text') {
    for (const l of section.lines) addRow([l]);
  } else {
    addRow(section.header, true);
    for (const r of section.rows) addRow(r);
  }
  const width = section.kind === 'text' ? 140 : 24;
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
    `<cols><col min="1" max="${section.kind === 'text' ? 1 : Math.max(1, section.header.length)}" width="${width}" customWidth="1"/></cols>` +
    `<sheetData>${rows.join('')}</sheetData></worksheet>`
  );
}

function sheetName(name: string, used: Set<string>): string {
  let base = name.replace(/[[\]:*?/\\]/g, ' ').trim().slice(0, 31) || 'Sheet';
  let candidate = base;
  let i = 2;
  while (used.has(candidate.toLowerCase())) {
    const suffix = ` ${i++}`;
    candidate = base.slice(0, 31 - suffix.length) + suffix;
  }
  used.add(candidate.toLowerCase());
  base = candidate;
  return base;
}

/** Render the document as an XLSX workbook: one worksheet per section. */
export function renderXlsx(doc: ExportDocument): Buffer {
  const used = new Set<string>();
  const sheets = doc.sections.map((s, i) => ({ id: i + 1, name: sheetName(s.name, used), xml: sheetXml(s) }));
  const contentTypes =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
    '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
    '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>' +
    sheets
      .map(
        (s) =>
          `<Override PartName="/xl/worksheets/sheet${s.id}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`,
      )
      .join('') +
    '</Types>';
  const rootRels =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
    '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>' +
    '</Relationships>';
  const core =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/">' +
    `<dc:title>${xmlEscape(doc.title)}</dc:title><dc:creator>NGAO360</dc:creator>` +
    '</cp:coreProperties>';
  const workbook =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
    `<sheets>${sheets.map((s) => `<sheet name="${xmlEscape(s.name)}" sheetId="${s.id}" r:id="rId${s.id}"/>`).join('')}</sheets>` +
    '</workbook>';
  const workbookRels =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    sheets
      .map(
        (s) =>
          `<Relationship Id="rId${s.id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${s.id}.xml"/>`,
      )
      .join('') +
    `<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>` +
    '</Relationships>';
  const styles =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
    '<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>' +
    '<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>' +
    '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>' +
    '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
    '<cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs>' +
    '</styleSheet>';

  return createZip([
    { name: '[Content_Types].xml', data: Buffer.from(contentTypes, 'utf8') },
    { name: '_rels/.rels', data: Buffer.from(rootRels, 'utf8') },
    { name: 'docProps/core.xml', data: Buffer.from(core, 'utf8') },
    { name: 'xl/workbook.xml', data: Buffer.from(workbook, 'utf8') },
    { name: 'xl/_rels/workbook.xml.rels', data: Buffer.from(workbookRels, 'utf8') },
    { name: 'xl/styles.xml', data: Buffer.from(styles, 'utf8') },
    ...sheets.map((s) => ({ name: `xl/worksheets/sheet${s.id}.xml`, data: Buffer.from(s.xml, 'utf8') })),
  ]);
}

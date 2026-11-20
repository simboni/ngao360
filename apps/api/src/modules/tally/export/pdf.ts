import type { Cell, ExportDocument } from './document';

/**
 * Minimal PDF 1.4 writer (no dependencies): A4 pages, Courier for tables and
 * Helvetica for headings, plain WinAnsi text. Non-Latin-1 characters are
 * transliterated where common (dashes, quotes) and otherwise replaced with "?".
 * Every page carries the non-official parallel-tally footer.
 */
const PAGE_W = 595;
const PAGE_H = 842;
const MARGIN = 40;
const FONT_SIZE = 8.5;
const LINE_H = 11;
const CHAR_W = FONT_SIZE * 0.6; // Courier advance width
const MAX_CHARS = Math.floor((PAGE_W - 2 * MARGIN) / CHAR_W);

function toWinAnsi(s: string): string {
  return s
    .replace(/[–—]/g, '-')
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/…/g, '...')
    .replace(/[^\x20-\x7E\xA0-\xFF]/g, '?');
}

function pdfString(s: string): string {
  return `(${toWinAnsi(s).replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)')})`;
}

export function wrap(text: string, width = MAX_CHARS): string[] {
  const out: string[] = [];
  for (const para of text.split('\n')) {
    if (para.length <= width) {
      out.push(para);
      continue;
    }
    let line = '';
    for (const word of para.split(' ')) {
      if (word.length > width) {
        if (line) out.push(line);
        for (let i = 0; i < word.length; i += width) out.push(word.slice(i, i + width));
        line = '';
        continue;
      }
      if ((line ? line.length + 1 : 0) + word.length > width) {
        out.push(line);
        line = word;
      } else line = line ? `${line} ${word}` : word;
    }
    if (line) out.push(line);
  }
  return out;
}

function cellText(c: Cell): string {
  return c === null ? '-' : String(c);
}

function tableLines(header: string[], rows: Cell[][]): string[] {
  const all = [header, ...rows.map((r) => r.map(cellText))];
  const cols = header.length;
  const natural = Array.from({ length: cols }, (_, i) => Math.max(...all.map((r) => (r[i] ?? '').length), 1));
  const budget = MAX_CHARS - (cols - 1) * 2;
  const widths = natural.map((w) => Math.min(w, Math.max(6, Math.floor(budget / cols))));
  // Give spare room back to the widest columns.
  let spare = budget - widths.reduce((a, b) => a + b, 0);
  for (let i = 0; i < cols && spare > 0; i++) {
    const want = natural[i]! - widths[i]!;
    const add = Math.min(want, spare);
    widths[i]! += add;
    spare -= add;
  }
  const fmtRow = (r: string[]) =>
    r
      .map((c, i) => {
        const w = widths[i]!;
        const t = c.length > w ? `${c.slice(0, Math.max(0, w - 1))}~` : c;
        return t.padEnd(w);
      })
      .join('  ')
      .trimEnd();
  const lines = [fmtRow(header), widths.map((w) => '-'.repeat(w)).join('  ')];
  for (const r of all.slice(1)) lines.push(fmtRow(r));
  return lines;
}

interface Line {
  text: string;
  heading?: boolean;
}

export function renderPdf(doc: ExportDocument, footer: string): Buffer {
  const lines: Line[] = [{ text: doc.title, heading: true }, { text: '' }];
  for (const s of doc.sections) {
    lines.push({ text: s.name, heading: true });
    if (s.kind === 'text') for (const l of s.lines) for (const w of wrap(l)) lines.push({ text: w });
    else for (const l of tableLines(s.header, s.rows)) lines.push({ text: l });
    lines.push({ text: '' });
  }

  const usable = Math.floor((PAGE_H - 2 * MARGIN - 3 * LINE_H) / LINE_H);
  const pages: Line[][] = [];
  for (let i = 0; i < lines.length; i += usable) pages.push(lines.slice(i, i + usable));
  if (pages.length === 0) pages.push([]);
  const footerLines = wrap(footer, Math.floor((PAGE_W - 2 * MARGIN) / (7 * 0.6)));

  const objects: string[] = [];
  const add = (body: string) => {
    objects.push(body);
    return objects.length;
  };
  const catalogId = add(''); // placeholder 1
  const pagesId = add(''); // placeholder 2
  const courier = add('<< /Type /Font /Subtype /Type1 /BaseFont /Courier /Encoding /WinAnsiEncoding >>');
  const helvBold = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');
  const pageIds: number[] = [];

  pages.forEach((pageLines, pi) => {
    const ops: string[] = ['BT'];
    let y = PAGE_H - MARGIN;
    for (const l of pageLines) {
      ops.push(l.heading ? `/F2 10 Tf` : `/F1 ${FONT_SIZE} Tf`);
      ops.push(`1 0 0 1 ${MARGIN} ${y} Tm ${pdfString(l.text)} Tj`);
      y -= LINE_H;
    }
    let fy = MARGIN - 4 + (footerLines.length - 1) * 8;
    ops.push('/F1 7 Tf');
    for (const fl of footerLines) {
      ops.push(`1 0 0 1 ${MARGIN} ${fy} Tm ${pdfString(fl)} Tj`);
      fy -= 8;
    }
    ops.push(`1 0 0 1 ${PAGE_W - MARGIN - 60} ${PAGE_H - MARGIN + 14} Tm ${pdfString(`Page ${pi + 1} of ${pages.length}`)} Tj`);
    ops.push('ET');
    const stream = ops.join('\n');
    const contentId = add(`<< /Length ${Buffer.byteLength(stream, 'latin1')} >>\nstream\n${stream}\nendstream`);
    pageIds.push(
      add(
        `<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 ${PAGE_W} ${PAGE_H}] ` +
          `/Resources << /Font << /F1 ${courier} 0 R /F2 ${helvBold} 0 R >> >> /Contents ${contentId} 0 R >>`,
      ),
    );
  });
  objects[catalogId - 1] = `<< /Type /Catalog /Pages ${pagesId} 0 R >>`;
  objects[pagesId - 1] = `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pageIds.length} >>`;
  const infoId = add(`<< /Title ${pdfString(doc.title)} /Producer (NGAO360) >>`);

  let out = '%PDF-1.4\n%\xE2\xE3\xCF\xD3\n';
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(Buffer.byteLength(out, 'latin1'));
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = Buffer.byteLength(out, 'latin1');
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const o of offsets) out += `${String(o).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root ${catalogId} 0 R /Info ${infoId} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

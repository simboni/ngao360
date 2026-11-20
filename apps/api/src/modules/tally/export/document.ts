/**
 * Format-neutral export document. The export service builds one of these from
 * an immutable snapshot; CSV, XLSX and PDF writers render it. Keeping one model
 * guarantees every format carries the same disclaimer, methodology,
 * denominator, snapshot reference and audit manifest.
 */
export type Cell = string | number | null;

export interface TextSection {
  kind: 'text';
  name: string;
  lines: string[];
}

export interface TableSection {
  kind: 'table';
  name: string;
  header: string[];
  rows: Cell[][];
}

export type Section = TextSection | TableSection;

export interface ExportDocument {
  title: string;
  sections: Section[];
}

/** All human-readable text in the document (for the forbidden-language guard). */
export function documentText(doc: ExportDocument): string {
  const parts: string[] = [doc.title];
  for (const s of doc.sections) {
    parts.push(s.name);
    if (s.kind === 'text') parts.push(...s.lines);
    else {
      parts.push(...s.header);
      for (const r of s.rows) for (const c of r) if (typeof c === 'string') parts.push(c);
    }
  }
  return parts.join('\n');
}

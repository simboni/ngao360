import { inflateRawSync } from 'node:zlib';
import {
  exportLabelLines,
  findForbiddenTallyLanguage,
  HISTORICAL_DEMO_LABEL,
  HISTORICAL_DEMO_NOTICE,
  PARALLEL_TALLY_BANNER,
  PARALLEL_TALLY_DISCLAIMER,
} from '@ngao360/shared';
import { exportFooter, renderExport } from '../services/exports.service';
import { csvCell, renderCsv } from './csv';
import { documentText } from './document';
import { buildExportDocument, type ExportContentInput } from './export-content';
import { renderPdf, wrap } from './pdf';
import { renderXlsx } from './xlsx';

const input: ExportContentInput = {
  snapshot: {
    id: '7d0f6a1e-0000-4000-8000-000000000001',
    reference: 'SNP-2027-000001',
    contentHash: 'a'.repeat(64),
    calculationVersion: 'tally-agg-v1',
    createdAt: '2027-08-09T18:00:00.000Z',
    createdByName: 'Synthetic Supervisor',
    releasedAt: null,
    geographyLabel: 'Whole contest area',
    registryVersionLabel: 'v1 (synthetic)',
    note: null,
  },
  cycleName: 'Synthetic 2027 rehearsal',
  provenanceLabel: 'Synthetic demonstration data',
  contestName: 'Synthetic County Governor',
  officeLabel: 'County Governor',
  stationFormNumber: '37A',
  coverage: { expectedStations: 16, received: 5, transcribed: 4, awaitingReview: 1, verified: 2, flagged: 1, excluded: 0, missing: 11, verifiedPercent: 12.5 },
  totals: {
    totalVerifiedValidVotes: 250,
    rejectedBallots: 3,
    candidates: [
      { ballotOrder: 1, candidateNameAsPublished: 'Synthetic Candidate A', partyLabel: 'Party One', verifiedVotes: 110, shareOfVerifiedValidVotes: 44 },
      { ballotOrder: 2, candidateNameAsPublished: '=HYPERLINK("x")', partyLabel: null, verifiedVotes: 140, shareOfVerifiedValidVotes: 56 },
    ],
  },
  stations: [
    { code: 'S001', name: 'Synthetic Station, "One"', coverageStatus: 'VERIFIED', submissionReference: 'SUB-2027-000001', totalValidVotes: 150, candidateVotes: { a: 100, b: 50 } },
    { code: 'S002', name: 'Synthetic Station Two', coverageStatus: 'MISSING', submissionReference: null, totalValidVotes: null, candidateVotes: null },
  ],
  candidateOrder: [
    { id: 'a', label: '1. Synthetic Candidate A' },
    { id: 'b', label: '2. Candidate B' },
  ],
  manifest: [
    { submissionReference: 'SUB-2027-000001', stationCode: 'S001', fileSha256: 'b'.repeat(64), submittedBy: 'Clerk', verifiedBy: 'Verifier', verifiedAt: '2027-08-09T17:00:00.000Z' },
  ],
  generatedAt: '2027-08-09T18:05:00.000Z',
  generatedByName: 'Synthetic Supervisor',
  format: 'CSV',
};

function unzip(buf: Buffer): Map<string, string> {
  const out = new Map<string, string>();
  let off = 0;
  while (buf.readUInt32LE(off) === 0x04034b50) {
    const compSize = buf.readUInt32LE(off + 18);
    const nameLen = buf.readUInt16LE(off + 26);
    const extra = buf.readUInt16LE(off + 28);
    const name = buf.subarray(off + 30, off + 30 + nameLen).toString('utf8');
    const start = off + 30 + nameLen + extra;
    out.set(name, inflateRawSync(buf.subarray(start, start + compSize)).toString('utf8'));
    off = start + compSize;
  }
  return out;
}

describe('export content', () => {
  const doc = buildExportDocument(input);
  const text = documentText(doc);

  it('carries the disclaimer, banner, provenance, snapshot reference and id, methodology, denominator and manifest', () => {
    expect(text).toContain(PARALLEL_TALLY_DISCLAIMER);
    expect(text).toContain(PARALLEL_TALLY_BANNER);
    expect(text).toContain('Synthetic demonstration data');
    expect(text).toContain('SNP-2027-000001');
    expect(text).toContain(input.snapshot.id);
    expect(text).toContain('Expected stations (denominator)');
    expect(text).toContain('Missing (not counted as zero)');
    expect(text).toContain('b'.repeat(64));
    expect(doc.sections.map((s) => s.name)).toEqual(['Disclaimer', 'Snapshot', 'Methodology', 'Coverage', 'Candidate totals', 'Stations', 'Audit manifest']);
  });

  it('uses no forbidden outcome language outside the disclaimer', () => {
    expect(findForbiddenTallyLanguage(text)).toBeNull();
  });

  it('leaves station votes blank (not zero) for missing stations', () => {
    const stations = doc.sections.find((s) => s.name === 'Stations');
    if (stations?.kind !== 'table') throw new Error('no stations table');
    expect(stations.rows[1]).toEqual(['S002', 'Synthetic Station Two', 'MISSING', '', null, null, null]);
  });

  it('omits station rows when not requested', () => {
    expect(buildExportDocument({ ...input, stations: null }).sections.map((s) => s.name)).not.toContain('Stations');
  });
});

describe('CSV writer', () => {
  it('quotes RFC 4180 cells and neutralises formula injection', () => {
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell('=SUM(A1)')).toBe("'=SUM(A1)");
    expect(csvCell('-1+2')).toBe("'-1+2");
    expect(csvCell(-5)).toBe('-5');
    expect(csvCell(null)).toBe('');
  });

  it('starts with a BOM and contains the disclaimer', () => {
    const buf = renderCsv(buildExportDocument(input));
    expect([...buf.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    const s = buf.toString('utf8');
    expect(s).toContain('# Disclaimer');
    expect(s).toContain('"Synthetic Station, ""One"""');
    expect(s).toContain(`'=HYPERLINK`);
  });
});

describe('XLSX writer', () => {
  it('produces a valid zip with one worksheet per section and escaped content', () => {
    const buf = renderXlsx(buildExportDocument(input));
    expect(buf.subarray(0, 2).toString('latin1')).toBe('PK');
    const files = unzip(buf);
    expect([...files.keys()]).toEqual(
      expect.arrayContaining(['[Content_Types].xml', 'xl/workbook.xml', 'xl/worksheets/sheet1.xml', 'xl/worksheets/sheet7.xml']),
    );
    expect(files.get('xl/workbook.xml')).toContain('name="Audit manifest"');
    expect(files.get('xl/worksheets/sheet1.xml')).toContain('IEBC');
    expect(files.get('xl/worksheets/sheet6.xml')).toContain('Synthetic Station, &quot;One&quot;');
  });
});

describe('PDF writer', () => {
  it('produces a PDF with the disclaimer text and a footer on every page', () => {
    const many = { ...input, stations: Array.from({ length: 200 }, (_, i) => ({ ...input.stations![1]!, code: `S${i}` })) };
    const buf = renderPdf(buildExportDocument(many), `${PARALLEL_TALLY_BANNER}. footer`);
    const s = buf.toString('latin1');
    expect(s.startsWith('%PDF-1.4')).toBe(true);
    expect(s.trimEnd().endsWith('%%EOF')).toBe(true);
    const pages = (s.match(/\/Type \/Page /g) ?? []).length;
    expect(pages).toBeGreaterThan(2);
    expect((s.match(/Parallel tally - not an official IEBC result\. footer/g) ?? []).length).toBe(pages);
    expect(s).toContain('SNP-2027-000001');
  });

  it('wraps long text at word boundaries', () => {
    expect(wrap('aaa bbb ccc', 7)).toEqual(['aaa bbb', 'ccc']);
    expect(wrap('x'.repeat(10), 4)).toEqual(['xxxx', 'xxxx', 'xx']);
  });

  it('renders every format through one entry point', () => {
    const d = buildExportDocument(input);
    expect(renderExport(d, 'CSV').length).toBeGreaterThan(100);
    expect(renderExport(d, 'XLSX').subarray(0, 2).toString()).toBe('PK');
    expect(renderExport(d, 'PDF').subarray(0, 4).toString()).toBe('%PDF');
  });
});

describe('historical demo label (docs/DEMO_2022.md)', () => {
  const demo: ExportContentInput = {
    ...input,
    provenanceLabel: 'Historical demo — simulated data, not live or official results',
    dataLabelLines: exportLabelLines(HISTORICAL_DEMO_LABEL).slice(2),
  };
  const doc = buildExportDocument(demo);

  it('puts the demo label next to the unofficial disclaimer in the document', () => {
    const text = documentText(doc);
    expect(text).toContain(PARALLEL_TALLY_DISCLAIMER);
    expect(text).toContain(PARALLEL_TALLY_BANNER);
    expect(text).toContain(HISTORICAL_DEMO_LABEL);
    expect(text).toContain(HISTORICAL_DEMO_NOTICE);
    expect(doc.title).toContain(HISTORICAL_DEMO_LABEL);
    expect(findForbiddenTallyLanguage(text)).toBeNull();
  });

  it('every format carries both labels, the PDF on every page footer', () => {
    const csv = renderExport(doc, 'CSV', HISTORICAL_DEMO_LABEL).toString('utf8');
    expect(csv).toContain(HISTORICAL_DEMO_LABEL);
    expect(csv).toContain('internal parallel tally');
    expect(csv).toContain('# Footer');
    const xlsx = [...unzip(renderExport(doc, 'XLSX', HISTORICAL_DEMO_LABEL)).values()].join('\n');
    expect(xlsx).toContain(HISTORICAL_DEMO_LABEL);
    expect(xlsx).toContain('not an official IEBC result');
    const many = { ...demo, stations: Array.from({ length: 200 }, (_, i) => ({ ...input.stations![1]!, code: `S${i}` })) };
    const pdf = renderExport(buildExportDocument(many), 'PDF', HISTORICAL_DEMO_LABEL).toString('latin1');
    const pages = (pdf.match(/\/Type \/Page /g) ?? []).length;
    expect(pages).toBeGreaterThan(2);
    expect((pdf.match(/HISTORICAL DEMO \/ SIMULATED DATA\. Parallel tally - not an official IEBC result/g) ?? []).length).toBe(pages);
    expect(exportFooter(HISTORICAL_DEMO_LABEL)).toContain(PARALLEL_TALLY_DISCLAIMER);
  });

  it('an ordinary dataset has no demo label and no extra footer section', () => {
    const csv = renderExport(buildExportDocument(input), 'CSV').toString('utf8');
    expect(csv).not.toContain(HISTORICAL_DEMO_LABEL);
    expect(csv).not.toContain('# Footer');
  });
});

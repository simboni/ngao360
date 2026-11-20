import { describe, expect, it } from 'vitest';
import { findForbiddenTallyLanguage } from '../disclaimer';
import { FORM_SERIES, FormFieldSchemaSchema, ValidationRulesSchema } from '../form-schema';
import {
  allFormTemplateDefinitions,
  buildFormTemplateDefinition,
  checkCandidateLabel,
  checkFormIdentity,
  checkTemplateDefinition,
  diffRegistry,
  evaluateValidationRules,
  FORM_CATALOGUE,
  findFormCatalogueEntry,
  isCapturableFormLevel,
  KENYA_COUNTIES,
  nextTemplateState,
  overallOutcome,
  parseCsv,
  reportErrors,
  toCsv,
  validateRegistryCsv,
} from './index';

const HEADER =
  'county_code,county_name,constituency_code,constituency_name,ward_code,ward_name,centre_code,centre_name,station_code,station_name,registered_voters';

function csv(...rows: string[]): string {
  return [HEADER, ...rows].join('\n');
}

const OK_ROW = '039,Bungoma,SYN-C01,Synthetic North,SYN-C01-W01,Ward One,SYN-C01-W01-P01,Synthetic School,SYN-C01-W01-P01-S01,Synthetic School Stream 1,512';

describe('counties', () => {
  it('lists the 47 counties with unique sequential codes', () => {
    expect(KENYA_COUNTIES).toHaveLength(47);
    expect(KENYA_COUNTIES.map((c) => c.code)).toEqual(Array.from({ length: 47 }, (_, i) => String(i + 1).padStart(3, '0')));
    expect(KENYA_COUNTIES.find((c) => c.code === '039')?.name).toBe('Bungoma');
    expect(KENYA_COUNTIES.find((c) => c.code === '047')?.name).toBe('Nairobi City');
  });
});

describe('parseCsv', () => {
  it('handles quotes, embedded commas/newlines, CRLF and BOM', () => {
    const r = parseCsv('﻿a,B\r\n"x, y","say ""hi""\nthere"\r\n\r\n1,2');
    expect(r.header).toEqual(['a', 'b']);
    expect(r.records).toEqual([
      { line: 2, cells: ['x, y', 'say "hi"\nthere'] },
      { line: 5, cells: ['1', '2'] },
    ]);
    expect(r.errors).toEqual([]);
  });

  it('reports an unterminated quote', () => {
    expect(parseCsv('a\n"oops').errors).toHaveLength(1);
  });

  it('round-trips through toCsv', () => {
    const out = toCsv(['a', 'b'], [['x, y', 'q"q'], [1, null]]);
    expect(parseCsv(out).records.map((r) => r.cells)).toEqual([['x, y', 'q"q'], ['1', '']]);
  });
});

describe('validateRegistryCsv', () => {
  it('accepts a valid file and summarises the hierarchy', () => {
    const { rows, report } = validateRegistryCsv(
      csv(OK_ROW, OK_ROW.replace(/S01/g, 'S02').replace('512', '480')),
      { version: 'R1', source: 'SYNTHETIC test' },
    );
    expect(report.fatal).toBe(false);
    expect(report.totals).toMatchObject({ rowsRead: 2, rowsAccepted: 2, rowsRejected: 0, errors: 0 });
    expect(report.hierarchy).toMatchObject({ counties: 1, constituencies: 1, wards: 1, pollingCentres: 1, stations: 2, registeredVotersTotal: 992 });
    expect(rows[0]).toMatchObject({ countyCode: '039', stationCode: 'SYN-C01-W01-P01-S01', registeredVoters: 512, line: 2 });
    expect(report.sourceMetadata).toMatchObject({ version: 'R1', source: 'SYNTHETIC test' });
  });

  it('is fatal when a required column is missing', () => {
    const { rows, report } = validateRegistryCsv('county_code,county_name\n039,Bungoma');
    expect(report.fatal).toBe(true);
    expect(rows).toEqual([]);
    expect(report.issues.filter((i) => i.code === 'MISSING_COLUMN').map((i) => i.column)).toContain('station_code');
  });

  it('is fatal when there are no data rows or too many rows', () => {
    expect(validateRegistryCsv(HEADER).report.issues[0]?.code).toBe('NO_DATA_ROWS');
    expect(validateRegistryCsv(csv(OK_ROW, OK_ROW.replace(/S01/g, 'S02')), {}, { maxRows: 1 }).report.issues[0]?.code).toBe('TOO_MANY_ROWS');
  });

  it('rejects rows with unknown counties, wrong county names and bad numbers, keeping the rest', () => {
    const { rows, report } = validateRegistryCsv(
      csv(
        OK_ROW,
        OK_ROW.replace('039,Bungoma', '048,Atlantis').replace(/S01/g, 'S02'),
        OK_ROW.replace('039,Bungoma', '039,Busia').replace(/S01/g, 'S03'),
        OK_ROW.replace(/S01/g, 'S04').replace(',512', ',-5'),
        OK_ROW.replace(/S01/g, 'S05').replace(',512', ',lots'),
      ),
    );
    expect(rows).toHaveLength(1);
    expect(report.totals.rowsRejected).toBe(4);
    const codes = report.issues.map((i) => [i.row, i.code]);
    expect(codes).toEqual(
      expect.arrayContaining([
        [3, 'UNKNOWN_COUNTY'],
        [4, 'COUNTY_NAME_MISMATCH'],
        [5, 'INVALID_INTEGER'],
        [6, 'INVALID_INTEGER'],
      ]),
    );
    expect(reportErrors(report).every((e) => e.row > 1)).toBe(true);
  });

  it('normalises numeric county codes with a warning and accepts name variants', () => {
    const { rows, report } = validateRegistryCsv(csv(OK_ROW.replace('039,Bungoma', '39,BUNGOMA')));
    expect(rows[0]?.countyCode).toBe('039');
    expect(report.issues.map((i) => i.code)).toContain('COUNTY_CODE_NORMALISED');
    expect(validateRegistryCsv(csv(OK_ROW.replace('039,Bungoma', '047,Nairobi'))).rows).toHaveLength(1);
  });

  it('rejects duplicate station codes instead of overwriting', () => {
    const { rows, report } = validateRegistryCsv(csv(OK_ROW, OK_ROW.replace('Stream 1', 'Stream 1 again')));
    expect(rows).toHaveLength(1);
    expect(report.issues).toEqual([expect.objectContaining({ row: 3, code: 'DUPLICATE_STATION_CODE', severity: 'ERROR' })]);
  });

  it('rejects inconsistent hierarchy definitions across rows', () => {
    const renamedWard = OK_ROW.replace('Ward One', 'Ward Uno').replace(/S01/g, 'S02');
    const movedWard = OK_ROW.replace('SYN-C01,Synthetic North', 'SYN-C02,Synthetic South').replace(/P01-S01/g, 'P01-S03');
    const { rows, report } = validateRegistryCsv(csv(OK_ROW, renamedWard, movedWard));
    expect(rows).toHaveLength(1);
    expect(report.issues.map((i) => i.code)).toEqual(expect.arrayContaining(['INCONSISTENT_NAME', 'INCONSISTENT_PARENT']));
  });

  it('keeps missing registered voters empty and flags implausible figures', () => {
    const { rows, report } = validateRegistryCsv(
      csv(OK_ROW.replace(',512', ','), OK_ROW.replace(/S01/g, 'S02').replace(',512', ',2500')),
    );
    expect(rows.map((r) => r.registeredVoters)).toEqual([null, 2500]);
    expect(report.issues.map((i) => [i.code, i.severity])).toEqual([
      ['REGISTERED_VOTERS_MISSING', 'WARNING'],
      ['REGISTERED_VOTERS_HIGH', 'WARNING'],
    ]);
    expect(report.hierarchy.stationsWithoutRegisteredVoters).toBe(1);
  });

  it('allows stations without a polling centre but not half a centre', () => {
    const noCentre = OK_ROW.replace('SYN-C01-W01-P01,Synthetic School,', ',,');
    const halfCentre = OK_ROW.replace('SYN-C01-W01-P01,Synthetic School,', 'SYN-X,,').replace(/S01$/, 'S09');
    const { rows, report } = validateRegistryCsv(csv(noCentre, halfCentre));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.centreCode).toBeNull();
    expect(report.issues.map((i) => i.code)).toContain('CENTRE_INCOMPLETE');
  });

  it('warns about unknown columns and validates optional coordinates', () => {
    const text = `${HEADER},latitude,longitude,colour\n${OK_ROW},0.56,34.56,blue\n${OK_ROW.replace(/S01/g, 'S02')},0.56,,blue`;
    const { rows, report } = validateRegistryCsv(text);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ latitude: 0.56, longitude: 34.56 });
    expect(report.issues.map((i) => i.code)).toEqual(expect.arrayContaining(['UNKNOWN_COLUMN', 'INVALID_COORDINATES']));
  });
});

describe('diffRegistry', () => {
  it('reports added, removed, renamed, moved and voter changes', () => {
    const prev = [
      { code: 'A', name: 'A', wardCode: 'W1', registeredVoters: 100 },
      { code: 'B', name: 'B', wardCode: 'W1', registeredVoters: 100 },
      { code: 'C', name: 'C', wardCode: 'W1', registeredVoters: 100 },
    ];
    const next = [
      { code: 'A', name: 'A', wardCode: 'W1', registeredVoters: 100 },
      { code: 'B', name: 'B renamed', wardCode: 'W2', registeredVoters: 120 },
      { code: 'D', name: 'D', wardCode: 'W1', registeredVoters: null },
    ];
    const d = diffRegistry(prev, next, 'R1');
    expect(d).toMatchObject({ comparedWithVersion: 'R1', added: 1, removed: 1, renamed: 1, moved: 1, registeredVotersChanged: 1, unchanged: 1 });
    expect(d.samples.removed).toEqual(['C']);
  });
});

describe('form template catalogue', () => {
  it('covers all six series and their certificates', () => {
    const numbers = FORM_CATALOGUE.map((e) => e.formNumber);
    for (const s of Object.values(FORM_SERIES)) {
      expect(numbers).toContain(s.station);
      for (const c of s.collation) expect(numbers).toContain(c);
      expect(numbers).toContain(s.certificate);
    }
    expect(numbers).toHaveLength(22);
  });

  it('marks certificates as reference only', () => {
    for (const n of ['34D', '35C', '36C', '37D', '38D', '39D']) {
      const e = findFormCatalogueEntry(n)!;
      expect(e.formLevel).toBe('CERTIFICATE');
      expect(e.capturable).toBe(false);
      expect(isCapturableFormLevel(e.formLevel)).toBe(false);
    }
    expect(isCapturableFormLevel('POLLING_STATION')).toBe(true);
  });

  it('builds schema-valid, internally consistent definitions for every form', () => {
    for (const d of allFormTemplateDefinitions()) {
      expect(() => FormFieldSchemaSchema.parse(d.fieldSchema)).not.toThrow();
      expect(() => ValidationRulesSchema.parse(d.validationRules)).not.toThrow();
      expect(checkTemplateDefinition(d.fieldSchema, d.validationRules)).toEqual([]);
      expect(checkFormIdentity(d.formNumber, d.contestType, d.formLevel)).toEqual([]);
      expect(d.officialSource).toContain('Legal Notice No. 72 of 2017');
      for (const r of d.validationRules.rules) expect(r.reference).toContain(`Form ${d.formNumber}`);
    }
  });

  it('never uses winner/elected/declared language in titles or rule messages', () => {
    for (const d of allFormTemplateDefinitions()) {
      const text = [d.title, d.notes, ...d.fieldSchema.fields.map((f) => `${f.label} ${f.helpText ?? ''}`), ...d.validationRules.rules.map((r) => r.message)].join(' | ');
      expect(findForbiddenTallyLanguage(text)).toBeNull();
    }
  });

  it('fully specifies the Governor 37A form', () => {
    const d = buildFormTemplateDefinition(findFormCatalogueEntry('37A')!);
    const keys = d.fieldSchema.fields.map((f) => f.key);
    expect(keys).toEqual(
      expect.arrayContaining([
        'county_code', 'constituency_code', 'ward_code', 'polling_station_code', 'polling_station_name',
        'registered_voters', 'candidate_votes', 'total_valid_votes', 'rejected_ballots',
        'rejection_objected_ballots', 'disputed_votes', 'total_votes_cast',
        'stamp_present', 'po_signature_present', 'agent_signatures_count',
      ]),
    );
    const candidate = d.fieldSchema.fields.find((f) => f.key === 'candidate_votes')!;
    expect(candidate).toMatchObject({ kind: 'CANDIDATE_VOTES', perCandidate: true, required: true });
    for (const k of ['stamp_present', 'po_signature_present']) {
      expect(d.fieldSchema.fields.find((f) => f.key === k)).toMatchObject({ kind: 'BOOLEAN_OBSERVATION', observationOnly: true });
    }
    expect(d.validationRules.rules.map((r) => r.key)).toEqual(
      expect.arrayContaining(['CANDIDATES_SUM_TO_TOTAL_VALID', 'VOTES_CAST_EQUALS_VALID_PLUS_REJECTED', 'VOTES_CAST_NOT_ABOVE_REGISTERED']),
    );
    expect(d.formLevel).toBe('POLLING_STATION');
  });

  it('37B and 37C are constituency and county collation forms', () => {
    expect(findFormCatalogueEntry('37B')?.formLevel).toBe('CONSTITUENCY');
    expect(findFormCatalogueEntry('37C')?.formLevel).toBe('COUNTY');
    const c = buildFormTemplateDefinition(findFormCatalogueEntry('37C')!);
    expect(c.fieldSchema.fields.map((f) => f.key)).toEqual(expect.arrayContaining(['constituencies_count', 'stations_count', 'county_code']));
  });
});

describe('checkTemplateDefinition', () => {
  const base = buildFormTemplateDefinition(findFormCatalogueEntry('37A')!);

  it('flags rules that refer to unknown fields or the wrong field kinds', () => {
    const issues = checkTemplateDefinition(base.fieldSchema, {
      rulesVersion: 2,
      rules: [
        { key: 'BAD_FIELD', version: 1, type: 'REQUIRED_PRESENT', fields: ['nope'], severity: 'FAIL', message: 'x', reference: 'Form 37A' },
        { key: 'BAD_SUM', version: 1, type: 'SUM_EQUALS', fields: ['total_valid_votes', 'rejected_ballots'], severity: 'FAIL', message: 'x', reference: 'Form 37A' },
        { key: 'BAD_OBS', version: 1, type: 'REQUIRED_OBSERVATION', fields: ['total_votes_cast'], severity: 'WARNING', message: 'x', reference: 'Form 37A' },
        { key: 'BAD_OBS', version: 1, type: 'LESS_OR_EQUAL', fields: ['total_votes_cast'], severity: 'WARNING', message: 'x', reference: '' },
      ],
    });
    const msgs = issues.map((i) => i.message).join('\n');
    expect(msgs).toMatch(/unknown field "nope"/);
    expect(msgs).toMatch(/SUM_EQUALS/);
    expect(msgs).toMatch(/REQUIRED_OBSERVATION/);
    expect(msgs).toMatch(/Duplicate rule key/);
    expect(msgs).toMatch(/LESS_OR_EQUAL/);
    expect(msgs).toMatch(/must cite/);
  });

  it('flags duplicate field keys and per-candidate misuse', () => {
    const issues = checkTemplateDefinition(
      {
        schemaVersion: 1,
        fields: [
          { key: 'a', label: 'A', kind: 'INTEGER', section: 'STATION_COUNTS', required: false, perCandidate: true, observationOnly: false },
          { key: 'a', label: 'A', kind: 'BOOLEAN_OBSERVATION', section: 'OBSERVATIONS', required: false, perCandidate: false, observationOnly: false },
        ],
      },
      { rulesVersion: 1, rules: [] },
    );
    expect(issues.map((i) => i.message)).toEqual(
      expect.arrayContaining([expect.stringMatching(/Duplicate field key/), expect.stringMatching(/per candidate/), expect.stringMatching(/observation-only/)]),
    );
  });
});

describe('evaluateValidationRules (37A)', () => {
  const d = buildFormTemplateDefinition(findFormCatalogueEntry('37A')!);
  const good = {
    polling_station_code: 'SYN-C01-W01-P01-S01',
    registered_voters: 500,
    candidate_votes: { a: 120, b: 80, c: 40, d: 10 },
    total_valid_votes: 250,
    rejected_ballots: 6,
    rejection_objected_ballots: 2,
    disputed_votes: 0,
    total_votes_cast: 256,
    stamp_present: true,
    po_signature_present: true,
  };
  const byKey = (values: Record<string, unknown>) =>
    Object.fromEntries(evaluateValidationRules(d.validationRules, values as never).map((r) => [r.ruleKey, r]));

  it('passes a consistent form', () => {
    const results = evaluateValidationRules(d.validationRules, good);
    expect(overallOutcome(results)).toBe('PASS');
    expect(results.every((r) => r.outcome === 'PASS')).toBe(true);
  });

  it('fails when candidate votes do not sum to total valid votes, naming fields and reference', () => {
    const r = byKey({ ...good, total_valid_votes: 251, total_votes_cast: 257 }).CANDIDATES_SUM_TO_TOTAL_VALID!;
    expect(r.outcome).toBe('FAIL');
    expect(r.fields).toEqual(['total_valid_votes', 'candidate_votes']);
    expect(r.reference).toMatch(/Form 37A/);
    expect(r.detail).toBe('120 + 80 + 40 + 10 = 250; total_valid_votes = 251');
  });

  it('fails when valid + rejected != votes cast', () => {
    expect(byKey({ ...good, total_votes_cast: 260 }).VOTES_CAST_EQUALS_VALID_PLUS_REJECTED!.outcome).toBe('FAIL');
  });

  it('warns (never fails) when votes cast exceed registered voters', () => {
    const r = byKey({ ...good, registered_voters: 200 });
    expect(r.VOTES_CAST_NOT_ABOVE_REGISTERED!.outcome).toBe('WARNING');
    expect(r.VALID_NOT_ABOVE_REGISTERED!.outcome).toBe('WARNING');
  });

  it('skips comparisons with missing inputs instead of treating them as zero', () => {
    const r = byKey({ ...good, registered_voters: null, total_votes_cast: undefined });
    expect(r.VOTES_CAST_NOT_ABOVE_REGISTERED!.outcome).toBe('SKIPPED');
    expect(r.VOTES_CAST_EQUALS_VALID_PLUS_REJECTED!.outcome).toBe('SKIPPED');
    expect(r.COUNTS_PRESENT!.outcome).toBe('WARNING');
  });

  it('fails negative counts and missing candidate figures; warns on unobserved stamp', () => {
    const r = byKey({ ...good, candidate_votes: { a: -1, b: null }, stamp_present: false });
    expect(r.NON_NEGATIVE_COUNTS!.outcome).toBe('FAIL');
    expect(r.CANDIDATE_VOTES_PRESENT!.outcome).toBe('FAIL');
    expect(r.STAMP_OBSERVED!.outcome).toBe('WARNING');
  });

  it('does not modify the captured values', () => {
    const values = structuredClone(good);
    evaluateValidationRules(d.validationRules, values);
    expect(values).toEqual(good);
  });
});

describe('lifecycle rules', () => {
  it('requires submission before approval and retires instead of editing', () => {
    expect(nextTemplateState('DRAFT', 'APPROVE')).toBeNull();
    expect(nextTemplateState('DRAFT', 'SUBMIT_FOR_APPROVAL')).toBe('PENDING_APPROVAL');
    expect(nextTemplateState('PENDING_APPROVAL', 'APPROVE')).toBe('APPROVED');
    expect(nextTemplateState('PENDING_APPROVAL', 'REJECT')).toBe('DRAFT');
    expect(nextTemplateState('APPROVED', 'RETIRE')).toBe('RETIRED');
    expect(nextTemplateState('RETIRED', 'APPROVE')).toBeNull();
  });

  it('checks form identity against office and level', () => {
    expect(checkFormIdentity('37A', 'GOVERNOR', 'POLLING_STATION')).toEqual([]);
    expect(checkFormIdentity('37A', 'SENATOR', 'POLLING_STATION')).toHaveLength(1);
    expect(checkFormIdentity('37C', 'GOVERNOR', 'CONSTITUENCY')).toHaveLength(1);
    expect(checkFormIdentity('39E', 'WOMAN_REPRESENTATIVE', 'POLLING_STATION')).toHaveLength(1);
  });

  it('requires a party label or independent status', () => {
    expect(checkCandidateLabel('Party Alpha', false)).toBeNull();
    expect(checkCandidateLabel(null, true)).toBeNull();
    expect(checkCandidateLabel('Independent', true)).toBeNull();
    expect(checkCandidateLabel('', false)).not.toBeNull();
    expect(checkCandidateLabel('Party Alpha', true)).not.toBeNull();
  });
});

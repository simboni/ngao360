/**
 * Form-template catalogue for all six elective positions (blueprint 8.1,
 * Appendix A): the 34–39 series. Each capturable form has a fully specified
 * field schema and declarative validation rules with a rule key and a form or
 * legal reference. Certificates (34D, 35C, 36C, 37D, 38D, 39D) are official IEBC
 * documents recorded as reference only: they are never captured or tallied.
 *
 * LEGAL BASELINE: the Elections (General) (Amendment) Regulations, 2017 (Legal
 * Notice No. 72 of 2017) and schedules. This is a product-design baseline, not
 * the 2027 forms. Before production the legal/configuration administrator must
 * load the actual 2027 IEBC forms as new template versions and approve them.
 * Seeded templates are versions to review, never a substitute for that step.
 */
import type { FormLevel, OfficeType } from '../enums';
import type { FormFieldDefinition, FormFieldSchema, ValidationRule, ValidationRules } from '../form-schema';

export const LEGAL_BASELINE_SOURCE =
  'Elections (General) (Amendment) Regulations, 2017 (Legal Notice No. 72 of 2017), schedules; ' +
  'baseline only, pending confirmation against the 2027 IEBC forms and directions';

/** Levels that can be captured in NGAO TALLY. Certificates are reference only. */
export const NON_CAPTURABLE_FORM_LEVELS: readonly FormLevel[] = ['CERTIFICATE'];
export function isCapturableFormLevel(level: FormLevel): boolean {
  return !NON_CAPTURABLE_FORM_LEVELS.includes(level);
}

export interface FormCatalogueEntry {
  formNumber: string;
  contestType: OfficeType;
  formLevel: FormLevel;
  title: string;
  /** Regulation the form is prescribed under (baseline). */
  regulation: string;
  capturable: boolean;
}

const OFFICE_NOUN: Record<OfficeType, string> = {
  PRESIDENT: 'Presidential',
  NATIONAL_ASSEMBLY: 'Member of the National Assembly',
  COUNTY_ASSEMBLY: 'Member of the County Assembly',
  GOVERNOR: 'County Governor',
  SENATOR: 'Senator',
  WOMAN_REPRESENTATIVE: 'County Woman Representative',
};

const CERTIFICATE_ISSUER: Record<OfficeType, string> = {
  PRESIDENT: 'the Chairperson of the Commission',
  NATIONAL_ASSEMBLY: 'the Constituency Returning Officer',
  COUNTY_ASSEMBLY: 'the Returning Officer',
  GOVERNOR: 'the County Returning Officer',
  SENATOR: 'the County Returning Officer',
  WOMAN_REPRESENTATIVE: 'the County Returning Officer',
};

function station(n: string, office: OfficeType): FormCatalogueEntry {
  return {
    formNumber: n,
    contestType: office,
    formLevel: 'POLLING_STATION',
    title: `Form ${n}: ${OFFICE_NOUN[office]} election results at the polling station`,
    regulation: 'regulation 79(2)',
    capturable: true,
  };
}
function constituency(n: string, office: OfficeType, kind: 'Collation' | 'Declaration'): FormCatalogueEntry {
  return {
    formNumber: n,
    contestType: office,
    formLevel: 'CONSTITUENCY',
    title: `Form ${n}: ${kind} of ${OFFICE_NOUN[office]} election results at the constituency tallying centre`,
    regulation: 'regulation 83',
    capturable: true,
  };
}
function county(n: string, office: OfficeType): FormCatalogueEntry {
  return {
    formNumber: n,
    contestType: office,
    formLevel: 'COUNTY',
    title: `Form ${n}: Declaration of ${OFFICE_NOUN[office]} election results at the county tallying centre`,
    regulation: 'regulation 87',
    capturable: true,
  };
}
function certificate(n: string, office: OfficeType): FormCatalogueEntry {
  return {
    formNumber: n,
    contestType: office,
    formLevel: 'CERTIFICATE',
    title: `Form ${n}: ${OFFICE_NOUN[office]} certificate issued by ${CERTIFICATE_ISSUER[office]} (official IEBC document; reference only, not captured)`,
    regulation: 'regulation 87 and schedules',
    capturable: false,
  };
}

/** Every form number in the 34–39 series, in order. */
export const FORM_CATALOGUE: readonly FormCatalogueEntry[] = Object.freeze([
  station('34A', 'PRESIDENT'),
  constituency('34B', 'PRESIDENT', 'Collation'),
  {
    formNumber: '34C',
    contestType: 'PRESIDENT',
    formLevel: 'NATIONAL',
    title: 'Form 34C: Declaration of Presidential election results at the national tallying centre',
    regulation: 'regulation 87',
    capturable: true,
  },
  certificate('34D', 'PRESIDENT'),
  station('35A', 'NATIONAL_ASSEMBLY'),
  constituency('35B', 'NATIONAL_ASSEMBLY', 'Declaration'),
  certificate('35C', 'NATIONAL_ASSEMBLY'),
  station('36A', 'COUNTY_ASSEMBLY'),
  constituency('36B', 'COUNTY_ASSEMBLY', 'Declaration'),
  certificate('36C', 'COUNTY_ASSEMBLY'),
  station('37A', 'GOVERNOR'),
  constituency('37B', 'GOVERNOR', 'Collation'),
  county('37C', 'GOVERNOR'),
  certificate('37D', 'GOVERNOR'),
  station('38A', 'SENATOR'),
  constituency('38B', 'SENATOR', 'Collation'),
  county('38C', 'SENATOR'),
  certificate('38D', 'SENATOR'),
  station('39A', 'WOMAN_REPRESENTATIVE'),
  constituency('39B', 'WOMAN_REPRESENTATIVE', 'Collation'),
  county('39C', 'WOMAN_REPRESENTATIVE'),
  certificate('39D', 'WOMAN_REPRESENTATIVE'),
]);

const CATALOGUE_BY_NUMBER = new Map(FORM_CATALOGUE.map((e) => [e.formNumber, e]));

export function findFormCatalogueEntry(formNumber: string): FormCatalogueEntry | undefined {
  return CATALOGUE_BY_NUMBER.get(formNumber.toUpperCase());
}

/* ------------------------------ Field builders ---------------------------- */

type FieldInput = Omit<FormFieldDefinition, 'required' | 'perCandidate' | 'observationOnly'> &
  Partial<Pick<FormFieldDefinition, 'required' | 'perCandidate' | 'observationOnly'>>;

function f(def: FieldInput): FormFieldDefinition {
  return { required: false, perCandidate: false, observationOnly: false, ...def };
}
const text = (key: string, label: string, helpText?: string, required = false) =>
  f({ key, label, kind: 'TEXT', section: 'DECLARATION', required, ...(helpText ? { helpText } : {}) });
const count = (key: string, label: string, section: FormFieldDefinition['section'] = 'STATION_COUNTS', required = false) =>
  f({ key, label, kind: 'INTEGER', section, min: 0, required });
const observation = (key: string, label: string, required = false) =>
  f({
    key,
    label,
    kind: 'BOOLEAN_OBSERVATION',
    section: 'OBSERVATIONS',
    observationOnly: true,
    required,
    helpText: 'Reviewer observation of what is visible on the copy. Software cannot establish authenticity.',
  });

const AS_PRINTED = 'Exactly as printed on the form; do not correct it from the registry.';

/** Vote-count fields shared by every capturable form. */
function voteFields(scope: string): FormFieldDefinition[] {
  return [
    count('registered_voters', `Number of registered voters${scope}`),
    f({
      key: 'candidate_votes',
      label: 'Number of valid votes obtained by each candidate',
      kind: 'CANDIDATE_VOTES',
      section: 'CANDIDATE_FIGURES',
      required: true,
      perCandidate: true,
      min: 0,
      helpText: 'One value per candidate, in ballot order, exactly as printed.',
    }),
    count('total_valid_votes', `Total number of valid votes cast${scope}`, 'CANDIDATE_FIGURES', true),
    count('rejected_ballots', `Number of rejected ballot papers${scope}`),
    count('rejection_objected_ballots', `Number of rejection objected to ballot papers${scope}`),
    count('disputed_votes', `Number of disputed votes${scope}`, 'DISPUTED_VOTES'),
    count('total_votes_cast', `Total number of votes cast${scope}`),
  ];
}

function stationFields(): FormFieldSchema {
  return {
    schemaVersion: 1,
    fields: [
      text('form_serial_number', 'Form serial number (where printed)', AS_PRINTED),
      text('county_code', 'County code', AS_PRINTED),
      text('county_name', 'County name', AS_PRINTED),
      text('constituency_code', 'Constituency code', AS_PRINTED),
      text('constituency_name', 'Constituency name', AS_PRINTED),
      text('ward_code', 'County assembly ward code', AS_PRINTED),
      text('ward_name', 'County assembly ward name', AS_PRINTED),
      text('polling_centre_name', 'Polling centre name', AS_PRINTED),
      text('polling_station_code', 'Polling station code', AS_PRINTED),
      text('polling_station_name', 'Polling station name', AS_PRINTED),
      f({ key: 'stream_number', label: 'Stream number (where printed)', kind: 'INTEGER', section: 'DECLARATION', min: 1 }),
      ...voteFields(' in the polling station'),
      text('presiding_officer_name', 'Name of presiding officer (as printed)', 'Personal data: shown only to authorised reviewers.'),
      f({ key: 'declaration_datetime', label: 'Date and time of declaration at the polling station (as printed)', kind: 'DATE_TIME', section: 'DECLARATION' }),
      observation('stamp_present', 'Official polling-station stamp visible'),
      observation('po_signature_present', 'Presiding officer signature visible'),
      observation('dpo_signature_present', 'Deputy presiding officer signature visible'),
      f({
        key: 'agent_signatures_count',
        label: 'Number of agent signatures visible',
        kind: 'INTEGER',
        section: 'OBSERVATIONS',
        min: 0,
        observationOnly: true,
        helpText: 'Count of signatures visible on the copy; names are not captured.',
      }),
      observation('agent_refusal_reasons_recorded', 'Reasons recorded for any agent refusing to sign'),
    ],
  };
}

function collationFields(level: 'constituency' | 'county' | 'national'): FormFieldSchema {
  const ids: FormFieldDefinition[] = [text('form_serial_number', 'Form serial number (where printed)', AS_PRINTED)];
  if (level !== 'national') {
    ids.push(text('county_code', 'County code', AS_PRINTED), text('county_name', 'County name', AS_PRINTED));
  }
  if (level === 'constituency') {
    ids.push(text('constituency_code', 'Constituency code', AS_PRINTED), text('constituency_name', 'Constituency name', AS_PRINTED));
  }
  ids.push(text('tally_centre_name', `${level[0]!.toUpperCase()}${level.slice(1)} tallying centre (as printed)`, AS_PRINTED));
  const units: FormFieldDefinition[] = [count('stations_count', 'Number of polling stations included')];
  if (level === 'county') units.push(count('constituencies_count', 'Number of constituencies included'));
  if (level === 'national') units.push(count('counties_count', 'Number of counties included'));
  const officer = level === 'national' ? 'national returning officer' : `${level} returning officer`;
  return {
    schemaVersion: 1,
    fields: [
      ...ids,
      ...units,
      ...voteFields(` (${level} total)`),
      text('returning_officer_name', `Name of ${officer} (as printed)`, 'Personal data: shown only to authorised reviewers.'),
      f({ key: 'declaration_datetime', label: 'Date and time of declaration (as printed)', kind: 'DATE_TIME', section: 'DECLARATION' }),
      observation('stamp_present', `Official ${level} tallying-centre stamp visible`),
      observation('ro_signature_present', 'Returning officer signature visible'),
      f({
        key: 'agent_signatures_count',
        label: 'Number of agent signatures visible',
        kind: 'INTEGER',
        section: 'OBSERVATIONS',
        min: 0,
        observationOnly: true,
      }),
    ],
  };
}

function certificateFields(): FormFieldSchema {
  return {
    schemaVersion: 1,
    fields: [
      text(
        'certificate_reference',
        'Certificate serial or reference (where printed)',
        'Reference only. Certificates are official IEBC documents; NGAO360 never captures, tallies or generates them.',
      ),
    ],
  };
}

/* ------------------------------ Rule builders ----------------------------- */

const COUNT_FIELDS = [
  'candidate_votes',
  'total_valid_votes',
  'rejected_ballots',
  'rejection_objected_ballots',
  'disputed_votes',
  'total_votes_cast',
  'registered_voters',
];

function rule(r: ValidationRule): ValidationRule {
  return r;
}

function voteRules(form: string, reg: string, signatureField: string, idField: string | null): ValidationRule[] {
  const ref = (extra: string) => `Form ${form}; ${reg}; ${extra}`;
  const rules: ValidationRule[] = [
    rule({ key: 'NON_NEGATIVE_COUNTS', version: 1, type: 'NON_NEGATIVE', fields: COUNT_FIELDS, severity: 'FAIL', message: 'Vote counts must be whole numbers of zero or more.', reference: ref('blueprint 8.4 numeric checks') }),
    rule({ key: 'CANDIDATE_VOTES_PRESENT', version: 1, type: 'REQUIRED_PRESENT', fields: ['candidate_votes'], severity: 'FAIL', message: 'A vote figure must be captured for every candidate printed on the form.', reference: ref('candidate figures') }),
    rule({ key: 'TOTAL_VALID_PRESENT', version: 1, type: 'REQUIRED_PRESENT', fields: ['total_valid_votes'], severity: 'FAIL', message: 'Total valid votes is printed on the form and must be captured.', reference: ref('total valid votes') }),
    rule({ key: 'COUNTS_PRESENT', version: 1, type: 'REQUIRED_PRESENT', fields: ['rejected_ballots', 'total_votes_cast'], severity: 'WARNING', message: 'Rejected ballots and total votes cast are printed on the form; capture them or note why they are illegible.', reference: ref('polling counts') }),
    rule({ key: 'CANDIDATES_SUM_TO_TOTAL_VALID', version: 1, type: 'SUM_EQUALS', fields: ['total_valid_votes', 'candidate_votes'], severity: 'FAIL', message: 'The sum of candidate votes must equal total valid votes.', reference: ref('blueprint 8.4 / 8.5 arithmetic') }),
    rule({ key: 'VOTES_CAST_EQUALS_VALID_PLUS_REJECTED', version: 1, type: 'FIELDS_SUM_EQUALS', fields: ['total_votes_cast', 'total_valid_votes', 'rejected_ballots'], severity: 'FAIL', message: 'Total votes cast must equal valid votes plus rejected ballots. Confirm this arithmetic against the approved 2027 form before approving the template.', reference: ref('form arithmetic (baseline, pending 2027 confirmation)') }),
    rule({ key: 'VOTES_CAST_NOT_ABOVE_REGISTERED', version: 1, type: 'LESS_OR_EQUAL', fields: ['total_votes_cast', 'registered_voters'], severity: 'WARNING', message: 'Total votes cast is above registered voters. Flag for human review; never exclude automatically.', reference: ref('blueprint 8.4 turnout check') }),
    rule({ key: 'VALID_NOT_ABOVE_REGISTERED', version: 1, type: 'LESS_OR_EQUAL', fields: ['total_valid_votes', 'registered_voters'], severity: 'WARNING', message: 'Total valid votes is above registered voters. Flag for human review.', reference: ref('blueprint 8.4 turnout check') }),
    rule({ key: 'REJECTION_OBJECTED_NOT_ABOVE_REJECTED', version: 1, type: 'LESS_OR_EQUAL', fields: ['rejection_objected_ballots', 'rejected_ballots'], severity: 'WARNING', message: 'Rejection-objected ballots should not exceed rejected ballots.', reference: ref('rejected ballot counts') }),
    rule({ key: 'STAMP_OBSERVED', version: 1, type: 'REQUIRED_OBSERVATION', fields: ['stamp_present'], severity: 'WARNING', message: 'The reviewer has not observed an official stamp. This records an observation; it is not an authenticity check.', reference: ref('blueprint 8.4 visible required fields') }),
    rule({ key: 'SIGNATURE_OBSERVED', version: 1, type: 'REQUIRED_OBSERVATION', fields: [signatureField], severity: 'WARNING', message: 'The reviewer has not observed the officer signature. Software cannot establish that a signature is genuine.', reference: ref('blueprint 8.4 visible required fields') }),
  ];
  if (idField) {
    rules.splice(3, 0, rule({ key: 'IDENTIFIER_PRESENT', version: 1, type: 'REQUIRED_PRESENT', fields: [idField], severity: 'WARNING', message: 'Capture the identifier printed on the form so it can be checked against the approved registry.', reference: ref('blueprint 8.4 registry identity check') }));
  }
  return rules;
}

/* ---------------------------- Template definitions ------------------------ */

export interface FormTemplateDefinition {
  formNumber: string;
  contestType: OfficeType;
  formLevel: FormLevel;
  title: string;
  capturable: boolean;
  fieldSchema: FormFieldSchema;
  validationRules: ValidationRules;
  officialSource: string;
  officialSourceUrl: string | null;
  notes: string;
}

export function buildFormTemplateDefinition(entry: FormCatalogueEntry): FormTemplateDefinition {
  const officialSource = `${LEGAL_BASELINE_SOURCE}; Form ${entry.formNumber}; ${entry.regulation}`;
  const base = {
    formNumber: entry.formNumber,
    contestType: entry.contestType,
    formLevel: entry.formLevel,
    title: entry.title,
    capturable: entry.capturable,
    officialSource,
    officialSourceUrl: null,
  };
  switch (entry.formLevel) {
    case 'POLLING_STATION':
      return {
        ...base,
        fieldSchema: stationFields(),
        validationRules: { rulesVersion: 1, rules: voteRules(entry.formNumber, entry.regulation, 'po_signature_present', 'polling_station_code') },
        notes: 'Baseline field schema. Revalidate labels and arithmetic against the 2027 IEBC form before approval.',
      };
    case 'CONSTITUENCY':
      return {
        ...base,
        fieldSchema: collationFields('constituency'),
        validationRules: { rulesVersion: 1, rules: voteRules(entry.formNumber, entry.regulation, 'ro_signature_present', 'constituency_code') },
        notes: 'Captures the constituency totals. Per-station rows printed on the form are reconciled against verified station submissions, not re-keyed.',
      };
    case 'COUNTY':
      return {
        ...base,
        fieldSchema: collationFields('county'),
        validationRules: { rulesVersion: 1, rules: voteRules(entry.formNumber, entry.regulation, 'ro_signature_present', 'county_code') },
        notes: 'Captures the county totals. Per-constituency rows are reconciled against verified constituency submissions.',
      };
    case 'NATIONAL':
      return {
        ...base,
        fieldSchema: collationFields('national'),
        validationRules: { rulesVersion: 1, rules: voteRules(entry.formNumber, entry.regulation, 'ro_signature_present', null) },
        notes: 'Captures the national totals for reconciliation only.',
      };
    case 'CERTIFICATE':
      return {
        ...base,
        fieldSchema: certificateFields(),
        validationRules: { rulesVersion: 1, rules: [] },
        notes: 'Reference only. Not capturable: NGAO TALLY never captures, tallies or generates certificates.',
      };
  }
}

/** Definitions for every form in the 34–39 series. */
export function allFormTemplateDefinitions(): FormTemplateDefinition[] {
  return FORM_CATALOGUE.map(buildFormTemplateDefinition);
}

/** Expected form number series for an office, e.g. GOVERNOR → '37'. */
export function seriesForOffice(office: OfficeType): string {
  return FORM_CATALOGUE.find((e) => e.contestType === office)!.formNumber.slice(0, 2);
}

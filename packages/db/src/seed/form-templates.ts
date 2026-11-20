/**
 * Baseline Governor form templates (37A/37B/37C) for the synthetic rehearsal.
 * Field labels follow the 2017 schedules as described in blueprint Appendix A.1.
 * Before production the legal/configuration administrator must load and approve
 * the actual 2027 IEBC forms (blueprint 8, legal baseline box).
 */
import type { FormFieldSchema, ValidationRules } from '@ngao360/shared';

const LEGAL_BASELINE =
  'Elections (General) (Amendment) Regulations, 2017 (Legal Notice No. 72 of 2017), schedules; ' +
  'baseline only, pending confirmation against 2027 IEBC forms and directions';

const stationFields: FormFieldSchema = {
  schemaVersion: 1,
  fields: [
    { key: 'registered_voters', label: 'Number of registered voters', kind: 'INTEGER', section: 'STATION_COUNTS', required: false, perCandidate: false, min: 0, observationOnly: false },
    { key: 'candidate_votes', label: 'Number of valid votes obtained', kind: 'CANDIDATE_VOTES', section: 'CANDIDATE_FIGURES', required: true, perCandidate: true, min: 0, observationOnly: false },
    { key: 'total_valid_votes', label: 'Total number of valid votes cast', kind: 'INTEGER', section: 'CANDIDATE_FIGURES', required: true, perCandidate: false, min: 0, observationOnly: false },
    { key: 'rejected_ballots', label: 'Number of rejected ballot papers', kind: 'INTEGER', section: 'STATION_COUNTS', required: false, perCandidate: false, min: 0, observationOnly: false },
    { key: 'rejection_objected_ballots', label: 'Number of rejection objected to ballot papers', kind: 'INTEGER', section: 'STATION_COUNTS', required: false, perCandidate: false, min: 0, observationOnly: false },
    { key: 'disputed_votes', label: 'Number of disputed votes', kind: 'INTEGER', section: 'DISPUTED_VOTES', required: false, perCandidate: false, min: 0, observationOnly: false },
    { key: 'total_votes_cast', label: 'Total votes cast', kind: 'INTEGER', section: 'STATION_COUNTS', required: false, perCandidate: false, min: 0, observationOnly: false },
    { key: 'presiding_officer_name', label: 'Name of presiding officer (as printed)', kind: 'TEXT', section: 'DECLARATION', required: false, perCandidate: false, observationOnly: false },
    { key: 'declaration_datetime', label: 'Date and time of declaration (as printed)', kind: 'DATE_TIME', section: 'DECLARATION', required: false, perCandidate: false, observationOnly: false },
    { key: 'stamp_present', label: 'Official stamp visible', kind: 'BOOLEAN_OBSERVATION', section: 'OBSERVATIONS', required: false, perCandidate: false, observationOnly: true, helpText: 'Reviewer observation only; software cannot establish authenticity.' },
    { key: 'po_signature_present', label: 'Presiding officer signature visible', kind: 'BOOLEAN_OBSERVATION', section: 'OBSERVATIONS', required: false, perCandidate: false, observationOnly: true },
    { key: 'agent_signatures_count', label: 'Number of agent signatures visible', kind: 'INTEGER', section: 'OBSERVATIONS', required: false, perCandidate: false, min: 0, observationOnly: true },
  ],
};

const stationRules = (form: string): ValidationRules => ({
  rulesVersion: 1,
  rules: [
    { key: 'NON_NEGATIVE_COUNTS', version: 1, type: 'NON_NEGATIVE', fields: ['candidate_votes', 'total_valid_votes', 'rejected_ballots', 'rejection_objected_ballots', 'disputed_votes', 'total_votes_cast', 'registered_voters'], severity: 'FAIL', message: 'Vote counts must be whole numbers of zero or more.', reference: `Form ${form}; blueprint 8.4` },
    { key: 'TOTAL_VALID_PRESENT', version: 1, type: 'REQUIRED_PRESENT', fields: ['total_valid_votes'], severity: 'FAIL', message: 'Total valid votes is printed on the form and must be captured.', reference: `Form ${form}` },
    { key: 'CANDIDATES_SUM_TO_TOTAL_VALID', version: 1, type: 'SUM_EQUALS', fields: ['total_valid_votes', 'candidate_votes'], severity: 'FAIL', message: 'Sum of candidate votes must equal total valid votes.', reference: `Form ${form}; blueprint 8.4 / 8.5 arithmetic` },
    { key: 'VOTES_CAST_EQUALS_VALID_PLUS_REJECTED', version: 1, type: 'FIELDS_SUM_EQUALS', fields: ['total_votes_cast', 'total_valid_votes', 'rejected_ballots'], severity: 'WARNING', message: 'Total votes cast should equal valid votes plus rejected ballots where both are printed. Confirm against the approved 2027 form arithmetic.', reference: `Form ${form} (pending 2027 confirmation)` },
    { key: 'VOTES_CAST_NOT_ABOVE_REGISTERED', version: 1, type: 'LESS_OR_EQUAL', fields: ['total_votes_cast', 'registered_voters'], severity: 'WARNING', message: 'Total votes cast exceeds registered voters; flag for human review. Do not exclude automatically.', reference: 'Blueprint 8.4 turnout check' },
    { key: 'STAMP_OBSERVED', version: 1, type: 'REQUIRED_OBSERVATION', fields: ['stamp_present'], severity: 'WARNING', message: 'Reviewer has not observed an official stamp. Record the observation; this is not an authenticity check.', reference: 'Blueprint 8.4 visible required fields' },
  ],
});

const collationFields = (level: string): FormFieldSchema => ({
  schemaVersion: 1,
  fields: [
    { key: 'registered_voters', label: `Registered voters (${level})`, kind: 'INTEGER', section: 'STATION_COUNTS', required: false, perCandidate: false, min: 0, observationOnly: false },
    { key: 'candidate_votes', label: `Total valid votes per candidate (${level})`, kind: 'CANDIDATE_VOTES', section: 'CANDIDATE_FIGURES', required: true, perCandidate: true, min: 0, observationOnly: false },
    { key: 'total_valid_votes', label: `Total valid votes (${level})`, kind: 'INTEGER', section: 'CANDIDATE_FIGURES', required: true, perCandidate: false, min: 0, observationOnly: false },
    { key: 'rejected_ballots', label: `Rejected ballots (${level})`, kind: 'INTEGER', section: 'STATION_COUNTS', required: false, perCandidate: false, min: 0, observationOnly: false },
    { key: 'total_votes_cast', label: `Total votes cast (${level})`, kind: 'INTEGER', section: 'STATION_COUNTS', required: false, perCandidate: false, min: 0, observationOnly: false },
    { key: 'stations_count', label: 'Number of polling stations included', kind: 'INTEGER', section: 'STATION_COUNTS', required: false, perCandidate: false, min: 0, observationOnly: false },
    { key: 'returning_officer_name', label: 'Name of returning officer (as printed)', kind: 'TEXT', section: 'DECLARATION', required: false, perCandidate: false, observationOnly: false },
    { key: 'stamp_present', label: 'Official stamp visible', kind: 'BOOLEAN_OBSERVATION', section: 'OBSERVATIONS', required: false, perCandidate: false, observationOnly: true },
  ],
});

const collationRules = (form: string): ValidationRules => ({
  rulesVersion: 1,
  rules: [
    { key: 'NON_NEGATIVE_COUNTS', version: 1, type: 'NON_NEGATIVE', fields: ['candidate_votes', 'total_valid_votes', 'rejected_ballots', 'total_votes_cast', 'registered_voters'], severity: 'FAIL', message: 'Vote counts must be whole numbers of zero or more.', reference: `Form ${form}` },
    { key: 'CANDIDATES_SUM_TO_TOTAL_VALID', version: 1, type: 'SUM_EQUALS', fields: ['total_valid_votes', 'candidate_votes'], severity: 'FAIL', message: 'Sum of candidate votes must equal total valid votes.', reference: `Form ${form}` },
    { key: 'VOTES_CAST_NOT_ABOVE_REGISTERED', version: 1, type: 'LESS_OR_EQUAL', fields: ['total_votes_cast', 'registered_voters'], severity: 'WARNING', message: 'Total votes cast exceeds registered voters; flag for human review.', reference: 'Blueprint 8.4' },
  ],
});

export interface TemplateSeed {
  formNumber: string;
  formLevel: 'POLLING_STATION' | 'CONSTITUENCY' | 'COUNTY';
  title: string;
  fieldSchema: FormFieldSchema;
  validationRules: ValidationRules;
  officialSource: string;
}

export const GOVERNOR_TEMPLATES: TemplateSeed[] = [
  { formNumber: '37A', formLevel: 'POLLING_STATION', title: 'Form 37A: County Governor election results at the polling station', fieldSchema: stationFields, validationRules: stationRules('37A'), officialSource: `${LEGAL_BASELINE}; regulation 79(2)` },
  { formNumber: '37B', formLevel: 'CONSTITUENCY', title: 'Form 37B: Collation of County Governor results at the constituency tallying centre', fieldSchema: collationFields('constituency'), validationRules: collationRules('37B'), officialSource: `${LEGAL_BASELINE}; regulation 83` },
  { formNumber: '37C', formLevel: 'COUNTY', title: 'Form 37C: Declaration of County Governor results at the county tallying centre', fieldSchema: collationFields('county'), validationRules: collationRules('37C'), officialSource: `${LEGAL_BASELINE}; regulation 87` },
];

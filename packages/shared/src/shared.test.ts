import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import * as enums from './enums';
import * as office from './office/enums';
import {
  ALL_PERMISSION_KEYS,
  PERMISSION_DEFINITIONS,
  hasModuleAccess,
} from './permissions';
import { SYSTEM_ROLES } from './roles';
import {
  PARALLEL_TALLY_BANNER,
  PARALLEL_TALLY_DISCLAIMER,
  findForbiddenTallyLanguage,
} from './disclaimer';
import { canTransitionSubmission } from './enums';

describe('permissions', () => {
  it('has a definition for every key and no duplicates', () => {
    const defined = PERMISSION_DEFINITIONS.map((p) => p.key);
    expect(new Set(defined).size).toBe(defined.length);
    expect([...defined].sort()).toEqual([...ALL_PERMISSION_KEYS].sort());
  });

  it('system roles reference only known permissions', () => {
    for (const role of SYSTEM_ROLES) {
      for (const p of role.permissions) expect(ALL_PERMISSION_KEYS).toContain(p);
    }
  });

  it('roles holding high-risk permissions require MFA', () => {
    const highRisk = new Set(PERMISSION_DEFINITIONS.filter((p) => p.highRisk).map((p) => p.key));
    for (const role of SYSTEM_ROLES) {
      if (role.permissions.some((p) => highRisk.has(p))) expect(role.mfaRequired).toBe(true);
    }
  });

  it('nav module access derives from permission prefixes', () => {
    expect(hasModuleAccess(['tally.submit'], 'tally')).toBe(true);
    expect(hasModuleAccess(['dashboard.view'], 'tally')).toBe(false);
  });

  it('no role combines submit and verify for tally', () => {
    for (const role of SYSTEM_ROLES) {
      const p = new Set<string>(role.permissions);
      expect(p.has('tally.submit') && p.has('tally.verify')).toBe(false);
      expect(p.has('tally.verify') && p.has('tally.approve')).toBe(false);
    }
  });
});

describe('parallel tally language', () => {
  it('canonical banner and disclaimer pass the guard', () => {
    expect(findForbiddenTallyLanguage(`${PARALLEL_TALLY_BANNER}. ${PARALLEL_TALLY_DISCLAIMER}`)).toBeNull();
  });
  it('flags winner/elected language', () => {
    expect(findForbiddenTallyLanguage('Candidate A is the projected winner')).toBe('winner');
    expect(findForbiddenTallyLanguage('Declared governor')).toBe('Declared');
  });
});

describe('submission workflow', () => {
  it('cannot jump from draft to verified', () => {
    expect(canTransitionSubmission('DRAFT', 'VERIFIED')).toBe(false);
    expect(canTransitionSubmission('SECOND_REVIEW_PENDING', 'VERIFIED')).toBe(true);
    expect(canTransitionSubmission('ARCHIVED', 'DRAFT')).toBe(false);
  });
});

describe('enum parity with Prisma schema', () => {
  const schema = readFileSync(join(__dirname, '../../db/prisma/schema.prisma'), 'utf8');
  const prismaEnums = new Map<string, string[]>();
  for (const m of schema.matchAll(/enum\s+(\w+)\s*\{([^}]*)\}/g)) {
    const values = m[2]!
      .split('\n')
      .map((l) => l.replace(/\/\/.*$/, '').trim())
      .filter(Boolean);
    prismaEnums.set(m[1]!, values);
  }
  const pairs: Array<[string, readonly string[]]> = [
    ['TenantType', enums.TENANT_TYPES],
    ['TenantStatus', enums.TENANT_STATUSES],
    ['UserStatus', enums.USER_STATUSES],
    ['MfaFactorType', enums.MFA_FACTOR_TYPES],
    ['MfaFactorStatus', enums.MFA_FACTOR_STATUSES],
    ['ScopeType', enums.SCOPE_TYPES],
    ['SensitivityLevel', enums.SENSITIVITY_LEVELS],
    ['AuditActorType', enums.AUDIT_ACTOR_TYPES],
    ['DataProvenance', enums.DATA_PROVENANCES],
    ['ElectionCycleStatus', enums.ELECTION_CYCLE_STATUSES],
    ['GeographicUnitType', enums.GEOGRAPHIC_UNIT_TYPES],
    ['RegistryVersionStatus', enums.REGISTRY_VERSION_STATUSES],
    ['PollingStationStatus', enums.POLLING_STATION_STATUSES],
    ['TallyCentreLevel', enums.TALLY_CENTRE_LEVELS],
    ['OfficeType', enums.OFFICE_TYPES],
    ['ContestStatus', enums.CONTEST_STATUSES],
    ['FormLevel', enums.FORM_LEVELS],
    ['FormTemplateApprovalState', enums.FORM_TEMPLATE_APPROVAL_STATES],
    ['OperationalStatus', enums.OPERATIONAL_STATUSES],
    ['SubmissionStatus', enums.SUBMISSION_STATUSES],
    ['SubmissionSourceType', enums.SUBMISSION_SOURCE_TYPES],
    ['ImageQuality', enums.IMAGE_QUALITY_LEVELS],
    ['ResultValueChangeSource', enums.RESULT_VALUE_CHANGE_SOURCES],
    ['OcrExtractionStatus', enums.OCR_EXTRACTION_STATUSES],
    ['ValidationOutcome', enums.VALIDATION_OUTCOMES],
    ['VerificationDecision', enums.VERIFICATION_DECISIONS],
    ['SupervisorAction', enums.SUPERVISOR_ACTIONS],
    ['DiscrepancyType', enums.DISCREPANCY_TYPES],
    ['DiscrepancySeverity', enums.DISCREPANCY_SEVERITIES],
    ['DiscrepancyStatus', enums.DISCREPANCY_STATUSES],
    ['DiscrepancyLinkRole', enums.DISCREPANCY_LINK_ROLES],
    ['StoredFilePurpose', enums.STORED_FILE_PURPOSES],
    ['MalwareScanStatus', enums.MALWARE_SCAN_STATUSES],
    ['StorageDriverKind', enums.STORAGE_DRIVERS],
    ['ExportFormat', enums.EXPORT_FORMATS],
    ['IncidentStatus', enums.INCIDENT_STATUSES],
    ['IncidentPriority', enums.INCIDENT_PRIORITIES],
    ['NotificationChannel', enums.NOTIFICATION_CHANNELS],
    // NGAO360 Office
    ['ContactPreference', office.CONTACT_PREFERENCES],
    ['VerificationStatus', office.VERIFICATION_STATUSES],
    ['CorrespondenceDirection', office.CORRESPONDENCE_DIRECTIONS],
    ['CorrespondenceChannel', office.CORRESPONDENCE_CHANNELS],
    ['CorrespondenceCategory', office.CORRESPONDENCE_CATEGORIES],
    ['CorrespondenceStatus', office.CORRESPONDENCE_STATUSES],
    ['AppointmentSource', office.APPOINTMENT_SOURCES],
    ['AppointmentStatus', office.APPOINTMENT_STATUSES],
    ['MeetingStatus', office.MEETING_STATUSES],
    ['ActionItemStatus', office.ACTION_ITEM_STATUSES],
    ['CaseCategory', office.CASE_CATEGORIES],
    ['CaseSource', office.CASE_SOURCES],
    ['CasePriority', office.CASE_PRIORITIES],
    ['CaseStatus', office.CASE_STATUSES],
    ['CaseClosureReason', office.CASE_CLOSURE_REASONS],
    ['CaseEventType', office.CASE_EVENT_TYPES],
    ['CaseEventVisibility', office.CASE_EVENT_VISIBILITIES],
    ['CaseEventActorType', office.CASE_EVENT_ACTOR_TYPES],
    ['ReferralStatus', office.REFERRAL_STATUSES],
    ['InstitutionType', office.INSTITUTION_TYPES],
    ['ProjectCategory', office.PROJECT_CATEGORIES],
    ['CommitmentSource', office.COMMITMENT_SOURCES],
    ['FundingSource', office.FUNDING_SOURCES],
    ['ProjectStatus', office.PROJECT_STATUSES],
    ['MilestoneStatus', office.MILESTONE_STATUSES],
    ['ProjectEvidenceType', office.PROJECT_EVIDENCE_TYPES],
  ];
  it.each(pairs)('%s matches', (name, values) => {
    expect(prismaEnums.get(name)).toEqual([...values]);
  });
});

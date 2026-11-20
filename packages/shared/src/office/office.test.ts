import { describe, expect, it } from 'vitest';
import { PERMISSION_DEFINITIONS, hasModuleAccess } from '../permissions';
import { OFFICE_ROLE_KEYS, SYSTEM_ROLES } from '../roles';
import { effectiveModules } from '../modules';
import {
  CASE_STATUSES,
  CITIZEN_FEEDBACK_LABELS,
  CASE_STATUS_PUBLIC_STAGE,
  CASE_STATUS_TRANSITIONS,
  PROJECT_STAGE_KIND,
  PROJECT_STATUSES,
  PROJECT_STATUS_TRANSITIONS,
  canTransitionCase,
  canTransitionProject,
  completionEvidenceSufficient,
} from './enums';
import { PublicCaseSubmissionSchema } from './public';
import { CaseContactInputSchema, CreateCaseSchema } from './cases';
import { CreateCorrespondenceSchema } from './correspondence';
import { OfficeModuleConfigSchema } from './common';
import { CURRENT_PORTAL_PRIVACY_NOTICE_VERSION, portalPrivacyNotice } from './privacy';
import { PUBLIC_REFERENCE_PATTERN, formatPublicReference, formatTrackingCode } from './references';
import { UpdateProjectPublicationSchema } from './projects';
import { OfficeGeographySchema, OfficePrivacyNoticesSchema, PossibleDuplicateSchema } from './workspace';

const officeRoles = SYSTEM_ROLES.filter((r) => OFFICE_ROLE_KEYS.includes(r.key));

describe('office roles and permissions', () => {
  it('defines the five office roles', () => {
    expect(officeRoles.map((r) => r.name).sort()).toEqual(
      ['Case officer', 'Correspondence clerk', 'Office administrator', 'Projects officer', 'Public-information editor'].sort(),
    );
  });

  it('office roles hold no campaign, tally or reference permissions (blueprint 15.2)', () => {
    for (const role of officeRoles) {
      for (const p of role.permissions) {
        expect(p.startsWith('tally.') || p.startsWith('reference.') || p.startsWith('forms.') || p.startsWith('incidents.')).toBe(false);
      }
    }
  });

  it('tally and campaign roles hold no office write permissions', () => {
    for (const role of SYSTEM_ROLES.filter((r) => !OFFICE_ROLE_KEYS.includes(r.key))) {
      const writes = role.permissions.filter((p) => p.startsWith('office.') && !p.endsWith('.view'));
      expect(writes).toEqual([]);
    }
  });

  it('nobody who edits projects or uploads evidence can also verify them by role', () => {
    for (const role of SYSTEM_ROLES) {
      const p = new Set<string>(role.permissions);
      expect(p.has('office.projects.evidence') && p.has('office.projects.verify')).toBe(false);
      expect(p.has('office.projects.edit') && p.has('office.projects.verify')).toBe(false);
    }
  });

  it('case officers cannot close cases; closing sits with the office administrator', () => {
    expect(SYSTEM_ROLES.find((r) => r.key === 'CASE_OFFICER')!.permissions).not.toContain('office.cases.close');
    expect(SYSTEM_ROLES.find((r) => r.key === 'OFFICE_ADMINISTRATOR')!.permissions).toContain('office.cases.close');
  });

  it('verify and publish are high risk', () => {
    const hr = PERMISSION_DEFINITIONS.filter((d) => d.highRisk).map((d) => d.key);
    expect(hr).toEqual(expect.arrayContaining(['office.projects.verify', 'office.projects.publish']));
  });

  it('office is a navigation module', () => {
    expect(hasModuleAccess(['office.cases.view'], 'office')).toBe(true);
    expect(hasModuleAccess(['tally.view'], 'office')).toBe(false);
  });
});

describe('tenant modules', () => {
  it('office is off and tally on by default; rows override defaults', () => {
    expect(effectiveModules([])).toEqual(['tally']);
    expect(effectiveModules([{ moduleKey: 'office', enabled: true }])).toEqual(['tally', 'office']);
    expect(effectiveModules([{ moduleKey: 'tally', enabled: false }])).toEqual([]);
  });

  it('office config parses with safe defaults (portal off, second person closes)', () => {
    const cfg = OfficeModuleConfigSchema.parse({});
    expect(cfg.publicPortalEnabled).toBe(false);
    expect(cfg.caseCloseRequiresSecondPerson).toBe(true);
    expect(cfg.captchaProvider).toBe('none');
  });
});

describe('case workflow', () => {
  it('every status has transitions and a public stage', () => {
    for (const s of CASE_STATUSES) {
      expect(CASE_STATUS_TRANSITIONS[s]).toBeDefined();
      expect(CASE_STATUS_PUBLIC_STAGE[s]).toBeDefined();
    }
  });
  it('reopening is a transition, not a deletion; closed cases only reopen', () => {
    expect(CASE_STATUS_TRANSITIONS.CLOSED).toEqual(['REOPENED']);
    expect(canTransitionCase('SUBMITTED', 'CLOSED')).toBe(true);
    expect(canTransitionCase('SUBMITTED', 'RESOLUTION_PROPOSED')).toBe(false);
  });
});

describe('project accountability', () => {
  it('status kinds distinguish commitment, approval and verified completion', () => {
    expect(PROJECT_STAGE_KIND.COMMITTED).toBe('COMMITMENT');
    expect(PROJECT_STAGE_KIND.APPROVED).toBe('APPROVED');
    expect(PROJECT_STAGE_KIND.COMPLETED).toBe('REPORTED_COMPLETE');
    expect(PROJECT_STAGE_KIND.VERIFIED_COMPLETED).toBe('VERIFIED_COMPLETE');
    for (const s of PROJECT_STATUSES) expect(PROJECT_STATUS_TRANSITIONS[s]).toBeDefined();
  });
  it('verified completion is only reachable from reported completion', () => {
    for (const s of PROJECT_STATUSES) {
      expect(canTransitionProject(s, 'VERIFIED_COMPLETED')).toBe(s === 'COMPLETED');
    }
  });
  it('a photograph alone is not proof of completion', () => {
    expect(completionEvidenceSufficient([{ type: 'PHOTO', verificationStatus: 'VERIFIED' }])).toBe(false);
    expect(completionEvidenceSufficient([{ type: 'INSPECTION_REPORT', verificationStatus: 'UNVERIFIED' }])).toBe(false);
    expect(
      completionEvidenceSufficient([
        { type: 'PHOTO', verificationStatus: 'VERIFIED' },
        { type: 'COMPLETION_CERTIFICATE', verificationStatus: 'VERIFIED' },
      ]),
    ).toBe(true);
  });
  it('publication fields are validated', () => {
    expect(UpdateProjectPublicationSchema.safeParse({ isPublic: true, publicFields: ['budgetSecret'], reason: 'Publish', expectedVersion: 0 }).success).toBe(false);
  });
});

describe('public portal contracts', () => {
  const base = {
    category: 'WATER_SANITATION',
    description: 'The borehole at the market has not worked for two weeks.',
    privacyNoticeVersion: CURRENT_PORTAL_PRIVACY_NOTICE_VERSION,
    privacyNoticeAcknowledged: true,
  };
  it('accepts an anonymous submission without contact details', () => {
    const r = PublicCaseSubmissionSchema.safeParse(base);
    expect(r.success).toBe(true);
  });
  it('requires consent and a number when asking to be phoned', () => {
    expect(PublicCaseSubmissionSchema.safeParse({ ...base, contactPreference: 'PHONE' }).success).toBe(false);
    expect(PublicCaseSubmissionSchema.safeParse({ ...base, contactPreference: 'PHONE', phone: '0712 345678' }).success).toBe(false);
    expect(
      PublicCaseSubmissionSchema.safeParse({ ...base, contactPreference: 'PHONE', phone: '0712 345678', consentToContact: true }).success,
    ).toBe(true);
  });
  it('requires acknowledging the privacy notice', () => {
    expect(PublicCaseSubmissionSchema.safeParse({ ...base, privacyNoticeAcknowledged: false }).success).toBe(false);
  });
  it('privacy notice covers what, why, who, how long and rights', () => {
    const n = portalPrivacyNotice({ controllerName: 'Office X', dataProtectionContact: 'dpo@example.org', caseRetentionMonths: 36, contactRetentionMonths: 12 });
    expect(n.sections.map((s) => s.heading)).toEqual(
      expect.arrayContaining(['What we collect', 'Why we collect it', 'Who receives it', 'How long we keep it', 'Your rights']),
    );
  });
  it('public references are random-format and well formed', () => {
    const bytes = new Uint8Array([1, 2, 3, 4, 250, 251, 252, 253]);
    const ref = formatPublicReference('BGM', bytes);
    expect(ref).toMatch(PUBLIC_REFERENCE_PATTERN);
    expect(formatTrackingCode(bytes)).toHaveLength(8);
    expect(() => formatPublicReference('bgm', bytes)).toThrow();
  });
});

describe('staff DTOs', () => {
  it('incoming correspondence needs a sender and received date', () => {
    expect(CreateCorrespondenceSchema.safeParse({ direction: 'INCOMING', channel: 'POST', category: 'GENERAL', subject: 'Letter' }).success).toBe(false);
    expect(
      CreateCorrespondenceSchema.safeParse({
        direction: 'INCOMING',
        channel: 'POST',
        category: 'GENERAL',
        subject: 'Letter',
        senderOrganisation: 'Ministry',
        receivedAt: '2026-11-01T08:00:00Z',
      }).success,
    ).toBe(true);
  });
  it('staff cases cannot claim the portal as source', () => {
    expect(
      CreateCaseSchema.safeParse({ source: 'PORTAL', category: 'HEALTH', title: 'Clinic', description: 'No drugs at the clinic', privacyNoticeVersion: 'v' }).success,
    ).toBe(false);
  });
  it('contact preference needs the matching detail', () => {
    expect(CaseContactInputSchema.safeParse({ preference: 'EMAIL' }).success).toBe(false);
    expect(CaseContactInputSchema.safeParse({ preference: 'NONE' }).success).toBe(true);
  });
});

describe('office form-support schemas (§9a)', () => {
  const id = '6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b';
  it('accepts a geography and privacy notices response', () => {
    expect(
      OfficeGeographySchema.safeParse({
        county: { id, name: 'Bungoma' },
        constituencies: [{ id, name: 'Kanduyi' }],
        wards: [{ id, name: 'Township', constituencyId: id }],
      }).success,
    ).toBe(true);
    const notice = portalPrivacyNotice({ controllerName: 'Office', dataProtectionContact: 'dpo@example.org', caseRetentionMonths: 24, contactRetentionMonths: 12 });
    expect(OfficePrivacyNoticesSchema.safeParse({ portal: notice, appointment: notice }).success).toBe(true);
  });
  it('bounds the duplicate similarity score', () => {
    const base = { id, reference: 'CASE-2026-000001', publicReference: 'BGM-ABCD-EFGH', title: 't', status: 'SUBMITTED', submittedAt: '2026-11-01T08:00:00Z' };
    expect(PossibleDuplicateSchema.safeParse({ ...base, similarity: 0.4 }).success).toBe(true);
    expect(PossibleDuplicateSchema.safeParse({ ...base, similarity: 1.4 }).success).toBe(false);
  });
  it('labels every citizen feedback response', () => {
    expect(Object.keys(CITIZEN_FEEDBACK_LABELS).sort()).toEqual(['ADDITIONAL_INFORMATION', 'CONFIRM_RESOLVED', 'DISPUTE']);
  });
});

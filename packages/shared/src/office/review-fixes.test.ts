import { describe, expect, it } from 'vitest';
import { PERMISSION_DEFINITIONS } from '../permissions';
import { SYSTEM_ROLES } from '../roles';
import {
  CASE_CLOSURE_REASONS,
  CASE_STATUSES,
  PROJECT_STATUSES,
  caseClosureAllowed,
  canTransitionCase,
  projectStatusNeedsApproval,
} from './enums';
import { portalPrivacyNotice } from './privacy';
import { publicFacingProjectChanges } from './projects';

describe('case closure without a fabricated resolution', () => {
  it('allows non-resolution closures from every open working state', () => {
    for (const s of ['ASSIGNED', 'IN_PROGRESS', 'REFERRED', 'REOPENED'] as const) {
      expect(canTransitionCase(s, 'CLOSED')).toBe(true);
      for (const r of CASE_CLOSURE_REASONS.filter((x) => x !== 'RESOLVED')) expect(caseClosureAllowed(s, r)).toBe(true);
      expect(caseClosureAllowed(s, 'RESOLVED')).toBe(false);
    }
  });
  it('allows "resolved" only after a resolution was proposed', () => {
    const allowed = CASE_STATUSES.filter((s) => caseClosureAllowed(s, 'RESOLVED'));
    expect(allowed.sort()).toEqual(['CITIZEN_FEEDBACK', 'RESOLUTION_PROPOSED']);
    expect(CASE_STATUSES.some((s) => s === 'CLOSED' && caseClosureAllowed(s, 'WITHDRAWN'))).toBe(false);
  });
});

describe('approval authority', () => {
  it('is required from the approved stage on, never for commitments', () => {
    expect(PROJECT_STATUSES.filter((s) => !projectStatusNeedsApproval(s)).sort()).toEqual(['CANCELLED', 'COMMITTED', 'PROPOSED']);
  });
});

describe('publication approval covers what published fields say', () => {
  it('flags always-public fields and approved optional sections only', () => {
    expect(publicFacingProjectChanges(['name', 'trackingOfficerId'], [])).toEqual(['name']);
    expect(publicFacingProjectChanges(['ownerName', 'allocationSource'], [])).toEqual([]);
    expect(publicFacingProjectChanges(['ownerName'], ['projectOwner'])).toEqual(['ownerName']);
    expect(publicFacingProjectChanges(['delayReason', 'expectedCompletionDate'], ['schedule'])).toEqual(['delayReason', 'expectedCompletionDate']);
    expect(publicFacingProjectChanges(['milestones'], ['milestones'])).toEqual(['milestones']);
    expect(publicFacingProjectChanges(['latitude'], ['description'])).toEqual([]);
  });
});

describe('confidential citizen cases', () => {
  it('have their own high-risk permission held only by the office administrator', () => {
    expect(PERMISSION_DEFINITIONS.find((p) => p.key === 'office.cases.confidential')?.highRisk).toBe(true);
    const holders = SYSTEM_ROLES.filter((r) => r.permissions.includes('office.cases.confidential')).map((r) => r.key);
    expect(holders).toContain('OFFICE_ADMINISTRATOR');
    expect(holders).not.toContain('CASE_OFFICER');
  });
});

describe('portal privacy notice', () => {
  it('states that no IP or device data is kept and what retention removes', () => {
    const n = portalPrivacyNotice({ controllerName: 'Synthetic office', dataProtectionContact: 'dp@example.org', caseRetentionMonths: 36, contactRetentionMonths: 12 });
    const text = n.sections.map((s) => s.body).join(' ');
    expect(text).toMatch(/do not keep your IP address or device details/);
    expect(text).toMatch(/location data hidden in photos/);
    expect(text).toMatch(/36 months after closure, your description, messages and photo are removed/);
  });
});

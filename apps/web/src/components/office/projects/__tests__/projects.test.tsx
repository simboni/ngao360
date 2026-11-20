/**
 * S26/S27 project logic and rendering tests: accountability wording,
 * verification separation of duties, photo-is-not-proof, and the public preview.
 * Run: pnpm --filter @ngao360/web exec tsx --tsconfig src/components/office/projects/__tests__/tsconfig.json --test src/components/office/projects/__tests__/*.test.tsx
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { PROJECT_PUBLIC_DISCLAIMER, PROJECT_STATUSES, type ProjectDetail, type ProjectEvidence, type ProjectSummary } from '@ngao360/shared';
import { renderToStaticMarkup } from 'react-dom/server';
import { ProjectStatusBadge, StageKindBadge } from '../project-badges';
import { projectTransitionTargets } from '../project-dialogs';
import { projectBody } from '../project-form-dialog';
import {
  buildPublicPreview,
  citableCompletionEvidence,
  completionLabel,
  completionVerifyState,
  evidenceVerifyBlock,
  formatMoney,
  groupByLocation,
  publicDiff,
  publicFieldBlock,
  spendShare,
} from '../project-model';
import { PublicPreview } from '../publication-panel';

const ME = '00000000-0000-4000-8000-0000000000a1';
const OTHER = '00000000-0000-4000-8000-0000000000a2';
const u = (id: string, displayName = 'Synthetic User') => ({ id, displayName });
const file = {
  id: '00000000-0000-4000-8000-0000000000f1',
  originalFilename: 'report.pdf',
  mimeType: 'application/pdf',
  sizeBytes: 1000,
  sha256: 'a'.repeat(64),
  malwareScanStatus: 'SKIPPED' as const,
  uploadedBy: u(OTHER),
  createdAt: '2026-11-01T00:00:00Z',
};

function ev(over: Partial<ProjectEvidence>): ProjectEvidence {
  return {
    id: '00000000-0000-4000-8000-0000000000e1',
    projectId: '00000000-0000-4000-8000-0000000000p1'.replace('p', 'c'),
    milestoneId: null,
    type: 'PHOTO',
    description: 'Synthetic site photo',
    capturedOn: '2026-11-01',
    sourceDescription: null,
    file,
    uploadedBy: u(OTHER),
    uploadedAt: '2026-11-01T00:00:00Z',
    latitude: null,
    longitude: null,
    verificationStatus: 'VERIFIED',
    verifiedBy: null,
    verifiedAt: null,
    verificationNote: null,
    isPublic: false,
    ...over,
  };
}

const inst = { id: '00000000-0000-4000-8000-0000000000d1', name: 'Synthetic County Department of Water', shortName: 'Water', type: 'COUNTY_DEPARTMENT' as const };

function project(over: Partial<ProjectDetail> = {}): ProjectDetail {
  return {
    id: '00000000-0000-4000-8000-0000000000c1',
    reference: 'PRJ-2026-000001',
    name: 'Synthetic borehole, Kimilili ward',
    category: 'WATER_SANITATION',
    status: 'COMPLETED',
    stageKind: 'REPORTED_COMPLETE',
    location: { county: null, constituency: { id: '00000000-0000-4000-8000-0000000000b1', name: 'Kimilili', type: 'CONSTITUENCY' }, ward: null, description: null },
    responsibleInstitution: inst,
    implementingAgency: null,
    commitmentSource: 'COUNTY_INTEGRATED_DEVELOPMENT_PLAN',
    fundingSource: 'COUNTY_GOVERNMENT',
    currency: 'KES',
    approvedAllocation: '12500000',
    expenditureReported: '6250000.50',
    expenditureVerificationStatus: 'UNVERIFIED',
    expectedCompletionDate: null,
    currentMilestone: null,
    evidenceCount: 0,
    verifiedEvidenceCount: 0,
    isPublic: false,
    updatedAt: '2026-11-19T00:00:00Z',
    description: 'Internal description',
    latitude: null,
    longitude: null,
    ownerName: null,
    trackingOfficer: null,
    approvalAuthority: null,
    commitmentSourceDetail: 'CIDP 2023-2027 (synthetic)',
    fundingSourceDetail: null,
    allocationSource: null,
    contractAmount: '11000000',
    contractAmountIsPublic: false,
    expenditureSource: 'Synthetic ledger',
    expenditureAsOf: '2026-10-31',
    expenditureVerifiedBy: null,
    expenditureVerifiedAt: null,
    startDate: null,
    actualCompletionDate: '2026-11-10',
    delayReason: null,
    completion: { reportedBy: u(OTHER), reportedAt: '2026-11-10T00:00:00Z', verifiedBy: null, verifiedAt: null, verificationNote: null },
    publication: { isPublic: false, publicFields: [], publicSummary: null, publishedBy: null, publishedAt: null },
    milestones: [],
    evidence: [],
    createdBy: u(OTHER),
    createdAt: '2026-01-01T00:00:00Z',
    allowedActions: ['verify_completion'],
    version: 3,
    ...over,
  };
}

describe('verification separation of duties', () => {
  it('disables evidence verification for the uploader, with the reason', () => {
    assert.match(evidenceVerifyBlock(ev({ uploadedBy: u(ME), verificationStatus: 'UNVERIFIED' }), ME, true) ?? '', /You uploaded this item/);
    assert.equal(evidenceVerifyBlock(ev({ verificationStatus: 'UNVERIFIED' }), ME, true), null);
    assert.match(evidenceVerifyBlock(ev({ verificationStatus: 'UNVERIFIED' }), ME, false) ?? '', /permission/);
  });
  it('blocks completion verification by the person who reported completion', () => {
    const s = completionVerifyState(project({ completion: { ...project().completion, reportedBy: u(ME) }, evidence: [ev({ type: 'INSPECTION_REPORT' })] }), ME, true);
    assert.equal(s.enabled, false);
    assert.ok(s.reasons.some((r) => r.includes('You reported the completion')));
  });
  it('never accepts photographs alone as proof of completion', () => {
    const s = completionVerifyState(project({ evidence: [ev({ type: 'PHOTO' }), ev({ id: '00000000-0000-4000-8000-0000000000e2', type: 'PHOTO' })] }), ME, true);
    assert.equal(s.enabled, false);
    assert.ok(s.reasons.some((r) => r.includes('A photograph alone is not proof of completion')));
  });
  it('does not let a verifier cite evidence they uploaded', () => {
    const p = project({ evidence: [ev({ type: 'COMPLETION_CERTIFICATE', uploadedBy: u(ME) })] });
    assert.deepEqual(citableCompletionEvidence(p, ME), []);
    assert.equal(completionVerifyState(p, ME, true).enabled, false);
  });
  it('allows verification with a verified inspection report from someone else', () => {
    const p = project({ evidence: [ev({ type: 'INSPECTION_REPORT' }), ev({ id: '00000000-0000-4000-8000-0000000000e3', type: 'PHOTO' })] });
    assert.deepEqual(completionVerifyState(p, ME, true), { enabled: true, reasons: [] });
    assert.equal(citableCompletionEvidence(p, ME).length, 1);
  });
  it('requires the project to be reported complete first', () => {
    assert.ok(completionVerifyState(project({ status: 'ONGOING', evidence: [ev({ type: 'INSPECTION_REPORT' })] }), ME, true).reasons.some((r) => r.includes('reported complete')));
  });
});

describe('status wording distinguishes commitment, approval and verified completion', () => {
  it('never calls a reported completion "complete" without a qualifier', () => {
    assert.equal(completionLabel('COMPLETED'), 'Reported complete — awaiting independent verification');
    assert.equal(completionLabel('VERIFIED_COMPLETED'), 'Completion verified');
    assert.equal(completionLabel('ONGOING'), 'Not complete');
    assert.match(renderToStaticMarkup(<StageKindBadge stage="COMMITMENT" />), /Commitment — not yet an approved project/);
    assert.match(renderToStaticMarkup(<ProjectStatusBadge status="COMPLETED" />), /not yet verified/);
  });
  it('never offers VERIFIED_COMPLETED as a plain status change', () => {
    for (const s of PROJECT_STATUSES) assert.ok(!projectTransitionTargets(s).includes('VERIFIED_COMPLETED'));
    assert.deepEqual(projectTransitionTargets('COMPLETED'), ['ONGOING']);
  });
});

describe('public preview (field-level approval)', () => {
  it('always shows the mandatory accountability fields and the disclaimer', () => {
    const pv = buildPublicPreview(project(), [], [], '');
    assert.equal(pv.responsibleInstitution.name, inst.name);
    assert.equal(pv.commitmentSourceLabel, 'County Integrated Development Plan');
    assert.equal(pv.completionVerificationLabel, 'Reported complete — awaiting independent verification');
    assert.equal(pv.disclaimer, PROJECT_PUBLIC_DISCLAIMER);
    assert.equal(pv.description, undefined, 'optional fields are absent unless approved');
    assert.equal(pv.expenditure, undefined);
  });
  it('keeps a non-public contract amount out even when selected', () => {
    assert.equal(buildPublicPreview(project(), ['contractAmount'], [], '').contractAmount, undefined);
    assert.equal(buildPublicPreview(project({ contractAmountIsPublic: true }), ['contractAmount'], [], '').contractAmount, '11000000');
    assert.match(publicFieldBlock('contractAmount', project()) ?? '', /not recorded as a matter of public record/);
  });
  it('publishes only selected, verified evidence', () => {
    const p = project({ evidence: [ev({ id: '00000000-0000-4000-8000-0000000000e4' }), ev({ id: '00000000-0000-4000-8000-0000000000e5', verificationStatus: 'DISPUTED' })] });
    const pv = buildPublicPreview(p, ['evidence'], ['00000000-0000-4000-8000-0000000000e4', '00000000-0000-4000-8000-0000000000e5'], '');
    assert.deepEqual(
      pv.evidence?.map((e) => e.id),
      ['00000000-0000-4000-8000-0000000000e4'],
    );
  });
  it('uses the public summary over the internal description', () => {
    assert.equal(buildPublicPreview(project(), ['description'], [], 'Public text').description, 'Public text');
    assert.equal(buildPublicPreview(project(), ['description'], [], '').description, 'Internal description');
    assert.equal(buildPublicPreview(project(), [], [], 'Public text').description, 'Public text');
  });
  it('lists what would change against the saved view', () => {
    const saved = buildPublicPreview(project(), [], [], '');
    assert.deepEqual(publicDiff(saved, buildPublicPreview(project(), ['fundingSource'], [], '')), ['fundingSourceLabel']);
  });
  it('renders without staff names and with the responsible institution', () => {
    const html = renderToStaticMarkup(<PublicPreview data={buildPublicPreview(project(), ['expenditure', 'milestones'], [], '')} published={false} />);
    assert.match(html, /Responsible institution: Synthetic County Department of Water/);
    assert.match(html, /Not published/);
    assert.doesNotMatch(html, /Synthetic User/);
  });
});

describe('finance, location and form helpers', () => {
  it('formats decimal-string money without float drift', () => {
    assert.equal(formatMoney('12500000'), 'KES 12,500,000');
    assert.equal(formatMoney('6250000.5'), 'KES 6,250,000.50');
    assert.equal(formatMoney(null), '—');
    assert.equal(spendShare('6250000', '12500000'), 50);
    assert.equal(spendShare(null, '1'), null);
  });
  it('groups projects by constituency and ward', () => {
    const p = project() as ProjectSummary;
    const g = groupByLocation([p, { ...p, id: 'x', location: { ...p.location, constituency: null, county: null } }]);
    assert.deepEqual(
      g.map((x) => x.constituency),
      ['Kimilili', 'No location recorded'],
    );
    assert.equal(g[0]!.wards[0]!.ward, 'Whole constituency');
  });
  it('sends only changed fields when editing', () => {
    const base = {
      name: 'A',
      description: '',
      category: 'HEALTH',
      geographicUnitId: '',
      locationDescription: '',
      latitude: '',
      longitude: '',
      responsibleInstitutionId: inst.id,
      implementingAgencyId: '',
      ownerName: '',
      trackingOfficerId: '',
      approvalAuthority: '',
      commitmentSource: 'OTHER',
      commitmentSourceDetail: '',
      fundingSource: 'OTHER',
      fundingSourceDetail: '',
      approvedAllocation: '',
      allocationSource: '',
      contractAmount: '',
      expenditureReported: '',
      expenditureSource: '',
      expenditureAsOf: '',
      startDate: '',
      expectedCompletionDate: '',
      initialStatus: 'PROPOSED',
      delayReason: '',
      reason: '',
      contractAmountIsPublic: false,
    };
    assert.deepEqual(projectBody({ ...base, expenditureReported: '100' }, base), { expenditureReported: '100' });
    assert.equal(projectBody(base).initialStatus, 'PROPOSED');
  });
});

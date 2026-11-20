/**
 * Projects (blueprint 9.3, API contract §12 and §13.4): separation of duties
 * in verification (never your own upload, never your own completion report),
 * "a photograph alone is not proof of completion", and a publish workflow that
 * exposes only approved fields and verified evidence while always naming the
 * responsible institution. Synthetic data only.
 */
import { PROJECT_PUBLIC_DISCLAIMER } from '@ngao360/shared';
import { type OfficeFixture, createOfficeFixture, describeDb, randomIp, syntheticPdf, syntheticPng } from './office-fixtures';

jest.setTimeout(120_000);

describeDb('Office projects (integration)', () => {
  let f: OfficeFixture;
  let projectId: string;
  let version: number;
  let institutionId: string;
  let photoId: string;
  let reportId: string;
  let verifierReportId: string;

  beforeAll(async () => {
    f = await createOfficeFixture({
      projects: { perms: ['office.projects.view', 'office.projects.edit', 'office.projects.evidence'] },
      verifier: { perms: ['office.projects.view', 'office.projects.verify', 'office.projects.evidence'] },
      verifier2: { perms: ['office.projects.view', 'office.projects.verify'] },
      editor: { perms: ['office.projects.view', 'office.projects.publish'] },
      editorNoReauth: { perms: ['office.projects.view', 'office.projects.publish'], reauth: false },
      scopedK2: { perms: ['office.projects.view', 'office.projects.edit'], scope: 'k2' },
    });
    institutionId = (
      await f.owner.institution.create({ data: { tenantId: f.tenantId, name: 'Synthetic County Department of Roads and Public Works', type: 'COUNTY_DEPARTMENT' } })
    ).id;
  });
  afterAll(async () => f?.close());

  const evidence = (who: string, meta: Record<string, unknown>, file = syntheticPdf(), name = 'report.pdf', type = 'application/pdf') =>
    f
      .http(who)
      .post(`/office/projects/${projectId}/evidence`)
      .field('metadata', JSON.stringify(meta))
      .attach('file', file, { filename: name, contentType: type });

  it('creates a project naming the responsible institution, scoped to the caller’s geography', async () => {
    const base = {
      name: 'Township footbridge reconstruction (synthetic)',
      category: 'ROADS_INFRASTRUCTURE',
      geographicUnitId: f.units.w1,
      responsibleInstitutionId: institutionId,
      commitmentSource: 'COUNTY_BUDGET',
      fundingSource: 'COUNTY_GOVERNMENT',
      approvedAllocation: '4500000',
      contractAmount: '4200000.50',
      contractAmountIsPublic: false,
      initialStatus: 'APPROVED',
      description: 'Internal description with procurement notes (synthetic).',
    };
    const out = await f.http('scopedK2').post('/office/projects').send(base).expect(403);
    expect(out.body.code).toBe('OUT_OF_SCOPE');
    await f.http('projects').post('/office/projects').send({ ...base, latitude: 0.56 }).expect(400);
    const res = await f.http('projects').post('/office/projects').send(base).expect(201);
    expect(res.body).toMatchObject({ status: 'APPROVED', stageKind: 'APPROVED', responsibleInstitution: { id: institutionId }, contractAmount: '4200000.5', isPublic: false });
    expect(res.body.reference).toMatch(/^PRJ-\d{4}-\d{6}$/);
    ({ id: projectId, version } = res.body);
    await f.http('scopedK2').get(`/office/projects/${projectId}`).expect(403);
  });

  it('records milestones and evidence; nobody verifies their own upload', async () => {
    await f.http('projects').post(`/office/projects/${projectId}/milestones`).send({ title: 'Foundations', plannedDate: '2026-12-01' }).expect(201);
    photoId = (await evidence('projects', { type: 'PHOTO', description: 'Synthetic site photograph after works', capturedOn: '2026-11-18' }, syntheticPng(), 'site.png', 'image/png').expect(201)).body.id;
    const report = await evidence('projects', { type: 'INSPECTION_REPORT', description: 'Synthetic county inspectorate report', sourceDescription: 'County inspectorate (synthetic)' }).expect(201);
    reportId = report.body.id;
    expect(report.body).toMatchObject({ verificationStatus: 'PENDING_VERIFICATION', uploadedBy: { id: f.users.projects }, latitude: null });

    const own = await evidence('verifier', { type: 'COMPLETION_CERTIFICATE', description: 'Synthetic completion certificate' }).expect(201);
    verifierReportId = own.body.id;
    const sod = await f.http('verifier').post(`/office/projects/${projectId}/evidence/${verifierReportId}/verify`).send({ status: 'VERIFIED', note: 'Looks fine' }).expect(403);
    expect(sod.body.code).toBe('SEPARATION_OF_DUTIES');

    await f.http('verifier').post(`/office/projects/${projectId}/evidence/${photoId}/verify`).send({ status: 'VERIFIED', note: 'Photo matches the site' }).expect(200);
    const v = await f.http('verifier').post(`/office/projects/${projectId}/evidence/${reportId}/verify`).send({ status: 'VERIFIED', note: 'Report signed and stamped' }).expect(200);
    expect(v.body).toMatchObject({ verificationStatus: 'VERIFIED', verifiedBy: { id: f.users.verifier } });
    await f.http('verifier2').post(`/office/projects/${projectId}/evidence/${verifierReportId}/verify`).send({ status: 'VERIFIED', note: 'Certificate checked' }).expect(200);
  });

  it('reports completion; the reporter cannot verify it and a photograph alone is not proof', async () => {
    const d = await f.http('projects').get(`/office/projects/${projectId}`).expect(200);
    version = d.body.version;
    version = (await f.http('projects').post(`/office/projects/${projectId}/transition`).send({ to: 'ONGOING', reason: 'Works started', expectedVersion: version }).expect(200)).body.version;
    await f.http('projects').post(`/office/projects/${projectId}/transition`).send({ to: 'COMPLETED', reason: 'Contractor reports completion', expectedVersion: version }).expect(400);
    const done = await f
      .http('projects')
      .post(`/office/projects/${projectId}/transition`)
      .send({ to: 'COMPLETED', reason: 'Contractor reports completion', actualCompletionDate: '2026-11-15', expectedVersion: version })
      .expect(200);
    expect(done.body).toMatchObject({ status: 'COMPLETED', stageKind: 'REPORTED_COMPLETE', completion: { reportedBy: { id: f.users.projects }, verifiedBy: null } });
    version = done.body.version;

    // The photograph is verified, but on its own it never proves completion.
    const photoOnly = await f
      .http('verifier2')
      .post(`/office/projects/${projectId}/verify-completion`)
      .send({ evidenceIds: [photoId], note: 'Photo shows a finished bridge', expectedVersion: version })
      .expect(400);
    expect(photoOnly.body.code).toBe('VALIDATION_FAILED');
    expect(photoOnly.body.message).toMatch(/photograph alone/i);

    // The verifier uploaded the certificate, so cannot verify completion citing it.
    const ownUpload = await f
      .http('verifier')
      .post(`/office/projects/${projectId}/verify-completion`)
      .send({ evidenceIds: [verifierReportId], note: 'Completion certificate on file', expectedVersion: version })
      .expect(403);
    expect(ownUpload.body.code).toBe('SEPARATION_OF_DUTIES');
  });

  it('verified completion needs re-authentication and someone independent of the report and the evidence', async () => {
    const ok = await f
      .http('verifier2')
      .post(`/office/projects/${projectId}/verify-completion`)
      .send({ evidenceIds: [reportId, photoId], note: 'Inspection report confirms completion to specification', expectedVersion: version })
      .expect(200);
    expect(ok.body).toMatchObject({ status: 'VERIFIED_COMPLETED', stageKind: 'VERIFIED_COMPLETE', completion: { verifiedBy: { id: f.users.verifier2 } } });
    version = ok.body.version;
    const audit = await f.owner.auditEvent.findFirstOrThrow({ where: { entityId: projectId, action: 'office.project.completion_verified' } });
    expect((audit.after as { evidenceIds: string[] }).evidenceIds.sort()).toEqual([reportId, photoId].sort());
    // Withdrawing a verified completion needs office.projects.verify.
    const w = await f.http('projects').post(`/office/projects/${projectId}/transition`).send({ to: 'ONGOING', reason: 'Defects found', expectedVersion: version }).expect(403);
    expect(w.body.code).toBe('FORBIDDEN');
  });

  it('expenditure is verified by someone other than the person who recorded it', async () => {
    const upd = await f.http('verifier2').get(`/office/projects/${projectId}`).expect(200);
    version = upd.body.version;
    // Recorded by the projects officer.
    version = (await f.http('projects').patch(`/office/projects/${projectId}`).send({ expenditureReported: '3900000', expenditureSource: 'County IFMIS extract (synthetic)', expectedVersion: version }).expect(200)).body.version;
    const r = await f.http('verifier2').post(`/office/projects/${projectId}/verify-expenditure`).send({ status: 'VERIFIED', note: 'Matches payment vouchers', expectedVersion: version }).expect(200);
    expect(r.body).toMatchObject({ expenditureVerificationStatus: 'VERIFIED', expenditureVerifiedBy: { id: f.users.verifier2 } });
    version = r.body.version;
    // Changing the reported figure resets its verification.
    const changed = await f.http('projects').patch(`/office/projects/${projectId}`).send({ expenditureReported: '4000000', expectedVersion: version }).expect(200);
    expect(changed.body.expenditureVerificationStatus).toBe('UNVERIFIED');
    version = changed.body.version;
  });

  it('publishes only approved fields and verified evidence; unpublished projects are invisible', async () => {
    await f.pub(randomIp()).get(`/public/${f.slug}/projects/${projectId}`).expect(404);
    expect((await f.pub(randomIp()).get(`/public/${f.slug}/projects`).expect(200)).body.items).toEqual([]);

    const pub = (who: string, body: Record<string, unknown>) => f.http(who).put(`/office/projects/${projectId}/publication`).send({ reason: 'Publish for citizens', expectedVersion: version, ...body });
    const reauth = await pub('editorNoReauth', { isPublic: true }).expect(401);
    expect(reauth.body.code).toBe('REAUTH_REQUIRED');
    await pub('projects', { isPublic: true }).expect(403);
    await pub('editor', { isPublic: true, publicFields: ['contractAmount'] }).expect(400);
    const pending = await evidence('projects', { type: 'OTHER_DOCUMENT', description: 'Unverified synthetic memo' }).expect(201);
    await pub('editor', { isPublic: true, publicFields: ['evidence'], publicEvidenceIds: [pending.body.id] }).expect(400);

    const ok = await pub('editor', { isPublic: true, publicFields: ['schedule', 'evidence', 'expenditure'], publicEvidenceIds: [reportId] }).expect(200);
    expect(ok.body.publication).toMatchObject({ isPublic: true, publishedBy: { id: f.users.editor } });
    version = ok.body.version;

    const res = await f.pub(randomIp()).get(`/public/${f.slug}/projects/${projectId}`).expect(200);
    expect(res.body).toMatchObject({
      name: 'Township footbridge reconstruction (synthetic)',
      stageKind: 'VERIFIED_COMPLETE',
      completionVerificationLabel: 'Completion verified',
      responsibleInstitution: { name: 'Synthetic County Department of Roads and Public Works', typeLabel: expect.any(String) },
      commitmentSourceLabel: expect.any(String),
      disclaimer: PROJECT_PUBLIC_DISCLAIMER,
      expenditure: { reported: '4000000', verificationLabel: 'Not verified' },
    });
    for (const hidden of ['contractAmount', 'approvedAllocation', 'description', 'projectOwner', 'mapLocation', 'milestones']) {
      expect(res.body).not.toHaveProperty(hidden);
    }
    const text = JSON.stringify(res.body);
    expect(text).not.toContain('Synthetic officer');
    expect(text).not.toContain('procurement notes');
    expect(text).not.toContain('4200000');
    expect(res.body.evidence.map((e: { id: string }) => e.id)).toEqual([reportId]);

    const file = await f.pub(randomIp()).get(`/public/${f.slug}/projects/${projectId}/evidence/${reportId}/file`).expect(302);
    expect(file.headers.location).toEqual(expect.any(String));
    await f.pub(randomIp()).get(`/public/${f.slug}/projects/${projectId}/evidence/${photoId}/file`).expect(404);

    const preview = await f.http('projects').get(`/office/projects/${projectId}/public-preview`).expect(200);
    expect(preview.body).toEqual(res.body);
    const list = await f.pub(randomIp()).get(`/public/${f.slug}/projects`).expect(200);
    expect(list.body.items).toHaveLength(1);
    expect(list.body.items[0]).toMatchObject({ id: projectId, completionVerificationLabel: 'Completion verified' });
  });

  it('a reported completion is never labelled complete in public', async () => {
    const created = await f
      .http('projects')
      .post('/office/projects')
      .send({ name: 'Mihuu dispensary maternity wing (synthetic)', category: 'HEALTH', geographicUnitId: f.units.w2, responsibleInstitutionId: institutionId, commitmentSource: 'MANIFESTO_PLEDGE', initialStatus: 'APPROVED' })
      .expect(201);
    let v = created.body.version;
    v = (await f.http('projects').post(`/office/projects/${created.body.id}/transition`).send({ to: 'ONGOING', reason: 'start', expectedVersion: v }).expect(200)).body.version;
    v = (await f.http('projects').post(`/office/projects/${created.body.id}/transition`).send({ to: 'COMPLETED', reason: 'done', actualCompletionDate: '2026-11-01', expectedVersion: v }).expect(200)).body.version;
    await f.http('editor').put(`/office/projects/${created.body.id}/publication`).send({ isPublic: true, reason: 'publish', expectedVersion: v }).expect(200);
    const res = await f.pub(randomIp()).get(`/public/${f.slug}/projects/${created.body.id}`).expect(200);
    expect(res.body).toMatchObject({ stageKind: 'REPORTED_COMPLETE', completionVerificationLabel: 'Reported complete — awaiting independent verification' });
    expect(res.body.statusLabel).toMatch(/not yet verified/);
  });

  it('history shows every change of the project, its milestones and evidence', async () => {
    const h = await f.http('projects').get(`/office/projects/${projectId}/history`).expect(200);
    const actions = new Set(h.body.map((e: { action: string }) => e.action));
    for (const a of ['office.project.created', 'office.project.milestone_saved', 'office.project.evidence_added', 'office.project.verification_recorded', 'office.project.completion_verified', 'office.project.publication_changed', 'file.stored']) {
      expect(actions).toContain(a);
    }
  });
});

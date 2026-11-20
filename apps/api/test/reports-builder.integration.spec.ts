/**
 * Report builder over HTTP (docs/API_CONTRACT.md §28): only registry datasets
 * and permitted fields, tenancy and geography / department scope applied in the
 * query layer (no other tenant's or out-of-scope rows, even through a shared
 * template), previews capped with totals, saved templates with owner and
 * scope, exports carrying generation time, filters, scope and classification,
 * sensitive exports gated by permission + re-auth + reason, tally datasets
 * keeping the unofficial disclaimer. Synthetic data only.
 */
import { PARALLEL_TALLY_DISCLAIMER } from '@ngao360/shared';
import { type CampaignFixture, createCampaignFixture, describeDb, seedDepartment } from './campaign-fixtures';

jest.setTimeout(120_000);

describeDb('Report builder (integration)', () => {
  let f: CampaignFixture;

  beforeAll(async () => {
    f = await createCampaignFixture({
      manager: { perms: ['tasks.view', 'events.view', 'org.departments.all', 'reports.view', 'reports.build', 'reports.save', 'reports.export'] },
      scoped: { perms: ['tasks.view', 'events.view', 'org.departments.all', 'reports.view', 'reports.build', 'reports.export'], scope: 'k2' },
      viewer: { perms: ['tasks.view', 'org.departments.all', 'reports.view'] },
      finance: { perms: ['finance.view', 'reports.build', 'reports.export'] },
      financeExporter: { perms: ['finance.view', 'finance.export', 'reports.build', 'reports.export', 'reports.export_sensitive'] },
      financeExporterNoReauth: { perms: ['finance.view', 'finance.export', 'reports.build', 'reports.export', 'reports.export_sensitive'], reauth: false },
      tally: { perms: ['tally.results.view', 'reports.build'] },
      other: { perms: ['tasks.view', 'org.departments.all', 'reports.build'], tenant: 'other' },
    });
    const dept = await seedDepartment(f, 'OPS', 'Operations (synthetic)');
    const otherDept = await seedDepartment(f, 'OPS', 'Other tenant operations (synthetic)', { tenantId: f.otherTenantId });
    const mk = (tenantId: string, ref: string, unit: string | null, departmentId: string, ownerId: string, status = 'READY') =>
      f.owner.task.create({ data: { tenantId, reference: ref, title: `Synthetic task ${ref}`, ownerId, createdById: ownerId, departmentId, geographicUnitId: unit, status: status as 'READY', dueAt: new Date('2026-01-01T00:00:00Z') } });
    await mk(f.tenantId, 'TSK-2027-000101', f.units.w1, dept.id, f.users.manager!);
    await mk(f.tenantId, 'TSK-2027-000102', f.units.w2, dept.id, f.users.manager!);
    await mk(f.tenantId, 'TSK-2027-000103', f.units.w2, dept.id, f.users.manager!, 'COMPLETED');
    await mk(f.tenantId, 'TSK-2027-000104', null, dept.id, f.users.manager!);
    await mk(f.otherTenantId, 'TSK-2027-000901', f.otherUnits.w2, otherDept.id, f.users.other!);
    await f.owner.campaignEvent.create({
      data: { tenantId: f.tenantId, reference: 'EVT-2027-000001', title: 'Synthetic rally', type: 'PUBLIC_RALLY', startsAt: new Date(), endsAt: new Date(Date.now() + 3600_000), organiserId: f.users.manager!, createdById: f.users.manager!, departmentId: dept.id, budgetMinor: 9_900_000n },
    });
  });
  afterAll(async () => f?.close());

  const tasksDef = (over: Record<string, unknown> = {}) => ({ datasetKey: 'campaign.tasks', fields: ['reference', 'status', 'geographyName'], filters: [], groupBy: [], ...over });

  it('lists only datasets and fields the caller may use', async () => {
    const ds = (await f.http('manager').get('/reports/datasets').expect(200)).body;
    const keys = ds.map((d: { key: string }) => d.key);
    expect(keys).toEqual(expect.arrayContaining(['campaign.tasks', 'campaign.events']));
    expect(keys).not.toContain('finance.transactions');
    const events = ds.find((d: { key: string }) => d.key === 'campaign.events');
    expect(events.fields.map((x: { key: string }) => x.key)).not.toContain('budgetMinor');
  });

  it('never returns non-permitted fields: unknown → 400, not permitted → 403 with the issues', async () => {
    const unknown = await f.http('manager').post('/reports/preview').send(tasksDef({ fields: ['reference', 'ownerEmail'] })).expect(400);
    expect(unknown.body.code).toBe('VALIDATION_FAILED');
    const budget = await f.http('manager').post('/reports/preview').send({ datasetKey: 'campaign.events', fields: ['reference', 'budgetMinor'], filters: [], groupBy: [] }).expect(403);
    expect(budget.body.code).toBe('FORBIDDEN');
    expect(JSON.stringify(budget.body.details)).toContain('budgetMinor');
    await f.http('manager').post('/reports/preview').send({ datasetKey: 'finance.transactions', fields: ['reference'], filters: [], groupBy: [] }).expect(403);
    await f.http('manager').post('/reports/preview').send({ datasetKey: 'campaign.events', fields: ['reference'], filters: [{ field: 'budgetMinor', op: 'gte', value: 1 }], groupBy: [] }).expect(403);
    const ok = (await f.http('manager').post('/reports/preview').send({ datasetKey: 'campaign.events', fields: ['reference', 'title'], filters: [], groupBy: [] }).expect(200)).body;
    expect(Object.keys(ok.rows[0]).sort()).toEqual(['reference', 'title']);
  });

  it('applies tenancy and geography in the query: other tenants and out-of-scope rows never appear', async () => {
    const all = (await f.http('manager').post('/reports/preview').send(tasksDef()).expect(200)).body;
    const allRefs = all.rows.map((r: { reference: string }) => r.reference).sort();
    expect(allRefs).toEqual(['TSK-2027-000101', 'TSK-2027-000102', 'TSK-2027-000103', 'TSK-2027-000104']);
    const scoped = (await f.http('scoped').post('/reports/preview').send(tasksDef()).expect(200)).body;
    expect(scoped.rows.map((r: { reference: string }) => r.reference).sort()).toEqual(['TSK-2027-000102', 'TSK-2027-000103']);
    expect(scoped.appliedScope).toContain('Webuye East');
    const other = (await f.http('other').post('/reports/preview').send(tasksDef()).expect(200)).body;
    expect(other.rows.map((r: { reference: string }) => r.reference)).toEqual(['TSK-2027-000901']);
    const out = await f.http('scoped').post('/reports/preview').send(tasksDef({ geographicUnitId: f.units.w1 })).expect(403);
    expect(out.body.code).toBe('OUT_OF_SCOPE');
  });

  it('groups with totals and describes filters in plain language', async () => {
    const r = (await f.http('manager').post('/reports/preview').send(tasksDef({ fields: ['status', 'reference'], groupBy: ['status'], filters: [{ field: 'status', op: 'in', value: ['READY', 'COMPLETED'] }] })).expect(200)).body;
    expect(r.rows).toEqual(expect.arrayContaining([expect.objectContaining({ status: 'READY', count: 3 }), expect.objectContaining({ status: 'COMPLETED', count: 1 })]));
    expect(r.rowCount).toBe(4);
    expect(r.filtersDescription).toContain('Status is one of READY, COMPLETED');
    expect(r.classification).toBe('INTERNAL');
    expect(r.exportRequirements).toMatchObject({ permissions: ['reports.export'], reauth: false, allowed: true });
  });

  it('reports.view alone runs standard or shared definitions, not new ones', async () => {
    const std = (await f.http('viewer').get('/reports/standard').expect(200)).body;
    const overdue = std.find((s: { key: string }) => s.key === 'overdue-work');
    expect(overdue.runnable).toBe(true);
    await f.http('viewer').post('/reports/preview').send(overdue.definition).expect(200);
    await f.http('viewer').post('/reports/preview').send(tasksDef()).expect(403);
  });

  it('shared templates run with the caller’s permissions and scope, never the owner’s', async () => {
    const t = (await f.http('manager').post('/reports/templates').send({ name: 'All tasks (synthetic)', definition: tasksDef(), permissionScope: 'ORGANISATION' }).expect(201)).body;
    expect(t).toMatchObject({ owner: { id: f.users.manager }, classification: 'INTERNAL', runnable: true });
    const seen = (await f.http('scoped').get('/reports/templates').expect(200)).body.items.map((x: { id: string }) => x.id);
    expect(seen).toContain(t.id);
    await f.http('scoped').patch(`/reports/templates/${t.id}`).send({ name: 'Hijack', definition: tasksDef(), expectedVersion: 1 }).expect(403);
    await f.http('other').get(`/reports/templates/${t.id}`).expect(404);
    const exp = (await f.http('scoped').post('/reports/exports').send({ templateId: t.id, format: 'CSV' }).expect(201)).body;
    expect(exp).toMatchObject({ rowCount: 2, classification: 'INTERNAL', sensitive: false, templateId: t.id });
    const audit = await f.owner.auditEvent.findFirst({ where: { tenantId: f.tenantId, action: 'reports.exported', entityId: exp.id } });
    expect(audit).not.toBeNull();
    const csv = await download(exp.url);
    expect(csv).toContain('Generated:');
    expect(csv).toContain('Data classification: INTERNAL');
    expect(csv).toContain('Scope:');
    expect(csv).toContain('TSK-2027-000102');
    expect(csv).not.toContain('TSK-2027-000101');
    // Private templates stay private.
    const priv = (await f.http('manager').post('/reports/templates').send({ name: 'Mine only', definition: tasksDef() }).expect(201)).body;
    await f.http('scoped').get(`/reports/templates/${priv.id}`).expect(404);
    await f.http('manager').post(`/reports/templates/${priv.id}/archive`).send({ reason: 'No longer needed' }).expect(200);
    await f.http('manager').get(`/reports/templates/${priv.id}`).expect(404);
  });

  it('sensitive exports need the elevated permission, re-authentication and a reason', async () => {
    const def = { datasetKey: 'finance.transactions', fields: ['reference', 'amountMinor'], filters: [], groupBy: [] };
    const missing = await f.http('finance').post('/reports/exports').send({ definition: def, format: 'XLSX', reason: 'Audit prep' }).expect(403);
    expect(missing.body.details.required).toEqual(expect.arrayContaining(['reports.export_sensitive', 'finance.export']));
    expect((await f.http('financeExporterNoReauth').post('/reports/exports').send({ definition: def, format: 'XLSX', reason: 'Audit prep' }).expect(401)).body.code).toBe('REAUTH_REQUIRED');
    await f.http('financeExporter').post('/reports/exports').send({ definition: def, format: 'XLSX' }).expect(400);
    const ok = (await f.http('financeExporter').post('/reports/exports').send({ definition: def, format: 'PDF', reason: 'Audit prep (synthetic)' }).expect(201)).body;
    expect(ok).toMatchObject({ sensitive: true, classification: 'CONFIDENTIAL', reason: 'Audit prep (synthetic)' });
    const row = await f.owner.reportExport.findUniqueOrThrow({ where: { id: ok.id } });
    expect(row.reauthAt).not.toBeNull();
    const log = (await f.http('financeExporter').get('/reports/exports').expect(200)).body;
    expect(log.items.map((x: { id: string }) => x.id)).toContain(ok.id);
    await f.http('finance').get(`/reports/exports/${ok.id}/url`).expect(404);
  });

  it('tally datasets carry the unofficial disclaimer', async () => {
    const r = (await f.http('tally').post('/reports/preview').send({ datasetKey: 'tally.form_coverage', fields: ['contestName', 'expectedStations'], filters: [], groupBy: [] }).expect(200)).body;
    expect(r.disclaimer).toBe(PARALLEL_TALLY_DISCLAIMER);
    expect(r.classification).toBe('CONFIDENTIAL');
    expect(r.exportRequirements.reauth).toBe(true);
  });

  async function download(url: string): Promise<string> {
    const supertest = (await import('supertest')).default;
    const r = await supertest(f.app.getHttpServer()).get(url).buffer(true).parse((res, cb) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => cb(null, Buffer.concat(chunks)));
    });
    return (r.body as Buffer).toString('utf8');
  }
});

/**
 * Field and election operations foundation (database level): tenant isolation
 * of every field table, append-only histories, immutable original reports,
 * deployment slot rules, incident closure separation, the idempotency ledger
 * and module activation for the War Room (field + tally). All data synthetic.
 */
import { createPrismaClient, type PrismaClient, type TenantTx, withTenant } from '@ngao360/db';
import { PERMISSION_DEFINITIONS } from '@ngao360/shared';
import { randomUUID } from 'node:crypto';
import type { AuthContext } from '../src/auth/auth.types';
import { ClientSubmissionLedger } from '../src/modules/field/common/client-submission.ledger';
import { fieldScopeWhere } from '../src/modules/field/common/field-location';
import { scopeFromGrants } from '../src/rbac/scope';

const OWNER_URL = process.env.TEST_DATABASE_URL;
const APP_URL = process.env.TEST_APP_DATABASE_URL;
const d = OWNER_URL && APP_URL ? describe : describe.skip;

d('field operations foundation (database)', () => {
  let owner: PrismaClient;
  let app: PrismaClient;
  const tA = randomUUID();
  const tB = randomUUID();
  const ids = {} as Record<string, string>;

  const asA = <T>(fn: (tx: TenantTx) => Promise<T>) => withTenant(app, tA, fn);
  const asB = <T>(fn: (tx: TenantTx) => Promise<T>) => withTenant(app, tB, fn);

  beforeAll(async () => {
    owner = createPrismaClient({ url: OWNER_URL!, log: [] });
    app = createPrismaClient({ url: APP_URL!, log: [] });
    for (const p of PERMISSION_DEFINITIONS) {
      await owner.permission.upsert({
        where: { key: p.key },
        create: { key: p.key, module: p.module, action: p.action, description: p.description, highRisk: !!p.highRisk },
        update: {},
      });
    }
    for (const [id, slug] of [[tA, `field-a-${tA.slice(0, 8)}`], [tB, `field-b-${tB.slice(0, 8)}`]] as const) {
      await owner.tenant.create({ data: { id, slug, name: slug, type: 'CAMPAIGN' } });
    }
    for (const who of ['reporter', 'desk', 'commander', 'planner']) {
      ids[who] = (await owner.user.create({ data: { tenantId: tA, email: `${who}@field.example.org`, displayName: `Synthetic ${who}`, status: 'ACTIVE' } })).id;
    }
    ids.userB = (await owner.user.create({ data: { tenantId: tB, email: 'b@field.example.org', displayName: 'B', status: 'ACTIVE' } })).id;
    const cycle = await owner.electionCycle.create({
      data: { tenantId: tA, name: 'Synthetic 2027 field', electionDate: new Date('2027-08-10'), legalConfigVersion: 'test', dataProvenance: 'SYNTHETIC', status: 'ACTIVE' },
    });
    ids.cycle = cycle.id;
    const reg = await owner.registryVersion.create({ data: { tenantId: tA, electionCycleId: cycle.id, version: 'v1', source: 'synthetic', status: 'DRAFT', stationCount: 1 } });
    const unit = async (type: 'COUNTY' | 'CONSTITUENCY' | 'WARD', code: string, parent?: { id: string; path: string }) => {
      const id = randomUUID();
      const path = `${parent?.path ?? '/'}${id}/`;
      await owner.geographicUnit.create({ data: { id, tenantId: tA, electionCycleId: cycle.id, registryVersionId: reg.id, type, parentId: parent?.id ?? null, officialCode: code, officialName: `Synthetic ${code}`, path, sourceVersion: 'v1' } });
      return { id, path };
    };
    const county = await unit('COUNTY', '904');
    const k = await unit('CONSTITUENCY', '9041', county);
    const w = await unit('WARD', '90411', k);
    Object.assign(ids, { county: county.id, constituency: k.id, ward: w.id });
    await owner.pollingStation.create({
      data: { tenantId: tA, electionCycleId: cycle.id, registryVersionId: reg.id, geographicUnitId: w.id, countyId: county.id, constituencyId: k.id, wardId: w.id, code: 'F1', name: 'Synthetic Station F1' },
    });
    await owner.registryVersion.update({ where: { id: reg.id }, data: { status: 'APPROVED', approvedAt: new Date() } });

    const loc = { electionCycleId: cycle.id, pollingStationCode: 'F1', countyId: county.id, constituencyId: k.id, wardId: w.id };
    await asA(async (tx) => {
      const agent = await tx.agent.create({
        data: { tenantId: tA, reference: 'AGT-2027-000001', givenName: 'Synthetic', familyName: 'Agent One', homeWardId: w.id, homeConstituencyId: k.id, homeCountyId: county.id, createdById: ids.planner!, phoneMasked: '+254 ••• ••• 001' },
      });
      ids.agent = agent.id;
      await tx.agentSensitive.create({ data: { agentId: agent.id, tenantId: tA, phone: '+254700000001', updatedById: ids.planner! } });
      ids.agent2 = (
        await tx.agent.create({
          data: { tenantId: tA, reference: 'AGT-2027-000002', givenName: 'Synthetic', familyName: 'Agent Two', homeWardId: w.id, homeConstituencyId: k.id, homeCountyId: county.id, createdById: ids.planner! },
        })
      ).id;
      ids.deployment = (await tx.deployment.create({ data: { tenantId: tA, agentId: agent.id, role: 'CHIEF_AGENT', createdById: ids.planner!, ...loc } })).id;
      await tx.deploymentEvent.create({ data: { tenantId: tA, deploymentId: ids.deployment, type: 'CREATED', toStatus: 'ASSIGNED', actorId: ids.planner! } });
      const tpl = await tx.fieldReportTemplate.create({
        data: { tenantId: tA, key: 'opening-of-polls', version: 1, name: 'Opening of polls', reportType: 'OPENING_OF_POLLS', schema: { sections: [] }, createdById: ids.planner! },
      });
      ids.template = tpl.id;
      ids.report = (
        await tx.fieldReport.create({
          data: { tenantId: tA, reference: 'FRP-2027-000001', templateId: tpl.id, templateVersion: 1, reportType: 'OPENING_OF_POLLS', geographicUnitId: w.id, eventAt: new Date(), answers: { opened_on_time: true }, authorId: ids.reporter!, clientIdempotencyKey: randomUUID(), ...loc },
        })
      ).id;
      ids.incident = (
        await tx.incident.create({
          data: { tenantId: tA, reference: 'INC-2027-000001', reportedCategory: 'MATERIALS', category: 'MATERIALS', initialSeverity: 'MEDIUM', severity: 'MEDIUM', occurredAt: new Date(), geographicUnitId: w.id, description: 'Synthetic: ballot papers for one stream arrived late.', reporterId: ids.reporter!, clientIdempotencyKey: randomUUID(), ...loc },
        })
      ).id;
      ids.incidentEvent = (await tx.incidentEvent.create({ data: { tenantId: tA, incidentId: ids.incident, type: 'REPORTED', toStatus: 'REPORTED', actorId: ids.reporter! } })).id;
      const checklist = await tx.readinessChecklist.create({ data: { tenantId: tA, ...loc } });
      await tx.readinessItem.create({ data: { tenantId: tA, checklistId: checklist.id, category: 'MATERIALS' } });
      const ss = await tx.stationStatus.create({ data: { tenantId: tA, ...loc, status: 'ASSIGNED', derivedStatus: 'ASSIGNED' } });
      await tx.stationStatusEvent.create({ data: { tenantId: tA, stationStatusId: ss.id, toStatus: 'ASSIGNED', source: 'DERIVED' } });
    });
  }, 60_000);

  afterAll(async () => {
    await owner?.$disconnect();
    await app?.$disconnect();
  });

  it('isolates every field table by tenant (RLS)', async () => {
    const counts = await asB(async (tx) => [
      await tx.agent.count(),
      await tx.agentSensitive.count(),
      await tx.deployment.count(),
      await tx.deploymentEvent.count(),
      await tx.fieldReportTemplate.count(),
      await tx.fieldReport.count(),
      await tx.incident.count(),
      await tx.incidentEvent.count(),
      await tx.readinessChecklist.count(),
      await tx.readinessItem.count(),
      await tx.stationStatus.count(),
      await tx.stationStatusEvent.count(),
      await tx.clientSubmission.count(),
    ]);
    expect(counts.every((c) => c === 0)).toBe(true);
    expect(await asB((tx) => tx.agent.findUnique({ where: { id: ids.agent! } }))).toBeNull();
    expect(await asA((tx) => tx.agent.count())).toBe(2);
    await expect(
      asB((tx) => tx.incidentEvent.create({ data: { tenantId: tA, incidentId: ids.incident!, type: 'NOTE', actorId: ids.userB! } })),
    ).rejects.toThrow(/row-level security/);
  });

  it('never deletes field records (even the owner role)', async () => {
    await expect(asA((tx) => tx.incident.delete({ where: { id: ids.incident! } }))).rejects.toThrow();
    await expect(owner.incident.delete({ where: { id: ids.incident! } })).rejects.toThrow(/IMMUTABLE_RECORD/);
    await expect(owner.agent.delete({ where: { id: ids.agent! } })).rejects.toThrow(/IMMUTABLE_RECORD/);
    await expect(owner.deployment.delete({ where: { id: ids.deployment! } })).rejects.toThrow(/IMMUTABLE_RECORD/);
  });

  it('keeps incident, deployment and status histories append-only', async () => {
    await expect(asA((tx) => tx.incidentEvent.update({ where: { id: ids.incidentEvent! }, data: { note: 'tampered' } }))).rejects.toThrow();
    await expect(owner.incidentEvent.update({ where: { id: ids.incidentEvent! }, data: { note: 'tampered' } })).rejects.toThrow(/IMMUTABLE_RECORD/);
    await expect(owner.deploymentEvent.deleteMany({ where: { deploymentId: ids.deployment! } })).rejects.toThrow(/IMMUTABLE_RECORD/);
    await expect(owner.stationStatusEvent.updateMany({ where: { tenantId: tA }, data: { reason: 'x' } })).rejects.toThrow(/IMMUTABLE_RECORD/);
  });

  it('never edits the original incident report; status and triage fields may change', async () => {
    await expect(
      asA((tx) => tx.incident.update({ where: { id: ids.incident! }, data: { description: 'Rewritten after the fact.' } })),
    ).rejects.toThrow(/IMMUTABLE_RECORD/);
    await expect(asA((tx) => tx.incident.update({ where: { id: ids.incident! }, data: { reportedCategory: 'SECURITY' } }))).rejects.toThrow(
      /IMMUTABLE_RECORD/,
    );
    const triaged = await asA((tx) =>
      tx.incident.update({ where: { id: ids.incident! }, data: { status: 'TRIAGED', category: 'LOGISTICS', severity: 'LOW', version: { increment: 1 } } }),
    );
    expect(triaged.reportedCategory).toBe('MATERIALS');
    expect(triaged.category).toBe('LOGISTICS');
  });

  it('closes an incident only with a note, a resolution and a reviewer who neither reported nor resolved it', async () => {
    const resolved = { status: 'RESOLVED' as const, outcome: 'RESOLVED' as const, resolutionNote: 'Ballots delivered; polling continued.', resolvedById: ids.desk!, resolvedAt: new Date() };
    await asA((tx) => tx.incident.update({ where: { id: ids.incident! }, data: resolved }));
    const close = (by: string) =>
      asA((tx) => tx.incident.update({ where: { id: ids.incident! }, data: { status: 'CLOSED', closureNote: 'Reviewed and closed.', closedById: by, closedAt: new Date() } }));
    await expect(close(ids.reporter!)).rejects.toThrow(/incidents_closer_check/);
    await expect(close(ids.desk!)).rejects.toThrow(/incidents_closer_check/);
    await expect(
      asA((tx) => tx.incident.update({ where: { id: ids.incident! }, data: { status: 'CLOSED', closedById: ids.commander!, closedAt: new Date() } })),
    ).rejects.toThrow(/incidents_closed_check/);
    await expect(close(ids.commander!)).resolves.toMatchObject({ status: 'CLOSED' });
  });

  it('keeps submitted field reports immutable apart from review fields; the author never reviews', async () => {
    await expect(asA((tx) => tx.fieldReport.update({ where: { id: ids.report! }, data: { answers: { opened_on_time: false } } }))).rejects.toThrow(
      /IMMUTABLE_RECORD/,
    );
    await expect(asA((tx) => tx.fieldReport.update({ where: { id: ids.report! }, data: { reviewStatus: 'ACCEPTED', reviewerId: ids.reporter! } }))).rejects.toThrow(
      /field_reports_reviewer_check/,
    );
    await expect(
      asA((tx) => tx.fieldReport.update({ where: { id: ids.report! }, data: { reviewStatus: 'ACCEPTED', reviewerId: ids.desk!, reviewNote: 'Accepted', reviewedAt: new Date() } })),
    ).resolves.toMatchObject({ reviewStatus: 'ACCEPTED' });
  });

  it('activates a template only by someone other than its creator, and then freezes it', async () => {
    await expect(
      asA((tx) => tx.fieldReportTemplate.update({ where: { id: ids.template! }, data: { status: 'ACTIVE', activatedById: ids.planner!, activatedAt: new Date() } })),
    ).rejects.toThrow(/maker_checker/);
    await asA((tx) => tx.fieldReportTemplate.update({ where: { id: ids.template! }, data: { status: 'ACTIVE', activatedById: ids.desk!, activatedAt: new Date() } }));
    await expect(asA((tx) => tx.fieldReportTemplate.update({ where: { id: ids.template! }, data: { name: 'Renamed' } }))).rejects.toThrow(/IMMUTABLE_RECORD/);
    await expect(asA((tx) => tx.fieldReportTemplate.update({ where: { id: ids.template! }, data: { status: 'RETIRED', retiredAt: new Date() } }))).resolves.toMatchObject({
      status: 'RETIRED',
    });
  });

  it('refuses double booking and a second active chief agent; a slot keeps its agent and station', async () => {
    const loc = { electionCycleId: ids.cycle!, pollingStationCode: 'F1', countyId: ids.county!, constituencyId: ids.constituency!, wardId: ids.ward! };
    await expect(
      asA((tx) => tx.deployment.create({ data: { tenantId: tA, agentId: ids.agent!, role: 'STATION_AGENT', createdById: ids.planner!, ...loc } })),
    ).rejects.toThrow();
    await expect(
      asA((tx) => tx.deployment.create({ data: { tenantId: tA, agentId: ids.agent2!, role: 'CHIEF_AGENT', createdById: ids.planner!, ...loc } })),
    ).rejects.toThrow();
    await expect(asA((tx) => tx.deployment.update({ where: { id: ids.deployment! }, data: { agentId: ids.agent2! } }))).rejects.toThrow(/IMMUTABLE_RECORD/);
    await expect(asA((tx) => tx.deployment.update({ where: { id: ids.deployment! }, data: { status: 'CHECKED_IN' } }))).rejects.toThrow(
      /deployments_checked_in_check/,
    );
  });

  it('idempotency ledger: replays the recorded result, flags a reused key, keeps keys per user', async () => {
    const ledger = new ClientSubmissionLedger();
    const authA = { tenantId: tA, userId: ids.reporter! } as AuthContext;
    const authA2 = { tenantId: tA, userId: ids.desk! } as AuthContext;
    const key = randomUUID();
    const item = { idempotencyKey: key, deviceId: 'device-synthetic-1', kind: 'INCIDENT' as const, clientCreatedAt: new Date().toISOString(), payload: { b: 1, a: 'x' } };
    const first = await asA((tx) => ledger.check(tx, authA, item));
    expect(first.state).toBe('NEW');
    await asA((tx) => ledger.record(tx, authA, item, first.payloadHash, { outcome: 'ACCEPTED', resultType: 'Incident', resultId: ids.incident!, resultReference: 'INC-2027-000001' }));
    const again = await asA((tx) => ledger.check(tx, authA, { ...item, payload: { a: 'x', b: 1 } }));
    expect(again.state).toBe('REPLAY');
    expect(again.state === 'REPLAY' && again.record.resultId).toBe(ids.incident);
    expect((await asA((tx) => ledger.check(tx, authA, { ...item, payload: { a: 'changed', b: 1 } }))).state).toBe('KEY_REUSED');
    expect((await asA((tx) => ledger.check(tx, authA2, item))).state).toBe('NEW');
    // An accepted record never changes its result.
    await expect(
      asA((tx) => tx.clientSubmission.updateMany({ where: { idempotencyKey: key, userId: ids.reporter! }, data: { resultId: randomUUID() } })),
    ).rejects.toThrow(/IMMUTABLE_RECORD/);
  });

  it('scope filter: station-scoped grants match field records by station code within the cycle', async () => {
    const scope = scopeFromGrants(
      [{ permission: 'field.incidents.view', scopeType: 'POLLING_STATION', geographicUnitId: null, pollingStationId: randomUUID(), pollingStationCode: 'F1', pollingStationCycleId: ids.cycle!, electionCycleId: null, expiresAt: null }],
      'field.incidents.view',
    );
    const where = fieldScopeWhere(scope)!;
    expect(await asA((tx) => tx.incident.count({ where: where as never }))).toBe(1);
    const other = scopeFromGrants(
      [{ permission: 'field.incidents.view', scopeType: 'POLLING_STATION', geographicUnitId: null, pollingStationId: randomUUID(), pollingStationCode: 'F2', pollingStationCycleId: ids.cycle!, electionCycleId: null, expiresAt: null }],
      'field.incidents.view',
    );
    expect(await asA((tx) => tx.incident.count({ where: fieldScopeWhere(other) as never }))).toBe(0);
  });

  it('accepts the field module key in tenant_modules', async () => {
    await expect(asA((tx) => tx.tenantModule.create({ data: { tenantId: tA, moduleKey: 'field', enabled: true } }))).resolves.toMatchObject({ moduleKey: 'field' });
    await expect(asA((tx) => tx.tenantModule.create({ data: { tenantId: tA, moduleKey: 'warroom', enabled: true } }))).rejects.toThrow();
  });
});

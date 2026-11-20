/**
 * Database integration tests: tenant isolation (RLS) and immutability guards.
 * Requires a migrated test database:
 *   TEST_DATABASE_URL      (owner role, used for fixtures)
 *   TEST_APP_DATABASE_URL  (runtime role ngao_app, RLS enforced)
 * Skipped when these are not set.
 */
import { createPrismaClient, type PrismaClient, sha256Hex, withTenant } from '@ngao360/db';
import { randomUUID } from 'node:crypto';

const OWNER_URL = process.env.TEST_DATABASE_URL;
const APP_URL = process.env.TEST_APP_DATABASE_URL;
const d = OWNER_URL && APP_URL ? describe : describe.skip;

d('Postgres RLS and integrity guards', () => {
  let owner: PrismaClient;
  let app: PrismaClient;
  const tA = randomUUID();
  const tB = randomUUID();
  let userA: string;

  beforeAll(async () => {
    owner = createPrismaClient({ url: OWNER_URL!, log: [] });
    app = createPrismaClient({ url: APP_URL!, log: [] });
    for (const [id, slug] of [[tA, `rls-a-${tA.slice(0, 8)}`], [tB, `rls-b-${tB.slice(0, 8)}`]] as const) {
      await owner.tenant.create({ data: { id, slug, name: slug, type: 'CAMPAIGN' } });
    }
    userA = (await owner.user.create({ data: { tenantId: tA, email: 'a@example.org', displayName: 'A', status: 'ACTIVE' } })).id;
    await owner.user.create({ data: { tenantId: tB, email: 'b@example.org', displayName: 'B', status: 'ACTIVE' } });
  });

  afterAll(async () => {
    await owner?.$disconnect();
    await app?.$disconnect();
  });

  it('returns no tenant rows without app.tenant_id', async () => {
    expect(await app.user.count({ where: { tenantId: { in: [tA, tB] } } })).toBe(0);
  });

  it('only exposes the current tenant rows', async () => {
    const rows = await withTenant(app, tA, (tx) => tx.user.findMany({ where: { tenantId: { in: [tA, tB] } } }));
    expect(rows.map((r) => r.tenantId)).toEqual([tA]);
  });

  it('rejects writes into another tenant', async () => {
    await expect(
      withTenant(app, tA, (tx) =>
        tx.user.create({ data: { tenantId: tB, email: 'x@example.org', displayName: 'X' } }),
      ),
    ).rejects.toThrow(/row-level security/);
  });

  it('keeps audit events append-only', async () => {
    const evt = await withTenant(app, tA, (tx) =>
      tx.auditEvent.create({ data: { tenantId: tA, action: 'test', entityType: 'Test', eventHash: sha256Hex('x') } }),
    );
    await expect(
      withTenant(app, tA, (tx) => tx.auditEvent.update({ where: { id: evt.id }, data: { action: 'tampered' } })),
    ).rejects.toThrow();
    // Even the owner role is blocked by the trigger.
    await expect(owner.auditEvent.delete({ where: { id: evt.id } })).rejects.toThrow(/IMMUTABLE_RECORD/);
  });

  it('keeps stored files immutable except scan status', async () => {
    const sha = sha256Hex(randomUUID());
    const file = await withTenant(app, tA, (tx) =>
      tx.storedFile.create({
        data: {
          tenantId: tA,
          sha256: sha,
          mimeType: 'image/png',
          sizeBytes: BigInt(10),
          originalFilename: 'form.png',
          purpose: 'RESULT_FORM',
          storageDriver: 'LOCAL',
          storageKey: `tenants/${tA}/sha256/${sha}`,
          uploadedById: userA,
        },
      }),
    );
    await withTenant(app, tA, (tx) =>
      tx.storedFile.update({ where: { id: file.id }, data: { malwareScanStatus: 'CLEAN', scannedAt: new Date() } }),
    );
    await expect(
      withTenant(app, tA, (tx) => tx.storedFile.update({ where: { id: file.id }, data: { sha256: sha256Hex('other') } })),
    ).rejects.toThrow(/IMMUTABLE_RECORD/);
    await expect(
      withTenant(app, tA, (tx) =>
        tx.storedFile.create({
          data: { tenantId: tA, sha256: sha, mimeType: 'image/png', sizeBytes: BigInt(10), originalFilename: 'dup.png', purpose: 'RESULT_FORM', storageDriver: 'LOCAL', storageKey: 'k', uploadedById: userA },
        }),
      ),
    ).rejects.toThrow(/Unique constraint/);
  });

  it('hides another tenant\'s records even when read by id', async () => {
    const cycleB = await owner.electionCycle.create({
      data: { tenantId: tB, name: 'Synthetic cycle B', electionDate: new Date('2027-08-10'), legalConfigVersion: 'test', dataProvenance: 'SYNTHETIC' },
    });
    // Tenant A asks for tenant B's cycle by primary key: RLS returns nothing.
    expect(await withTenant(app, tA, (tx) => tx.electionCycle.findUnique({ where: { id: cycleB.id } }))).toBeNull();
    expect(await withTenant(app, tA, (tx) => tx.electionCycle.count({ where: { tenantId: tB } }))).toBe(0);
    // Updates and deletes aimed at tenant B's row affect nothing.
    expect((await withTenant(app, tA, (tx) => tx.electionCycle.updateMany({ where: { id: cycleB.id }, data: { name: 'hijacked' } }))).count).toBe(0);
    expect((await owner.electionCycle.findUniqueOrThrow({ where: { id: cycleB.id } })).name).toBe('Synthetic cycle B');
    // Tenant B itself sees it.
    expect(await withTenant(app, tB, (tx) => tx.electionCycle.findUnique({ where: { id: cycleB.id } }))).not.toBeNull();
  });

  describe('reference-data guards', () => {
    let cycleId: string;
    let registryId: string;
    let stationId: string;
    let templateId: string;

    beforeAll(async () => {
      cycleId = (
        await owner.electionCycle.create({
          data: { tenantId: tA, name: 'Synthetic guard cycle', electionDate: new Date('2027-08-10'), legalConfigVersion: 'test', dataProvenance: 'SYNTHETIC' },
        })
      ).id;
      registryId = (await owner.registryVersion.create({ data: { tenantId: tA, electionCycleId: cycleId, version: 'g1', source: 'synthetic' } })).id;
      const unitId = randomUUID();
      await owner.geographicUnit.create({
        data: { id: unitId, tenantId: tA, electionCycleId: cycleId, registryVersionId: registryId, type: 'WARD', officialCode: 'G1', officialName: 'Synthetic ward', path: `/${unitId}/`, sourceVersion: 'g1' },
      });
      stationId = (
        await owner.pollingStation.create({
          data: { tenantId: tA, electionCycleId: cycleId, registryVersionId: registryId, geographicUnitId: unitId, countyId: unitId, constituencyId: unitId, wardId: unitId, code: 'G-1', name: 'Synthetic station', registeredVoters: 400 },
        })
      ).id;
      await owner.registryVersion.update({ where: { id: registryId }, data: { status: 'APPROVED', approvedAt: new Date() } });
      templateId = (
        await owner.formTemplate.create({
          data: { tenantId: tA, electionCycleId: cycleId, contestType: 'GOVERNOR', formNumber: '37A', formLevel: 'POLLING_STATION', version: 1, title: 'Synthetic 37A', effectiveDate: new Date('2027-01-01'), fieldSchema: { fields: [] }, validationRules: { version: 1, rules: [] }, officialSource: 'synthetic', approvalState: 'APPROVED' },
        })
      ).id;
    });

    it('refuses station changes in an approved registry version', async () => {
      await expect(owner.pollingStation.update({ where: { id: stationId }, data: { registeredVoters: 9999 } })).rejects.toThrow(/IMMUTABLE_RECORD/);
      await expect(owner.pollingStation.delete({ where: { id: stationId } })).rejects.toThrow(/IMMUTABLE_RECORD/);
    });

    it('allows only APPROVED -> SUPERSEDED on an approved registry version', async () => {
      await expect(owner.registryVersion.update({ where: { id: registryId }, data: { stationCount: 7 } })).rejects.toThrow(/IMMUTABLE_RECORD/);
      await expect(owner.registryVersion.update({ where: { id: registryId }, data: { status: 'DRAFT' } })).rejects.toThrow(/IMMUTABLE_RECORD/);
      await owner.registryVersion.update({ where: { id: registryId }, data: { status: 'SUPERSEDED' } });
      await expect(owner.registryVersion.update({ where: { id: registryId }, data: { status: 'APPROVED' } })).rejects.toThrow(/IMMUTABLE_RECORD/);
    });

    it('allows only retirement of an approved form template', async () => {
      await expect(owner.formTemplate.update({ where: { id: templateId }, data: { title: 'Edited' } })).rejects.toThrow(/IMMUTABLE_RECORD/);
      await expect(owner.formTemplate.delete({ where: { id: templateId } })).rejects.toThrow(/IMMUTABLE_RECORD/);
      await owner.formTemplate.update({ where: { id: templateId }, data: { approvalState: 'RETIRED' } });
      await expect(owner.formTemplate.update({ where: { id: templateId }, data: { approvalState: 'APPROVED' } })).rejects.toThrow(/IMMUTABLE_RECORD/);
    });

    it('keeps the registry import log tenant-scoped and append-only', async () => {
      const row = await withTenant(app, tA, (tx) =>
        tx.registryImport.create({ data: { tenantId: tA, registryVersionId: registryId, status: 'COMPLETED', importedById: userA } }),
      );
      expect(await withTenant(app, tB, (tx) => tx.registryImport.findUnique({ where: { id: row.id } }))).toBeNull();
      await expect(withTenant(app, tA, (tx) => tx.registryImport.update({ where: { id: row.id }, data: { status: 'FAILED' } }))).rejects.toThrow();
      await expect(owner.registryImport.delete({ where: { id: row.id } })).rejects.toThrow(/IMMUTABLE_RECORD/);
    });
  });
});

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
});

/**
 * Local 34A importer (`pnpm demo:import-34a`, docs/DEMO_2022.md) against the
 * SYNTHETIC fixtures in fixtures/demo-2022/34a (tiny generated PNG/PDF files
 * with valid-pattern names plus badly named files). Nothing is fetched.
 *
 *   dry run → report only, nothing written
 *   real run → known codes ingested through intake (SHA-256, duplicates) and
 *              held "not for display until redacted"; the unknown code goes to
 *              a DRAFT registry version that is not approved
 *   re-run → idempotent: every file reported as already imported
 *   maker-checker → the registrar cannot approve their own draft; the owner can,
 *              and the waiting file is ingested on the next run
 *
 * Requires TEST_DATABASE_URL (owner) and TEST_APP_DATABASE_URL (ngao_app).
 */
import type { INestApplicationContext } from '@nestjs/common';
import { createPrismaClient, type PrismaClient } from '@ngao360/db';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BuildDemoResult } from '../src/demo-2022/bungoma-demo';
import type { Import34AOptions } from '../src/demo-2022/import-34a';

const OWNER_URL = process.env.TEST_DATABASE_URL;
const APP_URL = process.env.TEST_APP_DATABASE_URL;
const d = OWNER_URL && APP_URL ? describe : describe.skip;

jest.setTimeout(300_000);

const FIXTURES = join(__dirname, '..', '..', '..', 'fixtures', 'demo-2022');
const DIR = join(FIXTURES, '34a');

d('2022 34A local-file importer (synthetic fixtures)', () => {
  let owner: PrismaClient;
  let app: INestApplicationContext;
  let storageRoot: string;
  let demo: BuildDemoResult;
  let ctx: typeof import('../src/demo-2022/demo-context');
  let imp: typeof import('../src/demo-2022/import-34a');
  let email: (local: string) => string;
  const slug = `import34a-${randomUUID().slice(0, 8)}`;
  let opts: Import34AOptions;

  beforeAll(async () => {
    storageRoot = mkdtempSync(join(tmpdir(), 'ngao-34a-'));
    Object.assign(process.env, {
      NODE_ENV: 'test',
      DATABASE_URL: OWNER_URL,
      APP_DATABASE_URL: APP_URL,
      QUEUES_ENABLED: 'false',
      OCR_PROVIDER: 'none',
      STORAGE_DRIVER: 'local',
      STORAGE_LOCAL_ROOT: storageRoot,
      JWT_ACCESS_SECRET: 'demo-34a-access-secret-demo-34a-access-secret-0001',
      JWT_REFRESH_SECRET: 'demo-34a-access-secret-demo-34a-access-secret-0001-refresh',
      MFA_ENCRYPTION_KEY: Buffer.alloc(32, 5).toString('base64'),
    });
    owner = createPrismaClient({ url: OWNER_URL!, log: [] });
    ctx = await import('../src/demo-2022/demo-context');
    imp = await import('../src/demo-2022/import-34a');
    const builder = await import('../src/demo-2022/bungoma-demo');
    const { loadDemoConfigFile } = await import('../src/demo-2022/config-file');
    email = (local) => builder.demoEmail(slug, local);
    app = await ctx.createDemoAppContext();
    demo = await builder.buildBungomaDemo(app, {
      config: loadDemoConfigFile(join(FIXTURES, 'bungoma-small.config.json')),
      ownerDb: owner,
      password: 'Demo-2022-Password-Test',
      tenantSlug: slug,
      concurrency: 3,
    });
    opts = { dir: DIR, tenantSlug: slug, dryRun: false, redacted: false, asEmail: email('clerk1'), registrarEmail: email('registrar') };
  });

  afterAll(async () => {
    await app?.close();
    await owner?.$disconnect();
    if (storageRoot) rmSync(storageRoot, { recursive: true, force: true });
  });

  const presidential = () => owner.resultSubmission.findMany({ where: { contestId: demo.presidentialContestId }, include: { pollingStation: { select: { code: true } } } });

  it('dry run: reports parsed, unparsable, known and unknown files and writes nothing', async () => {
    const r = await imp.import34A(app, { ...opts, dryRun: true });
    expect(r.dryRun).toBe(true);
    expect(r.filesSeen).toBe(9);
    expect(r.parsed).toBe(5);
    expect(r.unparsable.map((u) => u.file).sort()).toEqual(
      ['1_34_A_0390010001001_KIT1_20220809_181500.png', '1_34_A_039001000100101_KIT1_20221340_181500.png', 'notes.txt', 'scan_0001.png'].sort(),
    );
    expect(r.unparsable.find((u) => u.file === 'notes.txt')!.reason).toMatch(/1_34_A/);
    expect(r.knownStationFiles).toBe(4);
    expect(r.unknownStationCodes).toEqual(['039002000399901']);
    expect(r.otherCounty).toEqual([]);
    expect(r.ingested).toEqual([]);
    expect(r.draftRegistryVersion).toBeNull();
    expect(await presidential()).toHaveLength(0);
    expect(await owner.registryVersion.count({ where: { tenantId: demo.tenantId, status: 'DRAFT' } })).toBe(0);
    expect(imp.formatImportReport(r)).toMatch(/DRY RUN/);
  });

  it('real run: ingests known files through intake, holds them for redaction and drafts a registry version for the unknown code', async () => {
    const r = await imp.import34A(app, opts);
    expect(r.failed).toEqual([]);
    expect(r.ingested.map((i) => i.file).sort()).toEqual(
      ['1_34_A_039001000100101_KIT00001_20220809_181500.png', '1_34_A_039001000100101_KIT00001_20220809_181530.png', 'batch-b/1-34-a-039002000300101-kit00002-20220809-190102.PDF'].sort(),
    );
    // The byte-identical copy under another name is the same file for the same station.
    expect(r.alreadyImported.map((a) => a.file)).toEqual(['copies/1 34 A 039001000100101 KIT00001 20220809 181500.png']);
    expect(r.ingested.every((i) => i.held)).toBe(true);
    const sha = (f: string) => createHash('sha256').update(readFileSync(join(DIR, f))).digest('hex');
    for (const i of r.ingested) expect(i.sha256).toBe(sha(i.file));
    // A second, different scan of the same station is flagged as a possible duplicate, never dropped.
    expect(r.ingested.find((i) => i.file.endsWith('181530.png'))!.possibleDuplicate).toBe(true);

    const subs = await presidential();
    expect(subs).toHaveLength(3);
    expect(subs.every((s) => s.formNumber === '34A' && s.electionCycleId === demo.cycleId && s.sourceType === 'PUBLIC_PORTAL_COPY')).toBe(true);
    expect(subs.filter((s) => s.duplicateFlag)).toHaveLength(1);
    const holds = await owner.storedFileDisplayHold.findMany({ where: { tenantId: demo.tenantId } });
    expect(new Set(holds.map((h) => h.storedFileId))).toEqual(new Set(subs.map((s) => s.sourceFileId)));
    expect(holds.every((h) => h.redactedFileId === null)).toBe(true);

    // Unknown code → a DRAFT registry version holding the approved stations plus the new code; not approved.
    expect(r.draftRegistryVersion).toMatchObject({ created: true, stationCount: demo.layer.stations.length + 1 });
    const draft = await owner.registryVersion.findUniqueOrThrow({ where: { id: r.draftRegistryVersion!.id } });
    expect(draft).toMatchObject({ status: 'DRAFT', approvedById: null });
    expect(await owner.pollingStation.count({ where: { registryVersionId: draft.id, code: '039002000399901' } })).toBe(1);
    expect(r.awaitingRegistryApproval).toEqual([{ file: '1_34_A_039002000399901_KIT00009_20220809_200000.png', stationCode: '039002000399901' }]);
  });

  it('a held scan is not shown until a redacted copy is attached; then viewers get the copy', async () => {
    const { SubmissionsService } = await import('../src/modules/tally/services/submissions.service');
    const { DisplayHoldsService } = await import('../src/modules/tally/services/display-holds.service');
    const clerk = await ctx.authFor(app, demo.tenantId, email('clerk1'));
    const supervisor = await ctx.authFor(app, demo.tenantId, email('supervisor'));
    const sub = (await presidential()).find((s) => s.pollingStation!.code === '039002000300101')!;
    await expect(ctx.actAs(clerk, () => ctx.svc(app, SubmissionsService).sourceUrl(clerk, sub.id, false))).rejects.toMatchObject({ code: 'NOT_FOR_DISPLAY_UNTIL_REDACTED' });
    const redacted = readFileSync(join(DIR, 'scan_0001.png'));
    const r = await ctx.actAs(supervisor, () =>
      ctx.svc(app, DisplayHoldsService).attachRedactedCopy(supervisor, sub.id, { buffer: redacted, mimetype: 'image/png', originalname: 'redacted.png', size: redacted.length }),
    );
    const url = await ctx.actAs(clerk, () => ctx.svc(app, SubmissionsService).sourceUrl(clerk, sub.id, false));
    expect(url).toMatchObject({ redactedCopy: true, sha256: r.redactedSha256 });
    // The original is unchanged and still the submission's source.
    const after = await owner.resultSubmission.findUniqueOrThrow({ where: { id: sub.id }, include: { sourceFile: true } });
    expect(after.sourceFileId).toBe(sub.sourceFileId);
    expect(after.sourceFile.sha256).not.toBe(r.redactedSha256);
    // Holds change only once.
    await expect(
      ctx.actAs(supervisor, () => ctx.svc(app, DisplayHoldsService).attachRedactedCopy(supervisor, sub.id, { buffer: redacted, mimetype: 'image/png', originalname: 'again.png', size: redacted.length })),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('re-run is idempotent: every file is reported as already imported and the draft is reused', async () => {
    const before = await presidential();
    const r = await imp.import34A(app, opts);
    expect(r.ingested).toEqual([]);
    expect(r.alreadyImported).toHaveLength(4);
    expect(r.draftRegistryVersion).toMatchObject({ created: false });
    expect(await presidential()).toHaveLength(before.length);
    expect(await owner.registryVersion.count({ where: { tenantId: demo.tenantId, status: 'DRAFT' } })).toBe(1);
  });

  it('the draft needs maker-checker approval; after a different person approves it, the waiting file is ingested', async () => {
    const { RegistryService } = await import('../src/modules/reference/registry.service');
    const draft = await owner.registryVersion.findFirstOrThrow({ where: { tenantId: demo.tenantId, status: 'DRAFT' } });
    const registrar = await ctx.authFor(app, demo.tenantId, email('registrar'));
    await expect(ctx.actAs(registrar, () => ctx.svc(app, RegistryService).approve(registrar, draft.id, 'Self approval attempt'))).rejects.toMatchObject({ code: 'SEPARATION_OF_DUTIES' });
    const ownerUser = await ctx.authFor(app, demo.tenantId, email('owner'));
    await ctx.actAs(ownerUser, () => ctx.svc(app, RegistryService).approve(ownerUser, draft.id, 'Checked the new code against the 34A file name'));

    const r = await imp.import34A(app, opts);
    expect(r.unknownStationCodes).toEqual([]);
    expect(r.ingested.map((i) => i.stationCode)).toEqual(['039002000399901']);
    // Earlier filings still count for their stations under the new registry version (station lineage).
    expect(r.alreadyImported).toHaveLength(4);
  });

  it('--redacted still holds the scan: the declaration is audited and only a different person can release it', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'ngao-34a-redacted-'));
    try {
      const { writeFileSync } = await import('node:fs');
      const { SubmissionsService } = await import('../src/modules/tally/services/submissions.service');
      const { DisplayHoldsService } = await import('../src/modules/tally/services/display-holds.service');
      writeFileSync(join(tmp, '1_34_A_039002000400101_KIT00042_20220809_210000.png'), readFileSync(join(DIR, '1_34_A_039001000100101_KIT1_20221340_181500.png')));
      const r = await imp.import34A(app, { ...opts, dir: tmp, redacted: true });
      expect(r.ingested).toHaveLength(1);
      expect(r.ingested[0]).toMatchObject({ held: true, redactionDeclared: true });
      const sub = (await presidential()).find((s) => s.pollingStation!.code === '039002000400101')!;
      const hold = await owner.storedFileDisplayHold.findFirstOrThrow({ where: { storedFileId: sub.sourceFileId } });
      expect(hold.redactedFileId).toBeNull();
      const clerk = await ctx.authFor(app, demo.tenantId, email('clerk1'));
      const declared = await owner.auditEvent.findMany({ where: { tenantId: demo.tenantId, action: 'file.display_hold.redaction_declared', entityId: sub.sourceFileId } });
      expect(declared).toHaveLength(1);
      expect(declared[0]!.actorId).toBe(clerk.userId);
      expect(declared[0]!.reason).toContain(email('clerk1'));

      // Not displayable on the declaration alone.
      await expect(ctx.actAs(clerk, () => ctx.svc(app, SubmissionsService).sourceUrl(clerk, sub.id, false))).rejects.toMatchObject({ code: 'NOT_FOR_DISPLAY_UNTIL_REDACTED' });
      // The declarer (who also uploaded it) cannot release the hold.
      await expect(ctx.actAs(clerk, () => ctx.svc(app, DisplayHoldsService).confirmDeclaredRedaction(clerk, sub.id, 'I checked my own upload'))).rejects.toMatchObject({ code: 'SEPARATION_OF_DUTIES' });
      // A different person confirms with a reason; viewers get a re-encoded copy, the original is unchanged.
      const supervisor = await ctx.authFor(app, demo.tenantId, email('supervisor'));
      const done = await ctx.actAs(supervisor, () => ctx.svc(app, DisplayHoldsService).confirmDeclaredRedaction(supervisor, sub.id, 'Checked: no names or signatures visible'));
      const url = await ctx.actAs(clerk, () => ctx.svc(app, SubmissionsService).sourceUrl(clerk, sub.id, false));
      expect(url).toMatchObject({ redactedCopy: true, sha256: done.redactedSha256 });
      const released = await owner.auditEvent.findFirstOrThrow({ where: { tenantId: demo.tenantId, action: 'file.display_hold.redacted_copy_attached', entityId: sub.sourceFileId } });
      expect(released.actorId).toBe(supervisor.userId);
      expect(released.reason).toMatch(/Checked: no names or signatures visible/);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('a scan that was not declared redacted cannot be released by confirmation; a redacted copy is needed', async () => {
    const { DisplayHoldsService } = await import('../src/modules/tally/services/display-holds.service');
    const supervisor = await ctx.authFor(app, demo.tenantId, email('supervisor'));
    const sub = (await presidential()).find((s) => s.pollingStation!.code === '039002000399901')!;
    await expect(ctx.actAs(supervisor, () => ctx.svc(app, DisplayHoldsService).confirmDeclaredRedaction(supervisor, sub.id, 'Trying to skip the redaction'))).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('skips and reports station codes from another county instead of filing them under this county', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'ngao-34a-county-'));
    try {
      const { writeFileSync } = await import('node:fs');
      writeFileSync(join(tmp, '1_34_A_040001000100101_KIT00077_20220809_210000.png'), readFileSync(join(DIR, 'scan_0001.png')));
      const drafts = await owner.registryVersion.count({ where: { tenantId: demo.tenantId, status: 'DRAFT' } });
      const r = await imp.import34A(app, { ...opts, dir: tmp });
      expect(r.otherCounty).toEqual([{ file: '1_34_A_040001000100101_KIT00077_20220809_210000.png', stationCode: '040001000100101', countyCode: '040' }]);
      expect(r.unknownStationCodes).toEqual([]);
      expect(r.ingested).toEqual([]);
      expect(r.draftRegistryVersion).toBeNull();
      expect(await owner.registryVersion.count({ where: { tenantId: demo.tenantId, status: 'DRAFT' } })).toBe(drafts);
      expect(await owner.pollingStation.count({ where: { tenantId: demo.tenantId, code: '040001000100101' } })).toBe(0);
      expect(imp.formatImportReport(r)).toMatch(/other county/);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('refuses an organisation that is not a historical demo, and non-synthetic accounts', async () => {
    const plainSlug = `plain-${randomUUID().slice(0, 8)}`;
    await owner.tenant.create({ data: { slug: plainSlug, name: 'Synthetic ordinary organisation', displayName: 'Synthetic ordinary organisation', type: 'CAMPAIGN' } });
    await expect(imp.import34A(app, { ...opts, tenantSlug: plainSlug, asEmail: `clerk1@${plainSlug}.example.org`, dryRun: true })).rejects.toBeInstanceOf(ctx.NotHistoricalDemoError);
    await expect(imp.import34A(app, { ...opts, asEmail: 'someone@elsewhere.example.com', dryRun: true })).rejects.toBeInstanceOf(ctx.NotHistoricalDemoError);
  });
});

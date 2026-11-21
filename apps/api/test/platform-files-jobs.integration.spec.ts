/**
 * Malware scanning, metadata stripping and durable jobs through the HTTP stack and the test
 * database, with a fake clamd speaking INSTREAM (EICAR test string) and a dedicated BullMQ queue on
 * the local Redis. Synthetic data only.
 */
import { EICAR_TEST_STRING } from '@ngao360/shared';
import { createPrismaClient } from '@ngao360/db';
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { AppConfig } from '../src/config/app-config';
import { loadConfig } from '../src/config/config.schema';
import { JobRunRecorder, JobScheduler } from '../src/platform/jobs';
import { TallyComparisonRetryService } from '../src/platform/jobs/handlers/tally-comparison-retry.service';
import { TasksDueSoonService } from '../src/platform/jobs/handlers/tasks-due-soon.service';
import { FileScanService } from '../src/platform/scanning/file-scan.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { StorageService } from '../src/storage/storage.service';
import { APP_URL, type CampaignFixture, createCampaignFixture, describeDb, syntheticPdf } from './campaign-fixtures';
import { type FakeClamd, startFakeClamd } from './platform-fakes';

// The office.retention run walks every tenant in the shared test database: allow it time under parallel load.
jest.setTimeout(60_000);

describeDb('platform files and jobs (scanning, quarantine, metadata, durable jobs)', () => {
  let f: CampaignFixture;
  let clamd: FakeClamd;
  let prisma: PrismaService;
  let storage: StorageService;
  let scans: FileScanService;

  const store = (buffer: Buffer, purpose: 'OTHER' | 'FIELD_EVIDENCE' = 'OTHER', name = 'doc.pdf', mime = 'application/pdf') =>
    prisma.withTenant(f.tenantId, (tx) =>
      storage.storeImmutable({ tenantId: f.tenantId, uploadedById: f.users.member!, buffer, declaredMimeType: mime, originalFilename: name, purpose }, tx),
    );
  const fileRow = (id: string) => f.owner.storedFile.findUniqueOrThrow({ where: { id } });

  beforeAll(async () => {
    clamd = await startFakeClamd();
    Object.assign(process.env, { MALWARE_SCANNER: 'clamd', CLAMD_HOST: '127.0.0.1', CLAMD_PORT: String(clamd.port), CLAMD_TIMEOUT_MS: '1500' });
    f = await createCampaignFixture({
      admin: { perms: ['workspace.view', 'workspace.configure', 'platform.health.view', 'platform.tenants.manage'] },
      viewer: { perms: ['workspace.view'] },
      member: { perms: ['tasks.view'] },
    });
    prisma = f.app.get(PrismaService);
    storage = f.app.get(StorageService);
    scans = f.app.get(FileScanService);
  }, 120_000);

  afterAll(async () => {
    await f?.close();
    await clamd?.close();
  });

  it('scans PENDING files: CLEAN, or INFECTED and quarantined for good; never served once infected', async () => {
    const clean = (await store(syntheticPdf())).file;
    const infected = (await store(Buffer.from(`%PDF-1.4\n${EICAR_TEST_STRING}\n%%EOF`))).file;
    expect(clean.malwareScanStatus).toBe('PENDING');
    // A signed URL is still issued for a PENDING file (internal use); consumers that need CLEAN check it.
    await storage.signedUrl(infected);

    const counts = await scans.scanPending({ tenantId: f.tenantId });
    expect(counts).toMatchObject({ scanned: 2, clean: 1, infected: 1, errors: 0 });
    expect(await fileRow(clean.id)).toMatchObject({ malwareScanStatus: 'CLEAN', scanEngine: 'clamd', quarantinedAt: null });
    const bad = await fileRow(infected.id);
    expect(bad).toMatchObject({ malwareScanStatus: 'INFECTED', scanSignature: 'Eicar-Test-Signature' });
    expect(bad.quarantinedAt).not.toBeNull();
    expect(await f.owner.fileScanEvent.count({ where: { storedFileId: infected.id, status: 'INFECTED', quarantined: true } })).toBe(1);
    expect(await f.owner.auditEvent.count({ where: { tenantId: f.tenantId, entityId: infected.id, action: { in: ['file.scan.recorded', 'file.scan.quarantined'] }, actorType: 'SYSTEM' } })).toBe(2);

    await expect(storage.signedUrl(bad)).rejects.toMatchObject({ code: 'FILE_NOT_CLEAN' });
    await expect(f.owner.storedFile.update({ where: { id: infected.id }, data: { malwareScanStatus: 'CLEAN' } })).rejects.toThrow(/IMMUTABLE_RECORD/);
    // Nothing left to scan; a second run is a no-op.
    expect((await scans.scanPending({ tenantId: f.tenantId })).scanned).toBe(0);

    const status = await f.http('viewer').get(`/files/${infected.id}/scan`).expect(200);
    expect(status.body).toMatchObject({ status: 'INFECTED', quarantined: true, signature: 'Eicar-Test-Signature' });
    const rescan = await f.http('admin').post(`/files/${infected.id}/rescan`).send({ reason: 'Synthetic check' }).expect(409);
    expect(rescan.body.code).toBe('INVALID_TRANSITION');
    await f.http('member').get(`/files/${clean.id}/scan`).expect(403);
  });

  it('records ERROR when clamd fails (never CLEAN), backs off, and a rescan clears it once clamd is back', async () => {
    const file = (await store(syntheticPdf())).file;
    clamd.mode('error');
    expect(await scans.scanPending({ tenantId: f.tenantId })).toMatchObject({ scanned: 1, errors: 1 });
    expect(await fileRow(file.id)).toMatchObject({ malwareScanStatus: 'ERROR' });
    clamd.mode('ok');
    // Backoff: not retried by the next periodic run straight away.
    expect((await scans.scanPending({ tenantId: f.tenantId })).scanned).toBe(0);
    const res = await f.http('admin').post(`/files/${file.id}/rescan`).send({ reason: 'Scanner restored' }).expect(200);
    expect(res.body).toMatchObject({ status: 'CLEAN', engine: 'clamd' });
    await f.http('viewer').post(`/files/${file.id}/rescan`).send({ reason: 'Not allowed' }).expect(403);
  });

  it('strips EXIF / GPS from field evidence photos server-side and refuses HEIC there', async () => {
    const withGps = await sharp({ create: { width: 64, height: 48, channels: 3, background: { r: 200, g: 120, b: 40 } } })
      .withExif({ IFD0: { Make: 'SyntheticPhone', Model: 'S1' }, IFD3: { GPSLatitudeRef: 'N', GPSLatitude: '0/1 34/1 0/1', GPSLongitudeRef: 'E', GPSLongitude: '34/1 33/1 0/1' } })
      .jpeg()
      .toBuffer();
    expect((await sharp(withGps).metadata()).exif).toBeDefined();
    const { file } = await store(withGps, 'FIELD_EVIDENCE', 'IMG_0001.JPG', 'image/jpeg');
    expect(file.mimeType).toBe('image/jpeg');
    const bytes = await storage.readVerified(file);
    const meta = await sharp(bytes).metadata();
    expect(meta.exif).toBeUndefined();
    expect(bytes.includes(Buffer.from('SyntheticPhone'))).toBe(false);
    expect([meta.width, meta.height]).toEqual([64, 48]);
    // Other purposes keep the original bytes (they are re-encoded where they are shown).
    const kept = await store(withGps, 'OTHER', 'kept.jpg', 'image/jpeg');
    expect((await sharp(await storage.readVerified(kept.file)).metadata()).exif).toBeDefined();
    // HEIC cannot be cleaned on the server: refused for field evidence.
    const heic = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypheic'), Buffer.alloc(32)]);
    await expect(store(heic, 'FIELD_EVIDENCE', 'x.heic', 'image/heic')).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('lists registered durable jobs and lets a platform operator run one with a run record', async () => {
    const list = await f.http('viewer').get('/platform/jobs').expect(200);
    const keys = list.body.jobs.map((j: { jobKey: string }) => j.jobKey);
    expect(keys).toEqual(expect.arrayContaining(['messaging.dispatch', 'files.scan_pending', 'office.retention', 'field.station_status_record', 'tally.comparison_retry', 'tasks.due_soon']));
    // Queues are off in this suite: nothing is scheduled, run-now still works.
    expect(list.body.jobs.every((j: { scheduled: boolean }) => j.scheduled === false)).toBe(true);

    await f.http('viewer').post('/platform/jobs/office.retention/run').send({ reason: 'Not allowed' }).expect(403);
    const run = await f.http('admin').post('/platform/jobs/office.retention/run').send({ reason: 'Synthetic operator run' }).expect(200);
    expect(run.body).toMatchObject({ jobKey: 'office.retention', status: 'SUCCEEDED', tenantId: null });
    expect(run.body.counts).toHaveProperty('tenants');
    await f.http('admin').post('/platform/jobs/unknown.job/run').send({ reason: 'Nope' }).expect(404);
    const runs = await f.http('admin').get('/platform/jobs/runs?jobKey=office.retention&pageSize=100').expect(200);
    expect(runs.body.items.find((r: { id: string }) => r.id === run.body.id)).toMatchObject({ status: 'SUCCEEDED' });
    await f.http('viewer').get('/platform/jobs/runs').expect(403);
    expect(await f.owner.auditEvent.count({ where: { tenantId: f.tenantId, action: 'platform.job.triggered' } })).toBe(1);
    // A finished run is frozen.
    await expect(f.owner.jobRun.update({ where: { id: run.body.id }, data: { error: 'x' } })).rejects.toThrow(/IMMUTABLE_RECORD/);
  });

  it('reminds a task owner once when an open task is due within a day', async () => {
    const due = await f.owner.task.create({
      data: { tenantId: f.tenantId, reference: `TSK-2026-${randomUUID().slice(0, 6)}`, title: 'Synthetic task', ownerId: f.users.member!, createdById: f.users.admin!, status: 'IN_PROGRESS', dueAt: new Date(Date.now() + 3 * 3600_000) },
    });
    await f.owner.task.create({
      data: { tenantId: f.tenantId, reference: `TSK-2026-${randomUUID().slice(0, 6)}`, title: 'Far away', ownerId: f.users.member!, createdById: f.users.admin!, status: 'READY', dueAt: new Date(Date.now() + 5 * 86_400_000) },
    });
    await f.owner.task.create({
      data: { tenantId: f.tenantId, reference: `TSK-2026-${randomUUID().slice(0, 6)}`, title: 'Done', ownerId: f.users.member!, createdById: f.users.admin!, status: 'COMPLETED', dueAt: new Date(Date.now() + 3600_000), completedAt: new Date() },
    });
    const svc = f.app.get(TasksDueSoonService);
    expect(await svc.runForTenant(f.tenantId)).toBe(1);
    expect(await svc.runForTenant(f.tenantId)).toBe(0);
    const n = await f.owner.notification.findMany({ where: { tenantId: f.tenantId, type: 'task.due_soon' } });
    expect(n).toHaveLength(1);
    expect(n[0]).toMatchObject({ userId: f.users.member, entityId: due.id, link: `/tasks/${due.id}` });
    expect(n[0]!.body).not.toContain('Synthetic task');
    // Another tenant's tasks are never touched from this tenant.
    expect(await svc.runForTenant(f.otherTenantId)).toBe(0);
  });

  it('cross-stage comparison retry runs per tenant only where the tally module is on', async () => {
    const retry = f.app.get(TallyComparisonRetryService);
    // Tally on (default for organisations without a module row): the candidate query runs; nothing is due.
    expect(await retry.runForTenant(f.tenantId, { graceSeconds: 0 })).toEqual({ retried: 0, completed: 0, failed: 0 });
    await f.owner.tenantModule.upsert({
      where: { tenantId_moduleKey: { tenantId: f.otherTenantId, moduleKey: 'tally' } },
      create: { tenantId: f.otherTenantId, moduleKey: 'tally', enabled: false },
      update: { enabled: false },
    });
    expect(await retry.runForTenant(f.otherTenantId, { graceSeconds: 0 })).toBeNull();
  });
});

const redisUrl = process.env.REDIS_URL;
(APP_URL && redisUrl ? describe : describe.skip)('JobScheduler on BullMQ (dedicated queue)', () => {
  it('runs a kicked job once through the worker and records the run; on-demand jobs are not kicked', async () => {
    const env = { ...process.env, DATABASE_URL: process.env.TEST_DATABASE_URL, APP_DATABASE_URL: APP_URL, QUEUES_ENABLED: 'true', JOBS_ENABLED: 'true', REDIS_URL: redisUrl } as NodeJS.ProcessEnv;
    const config = { values: loadConfig(env) } as AppConfig;
    const client = createPrismaClient({ url: APP_URL!, log: [] });
    const prisma = { client, withTenant: () => Promise.reject(new Error('unused')) } as unknown as PrismaService;
    const queue = `platform-jobs-test-${randomUUID().slice(0, 8)}`;
    const scheduler = new JobScheduler(config, new JobRunRecorder(prisma), queue);
    const key = `test.probe_${randomUUID().replace(/-/g, '').slice(0, 8)}`;
    const ran: string[] = [];
    scheduler.register({ key, everyMs: 24 * 3600_000, handler: async (ctx) => (ran.push(ctx.runId), { probes: 1 }) });
    scheduler.register({ key: `${key}_manual`, handler: async () => ({ manual: 1 }) });
    try {
      await scheduler.onApplicationBootstrap();
      scheduler.trigger(key, 10);
      scheduler.trigger(key, 10); // collapses into the same kick
      scheduler.trigger(`${key}_manual`, 10); // on-demand only: ignored
      const deadline = Date.now() + 15_000;
      while (Date.now() < deadline && ran.length < 2) await new Promise((r) => setTimeout(r, 100));
      // The repeatable schedule's first occurrence plus one kick.
      expect(ran.length).toBeGreaterThanOrEqual(1);
      const rows = await client.jobRun.findMany({ where: { jobKey: key } });
      expect(rows.length).toBe(ran.length);
      expect(rows.every((r) => r.status === 'SUCCEEDED' && r.queueJobId !== null && r.tenantId === null)).toBe(true);
      expect(await client.jobRun.count({ where: { jobKey: `${key}_manual` } })).toBe(0);
    } finally {
      await scheduler.unschedule(key);
      await scheduler.onApplicationShutdown();
      await client.$disconnect();
    }
  }, 30_000);
});

/**
 * Campaign and organisation end-to-end rehearsal (blueprint 3, 5.1–5.4, 10.2,
 * 10.3, 15.3; API contract §23–29), driven through the real HTTP stack with the
 * real system roles, real password sign-in, TOTP for the roles that need MFA
 * and real re-authentication for high-risk actions:
 *
 *   1. the campaign manager builds a department and a team;
 *   2. the manager creates an event with an agenda, logistics and a dependent
 *      task chain; the assignee gets an in-app notification with a deep link;
 *   3. the assignee cannot start the dependent task while its dependency is
 *      open, then completes both in order;
 *   4. attendance is recorded (contact details never returned in lists);
 *   5. the after-action report is approved by a reviewer other than its author;
 *   6. a finance officer requests an expense with a supporting document; the
 *      requester cannot approve it; the finance approver approves after
 *      re-authenticating; a third user pays;
 *   7. the approved entry cannot be edited; the correction is a reversing entry
 *      approved by someone other than its requester;
 *   8. a contribution above the configured single-source cap is warned while
 *      the setting is unverified (with its legal source note) and blocked once
 *      the BLOCK setting is verified; no cap is written into the code;
 *   9. report builder: finance preview needs finance permissions, finance export
 *      needs the elevated permission and re-authentication and is audited; the
 *      operations role sees no finance dataset;
 *  10. a content item goes draft → editorial review → approval → publication →
 *      archive with author ≠ approver; recipient lists are refused.
 *
 * Everything is SYNTHETIC (fictional Bungoma geography, people and figures) in
 * a fresh tenant with a random slug. Requires TEST_DATABASE_URL (owner) and
 * TEST_APP_DATABASE_URL (runtime role ngao_app, RLS enforced); skipped otherwise.
 */
import type { INestApplication } from '@nestjs/common';
import argon2 from 'argon2';
import {
  createPrismaClient,
  currentTotpStep,
  generateTotpSecret,
  type PrismaClient,
  provisionSystemRoles,
  sealSecret,
  syncPermissionCatalogue,
  totpAt,
} from '@ngao360/db';
import { AUDIT_ACTIONS, getSystemRole, type SystemRoleKey } from '@ngao360/shared';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';

const OWNER_URL = process.env.TEST_DATABASE_URL;
const APP_URL = process.env.TEST_APP_DATABASE_URL;
const d = OWNER_URL && APP_URL ? describe : describe.skip;

jest.setTimeout(180_000);

const PASSWORD = 'Campaign-Rehearsal-Password-2027';
const MFA_KEY = Buffer.alloc(32, 13).toString('base64');
const JWT_SECRET = 'campaign-rehearsal-access-secret-campaign-rehearsal-01';
const SOURCE_NOTE = 'Synthetic rehearsal value: configure to the applicable law before use';

type Persona = 'manager' | 'lead' | 'ops' | 'editor' | 'commsApprover' | 'finance' | 'approver' | 'payer';
const PERSONAS: Record<Persona, SystemRoleKey> = {
  manager: 'CAMPAIGN_MANAGER',
  lead: 'DEPARTMENT_LEAD',
  ops: 'OPERATIONS_OFFICER',
  editor: 'COMMUNICATIONS_EDITOR',
  commsApprover: 'COMMUNICATIONS_APPROVER',
  finance: 'FINANCE_OFFICER',
  approver: 'FINANCE_APPROVER',
  payer: 'FINANCE_OFFICER',
};

const pdf = (label: string) => Buffer.concat([Buffer.from(`%PDF-1.4\n% synthetic ${label} (campaign rehearsal)\n`), randomBytes(48)]);

d('Campaign and organisation rehearsal (synthetic)', () => {
  let owner: PrismaClient;
  let app: INestApplication;
  let storageRoot: string;
  const slug = `campaign-rehearsal-${randomUUID().slice(0, 8)}`;
  let tenantId: string;
  const units = {} as Record<'county' | 'kanduyi' | 'township', string>;
  const userIds = {} as Record<Persona, string>;
  const totpSecrets: Partial<Record<Persona, string>> = {};
  const lastStep: Partial<Record<Persona, number>> = {};
  const agents = {} as Record<Persona, ReturnType<typeof request.agent>>;
  const ids: Record<string, string> = {};

  /* --------------------------------- helpers --------------------------------- */

  /** A fresh TOTP code for this persona, never reusing a step (see the Office rehearsal). */
  const nextCode = async (who: Persona): Promise<string> => {
    const secret = totpSecrets[who]!;
    for (;;) {
      const now = currentTotpStep();
      const secondsIntoStep = Math.floor(Date.now() / 1000) % 30;
      let step = secondsIntoStep < 20 ? now - 1 : now;
      while (lastStep[who] !== undefined && step <= lastStep[who]!) step++;
      if (step <= now + 1) {
        lastStep[who] = step;
        return totpAt(secret, step);
      }
      await new Promise((resolve) => setTimeout(resolve, (30 - secondsIntoStep) * 1000 + 250));
    }
  };

  const http = (who: Persona) => {
    const a = agents[who];
    return {
      get: (p: string) => a.get(`/api${p}`),
      post: (p: string) => a.post(`/api${p}`).set('x-ngao-client', 'web'),
      put: (p: string) => a.put(`/api${p}`).set('x-ngao-client', 'web'),
      patch: (p: string) => a.patch(`/api${p}`).set('x-ngao-client', 'web'),
    };
  };

  async function signIn(who: Persona): Promise<void> {
    agents[who] = request.agent(app.getHttpServer());
    const res = await http(who).post('/auth/login').send({ tenantSlug: slug, email: `${who.toLowerCase()}@campaign-rehearsal.example.org`, password: PASSWORD });
    expect(res.status).toBe(200);
    if (res.body.status === 'MFA_REQUIRED') {
      const mfa = await http(who).post('/auth/mfa/verify').send({ challengeToken: res.body.challengeToken, code: await nextCode(who) });
      expect(mfa.status).toBe(200);
      expect(mfa.body.mfaVerified).toBe(true);
    } else {
      expect(res.body.status).toBe('AUTHENTICATED');
    }
  }

  async function reauth(who: Persona): Promise<void> {
    const res = await http(who).post('/auth/reauth').send({ password: PASSWORD, ...(totpSecrets[who] ? { code: await nextCode(who) } : {}) });
    expect(res.status).toBe(200);
  }

  const auditCount = (action: string, where: Record<string, unknown> = {}) => owner.auditEvent.count({ where: { tenantId, action, ...where } });

  async function attachDocument(who: Persona, txId: string, kind: string, label: string) {
    const file = (await http(who).post('/finance/files').attach('file', pdf(label), { filename: `${label}.pdf`, contentType: 'application/pdf' }).expect(201)).body;
    return (await http(who).post(`/finance/transactions/${txId}/documents`).send({ fileId: file.id, kind }).expect(201)).body;
  }

  const finance = (who: Persona, txId: string, body: Record<string, unknown>) => http(who).post(`/finance/transactions/${txId}/transition`).send(body);

  async function download(url: string): Promise<string> {
    const u = new URL(url, 'http://localhost');
    const r = await request(app.getHttpServer())
      .get(u.pathname + u.search)
      .buffer(true)
      .parse((res, cb) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => cb(null, Buffer.concat(chunks)));
      });
    expect(r.status).toBe(200);
    return (r.body as Buffer).toString('utf8');
  }

  /* ---------------------------------- setup ---------------------------------- */

  beforeAll(async () => {
    storageRoot = mkdtempSync(join(tmpdir(), 'ngao-campaign-rehearsal-'));
    Object.assign(process.env, {
      NODE_ENV: 'test',
      DATABASE_URL: OWNER_URL,
      APP_DATABASE_URL: APP_URL,
      QUEUES_ENABLED: 'false',
      OFFICE_RETENTION_INTERVAL_MINUTES: '0',
      STORAGE_DRIVER: 'local',
      STORAGE_LOCAL_ROOT: storageRoot,
      JWT_ACCESS_SECRET: JWT_SECRET,
      JWT_REFRESH_SECRET: `${JWT_SECRET}-refresh`,
      MFA_ENCRYPTION_KEY: MFA_KEY,
      RATE_LIMIT_MAX: '100000',
      AUTH_RATE_LIMIT_MAX: '100000',
    });
    owner = createPrismaClient({ url: OWNER_URL!, log: [] });

    // Same provisioning as `pnpm db:seed`: permission catalogue and system roles.
    await syncPermissionCatalogue(owner);
    const name = 'Synthetic Bungoma campaign (rehearsal)';
    tenantId = (await owner.tenant.create({ data: { slug, name, displayName: name, type: 'CAMPAIGN' } })).id;
    const roleIds = await provisionSystemRoles(owner, tenantId);

    const cycle = await owner.electionCycle.create({
      data: { tenantId, name: 'Synthetic 2027 cycle', electionDate: new Date('2027-08-10'), legalConfigVersion: 'rehearsal', dataProvenance: 'SYNTHETIC', status: 'ACTIVE' },
    });
    const unit = async (key: keyof typeof units, type: 'COUNTY' | 'CONSTITUENCY' | 'WARD', code: string, unitName: string, parent?: { id: string; path: string }) => {
      const id = randomUUID();
      const path = `${parent?.path ?? '/'}${id}/`;
      await owner.geographicUnit.create({
        data: { id, tenantId, electionCycleId: cycle.id, type, parentId: parent?.id ?? null, officialCode: code, officialName: unitName, path, sourceVersion: 'synthetic-rehearsal' },
      });
      units[key] = id;
      return { id, path };
    };
    const county = await unit('county', 'COUNTY', 'S39', 'Bungoma (synthetic)');
    const kanduyi = await unit('kanduyi', 'CONSTITUENCY', 'S39-1', 'Kanduyi (synthetic)', county);
    await unit('township', 'WARD', 'S39-1-1', 'Township (synthetic)', kanduyi);
    ids.cycleId = cycle.id;

    await owner.tenantModule.create({ data: { tenantId, moduleKey: 'campaign', enabled: true, config: { referenceYear: 2027 } } });

    const passwordHash = await argon2.hash(PASSWORD, { type: argon2.argon2id });
    for (const [persona, role] of Object.entries(PERSONAS) as Array<[Persona, SystemRoleKey]>) {
      const user = await owner.user.create({
        data: { tenantId, email: `${persona.toLowerCase()}@campaign-rehearsal.example.org`, displayName: `Rehearsal ${persona} (synthetic)`, passwordHash, status: 'ACTIVE', passwordChangedAt: new Date() },
      });
      userIds[persona] = user.id;
      await owner.roleAssignment.create({ data: { tenantId, userId: user.id, roleId: roleIds[role]!, scopeType: 'ORGANISATION', reason: 'Campaign rehearsal (synthetic)' } });
      if (getSystemRole(role).mfaRequired) {
        const secret = generateTotpSecret();
        totpSecrets[persona] = secret;
        await owner.mfaFactor.create({
          data: { tenantId, userId: user.id, type: 'TOTP', status: 'ACTIVE', label: 'Rehearsal authenticator', secretEncrypted: sealSecret(secret, MFA_KEY), verifiedAt: new Date() },
        });
        await owner.user.update({ where: { id: user.id }, data: { mfaEnabled: true } });
      }
    }

    const { createApp } = await import('../src/main');
    app = await createApp();
    await app.init();
    for (const p of Object.keys(PERSONAS) as Persona[]) await signIn(p);
  }, 240_000);

  afterAll(async () => {
    await app?.close();
    await owner?.$disconnect();
    if (storageRoot) rmSync(storageRoot, { recursive: true, force: true });
  });

  /* ------------------------------- organisation ------------------------------- */

  it('0. operations roles hold no finance permission (blueprint 3)', async () => {
    const ops = (await http('ops').get('/auth/me').expect(200)).body;
    expect(ops.permissions.filter((k: string) => k.startsWith('finance.'))).toEqual([]);
    await http('ops').get('/finance/ledger').expect(403);
    await http('ops').get('/finance/transactions').expect(403);
    const fin = (await http('finance').get('/auth/me').expect(200)).body;
    expect(fin.permissions).toEqual(expect.arrayContaining(['finance.request', 'finance.pay']));
    expect(fin.permissions).not.toContain('finance.approve');
  });

  it('1. the campaign manager builds a department and a team', async () => {
    const m = http('manager');
    const dept = (await m.post('/org/departments').send({ code: 'FIELD-OPS', name: 'Field operations (synthetic)', leadUserId: userIds.lead, budgetCode: 'SYN-OPS-01' }).expect(201)).body;
    expect(dept).toMatchObject({ code: 'FIELD-OPS', depth: 0 });
    ids.dept = dept.id;
    const team = (await m.post('/org/teams').send({ name: 'Township mobilisers (synthetic)', departmentId: dept.id, coordinatorUserId: userIds.lead, geographicUnitId: units.township }).expect(201)).body;
    ids.team = team.id;
    const added = (await m.post(`/org/teams/${team.id}/members`).send({ members: [{ userId: userIds.ops }, { userId: userIds.editor }] }).expect(200)).body;
    expect(added.members.filter((x: { leftAt: string | null }) => !x.leftAt).map((x: { user: { id: string } }) => x.user.id)).toEqual(
      expect.arrayContaining([userIds.lead, userIds.ops, userIds.editor]),
    );
    const tree = (await m.get('/org/departments/tree').expect(200)).body;
    expect(JSON.stringify(tree)).toContain('FIELD-OPS');
    expect(await auditCount(AUDIT_ACTIONS.DEPARTMENT_CREATED, { entityId: dept.id })).toBe(1);
  });

  /* ---------------------------- events and tasks ---------------------------- */

  it('2. the manager creates an event with agenda, logistics and a dependent task chain; the assignee is notified', async () => {
    const m = http('manager');
    const now = Date.now();
    let e = (
      await m
        .post('/events')
        .send({
          title: 'Township town hall (synthetic)',
          type: 'TOWN_HALL',
          startsAt: new Date(now + 2 * 3600_000).toISOString(),
          endsAt: new Date(now + 4 * 3600_000).toISOString(),
          organiserId: userIds.manager,
          departmentId: ids.dept,
          teamId: ids.team,
          geographicUnitId: units.township,
          budgetMinor: 4_500_000,
        })
        .expect(201)
    ).body;
    ids.event = e.id;
    e = (
      await m
        .put(`/events/${e.id}/agenda`)
        .send({ expectedVersion: e.version, items: [{ title: 'Welcome and introductions', durationMinutes: 15 }, { title: 'Ward development questions', durationMinutes: 60, ownerId: userIds.lead }] })
        .expect(200)
    ).body;
    expect(e.agenda.map((a: { title: string }) => a.title)).toEqual(['Welcome and introductions', 'Ward development questions']);
    const logistic = (await m.post(`/events/${e.id}/logistics`).send({ itemType: 'EQUIPMENT', description: 'Public address system (synthetic)', quantity: 1, custodianId: userIds.ops }).expect(201)).body;
    expect(JSON.stringify(logistic)).toContain('Public address system');

    const source = { type: 'EVENT', id: e.id };
    const a = (await m.post('/tasks').send({ title: 'Confirm the venue booking', ownerId: userIds.ops, departmentId: ids.dept, status: 'READY', source }).expect(201)).body;
    const b = (await m.post('/tasks').send({ title: 'Set up the sound system', ownerId: userIds.ops, departmentId: ids.dept, status: 'READY', source, dependsOnTaskIds: [a.id] }).expect(201)).body;
    const c = (await m.post('/tasks').send({ title: 'Run the attendance desk', ownerId: userIds.ops, departmentId: ids.dept, status: 'READY', source, dependsOnTaskIds: [b.id] }).expect(201)).body;
    Object.assign(ids, { taskA: a.id, taskB: b.id, taskC: c.id });
    // A cycle in the chain is refused.
    expect((await m.post(`/tasks/${a.id}/dependencies`).send({ dependsOnTaskId: c.id }).expect(409)).body.details.reason).toBe('CYCLE');

    const detail = (await m.get(`/events/${e.id}`).expect(200)).body;
    expect(detail.tasks.map((t: { id: string }) => t.id).sort()).toEqual([a.id, b.id, c.id].sort());

    // The assignee sees in-app notifications with deep links to the tasks (extended §7/§29 list).
    const inbox = (await http('ops').get('/notifications?unreadOnly=true').expect(200)).body;
    const assigned = inbox.items.filter((n: { type: string }) => n.type === 'task.assigned');
    expect(assigned.map((n: { entityId: string }) => n.entityId).sort()).toEqual([a.id, b.id, c.id].sort());
    expect(assigned[0]).toMatchObject({ module: 'tasks', entityType: 'Task', severity: expect.any(String), requiresAck: false });
    expect(assigned.map((n: { link: string }) => n.link)).toContain(`/tasks/${a.id}`);
    const counts = (await http('ops').get('/notifications/counts').expect(200)).body;
    expect(counts.unread).toBeGreaterThanOrEqual(3);
    await http('ops').post(`/notifications/${assigned[0].id}/read`).expect(200);
    const read = (await http('ops').get('/notifications?unreadOnly=false').expect(200)).body;
    expect(read.items.find((n: { id: string }) => n.id === assigned[0].id).readAt).not.toBeNull();
  });

  it('3. the assignee cannot start a task while its dependency is open, then completes the chain in order', async () => {
    const o = http('ops');
    const get = async (id: string) => (await o.get(`/tasks/${id}`).expect(200)).body;
    let b = await get(ids.taskB!);
    expect(b.openDependencyCount).toBe(1);
    const blocked = await o.post(`/tasks/${b.id}/status`).send({ toStatus: 'IN_PROGRESS', expectedVersion: b.version }).expect(409);
    expect(blocked.body.details.openDependencies.map((x: { id: string }) => x.id)).toEqual([ids.taskA]);
    // A reason alone is no override, and the assignee holds no override right.
    await o.post(`/tasks/${b.id}/status`).send({ toStatus: 'IN_PROGRESS', reason: 'Starting early', overrideOpenDependencies: true, expectedVersion: b.version }).expect(403);

    for (const id of [ids.taskA!, ids.taskB!, ids.taskC!]) {
      let t = await get(id);
      t = (await o.post(`/tasks/${id}/status`).send({ toStatus: 'IN_PROGRESS', expectedVersion: t.version }).expect(200)).body;
      if (id === ids.taskB) {
        // C is still blocked by B while B is only in progress.
        const c = await get(ids.taskC!);
        await o.post(`/tasks/${c.id}/status`).send({ toStatus: 'IN_PROGRESS', expectedVersion: c.version }).expect(409);
      }
      t = (await o.post(`/tasks/${id}/status`).send({ toStatus: 'COMPLETED', expectedVersion: t.version }).expect(200)).body;
      expect(t.status).toBe('COMPLETED');
    }
    b = await get(ids.taskB!);
    expect(b.timeline.map((x: { type: string }) => x.type)).toEqual(expect.arrayContaining(['CREATED', 'STATUS_CHANGED']));
    expect(await auditCount(AUDIT_ACTIONS.TASK_STATUS_CHANGED, { entityId: ids.taskC })).toBeGreaterThanOrEqual(2);
  });

  it('4. attendance is recorded; contact details stay out of lists', async () => {
    const m = http('manager');
    let e = (await m.get(`/events/${ids.event}`).expect(200)).body;
    for (const s of ['PLANNED', 'CONFIRMED', 'IN_PROGRESS']) e = (await m.post(`/events/${e.id}/status`).send({ toStatus: s, expectedVersion: e.version }).expect(200)).body;
    const o = http('ops');
    await o.post(`/events/${e.id}/attendance`).send({ participantName: 'Synthetic Resident Wanjala', role: 'PARTICIPANT' }).expect(201);
    const withContact = (
      await o
        .post(`/events/${e.id}/attendance`)
        .send({ participantName: 'Synthetic Resident Nekesa', role: 'PARTICIPANT', contact: { phone: '+254700000077', consent: true, consentNoticeVersion: 'event-attendance-v1', purpose: 'Follow-up on her ward question only' } })
        .expect(201)
    ).body;
    expect(withContact.hasContact).toBe(true);
    await o.post(`/events/${e.id}/attendance`).send({ participantName: 'Rehearsal ops (synthetic)', participantUserId: userIds.ops, role: 'STAFF' }).expect(201);
    const list = (await m.get(`/events/${e.id}/attendance`).expect(200)).body;
    expect(list.total).toBe(3);
    expect(list.summary).toMatchObject({ total: 3, withContact: 1 });
    expect(JSON.stringify(list)).not.toContain('700000077');
    e = (await m.get(`/events/${e.id}`).expect(200)).body;
    e = (await m.post(`/events/${e.id}/status`).send({ toStatus: 'COMPLETED', expectedVersion: e.version }).expect(200)).body;
    expect(e.status).toBe('COMPLETED');
  });

  it('5. the after-action report is approved by a reviewer other than its author', async () => {
    const aar = (
      await http('lead')
        .put(`/events/${ids.event}/after-action?submit=true`)
        .send({ whatOccurred: 'Synthetic town hall held as planned; questions on ward roads recorded.', attendanceTotal: 3, attendanceBreakdown: { PARTICIPANT: 2, STAFF: 1 }, actualSpendMinor: 4_250_000 })
        .expect(200)
    ).body;
    expect(aar).toMatchObject({ status: 'SUBMITTED', author: { id: userIds.lead } });
    // The author holds the approval permission but may not approve their own report.
    const self = await http('lead').post(`/events/${ids.event}/after-action/review`).send({ decision: 'APPROVE', expectedVersion: aar.version });
    expect(self.status).toBe(403);
    expect(['SEPARATION_OF_DUTIES', 'FORBIDDEN']).toContain(self.body.code);
    const ok = (await http('manager').post(`/events/${ids.event}/after-action/review`).send({ decision: 'APPROVE', expectedVersion: aar.version }).expect(200)).body;
    expect(ok).toMatchObject({ status: 'APPROVED', reviewer: { id: userIds.manager } });
    await http('lead').put(`/events/${ids.event}/after-action`).send({ whatOccurred: 'Changed afterwards (must be refused).', attendanceTotal: 1, expectedVersion: ok.version }).expect(409);
  });

  /* ---------------------------------- finance ---------------------------------- */

  it('6. expense: requested with a document; the requester cannot approve; approved after re-auth; a third user pays', async () => {
    // Reference data: the approver (finance.settings.manage) sets up the account and categories (re-auth).
    await reauth('approver');
    const a = http('approver');
    ids.account = (await a.post('/finance/accounts').send({ name: 'Synthetic campaign account', type: 'BANK', institution: 'Synthetic Bank', accountNumberLast4: '0427', currency: 'KES', isDedicatedCampaignAccount: true }).expect(201)).body.id;
    ids.expenseCat = (await a.post('/finance/categories').send({ code: 'EXP.EVT', name: 'Event costs', kind: 'EXPENSE' }).expect(201)).body.id;
    ids.incomeCat = (await a.post('/finance/categories').send({ code: 'INC.DON', name: 'Donations', kind: 'INCOME' }).expect(201)).body.id;
    const f = http('finance');
    ids.payee = (await f.post('/finance/payees').send({ name: 'Synthetic Sound Hire Ltd', kind: 'SUPPLIER', taxPin: 'P059999999Z' }).expect(201)).body.id;

    let t = (
      await f
        .post('/finance/transactions')
        .send({ type: 'EXPENSE', accountId: ids.account, categoryId: ids.expenseCat, payeeId: ids.payee, amountMinor: 1_850_000, currency: 'KES', transactionDate: new Date().toISOString().slice(0, 10), description: 'Sound system hire for the Township town hall (synthetic)', externalReference: 'INV-SYN-0427', eventId: ids.event, departmentId: ids.dept })
        .expect(201)
    ).body;
    expect(t).toMatchObject({ status: 'DRAFT', amount: { amountMinor: 1_850_000, currency: 'KES' } });
    ids.expense = t.id;
    // Without the supporting document the approval checklist is incomplete.
    expect(t.approvalBlockers).toContain('SUPPORTING_DOCUMENT_MISSING');
    await attachDocument('finance', t.id, 'INVOICE', 'sound-hire-invoice');
    t = (await finance('finance', t.id, { action: 'SUBMIT', expectedVersion: (await f.get(`/finance/transactions/${t.id}`).expect(200)).body.version }).expect(200)).body;
    expect(t.status).toBe('REQUESTED');
    expect(t.approvalBlockers).toEqual([]);
    expect(t.allowedActions).not.toContain('APPROVE');

    // The requester cannot approve (no permission) and cannot pay their own request (separation of duties).
    await reauth('finance');
    expect((await finance('finance', t.id, { action: 'APPROVE', expectedVersion: t.version })).status).toBe(403);
    // The approver re-authenticated at the start of this step (approval is high risk).
    t = (await finance('approver', t.id, { action: 'APPROVE', expectedVersion: t.version }).expect(200)).body;
    expect(t).toMatchObject({ status: 'APPROVED', approvedBy: { id: userIds.approver }, requestedBy: { id: userIds.finance } });
    const selfPay = await finance('finance', t.id, { action: 'PAY', paymentReference: 'MPESA-SYN-0427', expectedVersion: t.version }).expect(403);
    expect(selfPay.body.code).toBe('SEPARATION_OF_DUTIES');

    // A third user pays (re-auth first: payment is high risk).
    expect((await finance('payer', t.id, { action: 'PAY', paymentReference: 'MPESA-SYN-0427', expectedVersion: t.version }).expect(401)).body.code).toBe('REAUTH_REQUIRED');
    await reauth('payer');
    t = (await finance('payer', t.id, { action: 'PAY', paymentReference: 'MPESA-SYN-0427', expectedVersion: t.version }).expect(200)).body;
    expect(t).toMatchObject({ status: 'PAID', paidBy: { id: userIds.payer }, paymentReference: 'MPESA-SYN-0427' });
    expect(new Set([userIds.finance, userIds.approver, userIds.payer]).size).toBe(3);
    const statuses = (await owner.auditEvent.findMany({ where: { tenantId, entityId: t.id, action: AUDIT_ACTIONS.FINANCE_TRANSACTION_STATUS_CHANGED } })).map((x) => (x.after as { status: string }).status);
    expect(statuses).toEqual(expect.arrayContaining(['REQUESTED', 'APPROVED', 'PAID']));
  });

  it('7. the approved entry cannot be edited; the correction is a reversing entry approved by someone else', async () => {
    const f = http('finance');
    const orig = (await f.get(`/finance/transactions/${ids.expense}`).expect(200)).body;
    const edit = await f.patch(`/finance/transactions/${orig.id}`).send({ amountMinor: 1_500_000, expectedVersion: orig.version }).expect(409);
    expect(edit.body.code).toBe('IMMUTABLE_RECORD');
    await expect(owner.financeTransaction.update({ where: { id: orig.id }, data: { amountMinor: 1n } })).rejects.toThrow(/IMMUTABLE_RECORD/);

    const balanceBefore = (await f.get('/finance/accounts').expect(200)).body.find((x: { id: string }) => x.id === ids.account).balanceMinor;
    const rev = (await f.post(`/finance/transactions/${orig.id}/reverse`).send({ reason: 'Invoiced twice by the supplier (synthetic)', expectedVersion: orig.version }).expect(201)).body;
    expect(rev).toMatchObject({ type: 'REVERSAL', status: 'REQUESTED', reversesId: orig.id, amount: { amountMinor: 1_850_000, currency: 'KES' } });
    await attachDocument('finance', rev.id, 'APPROVAL_MEMO', 'supplier-credit-note');
    const fresh = (await f.get(`/finance/transactions/${rev.id}`).expect(200)).body;
    // The reversal's requester cannot pay or approve it; the approver approves it.
    const approved = (await finance('approver', rev.id, { action: 'APPROVE', expectedVersion: fresh.version }).expect(200)).body;
    expect(approved.status).toBe('APPROVED');
    const after = (await f.get(`/finance/transactions/${orig.id}`).expect(200)).body;
    expect(after).toMatchObject({ status: 'REVERSED', reversedById: rev.id, amount: { amountMinor: 1_850_000 } });
    const balanceAfter = (await f.get('/finance/accounts').expect(200)).body.find((x: { id: string }) => x.id === ids.account).balanceMinor;
    expect(balanceAfter).toBe(balanceBefore + 1_850_000);
  });

  it('8. a contribution above the configured single-source cap is warned (unverified, with source note) and blocked once verified', async () => {
    const a = http('approver');
    await reauth('approver');
    const cap = (
      await a
        .post('/finance/settings/limits')
        .send({ kind: 'SINGLE_SOURCE_CAP_PCT', label: 'Rehearsal single-source cap', valueBasisPoints: 2000, capBasis: 'TOTAL_CONTRIBUTIONS', periodLabel: 'Synthetic 2027 cycle', effectiveFrom: '2026-01-01', legalSourceNote: SOURCE_NOTE, enforcement: 'BLOCK' })
        .expect(201)
    ).body;
    expect(cap).toMatchObject({ verified: false, enforcement: 'BLOCK', legalSourceNote: SOURCE_NOTE });

    const f = http('finance');
    const source = (await f.post('/finance/contribution-sources').send({ displayName: 'Synthetic Donor Barasa', kind: 'INDIVIDUAL', identifier: '23456789', declared: true }).expect(201)).body;
    expect(JSON.stringify(source)).not.toContain('23456789');
    const c0 = (
      await f
        .post('/finance/transactions')
        .send({ type: 'CONTRIBUTION', accountId: ids.account, categoryId: ids.incomeCat, contributionSourceId: source.id, amountMinor: 25_000_000, currency: 'KES', transactionDate: new Date().toISOString().slice(0, 10), description: 'Synthetic declared contribution', externalReference: 'RCPT-SYN-0001' })
        .expect(201)
    ).body;
    await attachDocument('finance', c0.id, 'RECEIPT', 'contribution-receipt');
    let c = (await finance('finance', c0.id, { action: 'SUBMIT', expectedVersion: (await f.get(`/finance/transactions/${c0.id}`).expect(200)).body.version }).expect(200)).body;
    const warn = c.compliance.find((x: { flag: string }) => x.flag === 'SINGLE_SOURCE_CAP_EXCEEDED');
    expect(warn).toMatchObject({ level: 'WARN', settingVerified: false, legalSourceNote: SOURCE_NOTE });
    expect(warn.message).toContain('Unverified – configure to the applicable law');
    // Warnings must be acknowledged before approval.
    expect((await finance('approver', c.id, { action: 'APPROVE', expectedVersion: c.version }).expect(409)).body.details.findings.length).toBeGreaterThan(0);

    // Once a person verifies the BLOCK setting, the approval is refused.
    await a.post(`/finance/settings/limits/${cap.id}/verify`).send({ verified: true, reason: 'Confirmed against the synthetic legal brief' }).expect(200);
    const block = await finance('approver', c.id, { action: 'APPROVE', acknowledgeWarnings: true, expectedVersion: c.version }).expect(409);
    expect(block.body.code).toBe('LIMIT_EXCEEDED');
    expect(block.body.details.findings[0]).toMatchObject({ flag: 'SINGLE_SOURCE_CAP_EXCEEDED', level: 'BLOCK', settingVerified: true, legalSourceNote: SOURCE_NOTE });
    c = (await f.get(`/finance/transactions/${c.id}`).expect(200)).body;
    expect(c.status).toBe('REQUESTED');
    expect(await auditCount(AUDIT_ACTIONS.FINANCE_LIMIT_SETTING_VERIFIED, { entityId: cap.id })).toBeGreaterThanOrEqual(1);
    // The entry stays on the flagged list (query flags read "true"/"false" literally).
    const flagged = (await f.get('/finance/transactions?flagged=true').expect(200)).body.items.map((x: { id: string }) => x.id);
    expect(flagged).toContain(c.id);
    expect(flagged).not.toContain(ids.expense);
  });

  /* ------------------------------- report builder ------------------------------- */

  it('9. finance data in the report builder: permission-scoped preview, export needs the elevated permission + re-auth and is audited', async () => {
    const def = { datasetKey: 'finance.transactions', fields: ['reference', 'type', 'status', 'amountMinor'], filters: [], groupBy: [] };
    // The operations role sees no finance dataset and cannot preview one.
    const opsDatasets = (await http('ops').get('/reports/datasets').expect(200)).body.map((x: { key: string }) => x.key);
    expect(opsDatasets.filter((k: string) => k.startsWith('finance.'))).toEqual([]);
    expect(opsDatasets).toContain('campaign.tasks');
    await http('ops').post('/reports/preview').send(def).expect(403);

    const f = http('finance');
    const preview = (await f.post('/reports/preview').send(def).expect(200)).body;
    expect(preview.rowCount).toBeGreaterThanOrEqual(3);
    expect(preview.exportRequirements).toMatchObject({ reauth: true });
    expect(preview.exportRequirements.permissions).toEqual(expect.arrayContaining(['finance.export', 'reports.export_sensitive']));
    // The finance approver may build but not export finance data.
    expect((await http('approver').post('/reports/exports').send({ definition: def, format: 'CSV', reason: 'Board pack (synthetic)' }).expect(403)).body.code).toBe('FORBIDDEN');

    // A fresh session has no recent re-authentication: the export is refused until the officer re-authenticates.
    await signIn('finance');
    expect((await http('finance').post('/reports/exports').send({ definition: def, format: 'CSV', reason: 'Board pack (synthetic)' })).status).toBe(401);
    await reauth('finance');
    const fresh = http('finance');
    const exp = (await fresh.post('/reports/exports').send({ definition: def, format: 'CSV', reason: 'Board pack (synthetic)' }).expect(201)).body;
    expect(exp).toMatchObject({ sensitive: true, classification: 'CONFIDENTIAL', reason: 'Board pack (synthetic)' });
    const row = await owner.reportExport.findUniqueOrThrow({ where: { id: exp.id } });
    expect(row.reauthAt).not.toBeNull();
    expect(await auditCount(AUDIT_ACTIONS.REPORT_EXPORTED, { entityId: exp.id })).toBe(1);
    const csv = await download(exp.url);
    expect(csv).toContain('Generated:');
    expect(csv).toContain('Data classification: CONFIDENTIAL');

    // The finance register export is gated the same way and audited.
    const reg = (await fresh.post('/finance/exports').send({ register: 'LEDGER', format: 'CSV', reason: 'Monthly review (synthetic)' }).expect(200)).body;
    expect(reg.url).toBeTruthy();
    expect(await auditCount(AUDIT_ACTIONS.FINANCE_EXPORTED, { actorId: userIds.finance })).toBeGreaterThanOrEqual(1);
  });

  /* ------------------------------- communications ------------------------------- */

  it('10. content goes draft → editorial review → approval → publication → archive with author ≠ approver', async () => {
    const lead = http('lead');
    // No recipient lists, voter targeting or bulk outreach.
    expect((await lead.post('/comms/content').send({ type: 'NOTICE', title: 'Town hall summary', body: 'x', audience: 'PUBLIC_NOTICE', recipients: ['+254700000001'] }).expect(400)).body.code).toBe('VALIDATION_FAILED');
    let c = (
      await lead
        .post('/comms/content')
        .send({ type: 'NOTICE', title: 'Township town hall summary (synthetic)', body: 'Residents raised ward road questions; answers follow next week.', audience: 'PUBLIC_NOTICE', departmentId: ids.dept, eventId: ids.event })
        .expect(201)
    ).body;
    const tr = (who: Persona, action: string) => http(who).post(`/comms/content/${c.id}/transition`).send({ action, expectedVersion: c.version });
    c = (await tr('lead', 'SUBMIT').expect(200)).body;
    expect(c.status).toBe('EDITORIAL_REVIEW');
    c = (await http('editor').patch(`/comms/content/${c.id}`).send({ body: 'Residents raised ward road questions; written answers follow next week.', expectedVersion: c.version }).expect(200)).body;
    c = (await tr('editor', 'EDITORIAL_APPROVE').expect(200)).body;
    expect(c.status).toBe('AWAITING_APPROVAL');
    // The author cannot approve; the approver must re-authenticate.
    expect((await tr('lead', 'APPROVE')).status).toBe(403);
    expect((await tr('commsApprover', 'APPROVE').expect(401)).body.code).toBe('REAUTH_REQUIRED');
    const awaiting = (await http('commsApprover').get('/comms/content?view=awaiting_me').expect(200)).body;
    expect(awaiting.items.map((x: { id: string }) => x.id)).toContain(c.id);
    await reauth('commsApprover');
    c = (await tr('commsApprover', 'APPROVE').expect(200)).body;
    c = (await tr('commsApprover', 'PUBLISH').expect(200)).body;
    expect(c).toMatchObject({ status: 'PUBLISHED', author: { id: userIds.lead }, approver: { id: userIds.commsApprover } });
    expect(c.author.id).not.toBe(c.approver.id);
    expect((await http('editor').patch(`/comms/content/${c.id}`).send({ body: 'Silent edit', expectedVersion: c.version }).expect(409)).body.code).toBe('IMMUTABLE_RECORD');
    c = (await tr('editor', 'ARCHIVE').expect(200)).body;
    expect(c.status).toBe('ARCHIVED');
    expect(c.revisions.map((r: { kind: string }) => r.kind)).toEqual(expect.arrayContaining(['CREATED', 'SUBMITTED_FOR_REVIEW', 'EDITED', 'EDITORIAL_APPROVED', 'APPROVED', 'PUBLISHED']));
    expect(await auditCount(AUDIT_ACTIONS.CONTENT_STATUS_CHANGED, { entityId: c.id })).toBeGreaterThanOrEqual(5);
  });
});

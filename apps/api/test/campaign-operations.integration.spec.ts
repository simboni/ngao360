/**
 * Campaign operations over HTTP (docs/API_CONTRACT.md §23–26): department
 * moves without cycles, department scope (404 outside, OUT_OF_SCOPE on
 * bodies), task dependencies without cycles and with open-dependency checks,
 * the task review step (owner ≠ reviewer), assignment notifications, the
 * communications workflow with author ≠ approver, refusal of recipient-list
 * fields and correction history, and after-action review by someone other
 * than the author. Synthetic data only.
 */
import { type CampaignFixture, createCampaignFixture, describeDb, seedDepartment } from './campaign-fixtures';

jest.setTimeout(120_000);

describeDb('Campaign operations (integration)', () => {
  let f: CampaignFixture;
  let ops: { id: string; path: string; depth: number };
  let comms: { id: string; path: string; depth: number };

  const TASK_ALL = ['tasks.view', 'tasks.create', 'tasks.assign', 'tasks.review'] as const;

  beforeAll(async () => {
    f = await createCampaignFixture({
      manager: { perms: ['org.departments.view', 'org.departments.manage', 'org.departments.all', 'org.teams.view', 'org.teams.manage', ...TASK_ALL, 'tasks.manage_all', 'events.view', 'events.create', 'events.manage', 'events.attendance'] },
      lead: { perms: ['org.departments.view', 'org.teams.view', ...TASK_ALL, 'events.view', 'events.create'] },
      member: { perms: ['org.departments.view', 'org.teams.view', 'tasks.view', 'tasks.create'] },
      reviewer: { perms: ['tasks.view', 'tasks.review', 'events.view', 'events.after_action.approve'] },
      outsider: { perms: ['tasks.view', 'tasks.create', 'org.teams.view', 'org.teams.manage'], scope: 'k2' },
      author: { perms: ['comms.content.view', 'comms.content.draft', 'comms.content.approve'] },
      editor: { perms: ['comms.content.view', 'comms.content.edit'] },
      approver: { perms: ['comms.content.view', 'comms.content.approve', 'comms.content.publish'] },
      approverNoReauth: { perms: ['comms.content.view', 'comms.content.approve'], reauth: false },
      other: { perms: ['tasks.view', 'tasks.create'], tenant: 'other' },
    });
    ops = await seedDepartment(f, 'OPS', 'Operations (synthetic)', { leadUserId: f.users.lead });
    comms = await seedDepartment(f, 'COMMS', 'Communications (synthetic)');
    // Department membership through teams (the scope rule: involvement OR own departments).
    const team = async (departmentId: string, name: string, who: string[]) => {
      const t = await f.owner.team.create({ data: { tenantId: f.tenantId, departmentId, name, createdById: f.users.manager! } });
      for (const w of who) await f.owner.teamMember.create({ data: { tenantId: f.tenantId, teamId: t.id, userId: f.users[w]!, addedById: f.users.manager! } });
    };
    await team(comms.id, 'Press desk (synthetic)', ['author', 'editor', 'approver', 'approverNoReauth']);
    await team(ops.id, 'Operations reviewers (synthetic)', ['reviewer']);
  });
  afterAll(async () => f?.close());

  describe('organisation', () => {
    it('moves a department and refuses cycles; descendants are re-pathed', async () => {
      const m = f.http('manager');
      const child = (await m.post('/org/departments').send({ code: 'OPS-LOG', name: 'Logistics (synthetic)', parentId: ops.id }).expect(201)).body;
      const grand = (await m.post('/org/departments').send({ code: 'OPS-LOG-FLEET', name: 'Fleet (synthetic)', parentId: child.id }).expect(201)).body;
      expect(grand.depth).toBe(2);
      const opsNow = (await m.get(`/org/departments/${ops.id}`).expect(200)).body;
      const cycle = await m.patch(`/org/departments/${ops.id}`).send({ parentId: grand.id, expectedVersion: opsNow.version }).expect(409);
      expect(cycle.body.details.reason).toBe('CYCLE');
      await m.patch(`/org/departments/${child.id}`).send({ parentId: comms.id, expectedVersion: child.version }).expect(200);
      const g2 = (await m.get(`/org/departments/${grand.id}`).expect(200)).body;
      expect(g2.path.map((p: { code: string }) => p.code)).toEqual(['COMMS', 'OPS-LOG']);
      expect(g2.depth).toBe(2);
      const audit = await f.owner.auditEvent.findMany({ where: { tenantId: f.tenantId, entityId: child.id, action: 'org.department.moved' } });
      expect(audit).toHaveLength(1);
      // The lead may rename but not move or change the lead.
      const opsV = (await m.get(`/org/departments/${ops.id}`).expect(200)).body.version;
      await f.http('lead').patch(`/org/departments/${ops.id}`).send({ name: 'Field operations (synthetic)', expectedVersion: opsV }).expect(200);
      await f.http('lead').patch(`/org/departments/${ops.id}`).send({ leadUserId: f.users.member, expectedVersion: opsV + 1 }).expect(403);
    });

    it('creates teams inside the caller grant and keeps membership history', async () => {
      const m = f.http('manager');
      const team = (await m.post('/org/teams').send({ name: 'Township mobilisers (synthetic)', departmentId: ops.id, coordinatorUserId: f.users.lead, geographicUnitId: f.units.w1 }).expect(201)).body;
      expect(team.members).toHaveLength(1);
      const out = await f.http('outsider').post('/org/teams').send({ name: 'Elsewhere', departmentId: ops.id, geographicUnitId: f.units.w1 }).expect(403);
      expect(out.body.code).toBe('OUT_OF_SCOPE');
      let d = (await f.http('lead').post(`/org/teams/${team.id}/members`).send({ members: [{ userId: f.users.member }] }).expect(200)).body;
      const row = d.members.find((x: { user: { id: string } }) => x.user.id === f.users.member);
      d = (await f.http('lead').post(`/org/teams/${team.id}/members/${row.id}/remove`).send({ reason: 'Moved to another team' }).expect(200)).body;
      expect(d.members.find((x: { id: string }) => x.id === row.id).leftAt).not.toBeNull();
      d = (await m.post(`/org/teams/${team.id}/members`).send({ members: [{ userId: f.users.member }] }).expect(200)).body;
      expect(d.members.filter((x: { user: { id: string } }) => x.user.id === f.users.member)).toHaveLength(2);
    });
  });

  describe('tasks', () => {
    let a: { id: string; version: number };
    let b: { id: string; version: number };

    it('creates tasks in scope, notifies the owner and hides them from other departments and tenants', async () => {
      const lead = f.http('lead');
      a = (await lead.post('/tasks').send({ title: 'Book the Township venue', ownerId: f.users.member, reviewerId: f.users.reviewer, departmentId: ops.id, status: 'READY', checklist: ['Call venue', 'Pay deposit'] }).expect(201)).body;
      expect(a).toMatchObject({ status: 'READY', owner: { id: f.users.member }, checklist: { done: 0, total: 2 } });
      const n = await f.owner.notification.findFirst({ where: { userId: f.users.member, type: 'task.assigned', entityId: a.id } });
      expect(n).toMatchObject({ module: 'tasks', link: `/tasks/${a.id}` });
      b = (await lead.post('/tasks').send({ title: 'Print agenda', ownerId: f.users.lead, departmentId: ops.id, status: 'READY', dependsOnTaskIds: [a.id] }).expect(201)).body;
      // Department and tenant scope.
      await f.http('outsider').get(`/tasks/${a.id}`).expect(404);
      await f.http('other').get(`/tasks/${a.id}`).expect(404);
      const list = (await f.http('outsider').get('/tasks').expect(200)).body;
      expect(list.items.map((t: { id: string }) => t.id)).not.toContain(a.id);
      const body = await f.http('outsider').post('/tasks').send({ title: 'Out of my area', ownerId: f.users.outsider, geographicUnitId: f.units.w1 }).expect(403);
      expect(body.body.code).toBe('OUT_OF_SCOPE');
      await f.http('member').post('/tasks').send({ title: 'Assign to someone else', ownerId: f.users.lead }).expect(403);
    });

    it('refuses dependency cycles and blocks starting while a dependency is open', async () => {
      const lead = f.http('lead');
      const cycle = await f.http('manager').post(`/tasks/${a.id}/dependencies`).send({ dependsOnTaskId: b.id }).expect(409);
      expect(cycle.body.details.reason).toBe('CYCLE');
      await f.http('manager').post(`/tasks/${b.id}/dependencies`).send({ dependsOnTaskId: b.id }).expect(409);
      const blocked = await lead.post(`/tasks/${b.id}/status`).send({ toStatus: 'IN_PROGRESS', expectedVersion: b.version }).expect(409);
      expect(blocked.body.details.openDependencies[0].id).toBe(a.id);
      // A task manager may override with a recorded reason.
      const over = (await f.http('manager').post(`/tasks/${b.id}/status`).send({ toStatus: 'IN_PROGRESS', reason: 'Agenda draft can start early', expectedVersion: b.version }).expect(200)).body;
      expect(over.timeline.at(-1).note).toContain('Dependency override');
    });

    it('the owner cannot complete a reviewed task alone or review it; the reviewer approves', async () => {
      const m = f.http('member');
      let d = (await m.post(`/tasks/${a.id}/status`).send({ toStatus: 'IN_PROGRESS', expectedVersion: a.version }).expect(200)).body;
      const direct = await m.post(`/tasks/${a.id}/status`).send({ toStatus: 'COMPLETED', expectedVersion: d.version }).expect(409);
      expect(direct.body.details.reason).toBe('REVIEW_REQUIRED');
      d = (await m.put(`/tasks/${a.id}/checklist`).send({ items: d.checklistItems.map((c: { id: string; label: string }) => ({ id: c.id, label: c.label, isDone: true })), expectedVersion: d.version }).expect(200)).body;
      expect(d.checklist).toEqual({ done: 2, total: 2 });
      d = (await m.post(`/tasks/${a.id}/status`).send({ toStatus: 'SUBMITTED_FOR_REVIEW', expectedVersion: d.version }).expect(200)).body;
      expect(await f.owner.notification.count({ where: { userId: f.users.reviewer, type: 'task.review_requested', entityId: a.id } })).toBe(1);
      // Owner holding tasks.review would still be refused (SoD); the member lacks it, so the guard answers first.
      await m.post(`/tasks/${a.id}/review`).send({ decision: 'APPROVE', expectedVersion: d.version }).expect(403);
      d = (await f.http('reviewer').post(`/tasks/${a.id}/review`).send({ decision: 'APPROVE', expectedVersion: d.version }).expect(200)).body;
      expect(d).toMatchObject({ status: 'COMPLETED' });
      expect(d.completedAt).not.toBeNull();
      expect((await m.patch(`/tasks/${a.id}`).send({ title: 'Changed later', expectedVersion: d.version }).expect(409)).body.code).toBe('IMMUTABLE_RECORD');
      const types = d.timeline.map((e: { type: string }) => e.type);
      expect(types).toEqual(expect.arrayContaining(['CREATED', 'ASSIGNED', 'STATUS_CHANGED', 'CHECKLIST_UPDATED', 'REVIEW_APPROVED']));
    });

    it('owner reviewing their own task is a separation-of-duties violation', async () => {
      const t = (await f.http('lead').post('/tasks').send({ title: 'Self review attempt', ownerId: f.users.lead, reviewerId: f.users.reviewer, status: 'READY', departmentId: ops.id }).expect(201)).body;
      let d = (await f.http('lead').post(`/tasks/${t.id}/status`).send({ toStatus: 'IN_PROGRESS', expectedVersion: t.version }).expect(200)).body;
      d = (await f.http('lead').post(`/tasks/${t.id}/status`).send({ toStatus: 'SUBMITTED_FOR_REVIEW', expectedVersion: d.version }).expect(200)).body;
      const sod = await f.http('lead').post(`/tasks/${t.id}/review`).send({ decision: 'APPROVE', expectedVersion: d.version }).expect(403);
      expect(sod.body.code).toBe('SEPARATION_OF_DUTIES');
      const board = (await f.http('lead').get('/tasks/board').expect(200)).body;
      expect(board.columns.find((c: { status: string }) => c.status === 'SUBMITTED_FOR_REVIEW').total).toBeGreaterThanOrEqual(1);
      const workload = (await f.http('lead').get('/tasks/workload').expect(200)).body;
      expect(workload.rows.length).toBeGreaterThan(0);
      await f.http('lead').get('/tasks/calendar?from=2026-01-01T00:00:00.000Z&to=2026-12-31T00:00:00.000Z').expect(400);
    });
  });

  describe('communications', () => {
    it('runs draft → editorial review → approval → publication with author ≠ approver and keeps corrections', async () => {
      const refused = await f.http('author').post('/comms/content').send({ type: 'NOTICE', title: 'Town hall notice', body: 'Synthetic body', audience: 'PUBLIC_NOTICE', recipients: ['0700000000'] }).expect(400);
      expect(refused.body.code).toBe('VALIDATION_FAILED');
      let c = (await f.http('author').post('/comms/content').send({ type: 'NOTICE', title: 'Town hall notice', body: 'Synthetic town hall on Saturday.', audience: 'PUBLIC_NOTICE', departmentId: comms.id }).expect(201)).body;
      const tr = (who: string, action: string, extra: Record<string, unknown> = {}) => f.http(who).post(`/comms/content/${c.id}/transition`).send({ action, expectedVersion: c.version, ...extra });
      c = (await tr('author', 'SUBMIT').expect(200)).body;
      expect(c.status).toBe('EDITORIAL_REVIEW');
      c = (await f.http('editor').patch(`/comms/content/${c.id}`).send({ body: 'Synthetic town hall on Saturday at 10:00.', expectedVersion: c.version }).expect(200)).body;
      expect(c.revision).toBe(2);
      c = (await tr('editor', 'EDITORIAL_APPROVE').expect(200)).body;
      expect(c.status).toBe('AWAITING_APPROVAL');
      expect((await tr('author', 'APPROVE').expect(403)).body.code).toBe('SEPARATION_OF_DUTIES');
      expect((await tr('approverNoReauth', 'APPROVE').expect(401)).body.code).toBe('REAUTH_REQUIRED');
      c = (await tr('approver', 'APPROVE').expect(200)).body;
      c = (await tr('approver', 'PUBLISH').expect(200)).body;
      expect(c).toMatchObject({ status: 'PUBLISHED', approver: { id: f.users.approver } });
      expect((await f.http('editor').patch(`/comms/content/${c.id}`).send({ body: 'Silent edit', expectedVersion: c.version }).expect(409)).body.code).toBe('IMMUTABLE_RECORD');
      // The author cannot record a correction of their own text.
      expect((await f.http('author').post(`/comms/content/${c.id}/correct`).send({ body: 'x', correctionNote: 'Fix time', expectedVersion: c.version }).expect(403)).body.code).toBe('SEPARATION_OF_DUTIES');
      c = (await f.http('approver').post(`/comms/content/${c.id}/correct`).send({ body: 'Synthetic town hall on Saturday at 11:00.', correctionNote: 'Corrected the start time', expectedVersion: c.version }).expect(200)).body;
      expect(c).toMatchObject({ correctionCount: 1, revision: 3, status: 'PUBLISHED' });
      const kinds = c.revisions.map((r: { kind: string }) => r.kind);
      expect(kinds).toEqual(['CREATED', 'SUBMITTED_FOR_REVIEW', 'EDITED', 'EDITORIAL_APPROVED', 'APPROVED', 'PUBLISHED', 'CORRECTED']);
      expect(c.revisions.find((r: { kind: string }) => r.kind === 'EDITED').body).toBe('Synthetic town hall on Saturday at 10:00.');
    });
  });

  describe('events', () => {
    it('records attendance without exposing contact; after-action review needs someone other than the author', async () => {
      const m = f.http('manager');
      const now = Date.now();
      let e = (await m.post('/events').send({ title: 'Township town hall (synthetic)', type: 'TOWN_HALL', startsAt: new Date(now - 3 * 3600_000).toISOString(), endsAt: new Date(now - 3600_000).toISOString(), organiserId: f.users.manager, departmentId: ops.id, geographicUnitId: f.units.w1, budgetMinor: 5_000_000 }).expect(201)).body;
      for (const s of ['PLANNED', 'CONFIRMED', 'IN_PROGRESS']) e = (await m.post(`/events/${e.id}/status`).send({ toStatus: s, expectedVersion: e.version }).expect(200)).body;
      const a = (await m.post(`/events/${e.id}/attendance`).send({ participantName: 'Synthetic Participant', role: 'PARTICIPANT', contact: { phone: '+254700000001', consent: true, consentNoticeVersion: 'v1', purpose: 'Event follow-up only' } }).expect(201)).body;
      expect(a).toMatchObject({ hasContact: true });
      expect(JSON.stringify(a)).not.toContain('700000001');
      const list = (await m.get(`/events/${e.id}/attendance`).expect(200)).body;
      expect(list).toMatchObject({ total: 1, withContact: 1 });
      expect(JSON.stringify(list)).not.toContain('700000001');
      e = (await m.post(`/events/${e.id}/status`).send({ toStatus: 'COMPLETED', expectedVersion: e.version }).expect(200)).body;
      const aar = (await m.put(`/events/${e.id}/after-action?submit=true`).send({ whatOccurred: 'Synthetic town hall held as planned.', attendanceTotal: 120, attendanceBreakdown: { PARTICIPANT: 110, STAFF: 10 }, actualSpendMinor: 4_500_000 }).expect(200)).body;
      expect(aar.status).toBe('SUBMITTED');
      expect((await m.post(`/events/${e.id}/after-action/review`).send({ decision: 'APPROVE', expectedVersion: aar.version }).expect(403)).body.code).toBe('FORBIDDEN');
      const ok = (await f.http('reviewer').post(`/events/${e.id}/after-action/review`).send({ decision: 'APPROVE', expectedVersion: aar.version }).expect(200)).body;
      expect(ok).toMatchObject({ status: 'APPROVED', reviewer: { id: f.users.reviewer } });
      await m.put(`/events/${e.id}/after-action`).send({ whatOccurred: 'Changed afterwards.', attendanceTotal: 1, expectedVersion: ok.version }).expect(409);
    });
  });
});

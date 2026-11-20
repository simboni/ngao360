/**
 * Campaign and organisation foundation (database level): tenant isolation of
 * every campaign table, privileges of the runtime role, append-only
 * histories, ledger immutability and maker-checker checks, approval
 * prerequisites, versioned limit settings, content corrections, team
 * membership history, breach closure rules, the department-scope helper and
 * the module key. All data synthetic.
 */
import { createPrismaClient, type PrismaClient, type TenantTx, withTenant } from '@ngao360/db';
import { PERMISSION_DEFINITIONS, type PermissionGrant, type PermissionKey } from '@ngao360/shared';
import { randomUUID } from 'node:crypto';
import type { AuthContext } from '../src/auth/auth.types';
import { campaignRecordInScope, loadCampaignScope, taskScopeWhere } from '../src/modules/campaign/common/campaign-scope';

const OWNER_URL = process.env.TEST_DATABASE_URL;
const APP_URL = process.env.TEST_APP_DATABASE_URL;
const d = OWNER_URL && APP_URL ? describe : describe.skip;

const CAMPAIGN_TABLES = [
  'departments', 'teams', 'team_members', 'tasks', 'task_collaborators', 'task_dependencies', 'task_checklist_items',
  'task_comments', 'task_attachments', 'task_events', 'campaign_events', 'event_invited_teams', 'event_agenda_items',
  'event_logistics_items', 'event_attendances', 'event_attendance_contacts', 'event_documents', 'event_after_action_reports',
  'content_items', 'content_revisions', 'finance_accounts', 'finance_categories', 'finance_payees', 'contribution_sources',
  'finance_budget_lines', 'finance_transactions', 'finance_transaction_documents', 'finance_transaction_events',
  'finance_limit_settings', 'report_templates', 'report_exports', 'notification_preferences', 'notification_deliveries',
  'notification_acknowledgements', 'breach_records', 'breach_events',
];

function authFor(tenantId: string, userId: string, perms: PermissionKey[], scope: Partial<PermissionGrant> = {}): AuthContext {
  return {
    userId,
    tenantId,
    sessionId: randomUUID(),
    email: 'x@campaign.example.org',
    displayName: 'Synthetic',
    mfaVerified: true,
    mfaRequired: false,
    reauthAt: null,
    roles: [],
    permissions: new Set(perms),
    grants: perms.map((permission) => ({
      permission,
      scopeType: 'ORGANISATION',
      geographicUnitId: null,
      pollingStationId: null,
      pollingStationCode: null,
      pollingStationCycleId: null,
      electionCycleId: null,
      expiresAt: null,
      ...scope,
    })),
  } as AuthContext;
}

d('campaign and organisation foundation (database)', () => {
  let owner: PrismaClient;
  let app: PrismaClient;
  const tA = randomUUID();
  const tB = randomUUID();
  const ids = {} as Record<string, string>;
  const asA = <T>(fn: (tx: TenantTx) => Promise<T>) => withTenant(app, tA, fn);
  const asB = <T>(fn: (tx: TenantTx) => Promise<T>) => withTenant(app, tB, fn);

  const newTransaction = (over: Record<string, unknown> = {}) =>
    asA((tx) =>
      tx.financeTransaction.create({
        data: {
          tenantId: tA,
          reference: `FIN-2027-${randomUUID().slice(0, 6)}`,
          type: 'EXPENSE',
          status: 'REQUESTED',
          accountId: ids.account!,
          categoryId: ids.category!,
          amountMinor: 1_250_000n,
          transactionDate: new Date('2027-03-01'),
          payeeId: ids.payee!,
          description: 'Synthetic sound system hire',
          requestedById: ids.officer!,
          requestedAt: new Date(),
          ...over,
        },
      }),
    );

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
    for (const [id, slug] of [[tA, `campaign-a-${tA.slice(0, 8)}`], [tB, `campaign-b-${tB.slice(0, 8)}`]] as const) {
      await owner.tenant.create({ data: { id, slug, name: slug, type: 'CAMPAIGN' } });
    }
    for (const who of ['manager', 'lead', 'member', 'outsider', 'officer', 'approver', 'payer', 'author', 'commsApprover', 'dpo', 'dpo2']) {
      ids[who] = (await owner.user.create({ data: { tenantId: tA, email: `${who}@campaign.example.org`, displayName: `Synthetic ${who}`, status: 'ACTIVE' } })).id;
    }
    ids.userB = (await owner.user.create({ data: { tenantId: tB, email: 'b@campaign.example.org', displayName: 'B', status: 'ACTIVE' } })).id;
    const file = await owner.storedFile.create({
      data: { tenantId: tA, sha256: 'a'.repeat(64), mimeType: 'application/pdf', sizeBytes: 10n, originalFilename: 'invoice.pdf', purpose: 'FINANCE_DOCUMENT', storageDriver: 'LOCAL', storageKey: `k-${tA}`, uploadedById: ids.officer! },
    });
    ids.file = file.id;

    await asA(async (tx) => {
      const root = randomUUID();
      await tx.department.create({ data: { id: root, tenantId: tA, code: 'OPS', name: 'Operations', path: `/${root}/`, leadUserId: ids.lead!, createdById: ids.manager! } });
      const child = randomUUID();
      await tx.department.create({ data: { id: child, tenantId: tA, code: 'OPS-LOG', name: 'Logistics', parentId: root, path: `/${root}/${child}/`, depth: 1, createdById: ids.manager! } });
      const other = randomUUID();
      await tx.department.create({ data: { id: other, tenantId: tA, code: 'COMMS', name: 'Communications', path: `/${other}/`, createdById: ids.manager! } });
      Object.assign(ids, { deptRoot: root, deptChild: child, deptOther: other });
      const team = await tx.team.create({ data: { tenantId: tA, departmentId: other, name: 'Press desk', coordinatorUserId: ids.author!, createdById: ids.manager! } });
      ids.team = team.id;
      ids.membership = (await tx.teamMember.create({ data: { tenantId: tA, teamId: team.id, userId: ids.member!, addedById: ids.manager! } })).id;
      const mk = (ref: string, departmentId: string | null, ownerId: string) =>
        tx.task.create({ data: { tenantId: tA, reference: ref, title: `Synthetic ${ref}`, ownerId, createdById: ids.manager!, departmentId } });
      ids.taskChild = (await mk('TSK-2027-000001', child, ids.manager!)).id;
      ids.taskOther = (await mk('TSK-2027-000002', other, ids.manager!)).id;
      ids.taskMine = (await mk('TSK-2027-000003', other, ids.outsider!)).id;
      ids.taskEvent = (await tx.taskEvent.create({ data: { tenantId: tA, taskId: ids.taskChild, type: 'CREATED', toStatus: 'DRAFT', actorId: ids.manager! } })).id;
      ids.account = (await tx.financeAccount.create({ data: { tenantId: tA, name: 'Synthetic campaign account', type: 'BANK', accountNumberMasked: '•••• 0001', createdById: ids.approver! } })).id;
      ids.category = (await tx.financeCategory.create({ data: { tenantId: tA, code: 'EXP.EVENTS', name: 'Events', kind: 'EXPENSE' } })).id;
      ids.payee = (await tx.financePayee.create({ data: { tenantId: tA, name: 'Synthetic Sound Ltd', kind: 'SUPPLIER', createdById: ids.officer! } })).id;
      ids.content = (
        await tx.contentItem.create({ data: { tenantId: tA, reference: 'CNT-2027-000001', type: 'PRESS_RELEASE', title: 'Synthetic release', body: 'Original text', audience: 'MEDIA', authorId: ids.author! } })
      ).id;
      ids.breach = (
        await tx.breachRecord.create({ data: { tenantId: tA, reference: 'BRE-2027-000001', title: 'Synthetic drill', description: 'Tabletop drill', isDrill: true, severity: 'LOW', detectedAt: new Date(), reportedById: ids.dpo! } })
      ).id;
    });
  }, 60_000);

  afterAll(async () => {
    await owner?.$disconnect();
    await app?.$disconnect();
  });

  it('enables RLS with a tenant policy on every campaign table', async () => {
    const rows = await owner.$queryRaw<Array<{ relname: string; relrowsecurity: boolean }>>`
      SELECT c.relname, c.relrowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = current_schema() AND c.relname = ANY(${CAMPAIGN_TABLES})`;
    expect(rows).toHaveLength(CAMPAIGN_TABLES.length);
    expect(rows.every((r) => r.relrowsecurity)).toBe(true);
    const counts = await asB(async (tx) => [await tx.department.count(), await tx.task.count(), await tx.financeTransaction.count(), await tx.contentItem.count(), await tx.breachRecord.count(), await tx.team.count()]);
    expect(counts.every((c) => c === 0)).toBe(true);
    await expect(asB((tx) => tx.taskComment.create({ data: { tenantId: tA, taskId: ids.taskChild!, authorId: ids.userB!, body: 'x' } }))).rejects.toThrow(/row-level security/);
  });

  it('never deletes campaign records and keeps histories append-only (even the owner role)', async () => {
    await expect(asA((tx) => tx.task.delete({ where: { id: ids.taskChild! } }))).rejects.toThrow();
    await expect(owner.task.delete({ where: { id: ids.taskChild! } })).rejects.toThrow(/IMMUTABLE_RECORD/);
    await expect(owner.department.delete({ where: { id: ids.deptOther! } })).rejects.toThrow(/IMMUTABLE_RECORD/);
    await expect(owner.taskEvent.update({ where: { id: ids.taskEvent! }, data: { note: 'tampered' } })).rejects.toThrow(/IMMUTABLE_RECORD/);
    await expect(asA((tx) => tx.taskEvent.update({ where: { id: ids.taskEvent! }, data: { note: 'tampered' } }))).rejects.toThrow();
    // Link rows may be removed (the timeline records it).
    await asA((tx) => tx.taskCollaborator.create({ data: { tenantId: tA, taskId: ids.taskChild!, userId: ids.member!, addedById: ids.manager! } }));
    await expect(asA((tx) => tx.taskCollaborator.delete({ where: { taskId_userId: { taskId: ids.taskChild!, userId: ids.member! } } }))).resolves.toBeTruthy();
  });

  it('tasks: reviewer is never the owner, no self-dependency, completed tasks are final', async () => {
    await expect(asA((tx) => tx.task.update({ where: { id: ids.taskChild! }, data: { reviewerId: ids.manager! } }))).rejects.toThrow(/tasks_reviewer_not_owner_check/);
    await expect(asA((tx) => tx.taskDependency.create({ data: { tenantId: tA, taskId: ids.taskChild!, dependsOnTaskId: ids.taskChild!, createdById: ids.manager! } }))).rejects.toThrow(
      /task_dependencies_not_self_check/,
    );
    await asA((tx) => tx.task.update({ where: { id: ids.taskMine! }, data: { status: 'COMPLETED', completedAt: new Date() } }));
    await expect(asA((tx) => tx.task.update({ where: { id: ids.taskMine! }, data: { status: 'IN_PROGRESS' } }))).rejects.toThrow(/IMMUTABLE_RECORD/);
  });

  it('team membership: one active row per member; leaving is recorded once', async () => {
    await expect(asA((tx) => tx.teamMember.create({ data: { tenantId: tA, teamId: ids.team!, userId: ids.member!, addedById: ids.manager! } }))).rejects.toThrow();
    await asA((tx) => tx.teamMember.update({ where: { id: ids.membership! }, data: { leftAt: new Date(), removedById: ids.manager! } }));
    await expect(asA((tx) => tx.teamMember.update({ where: { id: ids.membership! }, data: { leftAt: null } }))).rejects.toThrow(/IMMUTABLE_RECORD/);
    await asA((tx) => tx.teamMember.create({ data: { tenantId: tA, teamId: ids.team!, userId: ids.member!, addedById: ids.manager! } }));
  });

  it('ledger: entries start unapproved, positive integer minor units, counterparty per type', async () => {
    await expect(newTransaction({ status: 'APPROVED', approvedById: ids.approver!, approvedAt: new Date() })).rejects.toThrow(/IMMUTABLE_RECORD/);
    await expect(newTransaction({ amountMinor: 0n })).rejects.toThrow(/finance_transactions_amount_check/);
    await expect(newTransaction({ payeeId: null })).rejects.toThrow(/finance_transactions_counterparty_check/);
    await expect(newTransaction({ currency: 'kes' })).rejects.toThrow(/finance_transactions_currency_check/);
  });

  it('ledger: maker-checker (requester ≠ approver ≠ payer) and approval prerequisites', async () => {
    const tx1 = await newTransaction();
    const approve = (by: string) => asA((tx) => tx.financeTransaction.update({ where: { id: tx1.id }, data: { status: 'APPROVED', approvedById: by, approvedAt: new Date() } }));
    await expect(approve(ids.approver!)).rejects.toThrow(/APPROVAL_INCOMPLETE/);
    await asA((tx) => tx.financeTransaction.update({ where: { id: tx1.id }, data: { externalReference: 'INV-SYN-001' } }));
    await expect(approve(ids.approver!)).rejects.toThrow(/supporting document/);
    await asA((tx) => tx.financeTransactionDocument.create({ data: { tenantId: tA, transactionId: tx1.id, fileId: ids.file!, kind: 'INVOICE', addedById: ids.officer! } }));
    await expect(approve(ids.officer!)).rejects.toThrow(/finance_transactions_approver_check/);
    await expect(approve(ids.approver!)).resolves.toMatchObject({ status: 'APPROVED' });

    const pay = (by: string) =>
      asA((tx) => tx.financeTransaction.update({ where: { id: tx1.id }, data: { status: 'PAID', paidById: by, paidAt: new Date(), paymentReference: 'MPESA-SYN-1' } }));
    await expect(pay(ids.officer!)).rejects.toThrow(/finance_transactions_payer_check/);
    await expect(asA((tx) => tx.financeTransaction.update({ where: { id: tx1.id }, data: { amountMinor: 1n } }))).rejects.toThrow(/IMMUTABLE_RECORD/);
    await expect(pay(ids.payer!)).resolves.toMatchObject({ status: 'PAID' });
    await expect(asA((tx) => tx.financeTransaction.update({ where: { id: tx1.id }, data: { paymentReference: 'changed' } }))).rejects.toThrow(/IMMUTABLE_RECORD/);
    await expect(asA((tx) => tx.financeTransaction.update({ where: { id: tx1.id }, data: { status: 'APPROVED' } }))).rejects.toThrow(/IMMUTABLE_RECORD/);
    await expect(asA((tx) => tx.financeTransactionDocument.deleteMany({ where: { transactionId: tx1.id } }))).rejects.toThrow();

    // Correction = reversing entry; the original only moves to REVERSED.
    const rev = await newTransaction({ type: 'REVERSAL', reversesId: tx1.id, payeeId: null, description: 'Reversal: duplicate payment (synthetic)' });
    await expect(newTransaction({ type: 'REVERSAL', reversesId: tx1.id, payeeId: null })).rejects.toThrow();
    await expect(newTransaction({ type: 'EXPENSE', reversesId: tx1.id })).rejects.toThrow(/finance_transactions_reversal_check/);
    await expect(asA((tx) => tx.financeTransaction.update({ where: { id: tx1.id }, data: { status: 'REVERSED', reversedAt: new Date() } }))).resolves.toMatchObject({ status: 'REVERSED' });
    expect(rev.reversesId).toBe(tx1.id);
  });

  it('limit settings: legal source note required, value columns immutable, verification recorded', async () => {
    const base = { tenantId: tA, kind: 'SINGLE_SOURCE_CAP_PCT' as const, label: 'Demo cap', valueBasisPoints: 2000, capBasis: 'TOTAL_CONTRIBUTIONS' as const, periodLabel: '2027', effectiveFrom: new Date('2027-01-01'), createdById: ids.approver! };
    await expect(asA((tx) => tx.financeLimitSetting.create({ data: { ...base, legalSourceNote: 'tbd' } }))).rejects.toThrow(/finance_limit_settings_source_check/);
    await expect(asA((tx) => tx.financeLimitSetting.create({ data: { ...base, valueMinor: 5n, legalSourceNote: 'Unverified – configure to the applicable law' } }))).rejects.toThrow(
      /finance_limit_settings_kind_check/,
    );
    const s = await asA((tx) => tx.financeLimitSetting.create({ data: { ...base, legalSourceNote: 'Unverified – configure to the applicable law' } }));
    expect(s.verified).toBe(false);
    await expect(asA((tx) => tx.financeLimitSetting.update({ where: { id: s.id }, data: { valueBasisPoints: 3000 } }))).rejects.toThrow(/IMMUTABLE_RECORD/);
    await expect(asA((tx) => tx.financeLimitSetting.update({ where: { id: s.id }, data: { verified: true } }))).rejects.toThrow(/finance_limit_settings_verified_check/);
    // The person who entered a setting never verifies it.
    await expect(asA((tx) => tx.financeLimitSetting.update({ where: { id: s.id }, data: { verified: true, verifiedById: ids.approver!, verifiedAt: new Date() } }))).rejects.toThrow(
      /finance_limit_settings_second_verifier_check/,
    );
    await expect(
      asA((tx) => tx.financeLimitSetting.update({ where: { id: s.id }, data: { verified: true, verifiedById: ids.officer!, verifiedAt: new Date(), effectiveTo: new Date('2027-12-31') } })),
    ).resolves.toMatchObject({ verified: true });
  });

  it('content: approver ≠ author; published text changes only with a new revision', async () => {
    await expect(asA((tx) => tx.contentItem.update({ where: { id: ids.content! }, data: { approverId: ids.author! } }))).rejects.toThrow(
      /content_items_approver_not_author_check/,
    );
    await asA((tx) => tx.contentItem.update({ where: { id: ids.content! }, data: { status: 'PUBLISHED', approverId: ids.commsApprover!, approvedAt: new Date(), publishedAt: new Date() } }));
    await expect(asA((tx) => tx.contentItem.update({ where: { id: ids.content! }, data: { body: 'Silently changed' } }))).rejects.toThrow(/IMMUTABLE_RECORD/);
    await expect(
      asA((tx) => tx.contentItem.update({ where: { id: ids.content! }, data: { body: 'Corrected text', revision: { increment: 1 }, correctionCount: { increment: 1 } } })),
    ).resolves.toMatchObject({ revision: 2 });
    await expect(asA((tx) => tx.contentItem.update({ where: { id: ids.content! }, data: { publishedAt: new Date('2030-01-01') } }))).rejects.toThrow(/IMMUTABLE_RECORD/);
  });

  it('breach register: closing needs lessons and someone other than the reporter', async () => {
    const close = (by: string, lessons: string | null) =>
      asA((tx) => tx.breachRecord.update({ where: { id: ids.breach! }, data: { status: 'CLOSED', closedById: by, closedAt: new Date(), lessonsLearned: lessons } }));
    await expect(close(ids.dpo!, 'Drill lessons')).rejects.toThrow(/breach_records_closer_check/);
    await expect(close(ids.dpo2!, null)).rejects.toThrow(/breach_records_closed_check/);
    await expect(close(ids.dpo2!, 'Rotate keys faster; contact list kept current.')).resolves.toMatchObject({ status: 'CLOSED' });
    await expect(asA((tx) => tx.breachRecord.update({ where: { id: ids.breach! }, data: { isDrill: false } }))).rejects.toThrow(/IMMUTABLE_RECORD/);
  });

  it('department scope: involvement, or own departments (incl. sub-departments)', async () => {
    const lead = authFor(tA, ids.lead!, ['tasks.view']);
    const outsider = authFor(tA, ids.outsider!, ['tasks.view']);
    const manager = authFor(tA, ids.manager!, ['tasks.view', 'org.departments.all']);
    const visible = async (auth: AuthContext) =>
      asA(async (tx) => {
        const scope = await loadCampaignScope(tx, auth, 'tasks.view');
        const rows = await tx.task.findMany({ where: taskScopeWhere(scope) ?? {}, select: { id: true } });
        return rows.map((r) => r.id).sort();
      });
    expect(await visible(lead)).toEqual([ids.taskChild!].sort());
    expect(await visible(outsider)).toEqual([ids.taskMine!]);
    expect((await visible(manager)).length).toBe(3);
    const scope = await asA((tx) => loadCampaignScope(tx, lead, 'tasks.view'));
    expect(scope.departmentIds.sort()).toEqual([ids.deptRoot!, ids.deptChild!].sort());
    expect(campaignRecordInScope(scope, { departmentId: ids.deptOther!, geographicUnitPath: null, involvedUserIds: [] })).toBe(false);
    expect(campaignRecordInScope(scope, { departmentId: ids.deptOther!, geographicUnitPath: null, involvedUserIds: [ids.lead!] })).toBe(true);
    // A geography-limited grant never reaches records without geography (except by involvement).
    const geoLead = authFor(tA, ids.lead!, ['tasks.view'], { scopeType: 'CONSTITUENCY', geographicUnitId: randomUUID() });
    expect(await visible(geoLead)).toEqual([]);
  });

  it('campaign is a valid module key (default off)', async () => {
    await asA((tx) => tx.tenantModule.create({ data: { tenantId: tA, moduleKey: 'campaign', enabled: true } }));
    await expect(asA((tx) => tx.tenantModule.create({ data: { tenantId: tA, moduleKey: 'campaigns', enabled: true } }))).rejects.toThrow(/tenant_modules_key_check/);
  });
});

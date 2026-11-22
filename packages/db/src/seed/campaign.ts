/* eslint-disable no-console -- CLI seed script output */
/**
 * Campaign and organisation seed for the `demo` tenant (synthetic Bungoma
 * campaign): the `campaign` module switched on, one demo user per new role,
 * a department tree (8 departments, 15 teams), ~60 tasks across every status
 * with dependencies, checklists, comments and timelines, 10 events with
 * agendas, logistics, attendance and after-action reports, 12 content items
 * across the workflow (one corrected), the finance ledger (accounts,
 * categories, payees, contributors, budget lines, ~80 entries across states
 * including a reversal), demo limit settings marked unverified, 3 saved
 * report templates, notification preferences and alerts, and one breach
 * register drill.
 *
 * EVERYTHING IS SYNTHETIC. Names carry "synthetic"; phone numbers use the
 * invented +254 700 1xx xxx range; identifiers are 99-prefixed and stored
 * masked. Limit settings are demo values labelled "Unverified – configure to
 * the applicable law" (docs/RESEARCH.md: the 2026 regulations are contested).
 * Times are relative to the seed run.
 *
 * Idempotent: if department EXEC exists the operational data is left
 * untouched (users, roles and the module switch are refreshed every run).
 * Runs as the schema owner (RLS bypassed; DB triggers still apply, so ledger
 * entries are inserted as REQUESTED and then approved and paid in steps).
 */
import type {
  BreachEventType,
  BreachStatus,
  CampaignEventStatus,
  CampaignEventType,
  ContentAudience,
  ContentRevisionKind,
  ContentStatus,
  ContentType,
  FinanceTransactionStatus,
  LogisticsItemType,
  LogisticsStatus,
  Prisma,
  PrismaClient,
  ScopeType,
  TaskPriority,
  TaskStatus,
} from '@prisma/client';
import {
  CampaignModuleConfigSchema,
  evaluateContribution,
  type LimitSettingInput,
  maskNationalId,
  REPORT_DATASETS,
  reportClassification,
  type ReportDefinition,
  type SystemRoleKey,
  UNVERIFIED_LIMIT_LABEL,
} from '@ngao360/shared';
import { createHash } from 'node:crypto';
import { identifierFingerprint } from '../security';
import { storeSyntheticFile, syntheticPdf } from './office';
import type { ReferenceSeedResult } from './reference-data';

export interface CampaignSeedOptions {
  tenantId: string;
  ref: ReferenceSeedResult;
  roleIds: Record<string, string>;
  passwordHash: string;
  mfaRoles: ReadonlySet<string>;
  applyDemoMfa: (tenantId: string, userId: string) => Promise<unknown>;
}

const YEAR = 2027;
const DOMAIN = 'demo.example.org';
const DAY = 86_400_000;
const pad = (n: number, w = 6) => String(n).padStart(w, '0');
const reference = (prefix: string, n: number) => `${prefix}-${YEAR}-${pad(n)}`;
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
const dateOnly = (d: Date) => new Date(`${d.toISOString().slice(0, 10)}T00:00:00Z`);

function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

/** Demo-only key for identifier fingerprints when MFA_ENCRYPTION_KEY is not set. */
const FINGERPRINT_KEY = process.env.MFA_ENCRYPTION_KEY ?? 'seed-development-only-fingerprint-key';

export async function seedCampaign(prisma: PrismaClient, o: CampaignSeedOptions): Promise<void> {
  const { tenantId, ref: refData } = o;
  const rand = rng(20270810);
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)]!;
  const now = Date.now();
  const at = (days: number, hours = 0) => new Date(now + days * DAY + hours * 3_600_000);

  /* --------------------------- Module and demo users -------------------------- */
  const config = CampaignModuleConfigSchema.parse({ referenceYear: YEAR, finance: { defaultElectionCycleId: refData.cycleId } });
  await prisma.tenantModule.upsert({
    where: { tenantId_moduleKey: { tenantId, moduleKey: 'campaign' } },
    create: { tenantId, moduleKey: 'campaign', enabled: true, config },
    update: { enabled: true },
  });

  const campaignUsers: Array<{ key: string; email: string; displayName: string; role: SystemRoleKey; scope?: { type: ScopeType; unitKey: string } }> = [
    { key: 'manager', email: `manager@${DOMAIN}`, displayName: 'Mercy Campaign Manager (synthetic)', role: 'CAMPAIGN_MANAGER' },
    { key: 'teamcoord', email: `teamcoord@${DOMAIN}`, displayName: 'Tom Team Coordinator North (synthetic)', role: 'TEAM_COORDINATOR', scope: { type: 'CONSTITUENCY', unitKey: 'c1' } },
    { key: 'opsofficer', email: `opsofficer@${DOMAIN}`, displayName: 'Opal Operations Officer (synthetic)', role: 'OPERATIONS_OFFICER' },
    { key: 'payer', email: `payments@${DOMAIN}`, displayName: 'Pendo Payments Officer (synthetic)', role: 'FINANCE_OFFICER' },
    { key: 'approver', email: `approver@${DOMAIN}`, displayName: 'Abel Finance Approver (synthetic)', role: 'FINANCE_APPROVER' },
    { key: 'editor', email: `editor@${DOMAIN}`, displayName: 'Edwin Communications Editor (synthetic)', role: 'COMMUNICATIONS_EDITOR' },
    { key: 'commsApprover', email: `comms.approver@${DOMAIN}`, displayName: 'Agatha Communications Approver (synthetic)', role: 'COMMUNICATIONS_APPROVER' },
    { key: 'dpo', email: `dpo@${DOMAIN}`, displayName: 'Diana Data Protection Officer (synthetic)', role: 'DATA_PROTECTION_OFFICER' },
    { key: 'leadComms', email: `lead.comms@${DOMAIN}`, displayName: 'Lydia Department Lead Communications (synthetic)', role: 'DEPARTMENT_LEAD' },
  ];
  const users: Record<string, string> = {};
  for (const u of campaignUsers) {
    const user = await prisma.user.upsert({
      where: { tenantId_email: { tenantId, email: u.email } },
      create: { tenantId, email: u.email, displayName: u.displayName, passwordHash: o.passwordHash, status: 'ACTIVE', passwordChangedAt: new Date() },
      update: { displayName: u.displayName, passwordHash: o.passwordHash, status: 'ACTIVE', failedLoginCount: 0, lockedUntil: null },
    });
    users[u.key] = user.id;
    await prisma.roleAssignment.deleteMany({ where: { userId: user.id } });
    await prisma.roleAssignment.create({
      data: {
        tenantId,
        userId: user.id,
        roleId: o.roleIds[u.role]!,
        scopeType: u.scope?.type ?? 'ORGANISATION',
        geographicUnitId: u.scope ? refData.units.get(u.scope.unitKey)! : null,
        reason: 'Seed (synthetic demo)',
      },
    });
    if (o.mfaRoles.has(u.role)) await o.applyDemoMfa(tenantId, user.id);
  }
  const existing: Record<string, string> = {
    owner: 'owner',
    director: 'director',
    ops: 'ops',
    lead: 'lead',
    coordinator: 'coordinator',
    finance: 'finance',
    legal: 'legal',
    comms: 'comms',
    field: 'field',
    planner: 'planner',
    clerk: 'clerk',
    verifier: 'verifier',
  };
  for (const [k, local] of Object.entries(existing)) {
    users[k] = (await prisma.user.findUniqueOrThrow({ where: { tenantId_email: { tenantId, email: `${local}@${DOMAIN}` } } })).id;
  }
  console.log(`  campaign: module on, ${campaignUsers.length} campaign demo users`);

  if (await prisma.department.findUnique({ where: { tenantId_code: { tenantId, code: 'EXEC' } } })) {
    console.log('  campaign: operational data already present (unchanged)');
    await syncCampaignReferenceSequences(prisma, tenantId);
    return;
  }

  const unit = (key: string) => refData.units.get(key)!;
  const people = Object.values(users);

  /* ------------------------------- Departments -------------------------------- */
  const deptSpecs: Array<{ code: string; name: string; parent?: string; lead: string; budget: string; description: string; visibility?: 'ORGANISATION' | 'DEPARTMENT' | 'RESTRICTED' }> = [
    { code: 'EXEC', name: 'Executive Office', lead: 'manager', budget: 'B-100', description: 'Campaign leadership and cross-department coordination.' },
    { code: 'FIELD', name: 'Field Operations', parent: 'EXEC', lead: 'lead', budget: 'B-200', description: 'Ward coordination, area reports and field logistics.' },
    { code: 'FIELD-NORTH', name: 'North Region Operations', parent: 'FIELD', lead: 'teamcoord', budget: 'B-210', description: 'Field work in the synthetic North constituency.' },
    { code: 'COMMS', name: 'Communications and Media', parent: 'EXEC', lead: 'leadComms', budget: 'B-300', description: 'Press releases, notices, bulletins and the website.' },
    { code: 'FIN', name: 'Finance and Administration', parent: 'EXEC', lead: 'approver', budget: 'B-400', description: 'Ledger, budgets, contributions and suppliers.', visibility: 'RESTRICTED' },
    { code: 'EVENTS', name: 'Events and Logistics', parent: 'EXEC', lead: 'opsofficer', budget: 'B-500', description: 'Event planning, venues, vehicles and equipment.' },
    { code: 'VOL', name: 'Volunteer Mobilisation', parent: 'EXEC', lead: 'coordinator', budget: 'B-600', description: 'Volunteer onboarding, rosters and training.' },
    { code: 'LEGAL', name: 'Legal and Compliance', parent: 'EXEC', lead: 'legal', budget: 'B-700', description: 'Compliance review, finance limits and data protection liaison.', visibility: 'DEPARTMENT' },
  ];
  const depts: Record<string, { id: string; path: string }> = {};
  for (const d of deptSpecs) {
    const parent = d.parent ? depts[d.parent]! : null;
    const id = (await prisma.$queryRaw<Array<{ id: string }>>`SELECT gen_random_uuid()::text AS id`)[0]!.id;
    const path = `${parent?.path ?? '/'}${id}/`;
    await prisma.department.create({
      data: {
        id,
        tenantId,
        code: d.code,
        name: d.name,
        description: d.description,
        leadUserId: users[d.lead]!,
        parentId: parent?.id ?? null,
        path,
        depth: path.split('/').filter(Boolean).length - 1,
        budgetCode: d.budget,
        activeFrom: new Date('2026-09-01'),
        activeTo: new Date('2027-09-30'),
        visibility: d.visibility ?? 'ORGANISATION',
        createdById: users.manager!,
      },
    });
    depts[d.code] = { id, path };
  }

  /* ---------------------------------- Teams ----------------------------------- */
  const teamSpecs: Array<{ name: string; dept: string; coord: string; unitKey?: string; channel: 'IN_APP' | 'EMAIL' | 'PHONE' | 'MESSAGING_GROUP' | 'OTHER'; status?: 'ACTIVE' | 'PAUSED' | 'ARCHIVED' }> = [
    { name: 'North Ward Coordination', dept: 'FIELD-NORTH', coord: 'teamcoord', unitKey: 'c1', channel: 'MESSAGING_GROUP' },
    { name: 'North Volunteers Desk', dept: 'FIELD-NORTH', coord: 'teamcoord', unitKey: 'c1', channel: 'IN_APP' },
    { name: 'South Ward Coordination', dept: 'FIELD', coord: 'field', unitKey: 'c2', channel: 'MESSAGING_GROUP' },
    { name: 'East Ward Coordination', dept: 'FIELD', coord: 'field', unitKey: 'c3', channel: 'PHONE' },
    { name: 'West Ward Coordination', dept: 'FIELD', coord: 'planner', unitKey: 'c4', channel: 'MESSAGING_GROUP' },
    { name: 'Central Ward Coordination', dept: 'FIELD', coord: 'planner', unitKey: 'c5', channel: 'IN_APP', status: 'PAUSED' },
    { name: 'Press Desk', dept: 'COMMS', coord: 'comms', channel: 'EMAIL' },
    { name: 'Digital and Website', dept: 'COMMS', coord: 'editor', channel: 'IN_APP' },
    { name: 'Accounts Payable', dept: 'FIN', coord: 'finance', channel: 'EMAIL' },
    { name: 'Contributions Desk', dept: 'FIN', coord: 'payer', channel: 'EMAIL' },
    { name: 'Logistics Crew', dept: 'EVENTS', coord: 'opsofficer', channel: 'PHONE' },
    { name: 'Venues and Permits', dept: 'EVENTS', coord: 'opsofficer', unitKey: 'c6', channel: 'IN_APP' },
    { name: 'Volunteer Onboarding', dept: 'VOL', coord: 'coordinator', channel: 'MESSAGING_GROUP' },
    { name: 'Training Team', dept: 'VOL', coord: 'coordinator', unitKey: 'c7', channel: 'IN_APP' },
    { name: 'Compliance Review', dept: 'LEGAL', coord: 'legal', channel: 'EMAIL', status: 'ARCHIVED' },
  ];
  const teams: Array<{ id: string; dept: string; unitKey?: string; coord: string }> = [];
  for (const t of teamSpecs) {
    const team = await prisma.team.create({
      data: {
        tenantId,
        departmentId: depts[t.dept]!.id,
        name: t.name,
        coordinatorUserId: users[t.coord]!,
        geographicUnitId: t.unitKey ? unit(t.unitKey) : null,
        contactChannel: t.channel,
        contactDetail: t.channel === 'MESSAGING_GROUP' ? `${t.name} (internal group, synthetic)` : null,
        status: t.status ?? 'ACTIVE',
        createdById: users.manager!,
      },
    });
    teams.push({ id: team.id, dept: t.dept, unitKey: t.unitKey, coord: t.coord });
    const memberKeys = new Set<string>([t.coord]);
    while (memberKeys.size < 4) memberKeys.add(pick(Object.keys(users)));
    for (const k of memberKeys) {
      await prisma.teamMember.create({
        data: { tenantId, teamId: team.id, userId: users[k]!, role: k === t.coord ? 'COORDINATOR' : rand() < 0.3 ? 'VOLUNTEER' : 'MEMBER', addedById: users.manager!, joinedAt: at(-60) },
      });
    }
  }
  // One member who left (history kept).
  const leaver = await prisma.teamMember.create({ data: { tenantId, teamId: teams[0]!.id, userId: users.clerk!, role: 'VOLUNTEER', addedById: users.manager!, joinedAt: at(-50) } }).catch(() => null);
  if (leaver) await prisma.teamMember.update({ where: { id: leaver.id }, data: { leftAt: at(-10), removedById: users.teamcoord! } });
  console.log(`  campaign: ${deptSpecs.length} departments, ${teamSpecs.length} teams`);

  /* ---------------------------------- Events ---------------------------------- */
  const eventSpecs: Array<{ title: string; type: CampaignEventType; status: CampaignEventStatus; day: number; unitKey: string; dept: string; organiser: string; venue: string; budget: number; aar?: 'APPROVED' | 'SUBMITTED' | 'DRAFT' | 'RETURNED' }> = [
    { title: 'North constituency town hall', type: 'TOWN_HALL', status: 'COMPLETED', day: -28, unitKey: 'c1', dept: 'FIELD-NORTH', organiser: 'teamcoord', venue: 'Synthetic North Community Hall', budget: 180_000_00, aar: 'APPROVED' },
    { title: 'Volunteer induction day', type: 'TRAINING', status: 'COMPLETED', day: -21, unitKey: 'c7', dept: 'VOL', organiser: 'coordinator', venue: 'Synthetic Lowlands Youth Centre', budget: 60_000_00, aar: 'APPROVED' },
    { title: 'Press briefing on the manifesto', type: 'PRESS_BRIEFING', status: 'COMPLETED', day: -14, unitKey: 'c5', dept: 'COMMS', organiser: 'leadComms', venue: 'Synthetic Central Hotel, Conference Room 2', budget: 45_000_00, aar: 'SUBMITTED' },
    { title: 'South ward community clean-up', type: 'COMMUNITY_SERVICE', status: 'COMPLETED', day: -7, unitKey: 'c2', dept: 'FIELD', organiser: 'field', venue: 'Synthetic South Market Grounds', budget: 35_000_00, aar: 'DRAFT' },
    { title: 'Weekly coordination meeting', type: 'MEETING', status: 'IN_PROGRESS', day: 0, unitKey: 'c5', dept: 'EXEC', organiser: 'manager', venue: 'Campaign office boardroom (synthetic)', budget: 5_000_00 },
    { title: 'East constituency public rally', type: 'PUBLIC_RALLY', status: 'CONFIRMED', day: 6, unitKey: 'c3', dept: 'EVENTS', organiser: 'opsofficer', venue: 'Synthetic East Stadium', budget: 950_000_00 },
    { title: 'Supporters fundraising dinner', type: 'FUNDRAISER', status: 'PLANNED', day: 12, unitKey: 'c5', dept: 'FIN', organiser: 'approver', venue: 'Synthetic Central Hotel, Ballroom', budget: 400_000_00 },
    { title: 'West ward agents briefing', type: 'TRAINING', status: 'PLANNED', day: 18, unitKey: 'c4', dept: 'FIELD', organiser: 'planner', venue: 'Synthetic West Primary School Hall', budget: 70_000_00 },
    { title: 'Riverside town hall', type: 'TOWN_HALL', status: 'POSTPONED', day: 25, unitKey: 'c8', dept: 'FIELD', organiser: 'field', venue: 'Synthetic Riverside Social Hall', budget: 150_000_00 },
    { title: 'Lakeside youth forum', type: 'TOWN_HALL', status: 'DRAFT', day: 40, unitKey: 'c9', dept: 'VOL', organiser: 'coordinator', venue: 'Synthetic Lakeside Polytechnic', budget: 90_000_00 },
  ];
  const events: Array<{ id: string; reference: string; dept: string; spec: (typeof eventSpecs)[number] }> = [];
  const firstNames = ['Achieng', 'Barasa', 'Chebet', 'Daudi', 'Ekesa', 'Fwamba', 'Gathoni', 'Halima', 'Imani', 'Juma', 'Kerubo', 'Lusweti', 'Makhanu', 'Nafula', 'Okumu', 'Pamela', 'Rehema', 'Simiyu', 'Tabitha', 'Wekesa'];
  for (const [i, e] of eventSpecs.entries()) {
    const ev = await prisma.campaignEvent.create({
      data: {
        tenantId,
        reference: reference('EVT', i + 1),
        title: `${e.title} (synthetic)`,
        type: e.type,
        purpose: `Synthetic demo event: ${e.title.toLowerCase()}.`,
        startsAt: at(e.day, 10),
        endsAt: at(e.day, 14),
        venueName: e.venue,
        venueAddress: 'Synthetic address, Bungoma County',
        latitude: 0.56 + i * 0.01,
        longitude: 34.56 + i * 0.01,
        geographicUnitId: unit(e.unitKey),
        organiserId: users[e.organiser]!,
        departmentId: depts[e.dept]!.id,
        budgetMinor: BigInt(e.budget),
        visibility: e.type === 'PUBLIC_RALLY' || e.type === 'TOWN_HALL' ? 'PUBLIC' : e.type === 'MEETING' ? 'INTERNAL' : 'INVITED_TEAMS',
        status: e.status,
        cancellationReason: e.status === 'POSTPONED' ? 'Venue unavailable on the planned date (synthetic).' : null,
        createdById: users[e.organiser]!,
      },
    });
    events.push({ id: ev.id, reference: ev.reference, dept: e.dept, spec: e });
    for (const t of teams.filter((t) => t.dept === e.dept).slice(0, 2)) {
      await prisma.eventInvitedTeam.create({ data: { tenantId, eventId: ev.id, teamId: t.id } });
    }
    const agenda = ['Arrival and registration', 'Welcome remarks', 'Main session', 'Questions from participants', 'Close and logistics debrief'];
    for (const [p, title] of agenda.entries()) {
      await prisma.eventAgendaItem.create({
        data: { tenantId, eventId: ev.id, position: p + 1, startsAt: at(e.day, 10 + p * 0.75), durationMinutes: 45, title, ownerId: p === 2 ? users[e.organiser]! : null },
      });
    }
    const logistics: Array<[LogisticsItemType, string, number, string | null]> = [
      ['VEHICLE', 'Transport van (synthetic registration KXX 000X)', 1, 'Synthetic Fleet Hire'],
      ['EQUIPMENT', 'Public address system', 1, 'Synthetic Sound Ltd'],
      ['EQUIPMENT', 'Plastic chairs', 200, 'Synthetic Tents and Chairs'],
      ['MATERIALS', 'Printed programmes', 300, null],
    ];
    for (const [li, [itemType, description, quantity, supplier]] of logistics.entries()) {
      if (e.type === 'MEETING' && li > 0) break;
      const status: LogisticsStatus =
        e.status === 'COMPLETED' ? (li === 1 && i === 0 ? 'DAMAGED' : 'RETURNED') : e.status === 'IN_PROGRESS' ? 'COLLECTED' : e.status === 'CONFIRMED' ? 'CONFIRMED' : e.status === 'POSTPONED' ? 'CANCELLED' : 'REQUESTED';
      await prisma.eventLogisticsItem.create({
        data: {
          tenantId,
          eventId: ev.id,
          itemType,
          description,
          assetReference: itemType === 'VEHICLE' ? 'KXX 000X (synthetic)' : itemType === 'EQUIPMENT' ? `ASSET-${pad(i * 10 + li, 4)}` : null,
          supplierName: supplier,
          quantity,
          custodianId: users[pick(['opsofficer', 'planner', 'field', 'teamcoord'])]!,
          collectionAt: at(e.day - 1, 8),
          returnDueAt: at(e.day + 1, 17),
          returnedAt: ['RETURNED', 'DAMAGED'].includes(status) ? at(e.day + 1, 15) : null,
          status,
          damageNotes: status === 'DAMAGED' ? 'One speaker cone torn during packing; supplier notified (synthetic).' : null,
          createdById: users.opsofficer!,
        },
      });
    }
    if (['COMPLETED', 'IN_PROGRESS'].includes(e.status)) {
      const n = e.status === 'IN_PROGRESS' ? 8 : 18 + Math.floor(rand() * 12);
      const breakdown: Record<string, number> = {};
      for (let a = 0; a < n; a++) {
        const role = a === 0 ? 'ORGANISER' : a < 4 ? 'STAFF' : a < 8 ? 'VOLUNTEER' : pick(['PARTICIPANT', 'PARTICIPANT', 'GUEST', 'MEDIA'] as const);
        breakdown[role] = (breakdown[role] ?? 0) + 1;
        const withContact = role === 'PARTICIPANT' && a % 5 === 0;
        const att = await prisma.eventAttendance.create({
          data: {
            tenantId,
            eventId: ev.id,
            participantName: a === 0 ? 'Organiser (synthetic)' : `${firstNames[(a + i) % firstNames.length]} Synthetic ${pad(a, 2)}`,
            participantUserId: a === 0 ? users[e.organiser]! : null,
            teamId: a < 8 ? (teams.find((t) => t.dept === e.dept)?.id ?? null) : null,
            role,
            checkInMethod: a < 4 ? 'MANUAL' : pick(['SIGN_IN_SHEET', 'QR_CODE', 'SELF_CHECK_IN'] as const),
            checkedInAt: at(e.day, 9.5 + a * 0.02),
            recordedById: users[e.organiser]!,
            hasContact: withContact,
          },
        });
        if (withContact) {
          await prisma.eventAttendanceContact.create({
            data: {
              tenantId,
              attendanceId: att.id,
              phone: `+254700${pad(100000 + i * 100 + a, 6)}`,
              email: null,
              consentNoticeVersion: 'campaign-events-2026-11-v1',
              purpose: 'Follow-up about this event only (synthetic consent).',
              consentedAt: at(e.day, 10),
            },
          });
        }
      }
      if (e.aar) {
        const author = users[e.organiser]!;
        const reviewer = e.organiser === 'manager' ? users.ops! : users.manager!;
        const evidenceFile = await storeSyntheticFile(prisma, tenantId, author, syntheticPdf(`After-action evidence ${ev.reference} (synthetic)`), 'application/pdf', `after-action-${ev.reference}.pdf`, 'EVENT_DOCUMENT');
        await prisma.eventDocument.create({ data: { tenantId, eventId: ev.id, fileId: evidenceFile, kind: 'AFTER_ACTION_EVIDENCE', note: 'Sign-in sheet summary (synthetic)', addedById: author } });
        await prisma.eventAfterActionReport.create({
          data: {
            tenantId,
            eventId: ev.id,
            status: e.aar,
            whatOccurred: `The ${e.title.toLowerCase()} ran as planned with minor delays at registration (synthetic).`,
            attendanceTotal: n,
            attendanceBreakdown: breakdown,
            actualSpendMinor: BigInt(Math.round(e.budget * 0.93)),
            issues: i === 0 ? 'Public address speaker damaged during packing.' : 'Registration queue longer than expected.',
            lessons: 'Open registration 30 minutes earlier; assign a second check-in desk.',
            authorId: author,
            reviewerId: e.aar === 'APPROVED' || e.aar === 'RETURNED' ? reviewer : null,
            reviewedAt: e.aar === 'APPROVED' || e.aar === 'RETURNED' ? at(e.day + 3) : null,
            reviewNote: e.aar === 'APPROVED' ? 'Approved. Thank you.' : null,
          },
        });
      }
    }
  }
  console.log(`  campaign: ${events.length} events with agendas, logistics, attendance and after-action reports`);

  /* ---------------------------------- Tasks ----------------------------------- */
  const statusPlan: Array<[TaskStatus, number]> = [
    ['DRAFT', 6],
    ['READY', 10],
    ['IN_PROGRESS', 16],
    ['BLOCKED', 5],
    ['SUBMITTED_FOR_REVIEW', 7],
    ['COMPLETED', 12],
    ['CANCELLED', 4],
  ];
  const taskTitles = [
    'Confirm venue booking',
    'Print event programmes',
    'Recruit ward volunteers',
    'Draft weekly field summary',
    'Collect area activity reports',
    'Arrange transport for coordinators',
    'Update team roster',
    'Prepare training materials',
    'Review supplier quotations',
    'Reconcile petty cash',
    'Draft press statement',
    'Update website events page',
    'Schedule volunteer induction',
    'Check permits with county office',
    'Compile attendance totals',
    'Book public address system',
  ];
  const deptCodes = Object.keys(depts);
  const tasks: Array<{ id: string; status: TaskStatus }> = [];
  let tn = 0;
  for (const [status, count] of statusPlan) {
    for (let c = 0; c < count; c++) {
      tn++;
      const deptCode = deptCodes[tn % deptCodes.length]!;
      const team = teams.find((t) => t.dept === deptCode);
      const ownerKey = team?.coord ?? pick(['manager', 'opsofficer', 'lead', 'coordinator']);
      const owner = users[ownerKey]!;
      const reviewerCandidates = ['manager', 'lead', 'ops', 'opsofficer'].filter((k) => users[k] !== owner);
      const reviewer = status === 'SUBMITTED_FOR_REVIEW' || (status === 'COMPLETED' && c % 2 === 0) || rand() < 0.3 ? users[pick(reviewerCandidates)]! : null;
      const dueDays = status === 'COMPLETED' ? -20 + c : status === 'CANCELLED' ? -5 : (tn % 7 === 0 ? -3 : 2 + (tn % 20));
      const event = tn % 6 === 0 ? events[tn % events.length]! : null;
      const priority: TaskPriority = (['LOW', 'NORMAL', 'NORMAL', 'HIGH', 'URGENT'] as const)[tn % 5]!;
      const task = await prisma.task.create({
        data: {
          tenantId,
          reference: reference('TSK', tn),
          title: `${taskTitles[tn % taskTitles.length]} (synthetic ${pad(tn, 2)})`,
          description: 'Synthetic demo task for the campaign workspace.',
          acceptanceCriteria: 'Done when the result is recorded and the owner has attached evidence.',
          ownerId: owner,
          reviewerId: reviewer,
          createdById: users.manager!,
          priority,
          status: 'DRAFT',
          startAt: at(dueDays - 7),
          dueAt: at(dueDays, 17),
          departmentId: depts[deptCode]!.id,
          teamId: team?.id ?? null,
          geographicUnitId: team?.unitKey ? unit(team.unitKey) : null,
          sourceType: event ? 'EVENT' : tn % 11 === 0 ? 'DASHBOARD' : null,
          sourceId: event?.id ?? null,
          sourceLabel: event?.reference ?? null,
        },
      });
      await prisma.taskEvent.create({ data: { tenantId, taskId: task.id, type: 'CREATED', toStatus: 'DRAFT', actorId: users.manager!, createdAt: at(dueDays - 8) } });
      if (rand() < 0.4) {
        const collab = people.filter((p) => p !== owner && p !== reviewer).slice(tn % 5, (tn % 5) + 2);
        for (const u of collab) await prisma.taskCollaborator.create({ data: { tenantId, taskId: task.id, userId: u, addedById: users.manager! } });
      }
      const items = ['Agree scope', 'Do the work', 'Attach evidence'];
      for (const [p, label] of items.entries()) {
        const done = status === 'COMPLETED' || (status === 'SUBMITTED_FOR_REVIEW' ? true : status === 'IN_PROGRESS' && p === 0);
        await prisma.taskChecklistItem.create({ data: { tenantId, taskId: task.id, label, position: p + 1, isDone: done, doneById: done ? owner : null, doneAt: done ? at(dueDays - 2) : null, createdById: users.manager! } });
      }
      // Walk the workflow so the timeline is realistic.
      const path: TaskStatus[] =
        status === 'DRAFT' ? [] : status === 'READY' ? ['READY'] : status === 'IN_PROGRESS' ? ['READY', 'IN_PROGRESS'] : status === 'BLOCKED' ? ['READY', 'IN_PROGRESS', 'BLOCKED']
        : status === 'SUBMITTED_FOR_REVIEW' ? ['READY', 'IN_PROGRESS', 'SUBMITTED_FOR_REVIEW'] : status === 'COMPLETED' ? (reviewer ? ['READY', 'IN_PROGRESS', 'SUBMITTED_FOR_REVIEW', 'COMPLETED'] : ['READY', 'IN_PROGRESS', 'COMPLETED']) : ['CANCELLED'];
      let from: TaskStatus = 'DRAFT';
      for (const [s, to] of path.entries()) {
        const approvedByReviewer = to === 'COMPLETED' && from === 'SUBMITTED_FOR_REVIEW';
        await prisma.taskEvent.create({
          data: {
            tenantId,
            taskId: task.id,
            type: approvedByReviewer ? 'REVIEW_APPROVED' : 'STATUS_CHANGED',
            fromStatus: from,
            toStatus: to,
            actorId: approvedByReviewer ? reviewer! : to === 'CANCELLED' ? users.manager! : owner,
            note: to === 'BLOCKED' ? 'Waiting for supplier confirmation (synthetic).' : to === 'CANCELLED' ? 'No longer needed after the schedule changed (synthetic).' : null,
            createdAt: at(dueDays - 6 + s),
          },
        });
        from = to;
      }
      if (status === 'COMPLETED') {
        const evidence = await storeSyntheticFile(prisma, tenantId, owner, syntheticPdf(`Completion evidence ${task.reference} (synthetic)`), 'application/pdf', `evidence-${task.reference}.pdf`, 'TASK_ATTACHMENT');
        await prisma.taskAttachment.create({ data: { tenantId, taskId: task.id, fileId: evidence, kind: 'COMPLETION_EVIDENCE', note: 'Signed summary (synthetic)', addedById: owner } });
      }
      if (rand() < 0.5) {
        await prisma.taskComment.create({ data: { tenantId, taskId: task.id, authorId: owner, body: 'Update: on track; next step agreed with the team (synthetic).', createdAt: at(dueDays - 3) } });
      }
      await prisma.task.update({
        where: { id: task.id },
        data: { status, completedAt: status === 'COMPLETED' ? at(dueDays) : null, cancelledAt: status === 'CANCELLED' ? at(dueDays) : null, version: path.length + 1 },
      });
      tasks.push({ id: task.id, status });
    }
  }
  // Dependencies: chains inside each status group, no cycles (later tasks depend on earlier ones).
  let deps = 0;
  for (let i = 1; i < tasks.length; i++) {
    if (i % 3 !== 0) continue;
    const dep = tasks[i - 1 - (i % 2)]!;
    if (dep.id === tasks[i]!.id) continue;
    await prisma.taskDependency.create({ data: { tenantId, taskId: tasks[i]!.id, dependsOnTaskId: dep.id, createdById: users.manager! } });
    deps++;
  }
  console.log(`  campaign: ${tasks.length} tasks across every status, ${deps} dependencies`);

  /* --------------------------------- Content ---------------------------------- */
  const contentSpecs: Array<{ type: ContentType; title: string; audience: ContentAudience; status: ContentStatus; author: string; dept: string; event?: number }> = [
    { type: 'PRESS_RELEASE', title: 'Campaign launches ward listening tour', audience: 'MEDIA', status: 'PUBLISHED', author: 'comms', dept: 'COMMS' },
    { type: 'NOTICE', title: 'Office hours during the holiday season', audience: 'PUBLIC_NOTICE', status: 'PUBLISHED', author: 'editor', dept: 'COMMS' },
    { type: 'BULLETIN', title: 'Weekly staff bulletin no. 12', audience: 'INTERNAL_ALL', status: 'ARCHIVED', author: 'comms', dept: 'EXEC' },
    { type: 'EVENT_INFO', title: 'East constituency rally: venue and timings', audience: 'PUBLIC_WEBSITE', status: 'APPROVED', author: 'comms', dept: 'EVENTS', event: 5 },
    { type: 'WEBSITE_UPDATE', title: 'Manifesto summary page refresh', audience: 'PUBLIC_WEBSITE', status: 'AWAITING_APPROVAL', author: 'editor', dept: 'COMMS' },
    { type: 'PRESS_RELEASE', title: 'Statement on volunteer training programme', audience: 'MEDIA', status: 'EDITORIAL_REVIEW', author: 'comms', dept: 'VOL' },
    { type: 'BULLETIN', title: 'Field operations bulletin: North region', audience: 'INTERNAL_DEPARTMENT', status: 'DRAFT', author: 'leadComms', dept: 'FIELD-NORTH' },
    { type: 'NOTICE', title: 'Call for volunteer drivers (internal)', audience: 'INTERNAL_ALL', status: 'DRAFT', author: 'comms', dept: 'VOL' },
    { type: 'EVENT_INFO', title: 'Fundraising dinner: invitation details for partners', audience: 'PARTNERS', status: 'EDITORIAL_REVIEW', author: 'editor', dept: 'FIN', event: 6 },
    { type: 'WEBSITE_UPDATE', title: 'Events calendar for the coming month', audience: 'PUBLIC_WEBSITE', status: 'PUBLISHED', author: 'editor', dept: 'COMMS' },
    { type: 'PRESS_RELEASE', title: 'Correction-ready statement on town hall turnout', audience: 'MEDIA', status: 'WITHDRAWN', author: 'comms', dept: 'COMMS' },
    { type: 'BULLETIN', title: 'Finance reminders for event organisers', audience: 'INTERNAL_ALL', status: 'AWAITING_APPROVAL', author: 'comms', dept: 'FIN' },
  ];
  for (const [i, c] of contentSpecs.entries()) {
    const author = users[c.author]!;
    const body = `Synthetic demo text for "${c.title}". This item is part of the demo workspace and names no real people or events.`;
    const progressed = (s: ContentStatus) => CONTENT_ORDER.indexOf(c.status) >= CONTENT_ORDER.indexOf(s) || ['ARCHIVED', 'WITHDRAWN'].includes(c.status);
    const editor = progressed('AWAITING_APPROVAL') ? users.editor === author ? users.comms! : users.editor! : null;
    const approver = progressed('APPROVED') ? users.commsApprover! : null;
    const publishedAt = progressed('PUBLISHED') ? at(-20 + i) : null;
    const item = await prisma.contentItem.create({
      data: {
        tenantId,
        reference: reference('CNT', i + 1),
        type: c.type,
        title: `${c.title} (synthetic)`,
        summary: null,
        body,
        audience: c.audience,
        departmentId: depts[c.dept]!.id,
        eventId: c.event !== undefined ? events[c.event]!.id : null,
        authorId: author,
        editorId: editor,
        approverId: approver,
        approvedAt: approver ? at(-22 + i) : null,
        publishedAt,
        publishedById: publishedAt ? users.editor! : null,
        archivedAt: c.status === 'ARCHIVED' ? at(-2) : null,
        withdrawnAt: c.status === 'WITHDRAWN' ? at(-3) : null,
        status: c.status,
      },
    });
    const rev = (kind: ContentRevisionKind, fromStatus: ContentStatus | null, toStatus: ContentStatus | null, actorId: string, revision = 1, text = body, note: string | null = null, day = -25 + i) =>
      prisma.contentRevision.create({ data: { tenantId, contentId: item.id, kind, revision, title: item.title, body: text, bodySha256: sha256(text), fromStatus, toStatus, actorId, note, createdAt: at(day) } });
    await rev('CREATED', null, 'DRAFT', author);
    if (progressed('EDITORIAL_REVIEW')) await rev('SUBMITTED_FOR_REVIEW', 'DRAFT', 'EDITORIAL_REVIEW', author);
    if (progressed('AWAITING_APPROVAL')) await rev('EDITORIAL_APPROVED', 'EDITORIAL_REVIEW', 'AWAITING_APPROVAL', editor!);
    if (progressed('APPROVED')) await rev('APPROVED', 'AWAITING_APPROVAL', 'APPROVED', approver!);
    if (progressed('PUBLISHED')) await rev('PUBLISHED', 'APPROVED', 'PUBLISHED', users.editor!);
    if (c.status === 'ARCHIVED') await rev('ARCHIVED', 'PUBLISHED', 'ARCHIVED', users.editor!);
    if (c.status === 'WITHDRAWN') await rev('WITHDRAWN', 'PUBLISHED', 'WITHDRAWN', users.commsApprover!, 1, body, 'Withdrawn: figures could not be confirmed (synthetic).');
    if (i === 0) {
      // A published item corrected through a recorded revision; the earlier text stays in the history.
      const corrected = `${body} Correction: the tour starts in the North constituency, not the South.`;
      await prisma.contentItem.update({ where: { id: item.id }, data: { body: corrected, revision: 2, correctionCount: 1, version: 2 } });
      await rev('CORRECTED', 'PUBLISHED', 'PUBLISHED', users.commsApprover!, 2, corrected, 'Corrected the starting constituency (synthetic).', -5);
    }
  }
  console.log(`  campaign: ${contentSpecs.length} content items across the workflow (one corrected)`);

  /* --------------------------------- Finance ---------------------------------- */
  const accounts = {
    bank: await prisma.financeAccount.create({ data: { tenantId, name: 'Campaign account (synthetic bank)', type: 'BANK', institution: 'Synthetic Bank of Kenya', accountNumberMasked: '•••• 0101', isDedicatedCampaignAccount: true, createdById: users.approver! } }),
    mpesa: await prisma.financeAccount.create({ data: { tenantId, name: 'Mobile money till (synthetic)', type: 'MOBILE_MONEY', institution: 'Synthetic mobile money', accountNumberMasked: '•••• 0202', createdById: users.approver! } }),
    cash: await prisma.financeAccount.create({ data: { tenantId, name: 'Petty cash (synthetic)', type: 'CASH', createdById: users.approver! } }),
  };
  const catSpecs: Array<[string, string, 'INCOME' | 'EXPENSE' | 'TRANSFER']> = [
    ['INC.INDIVIDUAL', 'Contributions from individuals', 'INCOME'],
    ['INC.ORGANISATION', 'Contributions from organisations', 'INCOME'],
    ['INC.PARTY', 'Party support', 'INCOME'],
    ['EXP.VENUES', 'Venues and permits', 'EXPENSE'],
    ['EXP.TRANSPORT', 'Transport and fuel', 'EXPENSE'],
    ['EXP.PRINTING', 'Printing and materials', 'EXPENSE'],
    ['EXP.MEDIA', 'Media and advertising', 'EXPENSE'],
    ['EXP.STAFF', 'Staff and volunteer allowances', 'EXPENSE'],
    ['EXP.EQUIPMENT', 'Equipment hire', 'EXPENSE'],
    ['TRF.INTERNAL', 'Transfers between accounts', 'TRANSFER'],
  ];
  const cats: Record<string, string> = {};
  for (const [code, name, kind] of catSpecs) cats[code] = (await prisma.financeCategory.create({ data: { tenantId, code, name, kind } })).id;

  const payeeSpecs: Array<[string, 'SUPPLIER' | 'INDIVIDUAL' | 'ORGANISATION' | 'STAFF']> = [
    ['Synthetic Sound Ltd', 'SUPPLIER'],
    ['Synthetic Fleet Hire', 'SUPPLIER'],
    ['Synthetic Tents and Chairs', 'SUPPLIER'],
    ['Synthetic Printers Co.', 'SUPPLIER'],
    ['Synthetic Central Hotel', 'SUPPLIER'],
    ['Synthetic FM Radio', 'SUPPLIER'],
    ['Synthetic Fuel Station', 'SUPPLIER'],
    ['Volunteer allowance pool (synthetic)', 'STAFF'],
    ['County permits office (synthetic)', 'ORGANISATION'],
    ['Synthetic Caterers', 'SUPPLIER'],
  ];
  const payees: string[] = [];
  for (const [i, [name, kind]] of payeeSpecs.entries()) {
    const pin = `P99${pad(1000 + i, 7)}X`;
    payees.push(
      (
        await prisma.financePayee.create({
          data: { tenantId, name, kind, taxPinMasked: `P99•••••${pin.slice(-3)}`, taxPinHash: identifierFingerprint(tenantId, pin, FINGERPRINT_KEY), createdById: users.finance! },
        })
      ).id,
    );
  }

  const sourceSpecs: Array<[string, 'INDIVIDUAL' | 'ORGANISATION' | 'POLITICAL_PARTY' | 'OWN_FUNDS', boolean]> = [
    ['Synthetic Harvest Traders Ltd', 'ORGANISATION', true],
    ['Amina Synthetic Wanjala', 'INDIVIDUAL', true],
    ['Brian Synthetic Makokha', 'INDIVIDUAL', true],
    ['Cynthia Synthetic Nekesa', 'INDIVIDUAL', false],
    ['David Synthetic Khaemba', 'INDIVIDUAL', true],
    ['Esther Synthetic Masinde', 'INDIVIDUAL', true],
    ['Party Alpha (synthetic)', 'POLITICAL_PARTY', true],
    ['Candidate own funds (synthetic)', 'OWN_FUNDS', true],
    ['Synthetic Farmers Cooperative', 'ORGANISATION', true],
    ['George Synthetic Sifuna', 'INDIVIDUAL', false],
    ['Hellen Synthetic Wamalwa', 'INDIVIDUAL', true],
    ['Isaac Synthetic Simiyu', 'INDIVIDUAL', true],
  ];
  const sources: Array<{ id: string; declared: boolean }> = [];
  for (const [i, [name, kind, declared]] of sourceSpecs.entries()) {
    const ident = `99${pad(400000 + i * 37, 6)}`;
    sources.push({
      id: (
        await prisma.contributionSource.create({
          data: {
            tenantId,
            displayName: name,
            kind,
            identifierMasked: kind === 'OWN_FUNDS' ? null : kind === 'INDIVIDUAL' ? `ID ${maskNationalId(ident)}` : `Reg. ${maskNationalId(ident)}`,
            identifierHash: kind === 'OWN_FUNDS' ? null : identifierFingerprint(tenantId, ident, FINGERPRINT_KEY),
            declared,
            declaredAt: declared ? at(-80) : null,
            createdById: users.finance!,
          },
        })
      ).id,
      declared,
    });
  }

  // Demo limit settings: configurable, UNVERIFIED, with a legal source note (never hardcoded in code).
  const legalNote =
    `${UNVERIFIED_LIMIT_LABEL}. Demo value only: the Election Campaign Financing Regulations 2026 (gazetted 7 Aug 2026) ` +
    'are under court challenge and parliamentary dispute. Confirm the instrument in force and its figures with counsel before relying on this setting.';
  const capSetting = await prisma.financeLimitSetting.create({
    data: {
      tenantId,
      kind: 'SINGLE_SOURCE_CAP_PCT',
      label: 'Single-source contribution cap (demo, unverified)',
      valueBasisPoints: 2000,
      capBasis: 'TOTAL_CONTRIBUTIONS',
      electionCycleId: refData.cycleId,
      periodLabel: '2027 general election campaign period (synthetic)',
      officeType: 'GOVERNOR',
      effectiveFrom: new Date('2026-08-07'),
      legalSourceNote: legalNote,
      verified: false,
      enforcement: 'BLOCK',
      createdById: users.approver!,
    },
  });
  await prisma.financeLimitSetting.create({
    data: {
      tenantId,
      kind: 'SPENDING_LIMIT',
      label: 'Governor campaign spending limit (demo, unverified)',
      valueMinor: 18_100_000_000n,
      currency: 'KES',
      electionCycleId: refData.cycleId,
      periodLabel: '2027 general election campaign period (synthetic)',
      officeType: 'GOVERNOR',
      effectiveFrom: new Date('2026-08-07'),
      legalSourceNote: legalNote,
      verified: false,
      enforcement: 'WARN',
      createdById: users.approver!,
    },
  });
  await prisma.financeLimitSetting.create({
    data: {
      tenantId,
      kind: 'REPORTING_DEADLINE',
      label: 'Expenditure report due (demo, unverified)',
      deadlineDate: dateOnly(at(10)),
      electionCycleId: refData.cycleId,
      periodLabel: '2027 general election campaign period (synthetic)',
      effectiveFrom: new Date('2026-08-07'),
      legalSourceNote: legalNote,
      verified: false,
      enforcement: 'WARN',
      createdById: users.approver!,
    },
  });
  const settingInputs: LimitSettingInput[] = [
    {
      id: capSetting.id,
      kind: 'SINGLE_SOURCE_CAP_PCT',
      valueBasisPoints: 2000,
      capBasis: 'TOTAL_CONTRIBUTIONS',
      valueMinor: null,
      deadlineDate: null,
      electionCycleId: refData.cycleId,
      effectiveFrom: '2026-08-07',
      effectiveTo: null,
      legalSourceNote: legalNote,
      verified: false,
      enforcement: 'BLOCK',
    },
  ];

  // Budget lines per department and for the big events.
  const budgetLines: Record<string, string> = {};
  const budgetSpecs: Array<[string, string, string | null, number | null, string, number]> = [
    ['BL-FIELD-01', 'Field operations running costs', 'FIELD', null, 'EXP.TRANSPORT', 2_400_000_00],
    ['BL-NORTH-01', 'North region activities', 'FIELD-NORTH', null, 'EXP.VENUES', 600_000_00],
    ['BL-COMMS-01', 'Media and printing', 'COMMS', null, 'EXP.MEDIA', 1_800_000_00],
    ['BL-EVENTS-01', 'Events equipment hire', 'EVENTS', null, 'EXP.EQUIPMENT', 1_200_000_00],
    ['BL-VOL-01', 'Volunteer allowances', 'VOL', null, 'EXP.STAFF', 900_000_00],
    ['BL-EVT-RALLY', 'East rally', 'EVENTS', 5, 'EXP.VENUES', 950_000_00],
    ['BL-EVT-DINNER', 'Fundraising dinner', 'FIN', 6, 'EXP.VENUES', 400_000_00],
    ['BL-EVT-TOWNHALL', 'North town hall', 'FIELD-NORTH', 0, 'EXP.VENUES', 180_000_00],
  ];
  for (const [code, name, dept, ev, cat, amount] of budgetSpecs) {
    budgetLines[code] = (
      await prisma.financeBudgetLine.create({
        data: {
          tenantId,
          code,
          name: `${name} (synthetic)`,
          departmentId: dept ? depts[dept]!.id : null,
          eventId: ev !== null ? events[ev]!.id : null,
          categoryId: cats[cat]!,
          electionCycleId: refData.cycleId,
          amountMinor: BigInt(amount),
          periodStart: new Date('2026-09-01'),
          periodEnd: new Date('2027-08-31'),
          status: code === 'BL-EVT-DINNER' ? 'DRAFT' : 'APPROVED',
          approvedById: code === 'BL-EVT-DINNER' ? null : users.approver!,
          approvedAt: code === 'BL-EVT-DINNER' ? null : at(-75),
          createdById: users.finance!,
        },
      })
    ).id;
  }

  let fin = 0;
  let postedContributions = 0n;
  const sourceTotals = new Map<string, bigint>();
  const createEntry = async (e: {
    type: 'CONTRIBUTION' | 'EXPENSE' | 'TRANSFER' | 'REFUND' | 'REVERSAL';
    status: FinanceTransactionStatus;
    amountMinor: number;
    day: number;
    account: string;
    counterAccount?: string;
    category: string;
    budgetLine?: string;
    payee?: string;
    source?: { id: string; declared: boolean };
    description: string;
    dept?: string;
    event?: string;
    reverses?: string;
    flags?: string[];
  }) => {
    fin++;
    const requester = e.type === 'CONTRIBUTION' ? users.payer! : users.finance!;
    const payer = requester === users.finance ? users.payer! : users.finance!;
    const withRef = e.status !== 'DRAFT' || fin % 2 === 0;
    const row = await prisma.financeTransaction.create({
      data: {
        tenantId,
        reference: reference('FIN', fin),
        type: e.type,
        status: e.status === 'DRAFT' ? 'DRAFT' : 'REQUESTED',
        accountId: e.account,
        counterAccountId: e.counterAccount ?? null,
        categoryId: e.category,
        budgetLineId: e.budgetLine ?? null,
        amountMinor: BigInt(e.amountMinor),
        transactionDate: dateOnly(at(e.day)),
        payeeId: e.payee ?? null,
        contributionSourceId: e.source?.id ?? null,
        externalReference: withRef ? `${e.type === 'CONTRIBUTION' ? 'RCPT' : e.type === 'TRANSFER' ? 'TRF' : 'INV'}-SYN-${pad(fin, 5)}` : null,
        description: e.description,
        departmentId: e.dept ? depts[e.dept]!.id : null,
        eventId: e.event ?? null,
        electionCycleId: refData.cycleId,
        requestedById: requester,
        requestedAt: e.status === 'DRAFT' ? null : at(e.day, 1),
        reversesId: e.reverses ?? null,
        complianceFlags: e.flags ?? [],
        complianceEvaluatedAt: e.flags ? at(e.day, 1) : null,
      },
    });
    await prisma.financeTransactionEvent.create({ data: { tenantId, transactionId: row.id, type: 'CREATED', toStatus: 'DRAFT', actorId: requester, createdAt: at(e.day) } });
    if (e.status !== 'DRAFT' && (e.status !== 'REQUESTED' || fin % 3 !== 0)) {
      const doc = await storeSyntheticFile(prisma, tenantId, requester, syntheticPdf(`Supporting document ${row.reference} (synthetic)`), 'application/pdf', `${row.reference}.pdf`, 'FINANCE_DOCUMENT');
      // Ledger approval needs a supporting document with a CLEAN scan (DB trigger). These synthetic PDFs
      // are generated here, so the seed records them as clean, naming the seed as the scanning engine.
      await prisma.storedFile.updateMany({
        where: { id: doc, malwareScanStatus: { notIn: ['CLEAN', 'INFECTED'] } },
        data: { malwareScanStatus: 'CLEAN', scanEngine: 'synthetic-seed', scannedAt: at(e.day, 1) },
      });
      await prisma.financeTransactionDocument.create({
        data: { tenantId, transactionId: row.id, fileId: doc, kind: e.type === 'CONTRIBUTION' ? 'RECEIPT' : e.type === 'TRANSFER' ? 'BANK_SLIP' : 'INVOICE', addedById: requester },
      });
      await prisma.financeTransactionEvent.create({ data: { tenantId, transactionId: row.id, type: 'DOCUMENT_ADDED', actorId: requester, createdAt: at(e.day, 1) } });
    }
    if (e.status !== 'DRAFT') {
      await prisma.financeTransactionEvent.create({ data: { tenantId, transactionId: row.id, type: 'REQUESTED', fromStatus: 'DRAFT', toStatus: 'REQUESTED', actorId: requester, createdAt: at(e.day, 1) } });
    }
    if (['APPROVED', 'PAID', 'REVERSED'].includes(e.status)) {
      await prisma.financeTransaction.update({ where: { id: row.id }, data: { status: 'APPROVED', approvedById: users.approver!, approvedAt: at(e.day, 3), version: 2 } });
      await prisma.financeTransactionEvent.create({ data: { tenantId, transactionId: row.id, type: 'APPROVED', fromStatus: 'REQUESTED', toStatus: 'APPROVED', actorId: users.approver!, createdAt: at(e.day, 3) } });
    }
    if (['PAID', 'REVERSED'].includes(e.status)) {
      await prisma.financeTransaction.update({ where: { id: row.id }, data: { status: 'PAID', paidById: payer, paidAt: at(e.day, 6), paymentReference: `PAY-SYN-${pad(fin, 5)}`, version: 3 } });
      await prisma.financeTransactionEvent.create({ data: { tenantId, transactionId: row.id, type: 'PAID', fromStatus: 'APPROVED', toStatus: 'PAID', actorId: payer, createdAt: at(e.day, 6) } });
    }
    if (e.status === 'REJECTED') {
      await prisma.financeTransaction.update({ where: { id: row.id }, data: { status: 'REJECTED', rejectedById: users.approver!, rejectedAt: at(e.day, 4), rejectionReason: 'Quotation exceeds the approved budget line (synthetic).', version: 2 } });
      await prisma.financeTransactionEvent.create({ data: { tenantId, transactionId: row.id, type: 'REJECTED', fromStatus: 'REQUESTED', toStatus: 'REJECTED', actorId: users.approver!, note: 'Over budget (synthetic)', createdAt: at(e.day, 4) } });
    }
    if (e.status === 'CANCELLED') {
      await prisma.financeTransaction.update({ where: { id: row.id }, data: { status: 'CANCELLED', cancelledAt: at(e.day, 2), cancellationReason: 'Duplicate request (synthetic).', version: 2 } });
      await prisma.financeTransactionEvent.create({ data: { tenantId, transactionId: row.id, type: 'CANCELLED', fromStatus: 'REQUESTED', toStatus: 'CANCELLED', actorId: requester, createdAt: at(e.day, 2) } });
    }
    return row;
  };

  // Contributions (posted in date order so the cap evaluation uses the running totals).
  const contributionPlan: Array<[number, number, FinanceTransactionStatus]> = [];
  for (let i = 0; i < 24; i++) contributionPlan.push([1 + (i % 11), 50_000_00 + Math.floor(rand() * 250_000) * 100, i < 18 ? 'PAID' : i < 21 ? 'APPROVED' : 'REQUESTED']);
  // Routine contributions are evaluated against the period's planned total (a running total would flag
  // every early contribution as 100 % of the period so far).
  const plannedTotal = contributionPlan.filter(([, , s]) => s !== 'REQUESTED').reduce((a, [, amt]) => a + amt, 0);
  for (const [k, [srcIdx, amount, status]] of contributionPlan.entries()) {
    const src = sources[srcIdx]!;
    const day = -85 + k * 3;
    const flags = evaluateContribution({
      amountMinor: amount,
      sourceTotalMinor: Number(sourceTotals.get(src.id) ?? 0n),
      periodContributionsMinor: plannedTotal - amount,
      spendingLimitMinor: null,
      sourceDeclared: src.declared,
      settings: settingInputs,
      date: dateOnly(at(day)).toISOString().slice(0, 10),
      electionCycleId: refData.cycleId,
      nearBasisPoints: config.finance.nearLimitWarningBasisPoints,
    }).map((f) => f.flag);
    await createEntry({
      type: 'CONTRIBUTION',
      status,
      amountMinor: amount,
      day,
      account: k % 3 === 0 ? accounts.mpesa.id : accounts.bank.id,
      category: srcIdx === 6 ? cats['INC.PARTY']! : [0, 8].includes(srcIdx) ? cats['INC.ORGANISATION']! : cats['INC.INDIVIDUAL']!,
      source: src,
      description: `Contribution received (synthetic ${pad(k + 1, 2)})`,
      flags,
    });
    if (['PAID', 'APPROVED'].includes(status)) {
      postedContributions += BigInt(amount);
      sourceTotals.set(src.id, (sourceTotals.get(src.id) ?? 0n) + BigInt(amount));
    }
  }
  // The large organisational contribution that exceeds the demo cap (unverified → a warning, not a block).
  {
    const src = sources[0]!;
    const amount = 1_500_000_00;
    const findings = evaluateContribution({
      amountMinor: amount,
      sourceTotalMinor: Number(sourceTotals.get(src.id) ?? 0n),
      periodContributionsMinor: Number(postedContributions),
      spendingLimitMinor: null,
      sourceDeclared: src.declared,
      settings: settingInputs,
      date: dateOnly(at(-2)).toISOString().slice(0, 10),
      electionCycleId: refData.cycleId,
      nearBasisPoints: config.finance.nearLimitWarningBasisPoints,
    });
    if (!findings.some((f) => f.flag === 'SINGLE_SOURCE_CAP_EXCEEDED')) throw new Error('Seed invariant: the demo contribution must exceed the demo single-source cap');
    const row = await createEntry({
      type: 'CONTRIBUTION',
      status: 'APPROVED',
      amountMinor: amount,
      day: -2,
      account: accounts.bank.id,
      category: cats['INC.ORGANISATION']!,
      source: src,
      description: 'Large organisational contribution above the demo single-source cap (synthetic; warning because the setting is unverified)',
      flags: findings.map((f) => f.flag),
    });
    await prisma.financeTransactionEvent.create({
      data: { tenantId, transactionId: row.id, type: 'COMPLIANCE_EVALUATED', actorId: users.approver!, note: findings.map((f) => f.message).join(' | '), data: { findings: findings.map((f) => ({ flag: f.flag, level: f.level, settingId: f.settingId })) } as Prisma.InputJsonValue, createdAt: at(-2, 2) },
    });
  }

  // Expenses across departments, events and statuses.
  const expenseCats = ['EXP.VENUES', 'EXP.TRANSPORT', 'EXP.PRINTING', 'EXP.MEDIA', 'EXP.STAFF', 'EXP.EQUIPMENT'];
  const lineFor: Record<string, string> = { 'EXP.VENUES': 'BL-NORTH-01', 'EXP.TRANSPORT': 'BL-FIELD-01', 'EXP.PRINTING': 'BL-COMMS-01', 'EXP.MEDIA': 'BL-COMMS-01', 'EXP.STAFF': 'BL-VOL-01', 'EXP.EQUIPMENT': 'BL-EVENTS-01' };
  const deptFor: Record<string, string> = { 'BL-NORTH-01': 'FIELD-NORTH', 'BL-FIELD-01': 'FIELD', 'BL-COMMS-01': 'COMMS', 'BL-VOL-01': 'VOL', 'BL-EVENTS-01': 'EVENTS' };
  const expenseStatuses: FinanceTransactionStatus[] = [
    ...Array<FinanceTransactionStatus>(27).fill('PAID'),
    ...Array<FinanceTransactionStatus>(6).fill('APPROVED'),
    ...Array<FinanceTransactionStatus>(6).fill('REQUESTED'),
    ...Array<FinanceTransactionStatus>(4).fill('DRAFT'),
    ...Array<FinanceTransactionStatus>(2).fill('REJECTED'),
    ...Array<FinanceTransactionStatus>(1).fill('CANCELLED'),
  ];
  let toReverse: string | null = null;
  for (const [k, status] of expenseStatuses.entries()) {
    const cat = expenseCats[k % expenseCats.length]!;
    const line = lineFor[cat]!;
    const ev = k % 9 === 0 ? events[k % 4]! : null;
    const row = await createEntry({
      type: 'EXPENSE',
      status,
      amountMinor: 8_000_00 + Math.floor(rand() * 120_000) * 100,
      day: -80 + k * 2,
      account: k % 5 === 0 ? accounts.cash.id : k % 4 === 0 ? accounts.mpesa.id : accounts.bank.id,
      category: cats[cat]!,
      budgetLine: budgetLines[line],
      payee: payees[k % payees.length]!,
      description: `${catSpecs.find((c) => c[0] === cat)![1]}: synthetic expense ${pad(k + 1, 2)}`,
      dept: deptFor[line],
      event: ev?.id,
    });
    if (k === 3) toReverse = row.id;
  }
  // Transfers and refunds.
  for (let k = 0; k < 5; k++) {
    await createEntry({
      type: 'TRANSFER',
      status: k < 4 ? 'PAID' : 'REQUESTED',
      amountMinor: 100_000_00 + k * 25_000_00,
      day: -70 + k * 12,
      account: accounts.bank.id,
      counterAccount: k % 2 === 0 ? accounts.mpesa.id : accounts.cash.id,
      category: cats['TRF.INTERNAL']!,
      description: `Float top-up ${k + 1} (synthetic)`,
    });
  }
  for (let k = 0; k < 3; k++) {
    await createEntry({
      type: 'REFUND',
      status: k < 2 ? 'PAID' : 'REQUESTED',
      amountMinor: 5_000_00 + k * 1_500_00,
      day: -40 + k * 10,
      account: accounts.mpesa.id,
      category: cats['EXP.VENUES']!,
      payee: payees[4]!,
      description: `Refund of an overpaid deposit ${k + 1} (synthetic)`,
    });
  }
  // A reversal: the duplicate payment is corrected by a reversing entry (approved), and the original becomes REVERSED.
  if (toReverse) {
    const original = await prisma.financeTransaction.findUniqueOrThrow({ where: { id: toReverse } });
    const rev = await createEntry({
      type: 'REVERSAL',
      status: 'APPROVED',
      amountMinor: Number(original.amountMinor),
      day: -10,
      account: original.accountId,
      category: original.categoryId,
      budgetLine: original.budgetLineId ?? undefined,
      description: `Reversal of ${original.reference}: duplicate supplier payment (synthetic)`,
      reverses: original.id,
    });
    await prisma.financeTransaction.update({ where: { id: original.id }, data: { status: 'REVERSED', reversedAt: at(-10, 4), version: { increment: 1 } } });
    await prisma.financeTransactionEvent.create({
      data: { tenantId, transactionId: original.id, type: 'REVERSED', fromStatus: 'PAID', toStatus: 'REVERSED', actorId: users.approver!, note: `Reversed by ${rev.reference} (synthetic)`, createdAt: at(-10, 4) },
    });
  }
  console.log(`  campaign: finance ledger with ${fin} entries (incl. one reversal and one contribution above the demo cap), 3 unverified demo limit settings`);

  /* ----------------------------- Report templates ----------------------------- */
  const templates: Array<{ name: string; owner: string; scope: 'PRIVATE' | 'ROLES' | 'ORGANISATION'; roles: string[]; def: ReportDefinition; standard?: string }> = [
    {
      name: 'Overdue work by department',
      owner: 'manager',
      scope: 'ORGANISATION',
      roles: [],
      standard: 'overdue-work',
      def: { datasetKey: 'campaign.tasks', fields: ['departmentName', 'status', 'reference', 'title', 'ownerName', 'dueAt'], filters: [{ field: 'isOverdue', op: 'eq', value: true }], groupBy: ['departmentName'] },
    },
    {
      name: 'Contribution register (finance team)',
      owner: 'approver',
      scope: 'ROLES',
      roles: ['FINANCE_OFFICER', 'FINANCE_APPROVER'],
      standard: 'contribution-register',
      def: { datasetKey: 'finance.contributions', fields: ['reference', 'transactionDate', 'contributorName', 'contributorKind', 'declared', 'amountMinor', 'complianceFlags'], filters: [], groupBy: [] },
    },
    {
      name: 'North events this quarter',
      owner: 'teamcoord',
      scope: 'PRIVATE',
      roles: [],
      def: { datasetKey: 'campaign.events', fields: ['reference', 'title', 'status', 'startsAt', 'venueName', 'attendanceCount'], filters: [{ field: 'geographyName', op: 'contains', value: 'North' }], groupBy: [] },
    },
  ];
  for (const t of templates) {
    const ds = REPORT_DATASETS.find((d) => d.key === t.def.datasetKey)!;
    await prisma.reportTemplate.create({
      data: {
        tenantId,
        name: t.name,
        description: 'Synthetic demo template.',
        datasetKey: t.def.datasetKey,
        definition: t.def as unknown as Prisma.InputJsonValue,
        ownerId: users[t.owner]!,
        permissionScope: t.scope,
        sharedRoleKeys: t.roles,
        classification: reportClassification(ds, t.def.fields),
        standardReportKey: t.standard ?? null,
      },
    });
  }

  /* ------------------------ Notifications and preferences --------------------- */
  const prefRows: Array<[string, 'IN_APP' | 'EMAIL' | 'SMS' | 'PUSH', string, boolean]> = [
    ['manager', 'EMAIL', '*', true],
    ['manager', 'EMAIL', 'task.due_soon', false],
    ['approver', 'EMAIL', 'finance.approval_requested', true],
    ['approver', 'SMS', 'finance.approval_requested', false],
    ['finance', 'IN_APP', 'finance.rejected', true],
    ['commsApprover', 'EMAIL', 'content.approval_requested', true],
    ['teamcoord', 'PUSH', 'task.assigned', true],
    ['dpo', 'EMAIL', 'security.breach_recorded', true],
  ];
  for (const [u, channel, type, enabled] of prefRows) {
    await prisma.notificationPreference.create({ data: { tenantId, userId: users[u]!, channel, type, enabled } });
  }
  const notes: Array<{ user: string; module: string; type: string; title: string; body: string; link: string; severity?: 'INFO' | 'WARNING' | 'CRITICAL'; ack?: boolean; read?: boolean }> = [
    { user: 'approver', module: 'finance', type: 'finance.approval_requested', title: 'Ledger entries await your approval', body: 'Several expense requests are waiting (synthetic).', link: '/finance?view=awaiting_my_approval' },
    { user: 'approver', module: 'finance', type: 'finance.limit_warning', title: 'Contribution above the demo single-source cap', body: `${UNVERIFIED_LIMIT_LABEL}: a contribution exceeds the configured cap (synthetic).`, link: '/finance?flagged=true', severity: 'WARNING' },
    { user: 'commsApprover', module: 'comms', type: 'content.approval_requested', title: 'Content awaits approval', body: 'Two items are awaiting approval (synthetic).', link: '/comms?view=awaiting_me' },
    { user: 'teamcoord', module: 'tasks', type: 'task.assigned', title: 'New task assigned to you', body: 'A North region task was assigned (synthetic).', link: '/tasks?view=mine', read: true },
    { user: 'manager', module: 'events', type: 'event.after_action_review', title: 'After-action report submitted', body: 'The press briefing report is ready for review (synthetic).', link: `/events/${events[2]!.id}` },
    { user: 'dpo', module: 'notifications', type: 'security.critical_alert', title: 'Critical alert drill: acknowledge', body: 'Synthetic drill alert. Acknowledge to record the escalation path.', link: '/security/breaches', severity: 'CRITICAL', ack: true },
  ];
  for (const n of notes) {
    const row = await prisma.notification.create({
      data: {
        tenantId,
        userId: users[n.user]!,
        channel: 'IN_APP',
        module: n.module,
        type: n.type,
        title: n.title,
        body: n.body,
        link: n.link,
        severity: n.severity ?? 'INFO',
        requiresAck: n.ack ?? false,
        readAt: n.read ? at(-1) : null,
      },
    });
    if (['approver', 'commsApprover', 'dpo'].includes(n.user)) {
      await prisma.notificationDelivery.create({
        data: { tenantId, notificationId: row.id, channel: 'EMAIL', provider: 'log-email', status: 'SKIPPED', error: 'No provider configured (log provider)' },
      });
    }
  }

  /* ------------------------------ Breach register ----------------------------- */
  const breach = await prisma.breachRecord.create({
    data: {
      tenantId,
      reference: reference('BRE', 1),
      title: 'Drill: lost field laptop with cached exports (synthetic)',
      description: 'Tabletop drill. A coordinator reports a laptop left in a vehicle; it may hold a cached volunteer roster export.',
      isDrill: true,
      status: 'REMEDIATED',
      severity: 'MEDIUM',
      detectedAt: at(-6, 9),
      dataCategories: ['STAFF_CONTACT'],
      estimatedSubjects: 40,
      systemsAffected: 'One laptop (synthetic); no server systems.',
      containmentSummary: 'Sessions revoked and the account password reset within 30 minutes.',
      riskAssessment: 'Disk encrypted; export contained names and work phone numbers of 40 synthetic staff. Low likelihood of harm.',
      notificationDecision: 'Drill decision: notification to the regulator not required for this scenario; controller informed. Real incidents follow counsel’s advice on the applicable duty.',
      controllerNotifiedAt: at(-6, 12),
      remediationSummary: 'Remote wipe requested; export retention shortened in the drill plan.',
      lessonsLearned: null,
      ownerId: users.dpo!,
      reportedById: users.dpo!,
    },
  });
  const steps: Array<[BreachEventType, BreachStatus | null, BreachStatus | null, string, number]> = [
    ['DETECTED', null, 'DETECTED', 'Coordinator reported the missing laptop by phone (drill).', 0],
    ['CONTAINED', 'DETECTED', 'CONTAINED', 'All sessions of the account revoked; password reset.', 0.5],
    ['EVIDENCE_PRESERVED', 'CONTAINED', 'EVIDENCE_PRESERVED', 'Audit events for the account exported and kept with the record.', 1],
    ['ASSESSED', 'EVIDENCE_PRESERVED', 'ASSESSED', 'Scope: one cached roster export, 40 synthetic staff contacts; disk encrypted.', 2],
    ['CONTROLLER_NOTIFIED', null, null, 'Controller informed (drill).', 3],
    ['NOTIFICATION_NOT_REQUIRED', null, null, 'Drill decision recorded: regulator notification not required for this scenario.', 3.5],
    ['REMEDIATED', 'ASSESSED', 'REMEDIATED', 'Remote wipe requested; export retention shortened.', 24],
  ];
  for (const [type, fromStatus, toStatus, note, hours] of steps) {
    await prisma.breachEvent.create({
      data: { tenantId, breachId: breach.id, type, fromStatus, toStatus, note, occurredAt: at(-6, 9 + hours), actorId: users.dpo! },
    });
  }
  console.log('  campaign: 3 report templates, notification preferences and alerts, 1 breach register drill');

  await syncCampaignReferenceSequences(prisma, tenantId);
}

const CONTENT_ORDER: readonly ContentStatus[] = ['DRAFT', 'EDITORIAL_REVIEW', 'AWAITING_APPROVAL', 'APPROVED', 'PUBLISHED'];

/**
 * The seed writes TSK / EVT / CNT / FIN / BRE references directly, so move the
 * tenant's reference counters past them (never backwards).
 */
async function syncCampaignReferenceSequences(prisma: PrismaClient, tenantId: string): Promise<void> {
  const tables = { TSK: 'tasks', EVT: 'campaign_events', CNT: 'content_items', FIN: 'finance_transactions', BRE: 'breach_records' } as const;
  for (const [prefix, table] of Object.entries(tables)) {
    const name = `${prefix}-${YEAR}`;
    const rows = await prisma.$queryRawUnsafe<Array<{ max: number | null }>>(
      `SELECT max(substring(reference from '([0-9]+)$')::int) AS max FROM ${table} WHERE tenant_id = $1::uuid AND reference LIKE $2`,
      tenantId,
      `${name}-%`,
    );
    const next = (rows[0]?.max ?? 0) + 1;
    await prisma.$executeRaw`
      INSERT INTO reference_sequences (tenant_id, name, next_value) VALUES (${tenantId}::uuid, ${name}, ${next})
      ON CONFLICT (tenant_id, name) DO UPDATE SET next_value = GREATEST(reference_sequences.next_value, EXCLUDED.next_value)`;
  }
}

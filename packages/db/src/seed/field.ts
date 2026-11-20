/* eslint-disable no-console -- CLI seed script output */
/**
 * Field and election operations seed for the `demo` tenant (which has NGAO
 * TALLY): the `field` module switched on, one demo user per field role, ~120
 * agents with masked and sensitive data, deployments with gaps (uncovered
 * stations), readiness checklists in mixed states, two field report
 * templates, ~30 field reports, ~25 incidents across severities and statuses,
 * and War Room station statuses derived from them.
 *
 * EVERYTHING IS SYNTHETIC. Names carry "Synthetic"; phone numbers use the
 * +254 700 0xx xxx pattern and ID numbers start with 99 (invented); stations
 * are the synthetic Bungoma registry. Times are relative to the seed run (a
 * rehearsal day), not to the real election date.
 *
 * Idempotent: if agent AGT-2027-000001 exists the operational data is left
 * untouched (users, roles and the module switch are refreshed every run).
 * Runs as the schema owner (RLS bypassed).
 */
import type {
  DeploymentRole,
  DeploymentShift,
  DeploymentStatus,
  IncidentCategory,
  IncidentSeverity,
  IncidentStatus,
  OperationalStatus,
  PrismaClient,
  ReadinessItemStatus,
  ScopeType,
} from '@prisma/client';
import {
  deriveReadinessStatus,
  deriveStationStatus,
  FieldModuleConfigSchema,
  type FieldReportTemplateSchema,
  type FieldReportTemplateSchemaInput,
  FieldReportTemplateSchemaSchema,
  maskNationalId,
  maskPhone,
  READINESS_CATEGORIES,
  type SystemRoleKey,
} from '@ngao360/shared';
import { createHash } from 'node:crypto';
import type { ReferenceSeedResult } from './reference-data';

export interface FieldSeedOptions {
  tenantId: string;
  ref: ReferenceSeedResult;
  roleIds: Record<string, string>;
  passwordHash: string;
  mfaRoles: ReadonlySet<string>;
  applyDemoMfa: (tenantId: string, userId: string) => Promise<unknown>;
}

const YEAR = 2027;
const DOMAIN = 'demo.example.org';
const AGENT_COUNT = 120;
/** Stations s1…s110 are in the planned deployment area; s111…s153 are uncovered on purpose. */
const PLANNED_STATIONS = 110;

/** Deterministic pseudo-random numbers (same data on every fresh seed). */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

const GIVEN = ['Amina', 'Brian', 'Cynthia', 'David', 'Esther', 'Faith', 'George', 'Hellen', 'Isaac', 'Joyce', 'Kevin', 'Lilian', 'Moses', 'Naomi', 'Oscar', 'Purity', 'Quincy', 'Rose', 'Samuel', 'Teresa', 'Umar', 'Violet', 'Walter', 'Yvonne'];
const FAMILY = ['Barasa', 'Chesoli', 'Makokha', 'Nekesa', 'Wanjala', 'Khaemba', 'Masinde', 'Nafula', 'Sifuna', 'Wamalwa', 'Mukhwana', 'Simiyu'];
const pad = (n: number, w = 6) => String(n).padStart(w, '0');
const ref = (prefix: string, n: number) => `${prefix}-${YEAR}-${pad(n)}`;
/** Stable UUID-shaped idempotency keys for seeded offline items. */
const seededUuid = (label: string) => {
  const h = createHash('sha256').update(label).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
};

const OPENING_TEMPLATE: FieldReportTemplateSchema = FieldReportTemplateSchemaSchema.parse({
  allowEvidence: true,
  sections: [
    {
      key: 'opening',
      title: 'Opening of the polling station',
      questions: [
        { key: 'opened_on_time', label: 'Did the station open at the published time?', type: 'YES_NO', required: true },
        { key: 'opening_time', label: 'Time the first voter was served', type: 'TIME', required: true },
        { key: 'agent_admitted', label: 'Were you admitted to the station on presenting your accreditation?', type: 'YES_NO', required: true },
        {
          key: 'materials_present',
          label: 'Materials seen at opening',
          type: 'MULTI_CHOICE',
          options: [
            { value: 'ballot_papers', label: 'Ballot papers' },
            { value: 'ballot_boxes_sealed', label: 'Ballot boxes shown empty and sealed' },
            { value: 'register', label: 'Printed register' },
            { value: 'kits_device', label: 'Voter identification device' },
            { value: 'forms', label: 'Result forms' },
          ],
        },
        { key: 'queue_estimate', label: 'Approximate number of people queuing at opening', type: 'NUMBER', min: 0, max: 5000 },
        { key: 'observations', label: 'Other factual observations', type: 'LONG_TEXT', maxLength: 1000 },
      ],
    },
  ],
} satisfies FieldReportTemplateSchemaInput);

const CLOSING_TEMPLATE: FieldReportTemplateSchema = FieldReportTemplateSchemaSchema.parse({
  allowEvidence: true,
  sections: [
    {
      key: 'closing',
      title: 'Close of polls',
      questions: [
        { key: 'closing_time', label: 'Time the station closed to new voters', type: 'TIME', required: true },
        { key: 'queue_at_close', label: 'Were people still queuing at closing time allowed to vote?', type: 'SINGLE_CHOICE', required: true, options: [{ value: 'yes', label: 'Yes' }, { value: 'no', label: 'No' }, { value: 'no_queue', label: 'No queue at close' }] },
      ],
    },
    {
      key: 'counting',
      title: 'Counting observation',
      questions: [
        { key: 'count_observed', label: 'Did you observe the whole count?', type: 'YES_NO', required: true },
        { key: 'form_displayed', label: 'Was the station result form displayed publicly after the count?', type: 'YES_NO', required: true },
        { key: 'copy_received', label: 'Did you receive a copy of the station result form?', type: 'YES_NO', required: true },
        { key: 'count_concerns', label: 'Factual description of any counting concern (no names)', type: 'LONG_TEXT', maxLength: 1500 },
      ],
    },
  ],
} satisfies FieldReportTemplateSchemaInput);

interface StationRow {
  key: string;
  code: string;
  geographicUnitId: string;
  countyId: string;
  constituencyId: string;
  wardId: string;
  pollingCentreId: string | null;
}

export async function seedField(prisma: PrismaClient, o: FieldSeedOptions): Promise<void> {
  const { tenantId, ref: refData } = o;
  const cycleId = refData.cycleId;

  /* --------------------------- Module and demo users -------------------------- */
  const config = FieldModuleConfigSchema.parse({ electionCycleId: cycleId, checkInLocationEnabled: true });
  await prisma.tenantModule.upsert({
    where: { tenantId_moduleKey: { tenantId, moduleKey: 'field' } },
    create: { tenantId, moduleKey: 'field', enabled: true, config },
    update: { enabled: true },
  });

  const fieldUsers: Array<{ key: string; email: string; displayName: string; role: SystemRoleKey; scope?: { type: ScopeType; unitKey: string } }> = [
    { key: 'fieldCoord', email: `field@${DOMAIN}`, displayName: 'Faith Field Coordinator (synthetic)', role: 'FIELD_COORDINATOR' },
    { key: 'fieldCoordNorth', email: `field.north@${DOMAIN}`, displayName: 'Felix Field Coordinator North (synthetic)', role: 'FIELD_COORDINATOR', scope: { type: 'CONSTITUENCY', unitKey: 'c1' } },
    { key: 'planner', email: `planner@${DOMAIN}`, displayName: 'Paul Deployment Planner (synthetic)', role: 'DEPLOYMENT_PLANNER' },
    { key: 'desk', email: `incidents@${DOMAIN}`, displayName: 'Ida Incident Desk (synthetic)', role: 'INCIDENT_DESK_OFFICER' },
    { key: 'commander', email: `commander@${DOMAIN}`, displayName: 'Carol War Room Commander (synthetic)', role: 'WAR_ROOM_COMMANDER' },
    { key: 'observer', email: `observer@${DOMAIN}`, displayName: 'Omar War Room Observer (synthetic)', role: 'WAR_ROOM_OBSERVER' },
  ];
  const users: Record<string, string> = {};
  for (const u of fieldUsers) {
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
        electionCycleId: u.scope ? cycleId : null,
        reason: 'Seed (synthetic demo)',
      },
    });
    if (o.mfaRoles.has(u.role)) await o.applyDemoMfa(tenantId, user.id);
  }
  for (const k of ['agent1', 'agent2', 'coordinator', 'legal']) {
    const email = k === 'coordinator' ? `coordinator@${DOMAIN}` : `${k}@${DOMAIN}`;
    users[k] = (await prisma.user.findUniqueOrThrow({ where: { tenantId_email: { tenantId, email } } })).id;
  }
  console.log(`  field: module on, ${fieldUsers.length} field demo users`);

  if (await prisma.agent.findUnique({ where: { tenantId_reference: { tenantId, reference: ref('AGT', 1) } } })) {
    console.log('  field: operational data already present (unchanged)');
    return;
  }

  /* --------------------------------- Stations --------------------------------- */
  const keyById = new Map([...refData.stations.entries()].map(([k, id]) => [id, k] as const));
  const stationRows = await prisma.pollingStation.findMany({
    where: { tenantId, registryVersionId: refData.registryVersionId },
    select: { id: true, code: true, geographicUnitId: true, countyId: true, constituencyId: true, wardId: true, pollingCentreId: true },
  });
  const stations: StationRow[] = stationRows
    .map((s) => ({ ...s, key: keyById.get(s.id) ?? '' }))
    .filter((s) => s.key)
    .sort((a, b) => Number(a.key.slice(1)) - Number(b.key.slice(1)));
  const station = (n: number) => stations[n - 1]!;
  const loc = (s: StationRow) => ({
    electionCycleId: cycleId,
    pollingStationCode: s.code,
    countyId: s.countyId,
    constituencyId: s.constituencyId,
    wardId: s.wardId,
    pollingCentreId: s.pollingCentreId,
  });
  const wards = [...new Map(stations.map((s) => [s.wardId, s] as const)).values()];

  const now = Date.now();
  const hoursAgo = (h: number) => new Date(now - h * 3_600_000);
  const rand = rng(2027);
  const pick = <T>(xs: readonly T[]) => xs[Math.floor(rand() * xs.length)]!;

  /* ---------------------------------- Agents ---------------------------------- */
  const agentIds: string[] = [];
  for (let i = 1; i <= AGENT_COUNT; i++) {
    const home = wards[(i * 7) % wards.length]!;
    const status = i <= 2 ? 'ACTIVE' : i % 37 === 0 ? 'WITHDRAWN' : i % 19 === 0 ? 'INACTIVE' : i % 11 === 0 ? 'STANDBY' : i % 13 === 0 ? 'RECRUITED' : 'ACTIVE';
    const phone = `+2547000${pad(i, 5)}`;
    const nationalId = `99${pad(i * 1373, 6)}`;
    const hasMpesa = i % 3 !== 0;
    const hasKin = i % 2 === 0;
    const given = GIVEN[(i - 1) % GIVEN.length]!;
    const family = FAMILY[(i * 5) % FAMILY.length]!;
    const agent = await prisma.agent.create({
      data: {
        tenantId,
        reference: ref('AGT', i),
        userId: i === 1 ? users.agent1 : i === 2 ? users.agent2 : null,
        givenName: given,
        otherNames: 'Synthetic',
        familyName: family,
        gender: i % 9 === 0 ? null : i % 2 === 0 ? 'FEMALE' : 'MALE',
        homeWardId: home.wardId,
        homeConstituencyId: home.constituencyId,
        homeCountyId: home.countyId,
        languages: i % 4 === 0 ? ['sw', 'en', 'Lubukusu'] : i % 5 === 0 ? ['sw', 'Lubukusu'] : ['sw', 'en'],
        status,
        availability: status === 'ACTIVE' ? (i % 10 === 0 ? 'LIMITED' : 'AVAILABLE') : status === 'STANDBY' ? 'AVAILABLE' : 'UNAVAILABLE',
        notes: i % 17 === 0 ? 'Prefers a station within walking distance of home (synthetic note).' : null,
        phoneMasked: maskPhone(phone),
        nationalIdMasked: maskNationalId(nationalId),
        hasMpesaNumber: hasMpesa,
        hasNextOfKin: hasKin,
        privacyNoticeVersion: config.agentPrivacyNoticeVersion,
        privacyNoticeAckAt: hoursAgo(24 * 40 - i),
        createdById: i % 2 === 0 ? users.fieldCoord! : users.fieldCoordNorth!,
      },
    });
    agentIds.push(agent.id);
    await prisma.agentSensitive.create({
      data: {
        agentId: agent.id,
        tenantId,
        nationalIdNumber: nationalId,
        phone,
        mpesaNumber: hasMpesa ? (i % 6 === 0 ? `+2547001${pad(i, 5)}` : phone) : null,
        nextOfKinName: hasKin ? `Synthetic Relative ${i}` : null,
        nextOfKinPhone: hasKin ? `+2547002${pad(i, 5)}` : null,
        nextOfKinRelationship: hasKin ? pick(['Sibling', 'Parent', 'Spouse', 'Friend']) : null,
        updatedById: users.fieldCoord!,
      },
    });
    await prisma.agentStatusEvent.create({ data: { tenantId, agentId: agent.id, fromStatus: null, toStatus: 'RECRUITED', reason: 'Registered (synthetic seed)', actorId: users.fieldCoord!, createdAt: hoursAgo(24 * 40 - i) } });
    if (status !== 'RECRUITED') {
      await prisma.agentStatusEvent.create({ data: { tenantId, agentId: agent.id, fromStatus: 'RECRUITED', toStatus: status, reason: status === 'WITHDRAWN' ? 'Agent withdrew (synthetic)' : 'Status updated (synthetic)', actorId: users.fieldCoord!, createdAt: hoursAgo(24 * 20 - i) } });
    }
    const accreditation = status === 'WITHDRAWN' ? 'NOT_APPLICABLE' : i % 23 === 0 ? 'REJECTED' : i % 8 === 0 ? 'PENDING' : i % 14 === 0 ? 'SUBMITTED' : i % 29 === 0 ? 'NOT_SUBMITTED' : 'APPROVED';
    await prisma.agentAccreditation.create({
      data: {
        tenantId,
        agentId: agent.id,
        electionCycleId: cycleId,
        status: accreditation,
        accreditationReference: accreditation === 'APPROVED' ? `SYN-ACC-${pad(i, 5)}` : null,
        submittedAt: accreditation === 'NOT_SUBMITTED' || accreditation === 'NOT_APPLICABLE' ? null : hoursAgo(24 * 15),
        decidedAt: accreditation === 'APPROVED' || accreditation === 'REJECTED' ? hoursAgo(24 * 5) : null,
        notes: accreditation === 'REJECTED' ? 'Returned by the accrediting body; resubmission advised (synthetic).' : null,
        updatedById: users.fieldCoord!,
      },
    });
    const trainingStatus = status === 'RECRUITED' ? 'SCHEDULED' : i % 15 === 0 ? 'ABSENT' : i % 21 === 0 ? 'NOT_PASSED' : 'COMPLETED';
    await prisma.agentTraining.create({
      data: {
        tenantId,
        agentId: agent.id,
        electionCycleId: cycleId,
        title: 'Polling-day procedures and factual reporting',
        status: trainingStatus,
        scheduledOn: hoursAgo(24 * 12),
        materialsIssued: trainingStatus !== 'SCHEDULED' && trainingStatus !== 'ABSENT',
        attendedAt: ['COMPLETED', 'NOT_PASSED'].includes(trainingStatus) ? hoursAgo(24 * 12) : null,
        assessmentScore: trainingStatus === 'COMPLETED' ? 70 + (i % 30) : trainingStatus === 'NOT_PASSED' ? 45 : null,
        completedAt: trainingStatus === 'COMPLETED' ? hoursAgo(24 * 12) : null,
        refresherDueOn: trainingStatus === 'COMPLETED' ? hoursAgo(-24 * 30) : null,
        recordedById: users.fieldCoord!,
      },
    });
    if (i % 4 === 0) {
      await prisma.agentTraining.create({
        data: { tenantId, agentId: agent.id, electionCycleId: cycleId, title: 'Using the NGAO360 field app offline', status: i % 8 === 0 ? 'COMPLETED' : 'SCHEDULED', scheduledOn: hoursAgo(-24 * 3), materialsIssued: i % 8 === 0, completedAt: i % 8 === 0 ? hoursAgo(24 * 2) : null, recordedById: users.fieldCoord! },
      });
    }
  }

  /* -------------------------------- Deployments ------------------------------- */
  // Chief agents on planned stations, with deliberate gaps; station agents,
  // relief agents, runners and supervisors on some; a few replacements and cancellations.
  const available = agentIds.filter((_, idx) => {
    const i = idx + 1;
    // Agents 1 and 2 (the demo agent accounts) are placed on s1 and s2 explicitly.
    return i > 2 && !(i % 37 === 0 || i % 19 === 0 || i % 13 === 0);
  });
  const uncovered = new Set([7, 18, 26, 33, 41, 52, 58, 64, 77, 85, 91, 99, 104]);
  let agentCursor = 0;
  const nextAgent = () => available[agentCursor++];
  const deploymentByStation = new Map<number, { id: string; status: DeploymentStatus }>();
  let deploymentCount = 0;
  const statusFor = (n: number): DeploymentStatus => (n % 5 === 0 ? 'ASSIGNED' : n % 3 === 0 ? 'CONFIRMED' : 'CHECKED_IN');

  const createDeployment = async (
    s: StationRow,
    agentId: string,
    role: DeploymentRole,
    status: DeploymentStatus,
    extra: { shift?: DeploymentShift; replacesDeploymentId?: string; cancelledReason?: string; supervisorAgentId?: string } = {},
  ) => {
    const checkedIn = status === 'CHECKED_IN' || status === 'CHECKED_OUT';
    const d = await prisma.deployment.create({
      data: {
        tenantId,
        agentId,
        role,
        shift: extra.shift ?? 'FULL_DAY',
        status,
        ...loc(s),
        supervisorAgentId: extra.supervisorAgentId ?? null,
        instructions: role === 'CHIEF_AGENT' ? 'Arrive by 05:30, present your accreditation letter, observe opening and stay until the result form is displayed (synthetic).' : null,
        confirmedAt: ['CONFIRMED', 'CHECKED_IN', 'CHECKED_OUT'].includes(status) ? hoursAgo(30) : null,
        checkedInAt: checkedIn ? hoursAgo(6 + (deploymentCount % 3)) : null,
        checkInLatitude: checkedIn && deploymentCount % 2 === 0 ? 0.5635 + (deploymentCount % 50) / 10_000 : null,
        checkInLongitude: checkedIn && deploymentCount % 2 === 0 ? 34.5606 + (deploymentCount % 50) / 10_000 : null,
        checkInAccuracyMetres: checkedIn && deploymentCount % 2 === 0 ? 25 : null,
        replacesDeploymentId: extra.replacesDeploymentId ?? null,
        cancelledReason: extra.cancelledReason ?? null,
        createdById: users.planner!,
        createdAt: hoursAgo(24 * 7),
      },
    });
    deploymentCount++;
    const events: Array<{ type: 'CREATED' | 'CONFIRMED' | 'CHECKED_IN' | 'REPLACED' | 'CANCELLED'; from: DeploymentStatus | null; to: DeploymentStatus; at: Date; actor: string; hasLocation?: boolean; note?: string }> = [
      { type: 'CREATED', from: null, to: 'ASSIGNED', at: hoursAgo(24 * 7), actor: users.planner! },
    ];
    if (['CONFIRMED', 'CHECKED_IN', 'CHECKED_OUT'].includes(status)) events.push({ type: 'CONFIRMED', from: 'ASSIGNED', to: 'CONFIRMED', at: hoursAgo(30), actor: users.planner! });
    if (checkedIn) events.push({ type: 'CHECKED_IN', from: 'CONFIRMED', to: 'CHECKED_IN', at: d.checkedInAt!, actor: users.planner!, hasLocation: d.checkInLatitude !== null });
    if (status === 'REPLACED') events.push({ type: 'REPLACED', from: 'ASSIGNED', to: 'REPLACED', at: hoursAgo(48), actor: users.planner!, note: 'Agent unavailable on polling day; replaced (synthetic).' });
    if (status === 'CANCELLED') events.push({ type: 'CANCELLED', from: 'ASSIGNED', to: 'CANCELLED', at: hoursAgo(50), actor: users.planner!, note: extra.cancelledReason ?? 'Cancelled' });
    for (const e of events) {
      await prisma.deploymentEvent.create({
        data: { tenantId, deploymentId: d.id, type: e.type, fromStatus: e.from, toStatus: e.to, note: e.note ?? null, hasLocation: e.hasLocation ?? false, actorId: e.actor, createdAt: e.at },
      });
    }
    return d;
  };

  for (let n = 1; n <= PLANNED_STATIONS; n++) {
    if (uncovered.has(n)) continue;
    const s = station(n);
    // The two demo agent accounts are chief agents of s1 and s2 (their station-scoped grants).
    const agentId = n === 1 ? agentIds[0]! : n === 2 ? agentIds[1]! : nextAgent();
    if (!agentId) break;
    // Replacement examples: the original chief agent is REPLACED, a successor takes the slot.
    if (n === 12 || n === 47 || n === 88) {
      const original = await createDeployment(s, agentId, 'CHIEF_AGENT', 'REPLACED');
      const successor = nextAgent();
      if (successor) {
        const d = await createDeployment(s, successor, 'CHIEF_AGENT', 'CONFIRMED', { replacesDeploymentId: original.id });
        deploymentByStation.set(n, { id: d.id, status: 'CONFIRMED' });
      }
      continue;
    }
    if (n === 30 || n === 70) {
      await createDeployment(s, agentId, 'CHIEF_AGENT', 'CANCELLED', { cancelledReason: 'Station moved to another agent group (synthetic).' });
      continue; // cancelled and not re-filled: the station shows as not assigned
    }
    const status = statusFor(n);
    const d = await createDeployment(s, agentId, 'CHIEF_AGENT', status);
    deploymentByStation.set(n, { id: d.id, status });
  }
  // Second agents and support roles on some stations (each agent holds at most one active deployment).
  for (const n of [3, 5, 9, 14, 21, 25, 36, 44, 50, 61, 68, 75, 81, 95, 102]) {
    const agentId = nextAgent();
    if (!agentId) break;
    await createDeployment(station(n), agentId, n % 2 === 0 ? 'RELIEF_AGENT' : 'STATION_AGENT', statusFor(n + 1), { shift: n % 2 === 0 ? 'CLOSING_AND_COUNTING' : 'FULL_DAY' });
  }
  for (const n of [10, 40, 80]) {
    const agentId = nextAgent();
    if (!agentId) break;
    await createDeployment(station(n), agentId, 'SUPERVISOR', 'CHECKED_IN');
  }
  for (const n of [15, 55]) {
    const agentId = nextAgent();
    if (!agentId) break;
    await createDeployment(station(n), agentId, 'RUNNER', 'CONFIRMED', { shift: 'CLOSING_AND_COUNTING' });
  }
  console.log(`  field: ${AGENT_COUNT} agents, ${deploymentCount} deployments (${PLANNED_STATIONS - deploymentByStation.size} planned stations without an active chief agent, ${stations.length - PLANNED_STATIONS} outside the plan)`);

  /* --------------------------------- Readiness -------------------------------- */
  let checklists = 0;
  for (let n = 1; n <= PLANNED_STATIONS; n++) {
    if (n % 9 === 0) continue; // some stations have no checklist yet: shown as not started, never as ready
    const s = station(n);
    const covered = deploymentByStation.has(n);
    const items = READINESS_CATEGORIES.map((category, ci) => {
      let status: ReadinessItemStatus;
      if (category === 'ACCREDITATION') status = covered ? (n % 8 === 0 ? 'IN_PROGRESS' : 'DONE') : 'NOT_STARTED';
      else if (n % 17 === 0 && ci === 2) status = 'BLOCKED';
      else if (n % 6 === 0) status = ci % 2 === 0 ? 'IN_PROGRESS' : 'NOT_STARTED';
      else if (n % 25 === 0 && category === 'PAYMENT') status = 'NOT_APPLICABLE';
      else status = n % 4 === 0 && ci > 2 ? 'IN_PROGRESS' : 'DONE';
      return { category, status };
    });
    const checklist = await prisma.readinessChecklist.create({
      data: { tenantId, ...loc(s), status: deriveReadinessStatus(items) },
    });
    for (const it of items) {
      await prisma.readinessItem.create({
        data: {
          tenantId,
          checklistId: checklist.id,
          category: it.category,
          status: it.status,
          note: it.status === 'BLOCKED' ? 'Vehicle hire not confirmed for this ward (synthetic).' : null,
          dueAt: hoursAgo(-24),
          updatedById: it.status === 'NOT_STARTED' ? null : users.planner!,
        },
      });
    }
    checklists++;
  }

  /* ----------------------------- Report templates ----------------------------- */
  const opening = await prisma.fieldReportTemplate.create({
    data: { tenantId, key: 'opening-of-polls', version: 1, name: 'Opening of polls', description: 'Factual checklist completed by the chief agent when the station opens.', reportType: 'OPENING_OF_POLLS', status: 'ACTIVE', schema: OPENING_TEMPLATE as object, electionCycleId: cycleId, createdById: users.fieldCoord!, activatedById: users.commander!, activatedAt: hoursAgo(24 * 10) },
  });
  const closing = await prisma.fieldReportTemplate.create({
    data: { tenantId, key: 'closing-and-counting', version: 1, name: 'Closing and counting observation', description: 'Factual observation of the close of polls and the count.', reportType: 'CLOSING_AND_COUNTING', status: 'ACTIVE', schema: CLOSING_TEMPLATE as object, electionCycleId: cycleId, createdById: users.fieldCoord!, activatedById: users.commander!, activatedAt: hoursAgo(24 * 10) },
  });

  /* ------------------------------- Field reports ------------------------------ */
  const reportStations = [1, 2, 3, 4, 5, 6, 8, 9, 10, 11, 13, 14, 15, 16, 17, 19, 20, 21, 22, 23, 24, 25, 27, 28, 29, 31, 32, 34, 35, 36];
  const authors = [users.agent1!, users.agent2!, users.coordinator!, users.fieldCoordNorth!, users.fieldCoord!];
  const reportedStations = new Set<number>();
  let reportNo = 0;
  for (const n of reportStations) {
    reportNo++;
    const s = station(n);
    const isClosing = reportNo > 22;
    const author = n === 1 ? users.agent1! : n === 2 ? users.agent2! : authors[reportNo % authors.length]!;
    const offline = reportNo % 4 === 0;
    const key = seededUuid(`field-report-${reportNo}`);
    const reviewStatus = reportNo % 7 === 0 ? 'RETURNED' : reportNo % 5 === 0 ? 'ESCALATED' : reportNo % 3 === 0 ? 'SUBMITTED' : 'ACCEPTED';
    const reviewer = reviewStatus === 'SUBMITTED' ? null : author === users.fieldCoord! ? users.commander! : users.fieldCoord!;
    const answers = isClosing
      ? { closing_time: '17:00', queue_at_close: n % 3 === 0 ? 'yes' : 'no_queue', count_observed: true, form_displayed: n % 4 !== 0, copy_received: n % 5 !== 0, count_concerns: n % 4 === 0 ? 'The result form was not displayed at the station door after the count (synthetic).' : '' }
      : { opened_on_time: n % 6 !== 0, opening_time: n % 6 !== 0 ? '06:00' : '06:45', agent_admitted: n % 10 !== 0, materials_present: n % 8 === 0 ? ['ballot_papers', 'register'] : ['ballot_papers', 'ballot_boxes_sealed', 'register', 'kits_device', 'forms'], queue_estimate: 40 + ((n * 37) % 300), observations: n % 6 === 0 ? 'Opening delayed while ballot papers for one stream were sorted (synthetic).' : '' };
    const report = await prisma.fieldReport.create({
      data: {
        tenantId,
        reference: ref('FRP', reportNo),
        templateId: isClosing ? closing.id : opening.id,
        templateVersion: 1,
        reportType: isClosing ? 'CLOSING_AND_COUNTING' : 'OPENING_OF_POLLS',
        ...loc(s),
        geographicUnitId: s.geographicUnitId,
        eventAt: hoursAgo(isClosing ? 1 : 7),
        receivedAt: hoursAgo(isClosing ? 0.5 : offline ? 4 : 6.5),
        answers,
        authorId: author,
        submittedOffline: offline,
        clientIdempotencyKey: key,
        deviceId: `seed-device-${pad(reportNo, 3)}`,
        clientCreatedAt: hoursAgo(isClosing ? 1 : 7),
        reviewStatus,
        reviewerId: reviewer,
        reviewNote: reviewStatus === 'RETURNED' ? 'Please confirm the opening time you observed.' : reviewStatus === 'ESCALATED' ? 'Escalated to the incident desk for follow-up.' : reviewer ? 'Accepted.' : null,
        reviewedAt: reviewer ? hoursAgo(isClosing ? 0.25 : 5) : null,
      },
    });
    reportedStations.add(n);
    await prisma.clientSubmission.create({
      data: { tenantId, userId: author, deviceId: `seed-device-${pad(reportNo, 3)}`, idempotencyKey: key, kind: 'FIELD_REPORT', payloadHash: createHash('sha256').update(`seed:${key}`).digest('hex'), outcome: 'ACCEPTED', resultType: 'FieldReport', resultId: report.id, resultReference: report.reference, clientCreatedAt: report.clientCreatedAt, firstSeenAt: report.receivedAt, lastSeenAt: report.receivedAt },
    });
  }

  /* --------------------------------- Incidents -------------------------------- */
  const incidentSpecs: Array<{ n: number; category: IncidentCategory; severity: IncidentSeverity; status: IncidentStatus; description: string; hoursAgo: number }> = [
    { n: 6, category: 'OPENING_OR_CLOSING_TIME', severity: 'MEDIUM', status: 'CLOSED', description: 'The station opened 45 minutes after the published time while ballot papers for one stream were sorted.', hoursAgo: 7 },
    { n: 10, category: 'AGENT_ACCESS', severity: 'HIGH', status: 'RESOLVED', description: 'The chief agent was asked to wait outside for 30 minutes before the accreditation letter was accepted.', hoursAgo: 6.8 },
    { n: 16, category: 'MATERIALS', severity: 'MEDIUM', status: 'ASSIGNED', description: 'The printed register for stream 2 was missing at opening; voters were directed to stream 1 while it was located.', hoursAgo: 6.5 },
    { n: 3, category: 'EQUIPMENT', severity: 'MEDIUM', status: 'TRIAGED', description: 'The voter identification device restarted twice during the first hour; the queue paused for about ten minutes each time.', hoursAgo: 6.2 },
    { n: 22, category: 'OTHER', severity: 'LOW', status: 'REPORTED', description: 'A long queue formed at opening; officials opened a second line after 20 minutes.', hoursAgo: 6 },
    { n: 27, category: 'SECURITY', severity: 'HIGH', status: 'ESCALATED', description: 'A group gathered near the station entrance and shouted at people in the queue; no one was injured. Security officers were called.', hoursAgo: 5.5 },
    { n: 31, category: 'VIOLENCE_OR_INTIMIDATION', severity: 'CRITICAL', status: 'ESCALATED', description: 'A scuffle broke out in the queue and one person was taken for first aid. Voting paused for 20 minutes.', hoursAgo: 5.2 },
    { n: 34, category: 'ACCESSIBILITY', severity: 'MEDIUM', status: 'CLOSED', description: 'The station entrance had steps only; an elderly voter was assisted in by officials after a short wait.', hoursAgo: 5 },
    { n: 9, category: 'LOGISTICS', severity: 'LOW', status: 'CLOSED', description: 'The vehicle carrying agent refreshments arrived three hours late (no effect on voting).', hoursAgo: 4.8 },
    { n: 13, category: 'COMMUNICATIONS', severity: 'LOW', status: 'RESOLVED', description: 'Mobile network coverage at the centre was intermittent; reports were saved on the phone and sent later.', hoursAgo: 4.5 },
    { n: 20, category: 'PROCEDURE', severity: 'MEDIUM', status: 'ASSIGNED', description: 'Ballot boxes were sealed before agents were invited to view that they were empty.', hoursAgo: 4.2 },
    { n: 44, category: 'VOTER_IDENTIFICATION', severity: 'MEDIUM', status: 'TRIAGED', description: 'Several voters were told their details could not be found and were directed to a help desk at the centre.', hoursAgo: 4 },
    { n: 50, category: 'HEALTH_AND_SAFETY', severity: 'HIGH', status: 'RESOLVED', description: 'An official felt unwell in the heat and was replaced by a colleague; voting continued.', hoursAgo: 3.8 },
    { n: 57, category: 'MATERIALS', severity: 'HIGH', status: 'REPORTED', description: 'Ballot papers for the governor contest ran low by mid-afternoon; officials said more were on the way.', hoursAgo: 3.5 },
    { n: 63, category: 'OPENING_OR_CLOSING_TIME', severity: 'MEDIUM', status: 'REPORTED', description: 'The station closed to new voters at 16:50, ten minutes before the published closing time.', hoursAgo: 1.4 },
    { n: 66, category: 'COUNTING_AND_FORMS', severity: 'HIGH', status: 'ASSIGNED', description: 'The station result form was not displayed at the door after the count; officials said it would be displayed later.', hoursAgo: 1.2 },
    { n: 72, category: 'COUNTING_AND_FORMS', severity: 'HIGH', status: 'TRIAGED', description: 'Agents were not given a copy of the station result form after the count.', hoursAgo: 1.1 },
    { n: 23, category: 'AGENT_ACCESS', severity: 'HIGH', status: 'REPORTED', description: 'The relief agent was not admitted for the counting shift although the accreditation letter was presented.', hoursAgo: 1 },
    { n: 79, category: 'SECURITY', severity: 'MEDIUM', status: 'CLOSED', description: 'Lighting failed at the start of the count; counting resumed under lanterns after 15 minutes.', hoursAgo: 0.9 },
    { n: 83, category: 'EQUIPMENT', severity: 'LOW', status: 'CLOSED', description: 'A ballot box seal broke while being fitted and was replaced with a new seal in front of agents.', hoursAgo: 6.9 },
    { n: 90, category: 'PROCEDURE', severity: 'MEDIUM', status: 'RESOLVED', description: 'Counting started before all agents present had been seated; officials paused and restarted the tally sheet.', hoursAgo: 0.8 },
    { n: 96, category: 'OTHER', severity: 'LOW', status: 'TRIAGED', description: 'A loudspeaker vehicle drove past the centre twice playing music; no campaign material was observed.', hoursAgo: 5.9 },
    { n: 101, category: 'VIOLENCE_OR_INTIMIDATION', severity: 'CRITICAL', status: 'REPORTED', description: 'Agents reported being followed after leaving the counting hall; they are safe and with security officers.', hoursAgo: 0.5 },
    { n: 120, category: 'LOGISTICS', severity: 'MEDIUM', status: 'ASSIGNED', description: 'No agent transport reached the centre in the morning; the station has no agent assigned.', hoursAgo: 6.6 },
    { n: 135, category: 'COMMUNICATIONS', severity: 'LOW', status: 'REPORTED', description: 'The coordinator could not reach the centre by phone for two hours.', hoursAgo: 3 },
  ];

  const reporters = [users.agent1!, users.agent2!, users.coordinator!, users.fieldCoordNorth!, users.fieldCoord!];
  const openSevere = new Map<number, boolean>();
  const order: IncidentStatus[] = ['REPORTED', 'TRIAGED', 'ASSIGNED', 'ESCALATED', 'RESOLVED', 'CLOSED'];
  let incNo = 0;
  for (const spec of incidentSpecs) {
    incNo++;
    const s = station(spec.n);
    const reporter = spec.n === 1 ? users.agent1! : spec.n === 2 ? users.agent2! : reporters[incNo % reporters.length]!;
    const reportedAt = hoursAgo(spec.hoursAgo - 0.1);
    const rank = order.indexOf(spec.status);
    const resolved = spec.status === 'RESOLVED' || spec.status === 'CLOSED';
    const closed = spec.status === 'CLOSED';
    const escalated = spec.status === 'ESCALATED';
    const assigned = rank >= 2 || resolved;
    const initialSeverity = spec.category === 'VIOLENCE_OR_INTIMIDATION' ? 'CRITICAL' : ['AGENT_ACCESS', 'COUNTING_AND_FORMS', 'SECURITY', 'HEALTH_AND_SAFETY'].includes(spec.category) ? 'HIGH' : ['LOGISTICS', 'COMMUNICATIONS', 'OTHER'].includes(spec.category) ? 'LOW' : 'MEDIUM';
    const key = seededUuid(`incident-${incNo}`);
    const offline = incNo % 5 === 0;
    const inc = await prisma.incident.create({
      data: {
        tenantId,
        reference: ref('INC', incNo),
        electionCycleId: cycleId,
        reportedCategory: spec.category,
        category: spec.category,
        initialSeverity,
        severity: spec.severity,
        status: spec.status,
        outcome: resolved ? (spec.n === 90 ? 'UNRESOLVED' : spec.n === 50 ? 'NO_ACTION_NEEDED' : 'RESOLVED') : null,
        occurredAt: hoursAgo(spec.hoursAgo),
        reportedAt,
        pollingStationCode: s.code,
        geographicUnitId: s.geographicUnitId,
        countyId: s.countyId,
        constituencyId: s.constituencyId,
        wardId: s.wardId,
        pollingCentreId: s.pollingCentreId,
        description: `${spec.description} (synthetic)`,
        sensitivity: spec.category === 'VIOLENCE_OR_INTIMIDATION' || spec.category === 'SECURITY' ? 'CONFIDENTIAL' : 'INTERNAL',
        reporterId: reporter,
        assigneeId: assigned ? users.desk! : null,
        escalatedTo: escalated ? (spec.category === 'VIOLENCE_OR_INTIMIDATION' ? 'SECURITY_LIAISON' : 'WAR_ROOM_COMMAND') : null,
        evidenceHold: spec.category === 'VIOLENCE_OR_INTIMIDATION',
        resolutionNote: resolved ? (spec.n === 90 ? 'Agents and officials disagree on when counting began; recorded as unresolved for legal review.' : 'Issue addressed at the station; voting or counting continued.') : null,
        resolvedById: resolved ? users.desk! : null,
        resolvedAt: resolved ? hoursAgo(spec.hoursAgo - 1) : null,
        closureNote: closed ? 'Reviewed the report and the resolution; no further action.' : null,
        closedById: closed ? (incNo % 2 === 0 ? users.commander! : users.legal!) : null,
        closedAt: closed ? hoursAgo(Math.max(0.1, spec.hoursAgo - 1.5)) : null,
        submittedOffline: offline,
        clientIdempotencyKey: key,
        deviceId: `seed-device-inc-${pad(incNo, 3)}`,
        clientCreatedAt: hoursAgo(spec.hoursAgo),
      },
    });
    const ev = async (type: Parameters<typeof prisma.incidentEvent.create>[0]['data']['type'], from: IncidentStatus | null, to: IncidentStatus | null, actor: string, at: number, note: string | null, data: object = {}) =>
      prisma.incidentEvent.create({ data: { tenantId, incidentId: inc.id, type, fromStatus: from, toStatus: to, note, data, actorId: actor, createdAt: hoursAgo(at) } });
    await ev('REPORTED', null, 'REPORTED', reporter, spec.hoursAgo - 0.1, null, { category: spec.category, initialSeverity });
    if (rank >= 1 || resolved) await ev('TRIAGED', 'REPORTED', 'TRIAGED', users.desk!, spec.hoursAgo - 0.3, 'Acknowledged and triaged.', { severity: spec.severity, previousSeverity: initialSeverity });
    if (assigned) await ev('ASSIGNED', 'TRIAGED', 'ASSIGNED', users.desk!, spec.hoursAgo - 0.4, null, { assigneeId: users.desk! });
    if (escalated) await ev('ESCALATED', 'ASSIGNED', 'ESCALATED', users.desk!, spec.hoursAgo - 0.5, 'Escalated for coordination with security officers.', { target: spec.category === 'VIOLENCE_OR_INTIMIDATION' ? 'SECURITY_LIAISON' : 'WAR_ROOM_COMMAND' });
    if (spec.category === 'VIOLENCE_OR_INTIMIDATION') await ev('EVIDENCE_HOLD_PLACED', null, null, users.desk!, spec.hoursAgo - 0.55, 'Evidence hold placed pending legal review.');
    if (spec.n === 16) await ev('CORRECTION', null, null, reporter, spec.hoursAgo - 0.6, 'Correction: the missing register was for stream 3, not stream 2.', { note: 'reporter correction' });
    if (resolved) await ev('RESOLVED', 'ASSIGNED', 'RESOLVED', users.desk!, spec.hoursAgo - 1, inc.resolutionNote, { outcome: inc.outcome });
    if (closed) await ev('CLOSED', 'RESOLVED', 'CLOSED', inc.closedById!, Math.max(0.1, spec.hoursAgo - 1.5), inc.closureNote);
    if (!closed && (spec.severity === 'HIGH' || spec.severity === 'CRITICAL')) openSevere.set(spec.n, true);
    if (spec.n === 27) {
      await prisma.incidentSubject.create({ data: { tenantId, incidentId: inc.id, description: 'Reported by the chief agent as a group of about ten people; no individual identified (synthetic).', recordedById: users.commander! } });
      await ev('SUBJECT_RECORDED', null, null, users.commander!, spec.hoursAgo - 0.6, 'Restricted subject record added.');
    }
    if (offline) {
      await prisma.clientSubmission.create({
        data: { tenantId, userId: reporter, deviceId: `seed-device-inc-${pad(incNo, 3)}`, idempotencyKey: key, kind: 'INCIDENT', payloadHash: createHash('sha256').update(`seed:${key}`).digest('hex'), outcome: 'ACCEPTED', resultType: 'Incident', resultId: inc.id, resultReference: inc.reference, clientCreatedAt: inc.clientCreatedAt, firstSeenAt: reportedAt, lastSeenAt: reportedAt },
      });
    }
  }

  /* ----------------------- War Room station status (derived) ------------------- */
  let statuses = 0;
  for (let n = 1; n <= stations.length; n++) {
    const s = station(n);
    const dep = deploymentByStation.get(n) ?? null;
    const manual = n === 31 ? ('FLAGGED' as const) : null;
    const derived = deriveStationStatus({
      manual: null,
      deploymentStatus: dep?.status ?? null,
      hasFieldUpdate: reportedStations.has(n),
      formStatus: null,
      openSevereIncident: openSevere.get(n) ?? false,
      pollsClosed: false,
    }) as OperationalStatus;
    const status = (manual ?? derived) as OperationalStatus;
    const row = await prisma.stationStatus.create({
      data: {
        tenantId,
        ...loc(s),
        status,
        source: manual ? 'MANUAL' : 'DERIVED',
        derivedStatus: derived,
        manualStatus: manual,
        manualNote: manual ? 'Flagged by the commander while the escalated incident is handled (synthetic).' : null,
        manualSetById: manual ? users.commander! : null,
        components: { deploymentStatus: dep?.status ?? null, hasFieldUpdate: reportedStations.has(n), openSevereIncident: openSevere.get(n) ?? false, formStatus: null },
        computedAt: hoursAgo(0.2),
      },
    });
    await prisma.stationStatusEvent.create({ data: { tenantId, stationStatusId: row.id, fromStatus: null, toStatus: derived, source: 'DERIVED', reason: null, createdAt: hoursAgo(0.2) } });
    if (manual) {
      await prisma.stationStatusEvent.create({ data: { tenantId, stationStatusId: row.id, fromStatus: derived, toStatus: manual, source: 'MANUAL', reason: row.manualNote, actorId: users.commander!, createdAt: hoursAgo(0.1) } });
    }
    statuses++;
  }
  console.log(`  field: ${checklists} readiness checklists, 2 report templates, ${reportNo} field reports, ${incNo} incidents, ${statuses} station statuses`);
}

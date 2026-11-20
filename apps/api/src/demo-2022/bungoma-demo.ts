/**
 * Build or refresh the 2022 Bungoma historical demo organisation
 * (`pnpm demo:2022-bungoma`, docs/DEMO_2022.md). Idempotent.
 *
 * 1. Provision the separate demo organisation (marked historical demo), its
 *    system roles and SYNTHETIC demo users. Like `pnpm db:seed`, this one step
 *    runs as the schema owner because the API has no tenant-provisioning path.
 * 2. Everything else goes through the API services as named demo users:
 *    - a HISTORICAL_DEMO election cycle with the simulated-data flag;
 *    - the generated registry: imported by one owner, approved by another
 *      (the existing maker-checker path; never self-approved);
 *    - tally centres, the governor contest with neutral candidate labels and a
 *      presidential contest for imported 34A scans;
 *    - 37A/37B/37C (and 34A/34B/34C) templates created by one person and
 *      approved by the legal officer;
 *    - SIMULATED 37A submissions moved through capture → independent second
 *      review by distinct clerks and verifiers. Some stations stay missing or
 *      awaiting review, and a few are held by arithmetic discrepancies;
 *    - verified 37B per constituency and 37C for the county;
 *    - one immutable snapshot.
 *
 * Nothing is fetched from the network. Every station-level figure is SIMULATED.
 */
import { createHash } from 'node:crypto';
import type { INestApplicationContext } from '@nestjs/common';
import argon2 from 'argon2';
import { type PrismaClient, provisionSystemRoles, sealSecret, syncPermissionCatalogue, type TenantTx } from '@ngao360/db';
import {
  allFormTemplateDefinitions,
  CreateSnapshotSchema,
  type DemoConfig,
  generateGovernorLayer,
  HISTORICAL_DEMO_LABEL,
  type SimulatedFigures,
  type SimulatedGovernorLayer,
  type SubmissionStatus,
  type SystemRoleKey,
  toCsv,
  unverifiedConfigValues,
} from '@ngao360/shared';
import type { AuthContext } from '../auth/auth.types';
import { ContestsService } from '../modules/reference/contests.service';
import { ElectionCyclesService } from '../modules/reference/election-cycles.service';
import { FormTemplatesService } from '../modules/reference/form-templates.service';
import { RegistryService } from '../modules/reference/registry.service';
import { TallyCentresService } from '../modules/reference/tally-centres.service';
import { CaptureService } from '../modules/tally/services/capture.service';
import { ResultsService } from '../modules/tally/services/results.service';
import { SubmissionsService } from '../modules/tally/services/submissions.service';
import { VerificationService } from '../modules/tally/services/verification.service';
import { PrismaService } from '../prisma/prisma.service';
import { actAs, authFor, pool, requirePermission, svc } from './demo-context';
import { renderSimulatedFormPng, type SimulatedFormImage } from './simulated-form-image';

/* ---------------------------------------------------------------------------------------------- */
/* Demo users (SYNTHETIC)                                                                         */
/* ---------------------------------------------------------------------------------------------- */

export interface DemoUserDef {
  local: string;
  displayName: string;
  role: SystemRoleKey;
}

/** Two owners make the registry maker-checker possible; clerks and verifiers are distinct people. */
export const DEMO_USERS: readonly DemoUserDef[] = [
  { local: 'owner', displayName: 'Demo Owner (synthetic)', role: 'ORGANISATION_OWNER' },
  { local: 'registrar', displayName: 'Demo Registry Officer (synthetic)', role: 'ORGANISATION_OWNER' },
  { local: 'legal', displayName: 'Demo Legal Officer (synthetic)', role: 'LEGAL_COMPLIANCE_OFFICER' },
  { local: 'clerk1', displayName: 'Demo Clerk One (synthetic)', role: 'DATA_ENTRY_CLERK' },
  { local: 'clerk2', displayName: 'Demo Clerk Two (synthetic)', role: 'DATA_ENTRY_CLERK' },
  { local: 'clerk3', displayName: 'Demo Clerk Three (synthetic)', role: 'DATA_ENTRY_CLERK' },
  { local: 'verifier1', displayName: 'Demo Verifier One (synthetic)', role: 'RESULTS_VERIFIER' },
  { local: 'verifier2', displayName: 'Demo Verifier Two (synthetic)', role: 'RESULTS_VERIFIER' },
  { local: 'verifier3', displayName: 'Demo Verifier Three (synthetic)', role: 'RESULTS_VERIFIER' },
  { local: 'supervisor', displayName: 'Demo Supervisor (synthetic)', role: 'TALLY_SUPERVISOR' },
  { local: 'supervisor2', displayName: 'Demo Supervisor Two (synthetic)', role: 'TALLY_SUPERVISOR' },
];

export const demoEmail = (slug: string, local: string) => `${local}@${slug}.example.org`;

/** Same development TOTP secret as `pnpm db:seed` with SEED_DEMO_MFA=preenrolled. */
const DEMO_TOTP_SECRET = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';
const DEMO_TOTP_LABEL = 'Demo authenticator (synthetic)';

export interface BuildDemoOptions {
  config: DemoConfig;
  /** Owner-role client (DATABASE_URL), used only to provision the organisation, roles and users. */
  ownerDb: PrismaClient;
  password: string;
  mfa?: { mode: 'disabled' | 'preenrolled'; key?: string };
  /** Overrides config.dataset.tenantSlug (tests use random slugs). */
  tenantSlug?: string;
  concurrency?: number;
  log?: (line: string) => void;
}

export interface BuildDemoResult {
  tenantId: string;
  tenantSlug: string;
  cycleId: string;
  governorContestId: string;
  presidentialContestId: string;
  registryVersionId: string;
  snapshotId: string;
  layer: SimulatedGovernorLayer;
  statuses: Record<string, number>;
  verifiedStationCodes: string[];
  unverified: string[];
}

const CHECKLIST = {
  imageMatchesMetadata: true,
  allValuesComparedToSource: true,
  stationIdentityConfirmed: true,
  stampObserved: null,
  signatureObserved: null,
  legible: true,
};

/** Deterministic UUID (v4 layout) from a key, so re-runs replay the same idempotency keys. */
export function stableUuid(key: string): string {
  const h = createHash('sha256').update(`ngao360-demo-2022:${key}`).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${((parseInt(h.slice(16, 17), 16) & 0x3) | 0x8).toString(16)}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

/** Retry a unit of work on transient database conflicts (concurrent reference counters). */
async function retrying<T>(fn: () => Promise<T>, attempts = 4): Promise<T> {
  for (let i = 1; ; i++) {
    try {
      return await fn();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const transient = /deadlock|could not serialize|P2034|write conflict|Retry\./i.test(msg);
      if (!transient || i >= attempts) throw err;
      await new Promise((r) => setTimeout(r, 50 * i));
    }
  }
}

/* ---------------------------------------------------------------------------------------------- */

export async function buildBungomaDemo(app: INestApplicationContext, opts: BuildDemoOptions): Promise<BuildDemoResult> {
  const log = opts.log ?? (() => undefined);
  const config = opts.config;
  const slug = opts.tenantSlug ?? config.dataset.tenantSlug;
  const layer = generateGovernorLayer(config);
  log(`Simulated layer: ${layer.stations.length} stations in ${config.constituencies.length} constituencies (fingerprint ${layer.fingerprint}).`);

  /* -------------------------------- 1. Provision (owner role) ------------------------------- */
  const db = opts.ownerDb;
  await syncPermissionCatalogue(db);
  const tenant = await db.tenant.upsert({
    where: { slug },
    create: { slug, name: config.dataset.tenantName, displayName: config.dataset.tenantName, type: 'CAMPAIGN', historicalDemo: true },
    update: { name: config.dataset.tenantName, displayName: config.dataset.tenantName, historicalDemo: true },
  });
  const tenantId = tenant.id;
  const roleIds = await provisionSystemRoles(db, tenantId);
  const passwordHash = await argon2.hash(opts.password, { type: argon2.argon2id });
  for (const u of DEMO_USERS) {
    const email = demoEmail(slug, u.local);
    const user = await db.user.upsert({
      where: { tenantId_email: { tenantId, email } },
      create: { tenantId, email, displayName: u.displayName, passwordHash, status: 'ACTIVE', passwordChangedAt: new Date() },
      update: { displayName: u.displayName, passwordHash, status: 'ACTIVE', failedLoginCount: 0, lockedUntil: null },
    });
    const roleId = roleIds[u.role]!;
    const has = await db.roleAssignment.findFirst({ where: { tenantId, userId: user.id, roleId, revokedAt: null, scopeType: 'ORGANISATION' } });
    if (!has) await db.roleAssignment.create({ data: { tenantId, userId: user.id, roleId, scopeType: 'ORGANISATION', reason: 'Historical demo (synthetic user)' } });
    if (opts.mfa?.mode === 'preenrolled' && opts.mfa.key && process.env.NODE_ENV !== 'production') {
      const factor = await db.mfaFactor.findFirst({ where: { tenantId, userId: user.id, status: 'ACTIVE' } });
      if (!factor) {
        await db.mfaFactor.create({
          data: { tenantId, userId: user.id, type: 'TOTP', status: 'ACTIVE', label: DEMO_TOTP_LABEL, secretEncrypted: sealSecret(DEMO_TOTP_SECRET, opts.mfa.key), verifiedAt: new Date() },
        });
      }
      await db.user.update({ where: { id: user.id }, data: { mfaEnabled: true } });
    }
  }
  await db.tenantModule.upsert({
    where: { tenantId_moduleKey: { tenantId, moduleKey: 'tally' } },
    create: { tenantId, moduleKey: 'tally', enabled: true },
    update: { enabled: true },
  });
  log(`Organisation "${slug}" (historical demo) with ${DEMO_USERS.length} synthetic users.`);

  /* ------------------------------------- 2. As demo users ----------------------------------- */
  const as: Record<string, AuthContext> = {};
  for (const u of DEMO_USERS) as[u.local] = await authFor(app, tenantId, demoEmail(slug, u.local));
  const prisma = svc(app, PrismaService);
  const read = <T>(fn: (tx: TenantTx) => Promise<T>): Promise<T> => prisma.withTenant(tenantId, fn);

  // Election cycle: HISTORICAL_DEMO + simulated flag + provenance notes.
  const cycles = svc(app, ElectionCyclesService);
  const provenanceNotes =
    `${config.dataset.title}. Public administrative names (county, constituencies, wards) are historical reference data` +
    ` (verify: ${config.boundaries.verified ? 'verified' : 'unverified'}). Polling stations, codes (inferred 15-digit pattern), registered voters per station,` +
    ` 37A/37B/37C figures, form images, users and timing are SIMULATED (seed ${layer.seed}). County totals come from the demo config` +
    ` (${config.governor.candidates.every((c) => c.votes.verified) ? 'verified, see sources' : 'UNVERIFIED placeholders'}).`;
  let cycle = await read((tx) => tx.electionCycle.findFirst({ where: { name: config.dataset.cycleName } }));
  if (!cycle) {
    const reg = as.registrar!;
    requirePermission(reg, 'reference.edit');
    const created = await actAs(reg, () =>
      cycles.create(tenantId, {
        name: config.dataset.cycleName,
        electionDate: config.dataset.electionDate,
        jurisdiction: 'Kenya',
        legalConfigVersion: 'LN72-2017-baseline (2022 historical demo)',
        dataProvenance: 'HISTORICAL_DEMO',
        containsSimulatedData: true,
        provenanceNotes,
        officialSources: [
          { title: 'Constitution of Kenya, 2010, First Schedule (counties)', reference: 'County name and number' },
          { title: 'docs/DATA_SOURCES_2022.md and docs/DEMO_2022.md', reference: 'What is real and what is simulated in this demo' },
        ],
      }),
    );
    await actAs(reg, () => cycles.update(tenantId, created.id, { status: 'ACTIVE' }));
    cycle = await read((tx) => tx.electionCycle.findUniqueOrThrow({ where: { id: created.id } }));
  }
  const cycleId = cycle.id;

  // Registry: import by the registry officer, approval by the owner (maker-checker).
  const registry = svc(app, RegistryService);
  const version = `SIM-2022-${layer.fingerprint.slice(0, 10)}`;
  let rv = await read((tx) => tx.registryVersion.findFirst({ where: { electionCycleId: cycleId, version } }));
  if (!rv) {
    requirePermission(as.registrar!, 'reference.import');
    const created = await actAs(as.registrar!, () =>
      registry.create(tenantId, {
        electionCycleId: cycleId,
        version,
        source: `SIMULATED registry for the ${config.dataset.title}: station codes follow the INFERRED 15-digit pattern; centres, streams and registered voters per station are generated (seed ${layer.seed}). Not the IEBC station list.`,
        notes: `${HISTORICAL_DEMO_LABEL}. Generated by pnpm demo:2022-bungoma.`,
      }),
    );
    rv = await read((tx) => tx.registryVersion.findUniqueOrThrow({ where: { id: created.id } }));
  }
  if (rv.status === 'DRAFT' && rv.stationCount === 0) {
    const csv = registryCsv(layer);
    await actAs(as.registrar!, () =>
      registry.import(as.registrar!, rv!.id, { buffer: Buffer.from(csv, 'utf8'), originalname: `${version}.csv`, mimetype: 'text/csv' }, {
        dryRun: false,
        changeNotes: `${HISTORICAL_DEMO_LABEL}: generated registry`,
      }),
    );
  }
  rv = await read((tx) => tx.registryVersion.findUniqueOrThrow({ where: { id: rv!.id } }));
  if (rv.status === 'DRAFT') {
    requirePermission(as.owner!, 'reference.approve');
    await actAs(as.owner!, () => registry.approve(as.owner!, rv!.id, 'Historical demo: generated SIMULATED registry checked against the demo config'));
  }
  const registryVersionId = rv.id;
  log(`Registry ${version}: approved (imported by ${demoEmail(slug, 'registrar')}, approved by ${demoEmail(slug, 'owner')}).`);

  // Units, stations, tally centres.
  const units = await read((tx) => tx.geographicUnit.findMany({ where: { electionCycleId: cycleId }, select: { id: true, type: true, officialCode: true } }));
  const countyUnit = units.find((u) => u.type === 'COUNTY' && u.officialCode === config.county.code.value)!;
  const constituencyUnit = new Map(units.filter((u) => u.type === 'CONSTITUENCY').map((u) => [u.officialCode, u.id]));
  const stationIds = new Map(
    (await read((tx) => tx.pollingStation.findMany({ where: { registryVersionId }, select: { id: true, code: true } }))).map((s) => [s.code, s.id]),
  );
  const centres = svc(app, TallyCentresService);
  const centreCode = (k?: string) => `TC-${config.county.code.value}${k ?? ''}`;
  const existingCentres = new Map(
    (await read((tx) => tx.tallyCentre.findMany({ where: { electionCycleId: cycleId }, select: { id: true, code: true } }))).map((c) => [c.code, c.id]),
  );
  for (const k of config.constituencies) {
    if (!existingCentres.has(centreCode(k.code))) {
      const c = await actAs(as.registrar!, () =>
        centres.create(tenantId, { electionCycleId: cycleId, level: 'CONSTITUENCY', geographicUnitId: constituencyUnit.get(k.code)!, code: centreCode(k.code), name: `${k.name} constituency tallying centre (simulated)` }),
      );
      existingCentres.set(c.code, c.id);
    }
  }
  if (!existingCentres.has(centreCode())) {
    const c = await actAs(as.registrar!, () =>
      centres.create(tenantId, { electionCycleId: cycleId, level: 'COUNTY', geographicUnitId: countyUnit.id, code: centreCode(), name: `${config.county.name.value} county tallying centre (simulated)` }),
    );
    existingCentres.set(c.code, c.id);
  }

  // Form templates: created by the registry officer, approved by the legal officer.
  const templates = svc(app, FormTemplatesService);
  const tpl: Record<string, string> = {};
  for (const d of allFormTemplateDefinitions().filter((x) => ['37A', '37B', '37C', '34A', '34B', '34C'].includes(x.formNumber))) {
    const approved = await read((tx) => tx.formTemplate.findFirst({ where: { electionCycleId: cycleId, formNumber: d.formNumber, approvalState: 'APPROVED' }, orderBy: { version: 'desc' } }));
    if (approved) {
      tpl[d.formNumber] = approved.id;
      continue;
    }
    requirePermission(as.registrar!, 'forms.configure');
    requirePermission(as.legal!, 'forms.approve');
    const t = await actAs(as.registrar!, () =>
      templates.create(as.registrar!, {
        electionCycleId: cycleId,
        contestType: d.contestType,
        formNumber: d.formNumber,
        formLevel: d.formLevel,
        title: `${d.title} (2022 historical demo)`,
        effectiveDate: config.dataset.electionDate,
        fieldSchema: d.fieldSchema,
        validationRules: d.validationRules,
        officialSource: d.officialSource,
        officialSourceUrl: d.officialSourceUrl,
      }),
    );
    await actAs(as.registrar!, () => templates.decide(as.registrar!, t.id, { decision: 'SUBMIT_FOR_APPROVAL', reason: 'Historical demo template from the 34-39 catalogue' }));
    await actAs(as.legal!, () => templates.decide(as.legal!, t.id, { decision: 'APPROVE', reason: 'Approved for the 2022 historical demo only' }));
    tpl[d.formNumber] = t.id;
  }

  // Contests.
  const contests = svc(app, ContestsService);
  let governor = await read((tx) => tx.contest.findFirst({ where: { electionCycleId: cycleId, officeType: 'GOVERNOR' } }));
  if (!governor) {
    const c = await actAs(as.registrar!, () =>
      contests.create(tenantId, { electionCycleId: cycleId, officeType: 'GOVERNOR', name: `County Governor, ${config.county.name.value} (2022, SIMULATED station figures)`, geographicUnitId: countyUnit.id }),
    );
    for (const cand of layer.candidates) {
      const conf = config.governor.candidates[cand.ballotOrder - 1]!;
      await actAs(as.registrar!, () =>
        contests.addCandidate(tenantId, c.id, {
          candidateNameAsPublished: cand.displayName,
          partyLabel: cand.partyLabel,
          isIndependent: cand.partyLabel === null,
          ballotOrder: cand.ballotOrder,
          referenceCode: `SIM-GOV-${config.county.code.value}-${cand.ballotOrder}`,
          source: cand.verifiedName
            ? `${conf.name!.source}; every station-level figure is SIMULATED`
            : 'Neutral label: no verified candidate data configured; every figure is SIMULATED',
        }),
      );
    }
    await actAs(as.registrar!, () => contests.update(tenantId, c.id, { status: 'ACTIVE' }));
    governor = await read((tx) => tx.contest.findUniqueOrThrow({ where: { id: c.id } }));
  }
  let president = await read((tx) => tx.contest.findFirst({ where: { electionCycleId: cycleId, officeType: 'PRESIDENT' } }));
  if (!president) {
    const c = await actAs(as.registrar!, () =>
      contests.create(tenantId, { electionCycleId: cycleId, officeType: 'PRESIDENT', name: 'President (2022): local 34A scans for import', geographicUnitId: null }),
    );
    for (const [i, p] of config.presidential.candidates.entries()) {
      await actAs(as.registrar!, () =>
        contests.addCandidate(tenantId, c.id, {
          candidateNameAsPublished: p.name.value,
          partyLabel: p.partyLabel,
          isIndependent: p.partyLabel === null,
          ballotOrder: i + 1,
          source: p.name.source,
        }),
      );
    }
    if (config.presidential.candidates.length) await actAs(as.registrar!, () => contests.update(tenantId, c.id, { status: 'ACTIVE' }));
    president = await read((tx) => tx.contest.findUniqueOrThrow({ where: { id: c.id } }));
  }
  const candidates = await read((tx) => tx.candidateReference.findMany({ where: { contestId: governor!.id }, orderBy: { ballotOrder: 'asc' }, select: { id: true } }));
  const candidateIds = candidates.map((c) => c.id);

  /* --------------------------------- 3. Simulated submissions ------------------------------- */
  const submissions = svc(app, SubmissionsService);
  const capture = svc(app, CaptureService);
  const verification = svc(app, VerificationService);
  const clerks = ['clerk1', 'clerk2', 'clerk3'].map((k) => as[k]!);
  const verifiers = ['verifier1', 'verifier2', 'verifier3'].map((k) => as[k]!);
  const stationsByCode = new Map(layer.stations.map((s) => [s.code, s]));

  const figureValues = (f: SimulatedFigures, extra: Array<{ fieldKey: string; textValue?: string; numericValue?: number }>, mistypeValid = 0) => [
    ...candidateIds.map((id, i) => ({ fieldKey: 'candidate_votes', candidateReferenceId: id, numericValue: f.candidateVotes[i]!, expectedChangeVersion: 0 })),
    { fieldKey: 'total_valid_votes', candidateReferenceId: null, numericValue: f.totalValidVotes + mistypeValid, expectedChangeVersion: 0 },
    { fieldKey: 'rejected_ballots', candidateReferenceId: null, numericValue: f.rejectedBallots, expectedChangeVersion: 0 },
    { fieldKey: 'total_votes_cast', candidateReferenceId: null, numericValue: f.totalVotesCast + mistypeValid, expectedChangeVersion: 0 },
    { fieldKey: 'registered_voters', candidateReferenceId: null, numericValue: f.registeredVoters, expectedChangeVersion: 0 },
    ...extra.map((e) => ({ candidateReferenceId: null, expectedChangeVersion: 0, ...e })),
  ];
  const independentValues = (f: SimulatedFigures) => [
    ...candidateIds.map((id, i) => ({ fieldKey: 'candidate_votes', candidateReferenceId: id, numericValue: f.candidateVotes[i]! })),
    { fieldKey: 'total_valid_votes', candidateReferenceId: null, numericValue: f.totalValidVotes },
    { fieldKey: 'rejected_ballots', candidateReferenceId: null, numericValue: f.rejectedBallots },
    { fieldKey: 'total_votes_cast', candidateReferenceId: null, numericValue: f.totalVotesCast },
  ];

  /** Move one form through intake → capture → review → verification as far as its plan says. */
  const processForm = async (job: {
    key: string;
    formNumber: '37A' | '37B' | '37C';
    target: { pollingStationId: string } | { tallyCentreId: string };
    image: () => SimulatedFormImage;
    values: ReturnType<typeof figureValues>;
    target_status: 'AWAITING_REVIEW' | 'VERIFIED' | 'DISCREPANCY';
    figures: SimulatedFigures;
    clerk: AuthContext;
    verifier: AuthContext;
  }): Promise<SubmissionStatus> => {
    const idempotencyKey = stableUuid(`${cycleId}|${job.key}`);
    let sub = await read((tx) => tx.resultSubmission.findUnique({ where: { tenantId_idempotencyKey: { tenantId, idempotencyKey } }, select: { id: true, status: true, _count: { select: { values: true } } } }));
    if (!sub) {
      requirePermission(job.clerk, 'tally.submit');
      const png = await renderSimulatedFormPng(job.image());
      const created = await retrying(() =>
        actAs(job.clerk, () =>
          submissions.create(
            job.clerk,
            {
              electionCycleId: cycleId,
              contestId: governor!.id,
              formTemplateId: tpl[job.formNumber],
              pollingStationId: 'pollingStationId' in job.target ? job.target.pollingStationId : null,
              tallyCentreId: 'tallyCentreId' in job.target ? job.target.tallyCentreId : null,
              sourceType: 'CLERK_UPLOAD',
              idempotencyKey,
              imageQuality: 'GOOD',
              declaration: { sourceCopyNotes: `${HISTORICAL_DEMO_LABEL}: generated form image, no personal data` },
            },
            { buffer: png, mimetype: 'image/png', originalname: `simulated-${job.formNumber.toLowerCase()}-${job.key.split('|').pop()}.png`, size: png.length },
          ),
        ),
      );
      sub = { id: created.detail.id, status: created.detail.status, _count: { values: 0 } };
    }
    const id = sub.id;
    let status = sub.status as SubmissionStatus;
    if (status === 'SUBMITTED' && sub._count.values === 0) {
      requirePermission(job.clerk, 'tally.capture');
      await retrying(() => actAs(job.clerk, () => capture.save(job.clerk, id, { values: job.values })));
      status = (await actAs(job.clerk, () => capture.submitForReview(job.clerk, id))).status as SubmissionStatus;
    } else if (status === 'SUBMITTED' || status === 'DATA_ENTRY_REVIEWED' || status === 'OCR_COMPLETE') {
      status = (await actAs(job.clerk, () => capture.submitForReview(job.clerk, id))).status as SubmissionStatus;
    }
    if (job.target_status === 'VERIFIED' && status === 'SECOND_REVIEW_PENDING') {
      requirePermission(job.verifier, 'tally.verify');
      await retrying(() =>
        actAs(job.verifier, () => verification.create(job.verifier, id, { decision: 'PASS', checklist: CHECKLIST, independentValues: independentValues(job.figures), fieldComments: [] })),
      );
      status = (await read((tx) => tx.resultSubmission.findUniqueOrThrow({ where: { id }, select: { status: true } }))).status as SubmissionStatus;
    }
    return status;
  };

  const ordered = layer.stations.map((s) => s.code).sort();
  const jobs37A = ordered
    .map((code, i) => ({ code, i, plan: layer.plan.get(code)! }))
    .filter((j) => j.plan !== 'MISSING');
  const results37A = new Map(layer.results37A.map((r) => [r.stationCode, r]));
  const statuses: Record<string, number> = {};
  const bump = (s: string) => (statuses[s] = (statuses[s] ?? 0) + 1);
  let done = 0;
  await pool(jobs37A, opts.concurrency ?? 6, async ({ code, i, plan }) => {
    const r = results37A.get(code)!;
    const st = stationsByCode.get(code)!;
    const status = await processForm({
      key: `37A|${code}`,
      formNumber: '37A',
      target: { pollingStationId: stationIds.get(code)! },
      image: () => ({
        formNumber: '37A',
        identity: code,
        heading: st.name,
        subheading: `${st.wardName} ward, ${st.constituencyName} constituency, ${st.countyName} county. Station ${code} (inferred code)`,
        rows: [
          ...layer.candidates.map((c, k) => [c.displayName, r.candidateVotes[k]!] as [string, number]),
          ['Total valid votes', r.totalValidVotes],
          ['Rejected ballots', r.rejectedBallots],
          ['Total votes cast', r.totalVotesCast],
          ['Registered voters', r.registeredVoters],
        ],
      }),
      // Two stations are keyed with a wrong total so an arithmetic case holds them.
      values: figureValues(r, [
        { fieldKey: 'polling_station_code', textValue: code },
        { fieldKey: 'stamp_present', textValue: 'yes' },
        { fieldKey: 'po_signature_present', textValue: 'yes' },
      ], plan === 'DISCREPANCY' ? 10 : 0),
      target_status: plan === 'DISCREPANCY' ? 'DISCREPANCY' : plan === 'AWAITING_REVIEW' ? 'AWAITING_REVIEW' : 'VERIFIED',
      figures: r,
      clerk: clerks[i % clerks.length]!,
      verifier: verifiers[i % verifiers.length]!,
    });
    bump(status);
    if (++done % 100 === 0) log(`  37A: ${done}/${jobs37A.length}`);
  });
  statuses.MISSING_PLANNED = ordered.length - jobs37A.length;
  log(`37A: ${jobs37A.length} forms processed, ${statuses.MISSING_PLANNED} stations left missing on purpose.`);

  // 37B per constituency, then 37C for the county (all verified; consistent with the 37As).
  for (const [i, b] of layer.results37B.entries()) {
    await processForm({
      key: `37B|${b.constituencyCode}`,
      formNumber: '37B',
      target: { tallyCentreId: existingCentres.get(centreCode(b.constituencyCode))! },
      image: () => ({
        formNumber: '37B',
        identity: `${config.county.code.value}${b.constituencyCode}`,
        heading: `${b.constituencyName} constituency collation`,
        subheading: `${b.stationsCount} simulated stations, ${config.county.name.value} county`,
        rows: [...layer.candidates.map((c, k) => [c.displayName, b.candidateVotes[k]!] as [string, number]), ['Total valid votes', b.totalValidVotes], ['Rejected ballots', b.rejectedBallots], ['Total votes cast', b.totalVotesCast], ['Registered voters', b.registeredVoters]],
      }),
      values: figureValues(b, [
        { fieldKey: 'constituency_code', textValue: b.constituencyCode },
        { fieldKey: 'stations_count', numericValue: b.stationsCount },
        { fieldKey: 'stamp_present', textValue: 'yes' },
        { fieldKey: 'ro_signature_present', textValue: 'yes' },
      ]),
      target_status: 'VERIFIED',
      figures: b,
      clerk: clerks[i % clerks.length]!,
      verifier: verifiers[(i + 1) % verifiers.length]!,
    });
  }
  const c = layer.result37C;
  await processForm({
    key: `37C|${c.countyCode}`,
    formNumber: '37C',
    target: { tallyCentreId: existingCentres.get(centreCode())! },
    image: () => ({
      formNumber: '37C',
      identity: c.countyCode,
      heading: `${c.countyName} county declaration (simulated)`,
      subheading: `${c.stationsCount} simulated stations in ${layer.results37B.length} constituencies`,
      rows: [...layer.candidates.map((x, k) => [x.displayName, c.candidateVotes[k]!] as [string, number]), ['Total valid votes', c.totalValidVotes], ['Rejected ballots', c.rejectedBallots], ['Total votes cast', c.totalVotesCast], ['Registered voters', c.registeredVoters]],
    }),
    values: figureValues(c, [
      { fieldKey: 'county_code', textValue: c.countyCode },
      { fieldKey: 'stations_count', numericValue: c.stationsCount },
      { fieldKey: 'constituencies_count', numericValue: layer.results37B.length },
      { fieldKey: 'stamp_present', textValue: 'yes' },
      { fieldKey: 'ro_signature_present', textValue: 'yes' },
    ]),
    target_status: 'VERIFIED',
    figures: c,
    clerk: clerks[0]!,
    verifier: verifiers[1]!,
  });
  log(`37B: ${layer.results37B.length} constituency forms and 37C: 1 county form verified.`);

  /* ---------------------------------------- 4. Snapshot ------------------------------------- */
  const results = svc(app, ResultsService);
  let snap = await read((tx) => tx.tallySnapshot.findFirst({ where: { contestId: governor!.id, geographicUnitId: null }, orderBy: { createdAt: 'asc' }, select: { id: true } }));
  if (!snap) {
    requirePermission(as.supervisor!, 'tally.snapshot.create');
    const created = await actAs(as.supervisor!, () =>
      results.createSnapshot(
        as.supervisor!,
        CreateSnapshotSchema.parse({ electionCycleId: cycleId, contestId: governor!.id, note: `${HISTORICAL_DEMO_LABEL}: demo snapshot of the simulated governor layer` }),
      ),
    );
    snap = { id: created.id };
  }

  const verifiedStationCodes = (
    await read((tx) =>
      tx.resultSubmission.findMany({
        where: { contestId: governor!.id, formNumber: '37A', status: 'VERIFIED', isCanonical: true },
        select: { pollingStation: { select: { code: true } } },
      }),
    )
  ).map((s) => s.pollingStation!.code);

  return {
    tenantId,
    tenantSlug: slug,
    cycleId,
    governorContestId: governor!.id,
    presidentialContestId: president!.id,
    registryVersionId,
    snapshotId: snap.id,
    layer,
    statuses,
    verifiedStationCodes,
    unverified: unverifiedConfigValues(config),
  };
}

/** Registry CSV for the generated stations (same contract as any registry import). */
export function registryCsv(layer: SimulatedGovernorLayer): string {
  const cols = [
    'county_code',
    'county_name',
    'constituency_code',
    'constituency_name',
    'ward_code',
    'ward_name',
    'centre_code',
    'centre_name',
    'station_code',
    'station_name',
    'registered_voters',
    'stream_number',
    'location_source',
  ] as const;
  return toCsv(
    cols,
    layer.stations.map((s) => [
      s.countyCode,
      s.countyName,
      s.constituencyCode,
      s.constituencyName,
      s.wardCode,
      s.wardName,
      s.centreCode,
      s.centreName,
      s.code,
      s.name,
      s.registeredVoters,
      s.streamNumber,
      'SIMULATED (no real location)',
    ]),
  );
}

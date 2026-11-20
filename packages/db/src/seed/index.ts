/* eslint-disable no-console -- CLI seed script output */
/**
 * NGAO360 seed entrypoint. ALL DATA IS SYNTHETIC: organisations, people,
 * candidates, stations and figures are invented for rehearsal and testing.
 * No real voter data is ever seeded.
 *
 * Runs as the schema owner (DATABASE_URL), so RLS is bypassed. Idempotent.
 *
 *   pnpm db:seed
 *
 * Module agents may extend this by adding files under src/seed/ and calling them
 * from main() below (keep each module's seed in its own file).
 */
import argon2 from 'argon2';
import { PrismaClient, type ScopeType } from '@prisma/client';
import { SYSTEM_ROLES, type SystemRoleKey } from '@ngao360/shared';
import { provisionSystemRoles, syncPermissionCatalogue } from '../provisioning';
import { sealSecret } from '../security';
import { GOVERNOR_TEMPLATES } from './form-templates';

const prisma = new PrismaClient();

/** Demo-only TOTP secret for privileged demo users (never used outside development). */
export const DEMO_TOTP_SECRET = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';
const DEMO_PASSWORD = process.env.SEED_DEMO_PASSWORD ?? 'Demo-Password-2027';
const MFA_KEY = process.env.MFA_ENCRYPTION_KEY;

interface DemoUser {
  email: string;
  displayName: string;
  roles: Array<{ key: SystemRoleKey; scope?: { type: ScopeType; unitKey?: string; stationKey?: string } }>;
}

async function upsertTenant(slug: string, name: string, type: 'PLATFORM' | 'CAMPAIGN') {
  return prisma.tenant.upsert({
    where: { slug },
    create: { slug, name, displayName: name, type },
    update: { name, type },
  });
}

async function upsertUser(tenantId: string, u: DemoUser, passwordHash: string) {
  return prisma.user.upsert({
    where: { tenantId_email: { tenantId, email: u.email } },
    create: {
      tenantId,
      email: u.email,
      displayName: u.displayName,
      passwordHash,
      status: 'ACTIVE',
      passwordChangedAt: new Date(),
    },
    update: { displayName: u.displayName, passwordHash, status: 'ACTIVE', failedLoginCount: 0, lockedUntil: null },
  });
}

async function ensureDemoMfa(tenantId: string, userId: string) {
  if (!MFA_KEY || process.env.NODE_ENV === 'production') return false;
  const existing = await prisma.mfaFactor.findFirst({ where: { tenantId, userId, status: 'ACTIVE' } });
  if (!existing) {
    await prisma.mfaFactor.create({
      data: {
        tenantId,
        userId,
        type: 'TOTP',
        status: 'ACTIVE',
        label: 'Demo authenticator (synthetic)',
        secretEncrypted: sealSecret(DEMO_TOTP_SECRET, MFA_KEY),
        verifiedAt: new Date(),
      },
    });
  }
  await prisma.user.update({ where: { id: userId }, data: { mfaEnabled: true } });
  return true;
}

async function seedGeography(tenantId: string, cycleId: string, registryVersionId: string) {
  const units = new Map<string, string>();
  const stations = new Map<string, string>();
  const sourceVersion = 'SYNTHETIC-2027-R1';

  const mkUnit = async (
    key: string,
    type: 'COUNTY' | 'CONSTITUENCY' | 'WARD' | 'POLLING_CENTRE',
    code: string,
    name: string,
    parentKey: string | null,
  ) => {
    const parentId = parentKey ? units.get(parentKey)! : null;
    const parent = parentId ? await prisma.geographicUnit.findUniqueOrThrow({ where: { id: parentId } }) : null;
    const unit = await prisma.geographicUnit.upsert({
      where: {
        tenantId_electionCycleId_type_officialCode_sourceVersion: {
          tenantId,
          electionCycleId: cycleId,
          type,
          officialCode: code,
          sourceVersion,
        },
      },
      create: {
        tenantId,
        electionCycleId: cycleId,
        registryVersionId,
        type,
        officialCode: code,
        officialName: name,
        parentId,
        path: '/',
        sourceVersion,
      },
      update: { officialName: name, parentId, registryVersionId },
    });
    const path = `${parent ? parent.path : '/'}${unit.id}/`;
    await prisma.geographicUnit.update({ where: { id: unit.id }, data: { path } });
    units.set(key, unit.id);
    return unit.id;
  };

  // County name/code are public reference data; everything below is synthetic.
  const countyId = await mkUnit('county', 'COUNTY', '039', 'Bungoma', null);
  const constituencies = [
    { key: 'c1', code: 'SYN-C01', name: 'Synthetic Constituency North' },
    { key: 'c2', code: 'SYN-C02', name: 'Synthetic Constituency South' },
  ];
  let stationIndex = 0;
  for (const c of constituencies) {
    const constituencyId = await mkUnit(c.key, 'CONSTITUENCY', c.code, c.name, 'county');
    for (let w = 1; w <= 2; w++) {
      const wardKey = `${c.key}w${w}`;
      const wardId = await mkUnit(wardKey, 'WARD', `${c.code}-W0${w}`, `${c.name.replace('Synthetic Constituency ', '')} Ward ${w} (synthetic)`, c.key);
      for (let p = 1; p <= 2; p++) {
        const centreKey = `${wardKey}p${p}`;
        const centreCode = `${c.code}-W0${w}-P0${p}`;
        const centreId = await mkUnit(centreKey, 'POLLING_CENTRE', centreCode, `Synthetic Primary School ${c.key.toUpperCase()}${w}${p}`, wardKey);
        for (let s = 1; s <= 2; s++) {
          stationIndex++;
          const code = `${centreCode}-S0${s}`;
          const station = await prisma.pollingStation.upsert({
            where: { tenantId_registryVersionId_code: { tenantId, registryVersionId, code } },
            create: {
              tenantId,
              electionCycleId: cycleId,
              registryVersionId,
              geographicUnitId: centreId,
              countyId,
              constituencyId,
              wardId,
              pollingCentreId: centreId,
              code,
              name: `Synthetic Primary School ${c.key.toUpperCase()}${w}${p} — Stream ${s}`,
              streamNumber: s,
              registeredVoters: 380 + ((stationIndex * 37) % 220),
              locationSource: 'synthetic',
            },
            update: { geographicUnitId: centreId, countyId, constituencyId, wardId, pollingCentreId: centreId },
          });
          stations.set(`s${stationIndex}`, station.id);
        }
      }
    }
  }
  await prisma.registryVersion.update({
    where: { id: registryVersionId },
    data: { stationCount: stations.size },
  });
  return { units, stations, countyId };
}

async function main() {
  console.log('Seeding NGAO360 (synthetic data only)…');
  const passwordHash = await argon2.hash(DEMO_PASSWORD, { type: argon2.argon2id });

  const permissionCount = await syncPermissionCatalogue(prisma);
  console.log(`  permissions: ${permissionCount}`);

  /* ------------------------------ Platform tenant ----------------------------- */
  const platform = await upsertTenant('platform', 'NGAO360 Platform Operations', 'PLATFORM');
  const platformRoles = await provisionSystemRoles(prisma, platform.id);
  const operator = await upsertUser(
    platform.id,
    { email: 'operator@platform.example.org', displayName: 'Platform Operator (synthetic)', roles: [] },
    passwordHash,
  );
  await prisma.roleAssignment.deleteMany({ where: { userId: operator.id } });
  await prisma.roleAssignment.create({
    data: { tenantId: platform.id, userId: operator.id, roleId: platformRoles.PLATFORM_OPERATOR!, reason: 'Seed' },
  });
  await ensureDemoMfa(platform.id, operator.id);

  /* -------------------------------- Demo tenant ------------------------------- */
  const tenant = await upsertTenant('demo', 'Demo Campaign Organisation (synthetic)', 'CAMPAIGN');
  const roleIds = await provisionSystemRoles(prisma, tenant.id);

  const cycle = await prisma.electionCycle.upsert({
    where: { tenantId_name: { tenantId: tenant.id, name: '2027 General Election rehearsal (synthetic)' } },
    create: {
      tenantId: tenant.id,
      name: '2027 General Election rehearsal (synthetic)',
      electionDate: new Date('2027-08-10T00:00:00Z'),
      jurisdiction: 'Kenya',
      legalConfigVersion: 'LN72-2017-baseline',
      status: 'ACTIVE',
      dataProvenance: 'SYNTHETIC',
      officialSources: [
        {
          title: 'Elections (General) (Amendment) Regulations, 2017 — Legal Notice No. 72 of 2017',
          reference: 'Baseline; must be revalidated against 2027 IEBC forms',
        },
      ],
    },
    update: { status: 'ACTIVE', dataProvenance: 'SYNTHETIC' },
  });

  const registry = await prisma.registryVersion.upsert({
    where: { tenantId_electionCycleId_version: { tenantId: tenant.id, electionCycleId: cycle.id, version: 'SYNTHETIC-2027-R1' } },
    create: {
      tenantId: tenant.id,
      electionCycleId: cycle.id,
      version: 'SYNTHETIC-2027-R1',
      source: 'Synthetic rehearsal registry generated by seed (not real IEBC data)',
      status: 'APPROVED',
      approvedAt: new Date(),
    },
    update: { status: 'APPROVED' },
  });

  const geo = await seedGeography(tenant.id, cycle.id, registry.id);
  console.log(`  geography: ${geo.units.size} units, ${geo.stations.size} stations`);

  // Tally centres
  for (const [key, level, code, name] of [
    ['c1', 'CONSTITUENCY', 'TC-SYN-C01', 'Synthetic Constituency North tallying centre'],
    ['c2', 'CONSTITUENCY', 'TC-SYN-C02', 'Synthetic Constituency South tallying centre'],
    ['county', 'COUNTY', 'TC-039', 'Bungoma county tallying centre (synthetic)'],
  ] as const) {
    await prisma.tallyCentre.upsert({
      where: { tenantId_electionCycleId_code: { tenantId: tenant.id, electionCycleId: cycle.id, code } },
      create: { tenantId: tenant.id, electionCycleId: cycle.id, level, code, name, geographicUnitId: geo.units.get(key)! },
      update: { name, geographicUnitId: geo.units.get(key)! },
    });
  }

  // Governor contest + synthetic candidates
  let contest = await prisma.contest.findFirst({
    where: { tenantId: tenant.id, electionCycleId: cycle.id, officeType: 'GOVERNOR', geographicUnitId: geo.countyId },
  });
  if (!contest) {
    contest = await prisma.contest.create({
      data: {
        tenantId: tenant.id,
        electionCycleId: cycle.id,
        officeType: 'GOVERNOR',
        name: 'County Governor — Bungoma (synthetic rehearsal)',
        geographicUnitId: geo.countyId,
        formSeries: '37',
        status: 'ACTIVE',
      },
    });
  }
  const candidates = [
    ['Amani Synthetic Wekesa', 'Party Alpha (synthetic)'],
    ['Baraka Synthetic Nanjala', 'Party Beta (synthetic)'],
    ['Chanya Synthetic Wafula', null],
    ['Dalili Synthetic Simiyu', 'Party Gamma (synthetic)'],
  ] as const;
  for (const [i, [name, party]] of candidates.entries()) {
    await prisma.candidateReference.upsert({
      where: { tenantId_contestId_ballotOrder: { tenantId: tenant.id, contestId: contest.id, ballotOrder: i + 1 } },
      create: {
        tenantId: tenant.id,
        contestId: contest.id,
        ballotOrder: i + 1,
        candidateNameAsPublished: name,
        partyLabel: party,
        isIndependent: party === null,
        source: 'Synthetic rehearsal candidate list',
      },
      update: { candidateNameAsPublished: name, partyLabel: party, isIndependent: party === null },
    });
  }

  /* ----------------------------------- Users ---------------------------------- */
  const demoUsers: DemoUser[] = [
    { email: 'owner@demo.example.org', displayName: 'Olive Owner (synthetic)', roles: [{ key: 'ORGANISATION_OWNER' }] },
    { email: 'director@demo.example.org', displayName: 'Daniel Director (synthetic)', roles: [{ key: 'CAMPAIGN_DIRECTOR' }] },
    { email: 'supervisor@demo.example.org', displayName: 'Sarah Supervisor (synthetic)', roles: [{ key: 'TALLY_SUPERVISOR' }] },
    { email: 'verifier@demo.example.org', displayName: 'Victor Verifier (synthetic)', roles: [{ key: 'RESULTS_VERIFIER' }] },
    { email: 'verifier.north@demo.example.org', displayName: 'Vera Verifier North (synthetic)', roles: [{ key: 'RESULTS_VERIFIER', scope: { type: 'CONSTITUENCY', unitKey: 'c1' } }] },
    { email: 'clerk@demo.example.org', displayName: 'Clara Clerk (synthetic)', roles: [{ key: 'DATA_ENTRY_CLERK' }] },
    { email: 'clerk2@demo.example.org', displayName: 'Cyrus Clerk (synthetic)', roles: [{ key: 'DATA_ENTRY_CLERK' }] },
    { email: 'agent1@demo.example.org', displayName: 'Agnes Agent (synthetic)', roles: [{ key: 'POLLING_AGENT', scope: { type: 'POLLING_STATION', stationKey: 's1' } }] },
    { email: 'agent2@demo.example.org', displayName: 'Arthur Agent (synthetic)', roles: [{ key: 'POLLING_AGENT', scope: { type: 'POLLING_STATION', stationKey: 's2' } }] },
    { email: 'legal@demo.example.org', displayName: 'Lena Legal (synthetic)', roles: [{ key: 'LEGAL_COMPLIANCE_OFFICER' }] },
    { email: 'ops@demo.example.org', displayName: 'Oscar Operations (synthetic)', roles: [{ key: 'OPERATIONS_DIRECTOR' }] },
    { email: 'comms@demo.example.org', displayName: 'Cora Comms (synthetic)', roles: [{ key: 'COMMUNICATIONS_EDITOR' }] },
  ];
  const mfaRoles = new Set(SYSTEM_ROLES.filter((r) => r.mfaRequired).map((r) => r.key));
  for (const u of demoUsers) {
    const user = await upsertUser(tenant.id, u, passwordHash);
    await prisma.roleAssignment.deleteMany({ where: { userId: user.id } });
    for (const r of u.roles) {
      const scopeType = r.scope?.type ?? 'ORGANISATION';
      await prisma.roleAssignment.create({
        data: {
          tenantId: tenant.id,
          userId: user.id,
          roleId: roleIds[r.key]!,
          scopeType,
          geographicUnitId: r.scope?.unitKey ? geo.units.get(r.scope.unitKey)! : null,
          pollingStationId: r.scope?.stationKey ? geo.stations.get(r.scope.stationKey)! : null,
          electionCycleId: r.scope ? cycle.id : null,
          reason: 'Seed (synthetic demo)',
        },
      });
    }
    if (u.roles.some((r) => mfaRoles.has(r.key))) await ensureDemoMfa(tenant.id, user.id);
  }
  console.log(`  demo users: ${demoUsers.length}`);

  const owner = await prisma.user.findUniqueOrThrow({
    where: { tenantId_email: { tenantId: tenant.id, email: 'owner@demo.example.org' } },
  });

  // Form templates 37A/37B/37C (approved for the synthetic rehearsal only)
  for (const t of GOVERNOR_TEMPLATES) {
    await prisma.formTemplate.upsert({
      where: {
        tenantId_electionCycleId_formNumber_version: {
          tenantId: tenant.id,
          electionCycleId: cycle.id,
          formNumber: t.formNumber,
          version: 1,
        },
      },
      create: {
        tenantId: tenant.id,
        electionCycleId: cycle.id,
        contestType: 'GOVERNOR',
        formNumber: t.formNumber,
        formLevel: t.formLevel,
        version: 1,
        title: t.title,
        effectiveDate: new Date('2027-01-01T00:00:00Z'),
        fieldSchema: t.fieldSchema,
        validationRules: t.validationRules,
        officialSource: t.officialSource,
        approvalState: 'APPROVED',
        approvedById: owner.id,
        approvedAt: new Date(),
        createdById: owner.id,
        notes: 'Approved for synthetic rehearsal only. Replace with approved 2027 IEBC form before production.',
      },
      update: {},
    });
  }
  console.log(`  form templates: ${GOVERNOR_TEMPLATES.map((t) => t.formNumber).join(', ')}`);

  /* ------------------- Second tenant (cross-tenant isolation tests) ------------------- */
  const other = await upsertTenant('other', 'Other Organisation (synthetic)', 'CAMPAIGN');
  const otherRoles = await provisionSystemRoles(prisma, other.id);
  const otherOwner = await upsertUser(
    other.id,
    { email: 'owner@other.example.org', displayName: 'Otto Owner (synthetic)', roles: [] },
    passwordHash,
  );
  await prisma.roleAssignment.deleteMany({ where: { userId: otherOwner.id } });
  await prisma.roleAssignment.create({
    data: { tenantId: other.id, userId: otherOwner.id, roleId: otherRoles.ORGANISATION_OWNER!, reason: 'Seed' },
  });
  await ensureDemoMfa(other.id, otherOwner.id);

  console.log('Done.');
  console.log(`  Login: tenant "demo", e.g. clerk@demo.example.org / ${DEMO_PASSWORD}`);
  console.log(`  Privileged demo users have TOTP secret ${DEMO_TOTP_SECRET} (development only).`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());

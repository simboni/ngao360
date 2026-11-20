/* eslint-disable no-console -- CLI seed script output */
/**
 * NGAO360 seed entrypoint. ALL DATA IS SYNTHETIC: organisations, people,
 * candidates, stations and figures are invented for rehearsal and testing.
 * Only the 47 county codes and names are real public reference data. No real
 * voter data is ever seeded.
 *
 * Runs as the schema owner (DATABASE_URL), so RLS is bypassed. Idempotent.
 *
 *   pnpm db:seed
 *
 * Environment:
 *   SEED_DEMO_PASSWORD  password for every demo user (required when NODE_ENV=production)
 *   SEED_DEMO_MFA       'disabled' (default): demo users have no authenticator; users whose
 *                       role requires MFA enrol their own at first sign-in.
 *                       'preenrolled': development only; privileged demo users share
 *                       the fixed TOTP secret below so walkthroughs can skip enrolment.
 */
import argon2 from 'argon2';
import { PrismaClient, type ScopeType } from '@prisma/client';
import { SYSTEM_ROLES, type SystemRoleKey } from '@ngao360/shared';
import { provisionSystemRoles, syncPermissionCatalogue } from '../provisioning';
import { sealSecret } from '../security';
import { seedFormTemplates } from './form-templates';
import { seedField } from './field';
import { seedOffice } from './office';
import { approveSeedRegistry, seedReferenceData } from './reference-data';

const prisma = new PrismaClient();

const IS_PRODUCTION = process.env.NODE_ENV === 'production';
/** Demo-only TOTP secret, used only with SEED_DEMO_MFA=preenrolled outside production. */
export const DEMO_TOTP_SECRET = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';
const DEMO_TOTP_LABEL = 'Demo authenticator (synthetic)';
const MFA_KEY = process.env.MFA_ENCRYPTION_KEY;
const DEMO_MFA_MODE = (process.env.SEED_DEMO_MFA ?? 'disabled').toLowerCase();

function demoPassword(): string {
  const fromEnv = process.env.SEED_DEMO_PASSWORD;
  if (fromEnv && fromEnv.length >= 12) return fromEnv;
  if (IS_PRODUCTION) throw new Error('Set SEED_DEMO_PASSWORD (at least 12 characters) to seed demo users in production');
  if (fromEnv) console.warn('  SEED_DEMO_PASSWORD is shorter than 12 characters; using it anyway (development only)');
  return fromEnv ?? 'Demo-Password-2027';
}

interface DemoUser {
  email: string;
  displayName: string;
  roles: Array<{ key: SystemRoleKey; scope?: { type: ScopeType; unitKey?: string; stationKey?: string } }>;
}

async function upsertTenant(slug: string, name: string, type: 'PLATFORM' | 'CAMPAIGN' | 'ELECTED_OFFICE') {
  return prisma.tenant.upsert({
    where: { slug },
    create: { slug, name, displayName: name, type },
    update: { name, displayName: name, type },
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

/**
 * Apply SEED_DEMO_MFA to a privileged demo user. 'disabled' removes only the
 * shared demo factor (never a factor the user enrolled themselves).
 */
async function applyDemoMfa(tenantId: string, userId: string): Promise<'preenrolled' | 'enrol-at-sign-in'> {
  if (DEMO_MFA_MODE === 'preenrolled' && MFA_KEY && !IS_PRODUCTION) {
    const existing = await prisma.mfaFactor.findFirst({ where: { tenantId, userId, status: 'ACTIVE' } });
    if (!existing) {
      await prisma.mfaFactor.create({
        data: {
          tenantId,
          userId,
          type: 'TOTP',
          status: 'ACTIVE',
          label: DEMO_TOTP_LABEL,
          secretEncrypted: sealSecret(DEMO_TOTP_SECRET, MFA_KEY),
          verifiedAt: new Date(),
        },
      });
    }
    await prisma.user.update({ where: { id: userId }, data: { mfaEnabled: true } });
    return 'preenrolled';
  }
  await prisma.mfaFactor.updateMany({
    where: { tenantId, userId, label: DEMO_TOTP_LABEL, status: { in: ['ACTIVE', 'PENDING'] } },
    data: { status: 'REVOKED' },
  });
  const remaining = await prisma.mfaFactor.count({ where: { tenantId, userId, status: 'ACTIVE' } });
  if (remaining === 0) await prisma.user.update({ where: { id: userId }, data: { mfaEnabled: false } });
  return 'enrol-at-sign-in';
}

async function main() {
  console.log('Seeding NGAO360 (synthetic data only)…');
  const password = demoPassword();
  const passwordHash = await argon2.hash(password, { type: argon2.argon2id });
  const mfaRoles = new Set(SYSTEM_ROLES.filter((r) => r.mfaRequired).map((r) => r.key));

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
  await applyDemoMfa(platform.id, operator.id);

  /* -------------------------------- Demo tenant ------------------------------- */
  const tenant = await upsertTenant('demo', 'Demo Organisation', 'CAMPAIGN');
  const roleIds = await provisionSystemRoles(prisma, tenant.id);
  const ref = await seedReferenceData(prisma, tenant.id);
  console.log(
    `  reference: cycle "2027 General Election" (10 Aug 2027, SYNTHETIC), ${ref.counties} counties, ` +
      `${ref.units.size - 1} synthetic Bungoma units, ${ref.stations.size} synthetic stations`,
  );

  /* ----------------------------------- Users ---------------------------------- */
  // One demo user per tenant role (blueprint section 3). The platform operator lives in the platform tenant.
  const demoUsers: DemoUser[] = [
    { email: 'owner@demo.example.org', displayName: 'Olive Owner (synthetic)', roles: [{ key: 'ORGANISATION_OWNER' }] },
    { email: 'director@demo.example.org', displayName: 'Daniel Director (synthetic)', roles: [{ key: 'CAMPAIGN_DIRECTOR' }] },
    { email: 'ops@demo.example.org', displayName: 'Oscar Operations (synthetic)', roles: [{ key: 'OPERATIONS_DIRECTOR' }] },
    { email: 'lead@demo.example.org', displayName: 'Dora Department Lead (synthetic)', roles: [{ key: 'DEPARTMENT_LEAD' }] },
    { email: 'coordinator@demo.example.org', displayName: 'Cosmas Coordinator North (synthetic)', roles: [{ key: 'COORDINATOR', scope: { type: 'CONSTITUENCY', unitKey: 'c1' } }] },
    { email: 'agent1@demo.example.org', displayName: 'Agnes Agent (synthetic)', roles: [{ key: 'POLLING_AGENT', scope: { type: 'POLLING_STATION', stationKey: 's1' } }] },
    { email: 'agent2@demo.example.org', displayName: 'Arthur Agent (synthetic)', roles: [{ key: 'POLLING_AGENT', scope: { type: 'POLLING_STATION', stationKey: 's2' } }] },
    { email: 'clerk@demo.example.org', displayName: 'Clara Clerk (synthetic)', roles: [{ key: 'DATA_ENTRY_CLERK' }] },
    { email: 'clerk2@demo.example.org', displayName: 'Cyrus Clerk (synthetic)', roles: [{ key: 'DATA_ENTRY_CLERK' }] },
    { email: 'verifier@demo.example.org', displayName: 'Victor Verifier (synthetic)', roles: [{ key: 'RESULTS_VERIFIER' }] },
    { email: 'verifier.north@demo.example.org', displayName: 'Vera Verifier North (synthetic)', roles: [{ key: 'RESULTS_VERIFIER', scope: { type: 'CONSTITUENCY', unitKey: 'c1' } }] },
    { email: 'supervisor@demo.example.org', displayName: 'Sarah Supervisor (synthetic)', roles: [{ key: 'TALLY_SUPERVISOR' }] },
    { email: 'finance@demo.example.org', displayName: 'Fiona Finance (synthetic)', roles: [{ key: 'FINANCE_OFFICER' }] },
    { email: 'legal@demo.example.org', displayName: 'Lena Legal (synthetic)', roles: [{ key: 'LEGAL_COMPLIANCE_OFFICER' }] },
    { email: 'comms@demo.example.org', displayName: 'Cora Comms (synthetic)', roles: [{ key: 'COMMUNICATIONS_EDITOR' }] },
  ];
  for (const u of demoUsers) {
    const user = await upsertUser(tenant.id, u, passwordHash);
    await prisma.roleAssignment.deleteMany({ where: { userId: user.id } });
    for (const r of u.roles) {
      const roleId = roleIds[r.key];
      if (!roleId) throw new Error(`System role ${r.key} is not provisioned`);
      const scopeType = r.scope?.type ?? 'ORGANISATION';
      await prisma.roleAssignment.create({
        data: {
          tenantId: tenant.id,
          userId: user.id,
          roleId,
          scopeType,
          geographicUnitId: r.scope?.unitKey ? ref.units.get(r.scope.unitKey)! : null,
          pollingStationId: r.scope?.stationKey ? ref.stations.get(r.scope.stationKey)! : null,
          electionCycleId: r.scope ? ref.cycleId : null,
          reason: 'Seed (synthetic demo)',
        },
      });
    }
    if (u.roles.some((r) => mfaRoles.has(r.key))) await applyDemoMfa(tenant.id, user.id);
  }
  console.log(`  demo users: ${demoUsers.length}`);

  const owner = await prisma.user.findUniqueOrThrow({ where: { tenantId_email: { tenantId: tenant.id, email: 'owner@demo.example.org' } } });
  const legal = await prisma.user.findUniqueOrThrow({ where: { tenantId_email: { tenantId: tenant.id, email: 'legal@demo.example.org' } } });

  // Registry source metadata names the approving user (blueprint 6.2).
  await approveSeedRegistry(prisma, tenant.id, ref.registryVersionId, owner.id);

  // Form templates: owner configures, legal officer approves (maker-checker).
  const templates = await seedFormTemplates(prisma, {
    tenantId: tenant.id,
    electionCycleId: ref.cycleId,
    creatorId: owner.id,
    approverId: legal.id,
  });
  console.log(
    `  form templates: ${templates.created.length ? `created ${templates.created.join(', ')}` : 'no changes'}` +
      (templates.unchanged ? ` (${templates.unchanged} unchanged)` : ''),
  );

  /* ---------- Field and election operations (demo tenant, synthetic Bungoma) ---------- */
  await seedField(prisma, {
    tenantId: tenant.id,
    ref,
    roleIds,
    passwordHash,
    mfaRoles,
    applyDemoMfa: (tenantId, userId) => applyDemoMfa(tenantId, userId),
  });

  /* ------------- NGAO360 Office: synthetic County Governor's office (Bungoma) ------------- */
  await seedOffice(prisma, {
    passwordHash,
    mfaRoles,
    applyDemoMfa: (tenantId, userId) => applyDemoMfa(tenantId, userId),
  });

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
  await applyDemoMfa(other.id, otherOwner.id);

  console.log('Done.');
  console.log(`  Sign in: organisation "demo", e.g. clerk@demo.example.org with SEED_DEMO_PASSWORD${process.env.SEED_DEMO_PASSWORD ? '' : ' (default Demo-Password-2027)'}`);
  if (DEMO_MFA_MODE === 'preenrolled' && !IS_PRODUCTION) {
    console.log(`  Privileged demo users share the development TOTP secret ${DEMO_TOTP_SECRET}.`);
  } else {
    console.log('  Demo MFA is disabled: users whose role requires MFA enrol an authenticator at first sign-in.');
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());

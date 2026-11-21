/**
 * First platform-operator account for a fresh production install (docs/DEPLOYMENT.md §5).
 *
 * Demo accounts come only from the development seed, and every other account is invited by someone
 * already signed in, so a new install needs one account created from the server itself. This creates
 * (or refreshes) the platform organisation and its system roles, and an INVITED platform operator with a
 * single-use invitation token. The person opens the link, sets their own password and enrols MFA at
 * first sign-in. No password is ever chosen or printed here.
 *
 * Refuses when an ACTIVE platform operator already exists: further operators are invited from the app,
 * and a lost operator account is recovered with two-person account recovery.
 */
import { randomBytes } from 'node:crypto';
import { canonicalJson, hashJson, type PrismaClient, provisionSystemRoles, sha256Hex, syncPermissionCatalogue } from '@ngao360/db';

export const PLATFORM_SLUG = 'platform';
export const PLATFORM_OPERATOR_ROLE = 'PLATFORM_OPERATOR';

export interface BootstrapInput {
  email: string;
  displayName: string;
  ttlHours: number;
  now?: Date;
  /** Organisation code of the platform organisation (tests only; production uses `platform`). */
  tenantSlug?: string;
}

export type BootstrapResult =
  | { status: 'invited'; tenantSlug: string; userId: string; token: string; expiresAt: Date; acceptPath: string; reissued: boolean }
  | { status: 'refused'; reason: 'ACTIVE_OPERATOR_EXISTS' };

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function validateBootstrapInput(input: BootstrapInput): string | null {
  if (!EMAIL.test(input.email)) return 'A valid --email is required';
  if (input.displayName.trim().length < 2) return 'A --name of at least 2 characters is required';
  if (!Number.isInteger(input.ttlHours) || input.ttlHours < 1 || input.ttlHours > 168) return 'The invitation lifetime must be 1 to 168 hours';
  return null;
}

export async function bootstrapPlatformOperator(db: PrismaClient, input: BootstrapInput): Promise<BootstrapResult> {
  const problem = validateBootstrapInput(input);
  if (problem) throw new Error(problem);
  const email = input.email.trim().toLowerCase();
  const displayName = input.displayName.trim();
  const now = input.now ?? new Date();
  const slug = input.tenantSlug ?? PLATFORM_SLUG;

  await syncPermissionCatalogue(db);
  const tenant = await db.tenant.upsert({
    where: { slug },
    create: { slug, name: 'NGAO360 Platform Operations', displayName: 'NGAO360 Platform Operations', type: 'PLATFORM' },
    update: {},
  });
  if (tenant.type !== 'PLATFORM') throw new Error(`Organisation "${slug}" exists but is not the platform organisation`);
  const roles = await provisionSystemRoles(db, tenant.id);
  const roleId = roles[PLATFORM_OPERATOR_ROLE];
  if (!roleId) throw new Error('The platform operator role is missing from the role catalogue');

  const activeOperator = await db.roleAssignment.findFirst({
    where: { tenantId: tenant.id, roleId, revokedAt: null, user: { status: 'ACTIVE' } },
    select: { id: true },
  });
  if (activeOperator) return { status: 'refused', reason: 'ACTIVE_OPERATOR_EXISTS' };

  const token = randomBytes(32).toString('base64url');
  const tokenHash = sha256Hex(token);
  const expiresAt = new Date(now.getTime() + input.ttlHours * 3_600_000);

  const existing = await db.user.findUnique({ where: { tenantId_email: { tenantId: tenant.id, email } } });
  if (existing && existing.status !== 'INVITED') {
    throw new Error(`An account for ${email} already exists in the platform organisation with status ${existing.status}; use account recovery instead`);
  }
  const user = existing
    ? await db.user.update({ where: { id: existing.id }, data: { displayName, invitationTokenHash: tokenHash, invitationExpiresAt: expiresAt } })
    : await db.user.create({ data: { tenantId: tenant.id, email, displayName, status: 'INVITED', invitationTokenHash: tokenHash, invitationExpiresAt: expiresAt } });

  const hasRole = await db.roleAssignment.findFirst({ where: { tenantId: tenant.id, userId: user.id, roleId, revokedAt: null }, select: { id: true } });
  if (!hasRole) {
    await db.roleAssignment.create({ data: { tenantId: tenant.id, userId: user.id, roleId, reason: 'Bootstrap of the first platform operator from the server' } });
  }

  // Audit, built the same way as AuditService.buildEvent (SYSTEM actor, no request metadata).
  const after = { email, displayName, role: PLATFORM_OPERATOR_ROLE, invitationExpiresAt: expiresAt.toISOString(), reissued: !!existing };
  const core = {
    tenantId: tenant.id,
    actorId: null,
    actorType: 'SYSTEM' as const,
    action: 'platform.operator.bootstrap',
    entityType: 'User',
    entityId: user.id,
    beforeHash: hashJson(null),
    afterHash: hashJson(after),
    reason: 'First platform operator created from the server command line',
    requestId: null,
    occurredAt: now.toISOString(),
  };
  await db.auditEvent.create({
    data: { ...core, occurredAt: now, before: undefined, after, eventHash: sha256Hex(canonicalJson(core)) },
  });

  return {
    status: 'invited',
    tenantSlug: tenant.slug,
    userId: user.id,
    token,
    expiresAt,
    acceptPath: `/accept-invitation#token=${token}`,
    reissued: !!existing,
  };
}

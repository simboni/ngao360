/**
 * First platform-operator bootstrap (apps/api/src/cli/bootstrap-operator): a fresh install gets one
 * invited operator from the server, the token is single-use material stored only as a hash, re-running
 * before acceptance re-issues the link, and once an active operator exists the command refuses.
 */
import { randomUUID } from 'node:crypto';
import { createPrismaClient, type PrismaClient, sha256Hex } from '@ngao360/db';
import { bootstrapPlatformOperator, validateBootstrapInput } from '../src/cli/bootstrap-operator/bootstrap';

const OWNER_URL = process.env.TEST_DATABASE_URL;
const APP_URL = process.env.TEST_APP_DATABASE_URL;
const d = OWNER_URL && APP_URL ? describe : describe.skip;

describe('bootstrap input validation', () => {
  it('needs an e-mail, a name and a sane lifetime', () => {
    expect(validateBootstrapInput({ email: 'nope', displayName: 'Op', ttlHours: 72 })).toMatch(/email/);
    expect(validateBootstrapInput({ email: 'op@ngao360.co.ke', displayName: ' ', ttlHours: 72 })).toMatch(/name/);
    expect(validateBootstrapInput({ email: 'op@ngao360.co.ke', displayName: 'Op', ttlHours: 0 })).toMatch(/lifetime/);
    expect(validateBootstrapInput({ email: 'op@ngao360.co.ke', displayName: 'Op', ttlHours: 72 })).toBeNull();
  });
});

d('bootstrapPlatformOperator (DB)', () => {
  let db: PrismaClient;
  const slug = `platform-bootstrap-${randomUUID().slice(0, 8)}`;
  const email = `first.operator.${randomUUID().slice(0, 6)}@ngao360.example`;

  beforeAll(() => {
    db = createPrismaClient({ url: OWNER_URL!, log: [] });
  });
  afterAll(async () => {
    await db.$disconnect();
  });

  it('creates the platform organisation and an invited operator with a hashed single-use token', async () => {
    const now = new Date('2026-11-22T08:00:00Z');
    const r = await bootstrapPlatformOperator(db, { email: email.toUpperCase(), displayName: 'First Operator', ttlHours: 48, now, tenantSlug: slug });
    expect(r.status).toBe('invited');
    if (r.status !== 'invited') return;
    expect(r.reissued).toBe(false);
    expect(r.acceptPath).toBe(`/accept-invitation#token=${r.token}`);
    expect(r.expiresAt.toISOString()).toBe('2026-11-24T08:00:00.000Z');

    const tenant = await db.tenant.findUniqueOrThrow({ where: { slug } });
    expect(tenant.type).toBe('PLATFORM');
    const user = await db.user.findUniqueOrThrow({ where: { id: r.userId } });
    expect(user.email).toBe(email); // normalised to lower case
    expect(user.status).toBe('INVITED');
    expect(user.passwordHash).toBeNull(); // the person sets their own password
    expect(user.invitationTokenHash).toBe(sha256Hex(r.token));
    expect(JSON.stringify(user)).not.toContain(r.token);

    const assignment = await db.roleAssignment.findFirstOrThrow({ where: { userId: user.id, revokedAt: null }, include: { role: true } });
    expect(assignment.role.key).toBe('PLATFORM_OPERATOR');

    const audit = await db.auditEvent.findFirstOrThrow({ where: { tenantId: tenant.id, action: 'platform.operator.bootstrap', entityId: user.id } });
    expect(audit.actorType).toBe('SYSTEM');
    expect(JSON.stringify(audit, (_k, v: unknown) => (typeof v === 'bigint' ? v.toString() : v))).not.toContain(r.token);
  });

  it('re-issues a fresh link while the invitation is unused, invalidating the old one', async () => {
    const first = await db.user.findFirstOrThrow({ where: { tenant: { slug }, email } });
    const r = await bootstrapPlatformOperator(db, { email, displayName: 'First Operator', ttlHours: 72, tenantSlug: slug });
    expect(r.status).toBe('invited');
    if (r.status !== 'invited') return;
    expect(r.reissued).toBe(true);
    const after = await db.user.findUniqueOrThrow({ where: { id: first.id } });
    expect(after.invitationTokenHash).toBe(sha256Hex(r.token));
    expect(after.invitationTokenHash).not.toBe(first.invitationTokenHash);
    expect(await db.roleAssignment.count({ where: { userId: first.id, revokedAt: null } })).toBe(1);
  });

  it('refuses once an active platform operator exists, for the same or another e-mail', async () => {
    const user = await db.user.findFirstOrThrow({ where: { tenant: { slug }, email } });
    await db.user.update({ where: { id: user.id }, data: { status: 'ACTIVE', invitationTokenHash: null, invitationExpiresAt: null } });
    await expect(bootstrapPlatformOperator(db, { email, displayName: 'First Operator', ttlHours: 72, tenantSlug: slug })).resolves.toEqual({ status: 'refused', reason: 'ACTIVE_OPERATOR_EXISTS' });
    await expect(bootstrapPlatformOperator(db, { email: `other.${email}`, displayName: 'Second', ttlHours: 72, tenantSlug: slug })).resolves.toEqual({ status: 'refused', reason: 'ACTIVE_OPERATOR_EXISTS' });
    expect(await db.user.count({ where: { tenant: { slug } } })).toBe(1);
  });

  it('refuses to reuse a slug that belongs to a non-platform organisation', async () => {
    const other = `campaign-${randomUUID().slice(0, 8)}`;
    await db.tenant.create({ data: { slug: other, name: 'Not platform', type: 'CAMPAIGN' } });
    await expect(bootstrapPlatformOperator(db, { email, displayName: 'Op', ttlHours: 72, tenantSlug: other })).rejects.toThrow(/not the platform organisation/);
  });
});

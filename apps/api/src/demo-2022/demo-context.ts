/**
 * Shared plumbing for the 2022 historical demo command-line tools
 * (pnpm demo:2022-bungoma, pnpm demo:import-34a, pnpm demo:redact-34a).
 *
 * The tools never fetch anything from the network. They boot the API's own
 * Nest application context (no HTTP listener) and call the same services the
 * HTTP endpoints use, acting as a named user of the target organisation, so
 * intake, SHA-256 storage, duplicate detection, maker-checker approvals,
 * separation of duties and audit all apply exactly as through the API. The
 * route guard is not in the path, so each step first checks the acting user's
 * permission itself (`requirePermission`).
 */
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import type { INestApplicationContext, Type } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { MFA_REQUIRING_PERMISSIONS, type PermissionKey } from '@ngao360/shared';
import type { AuthContext } from '../auth/auth.types';
import { RequestContext } from '../common/context/request-context';
import { AppException } from '../common/http/app-exception';
import { PrismaService } from '../prisma/prisma.service';
import { PermissionService } from '../rbac/permission.service';

export const DEMO_CLI_USER_AGENT = 'ngao360-demo-cli (local operator)';

/** Background jobs are off: the tools run one unit of work and exit. */
export function demoCliEnvironment(): void {
  process.env.QUEUES_ENABLED = 'false';
  process.env.OCR_PROVIDER ??= 'none';
  process.env.OFFICE_RETENTION_INTERVAL_MINUTES ??= '0';
  process.env.FIELD_WARROOM_RECORD_SECONDS ??= '0';
  process.env.FIELD_WARROOM_CACHE_SECONDS ??= '0';
}

export async function createDemoAppContext(): Promise<INestApplicationContext> {
  demoCliEnvironment();
  // Imported only now: module wiring reads QUEUES_ENABLED when the module file loads.
  const { AppModule } = await import('../app.module');
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error', 'warn'] });
  await app.init();
  return app;
}

export function svc<T>(app: INestApplicationContext, type: Type<T>): T {
  return app.get(type, { strict: false });
}

/**
 * Build the AuthContext of a user of the tenant from their live role
 * assignments (same loader as the request guard). The tool is a local
 * operator action, so it counts as a completed MFA and re-authentication.
 */
export async function authFor(app: INestApplicationContext, tenantId: string, email: string): Promise<AuthContext> {
  const prisma = svc(app, PrismaService);
  const permissions = svc(app, PermissionService);
  return prisma.withTenant(tenantId, async (tx) => {
    const user = await tx.user.findFirst({ where: { email: email.toLowerCase() }, select: { id: true, email: true, displayName: true, status: true } });
    if (!user || user.status !== 'ACTIVE') throw new Error(`No active user ${email} in this organisation`);
    const { grants, roles, roleRequiresMfa } = await permissions.loadGrants(tx, user.id);
    const keys = new Set<PermissionKey>(grants.map((g) => g.permission));
    return {
      userId: user.id,
      tenantId,
      sessionId: randomUUID(),
      email: user.email,
      displayName: user.displayName,
      mfaVerified: true,
      mfaRequired: roleRequiresMfa || [...keys].some((p) => MFA_REQUIRING_PERMISSIONS.has(p)),
      reauthAt: Math.floor(Date.now() / 1000),
      roles,
      permissions: keys,
      grants,
    };
  });
}

/** Run `fn` as `auth` (request context for tenant transactions and audit metadata). */
export function actAs<T>(auth: AuthContext, fn: () => Promise<T>): Promise<T> {
  return RequestContext.run({ requestId: randomUUID(), ip: null, userAgent: DEMO_CLI_USER_AGENT, auth }, fn);
}

/** The permission check the route guard would make (the tools call services directly). */
export function requirePermission(auth: AuthContext, ...keys: PermissionKey[]): void {
  const missing = keys.filter((k) => !auth.permissions.has(k));
  if (missing.length) throw AppException.forbidden(`${auth.email} lacks ${missing.join(', ')}`, { required: missing });
}

export async function resolveTenant(app: INestApplicationContext, slug: string): Promise<{ id: string; slug: string; historicalDemo: boolean }> {
  const prisma = svc(app, PrismaService);
  const t = await prisma.client.tenant.findUnique({ where: { slug }, select: { id: true, slug: true, historicalDemo: true } });
  if (!t) throw new Error(`No organisation with code "${slug}"`);
  return t;
}

/** Minimal `--flag value` / `--switch` parser for the CLIs. */
export function parseArgs(argv: readonly string[]): Map<string, string | true> {
  const out = new Map<string, string | true>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--') continue;
    if (!a.startsWith('--')) throw new Error(`Unexpected argument "${a}"`);
    const [k, inline] = a.slice(2).split('=', 2) as [string, string | undefined];
    if (inline !== undefined) out.set(k, inline);
    else if (argv[i + 1] !== undefined && !argv[i + 1]!.startsWith('--')) out.set(k, argv[++i]!);
    else out.set(k, true);
  }
  return out;
}

/** Run a bounded number of async jobs at once, preserving result order. */
export async function pool<T, R>(items: readonly T[], size: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(size, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!, i);
    }
  });
  await Promise.all(workers);
  return out;
}

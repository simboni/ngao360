/**
 * @ngao360/db: Prisma client and tenant-scoped transaction helpers.
 *
 * Row-level security: every tenant-owned table has a policy comparing
 * `tenant_id` with the transaction-local setting `app.tenant_id`. The runtime
 * API connects as the non-owner role `ngao_app` (APP_DATABASE_URL) so policies
 * are enforced; migrations and seed run as the schema owner (DATABASE_URL).
 */
import { Prisma, PrismaClient } from '@prisma/client';

export * from '@prisma/client';

/** Postgres setting read by RLS policies. */
export const TENANT_SETTING = 'app.tenant_id';

export type TenantTx = Prisma.TransactionClient;

export interface CreateClientOptions {
  url?: string;
  log?: Prisma.LogLevel[];
}

export function createPrismaClient(opts: CreateClientOptions = {}): PrismaClient {
  return new PrismaClient({
    ...(opts.url ? { datasources: { db: { url: opts.url } } } : {}),
    log: opts.log ?? ['warn', 'error'],
  });
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Run `fn` inside a transaction with `app.tenant_id` set (transaction-local), so
 * RLS policies restrict every statement to the tenant. Always use this for
 * tenant-owned data access in the API.
 */
export async function withTenant<T>(
  client: PrismaClient,
  tenantId: string,
  fn: (tx: TenantTx) => Promise<T>,
  options?: { isolationLevel?: Prisma.TransactionIsolationLevel; timeout?: number; maxWait?: number },
): Promise<T> {
  if (!UUID_RE.test(tenantId)) throw new Error('withTenant: tenantId must be a UUID');
  return client.$transaction(
    async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`;
      return fn(tx);
    },
    { timeout: options?.timeout ?? 15_000, maxWait: options?.maxWait ?? 5_000, ...(options?.isolationLevel ? { isolationLevel: options.isolationLevel } : {}) },
  );
}

/**
 * Allocate the next human-readable reference for a tenant, e.g.
 * nextReference(tx, tenantId, 'SUB', 2027) → "SUB-2027-000001". Must be called
 * inside withTenant(). Uses a row lock so concurrent calls never collide.
 */
export async function nextReference(
  tx: TenantTx,
  tenantId: string,
  prefix: string,
  year: number = new Date().getUTCFullYear(),
): Promise<string> {
  const name = `${prefix}-${year}`;
  const rows = await tx.$queryRaw<Array<{ value: number }>>`
    INSERT INTO reference_sequences (tenant_id, name, next_value)
    VALUES (${tenantId}::uuid, ${name}, 2)
    ON CONFLICT (tenant_id, name)
    DO UPDATE SET next_value = reference_sequences.next_value + 1
    RETURNING next_value - 1 AS value`;
  const value = rows[0]?.value ?? 1;
  return `${name}-${String(value).padStart(6, '0')}`;
}

export * from './security';
export * from './provisioning';

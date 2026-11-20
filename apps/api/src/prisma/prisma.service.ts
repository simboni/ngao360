import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { createPrismaClient, type Prisma, type PrismaClient, type TenantTx, withTenant } from '@ngao360/db';
import { AppConfig } from '../config/app-config';
import { RequestContext } from '../common/context/request-context';
import { AppException } from '../common/http/app-exception';

/**
 * Database access for the API.
 *
 * - `client` connects as the runtime role (APP_DATABASE_URL, RLS enforced).
 *   Tenant-owned tables return no rows unless accessed through `withTenant`.
 * - Always use `withTenant(tenantId, tx => ...)` or `tenantTx(tx => ...)` for
 *   tenant data. Pass the `tx` to AuditService.record() so the audit event
 *   commits atomically with the change.
 */
@Injectable()
export class PrismaService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PrismaService.name);
  readonly client: PrismaClient;

  constructor(config: AppConfig) {
    const url = config.values.APP_DATABASE_URL ?? config.values.DATABASE_URL;
    if (!config.values.APP_DATABASE_URL) {
      this.logger.warn('APP_DATABASE_URL not set: using DATABASE_URL. RLS is NOT enforced for the table owner.');
    }
    this.client = createPrismaClient({ url });
  }

  async onModuleInit(): Promise<void> {
    await this.client.$connect();
  }

  async onModuleDestroy(): Promise<void> {
    await this.client.$disconnect();
  }

  /** Run `fn` in a transaction scoped to `tenantId` (sets app.tenant_id for RLS). */
  withTenant<T>(
    tenantId: string,
    fn: (tx: TenantTx) => Promise<T>,
    options?: { isolationLevel?: Prisma.TransactionIsolationLevel; timeout?: number },
  ): Promise<T> {
    return withTenant(this.client, tenantId, fn, options);
  }

  /** Same as withTenant, using the authenticated tenant of the current request. */
  tenantTx<T>(
    fn: (tx: TenantTx) => Promise<T>,
    options?: { isolationLevel?: Prisma.TransactionIsolationLevel; timeout?: number },
  ): Promise<T> {
    const tenantId = RequestContext.get()?.auth?.tenantId;
    if (!tenantId) throw AppException.unauthenticated('No tenant in request context');
    return this.withTenant(tenantId, fn, options);
  }
}

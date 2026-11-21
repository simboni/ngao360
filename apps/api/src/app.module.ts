import { type MiddlewareConsumer, Module, type NestModule } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_PIPE } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { AuditModule } from './audit/audit.module';
import { AuthModule } from './auth/auth.module';
import { AuthRecoveryModule } from './auth/recovery/auth-recovery.module';
import { JwtAuthGuard } from './auth/jwt-auth.guard';
import { RequestContextMiddleware } from './common/context/request-context.middleware';
import { AllExceptionsFilter } from './common/http/all-exceptions.filter';
import { CsrfGuard } from './common/http/csrf.guard';
import { ZodValidationPipe } from './common/zod/zod-validation.pipe';
import { AppConfig } from './config/app-config';
import { ConfigModule } from './config/config.module';
import { HealthModule } from './health/health.module';
import { AdminModule } from './modules/admin/admin.module';
import { CampaignModule } from './modules/campaign/campaign.module';
import { ReferenceModule } from './modules/reference/reference.module';
import { FieldModule } from './modules/field/field.module';
import { OfficeModule } from './modules/office/office.module';
import { TallyModule } from './modules/tally/tally.module';
import { WorkspaceModule } from './modules/workspace/workspace.module';
import { PlatformModule } from './platform/platform.module';
import { PrismaModule } from './prisma/prisma.module';
import { QueueModule } from './queue/queue.module';
import { RbacGuard } from './rbac/rbac.guard';
import { RbacModule } from './rbac/rbac.module';
import { StorageModule } from './storage/storage.module';
import { ModuleGuard } from './tenant-modules/module.guard';
import { TenantModulesModule } from './tenant-modules/tenant-modules.module';

@Module({
  imports: [
    ConfigModule,
    ThrottlerModule.forRootAsync({
      inject: [AppConfig],
      useFactory: (config: AppConfig) => [
        { ttl: config.values.RATE_LIMIT_TTL_SECONDS * 1000, limit: config.values.RATE_LIMIT_MAX },
      ],
    }),
    PrismaModule,
    AuditModule,
    RbacModule,
    AuthModule,
    StorageModule,
    QueueModule.register(),
    // Pilot hardening: messaging, scanning, captcha, rate-limit store, durable jobs (platform-infra)
    PlatformModule,
    HealthModule,
    TenantModulesModule,
    // Domain modules (filled by module agents)
    ReferenceModule,
    TallyModule,
    AdminModule,
    OfficeModule,
    FieldModule,
    CampaignModule,
    // Pilot hardening (docs/ARCHITECTURE.md §16)
    AuthRecoveryModule,
    WorkspaceModule,
  ],
  providers: [
    { provide: APP_PIPE, useClass: ZodValidationPipe },
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
    // Guard order matters: rate limit → CSRF → authenticate → authorise → module activation.
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_GUARD, useClass: CsrfGuard },
    { provide: APP_GUARD, useExisting: JwtAuthGuard },
    { provide: APP_GUARD, useExisting: RbacGuard },
    { provide: APP_GUARD, useExisting: ModuleGuard },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(RequestContextMiddleware).forRoutes('*');
  }
}

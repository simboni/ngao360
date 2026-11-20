import { Module } from '@nestjs/common';

/**
 * ADMIN module (owned by the admin module agent; edit only within
 * apps/api/src/modules/admin/).
 *
 * Scope: users (invite, suspend, reset MFA), roles + permission matrix, role
 * assignments with geography scope and expiry, audit log viewer/export,
 * dashboard summary and notifications. Endpoints: docs/API_CONTRACT.md §6–7.
 */
@Module({
  imports: [],
  controllers: [],
  providers: [],
  exports: [],
})
export class AdminModule {}

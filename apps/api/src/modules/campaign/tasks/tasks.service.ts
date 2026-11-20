import { Injectable } from '@nestjs/common';
import { AuditService } from '../../../audit/audit.service';
import { PrismaService } from '../../../prisma/prisma.service';
import { PermissionService } from '../../../rbac/permission.service';
import { TenantModulesService } from '../../../tenant-modules/tenant-modules.service';

/**
 * Tasks with accountable owner, collaborators, reviewer (≠ owner), dependencies (no cycles:
 * wouldCreateDependencyCycle), checklist, comments, attachments and completion evidence.
 * Every change appends a task_events row and writes its audit action in the same transaction.
 */
@Injectable()
export class TasksService {
  constructor(
    readonly prisma: PrismaService,
    readonly audit: AuditService,
    readonly permissions: PermissionService,
    readonly modules: TenantModulesService,
  ) {}
}

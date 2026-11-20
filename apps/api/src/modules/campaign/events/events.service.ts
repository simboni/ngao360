import { Injectable } from '@nestjs/common';
import { AuditService } from '../../../audit/audit.service';
import { PrismaService } from '../../../prisma/prisma.service';
import { PermissionService } from '../../../rbac/permission.service';
import { TenantModulesService } from '../../../tenant-modules/tenant-modules.service';

/**
 * Events and logistics. Attendance contact details live in event_attendance_contacts and are read only
 * through the audited reveal (events.attendance.contact). Approved after-action reports are immutable;
 * reviewer ≠ author (DB check).
 */
@Injectable()
export class EventsService {
  constructor(
    readonly prisma: PrismaService,
    readonly audit: AuditService,
    readonly permissions: PermissionService,
    readonly modules: TenantModulesService,
  ) {}
}

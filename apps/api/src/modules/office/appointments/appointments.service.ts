import { Injectable } from '@nestjs/common';
import { nextReference, Prisma, type TenantTx } from '@ngao360/db';
import {
  AUDIT_ACTIONS,
  type AppointmentDetail,
  type AppointmentQuery,
  type AppointmentStatus,
  type AppointmentSummary,
  type AppointmentTransition,
  CURRENT_APPOINTMENT_PRIVACY_NOTICE_VERSION,
  type CreateAppointment,
  type Paginated,
  type UpdateAppointment,
  canTransitionAppointment,
} from '@ngao360/shared';
import type { AuthContext } from '../../../auth/auth.types';
import { AuditService } from '../../../audit/audit.service';
import { AppException } from '../../../common/http/app-exception';
import { PrismaService } from '../../../prisma/prisma.service';
import { PermissionService } from '../../../rbac/permission.service';
import {
  USER_REF,
  addDays,
  assertUpdated,
  changedFields,
  immutableRecord,
  iso,
  isoDate,
  nairobiToday,
  paging,
  toDbDate,
  userHoldsPermission,
} from '../common';
import { OFFICE_REFERENCE_PREFIX } from '../office.constants';

const ENTITY = 'Appointment';
const CLOSED: readonly AppointmentStatus[] = ['DECLINED', 'CANCELLED', 'COMPLETED'];
const FOLLOW_UP_KEYS = new Set(['followUpRequired', 'followUpDate', 'followUpNotes']);

const SUMMARY_INCLUDE = { assignedTo: USER_REF } satisfies Prisma.AppointmentInclude;
const DETAIL_INCLUDE = {
  assignedTo: USER_REF,
  createdBy: USER_REF,
  linkedCase: { select: { id: true, reference: true } },
  linkedCorrespondence: { select: { id: true, reference: true, sensitivity: true } },
} satisfies Prisma.AppointmentInclude;
type SummaryRow = Prisma.AppointmentGetPayload<{ include: typeof SUMMARY_INCLUDE }>;
type DetailRow = Prisma.AppointmentGetPayload<{ include: typeof DETAIL_INCLUDE }>;

/** Replace contact values with presence flags: no Office audit event contains contact values. */
function redactContact(snapshot: Record<string, unknown>): Record<string, unknown> {
  const out = { ...snapshot };
  if ('contactPhone' in out) {
    out.hasPhone = !!out.contactPhone;
    delete out.contactPhone;
  }
  if ('contactEmail' in out) {
    out.hasEmail = !!out.contactEmail;
    delete out.contactEmail;
  }
  if ('requesterName' in out) {
    out.requesterNameChanged = true;
    delete out.requesterName;
  }
  return out;
}

/**
 * Appointments and the office diary (blueprint 9.1, API contract §10.1). The
 * requester gave contact details for this purpose, so holders of
 * `office.appointments.view` see them; audit events never contain them.
 */
@Injectable()
export class AppointmentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly permissions: PermissionService,
  ) {}

  async list(auth: AuthContext, q: AppointmentQuery): Promise<Paginated<AppointmentSummary>> {
    const today = nairobiToday();
    const and: Prisma.AppointmentWhereInput[] = [];
    if (q.status) and.push({ status: q.status });
    if (q.assignedToId) and.push({ assignedToId: q.assignedToId });
    if (q.view === 'mine') and.push({ assignedToId: auth.userId });
    if (q.view === 'pending') and.push({ status: 'REQUESTED' });
    if (q.view === 'follow_up') and.push({ followUpRequired: true, followUpDate: { lte: toDbDate(addDays(today, 7)) } });
    if (q.from || q.to) {
      const range = { ...(q.from ? { gte: new Date(q.from) } : {}), ...(q.to ? { lte: new Date(q.to) } : {}) };
      and.push({ OR: [{ confirmedStart: range }, { confirmedStart: null, preferredStart: range }] });
    }
    if (q.q) {
      const c = { contains: q.q, mode: 'insensitive' as const };
      and.push({ OR: [{ reference: c }, { requesterName: c }, { requesterOrganisation: c }, { purpose: c }, { assignedOffice: c }] });
    }
    const where: Prisma.AppointmentWhereInput = { AND: and };
    const diary = q.from || q.to;
    const orderBy: Prisma.AppointmentOrderByWithRelationInput[] = diary
      ? [{ confirmedStart: { sort: 'asc', nulls: 'last' } }, { preferredStart: { sort: 'asc', nulls: 'last' } }]
      : q.sort === 'confirmedStart'
        ? [{ confirmedStart: { sort: q.order, nulls: 'last' } }]
        : [{ createdAt: q.order }];
    return this.prisma.tenantTx(async (tx) => {
      const [rows, total] = await Promise.all([
        tx.appointment.findMany({ where, include: SUMMARY_INCLUDE, orderBy, ...paging(q) }),
        tx.appointment.count({ where }),
      ]);
      return { items: rows.map((r) => this.toSummary(r)), page: q.page, pageSize: q.pageSize, total };
    });
  }

  detail(auth: AuthContext, id: string): Promise<AppointmentDetail> {
    return this.prisma.tenantTx((tx) => this.loadDetail(tx, auth, id));
  }

  create(auth: AuthContext, dto: CreateAppointment): Promise<AppointmentDetail> {
    if (dto.privacyNoticeVersion !== CURRENT_APPOINTMENT_PRIVACY_NOTICE_VERSION) {
      throw AppException.validation('Show the current appointment privacy notice to the requester', [
        { path: ['privacyNoticeVersion'], message: `Expected ${CURRENT_APPOINTMENT_PRIVACY_NOTICE_VERSION}` },
      ]);
    }
    assertEndAfterStart(dto.preferredStart, dto.preferredEnd, 'preferredEnd');
    return this.prisma.tenantTx(async (tx) => {
      await this.assertLinks(tx, auth, dto);
      const reference = await nextReference(tx, auth.tenantId, OFFICE_REFERENCE_PREFIX.APPOINTMENT);
      const row = await tx.appointment.create({
        data: {
          tenantId: auth.tenantId,
          reference,
          source: dto.source,
          requesterName: dto.requesterName,
          requesterOrganisation: dto.requesterOrganisation ?? null,
          contactPhone: dto.contactPhone ?? null,
          contactEmail: dto.contactEmail ?? null,
          contactPreference: dto.contactPreference,
          purpose: dto.purpose,
          preferredStart: dto.preferredStart ? new Date(dto.preferredStart) : null,
          preferredEnd: dto.preferredEnd ? new Date(dto.preferredEnd) : null,
          assignedOffice: dto.assignedOffice ?? null,
          assignedToId: dto.assignedToId ?? null,
          venue: dto.venue ?? null,
          status: 'REQUESTED',
          privacyNoticeVersion: dto.privacyNoticeVersion,
          linkedCaseId: dto.linkedCaseId ?? null,
          linkedCorrespondenceId: dto.linkedCorrespondenceId ?? null,
          createdById: auth.userId,
        },
      });
      await this.audit.record(
        {
          tenantId: auth.tenantId,
          action: AUDIT_ACTIONS.APPOINTMENT_CREATED,
          entityType: ENTITY,
          entityId: row.id,
          after: {
            reference,
            source: row.source,
            status: row.status,
            hasPhone: !!row.contactPhone,
            hasEmail: !!row.contactEmail,
            contactPreference: row.contactPreference,
            preferredStart: iso(row.preferredStart),
            assignedToId: row.assignedToId,
            privacyNoticeVersion: row.privacyNoticeVersion,
            linkedCaseId: row.linkedCaseId,
            linkedCorrespondenceId: row.linkedCorrespondenceId,
          },
        },
        tx,
      );
      return this.loadDetail(tx, auth, row.id);
    });
  }

  update(auth: AuthContext, id: string, dto: UpdateAppointment): Promise<AppointmentDetail> {
    return this.prisma.tenantTx(async (tx) => {
      const row = await tx.appointment.findUnique({ where: { id } });
      if (!row) throw AppException.notFound('Appointment not found');
      const { expectedVersion, ...fields } = dto;
      assertEndAfterStart(fields.preferredStart ?? row.preferredStart?.toISOString(), fields.preferredEnd ?? row.preferredEnd?.toISOString(), 'preferredEnd');
      const patch: Prisma.AppointmentUncheckedUpdateManyInput = {
        source: fields.source,
        requesterName: fields.requesterName,
        requesterOrganisation: fields.requesterOrganisation,
        contactPhone: fields.contactPhone,
        contactEmail: fields.contactEmail,
        contactPreference: fields.contactPreference,
        purpose: fields.purpose,
        preferredStart: fields.preferredStart ? new Date(fields.preferredStart) : undefined,
        preferredEnd: fields.preferredEnd ? new Date(fields.preferredEnd) : undefined,
        assignedOffice: fields.assignedOffice,
        assignedToId: fields.assignedToId,
        venue: fields.venue,
        linkedCaseId: fields.linkedCaseId,
        linkedCorrespondenceId: fields.linkedCorrespondenceId,
        followUpRequired: fields.followUpRequired,
        followUpDate: toDbDate(fields.followUpDate),
        followUpNotes: fields.followUpNotes,
      };
      const diff = changedFields(row as unknown as Record<string, unknown>, patch as Record<string, unknown>);
      if (diff.keys.length === 0) return this.loadDetail(tx, auth, id);
      if (CLOSED.includes(row.status) && diff.keys.some((k) => !FOLLOW_UP_KEYS.has(k))) {
        throw immutableRecord('A declined, cancelled or completed appointment can only change its follow-up');
      }
      await this.assertLinks(tx, auth, {
        assignedToId: diff.keys.includes('assignedToId') ? (fields.assignedToId ?? undefined) : undefined,
        linkedCaseId: diff.keys.includes('linkedCaseId') ? fields.linkedCaseId : undefined,
        linkedCorrespondenceId: diff.keys.includes('linkedCorrespondenceId') ? fields.linkedCorrespondenceId : undefined,
      });
      const result = await tx.appointment.updateMany({ where: { id, version: expectedVersion }, data: { ...patch, version: { increment: 1 } } });
      assertUpdated(result, 'appointment');
      await this.audit.record(
        {
          tenantId: auth.tenantId,
          action: AUDIT_ACTIONS.APPOINTMENT_UPDATED,
          entityType: ENTITY,
          entityId: id,
          before: redactContact(diff.before),
          after: redactContact(diff.after),
        },
        tx,
      );
      return this.loadDetail(tx, auth, id);
    });
  }

  transition(auth: AuthContext, id: string, dto: AppointmentTransition): Promise<AppointmentDetail> {
    return this.prisma.tenantTx(async (tx) => {
      const row = await tx.appointment.findUnique({ where: { id } });
      if (!row) throw AppException.notFound('Appointment not found');
      if (!canTransitionAppointment(row.status, dto.to)) throw AppException.invalidTransition(row.status, dto.to);
      const data: Prisma.AppointmentUncheckedUpdateManyInput = { status: dto.to };
      if (dto.to === 'CONFIRMED' || dto.to === 'RESCHEDULED') {
        if (!dto.confirmedStart) throw AppException.validation('Give the confirmed start time', [{ path: ['confirmedStart'], message: 'Required' }]);
        // Compare instants: ISO strings with different offsets do not sort as text.
        assertEndAfterStart(dto.confirmedStart, dto.confirmedEnd, 'confirmedEnd');
        data.confirmedStart = new Date(dto.confirmedStart);
        data.confirmedEnd = dto.confirmedEnd ? new Date(dto.confirmedEnd) : null;
        if (dto.venue !== undefined) data.venue = dto.venue;
      }
      if (dto.to === 'COMPLETED') {
        if (!dto.outcome) throw AppException.validation('Record the outcome', [{ path: ['outcome'], message: 'Required' }]);
        data.outcome = dto.outcome;
        data.outcomeRecordedAt = new Date();
        if (dto.followUpRequired !== undefined) data.followUpRequired = dto.followUpRequired;
        if (dto.followUpDate !== undefined) data.followUpDate = toDbDate(dto.followUpDate);
        if (dto.followUpNotes !== undefined) data.followUpNotes = dto.followUpNotes;
      }
      if ((dto.to === 'DECLINED' || dto.to === 'CANCELLED' || dto.to === 'NO_SHOW') && !dto.reason) {
        throw AppException.validation('Give a reason', [{ path: ['reason'], message: 'Required' }]);
      }
      const result = await tx.appointment.updateMany({ where: { id, version: dto.expectedVersion }, data: { ...data, version: { increment: 1 } } });
      assertUpdated(result, 'appointment');
      await this.audit.record(
        {
          tenantId: auth.tenantId,
          action: AUDIT_ACTIONS.APPOINTMENT_STATUS_CHANGED,
          entityType: ENTITY,
          entityId: id,
          before: { status: row.status, confirmedStart: iso(row.confirmedStart) },
          after: {
            status: dto.to,
            confirmedStart: data.confirmedStart instanceof Date ? data.confirmedStart.toISOString() : iso(row.confirmedStart),
            outcomeRecorded: dto.to === 'COMPLETED',
            followUpRequired: dto.followUpRequired ?? row.followUpRequired,
          },
          reason: dto.reason ?? null,
        },
        tx,
      );
      return this.loadDetail(tx, auth, id);
    });
  }

  /* -------------------------------- Internals -------------------------------- */

  private async assertLinks(
    tx: TenantTx,
    auth: AuthContext,
    dto: { assignedToId?: string; linkedCaseId?: string; linkedCorrespondenceId?: string },
  ): Promise<void> {
    if (dto.assignedToId && !(await userHoldsPermission(tx, this.permissions, dto.assignedToId, 'office.appointments.view'))) {
      throw AppException.validation('The assignee must be an active user who can view appointments', [{ path: ['assignedToId'], message: 'Not allowed' }]);
    }
    if (dto.linkedCaseId && !(await tx.citizenCase.findUnique({ where: { id: dto.linkedCaseId }, select: { id: true } }))) {
      throw AppException.validation('Unknown case', [{ path: ['linkedCaseId'], message: 'Not found' }]);
    }
    if (dto.linkedCorrespondenceId) {
      const c = await tx.correspondence.findUnique({ where: { id: dto.linkedCorrespondenceId }, select: { sensitivity: true } });
      const hidden = c && (c.sensitivity === 'CONFIDENTIAL' || c.sensitivity === 'HIGHLY_RESTRICTED') && !auth.permissions.has('office.correspondence.confidential');
      if (!c || hidden) throw AppException.validation('Unknown correspondence', [{ path: ['linkedCorrespondenceId'], message: 'Not found' }]);
    }
  }

  private async loadDetail(tx: TenantTx, auth: AuthContext, id: string): Promise<AppointmentDetail> {
    const row = await tx.appointment.findUnique({ where: { id }, include: DETAIL_INCLUDE });
    if (!row) throw AppException.notFound('Appointment not found');
    return this.toDetail(row, auth);
  }

  private toSummary(r: SummaryRow): AppointmentSummary {
    return {
      id: r.id,
      reference: r.reference,
      requesterName: r.requesterName,
      requesterOrganisation: r.requesterOrganisation,
      purpose: r.purpose,
      preferredStart: iso(r.preferredStart),
      confirmedStart: iso(r.confirmedStart),
      confirmedEnd: iso(r.confirmedEnd),
      assignedOffice: r.assignedOffice,
      assignedTo: r.assignedTo,
      status: r.status,
      followUpRequired: r.followUpRequired,
      followUpDate: isoDate(r.followUpDate),
      createdAt: r.createdAt.toISOString(),
      updatedAt: r.updatedAt.toISOString(),
    };
  }

  private toDetail(r: DetailRow, auth: AuthContext): AppointmentDetail {
    const corr = r.linkedCorrespondence;
    const corrVisible =
      corr && (auth.permissions.has('office.correspondence.confidential') || (corr.sensitivity !== 'CONFIDENTIAL' && corr.sensitivity !== 'HIGHLY_RESTRICTED'));
    return {
      ...this.toSummary(r),
      source: r.source,
      contactPhone: r.contactPhone,
      contactEmail: r.contactEmail,
      contactPreference: r.contactPreference,
      preferredEnd: iso(r.preferredEnd),
      venue: r.venue,
      outcome: r.outcome,
      outcomeRecordedAt: iso(r.outcomeRecordedAt),
      followUpNotes: r.followUpNotes,
      privacyNoticeVersion: r.privacyNoticeVersion,
      linkedCase: r.linkedCase,
      linkedCorrespondence: corr && corrVisible ? { id: corr.id, reference: corr.reference } : null,
      createdBy: r.createdBy,
      allowedActions: this.allowedActions(r.status, auth),
      version: r.version,
    };
  }

  private allowedActions(status: AppointmentStatus, auth: AuthContext): AppointmentDetail['allowedActions'] {
    if (!auth.permissions.has('office.appointments.manage')) return [];
    const out: AppointmentDetail['allowedActions'] = ['edit'];
    const can = (to: AppointmentStatus) => canTransitionAppointment(status, to);
    if (can('CONFIRMED')) out.push('confirm');
    if (can('RESCHEDULED')) out.push('reschedule');
    if (can('DECLINED')) out.push('decline');
    if (can('CANCELLED')) out.push('cancel');
    if (can('COMPLETED')) out.push('complete');
    if (can('NO_SHOW')) out.push('no_show');
    return out;
  }
}

/** 400 unless `end` is strictly after `start`, compared as instants (offsets may differ). */
export function assertEndAfterStart(start: string | null | undefined, end: string | null | undefined, path: string): void {
  if (!start || !end) return;
  if (new Date(end).getTime() <= new Date(start).getTime()) {
    throw AppException.validation('The end must be after the start', [{ path: [path], message: 'Invalid' }]);
  }
}

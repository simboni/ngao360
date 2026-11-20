import { Injectable } from '@nestjs/common';
import { Prisma, type TenantTx } from '@ngao360/db';
import {
  AUDIT_ACTIONS,
  type CreateMeeting,
  type MeetingActionItem,
  type MeetingAgendaItem,
  MeetingAgendaItemSchema,
  type MeetingDecision,
  type MeetingDetail,
  type MeetingParticipant,
  MeetingParticipantSchema,
  type MeetingQuery,
  type MeetingSummary,
  type Paginated,
  type RecordMeetingDecision,
  type SaveMeetingActionItem,
  type SensitivityLevel,
  type UpdateMeeting,
} from '@ngao360/shared';
import { z } from 'zod';
import type { AuthContext } from '../../../auth/auth.types';
import { AuditService } from '../../../audit/audit.service';
import { AppException } from '../../../common/http/app-exception';
import { PrismaService } from '../../../prisma/prisma.service';
import { USER_REF, assertUpdated, changedFields, immutableRecord, iso, isoDate, paging, toDbDate } from '../common';

const ENTITY = 'Meeting';
const RESTRICTED: readonly SensitivityLevel[] = ['CONFIDENTIAL', 'HIGHLY_RESTRICTED'];

const SUMMARY_INCLUDE = {
  owner: USER_REF,
  _count: { select: { actionItems: { where: { status: 'OPEN' } } } },
} satisfies Prisma.MeetingInclude;
const DETAIL_INCLUDE = {
  owner: USER_REF,
  minutesRecorder: USER_REF,
  _count: { select: { actionItems: { where: { status: 'OPEN' } } } },
  actionItems: { include: { owner: USER_REF }, orderBy: { createdAt: 'asc' } },
  decisions: { include: { recordedBy: USER_REF }, orderBy: { recordedAt: 'asc' } },
} satisfies Prisma.MeetingInclude;
type SummaryRow = Prisma.MeetingGetPayload<{ include: typeof SUMMARY_INCLUDE }>;
type DetailRow = Prisma.MeetingGetPayload<{ include: typeof DETAIL_INCLUDE }>;
type ActionRow = DetailRow['actionItems'][number];
type DecisionRow = DetailRow['decisions'][number];

const parseParticipants = (v: unknown): MeetingParticipant[] => z.array(MeetingParticipantSchema).catch([]).parse(v);
const parseAgenda = (v: unknown): MeetingAgendaItem[] => z.array(MeetingAgendaItemSchema).catch([]).parse(v);

/**
 * Lean meetings (blueprint 9.1, API contract §10.2): agenda, participants,
 * minutes, action items and an append-only decision log. Confidential meetings
 * are visible only to their owner and listed participants who are users.
 */
@Injectable()
export class MeetingsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /** Where-fragment for meetings the caller may see. */
  private visibleWhere(auth: AuthContext): Prisma.MeetingWhereInput {
    return {
      OR: [
        { sensitivity: { notIn: [...RESTRICTED] } },
        { ownerId: auth.userId },
        { participants: { array_contains: [{ userId: auth.userId }] } },
      ],
    };
  }

  async list(auth: AuthContext, q: MeetingQuery): Promise<Paginated<MeetingSummary>> {
    const and: Prisma.MeetingWhereInput[] = [this.visibleWhere(auth)];
    if (q.status) and.push({ status: q.status });
    if (q.from || q.to) and.push({ scheduledStart: { ...(q.from ? { gte: new Date(q.from) } : {}), ...(q.to ? { lte: new Date(q.to) } : {}) } });
    if (q.q) and.push({ OR: [{ title: { contains: q.q, mode: 'insensitive' } }, { venue: { contains: q.q, mode: 'insensitive' } }] });
    const where: Prisma.MeetingWhereInput = { AND: and };
    return this.prisma.tenantTx(async (tx) => {
      const [rows, total] = await Promise.all([
        tx.meeting.findMany({ where, include: SUMMARY_INCLUDE, orderBy: [{ scheduledStart: q.order }], ...paging(q) }),
        tx.meeting.count({ where }),
      ]);
      return { items: rows.map((r) => this.toSummary(r)), page: q.page, pageSize: q.pageSize, total };
    });
  }

  detail(auth: AuthContext, id: string): Promise<MeetingDetail> {
    return this.prisma.tenantTx((tx) => this.loadDetail(tx, auth, id));
  }

  create(auth: AuthContext, dto: CreateMeeting): Promise<MeetingDetail> {
    return this.prisma.tenantTx(async (tx) => {
      const ownerId = dto.ownerId ?? auth.userId;
      await this.assertUsers(tx, [ownerId], 'ownerId');
      await this.assertParticipants(tx, dto.participants);
      if (dto.scheduledEnd && dto.scheduledEnd <= dto.scheduledStart) {
        throw AppException.validation('The end must be after the start', [{ path: ['scheduledEnd'], message: 'Invalid' }]);
      }
      const row = await tx.meeting.create({
        data: {
          tenantId: auth.tenantId,
          title: dto.title,
          scheduledStart: new Date(dto.scheduledStart),
          scheduledEnd: dto.scheduledEnd ? new Date(dto.scheduledEnd) : null,
          venue: dto.venue ?? null,
          onlineLink: dto.onlineLink ?? null,
          sensitivity: dto.sensitivity,
          agenda: dto.agenda as unknown as Prisma.InputJsonValue,
          participants: dto.participants as unknown as Prisma.InputJsonValue,
          status: 'SCHEDULED',
          ownerId,
        },
      });
      await this.audit.record(
        {
          tenantId: auth.tenantId,
          action: AUDIT_ACTIONS.MEETING_CREATED,
          entityType: ENTITY,
          entityId: row.id,
          after: {
            title: row.title,
            scheduledStart: row.scheduledStart.toISOString(),
            sensitivity: row.sensitivity,
            ownerId,
            participantCount: dto.participants.length,
            agendaItems: dto.agenda.length,
          },
        },
        tx,
      );
      return this.loadDetail(tx, auth, row.id);
    });
  }

  update(auth: AuthContext, id: string, dto: UpdateMeeting): Promise<MeetingDetail> {
    return this.prisma.tenantTx(async (tx) => {
      const row = await this.loadVisible(tx, auth, id);
      if (row.status === 'CANCELLED') throw immutableRecord('A cancelled meeting cannot be changed');
      if (dto.status && dto.status !== row.status && !(row.status === 'SCHEDULED' && (dto.status === 'HELD' || dto.status === 'CANCELLED'))) {
        throw AppException.invalidTransition(row.status, dto.status);
      }
      if (dto.ownerId && dto.ownerId !== row.ownerId) await this.assertUsers(tx, [dto.ownerId], 'ownerId');
      if (dto.participants) await this.assertParticipants(tx, dto.participants);
      const minutesChanging = dto.minutes !== undefined && dto.minutes !== row.minutes;
      if (minutesChanging && row.minutesRecordedAt && !dto.reason) {
        throw AppException.validation('Give a reason for changing recorded minutes', [{ path: ['reason'], message: 'Required' }]);
      }
      const patch: Prisma.MeetingUncheckedUpdateManyInput = {
        title: dto.title,
        scheduledStart: dto.scheduledStart ? new Date(dto.scheduledStart) : undefined,
        scheduledEnd: dto.scheduledEnd ? new Date(dto.scheduledEnd) : undefined,
        venue: dto.venue,
        onlineLink: dto.onlineLink,
        sensitivity: dto.sensitivity,
        ownerId: dto.ownerId,
        status: dto.status,
        agenda: dto.agenda as unknown as Prisma.InputJsonValue | undefined,
        participants: dto.participants as unknown as Prisma.InputJsonValue | undefined,
        minutes: dto.minutes,
      };
      const diff = changedFields(row as unknown as Record<string, unknown>, patch as Record<string, unknown>);
      if (diff.keys.length === 0) return this.loadDetail(tx, auth, id);
      if (minutesChanging) {
        patch.minutesRecordedById = auth.userId;
        patch.minutesRecordedAt = new Date();
      }
      const result = await tx.meeting.updateMany({ where: { id, version: dto.expectedVersion }, data: { ...patch, version: { increment: 1 } } });
      assertUpdated(result, 'meeting');
      // Minutes, agenda and participant lists can be long: audit that they changed, not their text.
      const summarise = (s: Record<string, unknown>) => {
        const out = { ...s };
        for (const k of ['minutes', 'agenda', 'participants']) if (k in out) out[k] = '[changed]';
        return out;
      };
      await this.audit.record(
        {
          tenantId: auth.tenantId,
          action: AUDIT_ACTIONS.MEETING_UPDATED,
          entityType: ENTITY,
          entityId: id,
          before: summarise(diff.before),
          after: summarise(diff.after),
          reason: dto.reason ?? null,
        },
        tx,
      );
      return this.loadDetail(tx, auth, id);
    });
  }

  addActionItem(auth: AuthContext, meetingId: string, dto: SaveMeetingActionItem): Promise<MeetingActionItem> {
    return this.prisma.tenantTx(async (tx) => {
      await this.loadVisible(tx, auth, meetingId);
      this.assertOwnerGiven(dto);
      if (dto.ownerId) await this.assertUsers(tx, [dto.ownerId], 'ownerId');
      const item = await tx.meetingActionItem.create({
        data: {
          tenantId: auth.tenantId,
          meetingId,
          description: dto.description,
          ownerId: dto.ownerId ?? null,
          ownerName: dto.ownerName ?? null,
          dueDate: toDbDate(dto.dueDate) ?? null,
          status: dto.status,
          completedAt: dto.status === 'DONE' ? new Date() : null,
        },
        include: { owner: USER_REF },
      });
      await this.audit.record(
        {
          tenantId: auth.tenantId,
          action: AUDIT_ACTIONS.MEETING_ACTION_ITEM_SAVED,
          entityType: 'MeetingActionItem',
          entityId: item.id,
          after: { meetingId, status: item.status, ownerId: item.ownerId, dueDate: isoDate(item.dueDate) },
        },
        tx,
      );
      return this.toActionItem(item);
    });
  }

  updateActionItem(auth: AuthContext, meetingId: string, itemId: string, dto: SaveMeetingActionItem): Promise<MeetingActionItem> {
    return this.prisma.tenantTx(async (tx) => {
      await this.loadVisible(tx, auth, meetingId);
      const existing = await tx.meetingActionItem.findFirst({ where: { id: itemId, meetingId } });
      if (!existing) throw AppException.notFound('Action item not found');
      this.assertOwnerGiven(dto);
      if (dto.ownerId && dto.ownerId !== existing.ownerId) await this.assertUsers(tx, [dto.ownerId], 'ownerId');
      const completedAt = dto.status === 'DONE' ? (existing.completedAt ?? new Date()) : null;
      const item = await tx.meetingActionItem.update({
        where: { id: itemId },
        data: {
          description: dto.description,
          ownerId: dto.ownerId ?? null,
          ownerName: dto.ownerName ?? null,
          dueDate: toDbDate(dto.dueDate) ?? null,
          status: dto.status,
          completedAt,
        },
        include: { owner: USER_REF },
      });
      await this.audit.record(
        {
          tenantId: auth.tenantId,
          action: AUDIT_ACTIONS.MEETING_ACTION_ITEM_SAVED,
          entityType: 'MeetingActionItem',
          entityId: item.id,
          before: { status: existing.status, ownerId: existing.ownerId, dueDate: isoDate(existing.dueDate) },
          after: { meetingId, status: item.status, ownerId: item.ownerId, dueDate: isoDate(item.dueDate) },
        },
        tx,
      );
      return this.toActionItem(item);
    });
  }

  recordDecision(auth: AuthContext, meetingId: string, dto: RecordMeetingDecision): Promise<MeetingDecision> {
    return this.prisma.tenantTx(async (tx) => {
      await this.loadVisible(tx, auth, meetingId);
      if (dto.supersedesId) {
        const prev = await tx.meetingDecision.findFirst({ where: { id: dto.supersedesId, meetingId }, select: { id: true } });
        if (!prev) throw AppException.validation('The superseded decision must belong to this meeting', [{ path: ['supersedesId'], message: 'Not found' }]);
      }
      const d = await tx.meetingDecision.create({
        data: {
          tenantId: auth.tenantId,
          meetingId,
          decision: dto.decision,
          rationale: dto.rationale ?? null,
          supersedesId: dto.supersedesId ?? null,
          recordedById: auth.userId,
        },
        include: { recordedBy: USER_REF },
      });
      await this.audit.record(
        {
          tenantId: auth.tenantId,
          action: AUDIT_ACTIONS.MEETING_DECISION_RECORDED,
          entityType: 'MeetingDecision',
          entityId: d.id,
          after: { meetingId, supersedesId: d.supersedesId },
        },
        tx,
      );
      return this.toDecision(d);
    });
  }

  /* -------------------------------- Internals -------------------------------- */

  private assertOwnerGiven(dto: SaveMeetingActionItem): void {
    if (!dto.ownerId && !dto.ownerName) {
      throw AppException.validation('Name who owns the action', [{ path: ['ownerId'], message: 'Choose a user or enter a name' }]);
    }
  }

  private async assertUsers(tx: TenantTx, ids: string[], path: string): Promise<void> {
    const unique = [...new Set(ids)];
    const found = await tx.user.count({ where: { id: { in: unique }, status: 'ACTIVE' } });
    if (found !== unique.length) throw AppException.validation('Unknown or inactive user', [{ path: [path], message: 'Not found' }]);
  }

  private async assertParticipants(tx: TenantTx, participants: MeetingParticipant[]): Promise<void> {
    const ids = participants.map((p) => p.userId).filter((v): v is string => !!v);
    if (ids.length === 0) return;
    const unique = [...new Set(ids)];
    const found = await tx.user.count({ where: { id: { in: unique } } });
    if (found !== unique.length) throw AppException.validation('A participant is not a user of this workspace', [{ path: ['participants'], message: 'Unknown user' }]);
  }

  private canSee(auth: AuthContext, row: { sensitivity: SensitivityLevel; ownerId: string; participants: unknown }): boolean {
    if (!RESTRICTED.includes(row.sensitivity)) return true;
    if (row.ownerId === auth.userId) return true;
    return parseParticipants(row.participants).some((p) => p.userId === auth.userId);
  }

  private async loadVisible(tx: TenantTx, auth: AuthContext, id: string) {
    const row = await tx.meeting.findUnique({ where: { id } });
    if (!row || !this.canSee(auth, row)) throw AppException.notFound('Meeting not found');
    return row;
  }

  private async loadDetail(tx: TenantTx, auth: AuthContext, id: string): Promise<MeetingDetail> {
    const row = await tx.meeting.findUnique({ where: { id }, include: DETAIL_INCLUDE });
    if (!row || !this.canSee(auth, row)) throw AppException.notFound('Meeting not found');
    return {
      ...this.toSummary(row),
      onlineLink: row.onlineLink,
      agenda: parseAgenda(row.agenda),
      participants: parseParticipants(row.participants),
      minutes: row.minutes,
      minutesRecordedBy: row.minutesRecorder,
      minutesRecordedAt: iso(row.minutesRecordedAt),
      actionItems: row.actionItems.map((a) => this.toActionItem(a)),
      decisions: row.decisions.map((d) => this.toDecision(d)),
      version: row.version,
    };
  }

  private toSummary(r: SummaryRow): MeetingSummary {
    return {
      id: r.id,
      title: r.title,
      scheduledStart: r.scheduledStart.toISOString(),
      scheduledEnd: iso(r.scheduledEnd),
      venue: r.venue,
      status: r.status,
      sensitivity: r.sensitivity,
      owner: r.owner,
      openActionCount: r._count.actionItems,
    };
  }

  private toActionItem(a: ActionRow): MeetingActionItem {
    return {
      id: a.id,
      description: a.description,
      owner: a.owner,
      ownerName: a.ownerName,
      dueDate: isoDate(a.dueDate),
      status: a.status,
      completedAt: iso(a.completedAt),
      updatedAt: a.updatedAt.toISOString(),
    };
  }

  private toDecision(d: DecisionRow): MeetingDecision {
    return {
      id: d.id,
      decision: d.decision,
      rationale: d.rationale,
      supersedesId: d.supersedesId,
      recordedBy: d.recordedBy,
      recordedAt: d.recordedAt.toISOString(),
    };
  }
}

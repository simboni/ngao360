import { Injectable } from '@nestjs/common';
import { nextReference, type Prisma, type TenantTx } from '@ngao360/db';
import {
  type AddBreachEvent,
  AUDIT_ACTIONS,
  BREACH_STATUS_LABELS,
  type BreachDetail,
  type BreachQuery,
  breachStatusFor,
  type BreachSummary,
  type CampaignFile,
  canTransitionBreach,
  type CreateBreach,
  type ExportBreachTimeline,
  type Paginated,
  type SignedUrlResponse,
  type UpdateBreach,
} from '@ngao360/shared';
import { AuditService } from '../../../audit/audit.service';
import type { AuthContext } from '../../../auth/auth.types';
import { AppException } from '../../../common/http/app-exception';
import { PrismaService } from '../../../prisma/prisma.service';
import { StorageService } from '../../../storage/storage.service';
import { TenantModulesService } from '../../../tenant-modules/tenant-modules.service';
import { CAMPAIGN_ENTITY } from '../campaign.constants';
import {
  assertActiveUsers,
  assertOwnFiles,
  auditedSignedUrl,
  type CampaignUpload,
  campaignFile,
  campaignReferenceYear,
  checkVersion,
  FILE_INCLUDE,
  iso,
  pageArgs,
  storeCampaignUpload,
  storeExport,
  usersWithPermission,
} from '../common';
import { NotificationCenterService } from '../notifications/notification-center.service';

const USER = { select: { id: true, displayName: true } } as const;
const DETAIL_INCLUDE = {
  owner: USER,
  reportedBy: USER,
  closedBy: USER,
  events: { include: { actor: USER, evidence: FILE_INCLUDE }, orderBy: [{ occurredAt: 'asc' }, { createdAt: 'asc' }] },
} satisfies Prisma.BreachRecordInclude;
type BreachRow = Prisma.BreachRecordGetPayload<{ include: typeof DETAIL_INCLUDE }>;

/**
 * Breach records with an append-only breach_events timeline (blueprint 15.4;
 * docs/API_CONTRACT.md §30). Closure needs lessons and a closer other than the
 * reporter (DB checks). Drills are labelled. Categories and counts only, never
 * personal data. Platform feature (no module gate).
 */
@Injectable()
export class BreachesService {
  constructor(
    readonly prisma: PrismaService,
    readonly audit: AuditService,
    readonly modules: TenantModulesService,
    private readonly storage: StorageService,
    private readonly notifications: NotificationCenterService,
  ) {}

  list(auth: AuthContext, q: BreachQuery): Promise<Paginated<BreachSummary>> {
    return this.prisma.tenantTx(async (tx) => {
      const where: Prisma.BreachRecordWhereInput = {
        AND: [
          q.status ? { status: q.status } : {},
          q.severity ? { severity: q.severity } : {},
          q.includeDrills ? {} : { isDrill: false },
          q.q ? { OR: [{ reference: { contains: q.q, mode: 'insensitive' } }, { title: { contains: q.q, mode: 'insensitive' } }] } : {},
        ],
      };
      const [rows, total] = await Promise.all([
        tx.breachRecord.findMany({ where, include: { owner: USER }, orderBy: [{ detectedAt: q.order }, { id: 'asc' }], ...pageArgs(q) }),
        tx.breachRecord.count({ where }),
      ]);
      return { items: rows.map(toSummary), page: q.page, pageSize: q.pageSize, total };
    });
  }

  private async load(tx: TenantTx, id: string): Promise<BreachRow> {
    const row = await tx.breachRecord.findUnique({ where: { id }, include: DETAIL_INCLUDE });
    if (!row) throw AppException.notFound('Breach record not found');
    return row;
  }

  private detail(auth: AuthContext, r: BreachRow): BreachDetail {
    const p = (k: Parameters<typeof auth.permissions.has>[0]) => auth.permissions.has(k);
    const allowed: BreachDetail['allowedActions'] = [];
    if (p('security.breach.manage') && r.status !== 'CLOSED') allowed.push('EDIT', 'ADVANCE');
    if (p('security.breach.manage') || p('security.breach.record')) allowed.push('ADD_EVENT');
    if (p('security.breach.manage') && r.status === 'REMEDIATED' && r.reportedById !== auth.userId) allowed.push('CLOSE');
    if (p('security.breach.manage') && r.status === 'CLOSED') allowed.push('REOPEN');
    if (p('security.breach.export')) allowed.push('EXPORT');
    return {
      ...toSummary(r),
      description: r.description,
      dataCategories: r.dataCategories as BreachDetail['dataCategories'],
      estimatedSubjects: r.estimatedSubjects,
      systemsAffected: r.systemsAffected,
      containmentSummary: r.containmentSummary,
      riskAssessment: r.riskAssessment,
      notificationDecision: r.notificationDecision,
      controllerNotifiedAt: iso(r.controllerNotifiedAt),
      subjectsNotifiedAt: iso(r.subjectsNotifiedAt),
      remediationSummary: r.remediationSummary,
      lessonsLearned: r.lessonsLearned,
      reportedBy: r.reportedBy,
      closedBy: r.closedBy,
      timeline: r.events.map((e) => ({
        id: e.id,
        type: e.type,
        fromStatus: e.fromStatus,
        toStatus: e.toStatus,
        note: e.note,
        occurredAt: e.occurredAt.toISOString(),
        actor: e.actor,
        evidence: e.evidence ? campaignFile(e.evidence) : null,
        createdAt: e.createdAt.toISOString(),
      })),
      createdAt: r.createdAt.toISOString(),
      updatedAt: r.updatedAt.toISOString(),
      allowedActions: allowed,
    };
  }

  get(auth: AuthContext, id: string): Promise<BreachDetail> {
    return this.prisma.tenantTx(async (tx) => this.detail(auth, await this.load(tx, id)));
  }

  create(auth: AuthContext, body: CreateBreach): Promise<BreachDetail> {
    return this.prisma.tenantTx(async (tx) => {
      await assertActiveUsers(tx, [body.ownerId], 'ownerId');
      const config = await this.modules.campaignConfig(tx);
      const reference = await nextReference(tx, auth.tenantId, 'BRE', campaignReferenceYear(config));
      const detectedAt = new Date(body.detectedAt);
      const row = await tx.breachRecord.create({
        data: {
          tenantId: auth.tenantId,
          reference,
          title: body.title,
          description: body.description,
          isDrill: body.isDrill,
          severity: body.severity,
          detectedAt,
          dataCategories: body.dataCategories,
          estimatedSubjects: body.estimatedSubjects ?? null,
          systemsAffected: body.systemsAffected ?? null,
          ownerId: body.ownerId ?? null,
          reportedById: auth.userId,
        },
      });
      await tx.breachEvent.create({
        data: { tenantId: auth.tenantId, breachId: row.id, type: 'DETECTED', fromStatus: null, toStatus: 'DETECTED', note: body.isDrill ? 'Drill recorded' : 'Breach recorded', occurredAt: detectedAt, actorId: auth.userId },
      });
      await this.audit.record(
        {
          tenantId: auth.tenantId,
          action: AUDIT_ACTIONS.BREACH_RECORDED,
          entityType: CAMPAIGN_ENTITY.BREACH,
          entityId: row.id,
          after: { reference, isDrill: row.isDrill, severity: row.severity, detectedAt: row.detectedAt, dataCategories: row.dataCategories, estimatedSubjects: row.estimatedSubjects },
        },
        tx,
      );
      const critical = body.severity === 'HIGH' || body.severity === 'CRITICAL';
      const managers = await usersWithPermission(tx, 'security.breach.manage', { exclude: [auth.userId] });
      await this.notifications.notify(tx, {
        tenantId: auth.tenantId,
        userIds: managers,
        module: 'security',
        type: critical ? 'security.critical_alert' : 'security.breach_recorded',
        title: `${body.isDrill ? '[DRILL] ' : ''}${critical ? 'Critical security alert' : 'Breach recorded'}: ${reference}`,
        body: `${reference} (${body.severity.toLowerCase()} severity) was recorded and needs assessment.`,
        link: `/security/breaches/${row.id}`,
        severity: critical ? 'CRITICAL' : 'WARNING',
        requiresAck: critical,
        entityType: CAMPAIGN_ENTITY.BREACH,
        entityId: row.id,
      });
      return this.detail(auth, await this.load(tx, row.id));
    });
  }

  update(auth: AuthContext, id: string, body: UpdateBreach): Promise<BreachDetail> {
    return this.prisma.tenantTx(async (tx) => {
      const cur = await this.load(tx, id);
      if (cur.status === 'CLOSED') throw AppException.conflict('Reopen the record before changing it', { reason: 'CLOSED' });
      checkVersion(cur, body.expectedVersion, this.detail(auth, cur));
      await assertActiveUsers(tx, [body.ownerId], 'ownerId');
      const { expectedVersion, ...fields } = body;
      const data: Prisma.BreachRecordUncheckedUpdateManyInput = { version: { increment: 1 } };
      for (const [k, v] of Object.entries(fields)) if (v !== undefined) (data as Record<string, unknown>)[k] = v;
      const r = await tx.breachRecord.updateMany({ where: { id, version: expectedVersion }, data });
      if (r.count === 0) throw AppException.conflict('This record was changed by someone else. Reload and try again.', { currentVersion: cur.version });
      await this.audit.record(
        {
          tenantId: auth.tenantId,
          action: AUDIT_ACTIONS.BREACH_UPDATED,
          entityType: CAMPAIGN_ENTITY.BREACH,
          entityId: id,
          before: pick(cur, Object.keys(fields)),
          after: fields,
        },
        tx,
      );
      return this.detail(auth, await this.load(tx, id));
    });
  }

  addEvent(auth: AuthContext, id: string, body: AddBreachEvent): Promise<BreachDetail> {
    return this.prisma.tenantTx(async (tx) => {
      const cur = await this.load(tx, id);
      const manage = auth.permissions.has('security.breach.manage');
      if (!manage && body.type !== 'NOTE') throw AppException.forbidden('Only breach managers can move the record through its steps');
      checkVersion(cur, body.expectedVersion, this.detail(auth, cur));
      if (body.evidenceFileId) await assertOwnFiles(tx, auth.userId, [body.evidenceFileId], 'BREACH_EVIDENCE', 'evidenceFileId');
      const occurredAt = body.occurredAt ? new Date(body.occurredAt) : new Date();
      if (occurredAt.getTime() > Date.now() + 5 * 60_000) throw AppException.validation('A step cannot be in the future', [{ path: ['occurredAt'], message: 'In the future' }]);
      const to = breachStatusFor(body.type);
      if (cur.status === 'CLOSED' && body.type !== 'REOPENED' && body.type !== 'NOTE') {
        throw AppException.invalidTransition(cur.status, to ?? body.type);
      }
      const data: Prisma.BreachRecordUncheckedUpdateInput = { version: { increment: 1 } };
      if (to && to !== cur.status) {
        if (!canTransitionBreach(cur.status, to)) throw AppException.invalidTransition(cur.status, to);
        data.status = to;
      } else if (to && to === cur.status && to !== 'NOTIFIED') {
        throw AppException.invalidTransition(cur.status, to);
      }
      switch (body.type) {
        case 'CONTROLLER_NOTIFIED':
          data.controllerNotifiedAt = occurredAt;
          break;
        case 'REGULATOR_NOTIFIED':
          data.regulatorNotifiedAt = occurredAt;
          break;
        case 'SUBJECTS_NOTIFIED':
          data.subjectsNotifiedAt = occurredAt;
          break;
        case 'NOTIFICATION_NOT_REQUIRED':
          if (cur.status !== 'ASSESSED') throw AppException.invalidTransition(cur.status, 'NOTIFICATION_NOT_REQUIRED');
          if (!cur.notificationDecision) {
            throw AppException.validation('Record the notification decision and its basis first', [{ path: ['notificationDecision'], message: 'Required' }]);
          }
          break;
        case 'LESSONS_RECORDED':
          if (!cur.lessonsLearned) data.lessonsLearned = body.note;
          break;
        case 'CLOSED':
          if (!cur.lessonsLearned) throw AppException.validation('Document the lessons learned before closing', [{ path: ['lessonsLearned'], message: 'Required' }]);
          if (cur.reportedById === auth.userId) throw AppException.separationOfDuties('The person who reported a breach cannot close it');
          data.closedAt = occurredAt;
          data.closedById = auth.userId;
          break;
        case 'REOPENED':
          if (cur.status !== 'CLOSED') throw AppException.invalidTransition(cur.status, 'ASSESSED');
          data.closedAt = null;
          data.closedById = null;
          break;
        default:
          break;
      }
      const r = await tx.breachRecord.updateMany({ where: { id, version: cur.version }, data: data as Prisma.BreachRecordUncheckedUpdateManyInput });
      if (r.count === 0) throw AppException.conflict('This record was changed by someone else. Reload and try again.', { currentVersion: cur.version });
      await tx.breachEvent.create({
        data: {
          tenantId: auth.tenantId,
          breachId: id,
          type: body.type,
          fromStatus: cur.status,
          toStatus: (data.status as BreachRow['status'] | undefined) ?? cur.status,
          note: body.note,
          occurredAt,
          actorId: auth.userId,
          evidenceFileId: body.evidenceFileId ?? null,
        },
      });
      await this.audit.record(
        {
          tenantId: auth.tenantId,
          action: AUDIT_ACTIONS.BREACH_EVENT_ADDED,
          entityType: CAMPAIGN_ENTITY.BREACH,
          entityId: id,
          after: { type: body.type, occurredAt, evidenceFileId: body.evidenceFileId ?? null },
        },
        tx,
      );
      if (data.status) {
        await this.audit.record(
          {
            tenantId: auth.tenantId,
            action: AUDIT_ACTIONS.BREACH_STATUS_CHANGED,
            entityType: CAMPAIGN_ENTITY.BREACH,
            entityId: id,
            before: { status: cur.status },
            after: { status: data.status, closedById: data.closedById ?? null },
            reason: body.note,
          },
          tx,
        );
      }
      return this.detail(auth, await this.load(tx, id));
    });
  }

  exportTimeline(auth: AuthContext, id: string, body: ExportBreachTimeline): Promise<SignedUrlResponse> {
    return this.prisma.tenantTx(
      async (tx) => {
        const r = await this.load(tx, id);
        const generatedAt = new Date();
        const title = `${r.isDrill ? '[DRILL] ' : ''}Breach timeline ${r.reference}`;
        const header = {
          title,
          generatedAt,
          generatedBy: auth.displayName,
          filtersDescription: `Breach ${r.reference}`,
          appliedScope: 'Organisation (breach register)',
          classification: 'CONFIDENTIAL' as const,
          disclaimer: r.isDrill ? 'This is a DRILL record, not a real incident.' : null,
          extraLines: [
            `Title: ${r.title}`,
            `Status: ${BREACH_STATUS_LABELS[r.status]}; severity ${r.severity}`,
            `Detected: ${r.detectedAt.toISOString()}`,
            `Data categories: ${r.dataCategories.join(', ') || 'not recorded'}; estimated people affected: ${r.estimatedSubjects ?? 'unknown'}`,
            `Notification decision: ${r.notificationDecision ?? 'not recorded'}`,
            `Lessons learned: ${r.lessonsLearned ?? 'not recorded'}`,
          ],
        };
        const rows = r.events.map((e) => [e.occurredAt.toISOString(), e.type, e.fromStatus ?? '', e.toStatus ?? '', e.actor.displayName, e.note, e.evidence ? e.evidence.sha256 : '']);
        const file = await storeExport(
          this.storage,
          tx,
          auth,
          header,
          [{ name: 'Timeline', header: ['Occurred at (UTC)', 'Step', 'From', 'To', 'Recorded by', 'Note', 'Evidence SHA-256'], rows }],
          body.format,
          `breach-${r.reference}`,
        );
        const exp = await tx.reportExport.create({
          data: {
            tenantId: auth.tenantId,
            datasetKey: 'security.breaches',
            format: body.format,
            fields: ['occurredAt', 'type', 'fromStatus', 'toStatus', 'actor', 'note', 'evidenceSha256'],
            definition: { breachId: r.id, reference: r.reference },
            filtersDescription: header.filtersDescription,
            appliedScope: header.appliedScope,
            classification: 'CONFIDENTIAL',
            sensitive: true,
            rowCount: rows.length,
            fileId: file.id,
            sha256: file.sha256,
            reason: body.reason,
            reauthAt: auth.reauthAt ? new Date(auth.reauthAt * 1000) : null,
            generatedById: auth.userId,
            generatedAt,
          },
        });
        await this.audit.record(
          {
            tenantId: auth.tenantId,
            action: AUDIT_ACTIONS.BREACH_TIMELINE_EXPORTED,
            entityType: CAMPAIGN_ENTITY.BREACH,
            entityId: r.id,
            after: { exportId: exp.id, format: body.format, rows: rows.length, sha256: file.sha256, isDrill: r.isDrill },
            reason: body.reason,
          },
          tx,
        );
        const { url, expiresAt } = await this.storage.signedUrl(file, 'attachment');
        return { url, expiresAt: expiresAt.toISOString(), sha256: file.sha256 };
      },
      { timeout: 60_000 },
    );
  }

  upload(auth: AuthContext, file: CampaignUpload | undefined): Promise<CampaignFile> {
    return this.prisma.tenantTx(async (tx) => (await storeCampaignUpload(this.storage, tx, auth, file, 'BREACH_EVIDENCE')).file);
  }

  evidenceUrl(auth: AuthContext, id: string, eventId: string): Promise<SignedUrlResponse> {
    return this.prisma.tenantTx(async (tx) => {
      const e = await tx.breachEvent.findFirst({ where: { id: eventId, breachId: id }, include: { evidence: true } });
      if (!e?.evidence) throw AppException.notFound('Evidence not found');
      return auditedSignedUrl(this.storage, this.audit, tx, auth, e.evidence, { type: CAMPAIGN_ENTITY.BREACH, id });
    });
  }
}

function toSummary(r: {
  id: string;
  reference: string;
  title: string;
  isDrill: boolean;
  status: BreachSummary['status'];
  severity: BreachSummary['severity'];
  detectedAt: Date;
  owner: { id: string; displayName: string } | null;
  regulatorNotifiedAt: Date | null;
  closedAt: Date | null;
  version: number;
}): BreachSummary {
  return {
    id: r.id,
    reference: r.reference,
    title: r.title,
    isDrill: r.isDrill,
    status: r.status,
    severity: r.severity,
    detectedAt: r.detectedAt.toISOString(),
    owner: r.owner,
    regulatorNotifiedAt: iso(r.regulatorNotifiedAt),
    closedAt: iso(r.closedAt),
    version: r.version,
  };
}

function pick(o: object, keys: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of keys) out[k] = (o as Record<string, unknown>)[k];
  return out;
}

import { Injectable } from '@nestjs/common';
import { nextReference, type Prisma, sha256Hex, type TenantTx } from '@ngao360/db';
import {
  AUDIT_ACTIONS,
  canTransitionContent,
  type ContentDetail,
  type ContentQuery,
  type ContentRevisionKind,
  type ContentStatus,
  type ContentSummary,
  type ContentTransition,
  type CorrectContent,
  type CreateContent,
  type Paginated,
  type UpdateContent,
} from '@ngao360/shared';
import { AuditService } from '../../../audit/audit.service';
import type { AuthContext } from '../../../auth/auth.types';
import { AppException } from '../../../common/http/app-exception';
import { PrismaService } from '../../../prisma/prisma.service';
import { TenantModulesService } from '../../../tenant-modules/tenant-modules.service';
import { CAMPAIGN_ENTITY } from '../campaign.constants';
import {
  assertRecentReauth,
  campaignReferenceYear,
  type CampaignScope,
  contentScopeWhere,
  eventScopeWhere,
  immutable,
  iso,
  loadCampaignScope,
  pageArgs,
  staleVersion,
  usersWithPermission,
} from '../common';
import { NotificationCenterService } from '../notifications/notification-center.service';

const USER = { select: { id: true, displayName: true } } as const;
const DEPT = { select: { id: true, code: true, name: true } } as const;
const SUMMARY_INCLUDE = { department: DEPT, author: USER, editor: USER, approver: USER } satisfies Prisma.ContentItemInclude;
const DETAIL_INCLUDE = { ...SUMMARY_INCLUDE, publishedBy: USER, revisions: { include: { actor: USER }, orderBy: { createdAt: 'asc' } } } satisfies Prisma.ContentItemInclude;
type SummaryRow = Prisma.ContentItemGetPayload<{ include: typeof SUMMARY_INCLUDE }>;
type DetailRow = Prisma.ContentItemGetPayload<{ include: typeof DETAIL_INCLUDE }>;

/**
 * Communications content workflow (blueprint 5.4; docs/API_CONTRACT.md §26):
 * draft → editorial review → authorised approval → publication → archive,
 * with an append-only revision and correction history. Author ≠ approver
 * (403, DB check). Publication only records that an item went out on a broad
 * audience channel: there are no recipient lists, voter data, targeting or
 * bulk messages (the controller refuses recipient-list fields).
 */
@Injectable()
export class CommsService {
  constructor(
    readonly prisma: PrismaService,
    readonly audit: AuditService,
    readonly modules: TenantModulesService,
    private readonly notifications: NotificationCenterService,
  ) {}

  private summary(c: SummaryRow): ContentSummary {
    return {
      id: c.id,
      reference: c.reference,
      type: c.type,
      title: c.title,
      status: c.status,
      audience: c.audience,
      department: c.department,
      author: c.author,
      editor: c.editor,
      approver: c.approver,
      publishedAt: iso(c.publishedAt),
      revision: c.revision,
      correctionCount: c.correctionCount,
      updatedAt: c.updatedAt.toISOString(),
      version: c.version,
    };
  }

  private allowed(auth: AuthContext, c: { status: ContentStatus; authorId: string }): ContentDetail['allowedActions'] {
    const p = (k: Parameters<typeof auth.permissions.has>[0]) => auth.permissions.has(k);
    const author = c.authorId === auth.userId;
    const out: ContentDetail['allowedActions'] = [];
    if (c.status === 'DRAFT' && author && p('comms.content.draft')) out.push('EDIT', 'SUBMIT');
    if (c.status === 'EDITORIAL_REVIEW' && !author && p('comms.content.edit')) out.push('EDIT', 'EDITORIAL_APPROVE', 'RETURN');
    if (c.status === 'AWAITING_APPROVAL' && !author && p('comms.content.approve')) out.push('APPROVE', 'RETURN');
    if (c.status === 'APPROVED' && p('comms.content.publish')) out.push('PUBLISH');
    if (c.status === 'APPROVED' && (p('comms.content.edit') || p('comms.content.approve'))) out.push('RETURN');
    if (c.status === 'PUBLISHED' && p('comms.content.publish')) out.push('ARCHIVE');
    if (c.status === 'PUBLISHED' && p('comms.content.approve')) out.push('WITHDRAW');
    if (c.status === 'PUBLISHED' && p('comms.content.approve') && !author) out.push('CORRECT');
    return [...new Set(out)];
  }

  private detail(auth: AuthContext, c: DetailRow): ContentDetail {
    return {
      ...this.summary(c),
      summary: c.summary,
      body: c.body,
      eventId: c.eventId,
      scheduledFor: iso(c.scheduledFor),
      publishedBy: c.publishedBy,
      archivedAt: iso(c.archivedAt),
      revisions: c.revisions.map((r) => ({
        id: r.id,
        kind: r.kind,
        revision: r.revision,
        title: r.title,
        body: r.body,
        bodySha256: r.bodySha256,
        fromStatus: r.fromStatus,
        toStatus: r.toStatus,
        note: r.note,
        actor: r.actor,
        createdAt: r.createdAt.toISOString(),
      })),
      createdAt: c.createdAt.toISOString(),
      allowedActions: this.allowed(auth, c),
    };
  }

  /** Load one item inside the caller's department scope (404 outside). */
  private async load(tx: TenantTx, scope: CampaignScope, id: string): Promise<DetailRow> {
    const c = await tx.contentItem.findUnique({ where: { id }, include: DETAIL_INCLUDE });
    // Content has no geography: involvement OR department (contentScopeWhere).
    if (!c || !this.inDepartmentScope(scope, c)) throw AppException.notFound('Content not found');
    return c;
  }

  private inDepartmentScope(scope: CampaignScope, c: { departmentId: string | null; authorId: string; editorId: string | null; approverId: string | null }): boolean {
    if (!scope.held) return false;
    if ([c.authorId, c.editorId, c.approverId].includes(scope.userId)) return true;
    return scope.allDepartments || (!!c.departmentId && scope.departmentIds.includes(c.departmentId));
  }

  private revision(tx: TenantTx, auth: AuthContext, c: { id: string; title: string; body: string }, kind: ContentRevisionKind, revision: number, from: ContentStatus | null, to: ContentStatus | null, note?: string | null) {
    return tx.contentRevision.create({
      data: { tenantId: auth.tenantId, contentId: c.id, kind, revision, title: c.title, body: c.body, bodySha256: sha256Hex(c.body), fromStatus: from, toStatus: to, note: note ?? null, actorId: auth.userId },
    });
  }

  list(auth: AuthContext, q: ContentQuery): Promise<Paginated<ContentSummary>> {
    return this.prisma.tenantTx(async (tx) => {
      const scope = await loadCampaignScope(tx, auth, 'comms.content.view');
      const me = auth.userId;
      const p = (k: Parameters<typeof auth.permissions.has>[0]) => auth.permissions.has(k);
      let view: Prisma.ContentItemWhereInput = {};
      if (q.view === 'mine') view = { authorId: me };
      if (q.view === 'awaiting_me') {
        const ors: Prisma.ContentItemWhereInput[] = [];
        if (p('comms.content.edit')) ors.push({ status: 'EDITORIAL_REVIEW', authorId: { not: me } });
        if (p('comms.content.approve')) ors.push({ status: 'AWAITING_APPROVAL', authorId: { not: me } });
        if (p('comms.content.publish')) ors.push({ status: 'APPROVED' });
        view = ors.length ? { OR: ors } : { id: { in: [] } };
      }
      const where: Prisma.ContentItemWhereInput = {
        AND: [
          contentScopeWhere(scope) ?? {},
          view,
          q.status ? { status: { in: Array.isArray(q.status) ? q.status : [q.status] } } : {},
          q.type ? { type: q.type } : {},
          q.audience ? { audience: q.audience } : {},
          q.departmentId ? { departmentId: q.departmentId } : {},
          q.q ? { OR: [{ title: { contains: q.q, mode: 'insensitive' } }, { reference: { contains: q.q, mode: 'insensitive' } }] } : {},
        ],
      };
      const [rows, total] = await Promise.all([
        tx.contentItem.findMany({ where, include: SUMMARY_INCLUDE, orderBy: [{ updatedAt: q.order }, { id: 'asc' }], ...pageArgs(q) }),
        tx.contentItem.count({ where }),
      ]);
      return { items: rows.map((r) => this.summary(r)), page: q.page, pageSize: q.pageSize, total };
    });
  }

  get(auth: AuthContext, id: string): Promise<ContentDetail> {
    return this.prisma.tenantTx(async (tx) => this.detail(auth, await this.load(tx, await loadCampaignScope(tx, auth, 'comms.content.view'), id)));
  }

  private async checkLinks(tx: TenantTx, auth: AuthContext, scope: CampaignScope, b: { departmentId?: string | null; eventId?: string | null }) {
    if (b.departmentId) {
      if (!(await tx.department.findUnique({ where: { id: b.departmentId } }))) throw AppException.validation('Unknown department', [{ path: ['departmentId'], message: 'Unknown' }]);
      if (!scope.allDepartments && !scope.departmentIds.includes(b.departmentId)) throw AppException.outOfScope('This department is not one of yours');
    }
    if (b.eventId) {
      const evScope = await loadCampaignScope(tx, auth, 'events.view');
      const visible = evScope.held && (await tx.campaignEvent.count({ where: { AND: [{ id: b.eventId }, eventScopeWhere(evScope) ?? {}] } })) > 0;
      if (!visible) throw AppException.validation('Link an event you can see', [{ path: ['eventId'], message: 'Unknown event' }]);
    }
  }

  create(auth: AuthContext, body: CreateContent): Promise<ContentDetail> {
    return this.prisma.tenantTx(async (tx) => {
      const scope = await loadCampaignScope(tx, auth, 'comms.content.view');
      await this.checkLinks(tx, auth, scope, body);
      const config = await this.modules.campaignConfig(tx);
      const reference = await nextReference(tx, auth.tenantId, 'CNT', campaignReferenceYear(config));
      const c = await tx.contentItem.create({
        data: {
          tenantId: auth.tenantId,
          reference,
          type: body.type,
          title: body.title,
          summary: body.summary ?? null,
          body: body.body,
          audience: body.audience,
          departmentId: body.departmentId ?? null,
          eventId: body.eventId ?? null,
          scheduledFor: body.scheduledFor ? new Date(body.scheduledFor) : null,
          authorId: auth.userId,
        },
      });
      await this.revision(tx, auth, c, 'CREATED', 1, null, 'DRAFT');
      await this.audit.record(
        { tenantId: auth.tenantId, action: AUDIT_ACTIONS.CONTENT_CREATED, entityType: CAMPAIGN_ENTITY.CONTENT, entityId: c.id, after: { reference, type: c.type, audience: c.audience, departmentId: c.departmentId, bodySha256: sha256Hex(c.body) } },
        tx,
      );
      return this.detail(auth, await this.load(tx, scope, c.id));
    });
  }

  update(auth: AuthContext, id: string, body: UpdateContent): Promise<ContentDetail> {
    return this.prisma.tenantTx(async (tx) => {
      const scope = await loadCampaignScope(tx, auth, 'comms.content.view');
      const cur = await this.load(tx, scope, id);
      const author = cur.authorId === auth.userId;
      if (cur.status === 'DRAFT') {
        if (!author || !auth.permissions.has('comms.content.draft')) throw AppException.forbidden('Only the author edits a draft');
      } else if (cur.status === 'EDITORIAL_REVIEW') {
        if (!auth.permissions.has('comms.content.edit')) throw AppException.forbidden(undefined, { required: ['comms.content.edit'] });
        if (author) throw AppException.separationOfDuties('The author cannot do the editorial review of their own content');
      } else {
        throw immutable('Content can only be edited in draft or editorial review; published content changes only by a correction');
      }
      if (cur.version !== body.expectedVersion) throw staleVersion(cur.version, this.detail(auth, cur));
      await this.checkLinks(tx, auth, scope, body);
      const textChanged = (body.title !== undefined && body.title !== cur.title) || (body.body !== undefined && body.body !== cur.body);
      const nextRevision = textChanged ? cur.revision + 1 : cur.revision;
      const data: Prisma.ContentItemUncheckedUpdateManyInput = {
        ...(body.title !== undefined ? { title: body.title } : {}),
        ...(body.summary !== undefined ? { summary: body.summary } : {}),
        ...(body.body !== undefined ? { body: body.body } : {}),
        ...(body.audience !== undefined ? { audience: body.audience } : {}),
        ...(body.departmentId !== undefined ? { departmentId: body.departmentId } : {}),
        ...(body.eventId !== undefined ? { eventId: body.eventId } : {}),
        ...(body.scheduledFor !== undefined ? { scheduledFor: body.scheduledFor ? new Date(body.scheduledFor) : null } : {}),
        revision: nextRevision,
        version: { increment: 1 },
      };
      const r = await tx.contentItem.updateMany({ where: { id, version: body.expectedVersion, status: cur.status }, data });
      if (r.count === 0) throw staleVersion(cur.version, null);
      if (textChanged) {
        await this.revision(tx, auth, { id, title: body.title ?? cur.title, body: body.body ?? cur.body }, 'EDITED', nextRevision, cur.status, cur.status, body.note);
      }
      await this.audit.record(
        {
          tenantId: auth.tenantId,
          action: AUDIT_ACTIONS.CONTENT_UPDATED,
          entityType: CAMPAIGN_ENTITY.CONTENT,
          entityId: id,
          before: { revision: cur.revision, bodySha256: sha256Hex(cur.body), audience: cur.audience },
          after: { revision: nextRevision, bodySha256: sha256Hex(body.body ?? cur.body), fields: Object.keys(body).filter((k) => k !== 'expectedVersion') },
          reason: body.note ?? null,
        },
        tx,
      );
      return this.detail(auth, await this.load(tx, scope, id));
    });
  }

  transition(auth: AuthContext, id: string, body: ContentTransition): Promise<ContentDetail> {
    return this.prisma.tenantTx(async (tx) => {
      const scope = await loadCampaignScope(tx, auth, 'comms.content.view');
      const cur = await this.load(tx, scope, id);
      const config = await this.modules.campaignConfig(tx);
      const p = (k: Parameters<typeof auth.permissions.has>[0]) => auth.permissions.has(k);
      const author = cur.authorId === auth.userId;
      const now = new Date();
      let to: ContentStatus;
      let kind: ContentRevisionKind;
      const data: Prisma.ContentItemUncheckedUpdateManyInput = { version: { increment: 1 } };
      const need = (k: Parameters<typeof auth.permissions.has>[0]) => {
        if (!p(k)) throw AppException.forbidden(undefined, { required: [k] });
      };
      switch (body.action) {
        case 'SUBMIT':
          need('comms.content.draft');
          if (!author) throw AppException.forbidden('Only the author submits their content');
          to = config.comms.requireEditorialReview ? 'EDITORIAL_REVIEW' : 'AWAITING_APPROVAL';
          kind = 'SUBMITTED_FOR_REVIEW';
          break;
        case 'EDITORIAL_APPROVE':
          need('comms.content.edit');
          if (author) throw AppException.separationOfDuties('The author cannot do the editorial review of their own content');
          to = 'AWAITING_APPROVAL';
          kind = 'EDITORIAL_APPROVED';
          data.editorId = auth.userId;
          break;
        case 'RETURN':
          if (!p('comms.content.edit') && !p('comms.content.approve')) throw AppException.forbidden(undefined, { required: ['comms.content.edit', 'comms.content.approve'] });
          if (author && cur.status !== 'APPROVED') throw AppException.separationOfDuties('The author cannot review their own content');
          to = 'DRAFT';
          kind = 'RETURNED';
          break;
        case 'APPROVE':
          need('comms.content.approve');
          if (author) throw AppException.separationOfDuties('The author cannot approve their own content');
          assertRecentReauth(auth);
          to = 'APPROVED';
          kind = 'APPROVED';
          Object.assign(data, { approverId: auth.userId, approvedAt: now });
          break;
        case 'PUBLISH':
          need('comms.content.publish');
          to = 'PUBLISHED';
          kind = 'PUBLISHED';
          Object.assign(data, { publishedById: auth.userId, ...(cur.publishedAt ? {} : { publishedAt: now }) });
          break;
        case 'ARCHIVE':
          need('comms.content.publish');
          to = 'ARCHIVED';
          kind = 'ARCHIVED';
          data.archivedAt = now;
          break;
        case 'WITHDRAW':
          need('comms.content.approve');
          to = 'WITHDRAWN';
          kind = 'WITHDRAWN';
          data.withdrawnAt = now;
          break;
      }
      if (!canTransitionContent(cur.status, to)) throw AppException.invalidTransition(cur.status, to);
      if (body.action === 'RETURN' && cur.status === 'DRAFT') throw AppException.invalidTransition(cur.status, to);
      if (cur.version !== body.expectedVersion) throw staleVersion(cur.version, this.detail(auth, cur));
      data.status = to;
      const r = await tx.contentItem.updateMany({ where: { id, version: body.expectedVersion, status: cur.status }, data });
      if (r.count === 0) throw staleVersion(cur.version, null);
      await this.revision(tx, auth, cur, kind, cur.revision, cur.status, to, body.note);
      await this.audit.record(
        {
          tenantId: auth.tenantId,
          action: AUDIT_ACTIONS.CONTENT_STATUS_CHANGED,
          entityType: CAMPAIGN_ENTITY.CONTENT,
          entityId: id,
          before: { status: cur.status },
          after: { status: to, action: body.action, revision: cur.revision, approverId: data.approverId ?? cur.approverId, editorId: data.editorId ?? cur.editorId },
          reason: body.note ?? null,
        },
        tx,
      );
      const base = { tenantId: auth.tenantId, module: 'comms', link: `/comms/${id}`, entityType: CAMPAIGN_ENTITY.CONTENT, entityId: id };
      if (to === 'EDITORIAL_REVIEW') {
        await this.notifications.notify(tx, { ...base, userIds: await usersWithPermission(tx, 'comms.content.edit', { exclude: [cur.authorId] }), type: 'content.review_requested', title: `Editorial review: ${cur.reference}`, body: `${cur.reference} is ready for editorial review.` });
      } else if (to === 'AWAITING_APPROVAL') {
        await this.notifications.notify(tx, { ...base, userIds: await usersWithPermission(tx, 'comms.content.approve', { exclude: [cur.authorId] }), type: 'content.approval_requested', title: `Approval requested: ${cur.reference}`, body: `${cur.reference} is awaiting approval.` });
      } else if (body.action === 'RETURN') {
        await this.notifications.notify(tx, { ...base, userIds: [cur.authorId], type: 'content.returned', title: `Returned: ${cur.reference}`, body: `${cur.reference} was returned to draft. See the note in its history.` });
      } else if (to === 'PUBLISHED') {
        await this.notifications.notify(tx, { ...base, userIds: [cur.authorId].filter((u) => u !== auth.userId), type: 'content.published', title: `Published: ${cur.reference}`, body: `${cur.reference} was recorded as published.` });
      }
      return this.detail(auth, await this.load(tx, scope, id));
    });
  }

  correct(auth: AuthContext, id: string, body: CorrectContent): Promise<ContentDetail> {
    return this.prisma.tenantTx(async (tx) => {
      const scope = await loadCampaignScope(tx, auth, 'comms.content.view');
      const cur = await this.load(tx, scope, id);
      if (cur.authorId === auth.userId) throw AppException.separationOfDuties('The author cannot record a correction of their own content');
      if (cur.status !== 'PUBLISHED') throw AppException.invalidTransition(cur.status, 'CORRECTED');
      if (cur.version !== body.expectedVersion) throw staleVersion(cur.version, this.detail(auth, cur));
      const next = cur.revision + 1;
      const title = body.title ?? cur.title;
      const r = await tx.contentItem.updateMany({
        where: { id, version: body.expectedVersion, status: 'PUBLISHED' },
        data: { title, body: body.body, revision: next, correctionCount: { increment: 1 }, version: { increment: 1 } },
      });
      if (r.count === 0) throw staleVersion(cur.version, null);
      await this.revision(tx, auth, { id, title, body: body.body }, 'CORRECTED', next, 'PUBLISHED', 'PUBLISHED', body.correctionNote);
      await this.audit.record(
        {
          tenantId: auth.tenantId,
          action: AUDIT_ACTIONS.CONTENT_CORRECTED,
          entityType: CAMPAIGN_ENTITY.CONTENT,
          entityId: id,
          before: { revision: cur.revision, bodySha256: sha256Hex(cur.body), correctionCount: cur.correctionCount },
          after: { revision: next, bodySha256: sha256Hex(body.body), correctionCount: cur.correctionCount + 1 },
          reason: body.correctionNote,
        },
        tx,
      );
      return this.detail(auth, await this.load(tx, scope, id));
    });
  }
}

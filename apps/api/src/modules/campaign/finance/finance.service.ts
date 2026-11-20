import { HttpStatus, Injectable } from '@nestjs/common';
import { nextReference, type Prisma, type TenantTx } from '@ngao360/db';
import {
  type AddFinanceDocument,
  AUDIT_ACTIONS,
  type CampaignFile,
  type CampaignModuleConfig,
  canTransitionFinanceTransaction,
  type ComplianceFinding,
  complianceBlocks,
  type CreateFinanceTransaction,
  ERROR_CODES,
  type FinanceDocument,
  type FinanceExportRequest,
  financeApprovalBlockers,
  type FinanceLedgerQuery,
  type FinanceLedgerSummary,
  financeSodViolation,
  type FinanceTransactionDetail,
  type FinanceTransactionQuery,
  type FinanceTransactionStatus,
  type FinanceTransactionSummary,
  type FinanceTransition,
  type Paginated,
  type ReportDefinition,
  type ReverseFinanceTransaction,
  type SignedUrlResponse,
  UNVERIFIED_LIMIT_LABEL,
  type UpdateFinanceTransaction,
} from '@ngao360/shared';
import { AuditService } from '../../../audit/audit.service';
import type { AuthContext } from '../../../auth/auth.types';
import { AppException } from '../../../common/http/app-exception';
import { PrismaService } from '../../../prisma/prisma.service';
import { StorageService } from '../../../storage/storage.service';
import { TenantModulesService } from '../../../tenant-modules/tenant-modules.service';
import { CAMPAIGN_ENTITY } from '../campaign.constants';
import {
  assertOwnFiles,
  assertRecentReauth,
  auditedSignedUrl,
  type CampaignUpload,
  campaignFile,
  campaignReferenceYear,
  exportCell,
  FILE_INCLUDE,
  iso,
  isoDate,
  minorToNumber,
  numberToMinor,
  pageArgs,
  staleVersion,
  storeCampaignUpload,
  storeExport,
  usersWithPermission,
} from '../common';
import { NotificationCenterService } from '../notifications/notification-center.service';
import { ReportBuilderService } from '../reports/report-builder.service';
import { currentFindings, evaluateEntry, flagsOf, loadLimitSettings, POSTED_NET, settingsChangedBy } from './finance-compliance';

const USER = { select: { id: true, displayName: true } } as const;
const SUMMARY_INCLUDE = {
  account: { select: { id: true, name: true } },
  counterAccount: { select: { id: true, name: true } },
  category: { select: { id: true, code: true, name: true } },
  payee: { select: { id: true, name: true } },
  contributionSource: { select: { id: true, displayName: true } },
  department: { select: { id: true, code: true, name: true } },
  requestedBy: USER,
  approvedBy: USER,
  paidBy: USER,
  reversals: { select: { id: true, status: true } },
  _count: { select: { documents: true } },
} satisfies Prisma.FinanceTransactionInclude;
const DETAIL_INCLUDE = {
  ...SUMMARY_INCLUDE,
  budgetLine: { select: { id: true, code: true, name: true } },
  rejectedBy: USER,
  documents: { include: { file: FILE_INCLUDE, addedBy: USER }, orderBy: { createdAt: 'asc' } },
  events: { include: { actor: USER }, orderBy: { createdAt: 'asc' } },
} satisfies Prisma.FinanceTransactionInclude;
type SummaryRow = Prisma.FinanceTransactionGetPayload<{ include: typeof SUMMARY_INCLUDE }>;
type DetailRow = Prisma.FinanceTransactionGetPayload<{ include: typeof DETAIL_INCLUDE }>;

/** The live reversal of an entry: a REJECTED or CANCELLED reversal no longer counts. */
export function liveReversal(t: { reversals: ReadonlyArray<{ id: string; status: string }> }): { id: string; status: string } | null {
  return t.reversals.find((r) => r.status !== 'REJECTED' && r.status !== 'CANCELLED') ?? null;
}

const CATEGORY_KIND: Record<string, 'INCOME' | 'EXPENSE' | 'TRANSFER'> = { CONTRIBUTION: 'INCOME', EXPENSE: 'EXPENSE', REFUND: 'EXPENSE', TRANSFER: 'TRANSFER' };

/** Posted balance effect of one entry on each account (reversals net out: REVERSED and REVERSAL rows are not counted). */
export async function accountBalances(tx: TenantTx): Promise<Map<string, bigint>> {
  const rows = await tx.financeTransaction.groupBy({
    by: ['accountId', 'counterAccountId', 'type'],
    where: { status: { in: [...POSTED_NET] }, type: { not: 'REVERSAL' } },
    _sum: { amountMinor: true },
  });
  const out = new Map<string, bigint>();
  const add = (id: string | null, v: bigint) => id && out.set(id, (out.get(id) ?? 0n) + v);
  for (const r of rows) {
    const v = r._sum.amountMinor ?? 0n;
    if (r.type === 'CONTRIBUTION') add(r.accountId, v);
    else if (r.type === 'EXPENSE' || r.type === 'REFUND') add(r.accountId, -v);
    else if (r.type === 'TRANSFER') {
      add(r.accountId, -v);
      add(r.counterAccountId, v);
    }
  }
  return out;
}

function sod(message: string): AppException {
  return AppException.separationOfDuties(message);
}

/**
 * Finance ledger (blueprint 5, 14 "Finance transaction", 15.3; docs/API_CONTRACT.md §27.1):
 * request → approve → pay with maker-checker (requester ≠ approver ≠ payer when
 * configured), documents and a reference before approval, frozen entries from
 * APPROVED on (DB trigger), reversal entries for corrections, tenant-configured
 * limits evaluated at submission and approval, and audited, re-authenticated
 * exports. Organisation-level: no department scope.
 */
@Injectable()
export class FinanceService {
  constructor(
    readonly prisma: PrismaService,
    readonly audit: AuditService,
    readonly modules: TenantModulesService,
    private readonly storage: StorageService,
    private readonly notifications: NotificationCenterService,
    private readonly reports: ReportBuilderService,
  ) {}

  /* ---------------------------------------------------------------- mapping */

  private summary(t: SummaryRow): FinanceTransactionSummary {
    return {
      id: t.id,
      reference: t.reference,
      type: t.type,
      status: t.status,
      transactionDate: isoDate(t.transactionDate)!,
      amount: { amountMinor: minorToNumber(t.amountMinor)!, currency: t.currency },
      account: t.account,
      category: t.category,
      counterparty: t.payee
        ? { kind: 'PAYEE', id: t.payee.id, name: t.payee.name }
        : t.contributionSource
          ? { kind: 'CONTRIBUTION_SOURCE', id: t.contributionSource.id, name: t.contributionSource.displayName }
          : t.counterAccount
            ? { kind: 'ACCOUNT', id: t.counterAccount.id, name: t.counterAccount.name }
            : null,
      externalReference: t.externalReference,
      description: t.description,
      department: t.department,
      requestedBy: t.requestedBy,
      approvedBy: t.approvedBy,
      paidBy: t.paidBy,
      documentCount: t._count.documents,
      complianceFlags: t.complianceFlags as FinanceTransactionSummary['complianceFlags'],
      reversesId: t.reversesId,
      reversedById: liveReversal(t)?.id ?? null,
      version: t.version,
    };
  }

  private blockers(t: DetailRow): string[] {
    return financeApprovalBlockers({
      type: t.type === 'REVERSAL' ? 'REVERSAL' : t.type,
      categoryId: t.categoryId,
      payeeId: t.payeeId,
      contributionSourceId: t.contributionSourceId,
      counterAccountId: t.counterAccountId,
      externalReference: t.externalReference,
      documentCount: t.documents.filter((d) => d.file.malwareScanStatus !== 'INFECTED').length,
      infectedDocumentCount: t.documents.filter((d) => d.file.malwareScanStatus === 'INFECTED').length,
    });
  }

  private async detail(tx: TenantTx, auth: AuthContext, t: DetailRow, config?: CampaignModuleConfig): Promise<FinanceTransactionDetail> {
    const cfg = config ?? (await this.modules.campaignConfig(tx));
    const live = t.status === 'REJECTED' || t.status === 'CANCELLED' ? [] : await evaluateEntry(tx, t, cfg);
    const p = (k: Parameters<typeof auth.permissions.has>[0]) => auth.permissions.has(k);
    const me = auth.userId;
    const isRequester = t.requestedById === me;
    const allowed: FinanceTransactionDetail['allowedActions'] = [];
    if (t.status === 'DRAFT' && isRequester && p('finance.request')) allowed.push('EDIT', 'SUBMIT');
    if (p('finance.request') && !['CANCELLED', 'REJECTED'].includes(t.status)) allowed.push('ADD_DOCUMENT');
    if (t.status === 'REQUESTED' && p('finance.approve') && !isRequester) allowed.push('APPROVE', 'REJECT');
    if (t.status === 'APPROVED' && p('finance.pay') && !financeSodViolation({ action: 'PAY', actorId: me, requestedById: t.requestedById, approvedById: t.approvedById, approverCannotPay: cfg.finance.approverCannotPay })) {
      allowed.push('PAY');
    }
    if ((t.status === 'DRAFT' || t.status === 'REQUESTED') && (isRequester || p('finance.approve'))) allowed.push('CANCEL');
    if ((t.status === 'APPROVED' || t.status === 'PAID') && p('finance.reverse') && !liveReversal(t) && t.type !== 'REVERSAL') allowed.push('REVERSE');
    return {
      ...this.summary(t),
      counterAccount: t.counterAccount,
      budgetLine: t.budgetLine,
      eventId: t.eventId,
      electionCycleId: t.electionCycleId,
      requestedAt: iso(t.requestedAt),
      approvedAt: iso(t.approvedAt),
      rejectedBy: t.rejectedBy,
      rejectionReason: t.rejectionReason,
      paidAt: iso(t.paidAt),
      paymentReference: t.paymentReference,
      documents: t.documents.map(toDocument),
      timeline: t.events.map((e) => ({ id: e.id, type: e.type, fromStatus: e.fromStatus, toStatus: e.toStatus, actor: e.actor, note: e.note, createdAt: e.createdAt.toISOString() })),
      compliance: live,
      approvalBlockers: this.blockers(t),
      createdAt: t.createdAt.toISOString(),
      allowedActions: allowed,
    };
  }

  private async load(tx: TenantTx, id: string): Promise<DetailRow> {
    const t = await tx.financeTransaction.findUnique({ where: { id }, include: DETAIL_INCLUDE });
    if (!t) throw AppException.notFound('Ledger entry not found');
    return t;
  }

  private event(tx: TenantTx, auth: AuthContext, transactionId: string, type: Prisma.FinanceTransactionEventUncheckedCreateInput['type'], from: FinanceTransactionStatus | null, to: FinanceTransactionStatus | null, note?: string | null, data?: unknown) {
    return tx.financeTransactionEvent.create({
      data: { tenantId: auth.tenantId, transactionId, type, fromStatus: from, toStatus: to, actorId: auth.userId, note: note ?? null, ...(data ? { data: JSON.parse(JSON.stringify(data)) } : {}) },
    });
  }

  /* ------------------------------------------------------------------ reads */

  ledger(auth: AuthContext, q: FinanceLedgerQuery): Promise<FinanceLedgerSummary> {
    return this.prisma.tenantTx(async (tx) => {
      const config = await this.modules.campaignConfig(tx);
      const currency = config.finance.defaultCurrency;
      const range = q.from || q.to ? { transactionDate: { ...(q.from ? { gte: new Date(q.from) } : {}), ...(q.to ? { lte: new Date(q.to) } : {}) } } : {};
      const cycle = q.electionCycleId ? { electionCycleId: q.electionCycleId } : {};
      const sum = async (type: 'CONTRIBUTION' | 'EXPENSE' | 'REFUND') =>
        minorToNumber(
          (await tx.financeTransaction.aggregate({ where: { type, currency, status: { in: [...POSTED_NET] }, ...range, ...cycle }, _sum: { amountMinor: true } }))._sum.amountMinor ?? 0n,
        )!;
      const [contributionsMinor, expensesMinor, refundsMinor, awaitingApproval, awaitingPayment, flagged, accounts] = await Promise.all([
        sum('CONTRIBUTION'),
        sum('EXPENSE'),
        sum('REFUND'),
        tx.financeTransaction.count({ where: { status: 'REQUESTED' } }),
        tx.financeTransaction.count({ where: { status: 'APPROVED' } }),
        tx.financeTransaction.count({ where: { NOT: { complianceFlags: { isEmpty: true } }, status: { notIn: ['CANCELLED', 'REJECTED', 'REVERSED'] } } }),
        this.accounts(tx),
      ]);
      const today = new Date().toISOString().slice(0, 10);
      return {
        currency,
        accounts,
        totals: { contributionsMinor, expensesMinor, refundsMinor },
        pending: { awaitingApproval, awaitingPayment, flagged },
        compliance: await currentFindings(tx, config, q.electionCycleId ?? null, today),
        asOf: new Date().toISOString(),
      };
    });
  }

  async accounts(tx: TenantTx) {
    const [rows, balances] = await Promise.all([tx.financeAccount.findMany({ orderBy: { name: 'asc' } }), accountBalances(tx)]);
    return rows.map((a) => ({
      id: a.id,
      name: a.name,
      type: a.type,
      institution: a.institution,
      accountNumberMasked: a.accountNumberMasked,
      currency: a.currency,
      isDedicatedCampaignAccount: a.isDedicatedCampaignAccount,
      status: a.status,
      balanceMinor: minorToNumber(balances.get(a.id) ?? 0n)!,
      version: a.version,
    }));
  }

  list(auth: AuthContext, q: FinanceTransactionQuery): Promise<Paginated<FinanceTransactionSummary>> {
    return this.prisma.tenantTx(async (tx) => {
      const config = await this.modules.campaignConfig(tx);
      const me = auth.userId;
      const view: Prisma.FinanceTransactionWhereInput =
        q.view === 'awaiting_my_approval'
          ? { status: 'REQUESTED', requestedById: { not: me } }
          : q.view === 'awaiting_payment'
            ? { status: 'APPROVED', requestedById: { not: me }, ...(config.finance.approverCannotPay ? { approvedById: { not: me } } : {}) }
            : q.view === 'my_requests'
              ? { requestedById: me }
              : {};
      const where: Prisma.FinanceTransactionWhereInput = {
        AND: [
          view,
          q.type ? { type: q.type } : {},
          q.status ? { status: { in: Array.isArray(q.status) ? q.status : [q.status] } } : {},
          q.accountId ? { OR: [{ accountId: q.accountId }, { counterAccountId: q.accountId }] } : {},
          q.categoryId ? { categoryId: q.categoryId } : {},
          q.payeeId ? { payeeId: q.payeeId } : {},
          q.contributionSourceId ? { contributionSourceId: q.contributionSourceId } : {},
          q.departmentId ? { departmentId: q.departmentId } : {},
          q.eventId ? { eventId: q.eventId } : {},
          q.budgetLineId ? { budgetLineId: q.budgetLineId } : {},
          q.from ? { transactionDate: { gte: new Date(q.from) } } : {},
          q.to ? { transactionDate: { lte: new Date(q.to) } } : {},
          q.flagged ? { NOT: { complianceFlags: { isEmpty: true } } } : {},
          q.q ? { OR: [{ reference: { contains: q.q, mode: 'insensitive' } }, { description: { contains: q.q, mode: 'insensitive' } }, { externalReference: { contains: q.q, mode: 'insensitive' } }] } : {},
        ],
      };
      const [rows, total] = await Promise.all([
        tx.financeTransaction.findMany({ where, include: SUMMARY_INCLUDE, orderBy: [{ transactionDate: q.order }, { reference: q.order }], ...pageArgs(q) }),
        tx.financeTransaction.count({ where }),
      ]);
      return { items: rows.map((r) => this.summary(r)), page: q.page, pageSize: q.pageSize, total };
    });
  }

  get(auth: AuthContext, id: string): Promise<FinanceTransactionDetail> {
    return this.prisma.tenantTx(async (tx) => this.detail(tx, auth, await this.load(tx, id)));
  }

  /* ----------------------------------------------------------------- writes */

  /** Shared checks for create / update (400 VALIDATION_FAILED naming the field). */
  private async validateFields(
    tx: TenantTx,
    v: {
      type: string;
      accountId: string;
      counterAccountId: string | null;
      categoryId: string;
      budgetLineId: string | null;
      currency: string;
      payeeId: string | null;
      contributionSourceId: string | null;
      departmentId: string | null;
      eventId: string | null;
      electionCycleId: string | null;
    },
  ): Promise<void> {
    const bad = (path: string, message: string) => AppException.validation(message, [{ path: [path], message }]);
    const account = await tx.financeAccount.findUnique({ where: { id: v.accountId } });
    if (!account || account.status !== 'ACTIVE') throw bad('accountId', 'Choose an active account');
    if (account.currency !== v.currency) throw bad('currency', `The account holds ${account.currency}`);
    const cat = await tx.financeCategory.findUnique({ where: { id: v.categoryId } });
    if (!cat || !cat.active) throw bad('categoryId', 'Choose an active category');
    if (v.type !== 'REVERSAL' && cat.kind !== CATEGORY_KIND[v.type]) throw bad('categoryId', `A ${v.type.toLowerCase()} needs a ${CATEGORY_KIND[v.type]!.toLowerCase()} category`);
    if (v.type === 'CONTRIBUTION' && (!v.contributionSourceId || v.payeeId)) throw bad('contributionSourceId', 'A contribution names a contribution source');
    if ((v.type === 'EXPENSE' || v.type === 'REFUND') && (!v.payeeId || v.contributionSourceId)) throw bad('payeeId', 'Expenses and refunds name a payee');
    if (v.type === 'TRANSFER' && (!v.counterAccountId || v.counterAccountId === v.accountId)) throw bad('counterAccountId', 'A transfer names a different counter account');
    if (v.counterAccountId) {
      const ca = await tx.financeAccount.findUnique({ where: { id: v.counterAccountId } });
      if (!ca || ca.status !== 'ACTIVE' || ca.currency !== v.currency) throw bad('counterAccountId', 'Choose an active account in the same currency');
    }
    if (v.budgetLineId) {
      const bl = await tx.financeBudgetLine.findUnique({ where: { id: v.budgetLineId } });
      if (!bl || bl.status !== 'APPROVED') throw bad('budgetLineId', 'Choose an approved budget line');
      if (bl.currency !== v.currency) throw bad('budgetLineId', `The budget line is in ${bl.currency}`);
    }
    if (v.payeeId && !(await tx.financePayee.findUnique({ where: { id: v.payeeId } }))?.active) throw bad('payeeId', 'Choose an active payee');
    if (v.contributionSourceId && !(await tx.contributionSource.findUnique({ where: { id: v.contributionSourceId } }))) throw bad('contributionSourceId', 'Unknown contribution source');
    if (v.departmentId && !(await tx.department.findUnique({ where: { id: v.departmentId } }))) throw bad('departmentId', 'Unknown department');
    if (v.eventId && !(await tx.campaignEvent.findUnique({ where: { id: v.eventId } }))) throw bad('eventId', 'Unknown event');
    if (v.electionCycleId && !(await tx.electionCycle.findUnique({ where: { id: v.electionCycleId } }))) throw bad('electionCycleId', 'Unknown election cycle');
  }

  create(auth: AuthContext, body: CreateFinanceTransaction): Promise<FinanceTransactionDetail> {
    return this.prisma.tenantTx(async (tx) => {
      const fields = {
        type: body.type,
        accountId: body.accountId,
        counterAccountId: body.counterAccountId ?? null,
        categoryId: body.categoryId,
        budgetLineId: body.budgetLineId ?? null,
        currency: body.currency,
        payeeId: body.payeeId ?? null,
        contributionSourceId: body.contributionSourceId ?? null,
        departmentId: body.departmentId ?? null,
        eventId: body.eventId ?? null,
        electionCycleId: body.electionCycleId ?? null,
      };
      await this.validateFields(tx, fields);
      const config = await this.modules.campaignConfig(tx);
      const reference = await nextReference(tx, auth.tenantId, 'FIN', campaignReferenceYear(config));
      const t = await tx.financeTransaction.create({
        data: {
          tenantId: auth.tenantId,
          reference,
          ...fields,
          amountMinor: numberToMinor(body.amountMinor),
          transactionDate: new Date(body.transactionDate),
          externalReference: body.externalReference ?? null,
          description: body.description,
          status: 'DRAFT',
          requestedById: auth.userId,
        },
      });
      await this.event(tx, auth, t.id, 'CREATED', null, 'DRAFT');
      await this.audit.record(
        {
          tenantId: auth.tenantId,
          action: AUDIT_ACTIONS.FINANCE_TRANSACTION_CREATED,
          entityType: CAMPAIGN_ENTITY.FINANCE_TRANSACTION,
          entityId: t.id,
          after: { reference, type: t.type, amountMinor: t.amountMinor, currency: t.currency, accountId: t.accountId, categoryId: t.categoryId, payeeId: t.payeeId, contributionSourceId: t.contributionSourceId, status: 'DRAFT' },
        },
        tx,
      );
      return this.detail(tx, auth, await this.load(tx, t.id), config);
    });
  }

  update(auth: AuthContext, id: string, body: UpdateFinanceTransaction): Promise<FinanceTransactionDetail> {
    return this.prisma.tenantTx(async (tx) => {
      const cur = await this.load(tx, id);
      if (cur.requestedById !== auth.userId) throw AppException.forbidden('Only the requester can edit this entry');
      if (cur.status !== 'DRAFT') throw new AppException(ERROR_CODES.IMMUTABLE_RECORD, HttpStatus.CONFLICT, 'Only draft entries can be edited');
      if (cur.version !== body.expectedVersion) throw staleVersion(cur.version, await this.detail(tx, auth, cur));
      const { expectedVersion, amountMinor, transactionDate, ...rest } = body;
      const merged = {
        type: cur.type,
        accountId: rest.accountId ?? cur.accountId,
        counterAccountId: rest.counterAccountId !== undefined ? rest.counterAccountId : cur.counterAccountId,
        categoryId: rest.categoryId ?? cur.categoryId,
        budgetLineId: rest.budgetLineId !== undefined ? rest.budgetLineId : cur.budgetLineId,
        currency: rest.currency ?? cur.currency,
        payeeId: rest.payeeId !== undefined ? rest.payeeId : cur.payeeId,
        contributionSourceId: rest.contributionSourceId !== undefined ? rest.contributionSourceId : cur.contributionSourceId,
        departmentId: rest.departmentId !== undefined ? rest.departmentId : cur.departmentId,
        eventId: rest.eventId !== undefined ? rest.eventId : cur.eventId,
        electionCycleId: rest.electionCycleId !== undefined ? rest.electionCycleId : cur.electionCycleId,
      };
      await this.validateFields(tx, merged);
      const { type: _type, ...writable } = merged;
      const data: Prisma.FinanceTransactionUncheckedUpdateManyInput = {
        ...writable,
        ...(amountMinor !== undefined ? { amountMinor: numberToMinor(amountMinor) } : {}),
        ...(transactionDate !== undefined ? { transactionDate: new Date(transactionDate) } : {}),
        ...(rest.externalReference !== undefined ? { externalReference: rest.externalReference } : {}),
        ...(rest.description !== undefined ? { description: rest.description } : {}),
        version: { increment: 1 },
      };
      const r = await tx.financeTransaction.updateMany({ where: { id, version: expectedVersion, status: 'DRAFT' }, data });
      if (r.count === 0) throw staleVersion(cur.version, null);
      const changed = Object.keys(body).filter((k) => k !== 'expectedVersion');
      await this.event(tx, auth, id, 'UPDATED', 'DRAFT', 'DRAFT', null, { fields: changed });
      await this.audit.record(
        {
          tenantId: auth.tenantId,
          action: AUDIT_ACTIONS.FINANCE_TRANSACTION_UPDATED,
          entityType: CAMPAIGN_ENTITY.FINANCE_TRANSACTION,
          entityId: id,
          before: { amountMinor: cur.amountMinor, accountId: cur.accountId, categoryId: cur.categoryId, payeeId: cur.payeeId, contributionSourceId: cur.contributionSourceId, externalReference: cur.externalReference },
          after: { fields: changed, amountMinor: amountMinor ?? undefined },
        },
        tx,
      );
      return this.detail(tx, auth, await this.load(tx, id));
    });
  }

  upload(auth: AuthContext, file: CampaignUpload | undefined): Promise<CampaignFile> {
    return this.prisma.tenantTx(async (tx) => (await storeCampaignUpload(this.storage, tx, auth, file, 'FINANCE_DOCUMENT')).file);
  }

  addDocument(auth: AuthContext, id: string, body: AddFinanceDocument): Promise<FinanceDocument> {
    return this.prisma.tenantTx(async (tx) => {
      const cur = await tx.financeTransaction.findUnique({ where: { id } });
      if (!cur) throw AppException.notFound('Ledger entry not found');
      if (cur.status === 'CANCELLED' || cur.status === 'REJECTED') throw new AppException(ERROR_CODES.IMMUTABLE_RECORD, HttpStatus.CONFLICT, 'This entry is closed');
      await assertOwnFiles(tx, auth.userId, [body.fileId], 'FINANCE_DOCUMENT', 'fileId');
      const file = await tx.storedFile.findUniqueOrThrow({ where: { id: body.fileId }, select: { malwareScanStatus: true } });
      if (file.malwareScanStatus === 'INFECTED') throw AppException.validation('This file failed the malware scan', [{ path: ['fileId'], message: 'Infected file' }]);
      // One receipt or invoice backs one live entry (no double claims); a reversal may cite the document of the entry it reverses.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`fin-doc:${auth.tenantId}:${body.fileId}`}))`;
      const reuse = await tx.financeTransactionDocument.findFirst({
        where: {
          fileId: body.fileId,
          transactionId: { not: id },
          transaction: { status: { notIn: ['REJECTED', 'CANCELLED'] }, ...(cur.reversesId ? { id: { not: cur.reversesId } } : {}), OR: [{ reversesId: null }, { reversesId: { not: id } }] },
        },
        select: { transaction: { select: { id: true, reference: true } } },
      });
      if (reuse) throw AppException.conflict('This document already supports another ledger entry', { reason: 'DOCUMENT_IN_USE', transactionId: reuse.transaction.id, reference: reuse.transaction.reference });
      const doc = await tx.financeTransactionDocument.create({
        data: { tenantId: auth.tenantId, transactionId: id, fileId: body.fileId, kind: body.kind, note: body.note ?? null, addedById: auth.userId },
        include: { file: FILE_INCLUDE, addedBy: USER },
      });
      await this.event(tx, auth, id, 'DOCUMENT_ADDED', cur.status, cur.status, body.kind);
      await this.audit.record(
        { tenantId: auth.tenantId, action: AUDIT_ACTIONS.FINANCE_TRANSACTION_DOCUMENT_ADDED, entityType: CAMPAIGN_ENTITY.FINANCE_TRANSACTION, entityId: id, after: { documentId: doc.id, fileId: body.fileId, kind: body.kind, sha256: doc.file.sha256 } },
        tx,
      );
      return toDocument(doc);
    });
  }

  documentUrl(auth: AuthContext, id: string, documentId: string): Promise<SignedUrlResponse> {
    return this.prisma.tenantTx(async (tx) => {
      const d = await tx.financeTransactionDocument.findFirst({ where: { id: documentId, transactionId: id }, include: { file: true } });
      if (!d) throw AppException.notFound('Document not found');
      return auditedSignedUrl(this.storage, this.audit, tx, auth, d.file, { type: CAMPAIGN_ENTITY.FINANCE_TRANSACTION, id });
    });
  }

  /* -------------------------------------------------------------- workflow */

  transition(auth: AuthContext, id: string, body: FinanceTransition): Promise<FinanceTransactionDetail> {
    return this.prisma.tenantTx(async (tx) => {
      const cur = await this.load(tx, id);
      const config = await this.modules.campaignConfig(tx);
      const has = (k: Parameters<typeof auth.permissions.has>[0]) => auth.permissions.has(k);
      const me = auth.userId;
      const target: Record<FinanceTransition['action'], FinanceTransactionStatus> = { SUBMIT: 'REQUESTED', APPROVE: 'APPROVED', REJECT: 'REJECTED', PAY: 'PAID', CANCEL: 'CANCELLED' };
      const to = target[body.action];
      // Permission per action first (the guard admits any finance actor).
      if (body.action === 'SUBMIT' && !has('finance.request')) throw AppException.forbidden(undefined, { required: ['finance.request'] });
      if ((body.action === 'APPROVE' || body.action === 'REJECT') && !has('finance.approve')) throw AppException.forbidden(undefined, { required: ['finance.approve'] });
      if (body.action === 'PAY' && !has('finance.pay')) throw AppException.forbidden(undefined, { required: ['finance.pay'] });
      if (body.action === 'CANCEL' && cur.requestedById !== me && !has('finance.approve')) throw AppException.forbidden('Only the requester or an approver can cancel');
      if (body.action === 'APPROVE' || body.action === 'PAY') assertRecentReauth(auth);
      if (!canTransitionFinanceTransaction(cur.status, to)) throw AppException.invalidTransition(cur.status, to);
      if (cur.version !== body.expectedVersion) throw staleVersion(cur.version, await this.detail(tx, auth, cur, config));

      const now = new Date();
      const data: Prisma.FinanceTransactionUncheckedUpdateManyInput = { status: to, version: { increment: 1 } };
      let findings: ComplianceFinding[] = [];
      switch (body.action) {
        case 'SUBMIT': {
          if (cur.requestedById !== me) throw AppException.forbidden('Only the requester can submit this entry');
          findings = await evaluateEntry(tx, cur, config);
          Object.assign(data, { requestedAt: now, complianceFlags: flagsOf(findings), complianceEvaluatedAt: now });
          break;
        }
        case 'APPROVE': {
          const v = financeSodViolation({ action: 'APPROVE', actorId: me, requestedById: cur.requestedById, approverCannotPay: config.finance.approverCannotPay });
          if (v) throw sod('You requested this entry; someone else must approve it');
          const blockers = this.blockers(cur);
          if (blockers.length) throw new AppException(ERROR_CODES.APPROVAL_INCOMPLETE, HttpStatus.CONFLICT, 'This entry is not ready for approval', { blockers });
          // Serialise limit checks per tenant and election cycle so two concurrent approvals
          // cannot both pass a cap or a spending limit (each sees the other once committed).
          const cycleId = cur.electionCycleId ?? config.finance.defaultElectionCycleId;
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`fin-limit:${auth.tenantId}:${cycleId ?? 'none'}`}))`;
          const settings = await loadLimitSettings(tx);
          const relaxed = settingsChangedBy(settings, cur, cycleId, me);
          if (relaxed.length) {
            throw AppException.separationOfDuties('You changed a limit setting that governs this entry (verification or a superseding version); another approver must decide', {
              settingIds: relaxed.map((x) => x.id),
            });
          }
          findings = await evaluateEntry(tx, cur, config, settings);
          if (complianceBlocks(findings)) {
            throw new AppException(ERROR_CODES.LIMIT_EXCEEDED, HttpStatus.CONFLICT, 'A verified limit setting blocks this approval', { findings });
          }
          const warnings = findings.filter((f) => f.level === 'WARN');
          if (warnings.length && !body.acknowledgeWarnings) {
            throw AppException.conflict('Review the compliance warnings and confirm to approve', { findings });
          }
          Object.assign(data, { approvedById: me, approvedAt: now, complianceFlags: flagsOf(findings), complianceEvaluatedAt: now });
          break;
        }
        case 'REJECT': {
          if (cur.requestedById === me) throw sod('You requested this entry; someone else must decide on it');
          Object.assign(data, { rejectedById: me, rejectedAt: now, rejectionReason: body.note });
          break;
        }
        case 'PAY': {
          const v = financeSodViolation({ action: 'PAY', actorId: me, requestedById: cur.requestedById, approvedById: cur.approvedById, approverCannotPay: config.finance.approverCannotPay });
          if (v === 'REQUESTER_CANNOT_PAY') throw sod('You requested this entry; someone else must pay it');
          if (v === 'APPROVER_CANNOT_PAY') throw sod('You approved this entry; someone else must pay it');
          const paidAt = body.paidAt ? new Date(body.paidAt) : now;
          if (paidAt.getTime() > now.getTime() + 5 * 60_000) throw AppException.validation('The payment time cannot be in the future', [{ path: ['paidAt'], message: 'In the future' }]);
          Object.assign(data, { paidById: me, paidAt, paymentReference: body.paymentReference });
          break;
        }
        case 'CANCEL': {
          Object.assign(data, { cancelledAt: now, cancellationReason: body.note });
          break;
        }
      }
      const r = await tx.financeTransaction.updateMany({ where: { id, version: cur.version, status: cur.status }, data });
      if (r.count === 0) throw staleVersion(cur.version, null);
      if (findings.length) await this.event(tx, auth, id, 'COMPLIANCE_EVALUATED', cur.status, to, findings.map((f) => f.message).join('; ').slice(0, 2000), { findings, acknowledged: !!body.acknowledgeWarnings });
      const eventType = ({ SUBMIT: 'REQUESTED', APPROVE: 'APPROVED', REJECT: 'REJECTED', PAY: 'PAID', CANCEL: 'CANCELLED' } as const)[body.action];
      await this.event(tx, auth, id, eventType, cur.status, to, body.note ?? (body.action === 'PAY' ? `Payment reference ${body.paymentReference}` : null));

      // An approved reversal marks the original REVERSED in the same transaction.
      if (body.action === 'APPROVE' && cur.type === 'REVERSAL' && cur.reversesId) {
        const orig = await tx.financeTransaction.findUniqueOrThrow({ where: { id: cur.reversesId } });
        if (orig.status !== 'APPROVED' && orig.status !== 'PAID') throw AppException.invalidTransition(orig.status, 'REVERSED');
        await tx.financeTransaction.update({ where: { id: orig.id }, data: { status: 'REVERSED', reversedAt: now, version: { increment: 1 } } });
        await this.event(tx, auth, orig.id, 'REVERSED', orig.status, 'REVERSED', `Reversed by ${cur.reference}`);
        await this.audit.record(
          {
            tenantId: auth.tenantId,
            action: AUDIT_ACTIONS.FINANCE_TRANSACTION_STATUS_CHANGED,
            entityType: CAMPAIGN_ENTITY.FINANCE_TRANSACTION,
            entityId: orig.id,
            before: { status: orig.status },
            after: { status: 'REVERSED', reversalId: cur.id, amountMinor: orig.amountMinor },
          },
          tx,
        );
      }
      await this.audit.record(
        {
          tenantId: auth.tenantId,
          action: AUDIT_ACTIONS.FINANCE_TRANSACTION_STATUS_CHANGED,
          entityType: CAMPAIGN_ENTITY.FINANCE_TRANSACTION,
          entityId: id,
          before: { status: cur.status },
          after: {
            status: to,
            amountMinor: cur.amountMinor,
            currency: cur.currency,
            requestedById: cur.requestedById,
            approvedById: body.action === 'APPROVE' ? me : cur.approvedById,
            paidById: body.action === 'PAY' ? me : null,
            complianceFlags: findings.length ? flagsOf(findings) : undefined,
            warningsAcknowledged: body.action === 'APPROVE' ? !!body.acknowledgeWarnings : undefined,
          },
          reason: body.note ?? null,
        },
        tx,
      );

      // Notifications (references only).
      const link = `/finance/transactions/${id}`;
      const base = { tenantId: auth.tenantId, module: 'finance', link, entityType: CAMPAIGN_ENTITY.FINANCE_TRANSACTION, entityId: id };
      if (body.action === 'SUBMIT') {
        const approvers = await usersWithPermission(tx, 'finance.approve', { exclude: [cur.requestedById] });
        await this.notifications.notify(tx, { ...base, userIds: approvers, type: 'finance.approval_requested', title: `Approval requested: ${cur.reference}`, body: `${cur.reference} is awaiting approval.` });
        if (findings.length) {
          await this.notifications.notify(tx, {
            ...base,
            userIds: approvers,
            type: 'finance.limit_warning',
            severity: 'WARNING',
            title: `Compliance check: ${cur.reference}`,
            body: `${cur.reference} has ${findings.length} compliance finding(s) to review before approval.`,
          });
        }
      } else if (body.action === 'APPROVE') {
        const payers = await usersWithPermission(tx, 'finance.pay', { exclude: [cur.requestedById, config.finance.approverCannotPay ? me : null] });
        await this.notifications.notify(tx, { ...base, userIds: payers, type: 'finance.payment_requested', title: `Ready for payment: ${cur.reference}`, body: `${cur.reference} was approved and is ready to be paid or settled.` });
      } else if (body.action === 'REJECT') {
        await this.notifications.notify(tx, { ...base, userIds: [cur.requestedById], type: 'finance.rejected', title: `Rejected: ${cur.reference}`, body: `${cur.reference} was rejected. See the reason on the entry.` });
      }
      return this.detail(tx, auth, await this.load(tx, id), config);
    });
  }

  reverse(auth: AuthContext, id: string, body: ReverseFinanceTransaction): Promise<FinanceTransactionDetail> {
    return this.prisma.tenantTx(async (tx) => {
      const orig = await this.load(tx, id);
      if (orig.status !== 'APPROVED' && orig.status !== 'PAID') throw AppException.conflict('Only approved or paid entries can be reversed', { status: orig.status });
      if (orig.type === 'REVERSAL') throw AppException.conflict('A reversing entry cannot itself be reversed');
      const existing = liveReversal(orig);
      if (existing) throw AppException.conflict('This entry already has a reversing entry', { reversalId: existing.id });
      if (orig.version !== body.expectedVersion) throw staleVersion(orig.version, null);
      const config = await this.modules.campaignConfig(tx);
      const reference = await nextReference(tx, auth.tenantId, 'FIN', campaignReferenceYear(config));
      const counterparty = orig.payee?.name ?? orig.contributionSource?.displayName ?? orig.counterAccount?.name ?? 'no counterparty';
      const rev = await tx.financeTransaction.create({
        data: {
          tenantId: auth.tenantId,
          reference,
          type: 'REVERSAL',
          status: 'REQUESTED',
          accountId: orig.accountId,
          counterAccountId: orig.counterAccountId,
          categoryId: orig.categoryId,
          budgetLineId: orig.budgetLineId,
          amountMinor: orig.amountMinor,
          currency: orig.currency,
          transactionDate: new Date(new Date().toISOString().slice(0, 10)),
          externalReference: orig.externalReference,
          description: `Reversal of ${orig.reference} (${orig.type.toLowerCase()}, ${counterparty}): ${body.reason}`.slice(0, 1000),
          departmentId: orig.departmentId,
          eventId: orig.eventId,
          electionCycleId: orig.electionCycleId,
          reversesId: orig.id,
          requestedById: auth.userId,
          requestedAt: new Date(),
        },
      });
      await this.event(tx, auth, rev.id, 'CREATED', null, 'REQUESTED', body.reason, { reverses: orig.reference });
      await this.audit.record(
        {
          tenantId: auth.tenantId,
          action: AUDIT_ACTIONS.FINANCE_TRANSACTION_REVERSED,
          entityType: CAMPAIGN_ENTITY.FINANCE_TRANSACTION,
          entityId: orig.id,
          after: { originalId: orig.id, originalReference: orig.reference, reversalId: rev.id, reversalReference: reference, amountMinor: orig.amountMinor, currency: orig.currency },
          reason: body.reason,
        },
        tx,
      );
      const approvers = await usersWithPermission(tx, 'finance.approve', { exclude: [auth.userId] });
      await this.notifications.notify(tx, {
        tenantId: auth.tenantId,
        userIds: approvers,
        module: 'finance',
        type: 'finance.approval_requested',
        title: `Reversal awaiting approval: ${reference}`,
        body: `${reference} reverses ${orig.reference} and is awaiting approval.`,
        link: `/finance/transactions/${rev.id}`,
        entityType: CAMPAIGN_ENTITY.FINANCE_TRANSACTION,
        entityId: rev.id,
      });
      return this.detail(tx, auth, await this.load(tx, rev.id), config);
    });
  }

  /* ---------------------------------------------------------------- exports */

  exportRegister(auth: AuthContext, body: FinanceExportRequest): Promise<SignedUrlResponse> {
    return this.prisma.tenantTx(
      async (tx) => {
        const reauthAt = assertRecentReauth(auth);
        // Calendar days in Africa/Nairobi (the date-only loaders map instants back to that day).
        const eat = (day: string, time: string) => new Date(`${day}T${time}+03:00`).toISOString();
        const dateRange = body.from || body.to ? { ...(body.from ? { from: eat(body.from, '00:00:00.000') } : {}), ...(body.to ? { to: eat(body.to, '23:59:59.999') } : {}) } : undefined;
        const defs: Record<FinanceExportRequest['register'], { title: string; def: ReportDefinition }> = {
          LEDGER: {
            title: 'Finance ledger',
            def: { datasetKey: 'finance.transactions', fields: ['reference', 'type', 'status', 'transactionDate', 'amountMinor', 'currency', 'categoryName', 'accountName', 'counterpartyName', 'externalReference', 'departmentName', 'requestedByName', 'approvedByName', 'paidByName', 'complianceFlags'], filters: [], groupBy: [], dateRange },
          },
          EXPENDITURE: {
            title: 'Expenditure register',
            def: { datasetKey: 'finance.transactions', fields: ['reference', 'status', 'transactionDate', 'amountMinor', 'currency', 'categoryName', 'counterpartyName', 'externalReference', 'approvedByName', 'paidByName', 'complianceFlags'], filters: [{ field: 'type', op: 'eq', value: 'EXPENSE' }], groupBy: [], dateRange },
          },
          CONTRIBUTIONS: {
            title: 'Contribution register',
            def: { datasetKey: 'finance.contributions', fields: ['reference', 'transactionDate', 'status', 'contributorName', 'contributorKind', 'identifierMasked', 'declared', 'amountMinor', 'complianceFlags'], filters: [], groupBy: [], dateRange },
          },
          BUDGET_VS_ACTUAL: {
            title: 'Budget vs actual',
            def: { datasetKey: 'finance.budget_vs_actual', fields: ['code', 'name', 'departmentName', 'eventReference', 'periodStart', 'budgetMinor', 'actualMinor', 'committedMinor', 'varianceMinor'], filters: [], groupBy: [], dateRange },
          },
        };
        const { title, def } = defs[body.register];
        const r = await this.reports.run(tx, auth, def);
        if (r.truncated || r.incomplete) {
          // A register must be complete: never hand out a silently cut-off file.
          throw AppException.conflict(`This register has more than ${r.ds.maxRows} rows; narrow the date range and export it in parts`, { reason: 'EXPORT_TOO_LARGE', maxRows: r.ds.maxRows });
        }
        const unverified = r.rows.some((row) => Array.isArray(row.complianceFlags) && row.complianceFlags.includes('UNVERIFIED_SETTING'));
        const generatedAt = new Date();
        const header = {
          title,
          generatedAt,
          generatedBy: auth.displayName,
          filtersDescription: `${body.from ?? 'start'} to ${body.to ?? 'today'}${body.register === 'EXPENDITURE' ? '; expenses only' : ''}`,
          appliedScope: r.appliedScope,
          classification: r.classification,
          disclaimer: unverified ? `Some compliance flags rely on limit settings marked "${UNVERIFIED_LIMIT_LABEL}"` : null,
          extraLines: ['Amounts are in minor units (cents) of the stated currency.', `Rows: ${r.rowCount}`],
        };
        const file = await storeExport(
          this.storage,
          tx,
          auth,
          header,
          [{ name: 'Register', header: r.columns.map((c) => c.label), rows: r.rows.map((row) => r.columns.map((c) => exportCell(row[c.key]))) }],
          body.format,
          `finance-${body.register.toLowerCase()}`,
        );
        const exp = await tx.reportExport.create({
          data: {
            tenantId: auth.tenantId,
            datasetKey: def.datasetKey,
            format: body.format,
            fields: def.fields,
            definition: { register: body.register, ...def } as unknown as Prisma.InputJsonValue,
            filtersDescription: header.filtersDescription,
            appliedScope: r.appliedScope,
            classification: r.classification,
            sensitive: true,
            rowCount: r.rowCount,
            fileId: file.id,
            sha256: file.sha256,
            reason: body.reason,
            reauthAt,
            generatedById: auth.userId,
            generatedAt,
          },
        });
        const after = { exportId: exp.id, register: body.register, format: body.format, from: body.from ?? null, to: body.to ?? null, rows: r.rowCount, classification: r.classification, sha256: file.sha256 };
        await this.audit.record({ tenantId: auth.tenantId, action: AUDIT_ACTIONS.FINANCE_EXPORTED, entityType: CAMPAIGN_ENTITY.REPORT_EXPORT, entityId: exp.id, after, reason: body.reason }, tx);
        await this.audit.record({ tenantId: auth.tenantId, action: AUDIT_ACTIONS.REPORT_EXPORTED, entityType: CAMPAIGN_ENTITY.REPORT_EXPORT, entityId: exp.id, after: { ...after, datasetKey: def.datasetKey, sensitive: true }, reason: body.reason }, tx);
        const { url, expiresAt } = await this.storage.signedUrl(file, 'attachment');
        return { url, expiresAt: expiresAt.toISOString(), sha256: file.sha256 };
      },
      { timeout: 120_000 },
    );
  }
}

export function toDocument(d: Prisma.FinanceTransactionDocumentGetPayload<{ include: { file: typeof FILE_INCLUDE; addedBy: typeof USER } }>): FinanceDocument {
  return { id: d.id, kind: d.kind, note: d.note, file: campaignFile(d.file), addedBy: d.addedBy, createdAt: d.createdAt.toISOString() };
}

import { Injectable } from '@nestjs/common';
import { identifierFingerprint, type Prisma, type TenantTx } from '@ngao360/db';
import {
  AUDIT_ACTIONS,
  type BudgetLine,
  type ContributionSource,
  type CreateFinanceLimitSetting,
  type FinanceAccount,
  type FinanceCategory,
  type FinanceLimitQuery,
  type FinanceLimitSetting,
  type FinancePayee,
  type Paginated,
  type PaginationQuery,
  type SaveBudgetLine,
  type SaveContributionSource,
  type SaveFinanceAccount,
  type SaveFinanceCategory,
  type SaveFinancePayee,
  type SupersedeFinanceLimitSetting,
  type VerifyFinanceLimitSetting,
} from '@ngao360/shared';
import { AuditService } from '../../../audit/audit.service';
import type { AuthContext } from '../../../auth/auth.types';
import { AppException } from '../../../common/http/app-exception';
import { AppConfig } from '../../../config/app-config';
import { PrismaService } from '../../../prisma/prisma.service';
import { TenantModulesService } from '../../../tenant-modules/tenant-modules.service';
import { CAMPAIGN_ENTITY } from '../campaign.constants';
import { iso, isoDate, minorToNumber, numberToMinor, pageArgs, staleVersion } from '../common';
import { budgetActuals } from '../reports/report-data';
import { POSTED_NET } from './finance-compliance';
import { accountBalances } from './finance.service';

const USER = { select: { id: true, displayName: true } } as const;
const LIMIT_INCLUDE = { verifiedBy: USER, createdBy: USER, supersededBy: { select: { id: true } } } satisfies Prisma.FinanceLimitSettingInclude;
type LimitRow = Prisma.FinanceLimitSettingGetPayload<{ include: typeof LIMIT_INCLUDE }>;
const BUDGET_INCLUDE = { department: { select: { id: true, code: true, name: true } }, approvedBy: USER } satisfies Prisma.FinanceBudgetLineInclude;
type BudgetRow = Prisma.FinanceBudgetLineGetPayload<{ include: typeof BUDGET_INCLUDE }>;

const DAY = 86_400_000;
const d = (s: string | null | undefined) => (s ? new Date(`${s}T00:00:00.000Z`) : null);

function maskTail(value: string, keep: number, prefix = ''): string {
  const v = value.replace(/[\s-]/g, '');
  return `${prefix}${'•'.repeat(Math.max(3, Math.min(6, v.length - keep)))}${v.slice(-keep)}`;
}

/**
 * Finance master data and versioned limit settings (docs/API_CONTRACT.md
 * §27.2–27.6). Identifiers (tax PINs, national ID / registration numbers) are
 * accepted in full but stored masked plus a keyed fingerprint for duplicate
 * detection; audits never carry them. Limit settings are never edited: a
 * change supersedes the row (value columns are immutable in the DB).
 */
@Injectable()
export class FinanceSettingsService {
  constructor(
    readonly prisma: PrismaService,
    readonly audit: AuditService,
    readonly modules: TenantModulesService,
    private readonly config: AppConfig,
  ) {}

  private fingerprint(tenantId: string, value: string): string {
    return identifierFingerprint(tenantId, value, this.config.values.MFA_ENCRYPTION_KEY);
  }

  /* ------------------------------------------------------------- limits */

  private limit(r: LimitRow): FinanceLimitSetting {
    return {
      id: r.id,
      kind: r.kind,
      label: r.label,
      valueBasisPoints: r.valueBasisPoints,
      capBasis: r.capBasis,
      valueMinor: minorToNumber(r.valueMinor),
      currency: r.currency,
      deadlineDate: isoDate(r.deadlineDate),
      electionCycleId: r.electionCycleId,
      periodLabel: r.periodLabel,
      officeType: r.officeType,
      effectiveFrom: isoDate(r.effectiveFrom)!,
      effectiveTo: isoDate(r.effectiveTo),
      legalSourceNote: r.legalSourceNote,
      verified: r.verified,
      verifiedBy: r.verifiedBy,
      verifiedAt: iso(r.verifiedAt),
      enforcement: r.enforcement,
      supersedesId: r.supersedesId,
      createdBy: r.createdBy,
      createdAt: r.createdAt.toISOString(),
    };
  }

  listLimits(_auth: AuthContext, q: FinanceLimitQuery): Promise<FinanceLimitSetting[]> {
    return this.prisma.tenantTx(async (tx) => {
      const on = d(q.activeOn);
      const rows = await tx.financeLimitSetting.findMany({
        where: {
          AND: [
            q.kind ? { kind: q.kind } : {},
            q.electionCycleId ? { OR: [{ electionCycleId: q.electionCycleId }, { electionCycleId: null }] } : {},
            on ? { effectiveFrom: { lte: on }, OR: [{ effectiveTo: null }, { effectiveTo: { gte: on } }] } : {},
            q.includeSuperseded ? {} : { supersededBy: { is: null } },
          ],
        },
        include: LIMIT_INCLUDE,
        orderBy: [{ kind: 'asc' }, { effectiveFrom: 'desc' }],
      });
      return rows.map((r) => this.limit(r));
    });
  }

  /** Another live (not superseded) setting of the same kind, cycle and office type overlapping [from, to]. */
  private async overlapping(tx: TenantTx, v: { kind: string; electionCycleId: string | null; officeType: string | null; from: Date; to: Date | null }, excludeId?: string) {
    return tx.financeLimitSetting.findFirst({
      where: {
        kind: v.kind as LimitRow['kind'],
        electionCycleId: v.electionCycleId,
        officeType: (v.officeType ?? null) as LimitRow['officeType'],
        supersededBy: { is: null },
        ...(excludeId ? { id: { not: excludeId } } : {}),
        OR: [{ effectiveTo: null }, { effectiveTo: { gte: v.from } }],
        ...(v.to ? { effectiveFrom: { lte: v.to } } : {}),
      },
      select: { id: true },
    });
  }

  private limitData(auth: AuthContext, kind: LimitRow['kind'], b: Omit<CreateFinanceLimitSetting, 'kind'>, now: Date) {
    return {
      tenantId: auth.tenantId,
      kind,
      label: b.label,
      valueBasisPoints: b.valueBasisPoints ?? null,
      capBasis: b.capBasis ?? null,
      valueMinor: b.valueMinor != null ? numberToMinor(b.valueMinor) : null,
      currency: kind === 'SPENDING_LIMIT' ? (b.currency ?? null) : null,
      deadlineDate: d(b.deadlineDate),
      electionCycleId: b.electionCycleId ?? null,
      periodLabel: b.periodLabel,
      officeType: b.officeType ?? null,
      effectiveFrom: d(b.effectiveFrom)!,
      effectiveTo: d(b.effectiveTo),
      legalSourceNote: b.legalSourceNote,
      verified: b.verified,
      verifiedById: b.verified ? auth.userId : null,
      verifiedAt: b.verified ? now : null,
      enforcement: b.enforcement,
      createdById: auth.userId,
    };
  }

  createLimit(auth: AuthContext, body: CreateFinanceLimitSetting): Promise<FinanceLimitSetting> {
    return this.prisma.tenantTx(async (tx) => {
      if (body.electionCycleId && !(await tx.electionCycle.findUnique({ where: { id: body.electionCycleId } }))) {
        throw AppException.validation('Unknown election cycle', [{ path: ['electionCycleId'], message: 'Unknown' }]);
      }
      const clash = await this.overlapping(tx, { kind: body.kind, electionCycleId: body.electionCycleId ?? null, officeType: body.officeType ?? null, from: d(body.effectiveFrom)!, to: d(body.effectiveTo) });
      if (clash) throw AppException.conflict('An active setting of this kind already covers these dates; supersede it instead', { existingId: clash.id });
      const row = await tx.financeLimitSetting.create({ data: this.limitData(auth, body.kind, body, new Date()), include: LIMIT_INCLUDE });
      await this.audit.record(
        { tenantId: auth.tenantId, action: AUDIT_ACTIONS.FINANCE_LIMIT_SETTING_CREATED, entityType: CAMPAIGN_ENTITY.FINANCE_LIMIT_SETTING, entityId: row.id, after: this.limit(row) },
        tx,
      );
      return this.limit(row);
    });
  }

  supersedeLimit(auth: AuthContext, id: string, body: SupersedeFinanceLimitSetting): Promise<FinanceLimitSetting> {
    return this.prisma.tenantTx(async (tx) => {
      const old = await tx.financeLimitSetting.findUnique({ where: { id }, include: LIMIT_INCLUDE });
      if (!old) throw AppException.notFound('Limit setting not found');
      if (old.supersededBy) throw AppException.conflict('This setting was already superseded', { supersededById: old.supersededBy.id });
      const from = d(body.effectiveFrom)!;
      if (from <= old.effectiveFrom) throw AppException.validation('The new setting must start after the one it replaces', [{ path: ['effectiveFrom'], message: `After ${isoDate(old.effectiveFrom)}` }]);
      const { reason, ...fields } = body;
      const check = { kind: old.kind, ...fields } as CreateFinanceLimitSetting;
      const kindOk =
        old.kind === 'SINGLE_SOURCE_CAP_PCT'
          ? check.valueBasisPoints != null && check.capBasis != null && check.valueMinor == null && check.deadlineDate == null
          : old.kind === 'SPENDING_LIMIT'
            ? check.valueMinor != null && check.currency != null && check.valueBasisPoints == null && check.deadlineDate == null
            : check.deadlineDate != null && check.valueMinor == null && check.valueBasisPoints == null;
      if (!kindOk) throw AppException.validation('Cap: basis points and basis; spending limit: amount and currency; deadline: a date', [{ path: ['kind'], message: 'Values do not match the kind' }]);
      const clash = await this.overlapping(tx, { kind: old.kind, electionCycleId: fields.electionCycleId ?? null, officeType: fields.officeType ?? null, from, to: d(fields.effectiveTo) }, old.id);
      if (clash) throw AppException.conflict('Another active setting already covers these dates', { existingId: clash.id });
      const closeOn = new Date(from.getTime() - DAY);
      await tx.financeLimitSetting.update({ where: { id: old.id }, data: { effectiveTo: old.effectiveTo && old.effectiveTo < closeOn ? old.effectiveTo : closeOn } });
      const row = await tx.financeLimitSetting.create({ data: { ...this.limitData(auth, old.kind, fields, new Date()), supersedesId: old.id }, include: LIMIT_INCLUDE });
      await this.audit.record(
        {
          tenantId: auth.tenantId,
          action: AUDIT_ACTIONS.FINANCE_LIMIT_SETTING_SUPERSEDED,
          entityType: CAMPAIGN_ENTITY.FINANCE_LIMIT_SETTING,
          entityId: row.id,
          before: this.limit(old),
          after: this.limit(row),
          reason,
        },
        tx,
      );
      return this.limit(row);
    });
  }

  verifyLimit(auth: AuthContext, id: string, body: VerifyFinanceLimitSetting): Promise<FinanceLimitSetting> {
    return this.prisma.tenantTx(async (tx) => {
      const old = await tx.financeLimitSetting.findUnique({ where: { id }, include: LIMIT_INCLUDE });
      if (!old) throw AppException.notFound('Limit setting not found');
      const row = await tx.financeLimitSetting.update({
        where: { id },
        data: body.verified ? { verified: true, verifiedById: auth.userId, verifiedAt: new Date() } : { verified: false, verifiedById: null, verifiedAt: null },
        include: LIMIT_INCLUDE,
      });
      await this.audit.record(
        {
          tenantId: auth.tenantId,
          action: AUDIT_ACTIONS.FINANCE_LIMIT_SETTING_VERIFIED,
          entityType: CAMPAIGN_ENTITY.FINANCE_LIMIT_SETTING,
          entityId: id,
          before: { verified: old.verified, verifiedById: old.verifiedById },
          after: { verified: row.verified, verifiedById: row.verifiedById, enforcement: row.enforcement },
          reason: body.reason,
        },
        tx,
      );
      return this.limit(row);
    });
  }

  /* ------------------------------------------------------------ accounts */

  private async account(tx: TenantTx, id: string): Promise<FinanceAccount> {
    const a = await tx.financeAccount.findUniqueOrThrow({ where: { id } });
    const balances = await accountBalances(tx);
    return {
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
    };
  }

  createAccount(auth: AuthContext, body: SaveFinanceAccount): Promise<FinanceAccount> {
    return this.prisma.tenantTx(async (tx) => {
      const a = await tx.financeAccount.create({
        data: {
          tenantId: auth.tenantId,
          name: body.name,
          type: body.type,
          institution: body.institution ?? null,
          accountNumberMasked: body.accountNumberLast4 ? `•••• ${body.accountNumberLast4}` : null,
          currency: body.currency,
          isDedicatedCampaignAccount: body.isDedicatedCampaignAccount,
          status: body.status,
          createdById: auth.userId,
        },
      });
      await this.audit.record(
        { tenantId: auth.tenantId, action: AUDIT_ACTIONS.FINANCE_ACCOUNT_SAVED, entityType: CAMPAIGN_ENTITY.FINANCE_ACCOUNT, entityId: a.id, after: { name: a.name, type: a.type, currency: a.currency, status: a.status, accountNumberMasked: a.accountNumberMasked } },
        tx,
      );
      return this.account(tx, a.id);
    });
  }

  updateAccount(auth: AuthContext, id: string, body: SaveFinanceAccount & { expectedVersion: number }): Promise<FinanceAccount> {
    return this.prisma.tenantTx(async (tx) => {
      const cur = await tx.financeAccount.findUnique({ where: { id } });
      if (!cur) throw AppException.notFound('Account not found');
      if (cur.version !== body.expectedVersion) throw staleVersion(cur.version, await this.account(tx, id));
      const used = await tx.financeTransaction.count({ where: { OR: [{ accountId: id }, { counterAccountId: id }] } });
      if (body.currency !== cur.currency && used > 0) throw AppException.conflict('The currency cannot change once the account has entries', { reason: 'CURRENCY_FIXED' });
      if (body.status === 'CLOSED' && cur.status !== 'CLOSED') {
        const bal = (await accountBalances(tx)).get(id) ?? 0n;
        if (bal !== 0n) throw AppException.conflict('Close an account only when its posted balance is zero', { balanceMinor: minorToNumber(bal) });
        const open = await tx.financeTransaction.count({ where: { OR: [{ accountId: id }, { counterAccountId: id }], status: { in: ['DRAFT', 'REQUESTED', 'APPROVED'] } } });
        if (open) throw AppException.conflict('Settle or cancel the open entries on this account first', { openEntries: open });
      }
      const r = await tx.financeAccount.updateMany({
        where: { id, version: body.expectedVersion },
        data: {
          name: body.name,
          type: body.type,
          institution: body.institution ?? null,
          ...(body.accountNumberLast4 !== undefined ? { accountNumberMasked: body.accountNumberLast4 ? `•••• ${body.accountNumberLast4}` : null } : {}),
          currency: body.currency,
          isDedicatedCampaignAccount: body.isDedicatedCampaignAccount,
          status: body.status,
          version: { increment: 1 },
        },
      });
      if (r.count === 0) throw staleVersion(cur.version, null);
      await this.audit.record(
        {
          tenantId: auth.tenantId,
          action: AUDIT_ACTIONS.FINANCE_ACCOUNT_SAVED,
          entityType: CAMPAIGN_ENTITY.FINANCE_ACCOUNT,
          entityId: id,
          before: { name: cur.name, status: cur.status, currency: cur.currency },
          after: { name: body.name, status: body.status, currency: body.currency },
        },
        tx,
      );
      return this.account(tx, id);
    });
  }

  /* ---------------------------------------------------------- categories */

  listCategories(): Promise<FinanceCategory[]> {
    return this.prisma.tenantTx(async (tx) => (await tx.financeCategory.findMany({ orderBy: [{ kind: 'asc' }, { code: 'asc' }] })).map(toCategory));
  }

  saveCategory(auth: AuthContext, body: SaveFinanceCategory, id?: string): Promise<FinanceCategory> {
    return this.prisma.tenantTx(async (tx) => {
      if (body.parentId) {
        const parent = await tx.financeCategory.findUnique({ where: { id: body.parentId } });
        if (!parent || parent.kind !== body.kind || parent.id === id) throw AppException.validation('The parent must be another category of the same kind', [{ path: ['parentId'], message: 'Invalid parent' }]);
      }
      let before: unknown = null;
      let row;
      const data = { code: body.code, name: body.name, kind: body.kind, parentId: body.parentId ?? null, description: body.description ?? null, active: body.active };
      if (id) {
        const cur = await tx.financeCategory.findUnique({ where: { id } });
        if (!cur) throw AppException.notFound('Category not found');
        if (cur.kind !== body.kind && (await tx.financeTransaction.count({ where: { categoryId: id } })) > 0) {
          throw AppException.conflict('The kind cannot change once the category is used', { reason: 'KIND_FIXED' });
        }
        before = toCategory(cur);
        row = await tx.financeCategory.update({ where: { id }, data });
      } else {
        if (await tx.financeCategory.findFirst({ where: { code: body.code } })) throw AppException.conflict('A category with this code exists', { reason: 'DUPLICATE_CODE' });
        row = await tx.financeCategory.create({ data: { tenantId: auth.tenantId, ...data } });
      }
      await this.audit.record({ tenantId: auth.tenantId, action: AUDIT_ACTIONS.FINANCE_CATEGORY_SAVED, entityType: CAMPAIGN_ENTITY.FINANCE_CATEGORY, entityId: row.id, before, after: toCategory(row) }, tx);
      return toCategory(row);
    });
  }

  /* -------------------------------------------------------------- payees */

  listPayees(q: PaginationQuery): Promise<Paginated<FinancePayee>> {
    return this.prisma.tenantTx(async (tx) => {
      const where: Prisma.FinancePayeeWhereInput = q.q ? { name: { contains: q.q, mode: 'insensitive' } } : {};
      const [rows, total] = await Promise.all([tx.financePayee.findMany({ where, orderBy: [{ name: 'asc' }, { id: 'asc' }], ...pageArgs(q) }), tx.financePayee.count({ where })]);
      return { items: rows.map(toPayee), page: q.page, pageSize: q.pageSize, total };
    });
  }

  savePayee(auth: AuthContext, body: SaveFinancePayee, id?: string): Promise<FinancePayee> {
    return this.prisma.tenantTx(async (tx) => {
      const pin = body.taxPin ? body.taxPin.trim() : null;
      const hash = pin ? this.fingerprint(auth.tenantId, pin) : null;
      if (hash) {
        const dup = await tx.financePayee.findFirst({ where: { taxPinHash: hash, ...(id ? { id: { not: id } } : {}) }, select: { id: true } });
        if (dup) throw AppException.conflict('A payee with this tax PIN already exists', { existingId: dup.id });
      }
      const data: Prisma.FinancePayeeUncheckedUpdateInput = {
        name: body.name,
        kind: body.kind,
        active: body.active,
        notes: body.notes ?? null,
        ...(body.taxPin !== undefined ? { taxPinMasked: pin ? `${pin.slice(0, 3)}${maskTail(pin.slice(3), 3)}` : null, taxPinHash: hash } : {}),
        ...(body.phone !== undefined ? { phoneMasked: body.phone ? maskTail(body.phone, 3) : null } : {}),
      };
      let row;
      if (id) {
        if (!(await tx.financePayee.findUnique({ where: { id } }))) throw AppException.notFound('Payee not found');
        row = await tx.financePayee.update({ where: { id }, data });
      } else {
        row = await tx.financePayee.create({ data: { ...(data as Prisma.FinancePayeeUncheckedCreateInput), tenantId: auth.tenantId, createdById: auth.userId } });
      }
      await this.audit.record(
        { tenantId: auth.tenantId, action: AUDIT_ACTIONS.FINANCE_PAYEE_SAVED, entityType: CAMPAIGN_ENTITY.FINANCE_PAYEE, entityId: row.id, after: { name: row.name, kind: row.kind, active: row.active, hasTaxPin: !!row.taxPinHash, hasPhone: !!row.phoneMasked } },
        tx,
      );
      return toPayee(row);
    });
  }

  /* ------------------------------------------------- contribution sources */

  listSources(q: PaginationQuery & { electionCycleId?: string; from?: string; to?: string }): Promise<Paginated<ContributionSource>> {
    return this.prisma.tenantTx(async (tx) => {
      const where: Prisma.ContributionSourceWhereInput = q.q ? { displayName: { contains: q.q, mode: 'insensitive' } } : {};
      const [rows, total] = await Promise.all([tx.contributionSource.findMany({ where, orderBy: [{ displayName: 'asc' }, { id: 'asc' }], ...pageArgs(q) }), tx.contributionSource.count({ where })]);
      const sums = await tx.financeTransaction.groupBy({
        by: ['contributionSourceId'],
        where: {
          type: 'CONTRIBUTION',
          status: { in: [...POSTED_NET] },
          contributionSourceId: { in: rows.map((r) => r.id) },
          ...(q.electionCycleId ? { electionCycleId: q.electionCycleId } : {}),
          ...(q.from || q.to ? { transactionDate: { ...(q.from ? { gte: d(q.from)! } : {}), ...(q.to ? { lte: d(q.to)! } : {}) } } : {}),
        },
        _sum: { amountMinor: true },
      });
      const total$ = new Map(sums.map((s) => [s.contributionSourceId, s._sum.amountMinor ?? 0n]));
      return { items: rows.map((r) => toSource(r, total$.get(r.id) ?? 0n)), page: q.page, pageSize: q.pageSize, total };
    });
  }

  saveSource(auth: AuthContext, body: SaveContributionSource, id?: string): Promise<ContributionSource> {
    return this.prisma.tenantTx(async (tx) => {
      const ident = body.identifier ? body.identifier.trim() : null;
      const hash = ident ? this.fingerprint(auth.tenantId, ident) : null;
      if (hash) {
        const dup = await tx.contributionSource.findFirst({ where: { identifierHash: hash, ...(id ? { id: { not: id } } : {}) }, select: { id: true } });
        if (dup) throw AppException.conflict('A contribution source with this identifier already exists', { existingId: dup.id });
      }
      const cur = id ? await tx.contributionSource.findUnique({ where: { id } }) : null;
      if (id && !cur) throw AppException.notFound('Contribution source not found');
      const data = {
        displayName: body.displayName,
        kind: body.kind,
        declared: body.declared,
        declaredAt: body.declared ? (cur?.declared ? cur.declaredAt : new Date()) : null,
        notes: body.notes ?? null,
        ...(body.identifier !== undefined
          ? { identifierMasked: ident ? maskTail(ident, 3, body.kind === 'INDIVIDUAL' ? 'ID ' : 'Reg. ') : null, identifierHash: hash }
          : {}),
      };
      const row = id
        ? await tx.contributionSource.update({ where: { id }, data })
        : await tx.contributionSource.create({ data: { ...data, tenantId: auth.tenantId, createdById: auth.userId } });
      await this.audit.record(
        {
          tenantId: auth.tenantId,
          action: AUDIT_ACTIONS.FINANCE_CONTRIBUTION_SOURCE_SAVED,
          entityType: CAMPAIGN_ENTITY.CONTRIBUTION_SOURCE,
          entityId: row.id,
          before: cur ? { displayName: cur.displayName, kind: cur.kind, declared: cur.declared, hasIdentifier: !!cur.identifierHash } : null,
          after: { displayName: row.displayName, kind: row.kind, declared: row.declared, hasIdentifier: !!row.identifierHash },
        },
        tx,
      );
      return toSource(row, 0n);
    });
  }

  /* --------------------------------------------------------- budget lines */

  private async budgetLines(tx: TenantTx, where: Prisma.FinanceBudgetLineWhereInput): Promise<BudgetLine[]> {
    const rows = await tx.financeBudgetLine.findMany({ where, include: BUDGET_INCLUDE, orderBy: { code: 'asc' } });
    const sums = await budgetActuals(tx, rows.map((r) => r.id));
    return rows.map((r) => toBudget(r, sums.get(r.id)));
  }

  listBudgetLines(q: { departmentId?: string; eventId?: string; electionCycleId?: string }): Promise<BudgetLine[]> {
    return this.prisma.tenantTx((tx) =>
      this.budgetLines(tx, {
        ...(q.departmentId ? { departmentId: q.departmentId } : {}),
        ...(q.eventId ? { eventId: q.eventId } : {}),
        ...(q.electionCycleId ? { electionCycleId: q.electionCycleId } : {}),
      }),
    );
  }

  private async validateBudget(tx: TenantTx, b: SaveBudgetLine) {
    const bad = (path: string, m: string) => AppException.validation(m, [{ path: [path], message: m }]);
    if (b.departmentId && !(await tx.department.findUnique({ where: { id: b.departmentId } }))) throw bad('departmentId', 'Unknown department');
    if (b.eventId && !(await tx.campaignEvent.findUnique({ where: { id: b.eventId } }))) throw bad('eventId', 'Unknown event');
    if (b.categoryId) {
      const c = await tx.financeCategory.findUnique({ where: { id: b.categoryId } });
      if (!c || c.kind !== 'EXPENSE') throw bad('categoryId', 'Choose an expense category');
    }
    if (b.electionCycleId && !(await tx.electionCycle.findUnique({ where: { id: b.electionCycleId } }))) throw bad('electionCycleId', 'Unknown election cycle');
    if (b.periodStart && b.periodEnd && b.periodEnd < b.periodStart) throw bad('periodEnd', 'The period ends before it starts');
  }

  saveBudgetLine(auth: AuthContext, body: SaveBudgetLine, id?: string): Promise<BudgetLine> {
    return this.prisma.tenantTx(async (tx) => {
      await this.validateBudget(tx, body);
      const data = {
        code: body.code,
        name: body.name,
        departmentId: body.departmentId ?? null,
        eventId: body.eventId ?? null,
        categoryId: body.categoryId ?? null,
        electionCycleId: body.electionCycleId ?? null,
        amountMinor: numberToMinor(body.amountMinor),
        currency: body.currency,
        periodStart: d(body.periodStart),
        periodEnd: d(body.periodEnd),
      };
      let before: unknown = null;
      let rowId: string;
      if (id) {
        const cur = await tx.financeBudgetLine.findUnique({ where: { id } });
        if (!cur) throw AppException.notFound('Budget line not found');
        if (cur.status !== 'DRAFT') throw AppException.conflict('Only draft budget lines can be edited; add a new line instead', { status: cur.status });
        if (body.expectedVersion === undefined) throw AppException.validation('expectedVersion is required', [{ path: ['expectedVersion'], message: 'Required' }]);
        if (cur.version !== body.expectedVersion) throw staleVersion(cur.version, null);
        before = { code: cur.code, amountMinor: cur.amountMinor, departmentId: cur.departmentId, eventId: cur.eventId };
        const r = await tx.financeBudgetLine.updateMany({ where: { id, version: body.expectedVersion, status: 'DRAFT' }, data: { ...data, version: { increment: 1 } } });
        if (r.count === 0) throw staleVersion(cur.version, null);
        rowId = id;
      } else {
        if (await tx.financeBudgetLine.findFirst({ where: { code: body.code } })) throw AppException.conflict('A budget line with this code exists', { reason: 'DUPLICATE_CODE' });
        rowId = (await tx.financeBudgetLine.create({ data: { ...data, tenantId: auth.tenantId, status: 'DRAFT', createdById: auth.userId } })).id;
      }
      await this.audit.record(
        { tenantId: auth.tenantId, action: AUDIT_ACTIONS.FINANCE_BUDGET_LINE_SAVED, entityType: CAMPAIGN_ENTITY.BUDGET_LINE, entityId: rowId, before, after: { ...data, status: 'DRAFT' } },
        tx,
      );
      return (await this.budgetLines(tx, { id: rowId }))[0]!;
    });
  }

  approveBudgetLine(auth: AuthContext, id: string, expectedVersion: number): Promise<BudgetLine> {
    return this.prisma.tenantTx(async (tx) => {
      const cur = await tx.financeBudgetLine.findUnique({ where: { id } });
      if (!cur) throw AppException.notFound('Budget line not found');
      if (cur.createdById === auth.userId) throw AppException.separationOfDuties('You created this budget line; someone else must approve it');
      if (cur.status !== 'DRAFT') throw AppException.invalidTransition(cur.status, 'APPROVED');
      if (cur.version !== expectedVersion) throw staleVersion(cur.version, null);
      const r = await tx.financeBudgetLine.updateMany({ where: { id, version: expectedVersion, status: 'DRAFT' }, data: { status: 'APPROVED', approvedById: auth.userId, approvedAt: new Date(), version: { increment: 1 } } });
      if (r.count === 0) throw staleVersion(cur.version, null);
      await this.audit.record(
        { tenantId: auth.tenantId, action: AUDIT_ACTIONS.FINANCE_BUDGET_LINE_APPROVED, entityType: CAMPAIGN_ENTITY.BUDGET_LINE, entityId: id, before: { status: 'DRAFT' }, after: { status: 'APPROVED', amountMinor: cur.amountMinor, approvedById: auth.userId } },
        tx,
      );
      return (await this.budgetLines(tx, { id }))[0]!;
    });
  }

  closeBudgetLine(auth: AuthContext, id: string, expectedVersion: number, reason: string): Promise<BudgetLine> {
    return this.prisma.tenantTx(async (tx) => {
      const cur = await tx.financeBudgetLine.findUnique({ where: { id } });
      if (!cur) throw AppException.notFound('Budget line not found');
      if (cur.status !== 'APPROVED') throw AppException.invalidTransition(cur.status, 'CLOSED');
      if (cur.version !== expectedVersion) throw staleVersion(cur.version, null);
      await tx.financeBudgetLine.updateMany({ where: { id, version: expectedVersion }, data: { status: 'CLOSED', version: { increment: 1 } } });
      await this.audit.record(
        { tenantId: auth.tenantId, action: AUDIT_ACTIONS.FINANCE_BUDGET_LINE_SAVED, entityType: CAMPAIGN_ENTITY.BUDGET_LINE, entityId: id, before: { status: 'APPROVED' }, after: { status: 'CLOSED' }, reason },
        tx,
      );
      return (await this.budgetLines(tx, { id }))[0]!;
    });
  }
}

function toCategory(c: { id: string; code: string; name: string; kind: FinanceCategory['kind']; parentId: string | null; description: string | null; active: boolean }): FinanceCategory {
  return { id: c.id, code: c.code, name: c.name, kind: c.kind, parentId: c.parentId, description: c.description, active: c.active };
}

function toPayee(p: { id: string; name: string; kind: FinancePayee['kind']; taxPinMasked: string | null; phoneMasked: string | null; active: boolean; notes: string | null }): FinancePayee {
  return { id: p.id, name: p.name, kind: p.kind, taxPinMasked: p.taxPinMasked, phoneMasked: p.phoneMasked, active: p.active, notes: p.notes };
}

function toSource(
  s: { id: string; displayName: string; kind: ContributionSource['kind']; identifierMasked: string | null; declared: boolean; declaredAt: Date | null; notes: string | null },
  total: bigint,
): ContributionSource {
  return {
    id: s.id,
    displayName: s.displayName,
    kind: s.kind,
    identifierMasked: s.identifierMasked,
    declared: s.declared,
    declaredAt: iso(s.declaredAt),
    totalContributedMinor: minorToNumber(total)!,
    notes: s.notes,
  };
}

function toBudget(r: BudgetRow, s?: { actual: bigint; committed: bigint }): BudgetLine {
  return {
    id: r.id,
    code: r.code,
    name: r.name,
    department: r.department,
    eventId: r.eventId,
    categoryId: r.categoryId,
    electionCycleId: r.electionCycleId,
    amount: { amountMinor: minorToNumber(r.amountMinor)!, currency: r.currency },
    actual: { amountMinor: minorToNumber(s?.actual ?? 0n)!, currency: r.currency },
    committed: { amountMinor: minorToNumber(s?.committed ?? 0n)!, currency: r.currency },
    periodStart: isoDate(r.periodStart),
    periodEnd: isoDate(r.periodEnd),
    status: r.status,
    approvedBy: r.approvedBy,
    version: r.version,
  };
}

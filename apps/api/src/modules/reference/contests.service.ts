import { Injectable } from '@nestjs/common';
import type { TenantTx } from '@ngao360/db';
import {
  AUDIT_ACTIONS,
  FORM_SERIES,
  type CandidateReference,
  type Contest,
  type CreateCandidateReference,
  type CreateContest,
  type Paginated,
  type UpdateCandidateReference,
  type UpdateContest,
} from '@ngao360/shared';
import type { z } from 'zod';
import { AuditService } from '../../audit/audit.service';
import { AppException } from '../../common/http/app-exception';
import { PrismaService } from '../../prisma/prisma.service';
import type { ContestQuerySchema } from './reference.dto';
import { contains, immutable, pageArgs, sortArgs, toCandidate, toContest } from './reference.common';
import { checkCandidateLabel, CONTEST_AREA_TYPE, CONTEST_TRANSITIONS } from '@ngao360/shared';

type ContestQuery = z.infer<typeof ContestQuerySchema>;

@Injectable()
export class ContestsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  list(q: ContestQuery): Promise<Paginated<Contest>> {
    return this.prisma.tenantTx(async (tx) => {
      const where = {
        electionCycleId: q.electionCycleId,
        ...(q.officeType ? { officeType: q.officeType } : {}),
        ...(q.status ? { status: q.status } : {}),
        ...(q.q ? { name: contains(q.q) } : {}),
      };
      const [rows, total] = await Promise.all([
        tx.contest.findMany({
          where,
          include: { _count: { select: { candidates: true } } },
          ...pageArgs(q),
          orderBy: sortArgs(q, ['name', 'officeType', 'status', 'createdAt'], 'createdAt'),
        }),
        tx.contest.count({ where }),
      ]);
      return { items: rows.map((r) => toContest(r, r._count.candidates)), page: q.page, pageSize: q.pageSize, total };
    });
  }

  get(id: string): Promise<Contest & { candidates: CandidateReference[] }> {
    return this.prisma.tenantTx(async (tx) => {
      const row = await tx.contest.findUnique({ where: { id }, include: { candidates: { orderBy: { ballotOrder: 'asc' } } } });
      if (!row) throw AppException.notFound('Contest not found');
      return { ...toContest(row, row.candidates.length), candidates: row.candidates.map(toCandidate) };
    });
  }

  create(tenantId: string, dto: CreateContest): Promise<Contest> {
    return this.prisma.tenantTx(async (tx) => {
      const cycle = await tx.electionCycle.findUnique({ where: { id: dto.electionCycleId }, select: { status: true } });
      if (!cycle) throw AppException.validation('Election cycle not found', [{ path: 'electionCycleId', message: 'Not found' }]);
      if (cycle.status === 'ARCHIVED' || cycle.status === 'CLOSED') throw immutable(`The election cycle is ${cycle.status.toLowerCase()}`);
      const areaType = CONTEST_AREA_TYPE[dto.officeType];
      if (areaType === null) {
        if (dto.geographicUnitId) {
          throw AppException.validation('A presidential contest is national and has no geographic unit', [{ path: 'geographicUnitId', message: 'Must be null' }]);
        }
        // NULL is distinct in the unique index, so check national contests explicitly.
        const dup = await tx.contest.findFirst({ where: { electionCycleId: dto.electionCycleId, officeType: dto.officeType, geographicUnitId: null } });
        if (dup) throw AppException.conflict('This election cycle already has a presidential contest');
      } else {
        if (!dto.geographicUnitId) {
          throw AppException.validation(`A ${dto.officeType.toLowerCase().replace(/_/g, ' ')} contest needs its ${areaType.toLowerCase()}`, [{ path: 'geographicUnitId', message: 'Required' }]);
        }
        const unit = await tx.geographicUnit.findUnique({ where: { id: dto.geographicUnitId }, select: { type: true, electionCycleId: true } });
        if (!unit || unit.electionCycleId !== dto.electionCycleId) {
          throw AppException.validation('Geographic unit not found in this election cycle', [{ path: 'geographicUnitId', message: 'Not found' }]);
        }
        if (unit.type !== areaType) {
          throw AppException.validation(`The area for this office must be a ${areaType.toLowerCase()}, not a ${unit.type.toLowerCase()}`, [
            { path: 'geographicUnitId', message: `Expected ${areaType}` },
          ]);
        }
      }
      const row = await tx.contest.create({
        data: {
          tenantId,
          electionCycleId: dto.electionCycleId,
          officeType: dto.officeType,
          name: dto.name,
          geographicUnitId: dto.geographicUnitId,
          formSeries: FORM_SERIES[dto.officeType].series,
          status: 'DRAFT',
        },
      });
      const out = toContest(row, 0);
      await this.audit.record({ tenantId, action: AUDIT_ACTIONS.REFERENCE_CREATED, entityType: 'Contest', entityId: row.id, after: out }, tx);
      return out;
    });
  }

  update(tenantId: string, id: string, dto: UpdateContest): Promise<Contest> {
    return this.prisma.tenantTx(async (tx) => {
      const current = await tx.contest.findUnique({ where: { id }, include: { _count: { select: { candidates: true } } } });
      if (!current) throw AppException.notFound('Contest not found');
      if (dto.status && dto.status !== current.status && !CONTEST_TRANSITIONS[current.status].includes(dto.status)) {
        throw AppException.invalidTransition(current.status, dto.status);
      }
      if (dto.status === 'ACTIVE' && current.status !== 'ACTIVE' && current._count.candidates === 0) {
        throw AppException.conflict('Add the candidate list before activating the contest');
      }
      const row = await tx.contest.update({
        where: { id },
        data: { ...(dto.name !== undefined ? { name: dto.name } : {}), ...(dto.status !== undefined ? { status: dto.status } : {}) },
      });
      const out = toContest(row, current._count.candidates);
      await this.audit.record(
        { tenantId, action: AUDIT_ACTIONS.REFERENCE_UPDATED, entityType: 'Contest', entityId: id, before: toContest(current, current._count.candidates), after: out },
        tx,
      );
      return out;
    });
  }

  candidates(contestId: string): Promise<CandidateReference[]> {
    return this.prisma.tenantTx(async (tx) => {
      const contest = await tx.contest.findUnique({ where: { id: contestId }, select: { id: true } });
      if (!contest) throw AppException.notFound('Contest not found');
      const rows = await tx.candidateReference.findMany({ where: { contestId }, orderBy: { ballotOrder: 'asc' } });
      return rows.map(toCandidate);
    });
  }

  /** The candidate list is the form layout: once results are submitted it is frozen. */
  private async assertCandidatesEditable(tx: TenantTx, contestId: string): Promise<void> {
    const submissions = await tx.resultSubmission.count({ where: { contestId } });
    if (submissions > 0) {
      throw immutable('Results have been submitted for this contest, so its candidate list can no longer change');
    }
  }

  addCandidate(tenantId: string, contestId: string, dto: CreateCandidateReference): Promise<CandidateReference> {
    return this.prisma.tenantTx(async (tx) => {
      const contest = await tx.contest.findUnique({ where: { id: contestId }, select: { id: true, status: true } });
      if (!contest) throw AppException.notFound('Contest not found');
      if (contest.status === 'CLOSED') throw immutable('The contest is closed');
      await this.assertCandidatesEditable(tx, contestId);
      const labelProblem = checkCandidateLabel(dto.partyLabel, dto.isIndependent);
      if (labelProblem) throw AppException.validation(labelProblem, [{ path: 'partyLabel', message: labelProblem }]);
      const taken = await tx.candidateReference.findFirst({ where: { contestId, ballotOrder: dto.ballotOrder }, select: { id: true } });
      if (taken) throw AppException.conflict(`Ballot position ${dto.ballotOrder} is already used in this contest`);
      const row = await tx.candidateReference.create({
        data: {
          tenantId,
          contestId,
          candidateNameAsPublished: dto.candidateNameAsPublished,
          partyLabel: dto.isIndependent ? (dto.partyLabel?.trim() ? dto.partyLabel : null) : (dto.partyLabel ?? null),
          isIndependent: dto.isIndependent,
          ballotOrder: dto.ballotOrder,
          referenceCode: dto.referenceCode ?? null,
          source: dto.source,
        },
      });
      const out = toCandidate(row);
      await this.audit.record({ tenantId, action: AUDIT_ACTIONS.REFERENCE_CREATED, entityType: 'CandidateReference', entityId: row.id, after: out }, tx);
      return out;
    });
  }

  updateCandidate(tenantId: string, id: string, dto: UpdateCandidateReference): Promise<CandidateReference> {
    return this.prisma.tenantTx(async (tx) => {
      const current = await tx.candidateReference.findUnique({ where: { id } });
      if (!current) throw AppException.notFound('Candidate not found');
      await this.assertCandidatesEditable(tx, current.contestId);
      const partyLabel = dto.partyLabel !== undefined ? dto.partyLabel : current.partyLabel;
      const isIndependent = dto.isIndependent ?? current.isIndependent;
      const labelProblem = checkCandidateLabel(partyLabel, isIndependent);
      if (labelProblem) throw AppException.validation(labelProblem, [{ path: 'partyLabel', message: labelProblem }]);
      if (dto.ballotOrder !== undefined && dto.ballotOrder !== current.ballotOrder) {
        const taken = await tx.candidateReference.findFirst({ where: { contestId: current.contestId, ballotOrder: dto.ballotOrder }, select: { id: true } });
        if (taken) throw AppException.conflict(`Ballot position ${dto.ballotOrder} is already used in this contest`);
      }
      const row = await tx.candidateReference.update({
        where: { id },
        data: {
          ...(dto.candidateNameAsPublished !== undefined ? { candidateNameAsPublished: dto.candidateNameAsPublished } : {}),
          partyLabel: partyLabel ?? null,
          isIndependent,
          ...(dto.ballotOrder !== undefined ? { ballotOrder: dto.ballotOrder } : {}),
          ...(dto.referenceCode !== undefined ? { referenceCode: dto.referenceCode } : {}),
          ...(dto.source !== undefined ? { source: dto.source } : {}),
        },
      });
      const out = toCandidate(row);
      await this.audit.record(
        { tenantId, action: AUDIT_ACTIONS.REFERENCE_UPDATED, entityType: 'CandidateReference', entityId: id, before: toCandidate(current), after: out },
        tx,
      );
      return out;
    });
  }
}

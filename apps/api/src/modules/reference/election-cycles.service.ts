import { Injectable } from '@nestjs/common';
import {
  AUDIT_ACTIONS,
  type CreateElectionCycle,
  type ElectionCycle,
  type Paginated,
  type PaginationQuery,
  type UpdateElectionCycle,
} from '@ngao360/shared';
import type { Prisma } from '@ngao360/db';
import { AuditService } from '../../audit/audit.service';
import { AppException } from '../../common/http/app-exception';
import { PrismaService } from '../../prisma/prisma.service';
import { contains, dateOnly, immutable, pageArgs, sortArgs, toElectionCycle } from './reference.common';
import { ELECTION_CYCLE_TRANSITIONS } from '@ngao360/shared';

@Injectable()
export class ElectionCyclesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  list(q: PaginationQuery): Promise<Paginated<ElectionCycle>> {
    return this.prisma.tenantTx(async (tx) => {
      const where: Prisma.ElectionCycleWhereInput = q.q ? { name: contains(q.q) } : {};
      const [rows, total] = await Promise.all([
        tx.electionCycle.findMany({ where, ...pageArgs(q), orderBy: sortArgs(q, ['name', 'electionDate', 'createdAt', 'status'], 'electionDate') }),
        tx.electionCycle.count({ where }),
      ]);
      return { items: rows.map(toElectionCycle), page: q.page, pageSize: q.pageSize, total };
    });
  }

  get(id: string): Promise<ElectionCycle> {
    return this.prisma.tenantTx(async (tx) => {
      const row = await tx.electionCycle.findUnique({ where: { id } });
      if (!row) throw AppException.notFound('Election cycle not found');
      return toElectionCycle(row);
    });
  }

  create(tenantId: string, dto: CreateElectionCycle): Promise<ElectionCycle> {
    return this.prisma.tenantTx(async (tx) => {
      const row = await tx.electionCycle.create({
        data: {
          tenantId,
          name: dto.name,
          electionDate: dateOnly(dto.electionDate),
          jurisdiction: dto.jurisdiction,
          legalConfigVersion: dto.legalConfigVersion,
          dataProvenance: dto.dataProvenance,
          containsSimulatedData: dto.containsSimulatedData ?? dto.dataProvenance === 'HISTORICAL_DEMO',
          provenanceNotes: dto.provenanceNotes ?? null,
          officialSources: dto.officialSources,
          status: 'DRAFT',
        },
      });
      const out = toElectionCycle(row);
      await this.audit.record(
        { tenantId, action: AUDIT_ACTIONS.REFERENCE_CREATED, entityType: 'ElectionCycle', entityId: row.id, after: out },
        tx,
      );
      return out;
    });
  }

  update(tenantId: string, id: string, dto: UpdateElectionCycle): Promise<ElectionCycle> {
    return this.prisma.tenantTx(async (tx) => {
      const current = await tx.electionCycle.findUnique({ where: { id } });
      if (!current) throw AppException.notFound('Election cycle not found');
      if (current.status === 'ARCHIVED') throw immutable('An archived election cycle cannot be changed');
      if (dto.status && dto.status !== current.status && !ELECTION_CYCLE_TRANSITIONS[current.status].includes(dto.status)) {
        throw AppException.invalidTransition(current.status, dto.status);
      }
      // Provenance labels every derived record and export; it may only change while the cycle is a draft.
      if (dto.dataProvenance && dto.dataProvenance !== current.dataProvenance && current.status !== 'DRAFT') {
        throw immutable('Data provenance can only be changed while the election cycle is a draft');
      }
      // The historical-demo / simulated-data label can be added, never removed (also a database guard).
      if (current.dataProvenance === 'HISTORICAL_DEMO' && dto.dataProvenance && dto.dataProvenance !== 'HISTORICAL_DEMO') {
        throw immutable('A historical demo election cycle keeps its provenance label');
      }
      if (current.containsSimulatedData && dto.containsSimulatedData === false) {
        throw immutable('The simulated-data label of an election cycle cannot be removed');
      }
      const row = await tx.electionCycle.update({
        where: { id },
        data: {
          ...(dto.name !== undefined ? { name: dto.name } : {}),
          ...(dto.electionDate !== undefined ? { electionDate: dateOnly(dto.electionDate) } : {}),
          ...(dto.jurisdiction !== undefined ? { jurisdiction: dto.jurisdiction } : {}),
          ...(dto.legalConfigVersion !== undefined ? { legalConfigVersion: dto.legalConfigVersion } : {}),
          ...(dto.dataProvenance !== undefined ? { dataProvenance: dto.dataProvenance } : {}),
          ...(dto.containsSimulatedData || dto.dataProvenance === 'HISTORICAL_DEMO' ? { containsSimulatedData: true } : {}),
          ...(dto.provenanceNotes !== undefined ? { provenanceNotes: dto.provenanceNotes } : {}),
          ...(dto.officialSources !== undefined ? { officialSources: dto.officialSources } : {}),
          ...(dto.status !== undefined ? { status: dto.status } : {}),
        },
      });
      const out = toElectionCycle(row);
      await this.audit.record(
        {
          tenantId,
          action: AUDIT_ACTIONS.REFERENCE_UPDATED,
          entityType: 'ElectionCycle',
          entityId: id,
          before: toElectionCycle(current),
          after: out,
        },
        tx,
      );
      return out;
    });
  }
}

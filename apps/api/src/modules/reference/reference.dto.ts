import {
  CreateCandidateReferenceSchema,
  CreateContestSchema,
  CreateElectionCycleSchema,
  CreateFormTemplateSchema,
  CreateGeographicUnitSchema,
  CreatePollingStationSchema,
  CreateRegistryVersionSchema,
  CreateTallyCentreSchema,
  ContestStatusSchema,
  FormTemplateApprovalRequestSchema,
  FormTemplateQuerySchema,
  GeographicUnitQuerySchema,
  IdParamSchema,
  OfficeTypeSchema,
  PaginationQuerySchema,
  PollingStationQuerySchema,
  ReasonSchema,
  TallyCentreLevelSchema,
  UpdateCandidateReferenceSchema,
  UpdateContestSchema,
  UpdateElectionCycleSchema,
  UpdateFormTemplateSchema,
  UpdateGeographicUnitSchema,
  UpdatePollingStationSchema,
  UuidSchema,
} from '@ngao360/shared';
import { z } from 'zod';
import { createZodDto } from '../../common/zod';
import { RegistryVersionListQuerySchema } from './reference.common';

export class IdParamDto extends createZodDto(IdParamSchema) {}
export class PaginationQueryDto extends createZodDto(PaginationQuerySchema) {}
export class ReasonBodyDto extends createZodDto(z.object({ reason: ReasonSchema })) {}

export class CreateElectionCycleDto extends createZodDto(CreateElectionCycleSchema) {}
export class UpdateElectionCycleDto extends createZodDto(UpdateElectionCycleSchema) {}

export class GeographicUnitQueryDto extends createZodDto(GeographicUnitQuerySchema) {}
export class CreateGeographicUnitDto extends createZodDto(CreateGeographicUnitSchema) {}
export class UpdateGeographicUnitDto extends createZodDto(UpdateGeographicUnitSchema) {}

export class RegistryVersionListQueryDto extends createZodDto(RegistryVersionListQuerySchema) {}
export class CreateRegistryVersionDto extends createZodDto(CreateRegistryVersionSchema) {}

export class PollingStationQueryDto extends createZodDto(PollingStationQuerySchema) {}
export class CreatePollingStationDto extends createZodDto(CreatePollingStationSchema) {}
export class UpdatePollingStationDto extends createZodDto(UpdatePollingStationSchema) {}

export const TallyCentreQuerySchema = PaginationQuerySchema.extend({
  electionCycleId: UuidSchema,
  level: TallyCentreLevelSchema.optional(),
});
export class TallyCentreQueryDto extends createZodDto(TallyCentreQuerySchema) {}
export class CreateTallyCentreDto extends createZodDto(CreateTallyCentreSchema) {}
export class UpdateTallyCentreDto extends createZodDto(CreateTallyCentreSchema.partial()) {}

export const ContestQuerySchema = PaginationQuerySchema.extend({
  electionCycleId: UuidSchema,
  officeType: OfficeTypeSchema.optional(),
  status: ContestStatusSchema.optional(),
});
export class ContestQueryDto extends createZodDto(ContestQuerySchema) {}
export class CreateContestDto extends createZodDto(CreateContestSchema) {}
export class UpdateContestDto extends createZodDto(UpdateContestSchema) {}
export class CreateCandidateDto extends createZodDto(CreateCandidateReferenceSchema) {}
export class UpdateCandidateDto extends createZodDto(UpdateCandidateReferenceSchema) {}

export class FormTemplateQueryDto extends createZodDto(FormTemplateQuerySchema) {}
export class CreateFormTemplateDto extends createZodDto(CreateFormTemplateSchema) {}
export class UpdateFormTemplateDto extends createZodDto(UpdateFormTemplateSchema) {}
export class FormTemplateApprovalDto extends createZodDto(FormTemplateApprovalRequestSchema) {}

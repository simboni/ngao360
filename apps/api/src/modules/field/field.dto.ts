/**
 * DTO classes for every field and election-operations endpoint (zod schemas
 * from @ngao360/shared, packages/shared/src/field; docs/API_CONTRACT.md
 * §15–22). Shared by the field sub-modules so they never define ad-hoc shapes.
 */
import {
  BulkCreateDeploymentSchema,
  IdParamSchema,
  AddIncidentEventSchema,
  AgentQuerySchema,
  AttachEvidenceSchema,
  RosterExportSchema,
  StationStatusParamQuerySchema,
  AgentStatusChangeSchema,
  AssignIncidentSchema,
  CancelDeploymentSchema,
  CheckInSchema,
  CheckOutSchema,
  CloseIncidentSchema,
  ConfirmDeploymentSchema,
  CreateAgentSchema,
  CreateDeploymentSchema,
  CreateFieldReportSchema,
  CreateFieldReportTemplateSchema,
  CreateIncidentSchema,
  DeploymentCoverageQuerySchema,
  DeploymentQuerySchema,
  EscalateIncidentSchema,
  FieldReportQuerySchema,
  FieldReportTemplateQuerySchema,
  FieldReportTemplateTransitionSchema,
  GenerateReadinessSchema,
  IncidentQuerySchema,
  LinkAgentUserSchema,
  ReadinessQuerySchema,
  RecordIncidentSubjectSchema,
  RecordTrainingSchema,
  ReopenIncidentSchema,
  ReplaceDeploymentSchema,
  ResolveIncidentSchema,
  RevealAgentSensitiveSchema,
  ReviewFieldReportSchema,
  SetAccreditationSchema,
  SetStationStatusSchema,
  StationStatusQuerySchema,
  SyncRequestSchema,
  SyncStatusQuerySchema,
  TriageIncidentSchema,
  UpdateAgentSchema,
  UpdateAgentSensitiveSchema,
  UpdateDeploymentSchema,
  UpdateReadinessItemSchema,
  UpdateTrainingSchema,
  WarRoomQuerySchema,
} from '@ngao360/shared';
import { z } from 'zod';
import { createZodDto } from '../../common/zod/zod-dto';
import { DownloadQuerySchema } from './common/field-support';

export class FieldIdParamDto extends createZodDto(IdParamSchema) {}
export class TrainingParamDto extends createZodDto(z.object({ id: z.string().uuid(), trainingId: z.string().uuid() })) {}
export class ReadinessItemParamDto extends createZodDto(z.object({ id: z.string().uuid(), itemId: z.string().uuid() })) {}
export class AttachEvidenceDto extends createZodDto(AttachEvidenceSchema) {}
export class StationCodeParamDto extends createZodDto(z.object({ code: z.string().trim().min(1).max(32) })) {}

// Agents (§16)
export class AgentQueryDto extends createZodDto(AgentQuerySchema) {}
export class CreateAgentDto extends createZodDto(CreateAgentSchema) {}
export class UpdateAgentDto extends createZodDto(UpdateAgentSchema) {}
export class AgentStatusChangeDto extends createZodDto(AgentStatusChangeSchema) {}
export class UpdateAgentSensitiveDto extends createZodDto(UpdateAgentSensitiveSchema) {}
export class RevealAgentSensitiveDto extends createZodDto(RevealAgentSensitiveSchema) {}
export class RecordTrainingDto extends createZodDto(RecordTrainingSchema) {}
export class UpdateTrainingDto extends createZodDto(UpdateTrainingSchema) {}
export class SetAccreditationDto extends createZodDto(SetAccreditationSchema) {}
export class LinkAgentUserDto extends createZodDto(LinkAgentUserSchema) {}

// Deployment (§17)
export class DeploymentQueryDto extends createZodDto(DeploymentQuerySchema) {}
export class CreateDeploymentDto extends createZodDto(CreateDeploymentSchema) {}
export class UpdateDeploymentDto extends createZodDto(UpdateDeploymentSchema) {}
export class ReplaceDeploymentDto extends createZodDto(ReplaceDeploymentSchema) {}
export class CancelDeploymentDto extends createZodDto(CancelDeploymentSchema) {}
export class ConfirmDeploymentDto extends createZodDto(ConfirmDeploymentSchema) {}
export class CheckInDto extends createZodDto(CheckInSchema) {}
export class CheckOutDto extends createZodDto(CheckOutSchema) {}
export class RosterExportDto extends createZodDto(RosterExportSchema) {}
export class DeploymentCoverageQueryDto extends createZodDto(DeploymentCoverageQuerySchema) {}

// Readiness (§18)
export class ReadinessQueryDto extends createZodDto(ReadinessQuerySchema) {}
export class GenerateReadinessDto extends createZodDto(GenerateReadinessSchema) {}
export class UpdateReadinessItemDto extends createZodDto(UpdateReadinessItemSchema) {}

// Field reports (§19)
export class FieldReportTemplateQueryDto extends createZodDto(FieldReportTemplateQuerySchema) {}
export class CreateFieldReportTemplateDto extends createZodDto(CreateFieldReportTemplateSchema) {}
export class FieldReportTemplateTransitionDto extends createZodDto(FieldReportTemplateTransitionSchema) {}
export class FieldReportQueryDto extends createZodDto(FieldReportQuerySchema) {}
export class CreateFieldReportDto extends createZodDto(CreateFieldReportSchema) {}
export class ReviewFieldReportDto extends createZodDto(ReviewFieldReportSchema) {}

// Incidents (§20)
export class IncidentQueryDto extends createZodDto(IncidentQuerySchema) {}
export class CreateIncidentDto extends createZodDto(CreateIncidentSchema) {}
export class TriageIncidentDto extends createZodDto(TriageIncidentSchema) {}
export class AssignIncidentDto extends createZodDto(AssignIncidentSchema) {}
export class EscalateIncidentDto extends createZodDto(EscalateIncidentSchema) {}
export class AddIncidentEventDto extends createZodDto(AddIncidentEventSchema) {}
export class ResolveIncidentDto extends createZodDto(ResolveIncidentSchema) {}
export class CloseIncidentDto extends createZodDto(CloseIncidentSchema) {}
export class ReopenIncidentDto extends createZodDto(ReopenIncidentSchema) {}
export class RecordIncidentSubjectDto extends createZodDto(RecordIncidentSubjectSchema) {}

// War Room (§21)
export class WarRoomQueryDto extends createZodDto(WarRoomQuerySchema) {}
export class StationStatusQueryDto extends createZodDto(StationStatusQuerySchema) {}
export class StationStatusParamQueryDto extends createZodDto(StationStatusParamQuerySchema) {}
export class SetStationStatusDto extends createZodDto(SetStationStatusSchema) {}

// Sync (§22)
export class SyncRequestDto extends createZodDto(SyncRequestSchema) {}
export class SyncStatusQueryDto extends createZodDto(SyncStatusQuerySchema) {}

// Files and extras local to the field module
export class DownloadQueryDto extends createZodDto(DownloadQuerySchema) {}
export class FileParamDto extends createZodDto(z.object({ id: z.string().uuid(), fileId: z.string().uuid() })) {}

export class BulkCreateDeploymentDto extends createZodDto(BulkCreateDeploymentSchema) {}

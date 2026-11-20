/**
 * DTO classes for every campaign and organisation endpoint (zod schemas from
 * @ngao360/shared, packages/shared/src/campaign; docs/API_CONTRACT.md §23–30).
 * Shared by the campaign sub-modules so they never define ad-hoc shapes.
 */
import {
  AcknowledgeNotificationSchema,
  AddBreachEventSchema,
  AddEventDocumentSchema,
  AddFinanceDocumentSchema,
  AddTaskAttachmentSchema,
  AddTaskCommentSchema,
  AddTaskDependencySchema,
  AddTeamMembersSchema,
  AssignableUserQuerySchema,
  AssignTaskSchema,
  AttendanceParamSchema,
  BreachQuerySchema,
  CampaignEventQuerySchema,
  CampaignIdParamSchema,
  ChangeCampaignEventStatusSchema,
  ChangeTaskStatusSchema,
  ContentQuerySchema,
  ContentTransitionSchema,
  CorrectContentSchema,
  CreateBreachSchema,
  CreateCampaignEventSchema,
  CreateContentSchema,
  CreateDepartmentSchema,
  CreateFinanceLimitSettingSchema,
  CreateFinanceTransactionSchema,
  CreateLogisticsItemSchema,
  CreateReportExportSchema,
  CreateTaskSchema,
  CreateTeamSchema,
  DepartmentQuerySchema,
  ExportBreachTimelineSchema,
  FinanceExportRequestSchema,
  FinanceLedgerQuerySchema,
  FinanceLimitQuerySchema,
  FinanceTransactionQuerySchema,
  FinanceTransitionSchema,
  LogisticsParamSchema,
  NotificationCenterQuerySchema,
  RecordAttendanceSchema,
  RemoveTeamMemberSchema,
  ReportDefinitionSchema,
  ReportExportQuerySchema,
  ReportTemplateQuerySchema,
  RevealAttendanceContactSchema,
  ReverseFinanceTransactionSchema,
  ReviewAfterActionReportSchema,
  ReviewTaskSchema,
  SaveAfterActionReportSchema,
  SaveBudgetLineSchema,
  SaveContributionSourceSchema,
  SaveEventAgendaSchema,
  SaveFinanceAccountSchema,
  SaveFinanceCategorySchema,
  SaveFinancePayeeSchema,
  SaveReportTemplateSchema,
  SaveTaskChecklistSchema,
  SupersedeFinanceLimitSettingSchema,
  TaskCalendarQuerySchema,
  TaskDependencyParamSchema,
  TaskQuerySchema,
  TeamMemberParamSchema,
  TeamQuerySchema,
  UpdateBreachSchema,
  UpdateCampaignEventSchema,
  UpdateContentSchema,
  UpdateDepartmentSchema,
  UpdateFinanceTransactionSchema,
  UpdateLogisticsItemSchema,
  UpdateNotificationPreferencesSchema,
  UpdateTaskSchema,
  UpdateTeamSchema,
  VerifyFinanceLimitSettingSchema,
} from '@ngao360/shared';
import {
  AttachmentParamSchema,
  AttendanceExportSchema,
  BudgetLineQuerySchema,
  ContributionSourceQuerySchema,
  DocumentParamSchema,
  ExpectedVersionBodySchema,
  PaginationQuerySchema,
  ReasonBodySchema,
  UpdateFinanceAccountSchema,
  VersionReasonBodySchema,
} from '@ngao360/shared';
import { createZodDto } from '../../common/zod/zod-dto';

export class CampaignIdParamDto extends createZodDto(CampaignIdParamSchema) {}
export class AssignableUserQueryDto extends createZodDto(AssignableUserQuerySchema) {}

// Organisation (§23)
export class DepartmentQueryDto extends createZodDto(DepartmentQuerySchema) {}
export class CreateDepartmentDto extends createZodDto(CreateDepartmentSchema) {}
export class UpdateDepartmentDto extends createZodDto(UpdateDepartmentSchema) {}
export class TeamQueryDto extends createZodDto(TeamQuerySchema) {}
export class CreateTeamDto extends createZodDto(CreateTeamSchema) {}
export class UpdateTeamDto extends createZodDto(UpdateTeamSchema) {}
export class AddTeamMembersDto extends createZodDto(AddTeamMembersSchema) {}
export class RemoveTeamMemberDto extends createZodDto(RemoveTeamMemberSchema) {}
export class TeamMemberParamDto extends createZodDto(TeamMemberParamSchema) {}

// Tasks (§24)
export class TaskQueryDto extends createZodDto(TaskQuerySchema) {}
export class TaskCalendarQueryDto extends createZodDto(TaskCalendarQuerySchema) {}
export class CreateTaskDto extends createZodDto(CreateTaskSchema) {}
export class UpdateTaskDto extends createZodDto(UpdateTaskSchema) {}
export class AssignTaskDto extends createZodDto(AssignTaskSchema) {}
export class ChangeTaskStatusDto extends createZodDto(ChangeTaskStatusSchema) {}
export class ReviewTaskDto extends createZodDto(ReviewTaskSchema) {}
export class AddTaskDependencyDto extends createZodDto(AddTaskDependencySchema) {}
export class TaskDependencyParamDto extends createZodDto(TaskDependencyParamSchema) {}
export class SaveTaskChecklistDto extends createZodDto(SaveTaskChecklistSchema) {}
export class AddTaskCommentDto extends createZodDto(AddTaskCommentSchema) {}
export class AddTaskAttachmentDto extends createZodDto(AddTaskAttachmentSchema) {}

// Events (§25)
export class CampaignEventQueryDto extends createZodDto(CampaignEventQuerySchema) {}
export class CreateCampaignEventDto extends createZodDto(CreateCampaignEventSchema) {}
export class UpdateCampaignEventDto extends createZodDto(UpdateCampaignEventSchema) {}
export class ChangeCampaignEventStatusDto extends createZodDto(ChangeCampaignEventStatusSchema) {}
export class SaveEventAgendaDto extends createZodDto(SaveEventAgendaSchema) {}
export class CreateLogisticsItemDto extends createZodDto(CreateLogisticsItemSchema) {}
export class UpdateLogisticsItemDto extends createZodDto(UpdateLogisticsItemSchema) {}
export class LogisticsParamDto extends createZodDto(LogisticsParamSchema) {}
export class RecordAttendanceDto extends createZodDto(RecordAttendanceSchema) {}
export class AttendanceParamDto extends createZodDto(AttendanceParamSchema) {}
export class RevealAttendanceContactDto extends createZodDto(RevealAttendanceContactSchema) {}
export class AddEventDocumentDto extends createZodDto(AddEventDocumentSchema) {}
export class SaveAfterActionReportDto extends createZodDto(SaveAfterActionReportSchema) {}
export class ReviewAfterActionReportDto extends createZodDto(ReviewAfterActionReportSchema) {}

// Communications (§26)
export class ContentQueryDto extends createZodDto(ContentQuerySchema) {}
export class CreateContentDto extends createZodDto(CreateContentSchema) {}
export class UpdateContentDto extends createZodDto(UpdateContentSchema) {}
export class ContentTransitionDto extends createZodDto(ContentTransitionSchema) {}
export class CorrectContentDto extends createZodDto(CorrectContentSchema) {}

// Finance (§27)
export class FinanceLedgerQueryDto extends createZodDto(FinanceLedgerQuerySchema) {}
export class FinanceTransactionQueryDto extends createZodDto(FinanceTransactionQuerySchema) {}
export class CreateFinanceTransactionDto extends createZodDto(CreateFinanceTransactionSchema) {}
export class UpdateFinanceTransactionDto extends createZodDto(UpdateFinanceTransactionSchema) {}
export class AddFinanceDocumentDto extends createZodDto(AddFinanceDocumentSchema) {}
export class FinanceTransitionDto extends createZodDto(FinanceTransitionSchema) {}
export class ReverseFinanceTransactionDto extends createZodDto(ReverseFinanceTransactionSchema) {}
export class SaveFinanceAccountDto extends createZodDto(SaveFinanceAccountSchema) {}
export class SaveFinanceCategoryDto extends createZodDto(SaveFinanceCategorySchema) {}
export class SaveFinancePayeeDto extends createZodDto(SaveFinancePayeeSchema) {}
export class SaveContributionSourceDto extends createZodDto(SaveContributionSourceSchema) {}
export class SaveBudgetLineDto extends createZodDto(SaveBudgetLineSchema) {}
export class FinanceLimitQueryDto extends createZodDto(FinanceLimitQuerySchema) {}
export class CreateFinanceLimitSettingDto extends createZodDto(CreateFinanceLimitSettingSchema) {}
export class SupersedeFinanceLimitSettingDto extends createZodDto(SupersedeFinanceLimitSettingSchema) {}
export class VerifyFinanceLimitSettingDto extends createZodDto(VerifyFinanceLimitSettingSchema) {}
export class FinanceExportRequestDto extends createZodDto(FinanceExportRequestSchema) {}

// Reports (§28)
export class ReportDefinitionDto extends createZodDto(ReportDefinitionSchema) {}
export class ReportTemplateQueryDto extends createZodDto(ReportTemplateQuerySchema) {}
export class SaveReportTemplateDto extends createZodDto(SaveReportTemplateSchema) {}
export class CreateReportExportDto extends createZodDto(CreateReportExportSchema) {}
export class ReportExportQueryDto extends createZodDto(ReportExportQuerySchema) {}

// Notification centre (§29)
export class NotificationCenterQueryDto extends createZodDto(NotificationCenterQuerySchema) {}
export class AcknowledgeNotificationDto extends createZodDto(AcknowledgeNotificationSchema) {}
export class UpdateNotificationPreferencesDto extends createZodDto(UpdateNotificationPreferencesSchema) {}

// Breach register (§30)
export class BreachQueryDto extends createZodDto(BreachQuerySchema) {}
export class CreateBreachDto extends createZodDto(CreateBreachSchema) {}
export class UpdateBreachDto extends createZodDto(UpdateBreachSchema) {}
export class AddBreachEventDto extends createZodDto(AddBreachEventSchema) {}
export class ExportBreachTimelineDto extends createZodDto(ExportBreachTimelineSchema) {}

/* Small request shapes (shared since the integration pass: packages/shared/src/campaign/requests.ts). */
export const CampaignPaginationQuerySchema = PaginationQuerySchema;
export class PaginationQueryDto extends createZodDto(PaginationQuerySchema) {}
export class ReasonBodyDto extends createZodDto(ReasonBodySchema) {}
export class ExpectedVersionBodyDto extends createZodDto(ExpectedVersionBodySchema) {}
export class VersionReasonBodyDto extends createZodDto(VersionReasonBodySchema) {}
export class AttendanceExportDto extends createZodDto(AttendanceExportSchema) {}
export class BudgetLineQueryDto extends createZodDto(BudgetLineQuerySchema) {}
export class ContributionSourceQueryDto extends createZodDto(ContributionSourceQuerySchema) {}
export class UpdateFinanceAccountDto extends createZodDto(UpdateFinanceAccountSchema) {}
export class AttachmentParamDto extends createZodDto(AttachmentParamSchema) {}
export class DocumentParamDto extends createZodDto(DocumentParamSchema) {}

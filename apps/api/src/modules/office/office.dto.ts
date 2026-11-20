import {
  AddCaseEventSchema,
  AppointmentQuerySchema,
  AppointmentTransitionSchema,
  AssignCaseSchema,
  AssignCorrespondenceSchema,
  CaseQuerySchema,
  CaseReferralParamSchema,
  CaseTransitionSchema,
  CloseCaseSchema,
  CorrespondenceQuerySchema,
  CorrespondenceTransitionSchema,
  CreateAppointmentSchema,
  CreateCaseReferralSchema,
  CreateCaseSchema,
  CreateCorrespondenceSchema,
  CreateInstitutionSchema,
  CreateMeetingSchema,
  CreateProjectMilestoneSchema,
  CreateProjectSchema,
  EraseCaseContactSchema,
  RedactCaseSchema,
  IdParamSchema,
  InstitutionQuerySchema,
  MeetingActionItemParamSchema,
  MeetingQuerySchema,
  ProjectEvidenceParamSchema,
  ProjectMilestoneParamSchema,
  ProjectQuerySchema,
  ProjectTransitionSchema,
  ProposeCaseResolutionSchema,
  PublicCitizenFeedbackSchema,
  PublicEvidenceParamSchema,
  PublicProjectParamSchema,
  PublicProjectQuerySchema,
  PublicTenantParamSchema,
  PublicTrackRequestSchema,
  RecordMeetingDecisionSchema,
  ReopenCaseSchema,
  SaveMeetingActionItemSchema,
  UpdateAppointmentSchema,
  UpdateCaseContactSchema,
  UpdateCaseReferralSchema,
  UpdateCaseSchema,
  UpdateCorrespondenceSchema,
  UpdateInstitutionSchema,
  UpdateMeetingSchema,
  UpdateProjectMilestoneSchema,
  UpdateProjectPublicationSchema,
  UpdateProjectSchema,
  UuidSchema,
  VerifyProjectCompletionSchema,
  VerifyProjectExpenditureSchema,
  VerifyRecordSchema,
} from '@ngao360/shared';
import { z } from 'zod';
import { createZodDto } from '../../common/zod/zod-dto';
import { DownloadQuerySchema } from './common/office-helpers';

/** Request DTOs for every Office endpoint (schemas from @ngao360/shared/office). */
export class OfficeIdParamDto extends createZodDto(IdParamSchema) {}
export class DownloadQueryDto extends createZodDto(DownloadQuerySchema) {}

// Correspondence (§9)
export class CorrespondenceQueryDto extends createZodDto(CorrespondenceQuerySchema) {}
export class CreateCorrespondenceDto extends createZodDto(CreateCorrespondenceSchema) {}
export class UpdateCorrespondenceDto extends createZodDto(UpdateCorrespondenceSchema) {}
export class AssignCorrespondenceDto extends createZodDto(AssignCorrespondenceSchema) {}
export class CorrespondenceTransitionDto extends createZodDto(CorrespondenceTransitionSchema) {}
export class AttachmentParamDto extends createZodDto(z.object({ id: UuidSchema, attachmentId: UuidSchema })) {}

// Appointments and meetings (§10)
export class AppointmentQueryDto extends createZodDto(AppointmentQuerySchema) {}
export class CreateAppointmentDto extends createZodDto(CreateAppointmentSchema) {}
export class UpdateAppointmentDto extends createZodDto(UpdateAppointmentSchema) {}
export class AppointmentTransitionDto extends createZodDto(AppointmentTransitionSchema) {}
export class MeetingQueryDto extends createZodDto(MeetingQuerySchema) {}
export class CreateMeetingDto extends createZodDto(CreateMeetingSchema) {}
export class UpdateMeetingDto extends createZodDto(UpdateMeetingSchema) {}
export class SaveMeetingActionItemDto extends createZodDto(SaveMeetingActionItemSchema) {}
export class MeetingActionItemParamDto extends createZodDto(MeetingActionItemParamSchema) {}
export class RecordMeetingDecisionDto extends createZodDto(RecordMeetingDecisionSchema) {}

// Cases (§11)
export class CaseQueryDto extends createZodDto(CaseQuerySchema) {}
export class CreateCaseDto extends createZodDto(CreateCaseSchema) {}
export class UpdateCaseDto extends createZodDto(UpdateCaseSchema) {}
export class AssignCaseDto extends createZodDto(AssignCaseSchema) {}
export class CaseTransitionDto extends createZodDto(CaseTransitionSchema) {}
export class AddCaseEventDto extends createZodDto(AddCaseEventSchema) {}
export class UpdateCaseContactDto extends createZodDto(UpdateCaseContactSchema) {}
export class EraseCaseContactDto extends createZodDto(EraseCaseContactSchema) {}
export class RedactCaseDto extends createZodDto(RedactCaseSchema) {}
export class CreateCaseReferralDto extends createZodDto(CreateCaseReferralSchema) {}
export class UpdateCaseReferralDto extends createZodDto(UpdateCaseReferralSchema) {}
export class CaseReferralParamDto extends createZodDto(CaseReferralParamSchema) {}
export class ProposeCaseResolutionDto extends createZodDto(ProposeCaseResolutionSchema) {}
export class CloseCaseDto extends createZodDto(CloseCaseSchema) {}
export class ReopenCaseDto extends createZodDto(ReopenCaseSchema) {}
export class CaseFileParamDto extends createZodDto(z.object({ id: UuidSchema, fileId: UuidSchema })) {}

// Projects and institutions (§12)
export class ProjectQueryDto extends createZodDto(ProjectQuerySchema) {}
export class CreateProjectDto extends createZodDto(CreateProjectSchema) {}
export class UpdateProjectDto extends createZodDto(UpdateProjectSchema) {}
export class ProjectTransitionDto extends createZodDto(ProjectTransitionSchema) {}
export class VerifyProjectCompletionDto extends createZodDto(VerifyProjectCompletionSchema) {}
export class VerifyProjectExpenditureDto extends createZodDto(VerifyProjectExpenditureSchema) {}
export class CreateProjectMilestoneDto extends createZodDto(CreateProjectMilestoneSchema) {}
export class UpdateProjectMilestoneDto extends createZodDto(UpdateProjectMilestoneSchema) {}
export class ProjectMilestoneParamDto extends createZodDto(ProjectMilestoneParamSchema) {}
export class VerifyRecordDto extends createZodDto(VerifyRecordSchema) {}
export class ProjectEvidenceParamDto extends createZodDto(ProjectEvidenceParamSchema) {}
export class UpdateProjectPublicationDto extends createZodDto(UpdateProjectPublicationSchema) {}
export class InstitutionQueryDto extends createZodDto(InstitutionQuerySchema) {}
export class CreateInstitutionDto extends createZodDto(CreateInstitutionSchema) {}
export class UpdateInstitutionDto extends createZodDto(UpdateInstitutionSchema) {}

// Public portal (§13)
export class PublicTenantParamDto extends createZodDto(PublicTenantParamSchema) {}
export class PublicTrackRequestDto extends createZodDto(PublicTrackRequestSchema) {}
export class PublicCitizenFeedbackDto extends createZodDto(PublicCitizenFeedbackSchema) {}
export class PublicProjectQueryDto extends createZodDto(PublicProjectQuerySchema) {}
export class PublicProjectParamDto extends createZodDto(PublicProjectParamSchema) {}
export class PublicEvidenceParamDto extends createZodDto(PublicEvidenceParamSchema) {}

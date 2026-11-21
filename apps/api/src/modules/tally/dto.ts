import {
  AggregateQuerySchema,
  AssignDiscrepancySchema,
  ConfirmDeclaredRedactionSchema,
  CloseDiscrepancySchema,
  CreateDiscrepancySchema,
  CreateExportSchema,
  CreateSnapshotSchema,
  CreateVerificationSchema,
  DesignateCanonicalSchema,
  DiscrepancyCommentSchema,
  DiscrepancyQuerySchema,
  DiscrepancyTransitionSchema,
  DisplayHoldQuerySchema,
  IdParamSchema,
  PaginationQuerySchema,
  ReasonSchema,
  ReleaseSnapshotSchema,
  ResolveDiscrepancySchema,
  SaveCaptureSchema,
  SnapshotQuerySchema,
  SubmissionQuerySchema,
  SubmissionTransitionSchema,
  SupervisorActionRequestSchema,
  UuidSchema,
} from '@ngao360/shared';
import { z } from 'zod';
import { createZodDto } from '../../common/zod/zod-dto';

export class IdParamDto extends createZodDto(IdParamSchema) {}
export class SubmissionQueryDto extends createZodDto(SubmissionQuerySchema) {}
export class SubmissionTransitionDto extends createZodDto(SubmissionTransitionSchema) {}
export class DesignateCanonicalDto extends createZodDto(DesignateCanonicalSchema) {}
export class SaveCaptureDto extends createZodDto(SaveCaptureSchema) {}
export class SubmitForReviewDto extends createZodDto(z.object({ reason: ReasonSchema.optional() }).default({})) {}
export class SourceUrlQueryDto extends createZodDto(
  z.object({ download: z.enum(['0', '1', 'true', 'false']).optional().transform((v) => v === '1' || v === 'true') }),
) {}
export class CreateVerificationDto extends createZodDto(CreateVerificationSchema) {}
export class SupervisorActionDto extends createZodDto(SupervisorActionRequestSchema) {}

export class DiscrepancyQueryDto extends createZodDto(DiscrepancyQuerySchema) {}
export class CreateDiscrepancyDto extends createZodDto(CreateDiscrepancySchema) {}
export class AssignDiscrepancyDto extends createZodDto(AssignDiscrepancySchema) {}
export class DiscrepancyCommentDto extends createZodDto(DiscrepancyCommentSchema) {}
export class DiscrepancyTransitionDto extends createZodDto(DiscrepancyTransitionSchema) {}
export class ResolveDiscrepancyDto extends createZodDto(ResolveDiscrepancySchema) {}
export class CloseDiscrepancyDto extends createZodDto(CloseDiscrepancySchema) {}

export class AggregateQueryDto extends createZodDto(AggregateQuerySchema) {}
export class BreakdownQueryDto extends createZodDto(AggregateQuerySchema.extend({ parentUnitId: UuidSchema.optional() })) {}
export class StationsQueryDto extends createZodDto(
  AggregateQuerySchema.merge(PaginationQuerySchema).extend({
    status: z.enum(['MISSING', 'RECEIVED', 'VERIFIED', 'FLAGGED', 'EXCLUDED']).optional(),
  }),
) {}
export class CreateSnapshotDto extends createZodDto(CreateSnapshotSchema) {}
export class SnapshotQueryDto extends createZodDto(SnapshotQuerySchema) {}
export class ReleaseSnapshotDto extends createZodDto(ReleaseSnapshotSchema) {}

export class CreateExportDto extends createZodDto(CreateExportSchema) {}
export class ExportQueryDto extends createZodDto(PaginationQuerySchema.extend({ snapshotId: UuidSchema.optional() })) {}

/* Display holds (API contract §35) */
export class DisplayHoldQueryDto extends createZodDto(DisplayHoldQuerySchema) {}
export class HoldIdParamDto extends createZodDto(z.object({ holdId: UuidSchema })) {}
export class ConfirmDeclaredRedactionDto extends createZodDto(ConfirmDeclaredRedactionSchema) {}

/**
 * Reference-data DTOs: election cycles, geography, registry versions, polling
 * stations, tally centres, contests, candidate references, form templates.
 */
import { z } from 'zod';
import {
  ContestStatusSchema,
  DataProvenanceSchema,
  ElectionCycleStatusSchema,
  FormLevelSchema,
  FormTemplateApprovalStateSchema,
  GeographicUnitTypeSchema,
  OfficeTypeSchema,
  PollingStationStatusSchema,
  RegistryVersionStatusSchema,
  TallyCentreLevelSchema,
} from '../enums';
import { FormFieldSchemaSchema, ValidationRulesSchema } from '../form-schema';
import { IsoDateSchema, IsoDateTimeSchema, PaginationQuerySchema, UuidSchema } from './common';

/* ----------------------------- Election cycles ---------------------------- */

export const OfficialSourceSchema = z.object({
  title: z.string().min(1),
  reference: z.string().optional(),
  url: z.string().url().optional(),
  retrievedAt: IsoDateSchema.optional(),
});
export type OfficialSource = z.infer<typeof OfficialSourceSchema>;

export const ElectionCycleSchema = z.object({
  id: UuidSchema,
  name: z.string(),
  electionDate: IsoDateSchema,
  jurisdiction: z.string(),
  legalConfigVersion: z.string(),
  status: ElectionCycleStatusSchema,
  dataProvenance: DataProvenanceSchema,
  officialSources: z.array(OfficialSourceSchema),
  createdAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
});
export type ElectionCycle = z.infer<typeof ElectionCycleSchema>;

export const CreateElectionCycleSchema = z.object({
  name: z.string().trim().min(3).max(200),
  electionDate: IsoDateSchema,
  jurisdiction: z.string().trim().min(2).max(100).default('Kenya'),
  legalConfigVersion: z.string().trim().min(1).max(100),
  dataProvenance: DataProvenanceSchema.default('LIVE'),
  officialSources: z.array(OfficialSourceSchema).default([]),
});
export type CreateElectionCycle = z.infer<typeof CreateElectionCycleSchema>;

export const UpdateElectionCycleSchema = CreateElectionCycleSchema.partial().extend({
  status: ElectionCycleStatusSchema.optional(),
});
export type UpdateElectionCycle = z.infer<typeof UpdateElectionCycleSchema>;

/* ------------------------------- Geography -------------------------------- */

export const GeographicUnitSchema = z.object({
  id: UuidSchema,
  electionCycleId: UuidSchema,
  type: GeographicUnitTypeSchema,
  parentId: UuidSchema.nullable(),
  officialCode: z.string(),
  officialName: z.string(),
  /** Materialised ancestor path "/<countyId>/<constituencyId>/..." including self. */
  path: z.string(),
  sourceVersion: z.string(),
  validFrom: IsoDateSchema.nullable(),
  validTo: IsoDateSchema.nullable(),
  childCount: z.number().int().optional(),
});
export type GeographicUnit = z.infer<typeof GeographicUnitSchema>;

export const GeographicUnitQuerySchema = PaginationQuerySchema.extend({
  electionCycleId: UuidSchema,
  type: GeographicUnitTypeSchema.optional(),
  parentId: UuidSchema.optional(),
});
export type GeographicUnitQuery = z.infer<typeof GeographicUnitQuerySchema>;

export const CreateGeographicUnitSchema = z.object({
  electionCycleId: UuidSchema,
  type: GeographicUnitTypeSchema,
  parentId: UuidSchema.nullable(),
  officialCode: z.string().trim().min(1).max(32),
  officialName: z.string().trim().min(1).max(200),
  sourceVersion: z.string().trim().min(1).max(64),
  validFrom: IsoDateSchema.nullable().optional(),
  validTo: IsoDateSchema.nullable().optional(),
});
export type CreateGeographicUnit = z.infer<typeof CreateGeographicUnitSchema>;

export const UpdateGeographicUnitSchema = CreateGeographicUnitSchema.pick({
  officialName: true,
  validFrom: true,
  validTo: true,
}).partial();
export type UpdateGeographicUnit = z.infer<typeof UpdateGeographicUnitSchema>;

/* --------------------------- Registry versions ---------------------------- */

export const RegistryVersionSchema = z.object({
  id: UuidSchema,
  electionCycleId: UuidSchema,
  version: z.string(),
  source: z.string(),
  status: RegistryVersionStatusSchema,
  stationCount: z.number().int(),
  importedAt: IsoDateTimeSchema,
  approvedAt: IsoDateTimeSchema.nullable(),
  approvedById: UuidSchema.nullable(),
  notes: z.string().nullable(),
});
export type RegistryVersion = z.infer<typeof RegistryVersionSchema>;

export const CreateRegistryVersionSchema = z.object({
  electionCycleId: UuidSchema,
  version: z.string().trim().min(1).max(64),
  source: z.string().trim().min(1).max(500),
  notes: z.string().max(2000).optional(),
});
export type CreateRegistryVersion = z.infer<typeof CreateRegistryVersionSchema>;

/**
 * CSV import (multipart field `file`) columns:
 * county_code,county_name,constituency_code,constituency_name,ward_code,ward_name,
 * centre_code,centre_name,station_code,station_name,registered_voters
 */
export const RegistryImportResultSchema = z.object({
  registryVersionId: UuidSchema,
  unitsCreated: z.number().int(),
  stationsCreated: z.number().int(),
  rowsRejected: z.number().int(),
  errors: z.array(z.object({ row: z.number().int(), message: z.string() })),
});
export type RegistryImportResult = z.infer<typeof RegistryImportResultSchema>;

/* ---------------------------- Polling stations ---------------------------- */

export const PollingStationSchema = z.object({
  id: UuidSchema,
  electionCycleId: UuidSchema,
  registryVersionId: UuidSchema,
  geographicUnitId: UuidSchema,
  countyId: UuidSchema,
  constituencyId: UuidSchema,
  wardId: UuidSchema,
  pollingCentreId: UuidSchema.nullable(),
  code: z.string(),
  name: z.string(),
  streamNumber: z.number().int().nullable(),
  registeredVoters: z.number().int().nullable(),
  status: PollingStationStatusSchema,
  latitude: z.number().nullable(),
  longitude: z.number().nullable(),
  locationSource: z.string().nullable(),
  /** Denormalised names for list display. */
  countyName: z.string().optional(),
  constituencyName: z.string().optional(),
  wardName: z.string().optional(),
  pollingCentreName: z.string().nullable().optional(),
});
export type PollingStation = z.infer<typeof PollingStationSchema>;

export const PollingStationQuerySchema = PaginationQuerySchema.extend({
  electionCycleId: UuidSchema,
  registryVersionId: UuidSchema.optional(),
  countyId: UuidSchema.optional(),
  constituencyId: UuidSchema.optional(),
  wardId: UuidSchema.optional(),
  pollingCentreId: UuidSchema.optional(),
  status: PollingStationStatusSchema.optional(),
});
export type PollingStationQuery = z.infer<typeof PollingStationQuerySchema>;

export const CreatePollingStationSchema = z.object({
  electionCycleId: UuidSchema,
  registryVersionId: UuidSchema,
  /** Ward or polling centre the station belongs to. */
  geographicUnitId: UuidSchema,
  code: z.string().trim().min(1).max(32),
  name: z.string().trim().min(1).max(200),
  streamNumber: z.number().int().min(1).nullable().optional(),
  registeredVoters: z.number().int().min(0).nullable().optional(),
  latitude: z.number().min(-90).max(90).nullable().optional(),
  longitude: z.number().min(-180).max(180).nullable().optional(),
  locationSource: z.string().max(200).nullable().optional(),
});
export type CreatePollingStation = z.infer<typeof CreatePollingStationSchema>;

export const UpdatePollingStationSchema = CreatePollingStationSchema.omit({
  electionCycleId: true,
  registryVersionId: true,
})
  .partial()
  .extend({ status: PollingStationStatusSchema.optional() });
export type UpdatePollingStation = z.infer<typeof UpdatePollingStationSchema>;

/* ------------------------------ Tally centres ----------------------------- */

export const TallyCentreSchema = z.object({
  id: UuidSchema,
  electionCycleId: UuidSchema,
  level: TallyCentreLevelSchema,
  geographicUnitId: UuidSchema.nullable(),
  code: z.string(),
  name: z.string(),
});
export type TallyCentre = z.infer<typeof TallyCentreSchema>;

export const CreateTallyCentreSchema = TallyCentreSchema.omit({ id: true }).extend({
  code: z.string().trim().min(1).max(32),
  name: z.string().trim().min(1).max(200),
});
export type CreateTallyCentre = z.infer<typeof CreateTallyCentreSchema>;

/* -------------------------------- Contests -------------------------------- */

export const ContestSchema = z.object({
  id: UuidSchema,
  electionCycleId: UuidSchema,
  officeType: OfficeTypeSchema,
  name: z.string(),
  /** County for governor/senator/woman rep; constituency for MNA; ward for MCA; null for president. */
  geographicUnitId: UuidSchema.nullable(),
  formSeries: z.string(),
  status: ContestStatusSchema,
  candidateCount: z.number().int().optional(),
});
export type Contest = z.infer<typeof ContestSchema>;

export const CreateContestSchema = z.object({
  electionCycleId: UuidSchema,
  officeType: OfficeTypeSchema,
  name: z.string().trim().min(3).max(200),
  geographicUnitId: UuidSchema.nullable(),
});
export type CreateContest = z.infer<typeof CreateContestSchema>;

export const UpdateContestSchema = z.object({
  name: z.string().trim().min(3).max(200).optional(),
  status: ContestStatusSchema.optional(),
});
export type UpdateContest = z.infer<typeof UpdateContestSchema>;

/* -------------------------- Candidate references -------------------------- */

export const CandidateReferenceSchema = z.object({
  id: UuidSchema,
  contestId: UuidSchema,
  candidateNameAsPublished: z.string(),
  partyLabel: z.string().nullable(),
  isIndependent: z.boolean(),
  ballotOrder: z.number().int(),
  referenceCode: z.string().nullable(),
  source: z.string(),
});
export type CandidateReference = z.infer<typeof CandidateReferenceSchema>;

export const CreateCandidateReferenceSchema = z.object({
  candidateNameAsPublished: z.string().trim().min(2).max(200),
  partyLabel: z.string().trim().max(200).nullable().optional(),
  isIndependent: z.boolean().default(false),
  ballotOrder: z.number().int().min(1),
  referenceCode: z.string().trim().max(64).nullable().optional(),
  source: z.string().trim().min(1).max(500),
});
export type CreateCandidateReference = z.infer<typeof CreateCandidateReferenceSchema>;

export const UpdateCandidateReferenceSchema = CreateCandidateReferenceSchema.partial();
export type UpdateCandidateReference = z.infer<typeof UpdateCandidateReferenceSchema>;

/* ----------------------------- Form templates ----------------------------- */

export const FormTemplateSchema = z.object({
  id: UuidSchema,
  electionCycleId: UuidSchema,
  contestType: OfficeTypeSchema,
  formNumber: z.string(),
  formLevel: FormLevelSchema,
  version: z.number().int(),
  title: z.string(),
  effectiveDate: IsoDateSchema,
  fieldSchema: FormFieldSchemaSchema,
  validationRules: ValidationRulesSchema,
  officialSource: z.string(),
  officialSourceUrl: z.string().nullable(),
  approvalState: FormTemplateApprovalStateSchema,
  approvedById: UuidSchema.nullable(),
  approvedAt: IsoDateTimeSchema.nullable(),
  createdAt: IsoDateTimeSchema,
});
export type FormTemplate = z.infer<typeof FormTemplateSchema>;

export const FormTemplateQuerySchema = PaginationQuerySchema.extend({
  electionCycleId: UuidSchema.optional(),
  contestType: OfficeTypeSchema.optional(),
  formNumber: z.string().optional(),
  approvalState: FormTemplateApprovalStateSchema.optional(),
});
export type FormTemplateQuery = z.infer<typeof FormTemplateQuerySchema>;

export const CreateFormTemplateSchema = z.object({
  electionCycleId: UuidSchema,
  contestType: OfficeTypeSchema,
  formNumber: z.string().regex(/^3[4-9][A-D]$/, 'Expected a form number such as 37A'),
  formLevel: FormLevelSchema,
  title: z.string().trim().min(3).max(300),
  effectiveDate: IsoDateSchema,
  fieldSchema: FormFieldSchemaSchema,
  validationRules: ValidationRulesSchema,
  officialSource: z.string().trim().min(3).max(500),
  officialSourceUrl: z.string().url().nullable().optional(),
});
export type CreateFormTemplate = z.infer<typeof CreateFormTemplateSchema>;

/** Only DRAFT templates are editable; approved templates are versioned, never edited. */
export const UpdateFormTemplateSchema = CreateFormTemplateSchema.omit({
  electionCycleId: true,
  contestType: true,
  formNumber: true,
}).partial();
export type UpdateFormTemplate = z.infer<typeof UpdateFormTemplateSchema>;

export const FormTemplateApprovalRequestSchema = z.object({
  decision: z.enum(['SUBMIT_FOR_APPROVAL', 'APPROVE', 'REJECT', 'RETIRE']),
  reason: z.string().trim().min(3).max(2000),
});
export type FormTemplateApprovalRequest = z.infer<typeof FormTemplateApprovalRequestSchema>;

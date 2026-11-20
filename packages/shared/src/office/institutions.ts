/** Institution registry: the public bodies legally responsible for projects and referrals. */
import { z } from 'zod';
import { IsoDateTimeSchema, PaginationQuerySchema, UuidSchema } from '../schemas/common';
import { PhoneSchema } from './common';
import { InstitutionTypeSchema } from './enums';

export const InstitutionSchema = z.object({
  id: UuidSchema,
  name: z.string(),
  shortName: z.string().nullable(),
  type: InstitutionTypeSchema,
  /** Parent body, e.g. a directorate under a county department. */
  parentId: UuidSchema.nullable(),
  /** Office contact of the institution (never a private individual's details). */
  contactEmail: z.string().nullable(),
  contactPhone: z.string().nullable(),
  physicalAddress: z.string().nullable(),
  /** Mandate summary used to decide referrals ("who is legally responsible"). */
  mandate: z.string().nullable(),
  isActive: z.boolean(),
  createdAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
});
export type Institution = z.infer<typeof InstitutionSchema>;

export const CreateInstitutionSchema = z.object({
  name: z.string().trim().min(2).max(200),
  shortName: z.string().trim().max(40).optional(),
  type: InstitutionTypeSchema,
  parentId: UuidSchema.optional(),
  contactEmail: z.string().trim().email().max(200).optional(),
  contactPhone: PhoneSchema.optional(),
  physicalAddress: z.string().trim().max(300).optional(),
  mandate: z.string().trim().max(2000).optional(),
});
export type CreateInstitution = z.infer<typeof CreateInstitutionSchema>;

export const UpdateInstitutionSchema = CreateInstitutionSchema.partial().extend({
  isActive: z.boolean().optional(),
});
export type UpdateInstitution = z.infer<typeof UpdateInstitutionSchema>;

export const InstitutionQuerySchema = PaginationQuerySchema.extend({
  type: InstitutionTypeSchema.optional(),
  active: z
    .enum(['true', 'false'])
    .transform((v) => v === 'true')
    .optional(),
});
export type InstitutionQuery = z.infer<typeof InstitutionQuerySchema>;

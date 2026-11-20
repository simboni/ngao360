/**
 * Mobile PWA home (blueprint 11.3; API contract §16.4). `GET /field/me` returns
 * the signed-in person's own agent record (non-sensitive fields only), their
 * assignments and what the mobile screens may offer. An agent never sees other
 * agents' personal details.
 */
import { z } from 'zod';
import { IsoDateTimeSchema, UuidSchema } from '../schemas/common';
import { MyAssignmentSchema } from './deployment';
import { AgentStatusSchema } from './enums';

export const FieldMeSchema = z.object({
  /** Null when the user is not registered as an agent (e.g. a coordinator using the PWA). */
  agent: z
    .object({
      id: UuidSchema,
      reference: z.string(),
      displayName: z.string(),
      status: AgentStatusSchema,
    })
    .nullable(),
  electionCycleId: UuidSchema.nullable(),
  assignments: z.array(MyAssignmentSchema),
  /** What the mobile screens may offer (UI hint; the API re-checks). */
  can: z.object({
    submitFieldReport: z.boolean(),
    reportIncident: z.boolean(),
    checkIn: z.boolean(),
    uploadResultForm: z.boolean(),
  }),
  /** Active templates the person may use on /m/report. */
  templates: z.array(z.object({ id: UuidSchema, key: z.string(), version: z.number().int(), name: z.string() })),
  notices: z.array(z.object({ id: z.string(), title: z.string(), body: z.string(), createdAt: IsoDateTimeSchema })),
  serverTime: IsoDateTimeSchema,
});
export type FieldMe = z.infer<typeof FieldMeSchema>;

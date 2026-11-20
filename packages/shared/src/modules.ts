/**
 * Tenant module activation (blueprint section 2 and S30). A product module can
 * be switched on or off per tenant by a user with `workspace.configure`. A
 * disabled module is hidden from navigation and every endpoint tagged with
 * `@RequireModule(key)` returns 403 `MODULE_DISABLED`. Data is never deleted
 * when a module is switched off.
 *
 * Stored in `tenant_modules`; a tenant without a row for a module gets the
 * module's `defaultEnabled`.
 */
import { z } from 'zod';
import { IsoDateTimeSchema, ReasonSchema, UserRefSchema } from './schemas/common';

export const TENANT_MODULE_KEYS = ['tally', 'office'] as const;
export type TenantModuleKey = (typeof TENANT_MODULE_KEYS)[number];
export const TenantModuleKeySchema = z.enum(TENANT_MODULE_KEYS);

export interface TenantModuleDefinition {
  key: TenantModuleKey;
  label: string;
  description: string;
  /** Effective state when the tenant has no `tenant_modules` row. */
  defaultEnabled: boolean;
}

export const TENANT_MODULES: readonly TenantModuleDefinition[] = [
  {
    key: 'tally',
    label: 'NGAO TALLY',
    description: 'Result-form intake, capture, verification and the internal parallel tally.',
    defaultEnabled: true,
  },
  {
    key: 'office',
    label: 'NGAO360 Office',
    description:
      'Correspondence, appointments, meetings, citizen cases, development projects and the public portal.',
    defaultEnabled: false,
  },
];

export function moduleDefinition(key: TenantModuleKey): TenantModuleDefinition {
  const def = TENANT_MODULES.find((m) => m.key === key);
  if (!def) throw new Error(`Unknown tenant module ${key}`);
  return def;
}

/** Effective enabled modules from stored rows (missing rows fall back to defaults). */
export function effectiveModules(rows: ReadonlyArray<{ moduleKey: string; enabled: boolean }>): TenantModuleKey[] {
  return TENANT_MODULES.filter((m) => {
    const row = rows.find((r) => r.moduleKey === m.key);
    return row ? row.enabled : m.defaultEnabled;
  }).map((m) => m.key);
}

export const TenantModuleStateSchema = z.object({
  key: TenantModuleKeySchema,
  label: z.string(),
  description: z.string(),
  enabled: z.boolean(),
  /** True when no row exists and the default applies. */
  isDefault: z.boolean(),
  /** Module-specific configuration (for `office`: `OfficeModuleConfig`). */
  config: z.record(z.unknown()),
  updatedAt: IsoDateTimeSchema.nullable(),
  updatedBy: UserRefSchema.nullable(),
});
export type TenantModuleState = z.infer<typeof TenantModuleStateSchema>;

export const UpdateTenantModuleSchema = z.object({
  enabled: z.boolean(),
  /** Replaces the module configuration when given; validated per module. */
  config: z.record(z.unknown()).optional(),
  reason: ReasonSchema,
});
export type UpdateTenantModule = z.infer<typeof UpdateTenantModuleSchema>;

export const TenantModuleParamSchema = z.object({ key: TenantModuleKeySchema });
export type TenantModuleParam = z.infer<typeof TenantModuleParamSchema>;

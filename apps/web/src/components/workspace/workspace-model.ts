/**
 * Pure helpers behind the S02 setup wizard, the S03 checklist and the S30 settings screens. The
 * API enforces every rule; these shape input and output and give early, plain-language feedback.
 */
import {
  type CreateWorkspace,
  CreateWorkspaceSchema,
  type DataProtectionInput,
  DataProtectionInputSchema,
  environmentDefinition,
  type IntegrationKind,
  type TenantModuleKey,
  type TenantType,
  type WorkspaceAdminInvitation,
  type WorkspaceEnvironment,
  type WorkspaceSetupItem,
} from '@ngao360/shared';
import { describeError as describeGeneric } from '@/components/tally/errors';
import { ApiRequestError } from '@/lib/api-client';

export const TENANT_TYPE_LABELS: Record<Exclude<TenantType, 'PLATFORM'>, string> = {
  CAMPAIGN: 'Campaign',
  POLITICAL_PARTY: 'Political party',
  ELECTED_OFFICE: 'Elected office',
  OBSERVER_ORGANISATION: 'Observer organisation',
};

export const INTEGRATION_KIND_LABELS: Record<IntegrationKind, string> = {
  email: 'E-mail',
  sms: 'SMS',
  push: 'Push notifications',
  captcha: 'Captcha (public portal)',
  scanner: 'Malware scanning',
};

export const PROVIDER_LABELS: Record<string, string> = {
  log: 'Log only (nothing is sent)',
  none: 'None',
  smtp: 'SMTP',
  africastalking: "Africa's Talking",
  webpush: 'Web push (VAPID)',
  hcaptcha: 'hCaptcha',
  turnstile: 'Cloudflare Turnstile',
  clamd: 'ClamAV (clamd)',
};

export const providerLabel = (p: string) => PROVIDER_LABELS[p] ?? p;

/* ------------------------------- Errors -------------------------------- */

export function describeWorkspaceError(err: unknown): string {
  if (err instanceof ApiRequestError) {
    const details = (err.body.details ?? null) as Record<string, unknown> | null;
    switch (err.code) {
      case 'FILE_NOT_CLEAN':
        return 'The file has not been recorded clean by the malware scanner yet. It can be used once the scan finishes.';
      case 'REAUTH_REQUIRED':
        return 'Confirm it is you to make this change.';
      case 'CONFLICT':
        if (details?.reason === 'NOT_DETECTED') {
          return `This step completes when the work is done${typeof details.evidence === 'string' ? ` (now: ${details.evidence})` : ''}. Do the work, or skip it with a note.`;
        }
        if (details?.reason === 'NOTICE_VERSION_REQUIRED') {
          return 'These periods differ from the ones your current privacy notice states. Publish a new notice version that states them, then enter its version here.';
        }
        if (details && Array.isArray(details.missingEnv)) {
          return `This server is not configured for that provider. Missing settings: ${(details.missingEnv as string[]).join(', ')}. An operator sets them in the server environment.`;
        }
        return err.message || 'This conflicts with the current state. Refresh and try again.';
      default:
        break;
    }
    if (err.status === 503) return 'Invitation delivery is not available right now, so nothing was created. Try again later.';
  }
  return describeGeneric(err);
}

/* ---------------------------- S02 wizard ----------------------------- */

export interface AdminDraft {
  email: string;
  displayName: string;
}

export interface WizardDraft {
  name: string;
  displayName: string;
  slug: string;
  environment: WorkspaceEnvironment;
  type: Exclude<TenantType, 'PLATFORM'>;
  timezone: string;
  dataRegion: 'ke' | 'eu' | 'other';
  modules: TenantModuleKey[];
  defaultCountyCode: string;
  dataProtection: { controllerName: string; contactName: string; contactEmail: string; contactPhone: string; privacyNoticeVersion: string; staffNoticeVersion: string };
  admins: AdminDraft[];
  reason: string;
}

export const WIZARD_STEPS = ['organisation', 'environment', 'geography', 'dataProtection', 'administrators', 'review'] as const;
export type WizardStep = (typeof WIZARD_STEPS)[number];
export const WIZARD_STEP_LABELS: Record<WizardStep, string> = {
  organisation: 'Organisation',
  environment: 'Environment and modules',
  geography: 'Geography',
  dataProtection: 'Data protection',
  administrators: 'First administrators',
  review: 'Review and create',
};

export function emptyDraft(): WizardDraft {
  return {
    name: '',
    displayName: '',
    slug: '',
    environment: 'CAMPAIGN',
    type: 'CAMPAIGN',
    timezone: 'Africa/Nairobi',
    dataRegion: 'ke',
    modules: [...environmentDefinition('CAMPAIGN').defaultModules],
    defaultCountyCode: '',
    dataProtection: { controllerName: '', contactName: '', contactEmail: '', contactPhone: '', privacyNoticeVersion: '', staffNoticeVersion: '' },
    admins: [{ email: '', displayName: '' }],
    reason: '',
  };
}

/** Organisation code from the name: lower case, digits and dashes (what the sign-in screen asks for). */
export function slugFromName(name: string): string {
  return name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 63);
}

/** Switching environment picks an allowed type and that environment's default modules. */
export function applyEnvironment(draft: WizardDraft, environment: WorkspaceEnvironment): WizardDraft {
  const def = environmentDefinition(environment);
  const type = (def.tenantTypes as readonly TenantType[]).includes(draft.type) ? draft.type : (def.tenantTypes[0] as WizardDraft['type']);
  return { ...draft, environment, type, modules: [...def.defaultModules] };
}

function dataProtectionInput(d: WizardDraft['dataProtection']): DataProtectionInput | null {
  const filled = Object.values(d).some((v) => v.trim() !== '');
  if (!filled) return null;
  return {
    controllerName: d.controllerName.trim(),
    contactName: d.contactName.trim(),
    contactEmail: d.contactEmail.trim(),
    contactPhone: d.contactPhone.trim() || null,
    privacyNoticeVersion: d.privacyNoticeVersion.trim(),
    staffNoticeVersion: d.staffNoticeVersion.trim() || null,
  };
}

/** Field errors for one wizard step (keys are draft paths). */
export function validateStep(step: WizardStep, draft: WizardDraft): Record<string, string> {
  const e: Record<string, string> = {};
  if (step === 'organisation' || step === 'review') {
    if (draft.name.trim().length < 2) e.name = 'Enter the organisation name';
    if (!/^[a-z0-9][a-z0-9-]{1,62}$/.test(draft.slug)) e.slug = '2–63 lower-case letters, digits or dashes, starting with a letter or digit';
    if (draft.displayName && draft.displayName.trim().length < 2) e.displayName = 'At least 2 characters';
  }
  if (step === 'environment' || step === 'review') {
    const def = environmentDefinition(draft.environment);
    if (!(def.tenantTypes as readonly string[]).includes(draft.type)) e.type = `Choose a type that fits ${def.label.toLowerCase()}`;
    if (draft.modules.length === 0) e.modules = 'Choose at least one module';
  }
  if (step === 'geography' || step === 'review') {
    if (draft.defaultCountyCode && !/^\d{3}$/.test(draft.defaultCountyCode)) e.defaultCountyCode = 'Three digits, e.g. 039';
  }
  if (step === 'dataProtection' || step === 'review') {
    const dp = dataProtectionInput(draft.dataProtection);
    if (dp) {
      const parsed = DataProtectionInputSchema.safeParse(dp);
      if (!parsed.success) for (const i of parsed.error.issues) e[`dataProtection.${i.path.join('.')}`] = i.message;
    }
  }
  if (step === 'administrators' || step === 'review') {
    const seen = new Set<string>();
    draft.admins.forEach((a, i) => {
      const email = a.email.trim().toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) e[`admins.${i}.email`] = 'Enter a valid e-mail address';
      else if (seen.has(email)) e[`admins.${i}.email`] = 'Each administrator needs a different e-mail address';
      seen.add(email);
      if (a.displayName.trim().length < 2) e[`admins.${i}.displayName`] = 'Enter their name';
    });
  }
  return e;
}

export function buildCreateWorkspaceBody(draft: WizardDraft): { body: CreateWorkspace } | { errors: Record<string, string> } {
  const errors = validateStep('review', draft);
  if (Object.keys(errors).length) return { errors };
  const [first, ...rest] = draft.admins;
  const dp = dataProtectionInput(draft.dataProtection);
  const parsed = CreateWorkspaceSchema.safeParse({
    slug: draft.slug,
    name: draft.name.trim(),
    ...(draft.displayName.trim() ? { displayName: draft.displayName.trim() } : {}),
    type: draft.type,
    environment: draft.environment,
    timezone: draft.timezone,
    dataRegion: draft.dataRegion,
    modules: draft.modules,
    ...(draft.defaultCountyCode ? { defaultCountyCode: draft.defaultCountyCode } : {}),
    admin: { email: first!.email.trim(), displayName: first!.displayName.trim() },
    ...(rest.length ? { additionalAdmins: rest.map((a) => ({ email: a.email.trim(), displayName: a.displayName.trim() })) } : {}),
    ...(dp ? { dataProtection: dp } : {}),
    ...(draft.reason.trim() ? { reason: draft.reason.trim() } : {}),
  });
  if (!parsed.success) return { errors: Object.fromEntries(parsed.error.issues.map((i) => [i.path.join('.'), i.message])) };
  return { body: parsed.data };
}

/** What the operator is told about an invitation: never a link once delivery is configured. */
export function invitationSummary(inv: WorkspaceAdminInvitation): { tone: 'success' | 'warning'; text: string; link: string | null } {
  if (inv.delivery === 'OUTBOX') {
    return { tone: 'success', text: `Invitation sent to ${inv.email}. The link goes only to them.`, link: null };
  }
  return {
    tone: 'warning',
    text: `No e-mail delivery is configured. Give ${inv.email} this one-time link through a channel you trust; it is shown once and works once.`,
    link: inv.acceptPath,
  };
}

/* ---------------------------- S03 checklist ----------------------------- */

export function onboardingProgress(items: readonly WorkspaceSetupItem[]): { complete: number; total: number; percent: number; next: WorkspaceSetupItem | null } {
  const isComplete = (i: WorkspaceSetupItem) => i.complete ?? i.status !== 'PENDING';
  const complete = items.filter(isComplete).length;
  const total = items.length;
  return { complete, total, percent: total ? Math.round((complete / total) * 100) : 0, next: items.find((i) => !isComplete(i)) ?? null };
}

/** Label for an item's state, distinguishing detected work from a manual mark and a regression. */
export function setupItemState(i: WorkspaceSetupItem): { label: string; tone: 'success' | 'info' | 'muted' | 'pending' } {
  if (i.status === 'SKIPPED') return { label: 'Skipped', tone: 'muted' };
  if (i.autoDetect) {
    if (i.detected) return { label: 'Done', tone: 'success' };
    if (i.status === 'DONE') return { label: 'No longer met', tone: 'pending' };
    return { label: 'To do', tone: 'info' };
  }
  return i.status === 'DONE' ? { label: 'Done', tone: 'success' } : { label: 'To do', tone: 'info' };
}

/* ------------------------------ S30 retention ------------------------------ */

export function retentionNeedsNewNotice(
  stated: { contactRetentionMonths: number; caseRetentionMonths: number } | null,
  next: { contactRetentionMonths: number; caseRetentionMonths: number },
): boolean {
  if (!stated) return false;
  return stated.contactRetentionMonths !== next.contactRetentionMonths || stated.caseRetentionMonths !== next.caseRetentionMonths;
}

/** "SENT 3 · SKIPPED 12" for 7-day activity counts (counts only). */
export function activityLine(counts: Record<string, number>): string {
  const parts = Object.entries(counts)
    .filter(([, n]) => n > 0)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, n]) => `${k.charAt(0)}${k.slice(1).toLowerCase()} ${n}`);
  return parts.length ? parts.join(' · ') : 'No activity in the last 7 days';
}

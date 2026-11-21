import { z } from 'zod';

const bool = z
  .union([z.boolean(), z.string()])
  .transform((v) => (typeof v === 'boolean' ? v : ['1', 'true', 'yes', 'on'].includes(v.toLowerCase())));

function emptyToUndefined(v: string | undefined): string | undefined {
  return v === undefined || v.trim() === '' ? undefined : v;
}

const optionalKey32 = z
  .string()
  .optional()
  .transform(emptyToUndefined)
  .refine((v) => v === undefined || Buffer.from(v, 'base64').length === 32, 'Must be 32 bytes, base64-encoded');

export const ConfigSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  API_PORT: z.coerce.number().int().default(4000),
  API_PUBLIC_URL: z.string().url().default('http://localhost:4000'),
  WEB_ORIGIN: z.string().default('http://localhost:3000'),

  DATABASE_URL: z.string().min(1),
  /** Runtime role with RLS enforced. Falls back to DATABASE_URL (with a warning) when unset. */
  APP_DATABASE_URL: z.string().optional(),
  REDIS_URL: z.string().default('redis://127.0.0.1:6379'),
  QUEUES_ENABLED: bool.default(true),
  /** all (default) | api (HTTP only, no BullMQ workers) | worker (dist/worker.js, no HTTP). See queue/process-role.ts. */
  PROCESS_ROLE: z.enum(['all', 'api', 'worker']).default('all'),

  JWT_ACCESS_SECRET: z.string().min(32),
  JWT_REFRESH_SECRET: z.string().min(32),
  JWT_ACCESS_TTL_SECONDS: z.coerce.number().int().positive().default(900),
  JWT_REFRESH_TTL_SECONDS: z.coerce.number().int().positive().default(604800),
  MFA_ENCRYPTION_KEY: z
    .string()
    .refine((v) => Buffer.from(v, 'base64').length === 32, 'Must be 32 bytes, base64-encoded'),
  MFA_ISSUER: z.string().default('NGAO360'),
  COOKIE_SECURE: bool.default(false),
  COOKIE_DOMAIN: z.string().optional().transform((v) => (v ? v : undefined)),

  STORAGE_DRIVER: z.enum(['local', 's3']).default('local'),
  STORAGE_LOCAL_ROOT: z.string().default('./storage'),
  S3_ENDPOINT: z.string().optional(),
  S3_REGION: z.string().default('us-east-1'),
  S3_BUCKET: z.string().default('ngao360'),
  S3_ACCESS_KEY_ID: z.string().optional(),
  S3_SECRET_ACCESS_KEY: z.string().optional(),
  S3_FORCE_PATH_STYLE: bool.default(true),
  /**
   * S3 Object Lock for stored originals: every object written by the S3 driver gets a retention
   * period in this mode (COMPLIANCE: nobody, root included, can shorten it or delete the version).
   * The bucket must have Object Lock enabled at creation. 'off' writes without retention
   * (development / MinIO without lock).
   */
  S3_OBJECT_LOCK_MODE: z.enum(['off', 'COMPLIANCE', 'GOVERNANCE']).default('off'),
  /** Escape hatch for a production deployment on storage without Object Lock (documented exception). */
  S3_OBJECT_LOCK_ALLOW_OFF: bool.default(false),
  S3_OBJECT_LOCK_DAYS: z.coerce.number().int().positive().max(36500).default(2555),
  SIGNED_URL_TTL_SECONDS: z.coerce.number().int().positive().default(300),

  RATE_LIMIT_TTL_SECONDS: z.coerce.number().int().positive().default(60),
  RATE_LIMIT_MAX: z.coerce.number().int().positive().default(300),
  AUTH_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(10),
  /**
   * Public portal limiter (per client IP and tenant, per window), separate from the
   * global throttler. In-memory per API instance; a shared Redis store is a known gap.
   */
  PUBLIC_RATE_LIMIT_WINDOW_SECONDS: z.coerce.number().int().positive().default(600),
  PUBLIC_SUBMIT_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(5),
  PUBLIC_TRACK_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(30),
  PUBLIC_READ_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(600),
  /**
   * Minutes between runs of the Office retention job (contact erasure and case
   * redaction after the retention periods in the office configuration). 0 turns
   * the in-process schedule off (tests; or when an external scheduler runs it).
   */
  OFFICE_RETENTION_INTERVAL_MINUTES: z.coerce.number().int().min(0).default(360),

  /** Seconds a password/TOTP re-authentication stays valid for high-risk actions. */
  REAUTH_WINDOW_SECONDS: z.coerce.number().int().positive().default(600),
  LOGIN_MAX_FAILURES: z.coerce.number().int().positive().default(5),
  LOGIN_LOCK_MINUTES: z.coerce.number().int().positive().default(15),
  /** Consecutive wrong TOTP codes before the authenticator is locked (independent of the IP throttle). */
  MFA_MAX_FAILURES: z.coerce.number().int().positive().default(5),
  /** Lock length; longer than the 5-minute challenge token lifetime so outstanding challenges expire. */
  MFA_LOCK_MINUTES: z.coerce.number().int().positive().default(15),
  /** Hours a single-use invitation link stays valid. */
  INVITATION_TTL_HOURS: z.coerce.number().int().positive().default(72),

  /** OCR draft provider: 'none' (manual capture) or 'stub' (synthetic low-confidence drafts, development only). */
  OCR_PROVIDER: z.enum(['none', 'stub']).default('none'),

  // --- Pilot hardening (docs/ARCHITECTURE.md §16). Every provider defaults to the log / no-op one;
  // --- secrets come only from here and are never logged, stored or returned by the API.
  /** 32-byte base64 key for outbox addresses, push endpoints and one-time payloads. Required in production. */
  MESSAGING_ENCRYPTION_KEY: optionalKey32,
  /** HMAC key for address hashes (contact lookups, delivery reports). Required in production. */
  MESSAGING_HASH_KEY: z.string().optional().transform(emptyToUndefined).pipe(z.string().min(32).optional()),
  MESSAGING_DISPATCH_INTERVAL_SECONDS: z.coerce.number().int().positive().default(30),
  MESSAGING_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(20).default(5),

  EMAIL_PROVIDER: z.enum(['log', 'smtp']).default('log'),
  EMAIL_FROM_ADDRESS: z.string().optional().transform(emptyToUndefined),
  EMAIL_FROM_NAME: z.string().default('NGAO360'),
  SMTP_HOST: z.string().optional().transform(emptyToUndefined),
  SMTP_PORT: z.coerce.number().int().positive().default(587),
  SMTP_SECURE: bool.default(false),
  SMTP_USER: z.string().optional().transform(emptyToUndefined),
  SMTP_PASSWORD: z.string().optional().transform(emptyToUndefined),

  SMS_PROVIDER: z.enum(['log', 'africastalking']).default('log'),
  AFRICASTALKING_USERNAME: z.string().optional().transform(emptyToUndefined),
  AFRICASTALKING_API_KEY: z.string().optional().transform(emptyToUndefined),
  /** Approved alphanumeric sender id (takes 2–14 business days); empty = the shared short code. */
  AFRICASTALKING_SENDER_ID: z.string().optional().transform(emptyToUndefined),
  /** https://api.africastalking.com (live) or https://api.sandbox.africastalking.com (sandbox). */
  AFRICASTALKING_BASE_URL: z.string().url().default('https://api.africastalking.com'),
  /** Random path token for the delivery-report callback URL (the vendor does not sign callbacks). */
  AFRICASTALKING_DLR_TOKEN: z.string().optional().transform(emptyToUndefined).pipe(z.string().min(24).optional()),
  /**
   * Messages to members of the public (portal acknowledgements) go only to numbers starting with
   * one of these E.164 prefixes (comma-separated). Default Kenya only; premium and foreign routes
   * are never used by an anonymous submission.
   */
  CITIZEN_SMS_ALLOWED_PREFIXES: z.string().default('+254'),
  /** At most this many citizen messages per destination address (any tenant) per 24 hours. */
  CITIZEN_MESSAGES_PER_DESTINATION_PER_DAY: z.coerce.number().int().min(0).default(3),
  /** At most this many citizen SMS per tenant per 24 hours (cost ceiling); beyond it they are skipped. */
  CITIZEN_SMS_DAILY_BUDGET_PER_TENANT: z.coerce.number().int().min(0).default(200),

  PUSH_PROVIDER: z.enum(['log', 'webpush']).default('log'),
  VAPID_PUBLIC_KEY: z.string().optional().transform(emptyToUndefined),
  VAPID_PRIVATE_KEY: z.string().optional().transform(emptyToUndefined),
  VAPID_SUBJECT: z.string().optional().transform(emptyToUndefined),

  /** 'none': files stay PENDING and cannot be used where CLEAN is required (fail closed). */
  MALWARE_SCANNER: z.enum(['none', 'clamd']).default('none'),
  CLAMD_HOST: z.string().default('127.0.0.1'),
  CLAMD_PORT: z.coerce.number().int().positive().default(3310),
  CLAMD_TIMEOUT_MS: z.coerce.number().int().positive().default(15000),
  SCAN_INTERVAL_SECONDS: z.coerce.number().int().positive().default(60),

  /** Providers this deployment can verify. A tenant picks one in its settings; a configured but failing provider refuses. */
  CAPTCHA_PROVIDER: z.enum(['none', 'hcaptcha', 'turnstile']).default('none'),
  CAPTCHA_SITE_KEY: z.string().optional().transform(emptyToUndefined),
  CAPTCHA_SECRET: z.string().optional().transform(emptyToUndefined),
  /** Override only in tests (fake HTTP server). */
  CAPTCHA_VERIFY_URL: z.string().url().optional().or(z.literal('').transform(() => undefined)),
  CAPTCHA_TIMEOUT_MS: z.coerce.number().int().positive().default(5000),

  /** Where rate-limit counters live: 'memory' (one API instance) or 'redis' (shared; REDIS_URL). */
  RATE_LIMIT_STORE: z.enum(['memory', 'redis']).default('memory'),

  /** Durable repeatable jobs on BullMQ (needs QUEUES_ENABLED). Off in most tests. */
  JOBS_ENABLED: bool.default(true),

  /** WebAuthn relying party: the registrable domain of WEB_ORIGIN (e.g. ngao360.example.org). */
  WEBAUTHN_RP_ID: z.string().default('localhost'),
  WEBAUTHN_RP_NAME: z.string().default('NGAO360'),
  /** Comma-separated origins allowed in WebAuthn responses; defaults to WEB_ORIGIN. */
  WEBAUTHN_ORIGINS: z.string().optional().transform(emptyToUndefined),
});

export type AppConfigValues = z.infer<typeof ConfigSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfigValues {
  const parsed = ConfigSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  if (parsed.data.NODE_ENV === 'production') {
    if (!parsed.data.APP_DATABASE_URL) throw new Error('APP_DATABASE_URL is required in production (RLS role)');
    if (!parsed.data.COOKIE_SECURE) throw new Error('COOKIE_SECURE must be true in production');
    if (parsed.data.STORAGE_DRIVER === 's3' && parsed.data.S3_OBJECT_LOCK_MODE === 'off' && !parsed.data.S3_OBJECT_LOCK_ALLOW_OFF) {
      throw new Error('S3_OBJECT_LOCK_MODE must be COMPLIANCE (or GOVERNANCE) in production with STORAGE_DRIVER=s3; set S3_OBJECT_LOCK_ALLOW_OFF=true only for a documented exception');
    }
    if (!parsed.data.MESSAGING_ENCRYPTION_KEY || !parsed.data.MESSAGING_HASH_KEY) {
      throw new Error('MESSAGING_ENCRYPTION_KEY and MESSAGING_HASH_KEY are required in production');
    }
  }
  const missing = missingProviderEnv(parsed.data);
  if (missing.length > 0) {
    // Names only, never values.
    throw new Error(`Invalid environment configuration: a selected provider is missing ${missing.join(', ')}`);
  }
  return parsed.data;
}

/**
 * Environment variable NAMES a selected provider needs but that are unset. A provider that is
 * selected but not configured stops the API at start-up (fail closed) instead of silently
 * degrading. Also used by the S30 integrations status (names only, never values).
 */
export function missingProviderEnv(v: AppConfigValues): string[] {
  const need: Array<[boolean, string]> = [];
  if (v.EMAIL_PROVIDER === 'smtp') {
    need.push([!!v.SMTP_HOST, 'SMTP_HOST'], [!!v.EMAIL_FROM_ADDRESS, 'EMAIL_FROM_ADDRESS']);
  }
  if (v.SMS_PROVIDER === 'africastalking') {
    need.push([!!v.AFRICASTALKING_USERNAME, 'AFRICASTALKING_USERNAME'], [!!v.AFRICASTALKING_API_KEY, 'AFRICASTALKING_API_KEY']);
  }
  if (v.PUSH_PROVIDER === 'webpush') {
    need.push([!!v.VAPID_PUBLIC_KEY, 'VAPID_PUBLIC_KEY'], [!!v.VAPID_PRIVATE_KEY, 'VAPID_PRIVATE_KEY'], [!!v.VAPID_SUBJECT, 'VAPID_SUBJECT']);
  }
  if (v.CAPTCHA_PROVIDER !== 'none') {
    need.push([!!v.CAPTCHA_SITE_KEY, 'CAPTCHA_SITE_KEY'], [!!v.CAPTCHA_SECRET, 'CAPTCHA_SECRET']);
  }
  if (v.EMAIL_PROVIDER !== 'log' || v.SMS_PROVIDER !== 'log' || v.PUSH_PROVIDER !== 'log') {
    need.push([!!v.MESSAGING_ENCRYPTION_KEY, 'MESSAGING_ENCRYPTION_KEY'], [!!v.MESSAGING_HASH_KEY, 'MESSAGING_HASH_KEY']);
  }
  return need.filter(([ok]) => !ok).map(([, name]) => name);
}

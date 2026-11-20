import { z } from 'zod';

const bool = z
  .union([z.boolean(), z.string()])
  .transform((v) => (typeof v === 'boolean' ? v : ['1', 'true', 'yes', 'on'].includes(v.toLowerCase())));

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
  }
  return parsed.data;
}

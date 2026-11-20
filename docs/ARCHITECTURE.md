# NGAO360 architecture

This document covers the platform foundation and the NGAO TALLY MVP, which are stages 1 and 4 of the
blueprint roadmap. It explains what exists, where it lives and the rules that module work must
follow. For endpoints, see [API_CONTRACT.md](./API_CONTRACT.md). For local setup, see
[DEVELOPMENT.md](./DEVELOPMENT.md).

## 1. Monorepo layout

```
apps/
  api/                NestJS API (TypeScript strict, CommonJS)
    src/
      config/         zod-validated environment (AppConfig)
      common/         request context (AsyncLocalStorage), zod pipe/DTOs, errors, CSRF guard, decorators
      prisma/         PrismaService: runtime client + withTenant()/tenantTx()
      auth/           login, JWT cookies, refresh rotation, TOTP MFA, re-auth
      rbac/           @RequirePermission, RbacGuard, PermissionService, GeoScopeService, scope helpers
      audit/          AuditService (append-only), @Audited interceptor
      storage/        StorageService (immutable, SHA-256), local + S3/MinIO drivers, signed URLs
      queue/          BullMQ registration (all queue names), OCR stub worker
      health/         GET /api/health
      tenant-modules/ module activation: TenantModulesService, @RequireModule + ModuleGuard, /workspace/modules
      modules/
        reference/    ← reference module agent
        tally/        ← tally module agent
        admin/        ← admin module agent
        office/       ← NGAO360 Office (blueprint 9): correspondence/, appointments/, cases/, projects/,
                        public/ (unauthenticated portal area), common/ (location, scope, references)
  web/                Next.js App Router (TypeScript), Tailwind, PWA shell
    src/
      app/            routes; (app)/ = authenticated shell; tally/ layout adds the parallel-tally banner
      components/ui/  design-system primitives (StatusBadge, DataTable, Card, KpiCard, EmptyState, PageHeader, …)
      components/layout/  AppShell, Sidebar (248/72px), Topbar (64px)
      lib/            api-client (cookie auth + refresh), auth-context (permissions), nav (permission-aware)
packages/
  shared/             zod schemas + TS types for every DTO, status enums, permission keys, roles, disclaimer
  db/                 Prisma schema, migrations, client, withTenant(), security primitives, seed
  config/             tsconfig and ESLint presets
infra/                Caddyfile, Postgres init script
docs/                 BLUEPRINT, DECISIONS, RESEARCH, this file, API_CONTRACT, DEVELOPMENT
```

### Ownership for parallel module work

| Area | Directories owned | Shared files they may NOT restructure |
| --- | --- | --- |
| Reference API | `apps/api/src/modules/reference/**` | `app.module.ts` (already imports `ReferenceModule`) |
| Tally API | `apps/api/src/modules/tally/**` | `queue/queue.constants.ts` (queues pre-registered) |
| Admin API | `apps/api/src/modules/admin/**` | |
| Reference UI | `apps/web/src/app/(app)/reference/**`, `apps/web/src/components/reference/**` | `lib/nav.ts` (items already present) |
| Tally UI | `apps/web/src/app/(app)/tally/**`, `apps/web/src/components/tally/**` | `tally/layout.tsx` banner must stay |
| Admin UI | `apps/web/src/app/(app)/admin/**`, `apps/web/src/app/(app)/dashboard/**`, `apps/web/src/components/admin/**` | |
| Office: correspondence + appointments/meetings | API `modules/office/correspondence/**`, `modules/office/appointments/**`; web `app/(app)/office/correspondence/**`, `app/(app)/office/appointments/**`, `components/office/correspondence/**`, `components/office/appointments/**` | `office.module.ts`, `office/common/**`, `office/layout.tsx` |
| Office: citizen cases + public requests | API `modules/office/cases/**`, `modules/office/public/public-cases.controller.ts`; web `app/(app)/office/cases/**`, `app/p/[tenantSlug]/page.tsx`, `request/**`, `track/**`, `components/office/cases/**`, `components/office/public/cases-*` | `public/public-portal.service.ts`, `public-rate-limit.ts`, `public-abuse.service.ts`, `public-shell.tsx` |
| Office: projects + institutions + public projects | API `modules/office/projects/**`, `modules/office/public/public-projects.controller.ts`; web `app/(app)/office/projects/**`, `app/p/[tenantSlug]/projects/**`, `components/office/projects/**`, `components/office/public/projects-*` | same as above |

Shared contracts in `packages/shared` and `packages/db/prisma/schema.prisma` already cover the full data
model and DTOs. If a module needs to extend them, the change must be additive (new optional fields,
new schemas) and must update `docs/API_CONTRACT.md` in the same commit. Add a new Prisma migration
rather than editing an existing one. Seed additions go in a new file under `packages/db/src/seed/`
and are called from `main()`.

## 2. Technology choices

| Layer | Choice | Notes |
| --- | --- | --- |
| Web | Next.js 15 App Router, React 19, Tailwind 3 | `output: 'standalone'`. `/api/*` is rewritten to the API, so cookies are first-party. |
| PWA | `public/manifest.webmanifest` and `public/sw.js` | The service worker caches the shell and static assets only. It never caches API responses or forms (blueprint 13.4). |
| API | NestJS 11, Express | Global prefix `/api`. |
| Validation | zod schemas from `@ngao360/shared` | `createZodDto(schema)` with a global `ZodValidationPipe`. The same schemas run in the browser. |
| ORM | Prisma 6 | Chosen over TypeORM (DECISIONS.md). |
| DB | PostgreSQL 16 with RLS | |
| Queue | Redis 7 + BullMQ | Queues: `ocr`, `registry-import`, `tally-export`, `notifications`. |
| Storage | S3-compatible (MinIO), with a local-filesystem driver for dev and tests | Private bucket, short-lived signed URLs. |
| Deploy | Docker Compose + Caddy | `docker-compose.yml`. |

Versions are pinned to stable majors (Nest 11, Next 15, Prisma 6) rather than the newest majors
listed in `RESEARCH.md` (Nest 12 ESM-only, Next 16, Prisma 7 with its driver-adapter and config
changes). The aim is a predictable base for parallel module work. Upgrade in a dedicated change.

## 3. Request lifecycle (API)

1. `RequestContextMiddleware` assigns a request id and stores IP and user agent in AsyncLocalStorage.
2. Global guards run in this order:
   - `ThrottlerGuard` (rate limit; tighter on `/auth/*`).
   - `CsrfGuard`: non-GET requests need the `x-ngao-client` header (Bearer clients are exempt).
   - `JwtAuthGuard`: verifies the `ngao_at` cookie, then loads the live session, the active user and the active role assignments (not expired, not revoked) inside a tenant transaction. It attaches an `AuthContext`.
   - `RbacGuard`: deny by default. It checks MFA for privileged users, then the `@RequirePermission` key(s), then an optional geography check (`GeoTarget` resolved by `GeoScopeService`), then `@RequireReauth`.
3. `ZodValidationPipe` validates DTO-typed parameters.
4. The handler calls a service. The service opens `prisma.tenantTx(tx => …)`, mutates data and calls `audit.record(…, tx)`.
5. `AllExceptionsFilter` maps errors (zod, Prisma, DB trigger `IMMUTABLE_RECORD`, RLS) to `ApiError`.

## 4. Multi-tenancy and row-level security

- Every tenant-owned table has `tenant_id`. The only tables without one are `tenants` and the global `permissions` catalogue.
- The migration `20261120000100_rls_and_integrity` enables RLS on every table with a `tenant_id` column. It adds a `tenant_isolation` policy, `tenant_id = ngao_current_tenant()`, where `ngao_current_tenant()` reads `current_setting('app.tenant_id', true)`.
- The API connects as role `ngao_app` (`APP_DATABASE_URL`). That role is not the table owner and has `NOBYPASSRLS`. `withTenant()` runs each unit of work in a transaction that first calls `set_config('app.tenant_id', $1, true)`, which is transaction-local and safe with pooling. With no setting, queries return no rows and inserts fail the policy.
- Migrations and seed run as the owner role `ngao` (`DATABASE_URL`), which bypasses RLS. Never use it at runtime. In production the API refuses to start without `APP_DATABASE_URL`.
- New tenant-owned tables in later migrations must call `SELECT ngao_enable_tenant_rls('<table>');`.
- Defence in depth: application code still filters by tenant implicitly through RLS, and by geography explicitly through scopes. `apps/api/test/rls.integration.spec.ts` contains cross-tenant tests.

## 5. Identity, MFA and sessions

- Passwords are hashed with argon2id. After 5 failures the account locks for 15 minutes. Errors do not reveal which of organisation, email or password was wrong. A dummy hash equalises timing.
- The access JWT (15 min) lives in the `ngao_at` httpOnly, SameSite=Lax cookie. Claims are `sub`, `tid`, `sid`, `mfa` and `rat`.
- The refresh JWT (7 days) lives in `ngao_rt` with path `/api/auth`. It carries a random secret whose SHA-256 is stored on the `sessions` row. The secret rotates on every refresh, and reuse revokes the session.
- MFA uses TOTP (RFC 6238, SHA-1, 6 digits, 30 s, ±1 step) with replay protection through `last_used_step`. Secrets are encrypted with AES-256-GCM (`MFA_ENCRYPTION_KEY`).
- MFA is required when the user has a role with `mfa_required`, holds any high-risk permission, or has opted in. Login then returns a 5-minute challenge token for verify or enrol.
- High-risk endpoints use `@RequireReauth()`. The user must have re-entered their password, plus TOTP when enabled, within `REAUTH_WINDOW_SECONDS`.

## 6. Authorisation model

- Permissions are `module.action` keys (`PERMISSIONS` in `@ngao360/shared`). Roles are per-tenant copies of `SYSTEM_ROLES`, from blueprint section 3, plus custom roles.
- A `RoleAssignment` grants a role to a user with:
  - `scope_type`: ORGANISATION, COUNTY, CONSTITUENCY, WARD, POLLING_CENTRE or POLLING_STATION.
  - An optional election cycle.
  - `valid_from` and `expires_at`.
  - A soft revoke.
- Effective grants are permission × scope. `RbacGuard` passes a request if any held grant is ORGANISATION-wide, contains the target's unit (geographic units have a materialised `path` of ancestor ids), or names the target station.
- List endpoints must filter using `PermissionService.scopeFor()` and `stationScopeWhere()`.
- Separation of duties (blueprint 3.2) is enforced per record in services. A user may never be both submitter and verifier, or verifier and approver, of the same record; the error code is `SEPARATION_OF_DUTIES`. No system role holds both `tally.submit` and `tally.verify`, or both `tally.verify` and `tally.approve` (checked by unit test).

## 7. Audit

- `audit_events` is append-only. A trigger rejects UPDATE, DELETE and TRUNCATE, even for the owner role, and the `ngao_app` role also lacks those privileges.
- Each event stores the actor, action, entity, redacted before and after snapshots, and SHA-256 hashes of each (`canonicalJson`). It also stores the reason, IP, user agent, request id and an `event_hash` over the canonical event content, which provides tamper evidence. `seq` gives a total order.
- Use `AuditService.record(entry, tx)` inside the same transaction as the change. Action names are `AUDIT_ACTIONS`. `@Audited()` is a convenience for simple create handlers.

## 8. Files and evidence integrity

- `StorageService.storeImmutable()` works in four steps:
  1. Validates the size (≤ 25 MB) and sniffs the magic bytes. Result forms must be JPEG, PNG, WebP, HEIC or PDF.
  2. Computes SHA-256.
  3. Writes to the content-addressed key `tenants/<tenant>/sha256/<aa>/<hash>`. It never overwrites: the local driver uses `wx` with 0444 permissions, and S3 uses `If-None-Match: *`.
  4. Inserts the `stored_files` row.
- `(tenant_id, sha256)` is unique. A repeated upload returns the existing file with `duplicate: true`, so the tally flags a potential duplicate for review and never discards it silently.
- A trigger makes `stored_files` immutable. Only the malware-scan status may change. `readVerified()` re-hashes on read.
- Downloads use short-lived signed URLs: S3 presigned URLs, or HMAC-signed local URLs served by `/api/files/local/:token`. Each issuance must be audited (`FILE_SOURCE_ACCESSED`).
- As blueprint 8.4 notes, a hash proves the stored file has not changed. It does not prove the form is authentic (`HASH_CAVEAT`).

## 9. NGAO TALLY data model highlights

- `FormTemplate`: versioned per cycle and form number, with `field_schema` and `validation_rules` JSON (`FormFieldSchemaSchema`, `ValidationRulesSchema`), `official_source` and an approval state. Approved templates are never edited; changes create a new version. The seed includes 37A, 37B and 37C for the Governor rehearsal. All six series (34–39) are supported by `FORM_SERIES`.
- `ResultSubmission`:
  - Has a unique reference, an idempotency key, the submitter and the source file. Original metadata is immutable (trigger).
  - Status follows `SUBMISSION_STATUS_TRANSITIONS`.
  - `is_canonical` is backed by partial unique indexes: one active canonical record per contest, form number and station or tally centre.
- `ResultValue`: the current value per field and candidate. Every change appends a `ResultValueChange` row recording the old and new value, actor, reason and source.
- `Verification`: independent values, a checklist, mismatched fields and the supervisor action.
- `DiscrepancyCase`: linked submissions (source A and B) and an append-only `DiscrepancyCaseAction` log. Closure needs a different approver.
- `TallySnapshot`: immutable `included_submission_ids`, `totals_json`, `coverage_json`, `calculation_version` and `content_hash`. Release fields can be set only once.
- `ElectionCycle.data_provenance` (SYNTHETIC, HISTORICAL or LIVE) labels historical 2022 or synthetic data (DECISIONS.md update).

## 10. Web shell

- Design tokens follow blueprint 12.1. They are defined in `apps/web/src/app/globals.css` as CSS variables and mapped into the Tailwind theme (`navy`, `deep-blue`, `teal`, `gold`, `cloud`, `slate`, `error`, `success`). The font is Inter, self-hosted through `@fontsource-variable`.
- Layout: a dark navy sidebar, 248 px expanded or 72 px collapsed (persisted per browser), with a 64 px top bar. The content area is fluid.
- Navigation is permission-aware (`lib/nav.ts`). The NGAO TALLY group is hidden unless the user has a `tally.*` permission. Hidden UI is not security; the API enforces every check.
- Every status is shown with `StatusBadge`, which always pairs a word with an icon.
- `ParallelTallyBanner` is rendered by `app/(app)/tally/layout.tsx` on every tally screen and must not be removed.
- `lib/api-client.ts` sends cookies and the CSRF header, refreshes once on 401 and throws `ApiRequestError` with the API `code`.

## 11. Deployment

`docker-compose.yml` runs these services:

- postgres 16, with an init script that creates the `ngao` and `ngao_app` roles
- redis 7
- minio (private bucket)
- `migrate`, a one-shot job that runs `prisma migrate deploy`
- api
- web
- caddy (TLS termination; `/api/*` goes to api and everything else to web)

Staging and production use separate compose projects and env files. Secrets are supplied through
environment files that are never committed.

## 12. NGAO360 Office

Office (blueprint section 9) is a separate tenant module (`office`, default off) on the same
tenancy, identity, RBAC, audit and storage. Contract: [API_CONTRACT.md](./API_CONTRACT.md) §8–13.

- **Module activation.** `tenant_modules` (RLS) holds per-tenant switches and module config
  (`OfficeModuleConfig` for office). `/auth/me` returns `modules`; navigation hides switched-off
  modules; `@RequireModule('office')` + `ModuleGuard` answer 403 `MODULE_DISABLED` server-side.
- **Data separation (blueprint 15.2).** Office tables (`correspondence*`, `appointments`,
  `meetings`, `meeting_*`, `citizen_cases`, `citizen_case_contacts`, `case_events`,
  `case_referrals`, `institutions`, `projects`, `project_milestones`, `project_evidence`) are
  separate from campaign and tally tables, behind `office.*` permissions held only by the five office
  roles (plus read-only oversight for the organisation owner). Office files use their own storage
  purposes (`CORRESPONDENCE`, `CASE_EVIDENCE`, `PROJECT_EVIDENCE`).
- **Requester privacy.** Contact details are in `citizen_case_contacts`, readable only through an
  audited endpoint with `office.cases.contact.view`; erasure nulls the fields (`erased_at`). Public
  tracking needs a random reference plus a tracking code whose hash only is stored.
- **History.** `case_events`, `meeting_decisions` and `correspondence_attachments` are append-only;
  no Office row can be deleted; case submissions and project evidence facts are immutable (triggers).
- **Accountability.** Projects name the responsible institution and commitment source;
  `projects_verified_completion_check` requires a verifier other than the completion reporter;
  evidence can be verified only by someone other than its uploader and published only when
  verified; `completionEvidenceSufficient()` means a photograph alone never verifies completion.
- **Geography.** Office records stop at ward level and reuse `geographic_units`. Geographic units
  currently belong to an election cycle, so an office-only tenant carries a reference-only cycle for
  its county tree (see the seed). Geo resolvers `officeCase` / `officeProject` plug Office records
  into the existing scoped grants.
- **Public portal.** `/api/public/:tenantSlug/*` is unauthenticated with its own in-memory rate
  limiter (per IP, tenant and bucket), a honeypot and a captcha hook, and identical 404s for unknown
  or disabled tenants. Web routes under `/p/[tenantSlug]` sit outside the authenticated shell.

## 13. Open items for module work

- **Presidential templates.** [DATA_SOURCES_2022.md](./DATA_SOURCES_2022.md) recommends a real 2022 presidential layer (34A/34B/34C) for the pilot county. Add 34A/34B/34C templates to the seed under `packages/db/src/seed/` (reference module). A presidential contest uses `geographicUnitId = null`.
- **Station codes.** 2022 station codes are 15 digits (county 3 + constituency 3 + ward 4 + centre 3 + station 2; this split is inferred). `PollingStation.code` is a free string, and the registry import should accept that format.
- **Historical data.** Import 2022 data into a separate cycle with `dataProvenance = HISTORICAL`. Simulated governor forms belong in a `SYNTHETIC` cycle. Every screen and export must show the provenance label.
- **Personal data in scans.** Scanned forms show presiding officers' and agents' names and signatures. Image viewers for demos should support blurring or redaction overlays. Never alter the stored original.
- **OCR.** There is no OCR engine yet. The worker is a stub that sets `NOT_CONFIGURED`. RESEARCH.md recommends PaddleOCR or docTR with field-box crops plus a digit classifier.
- **Offline capture.** The PWA has a shell only. The encrypted IndexedDB draft queue with idempotency keys is not built yet (blueprint 13.4).

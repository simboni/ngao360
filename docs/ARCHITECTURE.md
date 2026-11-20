# NGAO360 architecture

This document covers the platform foundation and the NGAO TALLY MVP (roadmap stages 1 and 4), NGAO360
Office (stage 5) and the prepared field and election operations module (stage 3, §14). It explains what exists, where it lives and the rules that module work must
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
        field/        ← field and election operations (blueprint 6, 7, 13.4): agents/, deployment/,
                        readiness/, reports/, incidents/, warroom/, sync/, common/ (station-code
                        location and scope, election cycle, idempotency ledger), field.dto.ts
        campaign/     ← campaign and organisation (blueprint 5, 10, 15.3, 15.4): org/, tasks/, events/,
                        comms/, finance/, reports/ (report builder), notifications/ (centre +
                        channel providers), security/ (breach register), common/ (department
                        scope, support helpers), campaign.dto.ts, campaign.constants.ts
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
| Field A: agents, deployment, readiness (S13–S15) and the mobile home API | API `modules/field/agents/**` (incl. `field-me.controller.ts`: `GET /field/me`, `POST /field/evidence`), `modules/field/deployment/**`, `modules/field/readiness/**`; web `app/(app)/field/agents/**`, `app/(app)/field/deployment/**`, `app/(app)/field/readiness/**`, `components/field/agents/**`, `components/field/deployment/**`, `components/field/readiness/**` | `field.module.ts`, `field.dto.ts`, `field.constants.ts`, `field/common/**`, `app/(app)/field/layout.tsx` |
| Field B: field reports, incidents, offline sync and the mobile PWA (S11, S17) | API `modules/field/reports/**`, `modules/field/incidents/**`, `modules/field/sync/**`; web `app/m/**`, `app/(app)/field/incidents/**`, `components/field/mobile/**`, `components/field/reports/**`, `components/field/incidents/**`, `lib/offline/**`, `public/sw.js` | same, plus `lib/nav.ts` (items already present) |
| Field C: War Room (S16) | API `modules/field/warroom/**`; web `app/(app)/warroom/**`, `components/field/warroom/**` | same; `components/field/war-room-banner.tsx` must stay in the War Room layout |
| Office: projects + institutions + public projects | API `modules/office/projects/**`, `modules/office/public/public-projects.controller.ts`; web `app/(app)/office/projects/**`, `app/p/[tenantSlug]/projects/**`, `components/office/projects/**`, `components/office/public/projects-*` | same as above |
| Campaign A: organisation, tasks, events (S05, S08, S09) | API `modules/campaign/org/**`, `modules/campaign/tasks/**`, `modules/campaign/events/**`; web `app/(app)/org/**`, `app/(app)/tasks/**`, `app/(app)/events/**`, `components/org/**`, `components/tasks/**`, `components/events/**` | `campaign.module.ts`, `campaign.dto.ts`, `campaign.constants.ts`, `campaign/common/**`, the `org`, `tasks` and `events` `layout.tsx` files, `lib/nav.ts` (items already present) |
| Campaign B: finance and communications (S10, blueprint 5.4) | API `modules/campaign/finance/**`, `modules/campaign/comms/**`; web `app/(app)/finance/**`, `app/(app)/comms/**`, `components/finance/**`, `components/comms/**` | same; limit evaluation stays in `packages/shared/src/campaign/finance/limits.ts` (no hardcoded limits) |
| Campaign C: reports, notification centre, breach register (S28, blueprint 10.1–10.3, 15.4) | API `modules/campaign/reports/**`, `modules/campaign/notifications/**`, `modules/campaign/security/**`, `modules/admin/notifications.service.ts` and the notification routes of `modules/admin/dashboard.controller.ts`; web `app/(app)/reports/**`, `app/(app)/notifications/**`, `app/(app)/security/**`, `components/reports/**`, `components/notifications/**`, `components/security/**`, the top-bar bell in `components/layout/topbar.tsx` | same; the dataset registry `packages/shared/src/campaign/reports/datasets.ts` may gain datasets (additive) |
| Campaign integration (shared web pieces) | web `components/campaign/**` (dashboard tiles `campaign-kpis.tsx`, navigation tests); the communications screens are under `components/comms/**` and the shared organisation widgets under `components/org/campaign-common.tsx` | `components/admin/dashboard-view.tsx` mounts `CampaignKpis` |

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
- Effective grants are permission × scope. `RbacGuard` passes a request if any held grant is ORGANISATION-wide, contains the target's unit (geographic units have a materialised `path` of ancestor ids), or names the target station. A station grant names the station by code within its election cycle (`stationLineageKey`), so it keeps working across registry versions.
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
- **Offline capture.** The PWA has the `/m` shell and route stubs; the encrypted IndexedDB queue is designed in §14.1 and built by the field module work (server side: the idempotency ledger exists).

## 14. Field and election operations

Blueprint 6 (field, registry, agents), 7 (War Room), 11.3 (mobile PWA), 13.4 (offline). Contract:
[API_CONTRACT.md](./API_CONTRACT.md) §15–22. Module key `field` (default off); the War Room needs
`field` **and** `tally` (`@RequireModule('field', 'tally')`, `PERMISSION_MODULE_TENANT_MODULES`).

- **Station lineage.** A registry amendment (new APPROVED version) creates new polling-station rows
  with the same codes. Everything that names a station keys on (election cycle, station code):
  POLLING_STATION grants (`role_assignments.polling_station_code`, filled by a trigger; matched with
  `stationLineageKey` in `scopeAllows`, `stationScopeWhere`, `submissionScopeWhere`), tally duplicate
  detection and canonical groups, dashboard station counts and every field table
  (`polling_station_code` + `election_cycle_id`, never a registry row id). New field records resolve
  the code in the approved registry (`resolveStationByCode`); responses mark codes dropped by a later
  amendment with `station.inApprovedRegistry=false`.
- **Data model** (migration `20261122000100_field_election_ops`): `agents` (masked phone/ID only) and
  `agent_sensitive` (ID number, phone, M-Pesa, next of kin; read only by the audited reveal),
  `agent_accreditations` (per cycle; recorded, never granted), `agent_trainings`,
  `agent_status_events`; `deployments` (agent × station code × cycle × role × shift; replacement
  links; partial unique indexes against double booking and a second chief agent) and
  `deployment_events`; `readiness_checklists` / `readiness_items`; versioned
  `field_report_templates` (maker-checker activation, frozen once active, one ACTIVE per key),
  `field_reports` (submitted content immutable) and `field_report_evidence`; `incidents` (original
  report immutable; initial vs triaged category and severity), `incident_events`,
  `incident_evidence`, `incident_subjects` (restricted); `station_statuses` (manual override and last
  derived status) and `station_status_events`; `client_submissions` (idempotency ledger). RLS on
  every table; nothing is deleted; histories are append-only (triggers, also for the owner role).
- **Access.** `field.*` and `warroom.*` permissions; roles Field coordinator, Deployment planner,
  Incident desk officer, War Room commander, War Room observer and the station-scoped Polling agent
  (mobile). Separation of duties: report reviewer ≠ author, template activator ≠ creator, incident
  closer ≠ reporter and ≠ resolver (DB checks), triager ≠ reporter, an agent acts only on their own
  deployments; role-level rules `incident-resolve-vs-close` and `field-agent-vs-agent-admin`.
- **Helpers for module agents** (`modules/field/common`): `resolveFieldCycle`, `resolveStationByCode`,
  `resolveFieldLocation`, `fieldGeoLocation`, `fieldScopeWhere`, `agentScopeWhere`,
  `loadFieldLocations`, `ClientSubmissionLedger` (`check`, `record`, `run`). Geo kinds in
  `FIELD_GEO_KIND` are registered by `FieldModule`. DTO classes for every endpoint are in
  `field.dto.ts`.
- **Service seams for sync.** The sync service (Field B) applies items through the owning services.
  Each owner exposes a transaction-level method that performs exactly the direct endpoint's checks
  and writes, without the ledger (the caller wraps it with `ClientSubmissionLedger.run`):
  `ReportsService.submitInTx(tx, auth, dto: CreateFieldReport, ctx)`,
  `IncidentsService.reportInTx(tx, auth, dto: CreateIncident, ctx)`,
  `IncidentsService.addEventInTx(tx, auth, incidentId, dto: AddIncidentEvent, ctx)`,
  `DeploymentService.confirmInTx(tx, auth, deploymentId, dto: ConfirmDeployment, ctx)` and
  `DeploymentService.checkInInTx(tx, auth, deploymentId, dto: CheckIn, ctx)`, with
  `ctx = { via: 'api' | 'sync'; deviceId: string }`; they return the detail DTO and throw
  `AppException`. `SyncModule` already imports `ReportsModule`, `IncidentsModule` and
  `DeploymentModule`.
- **War Room status** is derived at read time (`deriveStationStatus`) from deployments, field
  reports, open HIGH/CRITICAL incidents and tally intake matched by station code, plus the manual
  override; no other module has to call the War Room. One org-wide component snapshot per tenant,
  cycle and registry is cached briefly (at most 8 entries, expired entries evicted on write) and
  filtered by scope in memory; each caller's status is computed from it, with tally-derived states
  only where the caller holds `tally.view` over the station. Derived-status history is written by
  `StationStatusRecorderService` on a timer (set-based, advisory-locked), never by reads. Every
  response carries `WAR_ROOM_LABEL` and completeness; missing stations are never zero.

### 14.1 Mobile PWA and the offline queue (Field B)

- Route group `/m` (outside the desktop shell): `MobileShell` (header with connection state, bottom
  navigation from `MOBILE_NAV`, gated by permission and module). Agents without `dashboard.view` are
  sent from `/dashboard` to `/m`. `/m/forms` links into the existing tally upload when the user holds
  `tally.submit` and the tally module is on.
- The service worker keeps caching the shell and static assets only: never API responses, form
  images or queued records (blueprint 13.4).
- **Queue design** (to build in `apps/web/src/lib/offline/`): one IndexedDB database per signed-in
  user and tenant; each record keeps the `LocalQueueEntry` metadata (`packages/shared/src/field/sync.ts`)
  in clear and the payload (and any photo bytes) encrypted with AES-GCM (WebCrypto, random 96-bit IV
  per record). The key is a **non-extractable** `CryptoKey` generated on the device and stored in
  the same IndexedDB database. **What this protects:** other origins and casual inspection of the
  stored records (dev tools, storage viewers) see only ciphertext. **What it does not protect:**
  "non-extractable" only blocks JavaScript export; the browser serialises the stored key, raw key
  material included, into the profile's IndexedDB files beside the ciphertext, so a copy of the
  browser profile reveals queued payloads. And anyone who opens `/m` on the phone, also offline from
  the last user's local session, sees queued items and their summaries. **Known gap (priority before
  a live pilot):** wrap the queue key with a PIN-derived key (PBKDF2 / Argon2) and require the PIN
  before the queue opens offline (blueprint 11.3 "device PIN").
  On sign-out the database and key are deleted; confirmed items are deleted after `ACCEPTED`.
- Idempotency keys are generated when a record is first saved, before any upload, and reused on
  every retry; conflicts are shown to the person (never resolved by overwriting server data).

## 15. Campaign and organisation

Blueprint 5.1–5.4 (organisation, tasks, events, communications), 10.1–10.3 (standard reports, report builder,
notification centre), 14 (Task / Event, Finance transaction), 15.2–15.4. Contract:
[API_CONTRACT.md](./API_CONTRACT.md) §23–30. Module key `campaign` (default off) gates org/, tasks/, events/, comms/
and finance/; the report builder, notification centre and breach register are platform features (each report dataset
names its own module).

- **Data model** (migration `20261125000000_campaign_organisation`): `departments` (materialised `path`, `depth`,
  lead, budget code, active dates, visibility), `teams`, `team_members` (history via `left_at`; partial unique index on
  active rows); `tasks` (one accountable owner, reviewer ≠ owner, source link to dashboard / project / event / incident /
  case), `task_collaborators`, `task_dependencies`, `task_checklist_items`, `task_comments`, `task_attachments`,
  `task_events`; `campaign_events`, `event_invited_teams`, `event_agenda_items`, `event_logistics_items`,
  `event_attendances`, `event_attendance_contacts` (consent-based contact kept apart; erasure only),
  `event_documents`, `event_after_action_reports` (reviewer ≠ author; frozen once approved); `content_items` (approver ≠
  author; published text changes only with a new revision) and `content_revisions`; finance: `finance_accounts`,
  `finance_categories`, `finance_payees`, `contribution_sources` (masked identifier + keyed fingerprint),
  `finance_budget_lines`, `finance_transactions`, `finance_transaction_documents`, `finance_transaction_events`,
  `finance_limit_settings`; `report_templates`, `report_exports`; `notification_preferences`,
  `notification_deliveries`, `notification_acknowledgements` (plus severity / acknowledgement columns on
  `notifications`); `breach_records`, `breach_events`. RLS on every table; nothing is deleted except the three link
  tables; histories append-only (triggers, also for the owner role).
- **Ledger integrity.** Amounts are `BIGINT` minor units with an ISO currency (`MoneyMinor`; never floats). Entries
  are inserted as DRAFT or REQUESTED only; approval needs a category, a counterparty per type, an external reference
  and a supporting document (trigger); from APPROVED on the financial columns are frozen and the only moves are
  APPROVED → PAID → REVERSED (trigger). Requester ≠ approver, requester ≠ payer, requester ≠ rejecter (checks);
  approver ≠ payer when `CampaignModuleConfig.finance.approverCannotPay` (service). Corrections are REVERSAL entries
  that go through the same approval. DB SoD violations map to 403 `SEPARATION_OF_DUTIES`, missing prerequisites to 409
  `APPROVAL_INCOMPLETE` (`AllExceptionsFilter`).
- **Configurable limits.** Single-source caps, spending limits and reporting deadlines are tenant rows with effective
  dates, election cycle, office type, a mandatory legal source note, a `verified` flag and WARN / BLOCK enforcement;
  value columns are immutable (supersede to change). `evaluateContribution`, `evaluateExpense` and `evaluateDeadlines`
  (`packages/shared/src/campaign/finance/limits.ts`) are the only evaluators; a BLOCK applies only to a verified
  setting and every unverified finding carries "Unverified – configure to the applicable law". Nothing is hardcoded
  (docs/RESEARCH.md: the 2026 regulations are contested).
- **Department scope.** `common/campaign-scope.ts`: involvement OR (department ∈ caller departments AND geography ∈
  grant), with `org.departments.all` lifting the department test; list helpers per record type and
  `campaignRecordInScope` for one record (404 outside). Geo kinds `campaignTeam`, `campaignTask`, `campaignEvent`.
- **Report builder.** `REPORT_DATASETS` is the only queryable surface: per dataset the module, permission, permitted
  fields with classification and extra permission, scope kind and columns, date field, export rules and disclaimer
  (tally datasets keep `PARALLEL_TALLY_DISCLAIMER`). `validateReportDefinition`, `permittedFields`,
  `reportClassification` and `exportRequirements` are shared with the web client. Exports carry generation time,
  filters, scope and classification, are logged in `report_exports` and audited; sensitive ones need
  `reports.export_sensitive` + the dataset's export permission + re-auth.
- **Notification centre.** Extends `notifications`; preferences per user, channel and type (`notificationEnabled`);
  `NotificationChannelProvider` per external channel with the log provider as default (no vendor credentials, nothing
  sent); every attempt in `notification_deliveries`; critical alerts need acknowledgement (append-only record).
- **Political boundary.** No voter lists, recipient lists, personal targeting or bulk outreach anywhere in the model:
  content has audience categories, notifications go to signed-in users about their own work, event contact details are
  consent-based, stored apart and never exported.

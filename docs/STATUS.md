# NGAO360 build status

Branch `feat/foundation-tally-mvp` (merged to `main`), then `feat/office-governor`. Scope: roadmap stage 1 (platform foundation) and stage 4 (NGAO TALLY core), with the County Governor contest (Forms 37A/37B/37C) as the end-to-end rehearsal; stage 5 (NGAO360 Office) has its environment prepared for parallel module work (see "Office environment" below). All demo and test data is synthetic. The parallel tally is an internal record and is never labelled official.

## Pipeline (last run)

| Step | Command | Result |
| --- | --- | --- |
| Install | `pnpm install --frozen-lockfile` | OK |
| Typecheck | `pnpm typecheck` | 6/6 packages OK |
| Lint | `pnpm lint` | 6/6 packages OK |
| Build | `pnpm build` | shared, db, api, web OK (web includes `/accept-invitation`) |
| Unit and integration tests | `set -a; . ./.env; set +a; pnpm test` | shared 133, web 33, api 217 tests (20 suites, with RLS and HTTP integration against `ngao360_test`) |
| Governor rehearsal (e2e) | `pnpm test:rehearsal` | 11/11 |

Local services used: PostgreSQL 16 on port 5433 under `/tmp/ngao-pg`, Redis on 6379 (see `docs/DEVELOPMENT.md`). Migrations run up to `20261120000500_office_environment`.

## Screens (blueprint section 11)

| ID | Screen | Status | Notes |
| --- | --- | --- | --- |
| S01 | Login / MFA | Done, with gaps | Organisation code, email and password, TOTP challenge and enrolment, password lockout and TOTP lockout, legal links. Invitation acceptance page (`/accept-invitation`). No passkeys and no self-service recovery. |
| S02 | Workspace setup | Not started | Tenants are created by the seed or by a platform operator directly in the database. |
| S03 | Onboarding checklist | Not started | |
| S04 | Executive dashboard | Partial | Command-centre dashboard: KPI cards with definitions, priority queue, quick actions, scoped to the caller. No activity chart or geo panel yet. |
| S05 | Organisation tree | Not started | |
| S06 | User directory | Done | Search, filters, status, role chips, invitation by single-use link (and re-issue), suspend, reactivate, reset MFA, sessions. Teams are not modelled yet. |
| S07 | Role editor | Done | Permission matrix, module grouping, geography and cycle scope, expiry, effective-access preview, role-level and cross-role separation-of-duties checks, grantor-scope limits. |
| S08 | Task board | Not started | Stage 2. |
| S09 | Event detail | Not started | Stage 2. |
| S10 | Finance ledger | Not started | |
| S11 | Field report form | Not started | Stage 3. |
| S12 | Station registry | Partial | Versioned CSV import (queued for large files), validation report, diff against the approved version, maker-checker approval, list and filters. No map and no edit screen for a draft version. |
| S13 | Agent profile | Not started | Stage 3. |
| S14 | Deployment planner | Not started | Stage 3. |
| S15 | Election readiness | Not started | Stage 3. |
| S16 | War Room | Not started | Stage 3. |
| S17 | Incident intake | Not started | Stage 3. |
| S18 | Form inbox | Done | Upload (image or PDF, SHA-256, immutable original), filters, duplicate flag, processing state, views for "my uploads", "awaiting my review" and "awaiting supervisor". |
| S19 | Form capture | Done | Side-by-side image and field entry, OCR shown as a draft only, live validation with the exact rule and fields, change reasons, history. Arithmetic failures on printed figures go forward held by a case. |
| S20 | Verification workspace | Done | Blind independent re-entry or confirm mode, checklist, field comments, pass, return or dispute, supervisor actions (approve, reject, third check). Tally supervisors are routed here. |
| S21 | Parallel tally | Done | Contest and geography selectors, candidate totals in ballot order, verified-station denominator, mutually exclusive coverage segments, drill-down, station list, immutable snapshots, internal release, CSV, XLSX and PDF exports with the disclaimer. No trend chart over time. |
| S22 | Discrepancy case | Done | Source A/B comparison, case types, assignment, comments, reasoned resolution (canonical record, exclusion), closure by a different person. |
| S23 | Correspondence inbox | Environment ready | Schema, permissions, shared DTOs, API contract (§9–13), empty Nest controllers and web route stubs; seeded synthetic data. Screens and endpoints to be built by the office agents. |
| S24 | Citizen portal | Environment ready | Schema, permissions, shared DTOs, API contract (§9–13), empty Nest controllers and web route stubs; seeded synthetic data. Screens and endpoints to be built by the office agents. |
| S25 | Case workspace | Environment ready | Schema, permissions, shared DTOs, API contract (§9–13), empty Nest controllers and web route stubs; seeded synthetic data. Screens and endpoints to be built by the office agents. |
| S26 | Project register | Environment ready | Schema, permissions, shared DTOs, API contract (§9–13), empty Nest controllers and web route stubs; seeded synthetic data. Screens and endpoints to be built by the office agents. |
| S27 | Project detail | Environment ready | Schema, permissions, shared DTOs, API contract (§9–13), empty Nest controllers and web route stubs; seeded synthetic data. Screens and endpoints to be built by the office agents. |
| S28 | Report builder | Not started | |
| S29 | Audit log | Partial | Hash-chained, append-only events with filters, before and after, export. No retention-hold control. |
| S30 | System settings | Partial | Form-template registry with versioning and maker-checker approval (`/reference/forms`). No module, integration, retention or backup settings. |

## NGAO TALLY acceptance criteria (blueprint 17.2)

| Criterion | Status | Evidence |
| --- | --- | --- |
| Each supported form template is linked to its official source, version and effective date | Done | `form_templates` (official source, version, effective date, approval state); all 22 forms of the 34–39 series seeded; maker-checker covers creators and editors. |
| Upload and preserve an original form image with a unique submission ID and hash | Done | `SUB-YYYY-NNNNNN` reference, SHA-256, immutable stored files (DB triggers); `tally.api.integration.spec.ts`. |
| Capture records all configured fields and source metadata | Done | Field schema per template, declaration metadata, image quality, page count. |
| OCR is a draft; a human confirms every vote value | Done | OCR writes `ocrValue` only; submit for review needs every required value confirmed by a person. |
| A user cannot independently verify their own submission | Done | Verifier must differ from the submitter, every value editor or confirmer (from the append-only audit stream), any supervisor and any discrepancy resolver of the record; `separation-of-duties.spec.ts`, regression suite. |
| Validation warnings identify the exact field and rule and never discard or alter data | Done | Engine tests now use the seeded 37A, 37B and 37C rules from the shared catalogue. |
| Only verified submissions are in the default tally; exclusions and missing records stay visible | Done | Canonical VERIFIED records with no open holding case; archived-only stations show as excluded, never missing; records are matched to a new registry version by station code. |
| Any change to a captured value records actor, old value, new value, time and reason | Done | `result_value_changes` (append-only) plus audit events. |
| Exports carry the non-official disclaimer and snapshot reference | Done | CSV, XLSX and PDF; `export.spec.ts`, rehearsal. |
| No copy suggests NGAO360 declares or certifies winners | Done | Forbidden-wording test over web copy; API responses checked in tests. |

## Review findings addressed in this pass

All 27 reviewer findings were checked against the code and confirmed. Each was fixed. The security and integrity fixes have regression tests in `apps/api/test/auth-hardening.integration.spec.ts`, `apps/api/src/modules/tally/__tests__/tally.regressions.integration.spec.ts`, `apps/api/src/rbac/scope.spec.ts`, the domain specs and `apps/web/src/components/tally/__tests__/review-findings.test.ts`. Summary:

- **Auth:** a `verify` challenge can no longer start or confirm enrolment. Replacing an authenticator from a session needs re-authentication. TOTP failures are counted per user and lock after 5. Enrolment start is audited.
- **Access administration:** administrators cannot set passwords; invitations are single-use tokens. Grants are limited to the grantor's own `roles.assign` scope and cycle, and a non-org-wide grantor can only hand out permissions they hold. This applies to revocation too.
- **Authorisation:** election-cycle-limited grants are honoured everywhere. Multi-permission routes re-check the geography of the permission actually used (exclude, approve, return, source download). Discrepancy changes require every linked record to be in scope. Export lists are scoped.
- **Tally integrity:** open holding cases block a pass and keep VERIFIED records out of totals. Supervisor reject and third-check decisions resolve the disagreement case, and third checks need independent re-entry. Resolving a case releases only records it alone was holding. Verified records cannot be archived. Canonical designation cannot silently demote a verified record and needs re-authentication. Coverage segments are mutually exclusive. Records map to a new registry version by station code, and an approval that would orphan filed forms is refused. Registry and template approval enforce maker-checker.
- **Workflow:** arithmetic failures on printed figures reach second review held by an ARITHMETIC case, instead of hitting a dead end. A blind-mode Return no longer turns into a false dispute. Supervisors have a queue and are routed to the verification workspace.
- **Concurrency:** supervisor actions, discrepancy status changes and canonical designation are conditional writes. Save and submit-for-review lock the submission row. A cross-stage comparison failure no longer returns an error for a verification that was already recorded.

## Office environment (stage 5 preparation)

- **Module activation:** `tenant_modules` + `/workspace/modules` (S30 module settings API, no screen yet), `modules` in `/auth/me`, `@RequireModule` + `ModuleGuard` (403 `MODULE_DISABLED`), Office nav group hidden unless the module is on and the user holds an office permission. Office is off by default.
- **Schema:** migration `20261120000500_office_environment` adds correspondence (+ attachments), appointments, meetings (+ action items, decision log), citizen cases with separate contact table, case timeline (public/internal), referrals, institution registry, projects, milestones and evidence. RLS on every table; no deletes; append-only timeline, decisions and attachments; immutable case submissions and evidence facts; checks for verified completion (second person), evidence verification (not the uploader), publication and public contract amounts.
- **Access:** 21 `office.*` permissions and five roles (Office administrator, Case officer, Correspondence clerk, Projects officer, Public-information editor). Office roles hold no campaign or tally permissions; tally roles hold no office write permissions (unit-tested).
- **Contracts:** shared zod DTOs in `packages/shared/src/office/`; endpoints, permissions, audit actions and transitions in `docs/API_CONTRACT.md` §8–13.
- **API skeleton:** `apps/api/src/modules/office/{correspondence,appointments,cases,projects,public}` with empty controllers/services, geo resolvers `officeCase` / `officeProject`, location and scope helpers, public reference and tracking-code helpers, and the public area's own rate limiter, honeypot/captcha hook, tenant resolution and `GET /public/:tenantSlug/portal`.
- **Web skeleton:** `/office/correspondence[/id]`, `/office/appointments`, `/office/cases[/id]`, `/office/projects[/id]` behind the module gate; public route group `/p/[tenantSlug]` (home, request, track, projects, project) outside the authenticated shell.
- **Seed:** tenant `bungoma-governor` (synthetic County Governor's office, Bungoma) with the office module and portal on, 18 synthetic institutions, 7 office users, 25 cases across all stages, 15 correspondence items, 10 appointments, 2 meetings and 12 projects with milestones, evidence files and mixed verification states.

## Known gaps

- **Invitation delivery:** there is no e-mail or SMS channel yet, so the inviting administrator sees the link once and relays it. An administrator could still redeem a link themselves. Before the pilot, send invitations straight to the invitee and stop showing the link to the administrator in production.
- **Cross-stage comparison retry:** a failed comparison is logged but not retried. It needs a durable BullMQ job or a "re-run comparison" action.
- **Registry versions:** the tally aggregate maps records by station code, but some code still uses station row ids: polling-station-scoped grants, the dashboard "stations with forms" counts and intake duplicate detection. All three should move to station code (or a lineage table) before a mid-election registry amendment.
- **Accepted arithmetic:** an arithmetic case resolved as "figures as printed" allows a later pass. The acceptance is not tied to the exact figures, so a recapture after a return should reopen the check.
- **Queue filters:** the `awaiting_me` and `awaiting_supervisor` filters use the current value rows. Separation of duties is enforced on every action from the full audit history, so these lists are only an approximation.
- **Security review items still open:** passkeys, account recovery, rate limiting by account across instances (Redis store), a malware scan for uploads, real OCR, an S3 object lock for originals in production, a load test and a backup and restore drill (roadmap stage 6).
- **Office foundation gaps:** the public-portal limiter keeps counters in memory per API instance (move to Redis with the auth limiter); no captcha verifier is bound (configuring a provider fails closed); geographic units are tied to an election cycle, so an office-only tenant carries a reference-only cycle; services must check that linked ids belong to the tenant (FKs do not); there is no workspace settings screen for module activation yet (API only); contact-retention erasure is manual (no scheduled job yet).
- **Not built yet:** S02, S03, S05, S08–S11, S13–S17 and S23–S28. 2022 historical data import is designed (`docs/DATA_SOURCES_2022.md`) but not wired in.

## Recommended next workflow

1. **Stage 2, Command and organisation (3–4 weeks):** S05 organisation tree and teams, S08 task board, S09 events, an S04 dashboard with activity and geo panels, the notification centre (in-app now, then e-mail and SMS, which unblocks invitation delivery) and standard reports (section 10.1). Reuse the existing RBAC scopes, audit stream and module gating.
2. **Stage 3, Field and election operations (3–4 weeks):** S13 agent profiles, S14 deployment planner, S15 readiness dashboard, S11 and S17 field and incident intake on the PWA with offline queueing (section 13.4), and S16 War Room fed by the tally state. Move station-scoped grants and dashboards to station code first, so registry amendments stay safe.
3. **Stage 5, Office and public portal (3–4 weeks), the governor's-office environment the pilot customer asked for next:** S23 correspondence, S24 and S25 citizen cases, S26 and S27 projects, with a privacy review of public pages. Keep it in a separate module behind module activation, sharing tenancy, auth and audit.

Before any pilot use: close the invitation-delivery gap, add the cross-stage retry job, and run a security review (stage 6 items above).

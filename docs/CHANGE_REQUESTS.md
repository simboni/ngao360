# Change requests

Requests from module agents for changes outside the files they own. Append below; do not edit other agents' entries.

## Status (integration pass, 2026-11-20)

| Request | Status |
| --- | --- |
| Reference 1, Admin 1: root re-exports | **Applied.** `@ngao360/shared` exports `./reference` and `./admin`. All `@ngao360/shared/dist/*` imports and `reference-shared.ts` are gone. |
| Reference 2: registry import log | **Applied.** Migration `20261120000300` adds the append-only `registry_imports` table (tenant RLS) and `registry_versions.publication_date`. Imports write the log; `import-status` reads it first and falls back to audit events. |
| Reference 3: database guards | **Applied** in the same migration. Approved registry versions are immutable (APPROVED → SUPERSEDED only). Polling stations change only in DRAFT versions. Approved form templates are immutable (APPROVED → RETIRED only). |
| Reference 4, Tally 5, Admin 2: contract additions | **Open (docs).** Implemented and tested; `docs/API_CONTRACT.md` has not been rewritten yet. These entries are the current reference. |
| Reference 5: reject certificate templates | **Applied.** Intake returns 400 `VALIDATION_FAILED` for CERTIFICATE-level templates (covered by the Governor rehearsal test). |
| Reference 6: docs | **Applied** (README, DEVELOPMENT.md, `.env.example`). |
| Tally 1: OCR queue through provider | **Applied.** |
| Tally 2: `OCR_RECORDED` audit action | **Applied.** |
| Tally 3: `StationCoverageRowSchema` | **Applied.** API and web use the shared type. |
| Tally 4: `OCR_PROVIDER` config | **Applied.** |
| Tally UI 1: web test script and `tsx` | **Applied.** `pnpm test` runs the 27 tally UI tests. |
| Tally UI 2: Recharts | **Not applied.** The dependency-free charts are kept. |
| Tally UI 3, 4: shared evaluator and coverage type | **Applied.** |
| Tally UI 5: `GET /tally/assignees` | **Open.** |
| Tally UI 6: CSP must allow `blob:` | **Open.** No CSP yet; keep this in mind when adding one. |
| Admin 3: invitation acceptance | **Open.** Needs a new `user_invitations` table and e-mail delivery. |
| (new) 413/415 upload errors | **Applied.** Mapped to `VALIDATION_FAILED` instead of `INTERNAL`. |

## Reference module (from the reference-data agent)

1. **Re-export the reference helpers from the shared root.** Add this line to
   `packages/shared/src/index.ts`:
   ```ts
   export * from './reference';
   ```
   Until then, the API and seed import through `@ngao360/shared/dist/reference`
   (`apps/api/src/modules/reference/reference-shared.ts`). After the change, switch those
   imports to `@ngao360/shared` and delete `reference-shared.ts`.

2. **Registry import log table (schema).** Blueprint 6.2 requires the source, publication
   date, version, approving user and import validation report to be kept. `registry_versions`
   has no column for the publication date or the report. As a workaround, the import
   lifecycle (QUEUED, RUNNING, COMPLETED, FAILED) and the full `RegistryImportReport` are
   stored as `reference.imported` audit events on the `RegistryVersion`. `GET
   …/import-status` reads the latest one. Proposed schema:
   ```prisma
   model RegistryImport {
     id                String   @id @default(uuid()) @db.Uuid
     tenantId          String   @map("tenant_id") @db.Uuid
     registryVersionId String   @map("registry_version_id") @db.Uuid
     sourceFileId      String?  @map("source_file_id") @db.Uuid
     status            String   // QUEUED | RUNNING | COMPLETED | FAILED
     publicationDate   DateTime? @map("publication_date") @db.Date
     sourceUrl         String?  @map("source_url")
     changeNotes       String?  @map("change_notes")
     report            Json
     unitsCreated      Int      @default(0) @map("units_created")
     stationsCreated   Int      @default(0) @map("stations_created")
     error             String?
     importedById      String   @map("imported_by_id") @db.Uuid
     createdAt         DateTime @default(now()) @map("created_at") @db.Timestamptz(3)
     completedAt       DateTime? @map("completed_at") @db.Timestamptz(3)
     @@index([tenantId, registryVersionId, createdAt])
     @@map("registry_imports")
   }
   ```
   Also add `publication_date DATE NULL` to `registry_versions`, with RLS and `tenant_id` as
   for every tenant-owned table.

3. **Database guard for approved form templates and registry versions (migration).** The API
   refuses to edit an APPROVED or RETIRED `form_templates` row and an APPROVED or SUPERSEDED
   `registry_versions` row, and refuses to add or change `polling_stations` in a non-DRAFT
   version. A trigger like `ngao_stored_files_guard` would make this hold at database level.
   The trigger should allow only `approval_state` changes to RETIRED (templates) and
   `status` changes to SUPERSEDED (registry versions).

4. **API contract additions (docs/API_CONTRACT.md §4.3).** These are implemented and are
   backwards-compatible supersets:
   - `POST /reference/registry-versions/:id/import` accepts optional multipart text fields:
     `dryRun` (`true` validates and returns the report without storing anything, status 200),
     `publicationDate` (YYYY-MM-DD), `sourceUrl` and `changeNotes` (`RegistryImportOptionsSchema`).
     The response is `RegistryImportOutcome`: the `RegistryImportResult` fields plus
     `status`, `dryRun` and the full `report` (`RegistryImportReportSchema`). Status is 201
     when imported and 202 when queued. A file that cannot be imported at all (for example,
     missing columns) returns 400 `VALIDATION_FAILED` with `details.report`.
   - The CSV also accepts optional `stream_number`, `latitude`, `longitude` and
     `location_source` columns. `centre_code` and `centre_name` are optional (polling centres
     are optional groupings).
   - Importing into a version that already has stations returns 409 `CONFLICT`; importing into
     an APPROVED or SUPERSEDED version returns 409 `IMMUTABLE_RECORD`. Imports never overwrite.
   - `GET /reference/polling-stations` defaults to the cycle's APPROVED registry version when
     `registryVersionId` is omitted.
   - `GET /reference/contests` also accepts `status`.
   - `POST /reference/form-templates/:id/approval`: REJECT needs `forms.approve` but no
     re-authentication. APPROVE retires the previously APPROVED version of the same form
     number in the cycle, so intake matches exactly one approved version.
   - `POST /reference/polling-stations` is refused (409 `IMMUTABLE_RECORD`) unless the
     registry version is DRAFT.

5. **Tally intake (tally agent):** reject templates whose `formLevel` is `CERTIFICATE`
   (34D, 35C, 36C, 37D, 38D, 39D). These are seeded as reference-only records and must never be
   captured. Use `isCapturableFormLevel()` from the shared reference helpers. The shared
   `evaluateValidationRules()` is the reference evaluator for template rules, with the
   semantics documented in `packages/shared/src/reference/rules.ts`. Using it keeps capture
   and the registry consistent.

6. **Docs (DEVELOPMENT.md and .env.example):**
   - Demo MFA is now controlled by `SEED_DEMO_MFA`. The default, `disabled`, seeds no
     authenticators: users whose role requires MFA enrol at first sign-in. `preenrolled`
     restores the shared development TOTP secret.
   - `SEED_DEMO_PASSWORD` is required when `NODE_ENV=production`.
   - The demo tenant is now named "Demo Organisation" (slug `demo`) and the cycle is
     "2027 General Election". New demo users: `lead@`, `coordinator@` (Synthetic Constituency
     North) and `finance@demo.example.org`.
   - The synthetic registry has 153 stations (it was 16).

## Tally module (from the tally agent)

1. **Route OCR queue jobs through the pluggable provider.** `apps/api/src/queue/ocr.processor.ts`
   still marks every extraction `NOT_CONFIGURED`. `TallyModule` exports `TallyOcrService`,
   whose `process(tenantId, extractionId)` runs the configured provider (`OCR_PROVIDER=none|stub`)
   and writes only `ocrValue`/`ocrConfidence` drafts. Replace the body of `OcrProcessor.process`
   with:
   ```ts
   await this.moduleRef.get(TallyOcrService, { strict: false }).process(job.data.tenantId, job.data.extractionId);
   ```
   (inject `ModuleRef` from `@nestjs/core`). With `QUEUES_ENABLED=false` the tally module
   already runs the provider in process after the submission commits.

2. **Audit action for OCR drafts.** Add to `AUDIT_ACTIONS` in
   `packages/shared/src/schemas/admin.ts`:
   ```ts
   OCR_RECORDED: 'tally.ocr.recorded',
   ```
   The tally module writes this literal today (`OCR_RECORDED_ACTION` in
   `apps/api/src/modules/tally/ocr/ocr.service.ts`); switch to the constant once added.

3. **Shared schema for `GET /tally/results/stations` rows.** The contract type
   `SubmissionSummary & { pollingStationId, coverageStatus }` cannot describe MISSING stations,
   which have no submission but must stay visible. The API returns this shape (type
   `StationCoverageRow` in `apps/api/src/modules/tally/services/results.service.ts`). Add to
   `packages/shared/src/schemas/tally.ts` and reference it in `docs/API_CONTRACT.md` §5.6:
   ```ts
   export const StationCoverageStatusSchema = z.enum(['MISSING', 'RECEIVED', 'VERIFIED', 'FLAGGED', 'EXCLUDED']);
   export const StationCoverageRowSchema = SubmissionSummarySchema.extend({
     id: UuidSchema.nullable(),
     reference: z.string().nullable(),
     formNumber: z.string().nullable(),
     formLevel: FormLevelSchema.nullable(),
     formTemplateVersion: z.number().int().nullable(),
     status: SubmissionStatusSchema.nullable(),
     sourceType: SubmissionSourceTypeSchema.nullable(),
     isCanonical: z.boolean().nullable(),
     duplicateFlag: z.boolean().nullable(),
     submitter: UserRefSchema.nullable(),
     submittedAt: IsoDateTimeSchema.nullable(),
     createdAt: IsoDateTimeSchema.nullable(),
     updatedAt: IsoDateTimeSchema.nullable(),
     pollingStationId: UuidSchema,
     coverageStatus: StationCoverageStatusSchema,
     /** Votes by candidate id for VERIFIED (included) stations only; null otherwise, never zero-filled. */
     candidateVotes: z.record(z.number().int()).nullable(),
   });
   export type StationCoverageRow = z.infer<typeof StationCoverageRowSchema>;
   ```

4. **`OCR_PROVIDER` configuration.** Add `OCR_PROVIDER: z.enum(['none', 'stub']).default('none')`
   to `apps/api/src/config/config.schema.ts`, and `OCR_PROVIDER=none` to `.env.example` and
   `docs/DEVELOPMENT.md`. The tally module reads `process.env.OCR_PROVIDER` directly until then.
   `stub` is for development only: it writes synthetic low-confidence drafts.

5. **API contract clarifications for §5 (docs/API_CONTRACT.md).** Please record these
   behaviours, which the tally module implements:
   - `POST /tally/submissions`: a template problem (not APPROVED, wrong office or cycle) moves
     the record to QUARANTINED and opens `FORM_VERSION_MISMATCH`. A station problem (not in
     the approved registry, wrong cycle, inactive, outside the contest area) or a tally-centre
     level mismatch opens a `METADATA` case and keeps the original metadata; it does not
     quarantine. `imageQuality` POOR or ILLEGIBLE opens an `IMAGE_QUALITY` case. Station
     geography is checked in the service, because guards run before multipart parsing.
   - `POST /tally/submissions/:id/transition` also accepts `to: SECOND_REVIEW_PENDING` from
     DISPUTED or EXCLUDED_FROM_AGGREGATE with `tally.approve` (re-review). Other targets
     return 400 and point to the dedicated endpoint. Optimistic concurrency uses the stored
     row `version`. `SubmissionTransitionSchema` has no client `version` field; add an optional
     `expectedVersion` if the UI needs stale-write detection.
   - `PUT /values`: BOOLEAN_OBSERVATION fields accept `numericValue` 0/1 or `textValue`
     yes/no/true/false, and are stored as 0/1. Saving moves SUBMITTED, OCR_COMPLETE or
     RETURNED to DATA_ENTRY_REVIEWED. Validation re-runs without opening cases. Only
     `POST /validate` opens an `ARITHMETIC` case, and it holds the record (DISPUTED) only when
     the record is SECOND_REVIEW_PENDING or VERIFIED.
   - Verification: when `independentValues` is non-empty, this is independent re-entry mode,
     and it must include every candidate-vote cell and every required numeric field.
     Otherwise it is confirm mode. PASS needs all four checklist confirmations and no FAIL
     result. Mismatch keys are `fieldKey` or `fieldKey:candidateReferenceId`. A mismatch moves
     the record to DISPUTED, whatever the decision, and opens an ESCALATED
     `REVIEWER_DISAGREEMENT` case. After `THIRD_CHECK_REQUESTED`, the next reviewer must not
     have reviewed the record before. Only the latest round can receive a supervisor action;
     its geography is checked in the service.
   - Discrepancy resolution sends DISPUTED linked records back to SECOND_REVIEW_PENDING
     (never straight to VERIFIED). It releases QUARANTINED records to SUBMITTED when their
     template is now APPROVED. Excluding records also needs `tally.exclude`. The resolver must
     not be the submitter, a value editor or a verifier of any linked record. Manual case
     transitions also allow ESCALATED → UNDER_REVIEW.
   - Cross-stage comparison runs automatically when a collation-level form (e.g. 37B, 37C)
     becomes VERIFIED. It compares the form with the verified station-level aggregate for the
     tally centre's area and opens `CROSS_STAGE_MISMATCH` (HIGH when coverage is complete, LOW
     otherwise), linking the collation form as SOURCE_B and the included station forms as
     SOURCE_A.
   - Exports are generated synchronously (201). `TALLY_EXPORT_QUEUE` is not used yet.
     Candidate shares are percentages (0 to 100, two decimals) of verified valid votes.
     Candidates are always listed in ballot order.

## Admin module (from the admin agent)

1. **Re-export the admin helpers from the shared root.** Add to `packages/shared/src/index.ts`:
   ```ts
   export * from './admin';
   ```
   Until then the API and web import through `@ngao360/shared/dist/admin`. After the change, switch
   those imports to `@ngao360/shared`.

2. **API contract additions (docs/API_CONTRACT.md §6–7).** Implemented, backwards-compatible supersets:
   - `GET /dashboard/summary` accepts optional `contestId` and returns `DashboardSummaryExtended`
     (`@ngao360/shared/dist/admin`): each KPI adds `denominator`, `definition`, `href`, `breakdown`
     and `availability`; `recentActivity` items add `entityId`, `actor` and `reason`; plus
     `priorityQueue`, `electionCycle`, `registryVersion`, `contest`, `contests`, `generatedAt`,
     `includesTally` and `scoped`. Callers without `audit.view` see only their own recent activity.
   - `GET /admin/roles/:id/effective-access` adds `highRiskCount`, `mfaRequired`, `sodConflicts` and `notes`.
   - `GET /admin/audit-events`: `action` is a prefix match (`role.` finds every role event); `q`
     searches reason, entity id and action; `order=asc` reverses the `seq desc` default. A `from`
     after `to` returns 400. Exports are capped at `AUDIT_EXPORT_MAX_ROWS` (50,000) rows.
   - Extra separation-of-duties rules, all returning `SEPARATION_OF_DUTIES`: nobody edits a role they
     hold, revokes their own assignment, changes their own status or resets their own MFA; and a
     person never holds `roles.configure`/`roles.assign` together with a result-changing permission
     (`tally.capture`, `tally.verify`, `tally.approve`, `tally.exclude`, `tally.discrepancy.resolve`),
     whether in one role (400) or across roles (400). The last active organisation-wide holder of
     `roles.assign` cannot be suspended (409).

3. **Invitation completion (auth). Done:** implemented as `POST /auth/invitation/accept` and
   `POST /admin/users/:id/invitation` (token hash on `users.invitation_token_hash`; no e-mail
   delivery yet). Original request: `POST /admin/users` without `initialPassword` creates an
   `INVITED` user, but there is no endpoint for an invited user to set a password, and no
   invitation e-mail. Proposed: `POST /auth/invitations/accept { token, password }` with a
   single-use, 72-hour token (hash stored on a new `user_invitations` table with `tenant_id`, RLS
   and an audit event), plus `POST /admin/users/:id/resend-invitation` (`users.create`, reauth).

## Tally UI (from the tally web agent)

The S18–S22 screens live in `apps/web/src/app/(app)/tally/**` and `apps/web/src/components/tally/**`.

1. **Web test script.** The tally UI tests use `node:test` with `tsx` (no new dependencies) and a
   test-only tsconfig that switches JSX to `react-jsx`. Please set the `test` script in
   `apps/web/package.json` to:
   ```json
   "test": "tsx --tsconfig src/components/tally/__tests__/tsconfig.json --test src/components/tally/__tests__/*.test.ts src/components/tally/__tests__/*.test.tsx"
   ```
   and add `tsx` (already present in the workspace, currently resolved transitively) as an explicit
   `devDependency` of `@ngao360/web` so the binary is guaranteed.

2. **Charting library (optional).** The brief named Recharts for the S21 candidate bar chart. Adding a
   dependency means editing `apps/web/package.json` and the lockfile, which this agent does not own,
   so `components/tally/charts.tsx` ships dependency-free, accessible CSS/SVG charts (single
   neutral hue, ballot order, keyboard-focusable bars with tooltips, a table view beside each chart).
   If Recharts is still wanted, add `recharts` to `@ngao360/web`; the chart components take the
   same `CandidateTotal[]` / `Coverage` props, so they can be swapped without changing the dashboard.

3. **Validation evaluator import.** The live validation checklist (S19/S20) uses the shared
   reference evaluator through `@ngao360/shared/dist/reference/rules`. Once reference item 1 lands
   (`export * from './reference'` in the shared root), switch the import in
   `components/tally/capture-model.ts` to `@ngao360/shared`.

4. **`StationCoverageRow`.** `components/tally/types.ts` mirrors the API row type from tally item 3.
   Replace it with the shared schema when that is added.

5. **Discrepancy owner picker.** `POST /tally/discrepancies/:id/assign` takes a user id, but the tally
   roles cannot list users (`/admin/users` needs `users.view`). S22 therefore offers "Assign to me"
   and "Unassign" only. Proposed: `GET /tally/assignees` (`tally.discrepancy.manage`) returning
   `UserRef[]` of active users holding `tally.discrepancy.manage` or `tally.discrepancy.resolve`
   within the case's geography.

6. **Content Security Policy.** The source viewer fetches the original through the audited signed
   URL, checks its SHA-256 in the browser and displays it from a `blob:` URL (this also works with
   `X-Frame-Options: DENY` for PDFs). If a CSP is added to the web app, it must allow
   `img-src blob:` and `frame-src blob:` (and `connect-src` for the S3/MinIO host when the S3 driver
   is used; that bucket also needs CORS for `GET` from the web origin, otherwise the viewer falls
   back to the signed URL without the browser-side hash check).

## Office: citizen cases and public portal UI (from the cases web agent)

1. **Run the new web tests in `pnpm test`.** The Office case screens and the public portal have
   their own suites, which the current `@ngao360/web` `test` script does not pick up (it globs
   `components/tally/__tests__` only). Proposed script:
   `tsx --tsconfig src/components/tally/__tests__/tsconfig.json --test src/components/tally/__tests__/*.test.ts src/components/tally/__tests__/*.test.tsx && tsx --tsconfig src/components/public/__tests__/tsconfig.json --test src/components/public/__tests__/*.test.tsx && tsx --tsconfig src/components/office/cases/__tests__/tsconfig.json --test src/components/office/cases/__tests__/*.test.tsx`.

2. **Assignee lookup for cases.** `POST /office/cases/:id/assign` takes a user id, but case officers
   cannot list users (`/admin/users` needs `users.view`, which only the Office administrator holds).
   The assign dialog therefore offers the caller, anyone already assigned, and (for `users.view`
   holders) active Case officers and Office administrators; the API still checks the assignee's
   permission and scope. Proposed: `GET /office/cases/:id/assignable-officers`
   (`office.cases.manage`, geo) returning `UserRef[]` of active users holding `office.cases.manage`
   over the case location.

3. **Office geography lookup.** Office roles do not hold `reference.view`, so the case list filter,
   the "Record a case" form and the edit dialog read constituencies and wards (and the current
   privacy notice) from `GET /public/:tenantSlug/portal`. That only works while the public portal
   is on. Proposed: `GET /office/geography` (any `office.*.view`) returning the county's
   constituencies and wards, and `GET /office/privacy-notice` returning `portalPrivacyNotice()` with
   the tenant's configuration, so walk-in recording works with the portal switched off.

4. **Kiswahili strings.** `components/public/i18n.ts` holds the complete English table and a partial
   `sw` table that falls back to English key by key. The privacy notice text itself comes from the
   API (`portalPrivacyNotice`) and is English only; a Kiswahili notice needs a `locale` argument on
   that function and on `GET /public/:tenantSlug/portal`, reviewed by a fluent speaker.

5. **Captcha widget.** The portal ships no captcha script (no third-party hosts). When an office sets
   `captchaProvider`, register a widget with `registerCaptchaWidget()` in
   `components/public/captcha.tsx` and add the provider's host to a future CSP; until then the
   forms explain that the check is unavailable and do not submit, matching the API, which fails
   closed.

6. **Public portal bundle size.** `next build` reports 175–181 kB first-load JavaScript for the public
   pages (about the same as `/login`; 102 kB is the framework baseline). Much of the rest is likely
   `@ngao360/shared`: `lib/api-client.ts` imports `CSRF_HEADER` from the package barrel, whose zod
   schemas are module-level and hard to tree-shake. A `@ngao360/shared/constants` subpath export
   (no zod) would probably reduce the first load on slow mobile connections; measure before and after.

## Office API (from the Office API agent)

All Office and public-portal endpoints in API_CONTRACT §9–13 are implemented in
`apps/api/src/modules/office/**`, with integration suites in `apps/api/test/office-*.spec.ts`. The items
below are additions or decisions that need a contract or shared-schema update; none changes an existing
request or response shape.

1. **Endpoints added beyond §9–13 (implemented; please add rows to the contract and zod schemas to
   `packages/shared/src/office/`).** Response types are declared locally in the API for now.
   - `GET /office/cases/:id/possible-duplicates` (`office.cases.view` **(geo)**) →
     `PossibleDuplicate[]` = `{ id, reference, publicReference, title, status, submittedAt, similarity }`.
     The triage hint from blueprint 9.2: same category and same ward (or constituency when no ward is
     known), submitted within 30 days, description similarity ≥ 0.25, scope-filtered. Portal
     submissions with a hint also get an INTERNAL `NOTE` event with `actorType: SYSTEM` naming the
     internal references; it never reaches the tracking page.
   - `GET /office/geography` (any `office.*.view` or `office.cases.create`) → `{ county, constituencies,
     wards }` for `portalCountyUnitId` (first county when unset). Answers item 3 of the cases web
     agent's section, so walk-in recording works with the portal off.
   - `GET /office/privacy-notice` (`office.cases.create`, `office.cases.view`, `office.appointments.*`)
     → `{ portal: PrivacyNotice, appointment: PrivacyNotice }` built from the tenant configuration.
   - `GET /office/cases/:id/assignable-officers` (`office.cases.manage` **(geo)**) → `UserRef[]` of
     active users holding `office.cases.manage` over the case location (item 2 of the cases web
     agent's section). `POST .../assign` still re-checks.
2. **Acknowledgement queue job.** A portal submission with consented contact queues
   `{ kind: 'office.case.acknowledgement', tenantId, caseId, channel }` on `NOTIFICATION_QUEUE`
   (job name `office.case.acknowledgement`). The job carries ids only; no processor exists yet (admin
   module owns notifications). The processor must read the contact itself, skip erased contacts and
   send no case content beyond the public reference.
3. **Review-date SLA.** When an officer sets no `nextReviewDate`, entering ASSIGNED / IN_PROGRESS /
   REFERRED (or creating a case with an assignee) sets one by priority: URGENT 1 day, HIGH 3, MEDIUM 7,
   LOW 14 (`REVIEW_SLA_DAYS`); a referral's `followUpDate` takes precedence. Make the table a tenant
   setting in `OfficeModuleConfig` if offices need different SLAs.
4. **Rules the contract leaves implicit (implemented; please document).**
   - `assign` is refused (409 `INVALID_TRANSITION`) in SUBMITTED and CLOSED: triage first.
   - Timeline events, evidence, milestones and referral updates do not bump the parent record's
     `version`, so adding a note never invalidates a pending transition.
   - New project evidence starts as `PENDING_VERIFICATION`.
   - Milestone verification is refused (403 `SEPARATION_OF_DUTIES`) for the user who last recorded the
     milestone's status (from the audit stream), mirroring expenditure verification.
   - Turning `contractAmountIsPublic` off while `contractAmount` is a published field is refused (400).
   - `POST /public/:tenantSlug/track` also runs the abuse check (honeypot; captcha when configured),
     because tracking is the endpoint a code-guessing bot would hit. The web form already sends the
     abuse fields from `PublicTrackRequestSchema`.
   - Public `filePath` values are API paths (`/api/public/:slug/projects/:id/evidence/:evidenceId/file`)
     so the web can link them directly.
   - Correspondence `view=unassigned` leaves out FILED and ARCHIVED items; reassigning a FILED or
     ARCHIVED item is refused (409 `IMMUTABLE_RECORD`).
   - Every Office audit snapshot replaces contact values with `hasPhone` / `hasEmail`; appointment
     updates also drop the requester name (`requesterNameChanged: true`); note, minutes, agenda and
     participant text is never copied into audit events.
5. **Shared labels.** `CITIZEN_FEEDBACK_LABELS` (requester-facing text for feedback responses) lives in
   `apps/api/src/modules/office/cases/case-support.ts`; move it to `packages/shared/src/office/enums.ts`
   next to `CitizenFeedbackResponseSchema` so the tracking page can reuse it.
6. **Known gaps (unchanged by this work).** The public rate limiter keeps counters in memory per API
   instance (move to Redis before scaling out); no captcha verifier is bound. (Contact retention:
   done in the review-fix pass, see below.)

## Office: correspondence, appointments and projects UI (from the office web agent)

1. **Run the new web tests in `pnpm test`.** S23, the diary and S26/S27 have their own suites
   (`components/office/{correspondence,appointments,projects}/__tests__`, 43 tests), which the
   `@ngao360/web` `test` script does not pick up. Append to the script (alongside the cases-agent
   proposal): `&& tsx --tsconfig src/components/office/correspondence/__tests__/tsconfig.json --test src/components/office/correspondence/__tests__/*.test.tsx && tsx --tsconfig src/components/office/appointments/__tests__/tsconfig.json --test src/components/office/appointments/__tests__/*.test.tsx && tsx --tsconfig src/components/office/projects/__tests__/tsconfig.json --test src/components/office/projects/__tests__/*.test.tsx`.

2. **Mount the Office overview widget on the dashboard.** `components/office/office-kpis.tsx`
   exports `<OfficeKpis />`: overdue and unassigned correspondence, pending appointment requests,
   cases to triage, and projects reported complete awaiting verification. Each figure is the `total`
   of the scoped list endpoint, shown only to holders of the matching `office.*.view` permission,
   and the widget renders nothing when the `office` module is off. The dashboard owner should add
   `import { OfficeKpis } from '@/components/office/office-kpis';` and render `<OfficeKpis className="mb-6" />`
   near the top of `components/admin/dashboard-view.tsx` (or `app/(app)/dashboard/page.tsx`). Note
   that office roles do not hold `dashboard.view`, so they cannot open S04 today; either grant it to
   the Office administrator or add the widget to an `/office` landing page.

3. **Assignee lookups for correspondence, appointments and projects.** As for cases, the assign
   and tracking-officer pickers offer the caller, anyone already linked, and (for `users.view`
   holders) active users with the relevant Office roles; the API re-checks the assignee. Proposed:
   `GET /office/assignable-users?permission=office.correspondence.view|office.appointments.manage|office.projects.edit`
   returning `UserRef[]` of active users holding that permission (and, for correspondence, filtered to
   `.confidential` holders when `sensitivity` is CONFIDENTIAL+).

4. **Coordinates on `ProjectSummary` and a map.** The register's "By location" view groups projects
   by constituency and ward because `ProjectSummary` has no `latitude`/`longitude` and no map library
   is installed (and no tile host is allowed). Proposed, additively: `latitude`/`longitude` (nullable)
   on `ProjectSummarySchema`; add `leaflet` + `react-leaflet` to `@ngao360/web` with a self-hosted or
   approved tile source (add its host to a future CSP `img-src`). Until then the view is labelled as
   a map placeholder.

5. **Appointment privacy notice text.** The clerk-facing notice is built with
   `appointmentPrivacyNotice()`. The office's controller name, contact and retention come from
   `GET /workspace/modules`, which needs `workspace.view`; clerks do not hold it, so they see the
   organisation name and the default retention (labelled as such). The API only checks the version.
   Proposed: `GET /office/privacy-notices` (any `office.*.view`) returning both
   `portalPrivacyNotice()` and `appointmentPrivacyNotice()` built from the tenant's config (this also
   covers cases item 3).

6. **Correspondence audit history and redaction.** `GET /office/correspondence/:id/history` returns
   redacted before/after snapshots; the S23 history lists changed top-level keys with old → new
   values. If any Office audit snapshot ever carries contact values, the list would show them; the
   contract says snapshots record `hasPhone`/`hasEmail` only, so keep it that way.

7. **Milestone verify action flag.** `ProjectDetail.allowedActions` has no milestone-verification
   flag, so S27 offers "Verify" on DONE milestones to holders of `office.projects.verify` and relies on
   the API's separation-of-duties answer (last status editor cannot verify). Proposed: per-milestone
   `canVerify` (or `verifyBlockedReason`) on `ProjectMilestoneSchema`, computed like
   `verify_evidence`.

## Office: integration status (after the three Office agents)

Applied in the integration pass on `feat/office-governor`:

- **Web tests in `pnpm test`** (cases item 1, office web item 1): `@ngao360/web` now runs every
  `src/components/**/__tests__` suite with one `apps/web/tsconfig.test.json` (113 tests).
- **Contract and shared schemas for the extra endpoints** (Office API item 1): API contract §9a;
  `OfficeGeographySchema`, `OfficePrivacyNoticesSchema`, `AssignableOfficersSchema` and
  `PossibleDuplicateSchema` in `packages/shared/src/office/workspace.ts`; the API uses them.
- **Feedback labels** (Office API item 5): `CITIZEN_FEEDBACK_LABELS` moved to
  `packages/shared/src/office/enums.ts`.
- **Assignee lookup for cases** (cases item 2): the assign dialog reads
  `GET /office/cases/:id/assignable-officers`.
- **Geography and notices without the portal** (cases item 3, office web item 5): cases and projects
  read `GET /office/geography`; walk-in recording and the appointment form read
  `GET /office/privacy-notice`, so clerks see the configured notice without `workspace.view`.
- **Office KPIs on the dashboard** (office web item 2): `<OfficeKpis />` is mounted in the command
  centre; Office staff without `dashboard.view`, and organisations without NGAO TALLY, get an Office
  overview (office KPIs and their screens). The sidebar "Dashboard" link shows for Office view
  permissions. No migration was needed: role permissions are unchanged.

Still open (unchanged): Kiswahili privacy notice (cases item 4), captcha widget and verifier (cases
item 5, Office API item 6), public bundle size (cases item 6), acknowledgement processor (Office API
item 2), review-date SLA as a tenant setting (Office API item 3), Redis-backed public limiter (Office API item 6; the contact-retention job is done), assignee endpoint for correspondence, appointments and
projects (office web item 3), coordinates and a map (office web item 4), per-milestone verify flag
(office web item 7).

## Office review fixes (contract changes, applied)

Applied directly to `docs/API_CONTRACT.md` §9–13 in the review-fix pass (see `docs/STATUS.md`):

1. New permission `office.cases.confidential` (high risk; Office administrator). Restricted cases
   answer 404 without it.
2. New endpoint `POST /office/cases/:id/redact` (`office.cases.close`, re-auth) and the retention
   job; `CaseDetail.redactedAt`; `CaseAction` `redact`; audit action `office.case.redacted`.
3. `CLOSED` is reachable from ASSIGNED, IN_PROGRESS, REFERRED and REOPENED for closure reasons other
   than `RESOLVED` (`caseClosureAllowed`).
4. Projects: `approvalAuthority` required from APPROVED on; `completionEvidenceIds` stored; editing a
   published field withdraws publication; the public evidence file endpoint returns a cleaned photo
   (200) or, for a PDF with a clean scan only, a 302 to a download.
5. Portal privacy notice `office-portal-2026-11-v2`; portal HEIC photos are refused.


## Field: desktop web (S13–S16, incident desk; from the field web agent)

Built against API_CONTRACT §16–21 in `apps/web/src/app/(app)/field/**`, `app/(app)/warroom/page.tsx`
and `apps/web/src/components/field/{common,agents,deployment,readiness,incidents,warroom}/**`. No
shared schema or migration was changed. Requests:

1. **Dashboard mount (admin UI owns the dashboard).** Mount `<FieldDashboardCard />` from
   `@/components/field/field-dashboard-card` in the command centre, below the KPI row. It renders
   nothing unless the `field` module is on and the user holds `field.readiness.view` or
   `field.incidents.view`; it reads `GET /field/readiness/summary` and `GET /field/incidents?view=open`
   only, and links to `/warroom` when the tally module is also on.
2. **Incident assignee lookup.** There is no field endpoint listing who may be assigned. The assign
   and escalate dialogs offer the caller, assignees seen on open incidents and, for `users.view`
   holders only, `/admin/users`. Proposed: `GET /field/incidents/:id/assignable-users`
   (`field.incidents.assign`, geo) returning `UserRef[]` of active users holding
   `field.incidents.triage` over the incident location (mirrors `/office/cases/:id/assignable-officers`).
3. **Agent activity filters.** S13 shows reports and incidents at the agent's (first five) station
   codes because `FieldReportQuery` / `IncidentQuery` have no author filter. Proposed: optional
   `authorUserId` on `FieldReportQuery` and `reporterUserId` on `IncidentQuery` (only for callers with
   the matching view permission), or `GET /field/agents/:id/activity`.
4. **Coverage slots carry no agent id.** `StationCoverageSlot.slots[]` has `agentDisplayName` only, so
   the planner's client-side double-booking precheck matches by name and is a warning; the server's
   409 `details.conflicts` stays authoritative. Proposed: add `agentId` to each slot.
5. **War Room timeline.** There is no event feed; the timeline is built from `lastCheckInAt` /
   `lastFieldReportAt` of the station rows in view and the open-incident queue. Proposed:
   `GET /warroom/timeline?since=` (`warroom.view`, scope by code) returning check-in, field-report,
   incident and station-status events with `WAR_ROOM_LABEL`.
6. **Initial severity in the incident detail.** `IncidentDetail` has `reportedCategory` but no
   `initialSeverity`; the original-report card shows the reported category only and the triage
   change appears in the timeline. Proposed: add `initialSeverity` to `IncidentSummarySchema`.
7. **Election cycle without deployment or readiness view.** Screens learn the field cycle from
   `GET /field/deployments/coverage` or `/field/readiness/summary`, else the latest ACTIVE cycle from
   `/reference/election-cycles`. A tiny `GET /field/cycle` (any field view permission) returning the
   resolved cycle and its `dataProvenance` would remove the guess and give observers the provenance
   label without `reference.view`. Geography filters likewise need `reference.view`
   (War Room observers lack it, so they see their whole scope without filters).

## Field: API (agents, deployment, readiness, reports, incidents, War Room, sync; from the field API agent)

Implemented to §15–22. Additions and interpretations the contract should record:

1. **Bulk assignment (addition).** `POST /field/deployments/bulk` (`field.deployment.plan`), body
   `{ items: CreateDeployment[] }` (1–200), 200 with `{ created, refused, results: [{ index, outcome:
   'CREATED' | 'REFUSED', deploymentId, warnings: DeploymentConflict[], error: { code, message,
   details? } | null }] }`. Each item runs in its own transaction with exactly the checks of
   `POST /field/deployments` (one refusal never rolls back another). The schema lives in
   `apps/api/src/modules/field/field.dto.ts` (`BulkCreateDeploymentSchema`); proposed move to
   `packages/shared/src/field/deployment.ts` as `BulkCreateDeploymentSchema` / `BulkDeploymentResultSchema`.
2. **Coverage conflicts.** `GET /field/deployments/coverage` reports over-coverage (two agents in the
   same CHIEF/STATION role on overlapping shifts at one station) as a non-blocking
   `SLOT_ALREADY_FILLED`; double bookings, inactive agents, unaccredited agents and codes dropped from
   the approved registry as listed in §17. At most 200 conflicts are returned.
3. **Re-authentication for template activation** is checked in the service (`transition` to ACTIVE
   only), because the same route retires templates without it. Same 401 `REAUTH_REQUIRED`.
4. **Incident reassignment.** `POST /field/incidents/:id/assign` also accepts ASSIGNED (reassign; event
   ASSIGNED with `previousAssigneeId`). Moving away from RESOLVED (assign / escalate) clears the
   resolution fields on the row (they stay in events and audit), so the closer check uses the new resolver.
   Evidence is not added to a CLOSED incident (409 `INVALID_TRANSITION`; reopen first).
5. **Reporter-only incident view** hides other people's notes and event data, the assignee, the
   resolution/closure notes and evidence added by others; status, outcome and own entries stay visible.
6. **`field_report.escalated` notification** (module `field`, to `warroom.command` holders in scope):
   §19.2 names the recipients but §15 does not list the type.
7. **War Room derived-status history** is written for the stations a read returns (list page or
   detail), not for all stations on every overview read; the overview counts are still derived for
   every station. Per-station components are cached per tenant + cycle + scope for
   `FIELD_WARROOM_CACHE_SECONDS` (default 15; `asOf` is the computation time; a manual status change
   clears the tenant's cache). `formStatus` is `null` for callers without `tally.view`, while the
   derived status itself uses the tally state.
8. **Set-based queries at 55k stations.** Under RLS the planner estimates a scoped station set at one
   row and picks nested loops (minutes at 55k). War Room and readiness roll-ups run with
   `SET LOCAL enable_nestloop = off` inside their transaction (`withHashJoins`,
   `modules/field/common/field-sql.ts`); `test/warroom.integration.spec.ts` checks overview, station
   list, coverage and readiness summary on a 55,000-station registry (about 1 s together locally).
   A schema follow-up could add `polling_stations (tenant_id, registry_version_id, status)` and run
   `ANALYZE` after registry imports.
9. **Evidence attachment and de-duplication (gap).** Files are content-addressed per tenant; when two
   people upload identical bytes, the second upload returns the first person's file
   (`duplicate: true`) and the "attach only files you uploaded" rule then refuses it. Proposed: an
   upload-claims table (file × uploader) so a duplicate upload grants the uploader attach rights.
   Photos are still stored as uploaded (EXIF not stripped), as §16.4 states.
10. **Sync 5xx items** come back as REJECTED `INTERNAL` without a ledger row, so the device retries
    with the same key; proposed contract wording for this case.

## Field: mobile PWA and offline queue (S11, S17 on `/m`; from the field mobile agent)

Built in `apps/web/src/app/m/**` (home, report, incident, checkin, forms, plus new `queue` and
`submissions`), `apps/web/src/components/mobile/**`, `apps/web/src/lib/offline/**`, `public/sw.js`
and `public/manifest.webmanifest`. Coded to API contract §16.4, §17, §19, §20 and §22; no contract
change is needed. Requests for files owned by others:

1. **`next.config.mjs` Permissions-Policy blocks geolocation** (`geolocation=()`). Check-in location
   (when `checkInLocationEnabled`) and the optional incident location cannot work until it is
   `geolocation=(self)`. The mobile screens detect the policy and hide the location buttons meanwhile.
2. **Sign-out outside `/m` does not clear the offline queue.** The field app warns about unsent items
   and deletes the queue and its key on sign-out; the desktop menu (`lib/auth-context.tsx` `logout`)
   should call `clearOfflineDataForSignOut()` from `@/lib/offline/device` (ideally after the same
   warning: `unsentCount()` from `@/lib/offline/queue`). Until then a desktop sign-out leaves the last
   field user's encrypted queue on the device, and `/m` opened offline can show its item summaries.
3. **Unused files:** `components/field/mobile/mobile-shell.tsx` and `mobile-placeholder.tsx` are no
   longer used (the `/m` layout uses `components/mobile/mobile-shell.tsx`, which still reuses
   `components/field/mobile/mobile-nav.ts` and its test). They can be deleted by their owner.
4. **Bottom navigation:** the queue and "My submissions" are reached from the header chip and the menu;
   adding a "Queue" item to `MOBILE_NAV` is optional.
5. **Manifest (shared):** added `shortcuts` (Field app, Report an incident, Upload queue) only;
   `start_url` stays `/dashboard` (agents are redirected to `/m`).
6. **Tally upload deep link:** `/m/forms` links to `/tally/inbox?upload=1` (as the dashboard does). If
   the inbox ignores `upload=1`, opening the upload dialog from that parameter would save a tap.

Known gaps (documented, not blocking):

- Queue encryption uses a per-user, per-tenant non-extractable AES-GCM key in IndexedDB (fresh IV per
  record, entry-bound AAD). It protects only against other origins and casual inspection of the stored
  records: the browser serialises the key material into the profile's IndexedDB files beside the
  ciphertext (so a copied profile is readable), and anyone opening `/m` on the phone sees queued items.
  A PIN-wrapped key (PBKDF2 / Argon2) asked for before the queue opens offline is the priority next step.
- No upload with every tab closed: the service worker relays Background Sync to open tabs only.
- No separate unsaved "draft" state: a saved form goes straight into the encrypted queue (it can be
  removed from the queue before it uploads).
- Server-side EXIF stripping is still open (§16.4 gap); the phone now re-encodes photos (EXIF/GPS
  removed, long edge 1600 px) before queueing, so PWA uploads no longer carry it.

## Field: integration status (after the three field agents)

Applied in the integration pass (contract updated in `docs/API_CONTRACT.md` §7, §17, §19.2, §20):

| Request | Status |
| --- | --- |
| Web 1: mount `<FieldDashboardCard />` on the dashboard | **Applied.** Below the KPI row of the command centre; it also shows "Stations reporting (War Room)" (reported of expected, missing named as "no update yet (not zero)") with the unofficial / internal label for `warroom.view` holders when field and tally are on. The dashboard's `agent_coverage` KPI is now AVAILABLE with the field module and `field.deployment.view`. |
| Web 2: incident assignee lookup | **Applied.** `GET /field/incidents/:id/assignable-users` (`field.incidents.assign`, geo) → `UserRef[]` of active users holding `field.incidents.triage` over the location; the assign and escalate dialogs use it (open-incident assignees remain the fallback for callers without assign). The `/admin/users` fallback was removed. |
| Web 3: agent activity filters | Open. Still by station code. |
| Web 4: `agentId` on coverage slots | **Applied.** The planner's double-booking precheck matches by agent id and is blocking, like the server. |
| Web 5: War Room timeline feed | Open. |
| Web 6: `initialSeverity` on incidents | **Applied.** On `IncidentSummarySchema`; shown on the original-report card. |
| Web 7: `GET /field/cycle` | Open. |
| API 1: bulk-deployment schemas in shared | **Applied.** `BulkCreateDeploymentSchema` / `BulkDeploymentResultSchema` in `packages/shared/src/field/deployment.ts`; endpoint in the contract (§17). |
| API 2–7, 10: interpretations | Recorded in the contract where they change behaviour (coverage over-coverage, reassignment). |
| API 8: registry index | **Applied.** Migration `20261123000000_field_integration`: `polling_stations (tenant_id, registry_version_id, status)` plus `ANALYZE`. The hash-join workaround stays. |
| API 9: evidence upload claims | Done in the review pass (`field_file_claims`, migration `20261124000000_field_review_fixes`). |
| Mobile 1: `geolocation=(self)` | **Applied** in `next.config.mjs`. |
| Mobile 2: desktop sign-out clears the queue | **Applied.** `auth-context` `logout` calls `clearOfflineDataForSignOut()`; the top-bar sign-out first counts unsent items of the last field user on the device (`unsentCountForLastSession()`, states only, no decryption) and asks for confirmation. |
| Mobile 3: unused placeholders | **Applied.** `components/field/mobile/mobile-shell.tsx` and `mobile-placeholder.tsx` deleted. |
| Mobile 4–6 | Not applied (optional). |

Found and fixed during integration (not requested):

- **Agents could report outside their deployment.** Report and incident intake checked only the grant scope, so an agent with a ward grant could report for any station in the ward. A caller linked to an agent record now reports only at stations where they hold an ASSIGNED / CONFIRMED / CHECKED_IN / CHECKED_OUT deployment in the cycle (403 `OUT_OF_SCOPE`, also through sync). Callers without an agent record keep scope-only rules.
- **False offline conflicts in the seeded demo.** The seed wrote AGT / FRP / INC references without moving `reference_sequences`, so the first API-created incident hit a unique violation on the reference, which the services reported as `IDEMPOTENCY_KEY_REUSED` ("already sent with different content"); the phone then asked the agent to decide on a conflict that did not exist. The seed now moves the counters past seeded references (on every run), and only a violation of the client idempotency key index maps to `IDEMPOTENCY_KEY_REUSED`; other violations are server errors (sync: REJECTED `INTERNAL`, retried with the same key).

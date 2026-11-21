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

## Campaign: organisation, tasks, events and communications UI (from the campaign web agent)

Screens: `/org` (S05), `/tasks` and `/tasks/[id]` (S08), `/events` and `/events/[id]` (S09), `/comms` and `/comms/[id]`.
Components live in `apps/web/src/components/{org,tasks,events,comms}` (this run's file assignment). `docs/ARCHITECTURE.md`
§Campaign lists `components/campaign/{org,tasks,events}` and gives comms web to agent B, so the table needs updating.

1. **Campaign geography lookup.** No campaign endpoint lists geographic units, and campaign roles do not hold
   `reference.view` (whose `GET /reference/geographic-units` also needs an election cycle). So the task, team and event
   forms cannot set `geographicUnitId`, and the "Area" filter on the task board only offers areas already seen on loaded
   tasks. Proposed: `GET /org/geography` (any `org.*.view`, `tasks.view`, `events.view` or `comms.content.view`) that
   returns the units inside the caller's grant (county → constituency → ward, `GeoRef[]` with `parentId`). The web
   will then add a cascading picker.
2. **Attendance list shape.** §25 says `GET /events/:id/attendance` answers "`Paginated<EventAttendance>` +
   `AttendanceSummary`", but there is no shared schema for the combination. The web reads
   `Paginated<EventAttendance> & { summary?: AttendanceSummary }`. Proposed: export
   `EventAttendancePageSchema = PaginatedSchema(EventAttendanceSchema).extend({ summary: AttendanceSummarySchema })`
   from `packages/shared/src/campaign/events.ts` and name it in the contract.
3. **Attendance consent notice version.** The check-in form sends `consentNoticeVersion: 'event-attendance-v1'` (a
   web constant). Proposed: a versioned attendance notice text the tenant manages (as with the Office privacy notices),
   or `CampaignModuleConfig.events.attendanceNoticeVersion` plus notice text, returned with the event detail so the
   form can show the text being read to the person.
4. **Task list sort keys.** `TaskQuery.sort` is a free string and §24 names no sort keys, so the list view sorts each
   page in the browser. Proposed: document accepted keys for `GET /tasks` (`dueAt`, `priority`, `updatedAt`,
   `reference`), answering 400 for others.
5. **People picker for viewers.** `GET /org/assignable-users` needs a create / assign / manage permission, so a viewer
   with only `tasks.view` sees just themselves in the task board "Assignee" filter. Proposed: also allow `tasks.view` and
   `events.view` (display names only, as today).

## Campaign: API (organisation, tasks, events, comms, finance, reports, notification centre, breach register; from the campaign API agent)

All endpoints of §23–30 are implemented in `apps/api/src/modules/campaign/**` with integration suites
(`apps/api/test/campaign-operations`, `finance-ledger`, `reports-builder`, `notifications-centre`). Requests that need
files outside the campaign API folder:

1. **Extended `GET /notifications` (§7 / §29) — admin files.** `NotificationCenterService.list(auth, NotificationCenterQuery)`
   returns `Paginated<NotificationCenterItem>` (severity, `requiresAck`, `acknowledgedAt`, `entityType`, `entityId`;
   filters `module`, `severity`, `awaitingAck`; in-app rows only). The route itself lives in
   `modules/admin/dashboard.controller.ts` and `modules/admin/notifications.service.ts`, which this agent did not edit.
   Proposed: the dashboard controller's `GET /notifications` takes `NotificationCenterQueryDto` (from `campaign.dto.ts`)
   and returns the extended item (either delegate to `NotificationCenterService.list` by importing
   `NotificationCenterModule`, or add the five fields and three filters to the admin service), and `baseWhere` adds
   `channel: 'IN_APP'` so rows a user only wanted on an external channel are not listed in-app (the counts endpoint
   already filters this way).
2. **Address verification, SMS consent and push subscriptions (schema).** The `users` table has no e-mail verification
   flag, SMS consent record or push subscription table, so `NotificationPreferences.emailVerified` / `smsConsent` are
   always false and every external attempt is recorded as SKIPPED (the log provider sends nothing either way).
   Proposed: `users.email_verified_at`, a consent table for SMS (purpose, notice version, time) and
   `notification_push_subscriptions`; `NotificationCenterService.resolveAddress` is the single place to wire them.
3. **Inline request shapes → shared schemas.** `{ reason }`, `{ expectedVersion }`, `{ expectedVersion, reason }`,
   `{ format: 'CSV' | 'PDF', reason }` (attendance export), the budget-line query, the contribution-source query
   (`electionCycleId`, `from`, `to`) and `SaveFinanceAccount & { expectedVersion }` are defined locally in
   `campaign.dto.ts`. Proposed: move them to `packages/shared/src/campaign` and name them in the contract.
4. **Dependency override flag.** The task description asks for "cannot complete while a dependency is open unless
   overridden with reason"; `ChangeTaskStatusSchema` has no override flag. Implemented: a holder of `tasks.manage_all`
   who gives a `reason` (≥ 3 characters) may move a task to IN_PROGRESS / SUBMITTED_FOR_REVIEW / COMPLETED with open
   dependencies; the timeline note starts with "Dependency override:" and the audit entry carries
   `dependencyOverride: true`. Proposed: an explicit `overrideOpenDependencies: boolean` in the schema.
5. **Workflow reviewers and department scope.** The seeded Communications approver, Finance approver and the
   after-action reviewers hold no `org.departments.all`; under `DEPARTMENT_SCOPE_RULE` they see content / events only in
   their own departments or once involved, so `awaiting_me` is empty for an approver outside the author's department.
   Proposed (roles, shared): give `COMMUNICATIONS_APPROVER` and `CAMPAIGN_MANAGER` `org.departments.all`, or extend the
   rule so the holders of the next workflow permission count as involved for items at that step.
6. **Attendance list shape.** Implemented as both the flat merge (contract wording "Paginated + AttendanceSummary") and a
   `summary` object (what the web reads); see the web agent's request 2 for a shared schema.
7. **Task sort keys.** `GET /tasks` accepts `sort` = `dueAt`, `priority`, `reference`, otherwise `updatedAt`
   (answers 200 with the default for other keys today). Matches the web agent's request 4 once documented.
8. **`task.due_soon` notifications** need a scheduled job (BullMQ repeatable); not implemented.
9. **Report preview narrowing on organisation datasets.** `geographicUnitId` on a dataset without a geography column
   (finance, audit, breaches) answers 400; `departmentId` narrows finance datasets by the entry's department.
10. **Finance "committed".** §27.4 says committed = REQUESTED / APPROVED-not-paid, while `BudgetLineSchema` and the
    dataset label say "requested but not yet approved". Implemented: committed = REQUESTED expense entries; actual =
    APPROVED + PAID expense entries (reversed originals and reversing entries both drop out, so reversals net to zero).

## Campaign: finance, reports, notification centre and breach register UI (from the campaign web agent, B/C screens)

Screens: `/finance` (S10 ledger, contribution register, budget vs actual), `/finance/transactions/[id]`,
`/finance/settings` (limit settings), `/reports` and `/reports/[id]` (S28 builder, standard catalogue, templates, export
log), `/notifications` (centre, preferences, delivery log), `/security/breaches` and the new `/security/breaches/[id]`.
Components live in `apps/web/src/components/{finance,reports,notifications,security}` (this run's file assignment;
`docs/ARCHITECTURE.md` §1 lists `components/campaign/{finance,reports,notifications,security}`, so the table needs
updating, as for the org/tasks/events/comms screens).

1. **Mount the notification bell (app shell).** `components/notifications/notification-bell.tsx` exports
   `NotificationBell` (unread badge, a critical marker while alerts await acknowledgement, a panel of the latest eight
   with safe in-app deep links, polling `GET /notifications/counts` every minute while the tab is visible). In
   `components/layout/topbar.tsx` replace the static `<button … aria-label="Notifications"><Bell …/></button>` with
   `<NotificationBell />` (`import { NotificationBell } from '@/components/notifications/notification-bell'`). No other
   shell change is needed.
2. **Breach evidence URL in the contract.** The web opens timeline evidence with
   `GET /security/breaches/:id/events/:eventId/evidence/url` (implemented in `breaches.controller.ts`), which §30 does
   not list. Proposed: add the row (`security.breach.view`, `SignedUrlResponse`, audit `FILE_SOURCE_ACCESSED`).
3. **Why an action is unavailable (finance).** `FinanceTransactionDetail.allowedActions` says *whether*, not *why*. The
   web explains requester / approver segregation itself; for "approver cannot pay" it assumes
   `finance.approverCannotPay` is on because the web cannot read `CampaignModuleConfig` (needs `workspace.view`).
   Proposed: `FinanceLedgerSummary.segregation: { approverCannotPay: boolean }` or
   `FinanceTransactionDetail.unavailableActions: { action, reason: 'REQUESTER' | 'APPROVER_CANNOT_PAY' | 'STATUS' | 'PERMISSION' | 'BLOCKERS' }[]`.
4. **Currency on contribution totals.** `ContributionSource.totalContributedMinor` has no currency; the register shows
   it in the ledger summary currency. Proposed: `totalContributed: MoneyMinor`.
5. **Finance export answer.** `POST /finance/exports` returns only `SignedUrlResponse`, so the dialog states the
   classification client-side (CONFIDENTIAL; HIGHLY_RESTRICTED hint for the contribution register) and cannot show the
   row count. Proposed: return `ReportExport & SignedUrlResponse` like `POST /reports/exports`.
6. **Shared shapes for report listings.** `GET /reports/datasets` (`{ key, label, description, group, fields }[]`) and
   `GET /reports/standard` (`StandardReport & { runnable }`) have no shared schema; the web defines `AvailableDataset`
   and `RunnableStandardReport` in `components/reports/reports-api.ts`. Proposed: export
   `AvailableDatasetSchema` / `RunnableStandardReportSchema` from `packages/shared/src/campaign/reports`.
7. **Scope options for the report builder and limit settings.** Area narrowing uses `/reference/geographic-units`
   (needs `reference.view` and a cycle) and department narrowing uses `/org/departments/tree` (needs
   `org.departments.view` and the campaign module); election cycles come from `/reference/election-cycles`. Finance
   and report users often hold none of these, so the pickers fall back to "your scope is applied automatically" and
   limit settings to "every election cycle". Proposed: `GET /reports/scope-options` (any `reports.*`) returning the
   cycles, units (county → constituency → ward) and departments inside the caller's grant, reusable by
   `/finance/settings` (see also the campaign web agent's request 1, `GET /org/geography`). Area narrowing is hidden for
   organisation-level datasets, which answer 400 (API request 9).
8. **Notification module filter.** The centre's "Area" filter is a fixed list of permission modules. Proposed:
   `NotificationCounts.byModule: Record<string, { unread, awaitingAck }>` so the filter lists only modules with items.
9. **Not built in this run (UI).** Budget-line create / approve / close (§27.4), account, category, payee and
   contribution-source management (§27.2–27.3) and the per-entry "edit counterparty" pickers beyond the first 200
   payees / sources (`pageSize` 200 lists; a search-as-you-type picker is proposed). The ledger, detail, settings,
   register and budget views read these records.
10. **Ledger period by election cycle.** `FinanceLedgerQuery.electionCycleId` is not offered (no cycle list for
    finance users, request 7); the ledger summary uses the from / to dates of the filter bar.

## Campaign: integration status (after the three campaign agents)

Applied in the integration pass (contract updated in `docs/API_CONTRACT.md` §1, §7, §23–30):

| Request | Status |
| --- | --- |
| API 1: extended `GET /notifications` | **Applied.** The admin `DashboardController` takes `NotificationCenterQueryDto` and delegates to `NotificationCenterService.list` (`AdminModule` imports `NotificationCenterModule`): severity, `requiresAck`, `acknowledgedAt`, `entityType`, `entityId`; filters `module`, `severity`, `awaitingAck`; in-app rows only. Mark-read and mark-all-read also ignore external-channel rows. The admin service's old list method is removed. |
| API 2: e-mail verification, SMS consent, push subscriptions | **Open.** Needs a verification flow and a consent notice, not only columns; every external delivery stays SKIPPED through the log provider. `NotificationCenterService.resolveAddress` remains the single place to wire them. |
| API 3: inline request shapes | **Applied.** `packages/shared/src/campaign/requests.ts`: `ReasonBody`, `ExpectedVersionBody`, `VersionReasonBody`, `AttendanceExport`, `BudgetLineQuery`, `ContributionSourceQuery`, `UpdateFinanceAccount`, `AttachmentParam`, `DocumentParam`; `campaign.dto.ts` builds its DTO classes from them. |
| API 4: dependency override flag | **Applied.** `ChangeTaskStatus.overrideOpenDependencies` (needs a reason, 400 otherwise; only `tasks.manage_all`, 403 otherwise). A reason alone no longer overrides. The web status dialog offers the override to task managers when dependencies are open. |
| API 5: reviewers and department scope | **Applied for communications.** `COMMUNICATIONS_APPROVER` holds `org.departments.all`, so "awaiting me" lists content from every department. Finance is organisation-level (no department scope); after-action approval stays with the campaign manager (`org.departments.all`) and department leads (own departments). |
| API 6 / Web 2: attendance page shape | **Applied.** `EventAttendancePageSchema` (`Paginated<EventAttendance>` with `summary`); the flat merge stays for older clients. |
| API 7 / Web 4: task sort keys | **Applied.** `TaskQuery.sort` is `dueAt` / `priority` / `reference` / `updatedAt` (400 for others). The list view may now sort server-side. |
| API 8: `task.due_soon` job | **Open.** Needs a BullMQ repeatable job. |
| API 9: report narrowing on organisation datasets | Recorded (400 for `geographicUnitId` on datasets without a geography column). |
| API 10: finance "committed" | **Applied (contract).** §27.4 now matches the implementation and the shared schema: committed = REQUESTED expense entries; actual = APPROVED + PAID, reversals netting to zero. |
| Web 1 / B/C 7: geography and scope options lookup | **Open.** `GET /org/geography` / `GET /reports/scope-options` (units, cycles and departments inside the caller's grant) is not built; pickers keep the "your scope applies automatically" fallback. |
| Web 3: attendance notice version | **Open.** Still the web constant `event-attendance-v1`. |
| Web 5: people picker for viewers | **Applied.** `GET /org/assignable-users` also accepts `tasks.view` and `events.view` (display names only). |
| B/C 1: mount the notification bell | **Applied.** `components/layout/topbar.tsx` renders `<NotificationBell />`. |
| B/C 2: breach evidence URL | **Applied (contract).** Row added to §30. |
| B/C 3: why a finance action is unavailable | **Open.** The web still assumes `approverCannotPay` is on when an approver is refused payment. |
| B/C 4: currency on contribution totals | **Open.** |
| B/C 5: finance export answer with the export record | **Open.** `POST /finance/exports` still returns `SignedUrlResponse` only. |
| B/C 6: shared schemas for report listings | **Open.** |
| B/C 8: notification counts by module | **Open.** |
| B/C 9, 10: finance management screens, ledger by cycle | **Open (UI).** |
| (integration) dashboard campaign / finance KPIs | **Done.** `components/campaign/campaign-kpis.tsx` on `/dashboard`: my open tasks, overdue, to review, events in the next 14 days, content awaiting me, alerts to acknowledge; finance tiles (awaiting approval, approved not paid, limit findings, expenses posted in KES) only with `finance.view`, which operations roles never hold. Unit-tested per system role. |
| ARCHITECTURE component paths | **Applied.** §1 now lists `components/{org,tasks,events,comms,finance,reports,notifications,security}`. |

Found and fixed during integration (not requested):

- **Query flags read "false" as true.** Every `z.coerce.boolean()` query flag (`unreadOnly`, `flagged`, `mine`, `includeDrills`, `includeInactive`, `includeSuperseded`, field and tally flags) turned the string `"false"` into `true`, so for example `GET /security/breaches?includeDrills=false` still listed drills. They now use `QueryBooleanSchema` (`true`/`1`, `false`/`0`, anything else 400).
- **Implicit dependency override.** A task manager who typed a note while moving a blocked task overrode its open dependencies without asking; the web dialog said the move would be refused. The override is now explicit (API 4).

## Pilot hardening: auth-recovery (passkeys, recovery codes, assisted account recovery)

Built in `apps/api/src/auth/{passkeys,recovery}` and the web `components/auth/**`, `/settings/account`, `/login`,
`/recover` (API contract §32). Requests to other owners:

| # | To | Request | Status |
| --- | --- | --- | --- |
| AR1 | platform-infra | Bind `MESSAGE_OUTBOX`. `SecurityAlertsService` injects it `@Optional()`: until it is bound, security alerts are skipped (id-only log) and an approval of account recovery with e-mail configured answers **503** (fail closed, the link is never shown). | Done (platform-infra) |
| AR2 | platform-infra | Templates. `auth.recovery_link`: `payload { tenantSlug, expiresAt }`, `secretPayload { token, recoverPath }` where `recoverPath` = `/recover#tenant=<slug>&token=<token>` (prefix `WEB_ORIGIN`); sent with `addressOverride` = the account e-mail (the address the invitation proved), idempotency `account-recovery:<requestId>`. `auth.security_alert`: `payload { event, at }`, `event` ∈ `passkey_registered`, `passkey_revoked`, `passkey_counter_regression`, `recovery_codes_generated`, `recovery_code_used`, `account_recovery_requested`, `account_recovery_completed`; idempotency `security-alert:<event>:<entityId>`. Please accept `addressOverride` for `auth.recovery_link`. | Done (platform-infra) |
| AR3 | shared (`packages/shared/src/platform/auth-recovery.ts`) | Move the request schemas kept locally in `apps/api/src/auth/passkeys/passkeys.dto.ts` into shared: `PasskeyMfaOptions { challengeToken }`, `PasskeyMfaVerify { challengeToken, challengeId, response }`, `PasskeyReauthVerify { challengeId, response }`. | Done (integration) |
| AR4 | shared (`schemas/auth.ts`) | Optional `methods: ('totp' \| 'passkey' \| 'recovery_code')[]` on the `MFA_REQUIRED` login response so the sign-in screen can show only what the account has. Today the MFA step always offers TOTP, "use a passkey" (when the browser supports it) and "use a recovery code". | Open |
| AR5 | admin (`modules/admin/users.service.ts`) | `POST /admin/users/:id/reset-mfa` must also revoke the user's passkeys (`revokedReason: 'admin_reset'`, `revokedById` = admin) and unused recovery codes, and add the counts to the `USER_MFA_RESET` audit (contract §32.1). Not done here: the file is outside this agent's assignment for this pass. Until then an admin MFA reset leaves passkeys working. | Done (integration) |
| AR6 | admin + shared (`users.service.ts`, `admin.controller.ts`, `schemas/admin.ts`, `invite-user-dialog.tsx`, `user-drawer.tsx`) | Invitation delivery §32.4: once `isDeliveryConfigured('EMAIL')`, enqueue `auth.invitation` (token only in `secretPayload`, idempotency `invitation:<userId>:<first 16 of tokenHash>`) and return `{ expiresAt, delivery: 'OUTBOX', messageId }` with no token or `acceptPath`; otherwise add `delivery: 'SHOWN_ONCE'`. Not done here for the same reason as AR5. | Done (platform-infra) |
| AR7 | admin web (`components/admin/reauth.tsx`) | Offer "Confirm with a passkey" (`POST /auth/passkeys/reauth/options` + `/verify`), as `components/auth/account-reauth.tsx` does, so a person without TOTP can confirm high-risk admin actions with a passkey. | Open |
| AR8 | admin web (new `components/admin/account-recovery-*`) | Screens for `/admin/account-recovery*`: list (status filter), request (user, identity-check note, reason; reauth), approve / reject / cancel with reason; show `devRecoveryPath` once (non-production, no channel) and otherwise "Recovery link sent to the account e-mail". The in-app notice links to `/admin/users?recovery=<id>`. The API is complete and tested. | Open (UI) |
| AR9 | platform-infra (web) | `/settings/account` composes `PasskeysPanel` and `RecoveryCodesPanel` inside `AccountReauthProvider`. Add the contact and push panels (`components/account/contact-*`, `push-*`) to the same `space-y-6` column in `app/(app)/settings/account/page.tsx`; that one-line addition is welcome. | Open |
| AR10 | platform-infra | `RATE_LIMIT_STORE` account-level limits on `/auth/passkey/login/*`, `/auth/mfa/passkey/*`, `/auth/mfa/recovery`, `/auth/account-recovery/complete` (today: the per-IP auth throttle plus the shared MFA lockout; recovery tokens are 256-bit). | Done (platform-infra) |

## Pilot hardening: platform-infra (delivery, jobs, scanning, captcha, shared rate limits)

Built in `apps/api/src/platform/**`, `storage/**`, `queue/**`, `campaign/notifications/providers/**`, the moved
timers / limiters and `docker-compose.yml` (API contract §31, §34; migrations `20261129000000`–`20261129000200`).
Answers to earlier requests and requests to other owners:

| # | To | Request | Status |
| --- | --- | --- | --- |
| AR1 | (from auth-recovery) | `MESSAGE_OUTBOX` is bound in `PlatformModule` (`MessageOutboxService`, exported, global). | **Done** |
| AR2 | (from auth-recovery) | `auth.recovery_link` renders `secretPayload.recoverPath` when it is a same-origin path starting `/recover` (else `/recover#token=…`); `addressOverride` is accepted for it. `auth.security_alert` renders the listed `event` keys as sentences and uses `payload.at`. Both e-mail only for secrets; the alert also goes by SMS / push where the user has a deliverable contact. | **Done** |
| AR6 | (from auth-recovery) | Invitation delivery §32.4 implemented: `UsersService` enqueues `auth.invitation` (token only in the sealed secret payload, idempotency `invitation:<userId>:<first 16 of tokenHash>`) when `isDeliveryConfigured('EMAIL')` and returns `{ expiresAt, delivery: 'OUTBOX', messageId }` with no token or `acceptPath` (any `NODE_ENV`); otherwise the link as before plus `delivery: 'SHOWN_ONCE'`. An invited address the outbox refuses answers 409 instead of falling back to the link. `UserDetailSchema.invitation` fields made optional (additive). `invite-user-dialog.tsx` and `user-drawer.tsx` show "Invitation sent to …" for OUTBOX. Test: `test/platform-delivery.integration.spec.ts`. | **Done** |
| AR10 | (from auth-recovery) | `AccountRateLimitGuard` (global, `RATE_LIMIT_STORE`) limits every public `POST /auth/*` except logout per client IP (`AUTH_RATE_LIMIT_MAX` / minute) and per hashed identity in the body: organisation + e-mail, `challengeToken`, one-time `token` (`AUTH_RATE_LIMIT_MAX` / 15 minutes), across API instances with Redis. Store down → 503. | **Done** |
| AR9 | platform-infra (web) | Contact verification, SMS consent and push panels (`components/account/contact-*`, `push-*`) and the `public/sw.js` push handler are not built yet; the API (`/me/contacts*`, `/me/push*`) is complete and tested. | Open (UI) |
| PI1 | app (`apps/api/src/app.module.ts`) | Plug the shared store into the global throttler: `ThrottlerModule.forRootAsync({ inject: [AppConfig, RATE_LIMIT_STORE], useFactory: (c, store) => ({ throttlers: [{ ttl: c.values.RATE_LIMIT_TTL_SECONDS * 1000, limit: c.values.RATE_LIMIT_MAX }], storage: new RateLimitThrottlerStorage(store) }) })` (`RateLimitThrottlerStorage` exported from `platform/ratelimit`, tested). Until then the global per-IP throttle and the `@Throttle` limits on `/auth/*` count per API instance; the auth and portal limits that matter across instances already use the shared store (`AccountRateLimitGuard`, `PublicRateLimitGuard`). This edit was not permitted to this agent. | Done (integration) |
| PI2 | shared (`schemas/admin.ts` `AUDIT_ACTIONS`) | Reserve `STAGE_COMPARISON_COMPLETED: 'tally.stage_comparison.completed'` and `STAGE_COMPARISON_FAILED: 'tally.stage_comparison.failed'` (used today as string constants in `modules/tally/services/stage-comparison.service.ts`; the retry job reads them from the audit stream). | Done (integration) |
| PI3 | shared (`campaign` `financeApprovalBlockers`) | A distinct blocker `SUPPORTING_DOCUMENT_NOT_CLEAN` when documents are attached but none has a CLEAN scan. Today `documentCount` counts CLEAN documents only, so a PENDING document shows as `SUPPORTING_DOCUMENT_MISSING` (the DB guard says "needs a supporting document with a clean malware scan"). | Done (integration) |
| PI4 | office (`public/public-portal.service.ts`) | When the tenant chose a captcha provider but left `captchaSiteKey` empty, return the deployment key (`CaptchaVerifierRegistry.get(provider)?.siteKey()`) in `GET /public/:slug` so the widget can render. Today the widget needs the site key in the office module config. | Done (integration) |
| PI5 | workspace-admin (§33.3 integrations) | `available` for the scanner can use `FileScanService.scannerConfigured` plus `ClamdMalwareScanner.ping()`; captcha `available` = `CaptchaVerifierRegistry.get(provider) !== null`; `lastRun` from `GET /platform/jobs` (`office.retention`). | Done (workspace-admin) |
| PI6 | field-pin | Server-side EXIF stripping is done in storage: every `FIELD_EVIDENCE` image is re-encoded without metadata by `StorageService.storeImmutable` (HEIC refused with a 400 asking for JPEG / PNG / WebP), whoever calls it; `StoreFileInput.stripImageMetadata` opts other purposes in. The comment "gap: EXIF is not stripped yet" in `modules/field/common/field-support.ts` is stale. | Done (integration: comment fixed) |
| PI7 | office (`cases/case-portal.service.ts`) | Optional: enqueue the acknowledgement with `CaseAcknowledgementService`-style `MessageOutboxService.enqueueCitizenInTx` inside the submission transaction instead of the `notifications` BullMQ queue (the queue is processed by `NotificationQueueProcessor` now; with `QUEUES_ENABLED=false` no acknowledgement is queued at all). | Done (integration) |
| PI8 | tally (governor rehearsal) | Add a step that makes the inline cross-stage comparison fail once (e.g. a forced error) and checks that `tally.comparison_retry` opens the case; today the retry job is tested for its candidate query and tenant gating only (`test/platform-files-jobs.integration.spec.ts`). | Open (test) |

Applied in files outside `platform/**` as part of this assignment (moved timers / limiters and CLEAN enforcement):
`office/cases/case-retention.service.ts` and `field/warroom/station-status-recorder.service.ts` (timers → `JobScheduler`),
`office/public/public-rate-limit.ts` (→ `RATE_LIMIT_STORE`, IPs hashed), `tally/services/stage-comparison.service.ts`
(`compareInTenant`, completion audit), `campaign/notifications/notification-center.service.ts` (external channels →
outbox, preferences show verified e-mail / SMS consent), `campaign/finance/finance.service.ts` (CLEAN documents only),
`office/projects/project-support.ts` + `projects.service.ts` (public evidence needs CLEAN, 409 `FILE_NOT_CLEAN`), and the
test fixtures that now record a clean scan before approval / publication.

## Pilot hardening: workspace-admin (S02 workspace setup, S03 onboarding, S30 settings, finance master data, display-holds UI)

Built in `apps/api/src/modules/workspace/**` (API contract §33, as built; migration `20261129200000`), web `/setup`,
`/onboarding`, `/settings`, `/settings/finance`, `/tally/sources/holds` (`components/workspace/**`, `components/settings/**`,
`components/holds/**`). Answers and requests to other owners:

| # | To | Request | Status |
| --- | --- | --- | --- |
| PI5 | (from platform-infra) | Integration `available` uses `isDeliveryConfigured(channel)`, `CaptchaVerifierRegistry.get(provider)` and, for the scanner, `MALWARE_SCANNER.isConfigured()` plus the last platform `files.scan_pending` run not FAILED (no live `ping()` on a GET, so the settings page never waits on clamd). Job status on S30 reads `GET /platform/jobs`. | **Done** |
| WA1 | auth (`auth/auth.service.ts`, `token.service.ts`) | Apply the tenant security policy at sign-in (S30): in `isMfaRequired` also require MFA when `readSecurityPolicy(tx, tenantId).mfaPolicy === 'ALL_USERS'`; in `createSession` / `refresh` cap the session with `effectiveSignInPolicy(policy, JWT_REFRESH_TTL_SECONDS).refreshTtlSeconds`; an idle timeout needs a `last_seen_at` on `sessions` (not in the schema). Helpers are in `apps/api/src/modules/workspace/workspace-settings.ts` (pure, tested); then set `SIGN_IN_ENFORCES_TENANT_POLICY = true` in `workspace-settings.service.ts` (the S30 screen and `GET /workspace/security` say "recorded, not yet applied" until then). The policy can only tighten the server limits. | Done (integration) |
| WA2 | field-pin (`tally/controllers/display-holds.controller.ts`, `display-holds.service.ts`) | Implement the §35 routes; the screen at `/tally/sources/holds` (`components/holds/**`) is built against §35 exactly: `GET /tally/sources/holds?state&page&pageSize` → `Paginated<DisplayHoldSummary>`, `GET /:holdId`, `GET /:holdId/redacted/url` → `SignedUrlResponse`, `POST /:holdId/redacted-copy` multipart `file` + optional `reason` → `DisplayHoldSummary`, `POST /:holdId/confirm` `{ reason }` (≥ 10 characters, the service minimum) → `DisplayHoldSummary`; re-auth through the tally layout's prompt. The service is keyed by submission id today (`attachRedactedCopy(auth, submissionId, …)`), so the controller resolves the hold's submission from `stored_file_id`. The UI hides release actions for the hold's `createdBy` (hint only; the service refuses uploader and declarer). Until the routes exist the page shows the API error. `pnpm demo:redact-34a` must keep working. | Done (integration) |
| WA3 | web shared (`lib/nav.ts`) | Add `{ label: 'Workspace setup', href: '/setup', icon: Building2, anyOf: ['platform.tenants.manage', 'workspace.configure'] }` and, in the Campaign group, `{ label: 'Finance master data', href: '/settings/finance', icon: Banknote, anyOf: ['finance.view'], module: 'finance' }`. Both pages are reachable from `/settings` and `/onboarding` today. | Done (integration) |
| WA4 | platform-infra (`messaging/message-templates.ts`) | `auth.invitation` from `POST /platform/workspaces` carries `payload.tenantSlug`: put it in the link (`/accept-invitation#tenant=<slug>&token=…`) or the body so a first administrator of a brand-new organisation does not have to be told the organisation code separately (the accept form asks for it). | Done (integration) |
| WA5 | tenant-modules (`tenant-modules.service.ts`) | Optional: a `setOfficeConfig(tx, patch)` method. `PUT /workspace/retention` (Office periods) and `PUT /workspace/integrations/captcha` (captcha mirror) write `tenant_modules.config` for `office` directly in their own transaction (audited as `WORKSPACE_RETENTION_UPDATED` / `WORKSPACE_INTEGRATION_UPDATED`, not `MODULE_UPDATED`); behaviour of the module service is unchanged. | Open (tidy-up) |
| WA6 | docs (`docs/STATUS.md`) | Refresh: S02 and S03 are built; the S30 settings screen (modules, integrations, retention, security, backup) exists; finance account / category / payee / budget-line management has screens (`/settings/finance`); the display-holds screen exists (API per WA2). Remaining: WA1 (policy at sign-in), WA2 (holds routes). | Done (integration) |
| WA7 | shared (`schemas/admin.ts` `AUDIT_ACTIONS`) | Optional: distinct `WORKSPACE_SECURITY_POLICY_UPDATED` and `WORKSPACE_BACKUP_VERIFIED`; today they are `WORKSPACE_PROFILE_UPDATED` (`entityType: WorkspaceSecurityPolicy`) and `WORKSPACE_SETUP_ITEM_UPDATED` (`entityType: BackupVerification`). | Done (integration) |

Notes: the S03 checklist reads completion from data, so marking an auto-detected step DONE is refused until the data
shows it (409 `NOT_DETECTED`), and a regression (for example a new privileged user without MFA) shows the step as no
longer met. Retention periods stated under a privacy-notice version change only with a new version, in either direction
(stricter than first contracted: keeping data longer than people were told is as much a breach of the notice as deleting it
earlier). Backups are not taken by the app: an operator records each restore test; 90 days is the freshness window.

## Pilot hardening: field-pin (offline PIN)

Built in `apps/web/src/lib/offline/**` (`pin.ts`, `crypto.ts`, `queue.ts`, `storage.ts`), `components/mobile/**`
(`pin-gate.tsx`, `mobile-session.tsx`, additive gate and menu items in `mobile-shell.tsx`); contract §36 as built.
Requests to other owners:

| # | To | Request | Status |
| --- | --- | --- | --- |
| FP1 | API (auth / field) + security review | So that a forgotten PIN can upload before discarding (today unsent items are lost: nothing but the PIN can unwrap the queue key), add a server-held key share per user and device: e.g. `PUT /me/offline-key-share` (`{ deviceId }` → server generates 32 random bytes, stores them sealed with tenant_id + RLS, returns them) and `GET /me/offline-key-share?deviceId=` behind a fresh re-auth (audited, never logged), revoked on sign-out / device removal. The client would wrap the queue key a second time under it (`QueueKeyVault` gains `escrowWrap`), so an online reset can unwrap, upload, then re-wrap under the new PIN. Trade-off to decide: the server (or anyone with the user's password and TOTP plus the phone) could then open the queue without the PIN. | Open (design decision) |
| FP2 | `scripts/smoke/field-smoke.cjs` | `/m` now asks for a PIN. After `signIn(mp, 'agent1@…')`: on the heading "Set a PIN for this phone" fill `getByLabel('New PIN', { exact: true })` and `getByLabel('Repeat the PIN')` with a 6-digit non-sequence PIN (e.g. `583920`) and click "Set PIN"; after every full page load (`mp.goto(...)`), on "Enter your PIN" fill `getByLabel('PIN', { exact: true })` and click "Open". Navigation through links keeps the queue open. | Done (integration) |
| FP3 | docs (`docs/STATUS.md` pipeline table) | Web test count: the field-pin suite adds 16 tests (`offline-pin.test.ts`) and the queue suite 2 (lock). | Done (integration) |

## Pilot hardening: integration status (after the four pilot-hardening agents)

Applied in the integration pass (contract §32–36 updated where the behaviour changed):

| Request | Status |
| --- | --- |
| AR3 (passkey request schemas in shared) | **Applied.** `PasskeyMfaOptionsSchema`, `PasskeyMfaVerifySchema`, `PasskeyReauthVerifySchema` live in `packages/shared/src/platform/auth-recovery.ts`; `passkeys.dto.ts` only builds DTO classes. |
| AR4 (`methods` on MFA_REQUIRED) | Open (optional; the MFA step still offers every method). |
| AR5 (admin MFA reset revokes passkeys and codes) | **Applied (security).** `POST /admin/users/:id/reset-mfa` revokes every active passkey (`revokedReason: 'admin_reset'`, `revokedById` = the administrator) and every unused recovery code in the same transaction; `USER_MFA_RESET` records `passkeysRevoked` and `recoveryCodesRevoked`. Test: `admin.api.integration.spec.ts`. |
| AR7, AR8 (admin re-auth with a passkey; admin account-recovery screens) | Open (UI). The API is complete and tested. |
| AR9 (contact, SMS consent and push panels on `/settings/account`; service-worker push handler) | Open (UI). The API is complete and tested. |
| PI1 (global throttler on the shared store) | **Applied.** `ThrottlerModule.forRootAsync` uses `RateLimitThrottlerStorage(RATE_LIMIT_STORE)`: the global per-IP throttle and the `@Throttle` limits on `/auth/*` count in Redis in production (memory in development and tests); store down → 503. |
| PI2 (stage-comparison audit actions) | **Applied.** `AUDIT_ACTIONS.STAGE_COMPARISON_COMPLETED` / `STAGE_COMPARISON_FAILED` (same strings); the service constants alias them. |
| PI3 (`SUPPORTING_DOCUMENT_NOT_CLEAN`) | **Applied.** `financeApprovalBlockers` takes `pendingDocumentCount`; attached documents that are neither CLEAN nor INFECTED give `SUPPORTING_DOCUMENT_NOT_CLEAN` instead of "missing"; the approval checklist shows it. |
| PI4 (deployment captcha site key; portal widget) | **Applied.** `GET /public/:slug/portal` returns the tenant's site key or, when empty, the deployment's public key for the chosen provider (never a secret). The portal form registers hCaptcha and Turnstile widgets (`components/public/captcha-widgets.tsx`); the provider script loads only on a portal whose office chose that provider. |
| PI6 (stale EXIF comment) | **Applied.** |
| PI7 (acknowledgement in the submission transaction) | **Applied.** `CasePortalService` enqueues the SMS / e-mail acknowledgement with `MessageOutboxService.enqueueCitizenInTx` inside the submission transaction (idempotency `case-ack:<caseId>:<channel>`), so it exists exactly when the case does, with or without job queues; the `notifications` queue path remains only as a fallback when no outbox is bound. |
| PI8 (forced-failure comparison retry in a tally rehearsal) | Open (test). |
| WA1 (tenant security policy at sign-in) | **Applied (security).** `AuthService` requires MFA for everyone under `mfaPolicy: 'ALL_USERS'` (login, `/auth/me`) and caps new sessions at `sessionMaxHours`; `PermissionService.loadAuthContext` applies the policy to live sessions on every request (MFA for all, maximum session length from `createdAt`, idle timeout from `sessions.last_used_at`, which is touched at most once a minute); refresh refuses a session past either limit. No schema change was needed (`last_used_at` already existed). `GET /workspace/security` reports `policyEnforcedAtSignIn: true`. Test: `workspace-admin.integration.spec.ts`. |
| WA2 (display-holds routes) | **Applied.** `DisplayHoldsController` serves §35 through `DisplayHoldsHttpService`: list / detail scoped by the linked submission's geography and cycle (`tally.source.download`), redacted-copy URL only (403 `NOT_FOR_DISPLAY_UNTIL_REDACTED` while none is attached, 409 `FILE_NOT_CLEAN` until the copy is CLEAN), attach / confirm by hold id with `tally.approve` over the submission and re-auth (uploader and declarer refused by the existing service). Module `tally`. `pnpm demo:redact-34a` is unchanged. Test: `demo-34a-import.integration.spec.ts`. |
| WA3 (navigation) | **Applied.** "Workspace setup" (Administration) and "Finance master data" (Campaign). |
| WA4 (organisation code in the invitation) | **Applied.** `auth.invitation` puts a well-formed `payload.tenantSlug` in the link (`/accept-invitation#tenant=<code>&token=…`) and the body; admin invitations now carry it too; the accept form pre-fills the organisation code from the link. |
| WA5 (`setOfficeConfig`) | Open (tidy-up). |
| WA6 (STATUS refresh) | **Applied.** |
| WA7 (distinct audit actions) | **Applied.** `WORKSPACE_SECURITY_POLICY_UPDATED` and `WORKSPACE_BACKUP_VERIFIED`. |
| FP1 (server-held key share for the offline queue) | Open (design decision, security review). |
| FP2 (field smoke enters the PIN) | **Applied.** `scripts/smoke/field-smoke.cjs` sets the PIN on the first sign-in and enters it after each full page load. |
| FP3 (test counts) | **Applied** (STATUS pipeline table). |

Added in the integration pass: `apps/api/test/pilot-readiness-rehearsal.e2e.spec.ts` (`pnpm test:rehearsal:pilot`, production mode, fake SMTP / Africa's Talking / clamd / captcha, two API instances on Redis, a BullMQ-scheduled scan job) and `scripts/smoke/pilot-smoke.cjs` (`pnpm smoke:pilot`, screenshots `docs/screenshots/pilot-*.png`).

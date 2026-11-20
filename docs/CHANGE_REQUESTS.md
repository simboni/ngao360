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
   instance (move to Redis before scaling out); no captcha verifier is bound; contact retention is
   recorded (`retentionUntil`) but no scheduled job erases expired contacts yet.

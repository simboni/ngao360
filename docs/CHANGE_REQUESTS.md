# Change requests

Requests from module agents for changes outside the files they own. Append below; do not edit other agents' entries.

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

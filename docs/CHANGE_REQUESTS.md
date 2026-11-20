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

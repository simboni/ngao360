# NGAO360 REST API contract

This is the contract that the API module agents implement and the web UI agents code against.
Every request and response type named here is exported from `@ngao360/shared`
(`packages/shared/src`). If you need a field that is not here, add it to the shared schema
first, then update this file. Do not invent ad-hoc shapes.

Status: §2–30 are **implemented**: the platform foundation, NGAO TALLY, NGAO360 Office, field and
election operations, and campaign and organisation (organisation, tasks, events, communications,
finance, reports, the notification centre and the breach register; §23–30, with the end-to-end
campaign rehearsal in `apps/api/test/campaign-rehearsal.e2e.spec.ts`).
§31–36 (pilot hardening: messaging outbox, contacts and push, passkeys and recovery, workspace setup and settings,
malware scanning and durable jobs, display holds, the field offline PIN) are a **contract only**: schema, shared types,
platform interfaces and route stubs exist; the endpoints are being built.

Query-string flags (`unreadOnly`, `flagged`, `mine`, `includeDrills`, …) use `QueryBooleanSchema`: `true` / `1` and
`false` / `0` only (anything else is 400). `z.coerce.boolean()` is not used for query flags because it reads `"false"`
as true.

---

## 1. Conventions

| Topic | Rule |
| --- | --- |
| Base URL | `/api`. The web app proxies `/api/*` to the API (Next.js rewrite in dev, Caddy in deployment), so cookies are first-party. |
| Auth | The `ngao_at` httpOnly access cookie (15 min) is sent automatically. `ngao_rt` refresh cookie (7 days, path `/api/auth`). Non-browser clients may send `Authorization: Bearer <access JWT>`. |
| CSRF | Every non-GET request from the browser must send the header `x-ngao-client: web` (`CSRF_HEADER`). The web `api` client does this. |
| Content type | JSON (`application/json`), except uploads (`multipart/form-data`) and downloads. |
| Validation | Request bodies, queries and params are validated with the named zod schema. A failure returns 400 `VALIDATION_FAILED` with `details: [{ path, message }]`. |
| Errors | Every error body is an `ApiError`: `{ statusCode, error, code, message, details?, requestId }`. Codes are listed in `ERROR_CODES`, e.g. `FORBIDDEN`, `OUT_OF_SCOPE`, `MFA_REQUIRED`, `REAUTH_REQUIRED`, `SEPARATION_OF_DUTIES`, `INVALID_TRANSITION`, `IMMUTABLE_RECORD`, `CONFLICT`, `NOT_FOUND`. |
| Lists | Queries extend `PaginationQuerySchema` (`page` is 1-based, `pageSize` ≤ 200, `q`, `sort`, `order`). Responses are `Paginated<T>`: `{ items, page, pageSize, total }`. |
| IDs and time | UUID ids. ISO-8601 UTC timestamps (`...Z`) and `YYYY-MM-DD` dates. The UI shows Africa/Nairobi time. |
| Authorisation | Every endpoint declares `@RequirePermission(...)`, `@AuthenticatedOnly()` or `@Public()`. The RBAC guard denies anything else. The "Permission" column below is mandatory. **(geo)** means the guard checks the target record's geography against scoped grants via a `GeoTarget`. |
| Scope filtering | List endpoints return only rows inside the caller's geography. Get it from `PermissionService.scopeFor(auth, permission)`, then use `stationScopeWhere(scope)` (or filter by unit path). |
| Audit | Every state change writes an audit event with `AuditService.record(entry, tx)` in the same transaction. The "Audit" column names the `AUDIT_ACTIONS` key. |
| Reasons | Changing captured values, status transitions and all high-risk actions need a `reason` (`ReasonSchema`, 3–2000 chars). |
| Re-auth | Endpoints marked **(reauth)** need `POST /api/auth/reauth` within the last 10 minutes (`@RequireReauth()`). Otherwise they return 401 `REAUTH_REQUIRED`. |
| MFA | Users who hold a privileged role or any high-risk permission must have an MFA-verified session. Otherwise they get 403 `MFA_REQUIRED`. |
| Tenancy | All data access goes through `PrismaService.tenantTx()` / `withTenant()`, so Postgres RLS (`app.tenant_id`) applies. Never accept `tenantId` from the client. |
| Language | No endpoint or export may label a candidate "winner", "elected" or "declared". Aggregate responses carry `disclaimer: PARALLEL_TALLY_DISCLAIMER`. |
| Provenance | Data from a cycle with `dataProvenance` of `HISTORICAL` or `SYNTHETIC` must be labelled with `DATA_PROVENANCE_LABELS` in the UI and in exports. |
| Historical demo | A cycle with `dataProvenance = HISTORICAL_DEMO` or `containsSimulatedData = true`, or a tenant with `historical_demo`, also carries `HISTORICAL_DEMO_LABEL` ("HISTORICAL DEMO / SIMULATED DATA") next to the parallel-tally disclaimer: `GET /auth/me` returns `tenant.dataLabel` / `tenant.dataNotice` (web shell banner on every screen), `GET /tally/results/live` and every snapshot return `dataLabel` (stored inside the hashed snapshot content), and every export (tally, report builder, finance, attendance, breach, audit log, deployment roster) prints it in its header and footer. The label can be added, never removed (database triggers). See `docs/DEMO_2022.md`. |

---

## 2. Auth (implemented: `apps/api/src/auth`)

| Method | Path | Permission | Request | Response | Notes / Audit |
| --- | --- | --- | --- | --- | --- |
| POST | `/auth/login` | Public, rate-limited | `LoginRequest` | `LoginResponse` | `AUTHENTICATED` sets cookies. `MFA_REQUIRED` or `MFA_ENROLMENT_REQUIRED` returns a 5-minute `challengeToken`. Locks the account after 5 failures for 15 min. Audit: `AUTH_LOGIN_SUCCEEDED` / `AUTH_LOGIN_FAILED`. |
| POST | `/auth/mfa/verify` | Public, rate-limited | `MfaVerifyRequest` | `MeResponse` | Needs a `verify` challenge. Sets cookies. TOTP replay is rejected. After `MFA_MAX_FAILURES` (5) consecutive wrong codes the authenticator is locked for `MFA_LOCK_MINUTES` (15), whatever IP the attempts come from (also applies to `/auth/reauth`). Audit: `AUTH_MFA_VERIFIED` / `AUTH_MFA_FAILED` / `AUTH_MFA_LOCKED`. |
| POST | `/auth/mfa/enrol/start` | Public with an `enrol` challenge, or a session | `MfaEnrolStartRequest` | `MfaEnrolStartResponse` | Creates a PENDING TOTP factor. A `verify` challenge (user already has an authenticator) is refused (401). From a session, a user who already has an authenticator needs an MFA-verified session and a recent re-authentication. Audit: `AUTH_MFA_ENROL_STARTED`. |
| POST | `/auth/mfa/enrol/confirm` | Public with an `enrol` challenge, or a session | `MfaEnrolConfirmRequest` | `MeResponse` | Activates the factor (revoking any earlier one). With a challenge token it also completes login (sets cookies) and is refused if an active factor already exists. Audit: `AUTH_MFA_ENROLLED`. |
| POST | `/auth/invitation/accept` | Public, rate-limited | `AcceptInvitationRequest` | `OkResponse` | The invited person sets their own password with a single-use token (72 h, only its SHA-256 is stored). The account becomes ACTIVE; the person then signs in normally. Audit: `AUTH_INVITATION_ACCEPTED`. |
| POST | `/auth/refresh` | Public (refresh cookie) | none | `OkResponse` | Rotates the refresh token. Reuse revokes the session. |
| POST | `/auth/logout` | Authenticated | none | `OkResponse` | Revokes the session and clears cookies. Audit: `AUTH_LOGOUT`. |
| GET | `/auth/me` | Authenticated | none | `MeResponse` | Permissions and grants are for navigation only. |
| POST | `/auth/reauth` | Authenticated | `ReauthRequest` | `OkResponse` | Password, plus TOTP if MFA is enabled. Issues an access token with `rat`. Audit: `AUTH_REAUTH`. |

## 3. Platform (implemented)

| Method | Path | Permission | Response | Notes |
| --- | --- | --- | --- | --- |
| GET | `/health` | Public | `HealthResponse` | Database, storage and Redis checks. |
| GET | `/files/local/:token` | Public (HMAC token) | file bytes | Serves local-driver signed URLs only. Tokens come from `StorageService.signedUrl()` after a permission check and an audit event. |

---

## 4. Reference module (`apps/api/src/modules/reference`)

Web screens: `/reference/stations` (S12) and `/reference/forms`. Every mutation is audited with
`REFERENCE_CREATED`, `REFERENCE_UPDATED` or `REFERENCE_IMPORTED` (`entityType` = model name),
unless another action is named.

### 4.1 Election cycles

| Method | Path | Permission | Request | Response | Notes |
| --- | --- | --- | --- | --- | --- |
| GET | `/reference/election-cycles` | `reference.view` | `PaginationQuery` | `Paginated<ElectionCycle>` | |
| GET | `/reference/election-cycles/:id` | `reference.view` | `IdParam` | `ElectionCycle` | |
| POST | `/reference/election-cycles` | `reference.edit` | `CreateElectionCycle` | `ElectionCycle` (201) | Takes `dataProvenance` (`LIVE`, `HISTORICAL`, `SYNTHETIC` or `HISTORICAL_DEMO`), optional `containsSimulatedData` (implied by `HISTORICAL_DEMO`) and `provenanceNotes`. The simulated flag and the `HISTORICAL_DEMO` provenance can be set but never cleared (409 `IMMUTABLE_RECORD`). |
| PATCH | `/reference/election-cycles/:id` | `reference.edit` | `UpdateElectionCycle` | `ElectionCycle` | Status follows `DRAFT → ACTIVE → CLOSED → ARCHIVED`. |

### 4.2 Geography

| Method | Path | Permission | Request | Response | Notes |
| --- | --- | --- | --- | --- | --- |
| GET | `/reference/geographic-units` | `reference.view` | `GeographicUnitQuery` | `Paginated<GeographicUnit>` | Filter by `type` and `parentId`. Includes `childCount`. Scope-filtered by unit path. |
| GET | `/reference/geographic-units/:id` | `reference.view` **(geo: geographicUnit/params.id)** | `IdParam` | `GeographicUnit` | |
| GET | `/reference/geographic-units/:id/children` | `reference.view` **(geo)** | `IdParam` | `GeographicUnit[]` | For the drill-down. |
| POST | `/reference/geographic-units` | `reference.edit` | `CreateGeographicUnit` | `GeographicUnit` (201) | Validates the parent type with `GEOGRAPHIC_PARENT_TYPE`. Computes `path`. |
| PATCH | `/reference/geographic-units/:id` | `reference.edit` | `UpdateGeographicUnit` | `GeographicUnit` | Codes and parents are immutable; create a new `sourceVersion` instead. |

### 4.3 Registry versions and import

| Method | Path | Permission | Request | Response | Notes |
| --- | --- | --- | --- | --- | --- |
| GET | `/reference/registry-versions` | `reference.view` | `PaginationQuery & { electionCycleId }` | `Paginated<RegistryVersion>` | |
| POST | `/reference/registry-versions` | `reference.import` | `CreateRegistryVersion` | `RegistryVersion` (201) | Status `DRAFT`. |
| POST | `/reference/registry-versions/:id/import` | `reference.import` | multipart `file` (CSV) | `RegistryImportResult` (202 when queued) | The CSV columns are documented on `RegistryImportResultSchema`. Store the file with `StorageService.storeImmutable(purpose: 'REFERENCE_IMPORT')`. Files over 5,000 rows go to `REGISTRY_IMPORT_QUEUE`; 2027 is expected to have about 55k stations. Audit: `REFERENCE_IMPORTED`. |
| GET | `/reference/registry-versions/:id/import-status` | `reference.view` | `IdParam` | `RegistryImportResult & { status: 'QUEUED' \| 'RUNNING' \| 'COMPLETED' \| 'FAILED' }` | |
| POST | `/reference/registry-versions/:id/approve` | `reference.approve` **(reauth)** | `{ reason }` | `RegistryVersion` | Moves the previous APPROVED version for the cycle to `SUPERSEDED`. The approved version is the denominator for coverage. Audit: `REGISTRY_APPROVED`. |

### 4.4 Polling stations

| Method | Path | Permission | Request | Response | Notes |
| --- | --- | --- | --- | --- | --- |
| GET | `/reference/polling-stations` | `reference.view` | `PollingStationQuery` | `Paginated<PollingStation>` | Scope-filtered with `stationScopeWhere`. Includes denormalised names. |
| GET | `/reference/polling-stations/:id` | `reference.view` **(geo: pollingStation/params.id)** | `IdParam` | `PollingStation` | |
| POST | `/reference/polling-stations` | `reference.edit` | `CreatePollingStation` | `PollingStation` (201) | Derives `countyId`, `constituencyId`, `wardId` and `pollingCentreId` from `geographicUnitId`. |
| PATCH | `/reference/polling-stations/:id` | `reference.edit` | `UpdatePollingStation` | `PollingStation` | Rejected if the registry version is APPROVED. Create a new version instead. |

### 4.5 Tally centres

| Method | Path | Permission | Request | Response |
| --- | --- | --- | --- | --- |
| GET | `/reference/tally-centres` | `reference.view` | `PaginationQuery & { electionCycleId, level? }` | `Paginated<TallyCentre>` |
| POST | `/reference/tally-centres` | `reference.edit` | `CreateTallyCentre` | `TallyCentre` (201) |
| PATCH | `/reference/tally-centres/:id` | `reference.edit` | `Partial<CreateTallyCentre>` | `TallyCentre` |

### 4.6 Contests and candidate references

| Method | Path | Permission | Request | Response | Notes |
| --- | --- | --- | --- | --- | --- |
| GET | `/reference/contests` | `reference.view` | `PaginationQuery & { electionCycleId, officeType? }` | `Paginated<Contest>` | |
| GET | `/reference/contests/:id` | `reference.view` | `IdParam` | `Contest & { candidates: CandidateReference[] }` | |
| POST | `/reference/contests` | `reference.edit` | `CreateContest` | `Contest` (201) | Sets `formSeries` from `FORM_SERIES[officeType]`. The area must match the office (county for GOVERNOR, SENATOR and WOMAN_REPRESENTATIVE; constituency for NATIONAL_ASSEMBLY; ward for COUNTY_ASSEMBLY; null for PRESIDENT). |
| PATCH | `/reference/contests/:id` | `reference.edit` | `UpdateContest` | `Contest` | |
| GET | `/reference/contests/:id/candidates` | `reference.view` | `IdParam` | `CandidateReference[]` | Ordered by `ballotOrder`. |
| POST | `/reference/contests/:id/candidates` | `reference.edit` | `CreateCandidateReference` | `CandidateReference` (201) | Names exactly as published. No other personal data. |
| PATCH | `/reference/candidates/:id` | `reference.edit` | `UpdateCandidateReference` | `CandidateReference` | Blocked once the contest has submissions. |

### 4.7 Form templates

| Method | Path | Permission | Request | Response | Notes |
| --- | --- | --- | --- | --- | --- |
| GET | `/reference/form-templates` | `forms.view` | `FormTemplateQuery` | `Paginated<FormTemplate>` | |
| GET | `/reference/form-templates/:id` | `forms.view` | `IdParam` | `FormTemplate` | |
| POST | `/reference/form-templates` | `forms.configure` | `CreateFormTemplate` | `FormTemplate` (201) | `version` is max+1 for (cycle, formNumber). State is `DRAFT`. Validates `fieldSchema` and `validationRules` with the shared schemas. Audit: `FORM_TEMPLATE_CREATED`. |
| PATCH | `/reference/form-templates/:id` | `forms.configure` | `UpdateFormTemplate` | `FormTemplate` | DRAFT only. An approved template returns 409 `IMMUTABLE_RECORD`. Audit: `FORM_TEMPLATE_UPDATED`. |
| POST | `/reference/form-templates/:id/approval` | `forms.approve` **(reauth)** for APPROVE and RETIRE; `forms.configure` to SUBMIT | `FormTemplateApprovalRequest` | `FormTemplate` | The approver must differ from `createdById`. Audit: `FORM_TEMPLATE_STATE_CHANGED`. |

---

## 5. Tally module (`apps/api/src/modules/tally`)

Web screens: `/tally/inbox` (S18), `/tally/capture/[id]` (S19), `/tally/verify/[id]` (S20),
`/tally/results` (S21), `/tally/discrepancies` and `/tally/discrepancies/[id]` (S22).

The tally module registers a GeoScopeService resolver `'submission'` (station location, or tally-centre unit path)
and `'discrepancy'` (union of linked submissions) in `onModuleInit`.

### Separation-of-duties rules (blueprint 3.2 / 8.5), enforced server-side

1. A user cannot record a verification on a submission they submitted, or on one where they changed any `ResultValue`. The API returns 403 `SEPARATION_OF_DUTIES`.
2. A supervisor action cannot be taken by the submitter, a value editor or the verifier of that submission.
3. A discrepancy closure approver must differ from its resolver.
4. No endpoint deletes a submission, source file, value history or snapshot. The DB triggers return `IMMUTABLE_RECORD`.

### 5.1 Submissions (intake)

| Method | Path | Permission | Request | Response | Notes / Audit |
| --- | --- | --- | --- | --- | --- |
| POST | `/tally/submissions` | `tally.submit` **(geo: pollingStation/body.pollingStationId when station-level)** | multipart: `file` and `metadata` (JSON string of `CreateSubmission`) | `SubmissionDetail` (201). Repeating an `idempotencyKey` returns 200 with the original. | Checks the template is APPROVED and matches the contest `officeType` and cycle, and that the station is in the approved registry. Otherwise the submission is QUARANTINED and a `FORM_VERSION_MISMATCH` case is opened. `StorageService.storeImmutable(purpose: 'RESULT_FORM')`. When the hash is a duplicate or the station + form combination already exists, set `duplicateFlag`, link `duplicateOfId`, set `isCanonical=false` and open a `DUPLICATE` case. Never reject or delete. Reference is `nextReference(tx, tenantId, 'SUB')`. Creates an `OcrExtraction` and enqueues OCR. Status `SUBMITTED`. Audit: `FILE_STORED`, `SUBMISSION_CREATED`. |
| GET | `/tally/submissions` | `tally.view` | `SubmissionQuery` | `Paginated<SubmissionSummary>` | Scope-filtered. `view=awaiting_me` shows SECOND_REVIEW_PENDING records the caller did not submit or edit. `view=awaiting_supervisor` shows outcomes with a verification awaiting a supervisor action, excluding records the caller took part in. `view=mine` shows the caller's own. |
| GET | `/tally/submissions/:id` | `tally.view` **(geo: submission/params.id)** | `IdParam` | `SubmissionDetail` | `allowedActions` is computed from permissions, SoD and status. |
| GET | `/tally/submissions/:id/source-url` | `tally.view` **(geo)**. Add `?download=1` with `tally.source.download`. | `IdParam` | `SignedUrlResponse` | Inline view by default. Audit: `FILE_SOURCE_ACCESSED` on every call. A source image under a display hold (`stored_file_display_holds`, e.g. every real 2022 34A scan imported by `pnpm demo:import-34a`, with or without `--redacted`) answers 403 `NOT_FOR_DISPLAY_UNTIL_REDACTED` until a redacted copy is attached; afterwards the URL serves the redacted copy and the response carries `redactedCopy: true` and the copy's `sha256`. The original is never altered or served. Holds are created and redacted copies attached by `pnpm demo:import-34a` / `pnpm demo:redact-34a` (audit `FILE_DISPLAY_HOLD_CREATED`, `FILE_REDACTION_DECLARED` for an operator's `--redacted` declaration, `FILE_REDACTED_COPY_ATTACHED` naming the releasing reviewer and reason; the uploader or declarer can never release a hold); there is no HTTP endpoint for them yet. |
| POST | `/tally/submissions/:id/transition` | depends on target: RETURNED needs `tally.capture` or `tally.verify`; EXCLUDED_FROM_AGGREGATE needs `tally.exclude` **(reauth)**; ARCHIVED needs `tally.approve` | `SubmissionTransition` | `SubmissionDetail` | Must pass `canTransitionSubmission()`. Optimistic `version`. Audit: `SUBMISSION_STATUS_CHANGED` with before/after status and reason. |
| POST | `/tally/submissions/:id/designate-canonical` | `tally.approve` | `DesignateCanonical` | `SubmissionDetail` | Unsets `isCanonical` on the other records in the duplicate group (partial unique index). Audit: `SUBMISSION_CANONICAL_DESIGNATED`. |
| GET | `/tally/submissions/:id/audit` | `tally.view` **(geo)** | `IdParam` | `AuditEvent[]` | Events for the submission, its values, verifications and file. |

### 5.2 Capture

| Method | Path | Permission | Request | Response | Notes / Audit |
| --- | --- | --- | --- | --- | --- |
| PUT | `/tally/submissions/:id/values` | `tally.capture` **(geo)** | `SaveCapture` | `SubmissionDetail` | Allowed in SUBMITTED, OCR_COMPLETE, RETURNED and DATA_ENTRY_REVIEWED. Each value is checked against the template `fieldSchema`. Candidate fields need a `candidateReferenceId` of the contest. Each change bumps `changeVersion` (409 `CONFLICT` if `expectedChangeVersion` is stale). Appends a `ResultValueChange` (old, new, actor, reason, source `MANUAL_ENTRY`). `reason` is required when changing a non-null value. Sets `confirmedBy` and `confirmedAt`. Re-runs validation. Audit: `RESULT_VALUE_CHANGED` for each changed field. |
| GET | `/tally/submissions/:id/values/history` | `tally.view` **(geo)** | `IdParam` | `ResultValueChange[]` | |
| POST | `/tally/submissions/:id/submit-for-review` | `tally.capture` **(geo)** | `{ reason?: string }` | `SubmissionDetail` | Needs every required field confirmed by a person (OCR values alone never count) and no FAIL validation results. Moves DATA_ENTRY_REVIEWED to SECOND_REVIEW_PENDING. Audit: `SUBMISSION_STATUS_CHANGED`. |

### 5.3 Validation

| Method | Path | Permission | Request | Response | Notes / Audit |
| --- | --- | --- | --- | --- | --- |
| POST | `/tally/submissions/:id/validate` | `tally.capture` or `tally.verify` (anyOf) **(geo)** | none | `ValidationRun` | Runs the template's `validationRules` (versioned). Writes `ValidationResult` rows. Never alters or discards values. Each result names the exact fields and the rule. An arithmetic FAIL opens an `ARITHMETIC` case if none is open. Audit: `VALIDATION_RUN`. |
| GET | `/tally/submissions/:id/validation` | `tally.view` **(geo)** | `IdParam` | `ValidationRun \| null` | Latest run. |

### 5.4 Verification

| Method | Path | Permission | Request | Response | Notes / Audit |
| --- | --- | --- | --- | --- | --- |
| POST | `/tally/submissions/:id/verifications` | `tally.verify` **(geo)** | `CreateVerification` | `Verification` (201) | Requires SECOND_REVIEW_PENDING and the SoD rules. The verifier's `independentValues` are compared with the captured values; mismatches fill `mismatchedFieldKeys` and open a `REVIEWER_DISAGREEMENT` case. Decisions: PASS (with no mismatches) moves to VERIFIED and sets `verifiedAt`; RETURN moves to RETURNED; DISPUTE moves to DISPUTED. Audit: `VERIFICATION_RECORDED` and `SUBMISSION_STATUS_CHANGED`. |
| GET | `/tally/submissions/:id/verifications` | `tally.view` **(geo)** | `IdParam` | `Verification[]` | |
| POST | `/tally/verifications/:id/supervisor-action` | `tally.approve` **(reauth)** | `SupervisorActionRequest` | `Verification` | APPROVED confirms the outcome. REJECTED returns the submission to SECOND_REVIEW_PENDING. THIRD_CHECK_REQUESTED opens a new round. Audit: `SUPERVISOR_ACTION`. |

### 5.5 Discrepancies

| Method | Path | Permission | Request | Response | Notes / Audit |
| --- | --- | --- | --- | --- | --- |
| GET | `/tally/discrepancies` | `tally.discrepancy.view` | `DiscrepancyQuery` | `Paginated<DiscrepancyCaseSummary>` | Scope-filtered through linked submissions. |
| GET | `/tally/discrepancies/:id` | `tally.discrepancy.view` **(geo: discrepancy)** | `IdParam` | `DiscrepancyCaseDetail` | `requiredHandling` comes from `DISCREPANCY_REQUIRED_HANDLING`. |
| POST | `/tally/discrepancies` | `tally.discrepancy.manage` | `CreateDiscrepancy` | `DiscrepancyCaseDetail` (201) | Reference is `nextReference(..., 'DSC')`. ARITHMETIC and REVIEWER_DISAGREEMENT cases hold linked submissions from the aggregate (moves them to DISPUTED). Audit: `DISCREPANCY_OPENED`. |
| POST | `/tally/discrepancies/:id/assign` | `tally.discrepancy.manage` | `AssignDiscrepancy` | `DiscrepancyCaseDetail` | Appends a `DiscrepancyCaseAction`. Audit: `DISCREPANCY_UPDATED`. |
| POST | `/tally/discrepancies/:id/comments` | `tally.discrepancy.manage` | `DiscrepancyComment` | `DiscrepancyCaseAction` (201) | Append-only. |
| POST | `/tally/discrepancies/:id/transition` | `tally.discrepancy.manage` | `DiscrepancyTransition` | `DiscrepancyCaseDetail` | Allowed: OPEN → UNDER_REVIEW and ESCALATED. Audit: `DISCREPANCY_UPDATED`. |
| POST | `/tally/discrepancies/:id/resolve` | `tally.discrepancy.resolve` **(reauth)** | `ResolveDiscrepancy` | `DiscrepancyCaseDetail` | Records the decision. May designate a canonical submission or exclude submissions (each change is audited). Never overwrites source values. Audit: `DISCREPANCY_RESOLVED`. |
| POST | `/tally/discrepancies/:id/close` | `tally.discrepancy.resolve` | `CloseDiscrepancy` | `DiscrepancyCaseDetail` | The approver must differ from the resolver. Audit: `DISCREPANCY_CLOSED`. |

### 5.6 Results, aggregates and snapshots

The default aggregate includes only `status = VERIFIED` and `isCanonical = true` submissions of the
station-level form (for example 37A). The denominator is the station count of the APPROVED registry
version. Missing stations are never counted as zero votes. `calculationVersion` is a constant string
such as `"tally-agg-v1"`, bumped whenever the logic changes.

| Method | Path | Permission | Request | Response | Notes / Audit |
| --- | --- | --- | --- | --- | --- |
| GET | `/tally/results/live` | `tally.results.view` | `AggregateQuery` | `LiveAggregate` | Computed on demand and not persisted. Scope-limited for scoped grants. |
| GET | `/tally/results/breakdown` | `tally.results.view` | `AggregateQuery & { parentUnitId? }` | `GeographyBreakdown` | Drill-down from county to constituency to ward to station. Filters never change source records. |
| GET | `/tally/results/stations` | `tally.results.view` | `AggregateQuery & PaginationQuery & { status? }` | `Paginated<SubmissionSummary & { pollingStationId, coverageStatus: 'MISSING' \| 'RECEIVED' \| 'VERIFIED' \| 'FLAGGED' \| 'EXCLUDED' }>` | Each row links to the source submission. |
| POST | `/tally/snapshots` | `tally.snapshot.create` | `CreateSnapshot` | `TallySnapshot` (201) | Immutable. Stores `includedSubmissionIds`, `totalsJson`, `coverageJson` and `contentHash` (SHA-256 of the canonical content). Reference is `nextReference(..., 'SNP')`. Audit: `SNAPSHOT_CREATED`. |
| GET | `/tally/snapshots` | `tally.results.view` | `SnapshotQuery` | `Paginated<TallySnapshot>` | |
| GET | `/tally/snapshots/:id` | `tally.results.view` | `IdParam` | `TallySnapshot` | |
| POST | `/tally/snapshots/:id/release` | `tally.release` **(reauth)** | `ReleaseSnapshot` | `TallySnapshot` | Sets `releasedAt` and `releasedById` once; the DB trigger allows only this. "Release" means internal release to authorised viewers, never a public declaration. Audit: `SNAPSHOT_RELEASED`. |

### 5.7 Exports

| Method | Path | Permission | Request | Response | Notes / Audit |
| --- | --- | --- | --- | --- | --- |
| POST | `/tally/exports` | `tally.export` **(reauth)** | `CreateExport` | `TallyExport` (201 sync, or 202 when queued on `TALLY_EXPORT_QUEUE`) | The file must contain `PARALLEL_TALLY_DISCLAIMER`, the snapshot reference, methodology, denominator, record statuses, the data provenance label and an audit manifest. It is checked with `findForbiddenTallyLanguage()` before storage. Stored with `purpose: 'EXPORT'`. Audit: `EXPORT_CREATED`. |
| GET | `/tally/exports` | `tally.export` | `PaginationQuery & { snapshotId? }` | `Paginated<TallyExport>` | |
| GET | `/tally/exports/:id/download-url` | `tally.export` | `IdParam` | `SignedUrlResponse` | Audit: `FILE_SOURCE_ACCESSED`. |

### 5.8 OCR

| Method | Path | Permission | Request | Response | Notes |
| --- | --- | --- | --- | --- | --- |
| GET | `/tally/submissions/:id/ocr` | `tally.view` **(geo)** | `IdParam` | `OcrExtraction \| null` | The foundation worker is a stub that sets `NOT_CONFIGURED`. A future engine writes only `ocrValue` and `ocrConfidence`. |
| POST | `/tally/submissions/:id/ocr/retry` | `tally.capture` **(geo)** | none | `OcrExtraction` | |

---

## 6. Admin module (`apps/api/src/modules/admin`)

Web screens: `/admin/users` (S06), `/admin/roles` (S07) and `/admin/audit` (S29).

### 6.1 Users

| Method | Path | Permission | Request | Response | Notes / Audit |
| --- | --- | --- | --- | --- | --- |
| GET | `/admin/users` | `users.view` | `UserQuery` | `Paginated<UserSummary>` | |
| GET | `/admin/users/:id` | `users.view` | `IdParam` | `UserDetail` | |
| POST | `/admin/users` | `users.create` **(reauth)** | `CreateUser` | `UserDetail` (201) with `invitation { token, expiresAt, acceptPath }` shown once | Creates an INVITED user. Administrators never set another person's password: `initialPassword` is refused (400). Granting a role also needs `roles.assign` (and the grantor-scope rules below). Audit: `USER_CREATED`, plus `ROLE_ASSIGNED` for each assignment. |
| POST | `/admin/users/:id/invitation` | `users.create` **(reauth)** | `{ reason }` | `UserDetail` with a new `invitation` | INVITED users only; the previous token stops working. Audit: `USER_INVITATION_ISSUED`. |
| PATCH | `/admin/users/:id` | `users.edit` | `UpdateUser` | `UserDetail` | Audit: `USER_UPDATED`. |
| POST | `/admin/users/:id/status` | `users.suspend` **(reauth)** | `UserStatusChange` | `UserDetail` | Suspending revokes all sessions. A user cannot suspend themself. Audit: `USER_STATUS_CHANGED`. |
| POST | `/admin/users/:id/reset-mfa` | `users.reset_mfa` **(reauth)** | `ResetMfa` | `UserDetail` | Revokes the factors and sessions. The user must enrol at next login. Audit: `USER_MFA_RESET`. |
| GET | `/admin/users/:id/sessions` | `users.view` | `IdParam` | `{ id, createdAt, lastUsedAt, ipAddress, userAgent, mfaVerified }[]` | |
| POST | `/admin/users/:id/sessions/revoke-all` | `users.suspend` | `{ reason }` | `OkResponse` | Audit: `USER_UPDATED`. |

### 6.2 Roles and permissions

| Method | Path | Permission | Request | Response | Notes / Audit |
| --- | --- | --- | --- | --- | --- |
| GET | `/admin/permissions` | `roles.view` | none | `Permission[]` | The catalogue, grouped by module in the UI. |
| GET | `/admin/roles` | `roles.view` | `PaginationQuery` | `Paginated<Role>` | |
| GET | `/admin/roles/:id` | `roles.view` | `IdParam` | `Role` | |
| POST | `/admin/roles` | `roles.configure` **(reauth)** | `CreateRole` | `Role` (201) | Custom roles only. Must not combine `tally.submit` or `tally.capture` with `tally.verify`, or `tally.verify` with `tally.approve` (400 `SEPARATION_OF_DUTIES`). Audit: `ROLE_CREATED`. |
| PATCH | `/admin/roles/:id` | `roles.configure` **(reauth)** | `UpdateRole` | `Role` | System roles return 409 `IMMUTABLE_RECORD`. Audit: `ROLE_UPDATED`. |
| GET | `/admin/roles/:id/effective-access` | `roles.view` | `IdParam` | `{ permissions: Permission[]; modules: string[] }` | The "preview effective access" view in S07. |

### 6.3 Role assignments

| Method | Path | Permission | Request | Response | Notes / Audit |
| --- | --- | --- | --- | --- | --- |
| GET | `/admin/role-assignments` | `roles.view` | `PaginationQuery & { userId?, roleId?, includeRevoked? }` | `Paginated<RoleAssignment>` | |
| POST | `/admin/role-assignments` | `roles.assign` **(reauth)** | `CreateRoleAssignment` | `RoleAssignment` (201) | Checks the scope target exists, and `expiresAt > validFrom`. A POLLING_STATION grant stores the station's code (`pollingStationCode`, set by a DB trigger) and matches that code in every registry version of the station's election cycle (station lineage). A user cannot grant a role to themself. Grantor scope: an organisation-wide assignment needs an organisation-wide `roles.assign`; a geographic one must lie inside the grantor's `roles.assign` geography (and election cycle); a grantor whose `roles.assign` is not organisation-wide can only hand out permissions they hold over the same target (403 `OUT_OF_SCOPE`). Audit: `ROLE_ASSIGNED`. |
| POST | `/admin/role-assignments/:id/revoke` | `roles.assign` **(reauth)** | `RevokeRoleAssignment` | `RoleAssignment` | The assignment must lie inside the grantor's `roles.assign` scope. Soft revoke (`revokedAt`, `revokedById`, reason). Audit: `ROLE_REVOKED`. |

### 6.4 Audit log

| Method | Path | Permission | Request | Response | Notes / Audit |
| --- | --- | --- | --- | --- | --- |
| GET | `/admin/audit-events` | `audit.view` | `AuditQuery` | `Paginated<AuditEvent>` | Ordered by `seq desc`. |
| GET | `/admin/audit-events/:id` | `audit.view` | `IdParam` | `AuditEvent` | Recomputes `eventHash` and returns `integrity: 'OK' \| 'MISMATCH'`. |
| POST | `/admin/audit-events/export` | `audit.export` **(reauth)** | `AuditQuery` | `SignedUrlResponse` | CSV stored with `purpose: 'EXPORT'`. Audit: `AUDIT_EXPORTED`. |

## 7. Dashboard and notifications (admin module)

| Method | Path | Permission | Request | Response | Notes |
| --- | --- | --- | --- | --- | --- |
| GET | `/dashboard/summary` | `dashboard.view` | `{ electionCycleId? }` | `DashboardSummary` | KPIs: expected stations, forms received, verified, awaiting review, open discrepancies. Tally KPIs only appear for callers with `tally.view`. "Stations with forms" match filed forms to the approved registry by station code within the cycle (station lineage), so a registry amendment never turns a received station into a missing one. `agent_coverage` is AVAILABLE when the `field` module is on and the caller holds `field.deployment.view`: approved-registry stations in that scope with a CONFIRMED / CHECKED_IN / CHECKED_OUT chief or station agent ÷ all such stations; otherwise NOT_AVAILABLE. |
| GET | `/notifications` | Authenticated | `NotificationCenterQuery` (`unreadOnly`, `module`, `severity`, `awaitingAck`) | `Paginated<NotificationCenterItem>` | In-app rows only. Hides notifications whose `module` the user can no longer access. Served by `NotificationCenterService.list` (§29) from the admin `DashboardController`. |
| POST | `/notifications/:id/read` | Authenticated | `IdParam` | `OkResponse` | Only the caller's own in-app notifications. |
| POST | `/notifications/read-all` | Authenticated | none | `OkResponse` | Own in-app notifications. |

The notification centre (§29) adds counts, preferences, acknowledgement and the delivery log. The web dashboard
(`/dashboard`) also shows campaign and finance tiles per permission (`components/campaign/campaign-kpis.tsx`),
read from the §24–27 list endpoints' `total`, `GET /finance/ledger` and `GET /notifications/counts`.

## 8. Tenant module activation (implemented: `apps/api/src/tenant-modules`)

Modules (`TENANT_MODULES` in `@ngao360/shared`): `tally` (default **on**), `office` (default
**off**) and `field` (default **off**; the War Room also needs `tally`). State lives in `tenant_modules` (RLS); a missing row means the default. `GET /auth/me`
returns `modules: TenantModuleKey[]` and the web navigation hides switched-off modules.
Controllers tagged `@RequireModule('office')` answer **403 `MODULE_DISABLED`** when the tenant has
the module off (`ModuleGuard`, which runs after `RbacGuard`). Switching a module off never deletes
data.

| Method | Path | Permission | Request | Response | Notes / Audit |
| --- | --- | --- | --- | --- | --- |
| GET | `/workspace/modules` | `workspace.view` | none | `TenantModuleState[]` | `config` for `office` is `OfficeModuleConfig` with defaults applied. |
| PUT | `/workspace/modules/:key` | `workspace.configure` **(reauth)** | `TenantModuleParam` + `UpdateTenantModule` | `TenantModuleState[]` | `config` replaces the module config and is validated (`OfficeModuleConfigSchema`; 400 `VALIDATION_FAILED`). Enabling `office` creates the portal service account once (`portal-service@<slug>.invalid`, no password, no roles, `DEACTIVATED`) and stores its id in `config.portalServiceUserId`. Audit: `MODULE_UPDATED` (before/after enabled + config). |

`OfficeModuleConfig` (all fields have safe defaults): `publicPortalEnabled` (false),
`publicProjectsEnabled` (false), `portalDisplayName`, `controllerName`, `dataProtectionContact`,
`caseRetentionMonths` (36), `contactRetentionMonths` (12), `caseCloseRequiresSecondPerson` (true),
`portalCountyUnitId`, `portalCaseCategories` (all), `portalServiceUserId`, `captchaProvider`
(`none` \| `turnstile` \| `hcaptcha`), `captchaSiteKey`. Read it in services with
`TenantModulesService.officeConfig(tx)`.

---

## Office conventions (§9–13)

These rules apply to every Office endpoint. Shared DTOs are in `packages/shared/src/office/`.

| Topic | Rule |
| --- | --- |
| Module | Every authenticated Office controller is tagged `@RequireModule('office')`. Public controllers call `PublicPortalService.resolve(slug)`, which answers 404 for unknown tenants, office off, or portal off (same response, so the portal never reveals which organisations exist). |
| Separation from campaign data | Office data lives only in the Office tables and behind `office.*` permissions (blueprint 15.2). Never join Office records to tally, campaign or user-profile data for analytics, and never expose requester data to campaign roles. |
| Tenancy | Use `prisma.tenantTx()`. Before linking any id from a request (assignee, institution, case, correspondence, unit, file), load it inside the same transaction; RLS makes other tenants' rows invisible, so a missing row is 404/400. FK checks alone do not stop cross-tenant ids. |
| Geography | Cases and projects store the lowest unit given (`geographicUnitId`: ward, constituency or county; polling centres are refused) plus denormalised `countyId`, `constituencyId`, `wardId`. Use `resolveOfficeLocation(tx, unitId)` to fill them, `officeScopeWhere(scope)` to filter lists and the geo kinds `officeCase` / `officeProject` on record routes (`@RequirePermission('office.cases.view', { geo: { kind: 'officeCase', from: 'params', key: 'id' } })`). A record without a location is visible only to organisation-wide grants. Correspondence, appointments and meetings are not geographic: any grant of the permission is enough. |
| Concurrency | Mutable records carry `version`. Mutations take `expectedVersion` and update with `where: { id, version: expectedVersion }`, incrementing `version`; a stale value returns 409 `CONFLICT`. Writers that check a status and then insert (case events, evidence, referral updates, milestone and evidence verification) take a row lock (`SELECT … FOR UPDATE`) or write conditionally. Identical files uploaded at the same moment resolve to one `stored_files` row (`INSERT … ON CONFLICT DO NOTHING`). |
| Transitions | Use the shared `canTransition*()` helpers; an illegal move returns 409 `INVALID_TRANSITION`. Every transition writes the named audit action with before/after status and reason. |
| History | `case_events` (except a redaction through `ngao_redact_citizen_case`), `meeting_decisions` and `correspondence_attachments` are append-only (DB trigger, `IMMUTABLE_RECORD`). No Office row is ever deleted (DB trigger). Project evidence may change only its verification and publication fields. Case submission content and references are immutable. |
| Files | `StorageService.storeImmutable(purpose: 'CORRESPONDENCE' \| 'CASE_EVIDENCE' \| 'PROJECT_EVIDENCE')` (images and PDFs only, sniffed, ≤ 25 MB). Downloads use `StorageService.signedUrl()` and every issuance is audited with `FILE_SOURCE_ACCESSED` (`entityType` = the Office record). Public-portal photos are stored with `uploadedById = config.portalServiceUserId`. |
| References | Internal sequential references via `nextReference(tx, tenantId, OFFICE_REFERENCE_PREFIX.*)`: `COR-IN-YYYY-NNNNNN`, `COR-OUT-…`, `APT-…`, `CASE-…`, `PRJ-…`. Citizen cases also get a random `publicReference` (`BG-7K3F-9Q2X`, prefix from the tenant slug initials) and an 8-character tracking code shown once; only its SHA-256 is stored (`allocatePublicReference`, `trackingCodeMatches`). |
| allowedActions | Detail DTOs return `allowedActions` computed from the caller's permissions, the record state and separation-of-duties rules, so the UI never offers an action the API will refuse. |
| Personal data | Requester contact is only in `citizen_case_contacts` and only returned by `GET /office/cases/:id/contact`. No list or detail DTO, export, notification or log line contains contact fields. |
| Anonymous requesters | Public-portal audit events (`omitRequestMetadata`) and the portal photo's `FILE_STORED` event keep no source IP or user agent. Record history endpoints return `sourceIp`/`userAgent` only to holders of `audit.view`. Portal photos are re-encoded on the server before storage (metadata such as EXIF GPS removed, neutral file name `portal-photo.<ext>`); HEIC, which the server cannot decode, is refused (400). |
| Staff-recorded contact | `minimalContact()`: phone or email only for the chosen channel and only with consent (400 otherwise); a name alone may be kept with preference NONE. Same rule for `PUT …/contact`. |
| Notifications | `module: 'office'` notifications are hidden (list, read, read-all) while the tenant has the Office module off. |
| Language | Never present the office as controlling a project another body is legally responsible for. Use the labels in `PROJECT_STATUS_LABELS` / `PROJECT_STAGE_KIND_LABELS`; never call a `COMPLETED` project "complete" without "reported" / "awaiting verification". |

## 9. Correspondence (`apps/api/src/modules/office/correspondence`) — S23

Web: `/office/correspondence`, `/office/correspondence/[id]`. Items with sensitivity
`CONFIDENTIAL` or `HIGHLY_RESTRICTED` are invisible (lists filter them out; detail returns 404)
unless the caller holds `office.correspondence.confidential`; creating or raising an item to those
levels needs it too.

| Method | Path | Permission | Request | Response | Notes / Audit |
| --- | --- | --- | --- | --- | --- |
| GET | `/office/correspondence` | `office.correspondence.view` | `CorrespondenceQuery` | `Paginated<CorrespondenceSummary>` | `view=mine` (assigned to caller), `overdue` (`responseDueDate < today` and status not RESPONDED/SENT/FILED/ARCHIVED), `unassigned`. `q` matches reference, subject, sender/recipient and external reference. Default sort `receivedAt`/`createdAt` desc. |
| GET | `/office/correspondence/:id` | `office.correspondence.view` | `IdParam` | `CorrespondenceDetail` | Includes attachments, replies and linked case ref (case title not included). |
| POST | `/office/correspondence` | `office.correspondence.create` | `CreateCorrespondence` | `CorrespondenceDetail` (201) | Reference `COR-IN-…` or `COR-OUT-…`. Status: INCOMING → `RECEIVED` (or `ASSIGNED` when `assignedToId` given); OUTGOING → `DRAFT`. `inReplyToId` must be an item of the opposite direction. `linkedCaseId` is checked for existence only. Audit: `CORRESPONDENCE_CREATED`. |
| PATCH | `/office/correspondence/:id` | `office.correspondence.edit` | `UpdateCorrespondence` | `CorrespondenceDetail` | Not allowed in `ARCHIVED` (409 `IMMUTABLE_RECORD`). Lowering sensitivity from CONFIDENTIAL+ needs `.confidential` and a `reason`. Audit: `CORRESPONDENCE_UPDATED` (changed fields only). |
| POST | `/office/correspondence/:id/assign` | `office.correspondence.edit` | `AssignCorrespondence` | `CorrespondenceDetail` | Assignee must be ACTIVE and hold `office.correspondence.view` (and `.confidential` for restricted items) — 400 otherwise. `RECEIVED` → `ASSIGNED` when assigning; unassigning returns `ASSIGNED` to `RECEIVED` and is refused (400) while `IN_PROGRESS`. Raising the sensitivity to a restricted level re-checks the current assignee (400). Audit: `CORRESPONDENCE_ASSIGNED`. Sends an in-app notification (`module: 'office'`, `type: 'correspondence.assigned'`, link `/office/correspondence/:id`). |
| POST | `/office/correspondence/:id/transition` | `office.correspondence.edit` | `CorrespondenceTransition` | `CorrespondenceDetail` | `CORRESPONDENCE_STATUS_TRANSITIONS`: `DRAFT→SENT\|ARCHIVED`, `RECEIVED→ASSIGNED\|FILED`, `ASSIGNED→IN_PROGRESS\|RESPONDED\|FILED`, `IN_PROGRESS→RESPONDED\|FILED`, `RESPONDED→FILED`, `SENT→FILED`, `FILED→ARCHIVED`. `SENT` sets `sentAt` (default now). `reason` required for `FILED` from RECEIVED/ASSIGNED/IN_PROGRESS (no response) and for `ARCHIVED`. Audit: `CORRESPONDENCE_STATUS_CHANGED`. |
| POST | `/office/correspondence/:id/attachments` | `office.correspondence.edit` | multipart `file` + `metadata` (`AddCorrespondenceAttachment` JSON) | `CorrespondenceAttachment` (201) | `storeImmutable(purpose: 'CORRESPONDENCE')`. A duplicate hash reuses the stored file; attaching the same file twice to one item returns 409. Not allowed when ARCHIVED. Audit: `FILE_STORED` (new files) + `CORRESPONDENCE_ATTACHMENT_ADDED`. |
| GET | `/office/correspondence/:id/attachments/:attachmentId/url` | `office.correspondence.view` | params | `SignedUrlResponse` | Inline view; `?download=1` for download. Audit: `FILE_SOURCE_ACCESSED` every call. |
| GET | `/office/correspondence/:id/history` | `office.correspondence.view` | `IdParam` | `AuditEvent[]` | Audit events for the item and its attachments, oldest first. |

## 9a. Office form support (`apps/api/src/modules/office/workspace`)

Small reads the Office screens need whether or not the public portal is on. Schemas in
`packages/shared/src/office/workspace.ts`.

| Method | Path | Permission | Request | Response | Notes / Audit |
| --- | --- | --- | --- | --- | --- |
| GET | `/office/geography` | any of `office.cases.view`, `office.cases.create`, `office.projects.view`, `office.correspondence.view`, `office.appointments.view`, `office.meetings.view` | — | `OfficeGeography` | The county in `portalCountyUnitId` (first county when unset), its constituencies and wards. Used by filters and forms. |
| GET | `/office/privacy-notice` | any of `office.cases.create`, `office.cases.view`, `office.appointments.manage`, `office.appointments.view` | — | `OfficePrivacyNotices` | `{ portal, appointment }` built from the tenant's controller name, contact and retention settings; read to walk-in and phone requesters. |
| GET | `/office/cases/:id/assignable-officers` | `office.cases.manage` **(geo)** | `IdParam` | `UserRef[]` | Active users holding `office.cases.manage` over the case location. `assign` still re-checks. |
| GET | `/office/cases/:id/possible-duplicates` | `office.cases.view` **(geo)** | `IdParam` | `PossibleDuplicate[]` | Triage hint (blueprint 9.2): same category and ward (or constituency), submitted within 30 days, description similarity ≥ 0.25, scope-filtered. A hint only; an officer closes a duplicate explicitly. |

Implicit rules (from the Office API build, docs/CHANGE_REQUESTS.md): `assign` is refused in SUBMITTED
and CLOSED (triage first); adding timeline events, evidence, milestones or referral updates does not bump
the parent record's `version`; new project evidence starts `PENDING_VERIFICATION`; the user who last
recorded a milestone's status cannot verify it; `POST /public/:slug/track` also runs the abuse check.

## 10. Appointments and meetings (`apps/api/src/modules/office/appointments`)

Web: `/office/appointments` (diary with appointments and meetings tabs).

### 10.1 Appointments

| Method | Path | Permission | Request | Response | Notes / Audit |
| --- | --- | --- | --- | --- | --- |
| GET | `/office/appointments` | `office.appointments.view` | `AppointmentQuery` | `Paginated<AppointmentSummary>` | `from`/`to` filter on `confirmedStart`, falling back to `preferredStart`. `view=mine` (assigned to caller), `pending` (REQUESTED), `follow_up` (`followUpRequired` and `followUpDate ≤ today+7`). |
| GET | `/office/appointments/:id` | `office.appointments.view` | `IdParam` | `AppointmentDetail` | Contact fields are visible to holders of `office.appointments.view` (the requester gave them for this purpose). |
| POST | `/office/appointments` | `office.appointments.manage` | `CreateAppointment` | `AppointmentDetail` (201) | Reference `APT-…`, status `REQUESTED`. `privacyNoticeVersion` must equal `CURRENT_APPOINTMENT_PRIVACY_NOTICE_VERSION` (400 otherwise): the clerk reads or shows `appointmentPrivacyNotice()` to the requester. Audit: `APPOINTMENT_CREATED`. Audit snapshots never contain contact values: record `hasPhone` / `hasEmail` booleans instead (applies to every Office audit event). |
| PATCH | `/office/appointments/:id` | `office.appointments.manage` | `UpdateAppointment` | `AppointmentDetail` | Not in DECLINED/CANCELLED/COMPLETED except follow-up fields. Audit: `APPOINTMENT_UPDATED`. |
| POST | `/office/appointments/:id/transition` | `office.appointments.manage` | `AppointmentTransition` | `AppointmentDetail` | `APPOINTMENT_STATUS_TRANSITIONS`: `REQUESTED→CONFIRMED\|DECLINED\|CANCELLED`, `CONFIRMED→RESCHEDULED\|CANCELLED\|COMPLETED\|NO_SHOW`, `RESCHEDULED→CONFIRMED\|CANCELLED\|COMPLETED\|NO_SHOW`, `NO_SHOW→RESCHEDULED`. CONFIRMED/RESCHEDULED need `confirmedStart` (`confirmedEnd`, and on create/update `preferredEnd`, must be later, compared as instants whatever the offsets); COMPLETED needs `outcome` (sets `outcomeRecordedAt`; optional follow-up fields); DECLINED/CANCELLED/NO_SHOW need `reason`. Audit: `APPOINTMENT_STATUS_CHANGED`. |

### 10.2 Meetings (lean)

| Method | Path | Permission | Request | Response | Notes / Audit |
| --- | --- | --- | --- | --- | --- |
| GET | `/office/meetings` | `office.meetings.view` | `MeetingQuery` | `Paginated<MeetingSummary>` | CONFIDENTIAL+ meetings are visible only to the owner and listed participants with `userId`. |
| GET | `/office/meetings/:id` | `office.meetings.view` | `IdParam` | `MeetingDetail` | |
| POST | `/office/meetings` | `office.meetings.manage` | `CreateMeeting` | `MeetingDetail` (201) | Status `SCHEDULED`. Audit: `MEETING_CREATED`. |
| PATCH | `/office/meetings/:id` | `office.meetings.manage` | `UpdateMeeting` | `MeetingDetail` | `status`: `SCHEDULED→HELD\|CANCELLED` only. Setting `minutes` sets `minutesRecordedById/At`; editing minutes after they were recorded needs `reason`. Audit: `MEETING_UPDATED`. |
| POST | `/office/meetings/:id/action-items` | `office.meetings.manage` | `SaveMeetingActionItem` | `MeetingActionItem` (201) | Audit: `MEETING_ACTION_ITEM_SAVED`. |
| PATCH | `/office/meetings/:id/action-items/:itemId` | `office.meetings.manage` | `MeetingActionItemParam` + `SaveMeetingActionItem` | `MeetingActionItem` | `DONE` sets `completedAt`. Never deleted (cancel instead). Audit: `MEETING_ACTION_ITEM_SAVED`. |
| POST | `/office/meetings/:id/decisions` | `office.meetings.manage` | `RecordMeetingDecision` | `MeetingDecision` (201) | Append-only; to change a decision record a new one with `supersedesId`. Audit: `MEETING_DECISION_RECORDED`. |

## 11. Citizen cases (`apps/api/src/modules/office/cases`) — S25

Web: `/office/cases`, `/office/cases/[id]`. Record routes use the geo target
`{ kind: 'officeCase', from: 'params', key: 'id' }`; lists use `officeScopeWhere(scopeFor(auth, 'office.cases.view'))`.

**Stages and transitions** (`CASE_STATUS_TRANSITIONS`, blueprint 9.2):

| From | To | Endpoint | Permission | Rules |
| --- | --- | --- | --- | --- |
| SUBMITTED | TRIAGE | `transition` | `office.cases.manage` | Sets `triagedById/At`. |
| SUBMITTED, TRIAGE | CLOSED | `close` | `office.cases.close` | Triage closure (duplicate, out of jurisdiction, spam, withdrawn). |
| TRIAGE, REOPENED | ASSIGNED | `assign` (or `transition` when an assignee exists) | `office.cases.manage` | Needs an assignee. |
| ASSIGNED, REFERRED, REOPENED, RESOLUTION_PROPOSED, CITIZEN_FEEDBACK | IN_PROGRESS | `transition` | `office.cases.manage` | |
| TRIAGE, ASSIGNED, IN_PROGRESS | REFERRED | `referrals` (POST) | `office.cases.referral` | Creates a `CaseReferral`. |
| ASSIGNED, IN_PROGRESS, REFERRED | RESOLUTION_PROPOSED | `propose-resolution` | `office.cases.manage` | Records `resolutionSummary` (requester-visible) and `resolutionProposedById/At`. |
| RESOLUTION_PROPOSED | CITIZEN_FEEDBACK | `transition` | `office.cases.manage` | Asks the requester to confirm (public update). |
| ASSIGNED, IN_PROGRESS, REFERRED, REOPENED | CLOSED | `close` | `office.cases.close` | Closure without a resolution (referred out, withdrawn, duplicate, no response, out of jurisdiction, abusive). `RESOLVED` is refused here (400): `caseClosureAllowed()`. |
| RESOLUTION_PROPOSED, CITIZEN_FEEDBACK | CLOSED | `close` | `office.cases.close` | Any reason, including `RESOLVED`. With `caseCloseRequiresSecondPerson` (default true) the closer must differ from `resolutionProposedById` (403 `SEPARATION_OF_DUTIES`). |
| CLOSED | REOPENED | `reopen` | `office.cases.close` | A new event; the earlier closure fields are kept in the timeline (`CLOSED` event) and cleared on the row. Not after a redaction (409). |

**Sensitivity.** `CONFIDENTIAL` and `HIGHLY_RESTRICTED` cases need `office.cases.confidential`
covering the case: without it every case route answers 404 and lists, duplicate hints and the
portal's duplicate note leave them out. Recording a restricted case, or raising or lowering a case
to or from a restricted level, needs the permission; the assignee of a restricted case must hold
it too (400 otherwise).

**Internal notes.** `office.cases.internal_notes` is checked against the case geography, for
reading (`NOTE`, `CONTACT_ATTEMPT` in `events`) and for writing every internal type.

Every transition appends a `CaseEvent` (`STATUS_CHANGED`, `ASSIGNED`, `REFERRED`,
`RESOLUTION_PROPOSED`, `CLOSED`, `REOPENED`) with `fromStatus`/`toStatus`, plus a `PUBLIC_UPDATE`
when `publicMessage` is given, and an audit event in the same transaction.

| Method | Path | Permission | Request | Response | Notes / Audit |
| --- | --- | --- | --- | --- | --- |
| GET | `/office/cases` | `office.cases.view` | `CaseQuery` | `Paginated<CaseSummary>` | Scope-filtered. `view=mine` (assignee = caller), `unassigned`, `triage` (SUBMITTED+TRIAGE), `review_due` (`nextReviewDate ≤ today`, not CLOSED), `closed`. `geographicUnitId` matches county/constituency/ward columns. `q` matches reference, public reference and title (not description). |
| GET | `/office/cases/:id` | `office.cases.view` **(geo)** | `IdParam` | `CaseDetail` | `events` omits `NOTE` and `CONTACT_ATTEMPT` unless the caller holds `office.cases.internal_notes`. Never includes contact fields. |
| POST | `/office/cases` | `office.cases.create` | `CreateCase` | `CreateCaseResponse` (201) | Staff-recorded case (source ≠ PORTAL). Reference `CASE-…`; also allocates `publicReference` and a tracking code — the response is `CreateCaseResponse` = `CaseDetail` + `trackingCode` (shown once, for the officer to give the requester). The caller must cover the location with `office.cases.create` scope (403 `OUT_OF_SCOPE`). `privacyNoticeVersion` must equal `CURRENT_PORTAL_PRIVACY_NOTICE_VERSION`. Contact (if any) goes to `citizen_case_contacts`; `consentToContact` false with a contact preference other than NONE → 400. Status `SUBMITTED`, or `ASSIGNED` when `assigneeId` is given (triage recorded as the creator). Events: `SUBMITTED` (PUBLIC). Audit: `CASE_CREATED` (no contact data in before/after). |
| PATCH | `/office/cases/:id` | `office.cases.manage` **(geo)** | `UpdateCase` | `CaseDetail` | Category, priority, title, location, sensitivity, `nextReviewDate`, `duplicateOfId`. Description is immutable (DB guard). Not in CLOSED. Audit: `CASE_UPDATED`. |
| POST | `/office/cases/:id/assign` | `office.cases.manage` **(geo)** | `AssignCase` | `CaseDetail` | Assignee must be ACTIVE and hold `office.cases.manage` covering the case location (400 otherwise). From TRIAGE/REOPENED moves to ASSIGNED; otherwise only changes the assignee. Event `ASSIGNED` (INTERNAL) + public "assigned to an officer" (no name). Audit: `CASE_ASSIGNED`. Notification to the assignee (`type: 'case.assigned'`). |
| POST | `/office/cases/:id/transition` | `office.cases.manage` **(geo)** | `CaseTransition` | `CaseDetail` | Targets TRIAGE, ASSIGNED, IN_PROGRESS, CITIZEN_FEEDBACK (table above). Audit: `CASE_STATUS_CHANGED`. |
| POST | `/office/cases/:id/events` | `office.cases.manage` **(geo)**; `NOTE` and `CONTACT_ATTEMPT` also need `office.cases.internal_notes` **(geo)** | `AddCaseEvent` | `CaseEvent` (201) | Visibility derived from type (NOTE/CONTACT_ATTEMPT → INTERNAL, PUBLIC_UPDATE → PUBLIC). Not in CLOSED except NOTE (the case row is locked, so an update never lands after a concurrent close). Audit: `CASE_EVENT_ADDED` (`after` holds type and visibility; the body of a NOTE is never copied into the audit event). |
| POST | `/office/cases/:id/evidence` | `office.cases.manage` **(geo)** | multipart `file` + `metadata` (`AddCaseEvidence`) | `CaseEvent` (201) | `storeImmutable(purpose: 'CASE_EVIDENCE')`; event `EVIDENCE_ADDED`. PUBLIC evidence is listed (description only, no file) on the tracking page. Audit: `FILE_STORED` + `CASE_EVIDENCE_ADDED`. |
| GET | `/office/cases/:id/files/:fileId/url` | `office.cases.view` **(geo)** | params | `SignedUrlResponse` | Only files linked to the case's events. Audit: `FILE_SOURCE_ACCESSED`. |
| GET | `/office/cases/:id/contact` | `office.cases.contact.view` **(geo)** | `IdParam` | `CaseContact` (404 when none) | Every read is audited: `CASE_CONTACT_VIEWED` (no contact values in the event). |
| PUT | `/office/cases/:id/contact` | `office.cases.contact.view` + `office.cases.manage` **(geo)** | `UpdateCaseContact` | `CaseContact` | Correction at the requester's request. Audit: `CASE_CONTACT_UPDATED` (field names only). |
| POST | `/office/cases/:id/contact/erase` | `office.cases.close` **(geo)** **(reauth)** | `EraseCaseContact` | `CaseContact` | Data-subject erasure or retention: nulls name/phone/email, sets `erasedAt`; the case body stays. Audit: `CASE_CONTACT_ERASED`. |
| POST | `/office/cases/:id/redact` | `office.cases.close` **(geo)** **(reauth)** | `RedactCase` | `CaseDetail` | CLOSED cases only (400 otherwise; 409 when already redacted). Through the DB function `ngao_redact_citizen_case`: description → `[Personal content removed]`, location text cleared, title → category label, body and photo link of every REQUESTER event cleared, `redactedAt` set; contact erased. Permanent: no reopen afterwards. Audit: `CASE_REDACTED` (`trigger: REQUEST`). The retention job does the same `caseRetentionMonths` after closure (`trigger: RETENTION`, actor SYSTEM) and erases contacts after `retentionUntil`. |
| GET | `/office/cases/:id/referrals` | `office.cases.view` **(geo)** | `IdParam` | `CaseReferral[]` | |
| POST | `/office/cases/:id/referrals` | `office.cases.referral` **(geo)** | `CreateCaseReferral` | `CaseDetail` | Institution must be active. Moves TRIAGE/ASSIGNED/IN_PROGRESS → REFERRED (already REFERRED: adds another referral). `shareRequesterContact` true is refused (400) without `consentToContact`. Events `REFERRED` (INTERNAL, note) + `PUBLIC_UPDATE` ("Referred to <institution name>"). Audit: `CASE_REFERRED`. |
| PATCH | `/office/cases/:id/referrals/:referralId` | `office.cases.referral` **(geo)** | `CaseReferralParam` + `UpdateCaseReferral` | `CaseReferral` | Status `SENT→ACKNOWLEDGED\|RESPONDED\|NO_RESPONSE\|CLOSED`, `ACKNOWLEDGED→RESPONDED\|NO_RESPONSE\|CLOSED`, `RESPONDED\|NO_RESPONSE→CLOSED`. Event `REFERRAL_UPDATED` (INTERNAL). Audit: `CASE_REFERRAL_UPDATED`. |
| POST | `/office/cases/:id/propose-resolution` | `office.cases.manage` **(geo)** | `ProposeCaseResolution` | `CaseDetail` | → RESOLUTION_PROPOSED. Event `RESOLUTION_PROPOSED` (PUBLIC, the summary) and optional INTERNAL note. Audit: `CASE_STATUS_CHANGED`. |
| POST | `/office/cases/:id/close` | `office.cases.close` **(geo)** | `CloseCase` | `CaseDetail` | SoD rule above. DUPLICATE needs `duplicateOfId` (another case of the tenant). Sets closure fields; contact `retentionUntil = closedAt + contactRetentionMonths`. Event `CLOSED` (PUBLIC, `publicMessage` or a default). Audit: `CASE_CLOSED`. |
| POST | `/office/cases/:id/reopen` | `office.cases.close` **(geo)** | `ReopenCase` | `CaseDetail` | → REOPENED; clears closure fields and `retentionUntil`. Event `REOPENED` (PUBLIC). Audit: `CASE_REOPENED`. |
| GET | `/office/cases/:id/history` | `office.cases.view` **(geo)** | `IdParam` | `AuditEvent[]` | Audit events for the case, its referrals and evidence. |

## 12. Projects and institutions (`apps/api/src/modules/office/projects`) — S26, S27

Web: `/office/projects`, `/office/projects/[id]`. Record routes use the geo target
`{ kind: 'officeProject', from: 'params', key: 'id' }`.

**Status transitions** (`PROJECT_STATUS_TRANSITIONS`): `PROPOSED→COMMITTED|APPROVED|CANCELLED`,
`COMMITTED→APPROVED|CANCELLED`, `APPROVED→FUNDED|PROCUREMENT|ONGOING|CANCELLED`,
`FUNDED→PROCUREMENT|ONGOING|CANCELLED`, `PROCUREMENT→ONGOING|DELAYED|CANCELLED`,
`ONGOING→DELAYED|COMPLETED|CANCELLED`, `DELAYED→ONGOING|COMPLETED|CANCELLED`,
`COMPLETED→VERIFIED_COMPLETED|ONGOING`, `VERIFIED_COMPLETED→ONGOING` (verification withdrawn; needs
`office.projects.verify`), `CANCELLED→` none. The stage kind (`PROJECT_STAGE_KIND`) is returned on
every DTO so screens always distinguish commitment / approved / implementation / reported complete /
verified complete.

**Accountability rules** (blueprint 9.3): every project names `responsibleInstitution` (required)
and `commitmentSource`; screens and the public view say the office *tracks* the project and name the
institution responsible. `VERIFIED_COMPLETED` needs `completionEvidenceSufficient()` on the cited
evidence (at least one VERIFIED inspection report, completion certificate or handover document — a
photograph alone never suffices), a verifier who is not the completion reporter (DB check
`projects_verified_completion_check`) and not the uploader of any cited evidence. The cited ids are
stored (`completionEvidenceIds`); if one of them later leaves VERIFIED and the rest no longer suffice,
the project returns to COMPLETED and the withdrawal is audited (`PROJECT_STATUS_CHANGED` with
`verificationWithdrawn`). Evidence verification and completion verification take the project row
lock, so they never both commit on stale reads.

**Approval.** APPROVED and every later stage need `approvalAuthority` (400 on create, transition or
update; DB check `projects_approval_authority_check`), so a pledge is never shown as an approved project.

**Publication approval covers content.** On a published project, a change to an always-public field
or to a field of an approved public section (`publicFacingProjectChanges()`, including a new or
renamed milestone when milestones are public and a new delay reason when the schedule is public)
sets `isPublic` false and audits `PROJECT_PUBLICATION_CHANGED` with `withdrawnBecauseChanged`. A
holder of `office.projects.publish` must approve it again.

| Method | Path | Permission | Request | Response | Notes / Audit |
| --- | --- | --- | --- | --- | --- |
| GET | `/office/projects` | `office.projects.view` | `ProjectQuery` | `Paginated<ProjectSummary>` | Scope-filtered with `officeScopeWhere`. `currentMilestone` = lowest-sequence milestone not DONE/CANCELLED. |
| GET | `/office/projects/:id` | `office.projects.view` **(geo)** | `IdParam` | `ProjectDetail` | |
| POST | `/office/projects` | `office.projects.edit` | `CreateProject` | `ProjectDetail` (201) | Reference `PRJ-…`. `initialStatus` PROPOSED/COMMITTED/APPROVED. Institutions must exist and be active. Coordinates both or neither. `contractAmountIsPublic` false keeps the amount out of every public view. Audit: `PROJECT_CREATED`. |
| PATCH | `/office/projects/:id` | `office.projects.edit` **(geo)** | `UpdateProject` | `ProjectDetail` | Not in CANCELLED. Changing `expenditureReported` resets `expenditureVerificationStatus` to UNVERIFIED (and clears the verifier). Changing the responsible institution on a published project needs `reason`. Audit: `PROJECT_UPDATED` (changed fields). |
| POST | `/office/projects/:id/transition` | `office.projects.edit` **(geo)**; to ONGOING from VERIFIED_COMPLETED needs `office.projects.verify` | `ProjectTransition` | `ProjectDetail` | DELAYED needs `delayReason`; COMPLETED needs `actualCompletionDate` and sets `completionReportedById/At`; leaving COMPLETED/VERIFIED_COMPLETED clears completion fields. Audit: `PROJECT_STATUS_CHANGED`. |
| POST | `/office/projects/:id/verify-completion` | `office.projects.verify` **(geo)** **(reauth)** | `VerifyProjectCompletion` | `ProjectDetail` | COMPLETED → VERIFIED_COMPLETED under the rules above (403 `SEPARATION_OF_DUTIES`; 400 with `details` naming the missing evidence type). Audit: `PROJECT_COMPLETION_VERIFIED` (cites evidence ids). |
| POST | `/office/projects/:id/verify-expenditure` | `office.projects.verify` **(geo)** | `VerifyProjectExpenditure` | `ProjectDetail` | Needs a reported expenditure. Verifier must not be the last editor of `expenditureReported` (from the audit stream). Audit: `PROJECT_VERIFICATION_RECORDED` (`entityType: 'ProjectExpenditure'`). |
| GET | `/office/projects/:id/milestones` | `office.projects.view` **(geo)** | `IdParam` | `ProjectMilestone[]` | Ordered by `sequence`. |
| POST | `/office/projects/:id/milestones` | `office.projects.edit` **(geo)** | `CreateProjectMilestone` | `ProjectMilestone` (201) | Audit: `PROJECT_MILESTONE_SAVED`. |
| PATCH | `/office/projects/:id/milestones/:milestoneId` | `office.projects.edit` **(geo)** | `ProjectMilestoneParam` + `UpdateProjectMilestone` | `ProjectMilestone` | Changing status or `actualDate` resets verification to UNVERIFIED. Never deleted (CANCELLED instead). Audit: `PROJECT_MILESTONE_SAVED`. |
| POST | `/office/projects/:id/milestones/:milestoneId/verify` | `office.projects.verify` **(geo)** | `VerifyRecord` | `ProjectMilestone` | Only DONE milestones can be VERIFIED. Audit: `PROJECT_VERIFICATION_RECORDED` (`entityType: 'ProjectMilestone'`). |
| POST | `/office/projects/:id/evidence` | `office.projects.evidence` **(geo)** | multipart `file` + `metadata` (`CreateProjectEvidence`) | `ProjectEvidence` (201) | `storeImmutable(purpose: 'PROJECT_EVIDENCE')`. Location metadata only when given (never extracted from EXIF automatically). Audit: `FILE_STORED` + `PROJECT_EVIDENCE_ADDED`. |
| POST | `/office/projects/:id/evidence/:evidenceId/verify` | `office.projects.verify` **(geo)** | `ProjectEvidenceParam` + `VerifyRecord` | `ProjectEvidence` | Verifier ≠ uploader (403 `SEPARATION_OF_DUTIES`; also a DB check). DISPUTED evidence loses `isPublic`. Audit: `PROJECT_VERIFICATION_RECORDED` (`entityType: 'ProjectEvidence'`). |
| GET | `/office/projects/:id/evidence/:evidenceId/url` | `office.projects.view` **(geo)** | params | `SignedUrlResponse` | Audit: `FILE_SOURCE_ACCESSED`. |
| PUT | `/office/projects/:id/publication` | `office.projects.publish` **(geo)** **(reauth)** | `UpdateProjectPublication` | `ProjectDetail` | Sets `isPublic`, `publicFields`, `publicSummary`; sets `publishedById/At` when publishing. `contractAmount` only with `contractAmountIsPublic` (DB check); `publicEvidenceIds` must be VERIFIED evidence of the project (sets `isPublic` on exactly those). Mandatory public fields cannot be removed. Unpublishing keeps the settings. Audit: `PROJECT_PUBLICATION_CHANGED`. |
| GET | `/office/projects/:id/public-preview` | `office.projects.view` **(geo)** | `IdParam` | `PublicProjectDetail` | Exactly what §13.4 would return if published (same mapper). |
| GET | `/office/projects/:id/history` | `office.projects.view` **(geo)** | `IdParam` | `AuditEvent[]` | S27 update history. |

### 12.5 Institution registry

| Method | Path | Permission | Request | Response | Notes / Audit |
| --- | --- | --- | --- | --- | --- |
| GET | `/office/institutions` | any of `office.cases.view`, `office.projects.view`, `office.correspondence.view` | `InstitutionQuery` | `Paginated<Institution>` | Default `active=true`. Used by referral and project forms. |
| GET | `/office/institutions/:id` | same | `IdParam` | `Institution` | |
| POST | `/office/institutions` | `office.institutions.manage` | `CreateInstitution` | `Institution` (201) | Name unique per tenant (409). Audit: `INSTITUTION_CREATED`. |
| PATCH | `/office/institutions/:id` | `office.institutions.manage` | `UpdateInstitution` | `Institution` | Deactivate with `isActive: false` (never deleted); a deactivated institution stays on existing projects and referrals. Audit: `INSTITUTION_UPDATED`. |

## 13. Public portal (`apps/api/src/modules/office/public`) — S24 and public project pages

Web (outside the authenticated shell): `/p/[tenantSlug]` (home), `/p/[tenantSlug]/request` (S24),
`/p/[tenantSlug]/track`, `/p/[tenantSlug]/projects`, `/p/[tenantSlug]/projects/[id]`.

Every route here is `@Public()`, guarded by the portal's own `PublicRateLimitGuard` (per IP +
tenant + bucket, 429 `RATE_LIMITED` with `Retry-After`; env `PUBLIC_RATE_LIMIT_WINDOW_SECONDS`
600, `PUBLIC_SUBMIT_RATE_LIMIT_MAX` 5, `PUBLIC_TRACK_RATE_LIMIT_MAX` 30, `PUBLIC_READ_RATE_LIMIT_MAX`
600) in addition to the global throttler, and resolves the tenant with `PublicPortalService.resolve()`
(404 for unknown/disabled). Writes call `PublicAbuseService.check(dto, config, req.ip)`: a filled
honeypot field `website` or a failed captcha (when `captchaProvider ≠ none`; bind a verifier to
`CAPTCHA_VERIFIER`, otherwise it fails closed) returns a generic 400 `ABUSE_CHECK_FAILED`. The CSRF
header rule (§1) applies to public POSTs too. Responses never contain internal notes, staff names,
requester contact details, assignees or other requesters' data. Public reads are not audited;
public writes are (actor `SYSTEM`, `actorId` null).

### 13.1 Portal info (implemented)

| Method | Path | Permission | Request | Response | Notes |
| --- | --- | --- | --- | --- | --- |
| GET | `/public/:tenantSlug/portal` | public (`read`) | `PublicTenantParam` | `PublicPortalInfo` | Display name, privacy notice (what / why / who / how long / rights / contact, versioned: `CURRENT_PORTAL_PRIVACY_NOTICE_VERSION`), offered categories, constituencies and wards under `portalCountyUnitId`, captcha config, honeypot field name, photo limits, `projectsEnabled`. |

### 13.2 Submit a request (S24)

| Method | Path | Permission | Request | Response | Notes / Audit |
| --- | --- | --- | --- | --- | --- |
| POST | `/public/:tenantSlug/requests` | public (`submit`) | multipart: `payload` (JSON `PublicCaseSubmission`) + optional `photo` | `PublicCaseReceipt` (201) | No account. Checks: abuse check; `privacyNoticeVersion` equals the current version (409 `CONFLICT` "the notice changed, reload"); category offered; `geographicUnitId` is a ward or constituency under `portalCountyUnitId`; photo JPEG/PNG/WebP/HEIC ≤ `MAX_PUBLIC_PHOTO_BYTES` (sniffed). Creates `citizen_cases` (source PORTAL, status SUBMITTED, `createdById` null, random `publicReference`, `trackingCodeHash`), `citizen_case_contacts` only when `contactPreference ≠ NONE` (minimal fields; nothing stored otherwise), event `SUBMITTED` (PUBLIC, actor REQUESTER) and, with a photo, `storeImmutable(purpose: 'CASE_EVIDENCE', uploadedById: config.portalServiceUserId)` + event `EVIDENCE_ADDED` (INTERNAL). Receipt shows `publicReference` and `trackingCode` **once**. An acknowledgement notification is queued only when contact was given and consented (`NOTIFICATION_QUEUE`, channel per preference). Audit: `CASE_PUBLIC_SUBMITTED` (no contact values, no description text). |

### 13.3 Track and feedback

| Method | Path | Permission | Request | Response | Notes / Audit |
| --- | --- | --- | --- | --- | --- |
| POST | `/public/:tenantSlug/track` | public (`track`) | `PublicTrackRequest` | `PublicCaseStatus` | POST so the code never appears in URLs or logs. Unknown reference and wrong code return the same 404 (compare with `trackingCodeMatches`, constant time). Shows `CASE_STATUS_PUBLIC_STAGE` and its label, PUBLIC events only (message + time, no actor), referral institution names, `feedbackAllowed` in RESOLUTION_PROPOSED/CITIZEN_FEEDBACK. Not audited. |
| POST | `/public/:tenantSlug/track/feedback` | public (`submit`) | `PublicCitizenFeedback` | `PublicCaseStatus` | Same lookup rules; only when `feedbackAllowed` (409 otherwise). Appends `CITIZEN_FEEDBACK` (PUBLIC, actor REQUESTER, body = response label + message). `CONFIRM_RESOLVED` from RESOLUTION_PROPOSED moves to CITIZEN_FEEDBACK (the case is still closed by an officer); `DISPUTE` from either state moves to IN_PROGRESS and notifies the assignee; `ADDITIONAL_INFORMATION` changes no status. Audit: `CASE_CITIZEN_FEEDBACK`. |

### 13.4 Public projects

Only projects with `isPublic = true`, and only when `publicProjectsEnabled`. Mandatory fields are
always present (name, category, location, status + stage kind labels, responsible institution,
commitment source, completion verification label); optional sections appear only when listed in
`publicFields`. Every detail response carries `disclaimer: PROJECT_PUBLIC_DISCLAIMER`.
`completionVerificationLabel`: VERIFIED_COMPLETED → "Completion verified"; COMPLETED → "Reported
complete — awaiting independent verification"; otherwise "Not complete".

| Method | Path | Permission | Request | Response | Notes |
| --- | --- | --- | --- | --- | --- |
| GET | `/public/:tenantSlug/projects` | public (`read`) | `PublicProjectQuery` | `Paginated<PublicProjectSummary>` | Filters: category, stage kind, unit (ward/constituency), `q` on name. |
| GET | `/public/:tenantSlug/projects/:id` | public (`read`) | `PublicProjectParam` | `PublicProjectDetail` | 404 when not public. `contractAmount` only when approved and `contractAmountIsPublic`. `evidence` lists only evidence with `isPublic` (always VERIFIED). No staff names (`projectOwner` is the published owner name). |
| GET | `/public/:tenantSlug/projects/:id/evidence/:evidenceId/file` | public (`read`) | `PublicEvidenceParam` | JPEG/PNG/WebP: 200 with a copy re-encoded without metadata, `inline; filename="evidence-<id>.<ext>"`. PDF: 302 to a short-lived signed URL, `attachment` with a neutral name, only when `malwareScanStatus = CLEAN`. | Only `isPublic` evidence of a public project. HEIC and unscanned documents are never served (404; publication refuses them). `X-Content-Type-Options: nosniff`. Not audited (public record). |

---

## 14. Web client usage

```ts
import { api } from '@/lib/api-client';
import type { Paginated, SubmissionSummary, SubmissionQuery } from '@ngao360/shared';

const page = await api.get<Paginated<SubmissionSummary>>('/tally/submissions', {
  query: { view: 'awaiting_me', page: 1 } satisfies Partial<SubmissionQuery>,
});

const form = new FormData();
form.set('file', file);
form.set('metadata', JSON.stringify(createSubmission)); // CreateSubmission
await api.post('/tally/submissions', form);
```

Handle `ApiRequestError.code`. `REAUTH_REQUIRED` opens the password prompt (`POST /auth/reauth`) and then retries.
`SEPARATION_OF_DUTIES` shows a plain-language explanation. `OUT_OF_SCOPE` and `FORBIDDEN` show a no-access state.

---

## Field and election operations conventions (§15–22)

Status: **implemented** in `apps/api/src/modules/field/**` (integration suites `test/field-*.spec.ts`,
`test/sync`, `test/warroom`, end-to-end `test/election-day-rehearsal.e2e.spec.ts`). Data model:
migrations `20261122000000_station_code_lineage`, `20261122000100_field_election_ops` and
`20261123000000_field_integration` (registry index for War Room roll-ups); shared DTOs in
`packages/shared/src/field/`; DTO classes in `apps/api/src/modules/field/field.dto.ts`. Additions
and interpretations agreed during the build are folded in below and listed in
`docs/CHANGE_REQUESTS.md` (Field). Blueprint: 6.1–6.3, 7, 10.3, 11.3, 13.4, 15.

### 15. Rules for every field, War Room and sync endpoint

| Topic | Rule |
| --- | --- |
| Module | Field controllers are tagged `@RequireModule('field')`; the War Room is `@RequireModule('field', 'tally')`. A switched-off module answers **403 `MODULE_DISABLED`**. `field` defaults **off**; `FieldModuleConfig` (`packages/shared/src/field/common.ts`) is read with `TenantModulesService.fieldConfig(tx)`. `PUT /workspace/modules/field` validates it (400 `VALIDATION_FAILED`). |
| Election cycle | Every field record belongs to one election cycle. Requests take an optional `electionCycleId`; otherwise `resolveFieldCycle()` uses `FieldModuleConfig.electionCycleId`, then the ACTIVE cycle with the latest election date (404 when none). Responses carry the cycle; screens show `DATA_PROVENANCE_LABELS` for SYNTHETIC / HISTORICAL cycles. |
| Station lineage | Stations are named by **`pollingStationCode`** within the cycle, never by registry row id. New records resolve the code against the cycle's **APPROVED** registry version with `resolveStationByCode()` (400 `VALIDATION_FAILED`, path `pollingStationCode`, when the code is not in it). Responses return `FieldLocation` (`loadFieldLocations()`); `station.inApprovedRegistry=false` flags a code dropped by a later amendment (the record stays). Area-level records (field reports, incidents) may instead give a ward, constituency or county `geographicUnitId` (`resolveFieldLocation()`). |
| Geography and scope | Record routes use the geo kinds in `FIELD_GEO_KIND` (`fieldAgent`, `fieldDeployment`, `fieldReadinessChecklist`, `fieldReport`, `fieldIncident`), e.g. `@RequirePermission('field.incidents.triage', { geo: { kind: 'fieldIncident', from: 'params', key: 'id' } })`. Lists filter with `fieldScopeWhere(permissions.scopeFor(auth, perm))` (agents: `agentScopeWhere`). Cycle-limited grants reach only records of that cycle. Station-scoped grants (`POLLING_STATION`) match by station code in the granted station's cycle, so they survive registry amendments. Writes that name a station or area in the body check it with `scopeAllows(scope, fieldGeoLocation(cols))` → 403 `OUT_OF_SCOPE`. |
| Tenancy | `prisma.tenantTx()` only. Load every id from a request (agent, user, file, unit, template, incident) inside the transaction; RLS hides other tenants' rows, so a missing row is 404 / 400. |
| Concurrency | Mutable records carry `version`. Mutations take `expectedVersion` and write `where: { id, version: expectedVersion }` with `version: { increment: 1 }`; a stale value answers **409 `CONFLICT`** with `details: { currentVersion, serverState }` (the current DTO), so the person can review it. Never overwrite silently. |
| Idempotency | Device-originated writes (`POST /field/reports`, `POST /field/incidents`, `POST /field/deployments/:id/confirm`, `POST /field/deployments/:id/check-in`, every sync item) carry `clientIdempotencyKey` (UUID chosen by the device when the record is first saved locally) and `deviceId`. They go through `ClientSubmissionLedger` (`client_submissions`, unique per tenant + user + key, advisory-locked): **first time** → apply, record `ACCEPTED`, 201; **same key, same payload** (SHA-256 of `canonicalPayload`) → **200** with the original result and header `Idempotent-Replay: true`, nothing applied again; **same key, different payload or kind** → **409 `IDEMPOTENCY_KEY_REUSED`**, nothing applied; a key last answered REJECTED/CONFLICT is re-evaluated on retry. Field reports and incidents also have a unique (tenant, author, key) index as a backstop. |
| Offline age | Items saved on the device more than `FieldModuleConfig.offlineMaxAgeHours` (72) ago, or more than 5 minutes in the future, are refused: 400 `VALIDATION_FAILED` (direct) / `REJECTED` + `STALE` (sync). |
| Transitions | Use the shared helpers (`canTransitionAgent`, `canTransitionDeployment`, `canTransitionFieldReport`, `canTransitionIncident`); an illegal move answers **409 `INVALID_TRANSITION`**. Every transition writes its audit action with before/after status and reason, plus the append-only history row named below. |
| History | Never deleted (DB triggers, even for the owner role): every field table. Append-only (no UPDATE): `agent_status_events`, `deployment_events`, `field_report_evidence`, `incident_events`, `incident_evidence`, `incident_subjects`, `station_status_events`. Immutable content: the original incident report (category as reported, initial severity, time, location, description, reporter, offline metadata), submitted field-report content, an ACTIVE or RETIRED report template, a deployment's agent / station / cycle / role, an ACCEPTED ledger result. A DB error `IMMUTABLE_RECORD` maps to 409. |
| Separation of duties | Report reviewer ≠ author (DB check). Template activator ≠ creator (DB check). Incident closer ≠ reporter and ≠ resolver (DB check); incident triager ≠ reporter. An agent confirms and checks in only their own deployments (`agents.user_id = caller`, else 403 `FORBIDDEN`). Nobody reveals or edits their own agent record's sensitive data. Role-level rules: `incident-resolve-vs-close`, `field-agent-vs-agent-admin` (`ROLE_SOD_RULES`). Violations answer 403 `SEPARATION_OF_DUTIES`. |
| Agent personal data | National ID number, phone, M-Pesa number and next of kin live only in `agent_sensitive`. Lists and details return `phoneMasked` / `nationalIdMasked` and `has*` flags only. Full values only from `POST /field/agents/:id/reveal` (`field.agents.reveal_sensitive`, **reauth**, reason, the fields asked for, `Cache-Control: no-store`); every reveal and change is audited with field **names**, never values. No export, notification, log line or audit snapshot carries the values. Never store copies of ID documents (blueprint 6.3). |
| Incident wording | Descriptions are neutral factual accounts. Categories describe what was observed (`INCIDENT_CATEGORY_LABELS`). A named person or body may be recorded only in the restricted subject record (`field.incidents.view_subject`), never in descriptions, lists, notifications or exports; nothing is labelled fraudulent or criminal (blueprint 15.3). |
| Location privacy | Check-in coordinates are accepted only when `checkInLocationEnabled` (400 otherwise) and only from the agent's own check-in; they are returned only in `DeploymentDetail.checkInLocation` to holders of `field.deployment.view` over the station, never in lists, events or audit snapshots (`hasLocation` only). No continuous tracking. |
| War Room wording | Every War Room response carries `label: WAR_ROOM_LABEL` ("Unofficial, internal operational figures. Not an official result or IEBC record.") and `completeness` (`expected`, `reported`, `missing`, `ratio`). A station without an update is counted as **missing**, never as zero. Tally figures link to the internal parallel tally (`PARALLEL_TALLY_DISCLAIMER` applies); no winner / elected / declared wording (`findForbiddenTallyLanguage`). |
| Files | Evidence is stored with `StorageService.storeImmutable(purpose: 'FIELD_EVIDENCE')` (accreditation documents: `'AGENT_DOCUMENT'`): sniffed images and PDFs only, ≤ 25 MB, content-addressed, immutable. Records attach files by id; a caller may attach only files they uploaded, recorded as an upload claim (`field_file_claims`, one per uploader and purpose, because identical bytes are stored once per tenant and return the first uploader's row), else 400. Signed URLs are audited with `FILE_SOURCE_ACCESSED` (`entityType` = the field record). |
| Notifications | In-app only for now (blueprint 10.3), `module: 'field'` (or `'warroom'`), hidden while the module is off: `deployment.assigned` (agent's user, link `/m`), `field_report.returned` (author, link `/m`), `incident.reported` for HIGH/CRITICAL initial severity (incident desk in scope), `incident.assigned` (assignee), `incident.escalated` (holders of `warroom.command` in scope). Bodies carry the reference and category label only. |
| Errors | `VALIDATION_FAILED` details use `{ path, message }`; answer issues use `path: ['answers', questionKey]`. Conflicts use 409 with `details.serverState` where a current record exists. |

### 16. Agents (`apps/api/src/modules/field/agents`) — S13

Web: `/field/agents`, `/field/agents/[id]`. Geo kind `fieldAgent` = home county/constituency/ward plus
the stations of the agent's active deployments.

| Method | Path | Permission | Request | Response | Notes / Audit |
| --- | --- | --- | --- | --- | --- |
| GET | `/field/agents` | `field.agents.view` | `AgentQuery` | `Paginated<AgentSummary>` | `agentScopeWhere`. `accreditationStatus`, `trainingCompleted/Total` and `activeDeployments` are for `electionCycleId` (default field cycle). `undeployedOnly` = no ASSIGNED/CONFIRMED/CHECKED_IN deployment. `q` matches reference and names, never phone or ID. |
| GET | `/field/agents/:id` | `field.agents.view` **(geo)** | `FieldIdParam` | `AgentDetail` | Masked values only. `allowedActions` from permissions and state. |
| POST | `/field/agents` | `field.agents.create` | `CreateAgent` | `AgentDetail` (201) | `homeWardId` must be a WARD inside the caller's `field.agents.create` scope (403 `OUT_OF_SCOPE`). Reference `nextReference(tx, tenantId, 'AGT', cycleYear)`. Status `RECRUITED`; appends `agent_status_events` (null → RECRUITED). `privacyNoticeVersion` = config `agentPrivacyNoticeVersion`, acknowledged now. Writes `agent_sensitive` and the masked columns (`maskPhone`, `maskNationalId`, `hasMpesaNumber`, `hasNextOfKin`). Audit: `AGENT_CREATED` (no sensitive values, only `has*` flags). |
| PATCH | `/field/agents/:id` | `field.agents.edit` **(geo)** | `UpdateAgent` | `AgentDetail` | `expectedVersion`. A new `homeWardId` must also be in scope. Not allowed when WITHDRAWN (409 `IMMUTABLE_RECORD`). Audit: `AGENT_UPDATED` (changed fields). |
| POST | `/field/agents/:id/status` | `field.agents.edit` **(geo)** | `AgentStatusChange` | `AgentDetail` | `AGENT_STATUS_TRANSITIONS`. Moving to INACTIVE or WITHDRAWN while the agent has active deployments answers 409 `CONFLICT` with `details.deploymentIds` (replace them first). Appends `agent_status_events`. Audit: `AGENT_STATUS_CHANGED`. |
| POST | `/field/agents/:id/reveal` | `field.agents.reveal_sensitive` **(geo, reauth)** | `RevealAgentSensitive` | `AgentSensitiveReveal` | Only the requested fields. Refused for the caller's own agent record, including a record the caller was ever linked to (link history from the audit stream; 403 `SEPARATION_OF_DUTIES`). Geography: the agent's **home area** only, and only grants for every cycle or the current field cycle (a grant limited to another cycle, or a deployment of the agent into the caller's area, does not reach personal data). `Cache-Control: no-store`. Audit: `AGENT_SENSITIVE_REVEALED` with `after: { fields }` and the reason. |
| PUT | `/field/agents/:id/sensitive` | `field.agents.reveal_sensitive` **(geo, reauth)** | `UpdateAgentSensitive` | `AgentDetail` | Given fields replace stored ones (`null` clears). Refreshes the masked columns and flags; bumps `version`. Audit: `AGENT_SENSITIVE_UPDATED` with changed field names only. |
| POST | `/field/agents/:id/trainings` | `field.agents.training` **(geo)** | `RecordTraining` | `AgentTraining` (201) | Audit: `AGENT_TRAINING_RECORDED`. |
| PATCH | `/field/agents/:id/trainings/:trainingId` | `field.agents.training` **(geo)** | `TrainingParam` + `UpdateTraining` | `AgentTraining` | The training must belong to the agent (404). Audit: `AGENT_TRAINING_RECORDED` (before/after). |
| PUT | `/field/agents/:id/accreditation` | `field.agents.accreditation` **(geo)** | `SetAccreditation` | `AgentAccreditation` | Upsert per (agent, cycle). Records the status; NGAO360 never grants accreditation. Audit: `AGENT_ACCREDITATION_RECORDED`. |
| POST | `/field/agents/:id/accreditation/evidence` | `field.agents.accreditation` **(geo)** | multipart `file` + `metadata` `{ electionCycleId }` | `AgentAccreditation` | `storeImmutable(purpose: 'AGENT_DOCUMENT')` → `evidenceFileId`. Accreditation letters only, never ID copies (UI warning). Audit: `FILE_STORED`, `AGENT_ACCREDITATION_RECORDED`. |
| POST | `/field/agents/:id/user` | `field.agents.edit` **(geo)** | `LinkAgentUser` | `AgentDetail` | Links (or with `null` unlinks) an ACTIVE user of the tenant who is not linked to another agent (409). Grants no role: the station-scoped Polling agent role is assigned in `/admin/role-assignments`. Nobody links themself, or links or unlinks a record they are or were linked to (403 `SEPARATION_OF_DUTIES`). Audit: `AGENT_USER_LINKED`. |
| GET | `/field/agents/:id/history` | `field.agents.view` **(geo)** | `FieldIdParam` | `AuditEvent[]` | Agent, training, accreditation and reveal events, oldest first (reveals show who, when, which fields, why). |

#### 16.4 Mobile home and evidence (`field-me.controller.ts`)

| Method | Path | Permission | Request | Response | Notes / Audit |
| --- | --- | --- | --- | --- | --- |
| GET | `/field/me` | any of `field.reports.submit`, `field.incidents.report`, `field.deployment.checkin` | — | `FieldMe` | The caller's agent record (non-sensitive), deployments of that agent in the field cycle (ASSIGNED, CONFIRMED, CHECKED_IN, plus CHECKED_OUT today) as `MyAssignment` (with `checkInLocationEnabled` and notice), ACTIVE templates usable in the caller's scope, unread field notices. `can.uploadResultForm` = `tally.submit` and the tally module on. No other agent's data. |
| POST | `/field/evidence` | any of `field.reports.submit`, `field.incidents.report`, `field.incidents.triage` | multipart `file` | `FieldEvidenceUpload` (201; 200 when `duplicate`) | `storeImmutable(purpose: 'FIELD_EVIDENCE')`. The file is attached later by id (reports, incidents, sync items). Photos are not re-encoded yet (gap: EXIF location stays in the stored original; only signed, audited access). Audit: `FILE_STORED`. |

### 17. Deployment (`apps/api/src/modules/field/deployment`) — S14

Web: `/field/deployment`; mobile `/m`, `/m/checkin`. Geo kind `fieldDeployment`. Status
`DEPLOYMENT_STATUS_TRANSITIONS`; active = ASSIGNED, CONFIRMED, CHECKED_IN. DB backstops: one active
deployment per agent and shift (`deployments_agent_active_shift_key`), one active chief agent per
station and shift (`deployments_station_chief_active_key`), slot identity immutable.

| Method | Path | Permission | Request | Response | Notes / Audit |
| --- | --- | --- | --- | --- | --- |
| GET | `/field/deployments` | `field.deployment.view` | `DeploymentQuery` | `Paginated<DeploymentSummary>` | `fieldScopeWhere`. REPLACED/CANCELLED only with `includeInactive`. No coordinates. |
| GET | `/field/deployments/coverage` | `field.deployment.view` | `DeploymentCoverageQuery` | `DeploymentCoverage` | Planner grid: every station of the approved registry in scope (`expectedStations`, the denominator), its active slots (each with `deploymentId`, `agentId`, `agentDisplayName`, role, shift, status), `covered` = an active CHIEF_AGENT or STATION_AGENT. Over-coverage (two agents in one CHIEF/STATION role on overlapping shifts) is a non-blocking `SLOT_ALREADY_FILLED`; at most 200 conflicts. Uncovered stations are listed as "Not assigned", never dropped. `conflicts` lists double bookings, inactive or unaccredited agents and codes missing from the approved registry. |
| GET | `/field/deployments/:id` | `field.deployment.view` **(geo)** | `FieldIdParam` | `DeploymentDetail` | Events oldest first; `checkInLocation` only here; `warnings` = non-blocking conflicts. |
| POST | `/field/deployments` | `field.deployment.plan` | `CreateDeployment` | `DeploymentDetail` (201) | Station code resolved in the approved registry and inside the caller's plan scope (403 `OUT_OF_SCOPE`). Agent must exist, be ACTIVE or STANDBY (409 `CONFLICT`, kind `AGENT_NOT_ACTIVE`) and be visible to the caller. Blocking conflicts (`AGENT_DOUBLE_BOOKED` on an overlapping shift, `SLOT_ALREADY_FILLED` for a second chief agent) answer 409 `CONFLICT` with `details.conflicts: DeploymentConflict[]`; `AGENT_NOT_ACCREDITED` is a warning. Status ASSIGNED; event CREATED. Notification `deployment.assigned` to the agent's user. Audit: `DEPLOYMENT_CREATED`. |
| POST | `/field/deployments/bulk` | `field.deployment.plan` | `BulkCreateDeployment` (`{ items: CreateDeployment[] }`, 1–200) | `BulkDeploymentResult` (200) | Each item runs in its own transaction with exactly the checks of `POST /field/deployments`; one refusal never rolls back another. Per item `{ index, outcome: 'CREATED' \| 'REFUSED', deploymentId, warnings, error }`. Audit per created item: `DEPLOYMENT_CREATED`. |
| PATCH | `/field/deployments/:id` | `field.deployment.plan` **(geo)** | `UpdateDeployment` | `DeploymentDetail` | ASSIGNED or CONFIRMED only (409 `IMMUTABLE_RECORD`). A shift change re-checks double booking. Event UPDATED. Audit: `DEPLOYMENT_UPDATED`. |
| POST | `/field/deployments/:id/replace` | `field.deployment.plan` **(geo)** | `ReplaceDeployment` | `ReplaceDeploymentResult` (200) | One transaction: original → REPLACED (event REPLACED, reason), successor row with the same station, role and shift, `replacesDeploymentId` = original, status ASSIGNED. Successor checks as in create. From ASSIGNED, CONFIRMED or CHECKED_IN. Audit: `DEPLOYMENT_REPLACED` (both ids). |
| POST | `/field/deployments/:id/cancel` | `field.deployment.plan` **(geo)** | `CancelDeployment` | `DeploymentDetail` | ASSIGNED or CONFIRMED → CANCELLED with reason. The station shows as not assigned again. Audit: `DEPLOYMENT_STATUS_CHANGED`. |
| POST | `/field/deployments/:id/confirm` | `field.deployment.checkin` **(geo)** | `ConfirmDeployment` | `DeploymentDetail` (200; replay 200) | Own deployment only (403). ASSIGNED → CONFIRMED. Ledger kind `ASSIGNMENT_CONFIRMATION`. Already CONFIRMED or later with the same key → replay; deployment REPLACED or CANCELLED, or stale `expectedVersion` → 409 `CONFLICT` with `details: { reason: 'SERVER_CHANGED', serverState: DeploymentSummary }`. Event CONFIRMED. Audit: `DEPLOYMENT_STATUS_CHANGED`. |
| POST | `/field/deployments/:id/check-in` | `field.deployment.checkin` **(geo)** | `CheckIn` | `DeploymentDetail` (200; replay 200) | Own deployment only. CONFIRMED → CHECKED_IN; from ASSIGNED the server records CONFIRMED then CHECKED_IN (two events). `checkedInAt` is device time (offline age rules); the server keeps its own receipt time on the event. `location` only when enabled (400 otherwise). Ledger kind `CHECK_IN`; conflicts as for confirm. Audit: `DEPLOYMENT_CHECKED_IN` (`hasLocation`, never coordinates). |
| POST | `/field/deployments/:id/check-out` | `field.deployment.checkin` **(geo)** | `CheckOut` | `DeploymentDetail` | Own deployment only. CHECKED_IN → CHECKED_OUT. Audit: `DEPLOYMENT_STATUS_CHANGED`. |
| POST | `/field/deployments/roster-export` | `field.deployment.plan` **(reauth)** | `RosterExport` | `SignedUrlResponse` | CSV (station code and name, role, shift, status, agent reference and name, masked phone) in the caller's scope, `purpose: 'EXPORT'`, with the provenance label. Never unmasked values. Audit: `DEPLOYMENT_ROSTER_EXPORTED`. |

### 18. Readiness (`apps/api/src/modules/field/readiness`) — S15

Web: `/field/readiness`. Geo kind `fieldReadinessChecklist`. One checklist per (cycle, station code),
one item per `ReadinessCategory`; checklist `status` = `deriveReadinessStatus(items)`, rewritten on
every item change.

| Method | Path | Permission | Request | Response | Notes / Audit |
| --- | --- | --- | --- | --- | --- |
| GET | `/field/readiness/summary` | `field.readiness.view` | `ReadinessQuery` | `ReadinessSummary` | Denominator = stations of the approved registry in scope. Stations without a checklist count as not started, never ready. Agent figures (deployed, accredited, trained) for the same scope and cycle. |
| GET | `/field/readiness` | `field.readiness.view` | `ReadinessQuery` | `Paginated<ReadinessChecklist>` | `fieldScopeWhere`; filters by status, category and item status. |
| GET | `/field/readiness/:id` | `field.readiness.view` **(geo)** | `FieldIdParam` | `ReadinessChecklist` | |
| POST | `/field/readiness/generate` | `field.readiness.update` | `GenerateReadiness` | `GenerateReadinessResult` | Creates missing checklists (all categories NOT_STARTED) for approved-registry stations inside the caller's update scope (and `geographicUnitId`). Existing checklists are untouched. Audit: `READINESS_GENERATED` (counts). |
| PATCH | `/field/readiness/:id/items/:itemId` | `field.readiness.update` **(geo)** | `ReadinessItemParam` + `UpdateReadinessItem` | `ReadinessChecklist` | `expectedVersion` on the item. `reason` required for BLOCKED, NOT_APPLICABLE and leaving DONE (400). Audit: `READINESS_ITEM_UPDATED` (before/after item status and derived checklist status). |

### 19. Field reports (`apps/api/src/modules/field/reports`) — S11

Web: mobile `/m/report`; desktop review lists are built from these endpoints. Geo kind `fieldReport`.

#### 19.1 Templates (`report-templates.controller.ts`)

| Method | Path | Permission | Request | Response | Notes / Audit |
| --- | --- | --- | --- | --- | --- |
| GET | `/field/report-templates` | any of `field.reports.view`, `field.reports.submit`, `field.reports.templates` | `FieldReportTemplateQuery` | `Paginated<FieldReportTemplateDto>` | Callers with only `field.reports.submit` see ACTIVE templates only. |
| GET | `/field/report-templates/:id` | same | `FieldIdParam` | `FieldReportTemplateDto` | Any version (reports are read against the version they answered). |
| POST | `/field/report-templates` | `field.reports.templates` | `CreateFieldReportTemplate` | `FieldReportTemplateDto` (201) | DRAFT, `version` = max + 1 for the key. `findNonFactualQuestions()` must be empty (400 `VALIDATION_FAILED`, `path: ['schema', questionKey]`). Drafts are not edited; create a new version. Audit: `FIELD_REPORT_TEMPLATE_CREATED`. |
| POST | `/field/report-templates/:id/transition` | `field.reports.templates` (**reauth** for ACTIVE) | `FieldReportTemplateTransition` | `FieldReportTemplateDto` | DRAFT → ACTIVE by someone other than the creator (403 `SEPARATION_OF_DUTIES`; DB check). Activating retires the key's previous ACTIVE version in the same transaction (one ACTIVE per key, partial unique index). ACTIVE → RETIRED. Audit: `FIELD_REPORT_TEMPLATE_STATE_CHANGED`. |

#### 19.2 Reports

| Method | Path | Permission | Request | Response | Notes / Audit |
| --- | --- | --- | --- | --- | --- |
| GET | `/field/reports` | `field.reports.view`, or `field.reports.submit` (own reports only) | `FieldReportQuery` | `Paginated<FieldReportSummary>` | `fieldScopeWhere` on `field.reports.view`. `view=mine` = authored by the caller; `view=awaiting_review` = SUBMITTED or RETURNED-and-answered reports the caller did not author. |
| GET | `/field/reports/:id` | `field.reports.view` **(geo)**, or the author | `FieldIdParam` | `FieldReportDetail` | Answers are read against `templateVersion`. Coordinates only to `field.reports.view` holders. |
| POST | `/field/reports` | `field.reports.submit` | `CreateFieldReport` | `FieldReportDetail` (201; replay 200) | Template must be ACTIVE, or have been ACTIVE at `clientCreatedAt` for an offline item (else 409 `CONFLICT`, `reason: 'SERVER_CHANGED'`, `serverState` = current template). Location (station code or area) inside the caller's `field.reports.submit` scope, so a station-scoped agent reports on their own station(s) only (403 `OUT_OF_SCOPE`). A caller linked to a field agent record (`agents.user_id`) reports only for stations where they hold a deployment in the cycle (ASSIGNED, CONFIRMED, CHECKED_IN or CHECKED_OUT), even when the grant is wider (403 `OUT_OF_SCOPE`); callers without an agent record are limited by scope alone. `validateFieldAnswers()` must return nothing (400, `path: ['answers', key]`). `eventAt` within the offline age window. `supersedesReportId` must be the caller's own RETURNED report. Reference `FRP-YYYY-NNNNNN`. Ledger kind `FIELD_REPORT`. Audit: `FIELD_REPORT_SUBMITTED` (reference, template key/version, station code, offline flag, answered question keys; no free text). |
| POST | `/field/reports/:id/evidence` | `field.reports.submit` (author) or `field.reports.review` **(geo)** | `AttachEvidence` | `FieldReportDetail` | Files uploaded by the caller; not when CLOSED. Append-only links. Audit: `FIELD_REPORT_EVIDENCE_ADDED`. |
| GET | `/field/reports/:id/evidence/:fileId/url` | `field.reports.view` **(geo)** or the author | params, `DownloadQuery` | `SignedUrlResponse` | Audit: `FILE_SOURCE_ACCESSED`. |
| POST | `/field/reports/:id/review` | `field.reports.review` **(geo)** | `ReviewFieldReport` | `FieldReportDetail` | `FIELD_REPORT_REVIEW_TRANSITIONS`; reviewer ≠ author (403 `SEPARATION_OF_DUTIES`; DB check). RETURNED notifies the author (`field_report.returned`); ESCALATED notifies `warroom.command` holders in scope. The author answers a return with a new report (`supersedesReportId`), never an edit. Audit: `FIELD_REPORT_REVIEWED`. |

### 20. Incidents (`apps/api/src/modules/field/incidents`) — S17 and the incident desk

Web: mobile `/m/incident`; desktop `/field/incidents`, `/field/incidents/[id]`; War Room queue.
Geo kind `fieldIncident`. Workflow (blueprint 7.3) `INCIDENT_STATUS_TRANSITIONS`:
REPORTED → TRIAGED → ASSIGNED → ESCALATED → RESOLVED → CLOSED (CLOSED → TRIAGED on reopen).
Every step appends an `incident_events` row in the same transaction as the status change.

| Method | Path | Permission | Request | Response | Notes / Audit |
| --- | --- | --- | --- | --- | --- |
| GET | `/field/incidents` | `field.incidents.view`, or `field.incidents.report` (own incidents only) | `IncidentQuery` | `Paginated<IncidentSummary>` | `fieldScopeWhere`. `view=open` (not CLOSED), `assigned_to_me`, `unassigned`, `mine` (reported by caller). Default order: severity rank desc, then `reportedAt` asc. Never includes subject records. |
| GET | `/field/incidents/:id` | `field.incidents.view` **(geo)**, or the reporter | `FieldIdParam` | `IncidentDetail` | Reporter-only callers get the report, status, outcome and their own events (other people's notes hidden). `hasSubject` only; the record itself is §20 subject. **Sensitivity:** CONFIDENTIAL content needs `field.incidents.triage` or `field.incidents.view_subject` over the incident, HIGHLY_RESTRICTED needs `field.incidents.view_subject`; other viewers (the reporter excepted) get `contentRestricted: true`, a placeholder description and preview, no location text or point, no notes, corrections or evidence, in lists and detail; history and evidence URLs answer 403. |
| POST | `/field/incidents` | `field.incidents.report` | `CreateIncident` | `IncidentDetail` (201; replay 200) | Location inside the caller's report scope (403 `OUT_OF_SCOPE`); station-scoped agents report on their own station(s), and a caller linked to an agent record only at stations they are deployed to (as for field reports). `IncidentSummary` carries `initialSeverity` (immutable) beside the current `severity`. `initialSeverity` = `severity` = `config.incidentSeverityDefaults[category]`; `reportedCategory` = `category`. `evidenceFileIds` uploaded by the caller (`original=true` links). Status REPORTED; reference `INC-YYYY-NNNNNN`; events REPORTED (+ EVIDENCE_ADDED). Ledger kind `INCIDENT`. HIGH/CRITICAL notify the incident desk in scope. Audit: `INCIDENT_REPORTED` (reference, category, severity, station code, offline flag, description length; not the text). |
| POST | `/field/incidents/:id/triage` | `field.incidents.triage` **(geo)** | `TriageIncident` | `IncidentDetail` | REPORTED → TRIAGED, or re-triage (severity, category, sensitivity) in TRIAGED / ASSIGNED / ESCALATED without a status change. Triager ≠ reporter (403 `SEPARATION_OF_DUTIES`). Event TRIAGED `{ severity, previousSeverity, category?, previousCategory? }`. Audit: `INCIDENT_TRIAGED`. |
| GET | `/field/incidents/:id/assignable-users` | `field.incidents.assign` **(geo)** | `FieldIdParam` | `UserRef[]` | Active users holding `field.incidents.triage` over the incident location (the rule assign and escalate re-check), by name. No audit (names only). |
| POST | `/field/incidents/:id/assign` | `field.incidents.assign` **(geo)** | `AssignIncident` | `IncidentDetail` | From TRIAGED, ASSIGNED (reassign; event `previousAssigneeId`), ESCALATED or RESOLVED (sending a resolution back) → ASSIGNED. Assignee ACTIVE and holding `field.incidents.triage` over the incident location (400). Event ASSIGNED; notification `incident.assigned`. Audit: `INCIDENT_ASSIGNED`. |
| POST | `/field/incidents/:id/escalate` | `field.incidents.escalate` **(geo)** | `EscalateIncident` | `IncidentDetail` | From TRIAGED, ASSIGNED or RESOLVED → ESCALATED, `escalatedTo`; optional new assignee (same rule). Event ESCALATED; notification `incident.escalated`. Audit: `INCIDENT_ESCALATED`. |
| POST | `/field/incidents/:id/events` | `field.incidents.triage` **(geo)**; `REFERRED` and evidence holds need `field.incidents.escalate`; the reporter may add `CORRECTION` to their own incident | `AddIncidentEvent` | `IncidentEvent` (201) | Append-only; not on CLOSED (409 `INVALID_TRANSITION`). A CORRECTION never changes the original report: the detail shows it beside the report. Evidence hold sets `evidenceHold` (release clears it). Audit: `INCIDENT_EVENT_ADDED`. |
| POST | `/field/incidents/:id/evidence` | reporter (`field.incidents.report`), or `field.incidents.triage` **(geo)** | `AttachEvidence` | `IncidentDetail` | Files uploaded by the caller; appends `incident_evidence` and an EVIDENCE_ADDED event. Audit: `INCIDENT_EVIDENCE_ADDED`. |
| GET | `/field/incidents/:id/evidence/:fileId/url` | `field.incidents.view` **(geo)** | params, `DownloadQuery` | `SignedUrlResponse` | Audit: `FILE_SOURCE_ACCESSED`. |
| POST | `/field/incidents/:id/resolve` | `field.incidents.resolve` **(geo)** | `ResolveIncident` | `IncidentDetail` | From TRIAGED, ASSIGNED or ESCALATED → RESOLVED with `outcome` and note. `DUPLICATE` needs `duplicateOfId` (another visible incident). UNRESOLVED is the outcome for disputed matters; they never read as resolved. Event RESOLVED. Audit: `INCIDENT_RESOLVED`. |
| POST | `/field/incidents/:id/close` | `field.incidents.close` **(geo)** | `CloseIncident` | `IncidentDetail` | RESOLVED → CLOSED with a closure note; closer ≠ reporter and ≠ resolver (403 `SEPARATION_OF_DUTIES`; DB check `incidents_closer_check`). Event CLOSED. Audit: `INCIDENT_CLOSED`. |
| POST | `/field/incidents/:id/reopen` | `field.incidents.close` **(geo)** | `ReopenIncident` | `IncidentDetail` | CLOSED → TRIAGED with a reason; resolution and closure fields are cleared on the row (they remain in events and audit). Event REOPENED. Audit: `INCIDENT_REOPENED`. |
| GET | `/field/incidents/:id/subject` | `field.incidents.view_subject` **(geo)** | `FieldIdParam` | `IncidentSubject[]` | Newest first. Every call is audited: `INCIDENT_SUBJECT_VIEWED`. |
| POST | `/field/incidents/:id/subject` | `field.incidents.view_subject` **(geo, reauth)** | `RecordIncidentSubject` | `IncidentSubject` (201) | Append-only. Event SUBJECT_RECORDED with the note "Restricted subject record added" only. Audit: `INCIDENT_SUBJECT_RECORDED` (length, reason; not the text). |
| GET | `/field/incidents/:id/history` | `field.incidents.view` **(geo)** | `FieldIdParam` | `AuditEvent[]` | Oldest first; subject views listed without content. 403 for a classified incident the caller may not read (see detail). |

### 21. War Room (`apps/api/src/modules/field/warroom`) — S16

Web: `/warroom` (layout renders `WarRoomBanner`). `@RequireModule('field', 'tally')`. Scope:
`warroom.view` geography and cycle (station-scoped grants by code). Station status (blueprint 7.2)
is derived **at read time** by `deriveStationStatus()` from deployments (best active status at the
station), field reports (any report = update received), open HIGH/CRITICAL incidents and tally intake
(station-form submissions matched by **station code**: none / received / verification pending /
verified (canonical VERIFIED) / flagged (open holding case, DISPUTED, QUARANTINED)), combined with a
manual override in `station_statuses`. Tally-derived states (FORM_RECEIVED, VERIFICATION_PENDING,
VERIFIED_FOR_PARALLEL_TALLY, and FLAGGED from a form) need `tally.view` over the station: without it
the caller's status is derived with no form (`formStatus: null`), and forms do not count as an update
for completeness. Tally panels use the stations inside **both** the `warroom.view` and the
`tally.view` scope. After close of polls every deployed station (assigned, confirmed, checked in or
checked out) or one with a field update is FORM_EXPECTED until a form is recorded. Reads never write:
a background recorder (`StationStatusRecorderService`, every `FIELD_WARROOM_RECORD_SECONDS`, default
60) computes the full derived status of every station, upserts `station_statuses` where it changed
and appends one DERIVED `station_status_events` row per change in one set-based statement (advisory
lock per tenant and cycle; one SYSTEM audit event `STATION_STATUS_DERIVED_RECORDED` per run with
changes). DERIVED event times are "observed at", within one interval of the change. Station history
shown without tally visibility leaves out tally-derived transitions. Manual changes append MANUAL rows.
Agent operations count a CHECKED_OUT slot as assigned, confirmed and checked in (the same definition
as the panel's completeness).

| Method | Path | Permission | Request | Response | Notes / Audit |
| --- | --- | --- | --- | --- | --- |
| GET | `/warroom/overview` | `warroom.view` | `WarRoomQuery` | `WarRoomOverview` | Six panels (blueprint 7.1), each with `label`, `asOf`, `completeness` (expected = approved-registry stations in scope) and `available`. Tally panels are counts only (drill-down needs tally permissions); `available=false` when the caller lacks `tally.view`, and the UI then shows "not available", not numbers. `systemHealth` uses the health checks and the sync ledger. |
| GET | `/warroom/stations` | `warroom.view` | `StationStatusQuery` | `StationStatusList` | One row per approved-registry station in scope, including stations with no record (NOT_ASSIGNED, missing), never omitted or zero-filled. `attentionOnly` = FLAGGED, NOT_ASSIGNED, FORM_EXPECTED or an open HIGH/CRITICAL incident. |
| GET | `/warroom/stations/:code` | `warroom.view` (scope by code) | `StationCodeParam` + `StationStatusParamQuery` | `StationStatusDetail` | Events newest first. 404 for codes outside the approved registry and scope. |
| PUT | `/warroom/stations/:code/status` | `warroom.command` (scope by code) **(reauth)** | `StationCodeParam` + `SetStationStatus` | `StationStatusDetail` | `FLAGGED` or `CLOSED` with a reason; `null` returns to the derived status. Appends a MANUAL event. Audit: `STATION_STATUS_SET`. Never sent to IEBC or anyone outside the organisation. |

### 22. Offline sync (`apps/api/src/modules/field/sync`) — blueprint 13.4

| Method | Path | Permission | Request | Response | Notes / Audit |
| --- | --- | --- | --- | --- | --- |
| POST | `/field/sync` | any of `field.reports.submit`, `field.incidents.report`, `field.deployment.checkin` | `SyncRequest` (≤ 50 items) | `SyncResponse` (200) | Items are applied in order, **each in its own tenant transaction** through the owning service with exactly the checks of the direct endpoint (kind → permission: FIELD_REPORT `field.reports.submit`, INCIDENT `field.incidents.report`, INCIDENT_NOTE CORRECTION by the reporter or `field.incidents.triage`, CHECK_IN and ASSIGNMENT_CONFIRMATION `field.deployment.checkin`; missing → REJECTED `FORBIDDEN`). Per item: `ACCEPTED` (new or `replayed: true`), `REJECTED` (`errorCode` = an `ERROR_CODES` value or `STALE`), `CONFLICT` (`IDEMPOTENCY_KEY_REUSED`, or `SERVER_CHANGED` with `serverState`). One failing item never rolls back another. The item's `idempotencyKey` must equal the payload's `clientIdempotencyKey` where the payload has one (else REJECTED `VALIDATION_FAILED`). Applied items write the direct endpoint's audit action with `metadata: { via: 'sync', deviceId }`; conflicts write `SYNC_CONFLICT_RECORDED` (kind, key, code; no payload). A malformed batch is 400 `VALIDATION_FAILED` as a whole. |
| GET | `/field/sync/status` | same | `SyncStatusQuery` | `SyncStatus` | The caller's own ledger rows for the device: last receipt, accepted count, open conflicts. Never another user's. |

Client obligations (blueprint 13.4, mobile safety in 11.3): generate the UUID key when the record is
first saved locally; keep payloads in the encrypted local queue (docs/ARCHITECTURE.md §14); show
local saves separately from server-confirmed uploads; retry with backoff using the same key; delete a
local item only after `ACCEPTED` (or a REJECTED the person has seen); keep `CONFLICT` items until the
person resolves them (resubmit as a new item with a new key, or discard); clear the queue on sign-out.

### Field status, audit and error summary

| Record | Transitions | History | Audit actions |
| --- | --- | --- | --- |
| Agent | `AGENT_STATUS_TRANSITIONS` | `agent_status_events` | `AGENT_CREATED`, `AGENT_UPDATED`, `AGENT_STATUS_CHANGED`, `AGENT_SENSITIVE_REVEALED`, `AGENT_SENSITIVE_UPDATED`, `AGENT_TRAINING_RECORDED`, `AGENT_ACCREDITATION_RECORDED`, `AGENT_USER_LINKED` |
| Deployment | `DEPLOYMENT_STATUS_TRANSITIONS` | `deployment_events` | `DEPLOYMENT_CREATED`, `DEPLOYMENT_UPDATED`, `DEPLOYMENT_STATUS_CHANGED`, `DEPLOYMENT_REPLACED`, `DEPLOYMENT_CHECKED_IN`, `DEPLOYMENT_ROSTER_EXPORTED` |
| Readiness | derived (`deriveReadinessStatus`) | audit | `READINESS_GENERATED`, `READINESS_ITEM_UPDATED` |
| Report template | DRAFT → ACTIVE → RETIRED | audit | `FIELD_REPORT_TEMPLATE_CREATED`, `FIELD_REPORT_TEMPLATE_STATE_CHANGED` |
| Field report | `FIELD_REPORT_REVIEW_TRANSITIONS` | `field_report_evidence`, audit | `FIELD_REPORT_SUBMITTED`, `FIELD_REPORT_REVIEWED`, `FIELD_REPORT_EVIDENCE_ADDED` |
| Incident | `INCIDENT_STATUS_TRANSITIONS` | `incident_events`, `incident_evidence`, `incident_subjects` | `INCIDENT_REPORTED`, `INCIDENT_TRIAGED`, `INCIDENT_ASSIGNED`, `INCIDENT_ESCALATED`, `INCIDENT_EVENT_ADDED`, `INCIDENT_EVIDENCE_ADDED`, `INCIDENT_SUBJECT_RECORDED`, `INCIDENT_SUBJECT_VIEWED`, `INCIDENT_RESOLVED`, `INCIDENT_CLOSED`, `INCIDENT_REOPENED` |
| Station status | derived + manual FLAGGED/CLOSED | `station_status_events` | `STATION_STATUS_SET` |
| Sync | ledger outcomes | `client_submissions` | `SYNC_CONFLICT_RECORDED` |

| Situation | Status | Code |
| --- | --- | --- |
| Module off | 403 | `MODULE_DISABLED` |
| Station code not in the approved registry | 400 | `VALIDATION_FAILED` (`path: ['pollingStationCode']`) |
| Record or body location outside scope | 403 | `OUT_OF_SCOPE` |
| Not your own deployment / file | 403 / 400 | `FORBIDDEN` / `VALIDATION_FAILED` |
| Stale `expectedVersion`, replaced/cancelled deployment, retired template | 409 | `CONFLICT` (`details.reason`, `details.serverState`) |
| Same key, different payload | 409 | `IDEMPOTENCY_KEY_REUSED` |
| Double booking, second chief agent | 409 | `CONFLICT` (`details.conflicts`) |
| Illegal transition | 409 | `INVALID_TRANSITION` |
| Editing immutable content (DB trigger) | 409 | `IMMUTABLE_RECORD` |
| Reviewer = author, closer = reporter/resolver, activator = creator, triager = reporter | 403 | `SEPARATION_OF_DUTIES` |

## Campaign and organisation conventions (§23–30)

Status: **implemented** (integration suites `campaign-*`, `finance-ledger`, `reports-builder`,
`notifications-centre` and the end-to-end `campaign-rehearsal`). Data model: migration
`20261125000000_campaign_organisation`; shared DTOs in `packages/shared/src/campaign/` (`finance/`,
`reports/` subfolders; small shared request shapes in `requests.ts`); DTO classes in
`apps/api/src/modules/campaign/campaign.dto.ts`; controllers and services in
`apps/api/src/modules/campaign/{org,tasks,events,comms,finance,reports,notifications,security}`.
Blueprint: 2.2, 3, 4, 5.1–5.4, 10.1–10.3, 11 (S05, S08, S09, S10, S28), 14, 15.2–15.4.

### 23–30.0 Rules for every campaign endpoint

| Topic | Rule |
| --- | --- |
| Module | org/, tasks/, events/, comms/ and finance/ controllers are tagged `@RequireModule('campaign')` (403 **`MODULE_DISABLED`**; `campaign` defaults **off**). `CampaignModuleConfig` (`packages/shared/src/campaign/common.ts`) is read with `TenantModulesService.campaignConfig(tx)` and validated by `PUT /workspace/modules/campaign`. Reports (§28), the notification centre (§29) and the breach register (§30) are platform features without a module gate; each report dataset names its own module. Notifications of a switched-off module stay hidden (`PERMISSION_MODULE_TENANT_MODULES`: `org`, `tasks`, `events`, `comms`, `finance` → `campaign`). |
| Permissions | `org.*`, `tasks.*`, `events.*`, `comms.content.*`, `finance.*` (own family; operations roles never hold it: unit-tested and role rule `operations-vs-finance`), `reports.*`, `notifications.preferences`, `security.breach.*`. High risk (MFA + re-auth where marked **reauth**): `events.attendance.contact`, `comms.content.approve`, `finance.approve`, `finance.pay`, `finance.reverse`, `finance.settings.manage`, `finance.export`, `reports.export_sensitive`, `security.breach.manage`, `security.breach.export`. |
| Department scope | Campaign records (tasks, events, teams, content, budget lines by department) are visible to a caller holding the read permission when **involved** (owner, collaborator, reviewer, creator, organiser, author, editor, approver, coordinator, active member) **or** when the record's department is one of the caller's departments **and** its geography is inside the permission's geographic grant (`DEPARTMENT_SCOPE_RULE`). Caller departments = all with `org.departments.all`, else departments led + departments of teams coordinated or belonged to + all their sub-departments (`departments.path`). Records without a department need `org.departments.all`; records without geography pass the geographic test only for ORGANISATION-wide grants. Lists use `loadCampaignScope(tx, auth, perm)` + `taskScopeWhere` / `eventScopeWhere` / `teamScopeWhere` / `contentScopeWhere`; record routes use `campaignRecordInScope()` and answer **404** outside scope (existence not revealed). Write routes check the read scope first, then the write permission. Finance is organisation-level: `finance.*` grants are not narrowed by department or geography. |
| Geography | Campaign records name one optional `geographicUnitId` (county, constituency, ward or centre); cycle-limited grants count geographically (campaign records are not cycle-bound). Geo kinds `campaignTeam`, `campaignTask`, `campaignEvent` are registered for routes where involvement does not apply (e.g. `@RequirePermission('org.teams.manage', { geo: { kind: 'campaignTeam', from: 'params', key: 'id' } })`). A body that names a unit outside the caller's grant answers 403 `OUT_OF_SCOPE`. |
| Tenancy | `prisma.tenantTx()` only; every id from a request is loaded inside the transaction (RLS hides other tenants: 404 / 400). |
| Concurrency | Mutable records carry `version`; mutations take `expectedVersion` (≥ 1), write `where: { id, version }` with `version: { increment: 1 }` and answer **409 `CONFLICT`** with `details: { currentVersion, serverState }` when stale. |
| History | Never deleted (DB triggers, even for the owner role): every campaign table except the link rows `task_collaborators`, `task_dependencies`, `event_invited_teams` (insert / delete only; the change is on the parent's timeline). Append-only: `task_comments`, `task_attachments`, `task_events`, `event_documents`, `content_revisions`, `finance_transaction_documents`, `finance_transaction_events`, `report_exports`, `notification_deliveries`, `notification_acknowledgements`, `breach_events`. Immutable content: completed / cancelled tasks, approved after-action reports, published content text (only via a CORRECTED revision), archived / withdrawn content, approved budget lines, ledger entries from APPROVED on, limit-setting values, team-membership history, attendance contact values (erasure only), a breach record's reference / drill flag / detection time / reporter. DB `IMMUTABLE_RECORD` → 409. |
| Separation of duties | Per record (403 **`SEPARATION_OF_DUTIES`**; DB checks map to the same code): task reviewer ≠ owner; after-action reviewer ≠ author; content approver ≠ author; budget-line approver ≠ creator; ledger approver ≠ requester, payer ≠ requester, rejecter ≠ requester; payer ≠ approver when `finance.approverCannotPay` (default true, service check); breach closer ≠ reporter. Role level (`ROLE_SOD_RULES`): `finance-request-vs-approve`, `finance-approve-vs-pay`, `comms-draft-vs-approve`, `operations-vs-finance`. |
| Money | Integer minor units (`amountMinor`, KES cents) with `currency` (ISO 4217, default `KES`); never floats or decimal strings. DB `BIGINT`; JSON integers within the safe range (`minorToNumber`). Use `parseMajorToMinor` / `formatMoney` in the UI. |
| Files | `StorageService.storeImmutable(purpose)`: `TASK_ATTACHMENT`, `EVENT_DOCUMENT`, `FINANCE_DOCUMENT`, `BREACH_EVIDENCE` (report exports: `EXPORT`). Upload per owning module, multipart `file` (images and PDFs, ≤ 25 MB) → `CampaignFile` (201; 200 when the bytes already exist): `POST /tasks/files` (`tasks.create`), `POST /events/files` (`events.manage` or `events.create`), `POST /finance/files` (`finance.request`), `POST /security/breaches/files` (`security.breach.record`). Audit: `FILE_STORED`. Records attach files by id; only files the caller uploaded with the matching purpose (`assertOwnFiles`, else 400). Signed URLs are audited (`FILE_SOURCE_ACCESSED`, `entityType` = the record). |
| Audit | Every state change writes its `AUDIT_ACTIONS` entry in the same transaction with before / after snapshots (amounts, ids, statuses; never attendee contact values, identifiers or file contents) and the reason when given. |
| Notifications | Created through `NotificationCenterService.notify(tx, …)` (§29) with `module` = the permission module (`tasks`, `events`, `comms`, `finance`, `notifications`), a `NOTIFICATION_TYPES` type, a deep link and `entityType` / `entityId`. Bodies carry references and labels only. |
| Political boundary | No voter lists, no recipient lists, no per-person targeting, no bulk SMS / e-mail to the public, no persuasion automation (blueprint 5.4, 15.2). Content goes to broad audience categories; notifications go to signed-in users about their own work. A request body carrying recipient-list fields (`CONTENT_FORBIDDEN_FIELDS`) is refused with 400 `VALIDATION_FAILED`. |
| Errors | `VALIDATION_FAILED` details `{ path, message }`. Ledger approval without prerequisites: 409 **`APPROVAL_INCOMPLETE`** with `details.blockers` (`financeApprovalBlockers`). A verified limit setting with `enforcement=BLOCK`: 409 **`LIMIT_EXCEEDED`** with `details.findings` (`ComplianceFinding[]`). |

### 23. Organisation (`apps/api/src/modules/campaign/org`) — S05

Web: `/org`. Departments form a tree with a materialised `path` ("/root/…/self/") and `depth`.

#### 23.1 Departments (`departments.controller.ts`)

| Method | Path | Permission | Request | Response | Notes / Audit |
| --- | --- | --- | --- | --- | --- |
| GET | `/org/departments/tree` | `org.departments.view` | `DepartmentQuery` | `DepartmentTree` | Every department is visible as a card (name, code, lead, parent, dates); `visibility` RESTRICTED / DEPARTMENT hides `budgetCode` and team details from callers outside the department unless `org.departments.all`. `manageableIds` = departments the caller leads (and descendants) or all with `org.departments.manage` + `org.departments.all`. Inactive (outside active dates) only with `includeInactive`. |
| GET | `/org/departments/:id` | `org.departments.view` | `CampaignIdParam` | `DepartmentDetail` | `path` (ancestors), teams (scope-filtered), `allowedActions`. |
| POST | `/org/departments` | `org.departments.manage` | `CreateDepartment` | `DepartmentDetail` (201) | `code` unique (409). Parent must exist; a non-`org.departments.all` caller may only create under a department they lead. Lead must be an active user. Computes `path`, `depth`. Audit: `DEPARTMENT_CREATED`. |
| PATCH | `/org/departments/:id` | `org.departments.manage` (or the department's lead for name, description, budget code, dates, visibility) | `UpdateDepartment` | `DepartmentDetail` | `expectedVersion`. Moving (`parentId`) refuses a cycle (409 `CONFLICT`, `details.reason: 'CYCLE'`) and rewrites `path` / `depth` of every descendant in the same transaction. Changing `leadUserId` needs `org.departments.manage`. Audit: `DEPARTMENT_UPDATED`; move also `DEPARTMENT_MOVED` (old and new parent). |

#### 23.2 Teams (`teams.controller.ts`)

| Method | Path | Permission | Request | Response | Notes / Audit |
| --- | --- | --- | --- | --- | --- |
| GET | `/org/teams` | `org.teams.view` | `TeamQuery` | `Paginated<TeamSummary>` | `teamScopeWhere`. `mine` = coordinator or active member. |
| GET | `/org/teams/:id` | `org.teams.view` | `CampaignIdParam` | `TeamDetail` | Department scope (404). Members incl. history (`leftAt`). |
| POST | `/org/teams` | `org.teams.manage` | `CreateTeam` | `TeamDetail` (201) | Department must be one of the caller's (unless `org.departments.all`); `geographicUnitId` inside the caller's `org.teams.manage` grant (403 `OUT_OF_SCOPE`); name unique per department (409). Coordinator is added as an active COORDINATOR member. Audit: `TEAM_CREATED`. |
| PATCH | `/org/teams/:id` | `org.teams.manage` **(geo `campaignTeam`)** | `UpdateTeam` | `TeamDetail` | `expectedVersion`; ARCHIVED is final for edits other than status back to ACTIVE with a reason. Audit: `TEAM_UPDATED`. |
| POST | `/org/teams/:id/members` | `org.teams.manage` **(geo)**, or the team's coordinator | `AddTeamMembers` | `TeamDetail` | Active users only; an existing active member keeps its row (role updated only by remove + add). Audit: `TEAM_MEMBERS_ADDED` (user ids). |
| POST | `/org/teams/:id/members/:memberId/remove` | `org.teams.manage` **(geo)**, or the team's coordinator | `TeamMemberParam` + `RemoveTeamMember` | `TeamDetail` | Sets `left_at`, `removed_by_id` (history kept; partial unique index allows re-adding). Audit: `TEAM_MEMBER_REMOVED`. |

#### 23.3 Pickers (`org-users.controller.ts`)

| Method | Path | Permission | Request | Response | Notes |
| --- | --- | --- | --- | --- | --- |
| GET | `/org/assignable-users` | any of `org.departments.manage`, `org.teams.manage`, `tasks.create`, `tasks.assign`, `tasks.view`, `events.create`, `events.manage`, `events.view` | `AssignableUserQuery` | `AssignableUser[]` | Active users of the tenant, display name only (no e-mail or phone), with department / team ids. Viewers use it for the board and list filters. `permission` filters to holders of that permission (e.g. `tasks.review` for reviewer pickers). |

### 24. Tasks (`apps/api/src/modules/campaign/tasks`) — S08

Web: `/tasks` (board / list / calendar / workload), `/tasks/[id]`. Status `TASK_STATUS_TRANSITIONS`; open =
`OPEN_TASK_STATUSES`. Every change appends `task_events` and writes its audit action.

| Method | Path | Permission | Request | Response | Notes / Audit |
| --- | --- | --- | --- | --- | --- |
| GET | `/tasks` | `tasks.view` | `TaskQuery` | `Paginated<TaskSummary>` | `taskScopeWhere`. `view=mine` owner or collaborator; `review` reviewer and SUBMITTED_FOR_REVIEW; `overdue` due < now and open. `sort` = `dueAt`, `priority`, `reference` or `updatedAt` (default; other keys 400), with `order`. |
| GET | `/tasks/board` | `tasks.view` | `TaskQuery` | `TaskBoard` | One column per status with total and first 50 cards. |
| GET | `/tasks/calendar` | `tasks.view` | `TaskCalendarQuery` | `TaskSummary[]` | Tasks with start or due in [from, to] (max 92 days, 400 otherwise). |
| GET | `/tasks/workload` | `tasks.view` | `TaskQuery` | `TaskWorkload` | Counts per owner over tasks in scope only. |
| GET | `/tasks/:id` | `tasks.view` | `CampaignIdParam` | `TaskDetail` | Department scope (404). Timeline oldest first. `allowedActions` from permissions, involvement and state. |
| POST | `/tasks` | `tasks.create` | `CreateTask` | `TaskDetail` (201) | Reference `nextReference(tx, tenantId, 'TSK', campaignReferenceYear)`. Owner / reviewer / collaborators active users; reviewer ≠ owner (400 and DB check). Department must be one of the caller's (or `org.departments.all`); team must belong to the department; geography inside the `tasks.create` grant. Assigning an owner other than yourself needs `tasks.assign`. `source` resolves the record (event / project / incident / case) the caller can see and stores `sourceLabel` = its reference (400 when not visible; project and case need the Office module and permission). Dependencies: `wouldCreateDependencyCycle` (409). Events CREATED (+ ASSIGNED). Notification `task.assigned` to the owner (if not the caller). Audit: `TASK_CREATED`. |
| PATCH | `/tasks/:id` | `tasks.create` and (owner or `tasks.manage_all`) | `UpdateTask` | `TaskDetail` | Not when COMPLETED / CANCELLED (409 `IMMUTABLE_RECORD`). Event UPDATED (changed field names). Audit: `TASK_UPDATED`. |
| POST | `/tasks/:id/assign` | `tasks.assign` (own tasks) or `tasks.manage_all` | `AssignTask` | `TaskDetail` | Reviewer ≠ owner. Once a reviewer is named, only `tasks.manage_all` may change or remove it, with a `note` (403 / 400). A task in SUBMITTED_FOR_REVIEW keeps owner and reviewer (409 `REVIEW_PENDING`; managers with a note only). The reviewer can never be a past owner or the person who submitted the work (from `task_events`; 403 `SEPARATION_OF_DUTIES`, also on `/review`). Events ASSIGNED / REVIEWER_CHANGED / COLLABORATORS_CHANGED. Notifications `task.assigned`. Audit: `TASK_ASSIGNED` (before / after ids). |
| POST | `/tasks/:id/status` | owner or collaborator with `tasks.create`; `tasks.manage_all` for others' tasks | `ChangeTaskStatus` | `TaskDetail` | `canTransitionTask` (409 `INVALID_TRANSITION`). → IN_PROGRESS, SUBMITTED_FOR_REVIEW or COMPLETED needs `dependenciesSatisfied` (409 `CONFLICT`, `details.openDependencies`) unless `overrideOpenDependencies: true` with a reason (≥ 3 characters; 400 without) from a holder of `tasks.manage_all` (403 for others); the timeline note starts "Dependency override:" and the audit entry carries `dependencyOverride: true`. → COMPLETED directly only when there is no reviewer (`tasks.reviewRequiredWhenReviewerSet`) — otherwise SUBMITTED_FOR_REVIEW, which notifies the reviewer (`task.review_requested`). BLOCKED / CANCELLED need a reason. Event STATUS_CHANGED. Audit: `TASK_STATUS_CHANGED`. |
| POST | `/tasks/:id/review` | `tasks.review` and caller = reviewer (or `tasks.manage_all` with reviewer ≠ caller ≠ owner) | `ReviewTask` | `TaskDetail` | Only SUBMITTED_FOR_REVIEW. Caller = owner → 403 `SEPARATION_OF_DUTIES`. APPROVE → COMPLETED (`completedAt`), event REVIEW_APPROVED; RETURN → IN_PROGRESS with note, event REVIEW_RETURNED, notification `task.returned`. Audit: `TASK_REVIEWED`. |
| POST | `/tasks/:id/dependencies` | `tasks.create` and (owner or `tasks.manage_all`) | `AddTaskDependency` | `TaskDetail` | Both tasks visible; no cycle (409). Event DEPENDENCY_ADDED. Audit: `TASK_DEPENDENCY_CHANGED`. |
| DELETE | `/tasks/:id/dependencies/:dependsOnTaskId` | same | `TaskDependencyParam` | `TaskDetail` | Removes the link row. Event DEPENDENCY_REMOVED. Audit: `TASK_DEPENDENCY_CHANGED`. |
| PUT | `/tasks/:id/checklist` | owner / collaborator with `tasks.create`, or `tasks.manage_all` | `SaveTaskChecklist` | `TaskDetail` | Items not in the list are marked `removedAt` (kept). `doneBy` / `doneAt` set when ticked. Event CHECKLIST_UPDATED. Audit: `TASK_CHECKLIST_SAVED`. |
| POST | `/tasks/:id/comments` | `tasks.view` and involved, or `tasks.create` in scope | `AddTaskComment` | `TaskComment` (201) | Append-only. Event COMMENTED. Audit: `TASK_COMMENTED` (no body). |
| POST | `/tasks/:id/attachments` | `tasks.create` and involved (or `tasks.manage_all`) | `AddTaskAttachment` | `TaskAttachment` (201) | File purpose `TASK_ATTACHMENT`, uploaded by the caller. `COMPLETION_EVIDENCE` by owner / collaborator only. Event ATTACHMENT_ADDED / EVIDENCE_ADDED. Audit: `TASK_ATTACHMENT_ADDED`. |
| GET | `/tasks/:id/attachments/:attachmentId/url` | `tasks.view` (task in scope) | — | `SignedUrlResponse` | Audit: `FILE_SOURCE_ACCESSED`. |

### 25. Events and logistics (`apps/api/src/modules/campaign/events`) — S09

Web: `/events`, `/events/[id]`. Status `CAMPAIGN_EVENT_STATUS_TRANSITIONS`; logistics `LOGISTICS_STATUS_TRANSITIONS`;
after-action `AFTER_ACTION_STATUS_TRANSITIONS`.

| Method | Path | Permission | Request | Response | Notes / Audit |
| --- | --- | --- | --- | --- | --- |
| GET | `/events` | `events.view` | `CampaignEventQuery` | `Paginated<CampaignEventSummary>` | `eventScopeWhere` (involvement includes members of invited teams). `budget` only for holders of `events.manage` on the event or `finance.view`, else null. |
| GET | `/events/:id` | `events.view` | `CampaignIdParam` | `CampaignEventDetail` | Department scope (404). Tasks = tasks with `source = EVENT:id` visible to the caller. `communications` = content with this `eventId` in APPROVED, PUBLISHED or ARCHIVED inside the caller's `comms.content.view` scope (empty without it; blueprint 5.3). Attendance not included (see below). |
| POST | `/events` | `events.create` | `CreateCampaignEvent` | `CampaignEventDetail` (201) | Reference `EVT`. Organiser active user; department / geography rules as for tasks; invited teams must be visible. `budgetMinor` integer minor units. Status DRAFT. Notification `event.invited` to coordinators of invited teams once PLANNED. Audit: `EVENT_CREATED`. |
| PATCH | `/events/:id` | `events.manage` (or organiser with `events.create`) | `UpdateCampaignEvent` | `CampaignEventDetail` | Not when COMPLETED / CANCELLED. Time or venue change on PLANNED / CONFIRMED notifies invited coordinators (`event.changed`). Audit: `EVENT_UPDATED`. |
| POST | `/events/:id/status` | `events.manage` (or organiser) | `ChangeCampaignEventStatus` | `CampaignEventDetail` | `canTransitionCampaignEvent`; CANCELLED / POSTPONED need a reason (stored in `cancellationReason`). Audit: `EVENT_STATUS_CHANGED`. |
| PUT | `/events/:id/agenda` | `events.manage` (or organiser) | `SaveEventAgenda` | `CampaignEventDetail` | Replaces the agenda; removed items get `removedAt`. Audit: `EVENT_AGENDA_SAVED`. |
| POST | `/events/:id/logistics` | `events.logistics` | `CreateLogisticsItem` | `EventLogisticsItem` (201) | Custodian active user. Supplier is text (finance payees stay in finance). Audit: `EVENT_LOGISTICS_SAVED`. |
| PATCH | `/events/:id/logistics/:itemId` | `events.logistics` | `LogisticsParam` + `UpdateLogisticsItem` | `EventLogisticsItem` | Item must belong to the event (404). `canTransitionLogistics`; DAMAGED / LOST need `damageNotes` (DB check); RETURNED / DAMAGED set `returnedAt`. Audit: `EVENT_LOGISTICS_SAVED`. |
| GET | `/events/:id/attendance` | `events.attendance` | `CampaignIdParam` + `PaginationQuery` | `EventAttendancePage` (`Paginated<EventAttendance>` with `summary: AttendanceSummary`; the summary fields are also merged at the top level for older clients) | Names, role, method, time, `hasContact` only. |
| POST | `/events/:id/attendance` | `events.attendance` | `RecordAttendance` | `EventAttendance` (201) | Event PLANNED / CONFIRMED / IN_PROGRESS / COMPLETED (same day). Contact only with `consent: true`, a notice version and a purpose; stored in `event_attendance_contacts`. Audit: `EVENT_ATTENDANCE_RECORDED` (`hasContact`, never values). |
| POST | `/events/:id/attendance/:attendanceId/contact` | `events.attendance.contact` **(reauth)** | `AttendanceParam` + `RevealAttendanceContact` | `EventAttendanceContact` | `Cache-Control: no-store`. Audit: `EVENT_ATTENDANCE_CONTACT_VIEWED` (reason, field names). Never in lists, exports or notifications. |
| POST | `/events/:id/attendance/:attendanceId/contact/erase` | `events.attendance.contact` | `AttendanceParam` + `{ reason }` | `OkResponse` | Nulls the values, sets `erasedAt` (DB trigger allows erasure only). Audit: `EVENT_ATTENDANCE_RECORDED` (erased). |
| POST | `/events/:id/attendance/export` | `events.attendance` + `reports.export` **(reauth)** | `AttendanceExport` | `SignedUrlResponse` | Names, roles, methods and times only (no contact values); header with generation time and classification INTERNAL. Logged in `report_exports` (`datasetKey: 'campaign.event_attendance'`). Audit: `EVENT_ATTENDANCE_EXPORTED`. |
| POST | `/events/:id/documents` | `events.manage` (or organiser) | `AddEventDocument` | `EventDocument` (201) | File purpose `EVENT_DOCUMENT`. Audit: `EVENT_DOCUMENT_ADDED`. |
| GET | `/events/:id/documents/:documentId/url` | `events.view` (event in scope) | — | `SignedUrlResponse` | Audit: `FILE_SOURCE_ACCESSED`. |
| PUT | `/events/:id/after-action` | `events.manage` (or organiser) | `SaveAfterActionReport` | `EventAfterActionReport` | Event COMPLETED. Creates (author = caller) or updates a DRAFT / RETURNED report (`expectedVersion`). `actualSpendMinor` integer minor units (reported figure; the ledger stays authoritative). Evidence files purpose `EVENT_DOCUMENT` become `AFTER_ACTION_EVIDENCE` documents. `submit: true` in the query moves DRAFT / RETURNED → SUBMITTED and notifies holders of `events.after_action.approve` in scope (`event.after_action_review`). Audit: `EVENT_AFTER_ACTION_SAVED`. |
| POST | `/events/:id/after-action/review` | `events.after_action.approve` | `ReviewAfterActionReport` | `EventAfterActionReport` | SUBMITTED only. Reviewer ≠ author (403; DB check). APPROVE freezes the report (DB trigger). Audit: `EVENT_AFTER_ACTION_REVIEWED`. |

### 26. Communications content (`apps/api/src/modules/campaign/comms`) — blueprint 5.4

Web: `/comms`, `/comms/[id]`. Status `CONTENT_STATUS_TRANSITIONS`. Every body change and every workflow step
appends a `content_revisions` row (title, body, `bodySha256`, from / to status, note, actor).

| Method | Path | Permission | Request | Response | Notes / Audit |
| --- | --- | --- | --- | --- | --- |
| GET | `/comms/content` | `comms.content.view` | `ContentQuery` | `Paginated<ContentSummary>` | `contentScopeWhere` plus the caller's workflow stages across departments (`commsWorkflowStatuses`: EDITORIAL_REVIEW and APPROVED for `comms.content.edit`, AWAITING_APPROVAL / APPROVED / PUBLISHED for `.approve`, APPROVED / PUBLISHED for `.publish`). `awaiting_me`: EDITORIAL_REVIEW for `comms.content.edit` holders (not the author), AWAITING_APPROVAL for `comms.content.approve` holders (not the author), APPROVED for `comms.content.publish`. |
| GET | `/comms/content/:id` | `comms.content.view` | `CampaignIdParam` | `ContentDetail` | Department scope or the caller's workflow stage (404). Revisions oldest first. |
| POST | `/comms/content` | `comms.content.draft` | `CreateContent` | `ContentDetail` (201) | Reference `CNT`. Author = caller. Fields in `CONTENT_FORBIDDEN_FIELDS` → 400. Revision CREATED. Audit: `CONTENT_CREATED`. |
| PATCH | `/comms/content/:id` | DRAFT: author with `comms.content.draft`; EDITORIAL_REVIEW: `comms.content.edit` (not the author) | `UpdateContent` | `ContentDetail` | Other states → 409 `IMMUTABLE_RECORD`. A body / title change bumps `revision` and appends EDITED. Audit: `CONTENT_UPDATED`. |
| POST | `/comms/content/:id/transition` | per action (below) | `ContentTransition` | `ContentDetail` | SUBMIT (author, `comms.content.draft`): DRAFT → EDITORIAL_REVIEW (→ AWAITING_APPROVAL when `comms.requireEditorialReview` is off); notifies editors (`content.review_requested`). EDITORIAL_APPROVE (`comms.content.edit`, ≠ author): → AWAITING_APPROVAL, sets `editorId`; notifies approvers. RETURN (`comms.content.edit` or `.approve`): → DRAFT with note; notifies the author (`content.returned`). APPROVE (`comms.content.approve` **reauth**, ≠ author, ≠ the editorial reviewer (`editorId`) and ≠ anyone who rewrote the text since the last submit: 403 and DB checks): AWAITING_APPROVAL → APPROVED, sets `approverId`, `approvedAt`. PUBLISH (`comms.content.publish`): APPROVED → PUBLISHED, `publishedAt` (set once), `publishedById`; records publication only (nothing is sent). ARCHIVE (`comms.content.publish`): PUBLISHED → ARCHIVED. WITHDRAW (`comms.content.approve`, note): PUBLISHED → WITHDRAWN. Each appends the matching revision kind. Audit: `CONTENT_STATUS_CHANGED`. |
| POST | `/comms/content/:id/correct` | `comms.content.approve` **(reauth)**, ≠ author | `CorrectContent` | `ContentDetail` | PUBLISHED only. New body revision (DB trigger requires the bump), `correctionCount + 1`, revision CORRECTED with the public correction note; the previous text stays in the history. Audit: `CONTENT_CORRECTED`. |

### 27. Finance (`apps/api/src/modules/campaign/finance`) — S10

Web: `/finance`, `/finance/transactions/[id]`, `/finance/settings`. Organisation-level (no department scope).
Status `FINANCE_TRANSACTION_STATUS_TRANSITIONS`; posted = `POSTED_FINANCE_STATUSES` (balances, budget vs actual and
limit checks use posted entries net of reversals).

#### 27.1 Ledger and transactions (`finance.controller.ts`)

| Method | Path | Permission | Request | Response | Notes / Audit |
| --- | --- | --- | --- | --- | --- |
| GET | `/finance/ledger` | `finance.view` | `FinanceLedgerQuery` | `FinanceLedgerSummary` | Account balances, totals, pending counts, current compliance findings (`evaluateDeadlines` + period checks) with each setting's `verified` flag; unverified findings carry `UNVERIFIED_LIMIT_LABEL`. |
| GET | `/finance/transactions` | `finance.view` | `FinanceTransactionQuery` | `Paginated<FinanceTransactionSummary>` | `awaiting_my_approval` = REQUESTED not requested by me; `awaiting_payment` = APPROVED, requested and (when segregation is on) approved by someone else; `flagged` = non-empty `complianceFlags`. |
| GET | `/finance/transactions/:id` | `finance.view` | `CampaignIdParam` | `FinanceTransactionDetail` | `approvalBlockers` (`financeApprovalBlockers`), live `compliance`, timeline, documents, `allowedActions` (SoD applied). |
| POST | `/finance/transactions` | `finance.request` | `CreateFinanceTransaction` | `FinanceTransactionDetail` (201) | DRAFT; requester = caller. Account ACTIVE and in the same currency (400). Category kind matches the type (INCOME for CONTRIBUTION, EXPENSE for EXPENSE / REFUND, TRANSFER for TRANSFER). Budget line APPROVED. Counterparty per type (zod + DB check). Reference `FIN`. Event CREATED. Audit: `FINANCE_TRANSACTION_CREATED`. |
| PATCH | `/finance/transactions/:id` | `finance.request`, requester only | `UpdateFinanceTransaction` | `FinanceTransactionDetail` | DRAFT only (409 `IMMUTABLE_RECORD`). Event UPDATED. Audit: `FINANCE_TRANSACTION_UPDATED`. |
| POST | `/finance/transactions/:id/documents` | `finance.request` (DRAFT / REQUESTED) | `AddFinanceDocument` | `FinanceDocument` (201) | File purpose `FINANCE_DOCUMENT`, uploaded by the caller. One file supports one live entry (409 `DOCUMENT_IN_USE` when it is on another entry that is not REJECTED / CANCELLED; a reversal may cite its original's document; DB trigger). Files with `malwareScanStatus = INFECTED` are refused (400) and never count towards approval (blocker `SUPPORTING_DOCUMENT_INFECTED`). Append-only (documents of an approved entry can be added as later evidence but never removed). Event DOCUMENT_ADDED. Audit: `FINANCE_TRANSACTION_DOCUMENT_ADDED`. |
| GET | `/finance/transactions/:id/documents/:documentId/url` | `finance.view` | — | `SignedUrlResponse` | Audit: `FILE_SOURCE_ACCESSED`. |
| POST | `/finance/transactions/:id/transition` | per action | `FinanceTransition` | `FinanceTransactionDetail` | **SUBMIT** (`finance.request`, requester): DRAFT → REQUESTED, `requestedAt`; evaluates compliance and stores `complianceFlags`; notifies approvers (`finance.approval_requested`). **APPROVE** (`finance.approve` **reauth**): requester → 403 `SEPARATION_OF_DUTIES`; blockers → 409 `APPROVAL_INCOMPLETE` (DB trigger backstop); re-evaluates compliance with `evaluateContribution` / `evaluateExpense` against active `FinanceLimitSetting` rows; any BLOCK finding (verified + BLOCK only) → 409 `LIMIT_EXCEEDED`; WARN findings need `acknowledgeWarnings: true` (409 `CONFLICT`, `details.findings` otherwise) and are recorded on a COMPLIANCE_EVALUATED event; → APPROVED, frozen from here (DB trigger); for a REVERSAL entry the original moves to REVERSED (`reversedAt`) in the same transaction (event REVERSED on the original); notifies payers (`finance.payment_requested`). **REJECT** (`finance.approve`, ≠ requester, note): → REJECTED; notifies the requester (`finance.rejected`). **PAY** (`finance.pay` **reauth**): APPROVED → PAID; payer ≠ requester (403, DB check), payer ≠ approver when `finance.approverCannotPay` (403); `paymentReference` required, `paidAt` defaults to now; written once. **CANCEL** (requester or `finance.approve`): DRAFT / REQUESTED → CANCELLED with reason. Each appends `finance_transaction_events`. Audit: `FINANCE_TRANSACTION_STATUS_CHANGED` (from, to, amount, SoD actors). |
| POST | `/finance/transactions/:id/reverse` | `finance.reverse` **(reauth)** | `ReverseFinanceTransaction` | `FinanceTransactionDetail` (201, the reversal) | Original APPROVED or PAID without a live reversal (409; a REJECTED or CANCELLED reversal does not count, partial unique index). Creates a REVERSAL entry (same amount, currency, account, category, budget line, counterparty copied into the description; `reversesId`) in REQUESTED with the reason; it needs approval by someone other than its requester like any entry. Audit: `FINANCE_TRANSACTION_REVERSED` (original and reversal ids). |
| POST | `/finance/exports` | `finance.export` + `reports.export_sensitive` **(reauth)** | `FinanceExportRequest` (`register`, `format`, `from`, `to`, `reason`) | `SignedUrlResponse` | Registers: LEDGER, CONTRIBUTIONS, EXPENDITURE, BUDGET_VS_ACTUAL, built on the §28 datasets (`finance.transactions`, `finance.contributions`, `finance.budget_vs_actual`). `from` / `to` are Africa/Nairobi calendar days. A register longer than the dataset's `maxRows` is refused (409 `EXPORT_TOO_LARGE`), never cut off. File header: title, generation time (Africa/Nairobi and UTC), generator, filters, classification CONFIDENTIAL (HIGHLY_RESTRICTED when masked identifiers are included), and the unverified-limit label where findings rely on unverified settings. Stored with purpose `EXPORT`; logged in `report_exports` (`sensitive: true`, `reauthAt`, reason). Audit: `FINANCE_EXPORTED` and `REPORT_EXPORTED`. |

#### 27.2 Accounts and categories

| Method | Path | Permission | Request | Response | Notes / Audit |
| --- | --- | --- | --- | --- | --- |
| GET | `/finance/accounts` | `finance.view` | — | `FinanceAccount[]` | Balances from posted entries (transfers move between accounts; reversals net out). |
| POST | `/finance/accounts` | `finance.settings.manage` **(reauth)** | `SaveFinanceAccount` | `FinanceAccount` (201) | Only the last 4 digits are accepted and stored masked. Audit: `FINANCE_ACCOUNT_SAVED`. |
| PATCH | `/finance/accounts/:id` | `finance.settings.manage` **(reauth)** | `UpdateFinanceAccount` | `FinanceAccount` | Currency fixed once an entry exists (409). Closing needs a zero posted balance (409). Audit: `FINANCE_ACCOUNT_SAVED`. |
| GET | `/finance/categories` | `finance.view` | — | `FinanceCategory[]` | |
| POST | `/finance/categories` | `finance.settings.manage` | `SaveFinanceCategory` | `FinanceCategory` (201) | Code unique (409). Audit: `FINANCE_CATEGORY_SAVED`. |
| PATCH | `/finance/categories/:id` | `finance.settings.manage` | `SaveFinanceCategory` | `FinanceCategory` | Kind fixed once used (409). Deactivate instead of delete. Audit: `FINANCE_CATEGORY_SAVED`. |

#### 27.3 Payees and contribution sources

| Method | Path | Permission | Request | Response | Notes / Audit |
| --- | --- | --- | --- | --- | --- |
| GET | `/finance/payees` | `finance.view` | `PaginationQuery` | `Paginated<FinancePayee>` | Masked PIN and phone only. |
| POST | `/finance/payees` | `finance.request` | `SaveFinancePayee` | `FinancePayee` (201) | Tax PIN stored masked plus `identifierFingerprint(tenantId, pin, key)` (duplicate → 409 with the existing payee id). Audit: `FINANCE_PAYEE_SAVED` (no PIN, no phone). |
| PATCH | `/finance/payees/:id` | `finance.request` or `finance.settings.manage` | `SaveFinancePayee` | `FinancePayee` | A payee named on an APPROVED / PAID / REVERSED entry needs `finance.settings.manage` (403) and keeps its name, kind and tax PIN (409 `IMMUTABLE_RECORD`; DB trigger). Audit: `FINANCE_PAYEE_SAVED` (before / after, masked PIN only). |
| GET | `/finance/contribution-sources` | `finance.view` | `ContributionSourceQuery` | `Paginated<ContributionSource>` | `totalContributedMinor` = posted contributions in the period. Identifier masked only; never returned in full. |
| POST | `/finance/contribution-sources` | `finance.request` | `SaveContributionSource` | `ContributionSource` (201) | Identifier stored masked + fingerprint (one source per identifier: 409 with the existing id). `declared` sets `declaredAt`. Audit: `FINANCE_CONTRIBUTION_SOURCE_SAVED` (`hasIdentifier`, never the value). |
| PATCH | `/finance/contribution-sources/:id` | `finance.request`, `finance.approve` or `finance.settings.manage` | `SaveContributionSource` | `ContributionSource` | Changing `declared` needs `finance.approve` (403; also on create), never by someone with open requests from the source (403 `SEPARATION_OF_DUTIES`); `declaredById` recorded. Once posted entries name the source, its name, kind, identifier and a recorded declaration are frozen (409; DB trigger). Contributions from a source without an identifier carry `SOURCE_IDENTITY_UNVERIFIED`; look-alike names (`J. Wekesa` / `John Wekesa`) carry `POSSIBLE_DUPLICATE_SOURCE` with the combined share (warnings). Audit: `FINANCE_CONTRIBUTION_SOURCE_SAVED` (before / after). |

#### 27.4 Budget lines

| Method | Path | Permission | Request | Response | Notes / Audit |
| --- | --- | --- | --- | --- | --- |
| GET | `/finance/budget-lines` | `finance.view` | `BudgetLineQuery` | `BudgetLine[]` | `actual` = APPROVED + PAID expense entries (a reversed original and its reversal both drop out, so reversals net to zero); `committed` = REQUESTED expense entries (requested, not yet approved). |
| POST | `/finance/budget-lines` | `finance.request` | `SaveBudgetLine` | `BudgetLine` (201) | DRAFT. Department or event required (DB check). Audit: `FINANCE_BUDGET_LINE_SAVED`. |
| PATCH | `/finance/budget-lines/:id` | `finance.request` | `SaveBudgetLine` (`expectedVersion`) | `BudgetLine` | DRAFT only (DB trigger freezes APPROVED). Audit: `FINANCE_BUDGET_LINE_SAVED`. |
| POST | `/finance/budget-lines/:id/approve` | `finance.approve` **(reauth)** | `ExpectedVersionBody` | `BudgetLine` | Approver ≠ creator (403; DB check). Audit: `FINANCE_BUDGET_LINE_APPROVED`. |
| POST | `/finance/budget-lines/:id/close` | `finance.approve` | `VersionReasonBody` | `BudgetLine` | APPROVED → CLOSED (final). Audit: `FINANCE_BUDGET_LINE_SAVED`. |

#### 27.5 Contribution register

The contribution register is the `finance.contributions` dataset (§28) plus
`GET /finance/transactions?type=CONTRIBUTION`. Each contribution names a `ContributionSource` (kind, masked identifier,
declaration) and carries `complianceFlags` evaluated at submission and approval against the tenant's settings
(`SINGLE_SOURCE_CAP_EXCEEDED` / `_NEAR`, `UNDECLARED_SOURCE`, `UNVERIFIED_SETTING` when the setting behind a finding is
not verified). The flags are frozen with the entry at approval.

#### 27.6 Limit settings (`finance-settings.controller.ts`)

Settings are versioned rows of `finance_limit_settings`: `kind` (`SINGLE_SOURCE_CAP_PCT` in basis points with
`capBasis`, `SPENDING_LIMIT` in minor units + currency, `REPORTING_DEADLINE` date), election cycle, `periodLabel`,
optional `officeType`, `effectiveFrom` / `effectiveTo`, mandatory `legalSourceNote`, `verified` (default **false**) and
`enforcement` (WARN | BLOCK). **No limit, percentage or date is hardcoded**; a BLOCK takes effect only once the setting
is verified (`complianceBlocks`), and every unverified finding is shown as a warning labelled "Unverified – configure to
the applicable law".

| Method | Path | Permission | Request | Response | Notes / Audit |
| --- | --- | --- | --- | --- | --- |
| GET | `/finance/settings/limits` | `finance.view` | `FinanceLimitQuery` | `FinanceLimitSetting[]` | `activeOn` uses `activeLimitSettings` semantics; superseded rows only with `includeSuperseded`. |
| POST | `/finance/settings/limits` | `finance.settings.manage` **(reauth)** | `CreateFinanceLimitSetting` | `FinanceLimitSetting` (201) | Kind columns (zod + DB check); `verified: true` records `verifiedById` / `verifiedAt` = caller / now. Overlapping active settings of the same kind, cycle and office type → 409 (supersede instead). Audit: `FINANCE_LIMIT_SETTING_CREATED`. |
| POST | `/finance/settings/limits/:id/supersede` | `finance.settings.manage` **(reauth)** | `SupersedeFinanceLimitSetting` | `FinanceLimitSetting` (201, the new row) | One transaction: new row with `supersedesId`; old row `effectiveTo` = new `effectiveFrom` − 1 day (value columns stay immutable, DB trigger). Audit: `FINANCE_LIMIT_SETTING_SUPERSEDED` (old and new values, reason). |
| POST | `/finance/settings/limits/:id/verify` | `finance.settings.manage` **(reauth)** | `VerifyFinanceLimitSetting` | `FinanceLimitSetting` | Sets or clears `verified` with who / when (DB check). The person who entered the setting cannot verify it (403 `SEPARATION_OF_DUTIES`; DB check `finance_limit_settings_second_verifier_check`); create and supersede refuse `verified: true` (400). `verificationChangedById` keeps who last changed the flag: that person, and the author of a superseding version, cannot approve an entry the (now non-blocking) setting governs (403 `SEPARATION_OF_DUTIES` with `settingIds`). Approvals take a per-tenant, per-cycle advisory lock before evaluating limits, so concurrent approvals cannot both pass a cap. Posted totals are per currency: an entry in another currency than a spending limit gets `CURRENCY_MISMATCH` (warning) and is not counted. Audit: `FINANCE_LIMIT_SETTING_VERIFIED` (reason). |

### 28. Reports (`apps/api/src/modules/campaign/reports`) — S28, blueprint 10.1–10.2

Web: `/reports` (builder + standard-report catalogue), `/reports/[id]`. Only datasets in `REPORT_DATASETS`
(`packages/shared/src/campaign/reports/datasets.ts`) can be queried: dataset key, tenant module, required permission,
permitted fields (each with a classification and optional extra permission), scope column(s), date field, export rules
and an optional disclaimer. No free SQL, no raw column names. Every query runs in `prisma.tenantTx()` (RLS) and applies
the dataset scope **in the query layer**: `organisation` (permission only), `geography` (`geographyColumn` inside the
permission's grant; cycle-limited grants only for their cycle), `department_geography` (the campaign department-scope
rule). Field-level permissions (`requiresPermission`) are applied before selection and filtering.

| Method | Path | Permission | Request | Response | Notes / Audit |
| --- | --- | --- | --- | --- | --- |
| GET | `/reports/datasets` | any of `reports.view`, `reports.build` | — | `{ key, label, description, group, fields: DatasetField[] }[]` | `availableDatasets(permissions, enabledModules)` with `permittedFields` per dataset. |
| GET | `/reports/standard` | any of `reports.view`, `reports.build` | — | `StandardReport[]` (+ `runnable`) | `STANDARD_REPORTS` the caller can run (dataset available and definition valid for the caller). |
| POST | `/reports/preview` | `reports.build` (or `reports.view` for a standard / shared definition unchanged) | `ReportDefinition` | `ReportPreview` | `validateReportDefinition` → 403 `FORBIDDEN` with `details` (issues) for unpermitted datasets / fields, 400 for unknown ones. `geographicUnitId` / `departmentId` must be inside the caller's scope (403 `OUT_OF_SCOPE`). At most 50 sample rows or 500 groups; `rowCount` and `totals` over all matching rows; `appliedScope` and `filtersDescription` in plain language; `classification` = `reportClassification`; `disclaimer` (tally datasets: `PARALLEL_TALLY_DISCLAIMER`); `exportRequirements` with `allowed`. Not audited per call (only exports are). |
| GET | `/reports/templates` | any of `reports.view`, `reports.build` | `ReportTemplateQuery` | `Paginated<ReportTemplate>` | Visible: own templates, ORGANISATION-scoped templates whose dataset the caller can use, ROLES-scoped templates sharing one of the caller's role keys. `runnable=false` when a field or dataset permission is missing. Archived hidden. |
| GET | `/reports/templates/:id` | same | `CampaignIdParam` | `ReportTemplate` | 404 when not visible. |
| POST | `/reports/templates` | `reports.save` | `SaveReportTemplate` | `ReportTemplate` (201) | Owner = caller; definition validated for the caller; `classification` computed. Audit: `REPORT_TEMPLATE_SAVED`. |
| PATCH | `/reports/templates/:id` | `reports.save`, owner only | `SaveReportTemplate` (`expectedVersion`) | `ReportTemplate` | Audit: `REPORT_TEMPLATE_SAVED`. |
| POST | `/reports/templates/:id/archive` | `reports.save`, owner only | `{ reason }` | `OkResponse` | Sets `archivedAt` (never deleted). Audit: `REPORT_TEMPLATE_DELETED` (`reports.template.archived`). |
| POST | `/reports/exports` | `reports.export` (+ the rest of `exportRequirements`) | `CreateReportExport` | `ReportExport` + `SignedUrlResponse` | Definition validated for the caller (a shared template runs with the **caller's** permissions and scope, never the owner's). **Sensitive** exports (`dataset.sensitiveExport` or a CONFIDENTIAL / HIGHLY_RESTRICTED selection) need `reports.export_sensitive`, the dataset's `exportPermission` (finance → `finance.export`, tally → `tally.export`, audit → `audit.export`, breaches → `security.breach.export`), **re-authentication** and a `reason` (400 without). The file (CSV / XLSX / PDF, purpose `EXPORT`) starts with a header block: report name, generation time (Africa/Nairobi and UTC), generator, filters, applied scope, data classification and the dataset disclaimer (tally keeps "unofficial, not an IEBC result"). Logged append-only in `report_exports` (fields, definition, filters, scope, classification, `sensitive`, row count, SHA-256, `reauthAt`, reason). An ad-hoc `definition` needs `reports.build` unless it is a standard or visible shared definition (as preview). `eq` / `in` filters on enum columns run in the query; when the row cap is hit before an in-memory filter the result is incomplete: previews say so and exports are refused (409 `RESULTS_INCOMPLETE`). Money totals are left out when rows mix currencies. Audit: `REPORT_EXPORTED`. Notification `report.export_ready` when produced by the queue. |
| GET | `/reports/exports` | `reports.export` (own) ; `audit.view` (all) | `ReportExportQuery` | `Paginated<ReportExport>` | Export log. |
| GET | `/reports/exports/:id/url` | the generator, or `audit.export` | — | `SignedUrlResponse` | Re-downloading is re-exporting: the caller must hold the dataset permission, field permissions and `exportRequirements` again (403 with `required`), the module must be on, and sensitive exports need a recent re-authentication (401). `audit.export` alone sees the log, never the file. Audit: `FILE_SOURCE_ACCESSED` (`redownload`, `sensitive`). |

### 29. Notification centre (`apps/api/src/modules/campaign/notifications` + admin §7) — blueprint 10.3

Web: `/notifications` (centre + preferences); the top-bar bell shows `NotificationCounts`. The existing
`notifications` table and `/notifications` endpoints (§7; the admin `DashboardController` delegates the list to
`NotificationCenterService.list`) are **extended**, not duplicated: `GET /notifications` returns
`Paginated<NotificationCenterItem>` (adds `severity`, `requiresAck`, `acknowledgedAt`, `entityType`, `entityId`) and
accepts `NotificationCenterQuery` (`unreadOnly`, `module`, `severity`, `awaitingAck`). External channels use
`NotificationChannelProvider` (`providers/notification-provider.ts`); the default for EMAIL, SMS and PUSH is the
**log provider** (records SKIPPED, sends nothing, no vendor credentials).

| Method | Path | Permission | Request | Response | Notes / Audit |
| --- | --- | --- | --- | --- | --- |
| GET | `/notifications/counts` | Authenticated | — | `NotificationCounts` | Unread and awaiting-acknowledgement counts over visible modules. |
| GET | `/notifications/preferences` | `notifications.preferences` | — | `NotificationPreferences` | Every `NOTIFICATION_TYPES` × channel with the effective value (`notificationEnabled`), `locked` for mandatory in-app types, `availableChannels` (providers whose `isAvailable()` is true), `emailVerified`, `smsConsent`. |
| PUT | `/notifications/preferences` | `notifications.preferences` | `UpdateNotificationPreferences` | `NotificationPreferences` | Upserts rows (own only). Switching off a mandatory in-app type → 400. Audit: `NOTIFICATION_PREFERENCES_UPDATED` (channel / type / enabled). |
| POST | `/notifications/:id/acknowledge` | Authenticated (own notification) | `AcknowledgeNotification` | `NotificationCenterItem` | Only `requiresAck` notifications (409 otherwise). Appends `notification_acknowledgements` (ACKNOWLEDGED / ESCALATED / CLOSED with note); first ACKNOWLEDGED sets `acknowledgedAt` and `readAt`. ESCALATED happens once per notification (409 `ALREADY_ESCALATED`; DB trigger) and skips managers who already hold an open critical alert for the same record. Audit: `NOTIFICATION_ACKNOWLEDGED`. |
| GET | `/notifications/:id/acknowledgements` | own notification, or `security.breach.view` for `security.*` types | — | `NotificationAcknowledgement[]` | The escalation and closure record. |
| GET | `/notifications/deliveries` | Authenticated (own) | `PaginationQuery` | `Paginated<NotificationDelivery>` | The caller's delivery log per channel. |

`NotificationCenterService.notify(tx, { tenantId, userIds, module, type, title, body, link, severity?, requiresAck?, entityType?, entityId? })`
inserts the in-app rows in the caller's transaction and, after commit, dispatches enabled external channels: e-mail only
to a verified address, SMS only with a phone and consent, push only to a registered subscription; one message per user;
each attempt appends `notification_deliveries` (provider name, status, attempt, error). Critical alerts
(`severity: CRITICAL`, `requiresAck: true`) are always delivered in-app (`MANDATORY_NOTIFICATION_TYPES`) and stay in
`awaitingAck` until acknowledged; escalation goes to holders of `security.breach.manage`.

### 30. Breach register (`apps/api/src/modules/campaign/security`) — blueprint 15.4

Web: `/security/breaches`. Status `BREACH_STATUS_TRANSITIONS`; timeline types move the status per `breachStatusFor`.
Drills are recorded with `isDrill: true` and labelled everywhere. The register holds categories and counts only.

| Method | Path | Permission | Request | Response | Notes / Audit |
| --- | --- | --- | --- | --- | --- |
| GET | `/security/breaches` | `security.breach.view` | `BreachQuery` | `Paginated<BreachSummary>` | |
| GET | `/security/breaches/:id` | `security.breach.view` | `CampaignIdParam` | `BreachDetail` | Timeline by `occurredAt`. |
| POST | `/security/breaches` | `security.breach.record` | `CreateBreach` | `BreachDetail` (201) | Reference `BRE`; reporter = caller; status DETECTED; event DETECTED. Notifies holders of `security.breach.manage` with a CRITICAL, acknowledgement-required alert for HIGH / CRITICAL severity (`security.critical_alert`), else `security.breach_recorded`. Audit: `BREACH_RECORDED`. |
| PATCH | `/security/breaches/:id` | `security.breach.manage` | `UpdateBreach` | `BreachDetail` | Not when CLOSED (reopen first). Audit: `BREACH_UPDATED`. |
| POST | `/security/breaches/:id/events` | `security.breach.manage` (NOTE also `security.breach.record`) | `AddBreachEvent` | `BreachDetail` | A recorder without `security.breach.view` adds notes only to records they reported (404 otherwise, before any version check, so no detail leaks). Status moves via `canTransitionBreach` (409 `INVALID_TRANSITION`); `*_NOTIFIED` set the matching `…NotifiedAt`; NOTIFICATION_NOT_REQUIRED needs `notificationDecision`; CLOSED needs `lessonsLearned` and a closer ≠ reporter (403; DB checks); REOPENED → ASSESSED, clears `closedAt` / `closedById`. Evidence file purpose `BREACH_EVIDENCE`. Appends `breach_events`. Audit: `BREACH_EVENT_ADDED` (+ `BREACH_STATUS_CHANGED`). |
| GET | `/security/breaches/:id/events/:eventId/evidence/url` | `security.breach.view` | — | `SignedUrlResponse` | Evidence file of a timeline entry. Audit: `FILE_SOURCE_ACCESSED`. |
| POST | `/security/breaches/:id/export` | `security.breach.export` **(reauth)** | `ExportBreachTimeline` | `SignedUrlResponse` | PDF / CSV timeline with drill label, generation time and classification CONFIDENTIAL; logged in `report_exports` (`datasetKey: 'security.breaches'`, `sensitive: true`). Audit: `BREACH_TIMELINE_EXPORTED`. |

### Campaign status, audit and error summary

| Record | Transitions | History | Audit actions |
| --- | --- | --- | --- |
| Department / team | — (move re-paths) | audit; `team_members.left_at` | `DEPARTMENT_CREATED`, `DEPARTMENT_UPDATED`, `DEPARTMENT_MOVED`, `TEAM_CREATED`, `TEAM_UPDATED`, `TEAM_MEMBERS_ADDED`, `TEAM_MEMBER_REMOVED` |
| Task | `TASK_STATUS_TRANSITIONS` | `task_events`, `task_comments`, `task_attachments` | `TASK_CREATED`, `TASK_UPDATED`, `TASK_ASSIGNED`, `TASK_STATUS_CHANGED`, `TASK_REVIEWED`, `TASK_DEPENDENCY_CHANGED`, `TASK_CHECKLIST_SAVED`, `TASK_COMMENTED`, `TASK_ATTACHMENT_ADDED` |
| Event | `CAMPAIGN_EVENT_STATUS_TRANSITIONS`, `LOGISTICS_STATUS_TRANSITIONS`, `AFTER_ACTION_STATUS_TRANSITIONS` | `event_documents`, audit | `EVENT_CREATED`, `EVENT_UPDATED`, `EVENT_STATUS_CHANGED`, `EVENT_AGENDA_SAVED`, `EVENT_LOGISTICS_SAVED`, `EVENT_ATTENDANCE_RECORDED`, `EVENT_ATTENDANCE_CONTACT_VIEWED`, `EVENT_ATTENDANCE_EXPORTED`, `EVENT_DOCUMENT_ADDED`, `EVENT_AFTER_ACTION_SAVED`, `EVENT_AFTER_ACTION_REVIEWED` |
| Content | `CONTENT_STATUS_TRANSITIONS` | `content_revisions` | `CONTENT_CREATED`, `CONTENT_UPDATED`, `CONTENT_STATUS_CHANGED`, `CONTENT_CORRECTED` |
| Ledger entry | `FINANCE_TRANSACTION_STATUS_TRANSITIONS` | `finance_transaction_events`, `finance_transaction_documents` | `FINANCE_TRANSACTION_CREATED`, `FINANCE_TRANSACTION_UPDATED`, `FINANCE_TRANSACTION_DOCUMENT_ADDED`, `FINANCE_TRANSACTION_STATUS_CHANGED`, `FINANCE_TRANSACTION_REVERSED`, `FINANCE_EXPORTED` |
| Finance master data | budget line DRAFT → APPROVED → CLOSED | audit | `FINANCE_ACCOUNT_SAVED`, `FINANCE_CATEGORY_SAVED`, `FINANCE_PAYEE_SAVED`, `FINANCE_CONTRIBUTION_SOURCE_SAVED`, `FINANCE_BUDGET_LINE_SAVED`, `FINANCE_BUDGET_LINE_APPROVED` |
| Limit setting | versioned (supersede) | rows kept; audit | `FINANCE_LIMIT_SETTING_CREATED`, `FINANCE_LIMIT_SETTING_SUPERSEDED`, `FINANCE_LIMIT_SETTING_VERIFIED` |
| Report template / export | archive | `report_exports` | `REPORT_TEMPLATE_SAVED`, `REPORT_TEMPLATE_DELETED`, `REPORT_EXPORTED` |
| Notification | read / acknowledge | `notification_acknowledgements`, `notification_deliveries` | `NOTIFICATION_PREFERENCES_UPDATED`, `NOTIFICATION_ACKNOWLEDGED` |
| Breach | `BREACH_STATUS_TRANSITIONS` | `breach_events` | `BREACH_RECORDED`, `BREACH_UPDATED`, `BREACH_EVENT_ADDED`, `BREACH_STATUS_CHANGED`, `BREACH_TIMELINE_EXPORTED` |

| Situation | Status | Code |
| --- | --- | --- |
| Module off | 403 | `MODULE_DISABLED` |
| Record outside the department scope | 404 | `NOT_FOUND` |
| Body names a unit / department outside the caller's scope | 403 | `OUT_OF_SCOPE` |
| Unpermitted report dataset or field | 403 | `FORBIDDEN` (`details` = issues) |
| Sensitive export or high-risk action without recent re-auth | 403 | `REAUTH_REQUIRED` |
| Stale `expectedVersion` | 409 | `CONFLICT` (`details.serverState`) |
| Illegal transition | 409 | `INVALID_TRANSITION` |
| Editing frozen content (DB trigger) | 409 | `IMMUTABLE_RECORD` |
| Ledger approval without category, counterparty, reference or document | 409 | `APPROVAL_INCOMPLETE` |
| Verified BLOCK limit finding | 409 | `LIMIT_EXCEEDED` |
| Unacknowledged WARN findings on approval | 409 | `CONFLICT` (`details.findings`) |
| Requester approves / pays, approver pays (segregation on), author approves, owner reviews, reporter closes | 403 | `SEPARATION_OF_DUTIES` |
| Dependency cycle, duplicate code / identifier | 409 | `CONFLICT` |

---

## Pilot hardening conventions (§31–36)

Status: **being built** on `feat/pilot-hardening` (as-built notes for §31 and §34 in §34.1). The schema (migration
`20261128000000_pilot_hardening_foundation`), the shared types (`packages/shared/src/platform/`), the platform interfaces
(`apps/api/src/platform/`), empty modules and the web route stubs exist; the endpoints below are built by four parallel
agents (ownership in [ARCHITECTURE.md](./ARCHITECTURE.md) §16). Every rule in §1 applies. In addition:

| Topic | Rule |
| --- | --- |
| Secrets | Vendor secrets (SMTP password, Africa's Talking API key, VAPID private key, captcha secret) come only from the environment (`.env.example`). They are never stored in the database, never returned by an endpoint and never logged. Endpoints report provider *names*, `configured` / `available` flags and missing variable *names* only. `tenant_integration_settings.config` refuses secret-looking keys (DB check + `containsSecretKey`). |
| Defaults | Every provider defaults to the log / no-op one: e-mail, SMS and push record SKIPPED; no scanner (files stay PENDING); no captcha verifier. Tests use in-process fakes (fake SMTP / HTTP servers, a fake clamd speaking INSTREAM, the EICAR string), never the vendors. |
| Fail closed | Only `CLEAN` is clean (`isScanClean`): PENDING, ERROR and SKIPPED files cannot be published or used where CLEAN is required (409 `FILE_NOT_CLEAN`). A tenant captcha provider that is not configured, or whose verification fails or times out, refuses the submission (400 `ABUSE_CHECK_FAILED`, generic). A selected provider that lacks its variables stops the API at start-up. The Redis rate-limit store erroring answers 429 / 503, never "unlimited". |
| Delivery | Messages go to one person about their own account or work, through `message_outbox` (enqueued in the business transaction, sent by the `messaging.dispatch` job). E-mail only to a verified address (the invitation and verification templates prove control of the address they are sent to); SMS only to a verified number with consent and no opt-out; push only to the user's own subscriptions. No lists, no bulk, no outreach (blueprint 15.3). |
| Invitation links | Once an e-mail provider is configured (`MessageProviderRegistry.isDeliveryConfigured('EMAIL')`), invitations and recovery links are delivered to the person through the outbox and are **never** returned to the administrator (any `NODE_ENV`). Without a channel the link is shown once, as today, and the response says `delivery: 'SHOWN_ONCE'`. |
| Separation of duties | Account recovery: requester ≠ subject, approver ≠ requester and ≠ subject, rejecter ≠ subject (DB checks → 403 `SEPARATION_OF_DUTIES`). A display-hold redacted copy is attached / confirmed by someone other than the uploader and the declarer (existing service rule). |
| Transitions | `MESSAGE_STATUS_TRANSITIONS` and `ACCOUNT_RECOVERY_TRANSITIONS` (shared) mirror DB triggers; a refused DB transition maps to 409 `INVALID_TRANSITION`, a frozen record to 409 `IMMUTABLE_RECORD`. |
| Rate limits | Account-level limits (per hashed tenant + e-mail / user id) use `RATE_LIMIT_STORE` (memory or Redis); keys never contain personal data in clear. |

### 31. Messaging, contacts and push (`apps/api/src/platform/messaging`) — owner platform-infra, blueprint 10.3

Outbox flow: `MessageOutboxPort.enqueueInTx(tx, OutboxEnqueueInput)` (token `MESSAGE_OUTBOX`) inserts one QUEUED row in
the caller's tenant transaction: the address is resolved (verified e-mail / consented phone / active push subscriptions,
or `addressOverride` for invitation and verification templates), sealed with `MESSAGING_ENCRYPTION_KEY`, hashed with
`MESSAGING_HASH_KEY` and masked; secrets for the template go to `secret_payload_encrypted`; a recipient without a
deliverable address gives a SKIPPED row (never an error that blocks the business change). The same `(tenant,
idempotencyKey)` returns the existing row. The dispatcher (`messaging.dispatch`, every
`MESSAGING_DISPATCH_INTERVAL_SECONDS`) claims due rows (`QUEUED` / `FAILED` with `next_attempt_at <= now()`, or
`SENDING` with an expired `locked_until`) with `FOR UPDATE SKIP LOCKED`, moves them to SENDING (attempts + 1, lease),
renders the template, calls `MessageProviderRegistry.get(channel).send()` and records SENT (provider id, `sent_at`),
SKIPPED (log provider), FAILED (`next_attempt_at = now() + messageRetryDelayMs(attempts)`) or DEAD (permanent failure or
`attempts = max_attempts`); `secret_payload_encrypted` is wiped at SENT / SKIPPED / DEAD (DB check). Every transition
appends `message_outbox_events`. In-app notifications keep `notification_deliveries`; the notification centre's
external channels move onto the outbox (`notification.alert`, `notification_id` set).

#### 31.1 Outbox administration

| Method | Path | Permission | Request | Response | Notes / Audit |
| --- | --- | --- | --- | --- | --- |
| GET | `/workspace/messages` | `workspace.configure` | `OutboxListQuery` | `Paginated<OutboxMessageSummary>` | Masked address only; never payload or secrets. |
| GET | `/workspace/messages/:id/events` | `workspace.configure` | — | `{ items: MessageOutboxEvent[] }` | Attempt history (errors without addresses). |
| POST | `/workspace/messages/:id/cancel` | `workspace.configure` | `{ reason }` | `OutboxMessageSummary` | QUEUED / FAILED → DEAD (409 `INVALID_TRANSITION` otherwise). Audit: `MESSAGE_CANCELLED`. A DEAD message is never revived: re-issue the invitation / recovery instead. |

#### 31.2 Own contacts and push (`/me/*`, authenticated, own account only)

| Method | Path | Permission | Request | Response | Notes / Audit |
| --- | --- | --- | --- | --- | --- |
| GET | `/me/contacts` | Authenticated | — | `ContactStatusResponse` | E-mail (login address) and phone (`users.phone`) with verification and SMS consent. |
| POST | `/me/contacts/verify/start` | Authenticated, rate-limited (account: 5 / hour / channel) | `StartContactVerification` | `ContactStatus` | Creates or refreshes the current `contact_verifications` row (supersedes one for an old address), stores SHA-256 of a 6-digit code (10 min), enqueues `contact.verify_email` / `contact.verify_sms` to that address. 409 when there is no phone. Appends `CODE_SENT`. Audit: `CONTACT_VERIFICATION_SENT`. |
| POST | `/me/contacts/verify/confirm` | Authenticated, rate-limited | `ConfirmContactVerification` | `ContactStatus` | 5 wrong codes invalidate the code. Sets `verified_at` once. Appends `VERIFIED` / `VERIFICATION_FAILED`. Audit: `CONTACT_VERIFIED`. |
| PUT | `/me/contacts/sms-consent` | Authenticated | `SmsConsent` | `ContactStatus` | `consentVersion` must equal `SMS_CONSENT_NOTICE.version` (400 otherwise); `consent: false` records an opt-out (`source: settings`). Appends `CONSENT_GIVEN` / `OPTED_OUT` / `OPTED_IN`. Audit: `CONTACT_SMS_CONSENT_CHANGED`. |
| GET | `/me/push/config` | Authenticated | — | `PushConfigResponse` | VAPID public key or null. |
| GET | `/me/push/subscriptions` | Authenticated | — | `PushSubscriptionSummary[]` | Own, active. |
| POST | `/me/push/subscriptions` | Authenticated | `PushSubscribe` | `PushSubscriptionSummary` (201) | Endpoint and keys sealed; same endpoint → existing row. Audit: `PUSH_SUBSCRIBED`. |
| DELETE | `/me/push/subscriptions/:id` | Authenticated (own) | — | `OkResponse` | Revokes (`revoked_reason: user`); rows are never deleted. A 404 / 410 from the push service revokes with `expired`. Audit: `PUSH_UNSUBSCRIBED`. |

#### 31.3 Provider callbacks (public, no session)

| Method | Path | Permission | Request | Response | Notes / Audit |
| --- | --- | --- | --- | --- | --- |
| POST | `/webhooks/sms/africastalking/:token/delivery` | Public; `:token` = `AFRICASTALKING_DLR_TOKEN` (constant-time compare, 404 otherwise), rate-limited | vendor form body (`id`, `status`, `failureReason`) | 200 empty | Finds the message by `(provider, provider_message_id)` through a SECURITY DEFINER lookup that returns only the tenant id, then sets `delivery_status` / `delivery_status_at` inside `withTenant` and appends an event. Unknown ids → 200 (no oracle). Idempotent. |
| POST | `/webhooks/sms/africastalking/:token/inbound` | same | vendor form body (`from`, `text`) | 200 empty | `STOP` / `STOP ALL` / `UNSUBSCRIBE` (case-insensitive) opt out every current SMS contact with that number hash (`source: sms_reply`); nothing else is stored. Audit (SYSTEM): `CONTACT_SMS_OPTED_OUT`. |

### 32. Passkeys, recovery codes and account recovery (`apps/api/src/auth/passkeys`, `apps/api/src/auth/recovery`) — owner auth-recovery, blueprint 15.1, S01

**Status: implemented** (`PasskeysService`, `RecoveryCodesService`, `AccountRecoveryService`, `AuthRecoveryModule`;
tests `apps/api/test/auth-passkeys.integration.spec.ts`, `auth-recovery.integration.spec.ts` with a software
authenticator). Open items are in CHANGE_REQUESTS.md "Pilot hardening: auth-recovery" (AR1–AR10); in particular §32.4 and
the reset-mfa addition below are **not yet built** (AR5, AR6).

WebAuthn ceremonies use `@simplewebauthn/server` with `WEBAUTHN_RP_ID`, `WEBAUTHN_RP_NAME`, `WEBAUTHN_ORIGINS` (comma
separated, defaults to `WEB_ORIGIN`); `userVerification: 'required'` in options and `requireUserVerification` on verify;
attestation `none`. Challenges are single-use rows in `webauthn_challenges` (SHA-256 only, 5 minutes) bound to a purpose
(`REGISTER`, `AUTHENTICATE`, `REAUTH`) and, except for passwordless sign-in, to the user; a challenge is consumed in its
own transaction **before** the response is checked, so a failed or replayed response can never be retried with it.
Spent ones are deleted by `auth.recovery_expiry`. A signature counter that does not increase (when the authenticator
uses one) is refused by the library and a decrease by the DB (`PASSKEY_VERIFICATION_FAILED`, audit
`AUTH_PASSKEY_FAILED` with `reason: counter_regression`, security alert to the user). Every ceremony failure answers the
same 401 `PASSKEY_VERIFICATION_FAILED` and is audited with a reason (`challenge_invalid`, `unknown_credential`,
`account_unavailable`, `verification_failed`, `counter_regression`). A failed assertion against a known credential
counts towards the same MFA lockout as TOTP (`MFA_MAX_FAILURES` → `mfaLockedUntil`); a password-locked, MFA-locked,
suspended or deactivated account is refused like a wrong password. A passkey sign-in with user verification counts as
an MFA-verified session. At most 10 active passkeys per person (409). With a passkey and no TOTP, a password sign-in that
needs MFA answers `MFA_REQUIRED` (not `MFA_ENROLMENT_REQUIRED`).

#### 32.1 Passkeys

| Method | Path | Permission | Request | Response | Notes / Audit |
| --- | --- | --- | --- | --- | --- |
| POST | `/auth/passkeys/register/options` | Authenticated, MFA-verified session **(reauth)** | — | `PasskeyOptionsResponse` | Excludes the user's existing credentials. |
| POST | `/auth/passkeys/register/verify` | Authenticated **(reauth)** | `PasskeyRegisterVerify` | `PasskeySummary` (201) | Stores credential id, COSE key, counter, transports, backup flags. Security alert (`auth.security_alert`) to the user. Audit: `AUTH_PASSKEY_REGISTERED`. |
| GET | `/auth/passkeys` | Authenticated | — | `PasskeySummary[]` | Own, not revoked. |
| PATCH | `/auth/passkeys/:id` | Authenticated (own) | `PasskeyRename` | `PasskeySummary` | Audit: `AUTH_PASSKEY_RENAMED`. |
| DELETE | `/auth/passkeys/:id` | Authenticated (own) **(reauth)** | — | `OkResponse` | Revokes (never deletes). Audit: `AUTH_PASSKEY_REVOKED`. |
| POST | `/auth/passkey/login/options` | Public, rate-limited (IP + account) | `PasskeyLoginOptions` | `PasskeyOptionsResponse` | Same shape whether or not the account exists (no enumeration). |
| POST | `/auth/passkey/login/verify` | Public, rate-limited | `PasskeyLoginVerify` | `LoginResponse` (`AUTHENTICATED`) | Sets cookies with `mfa = true`. Locked / suspended accounts are refused like a wrong password. Audit: `AUTH_PASSKEY_LOGIN` / `AUTH_PASSKEY_FAILED`. Options never carry `allowCredentials` (discoverable credentials only); `email` is accepted and ignored. |
| POST | `/auth/mfa/passkey/options` | Public with a `verify` login challenge, rate-limited | `{ challengeToken }` | `PasskeyOptionsResponse` | Passkey as the **second factor** after the password: `allowCredentials` = the user's active passkeys (the password was already correct). Refused while MFA-locked. |
| POST | `/auth/mfa/passkey/verify` | same | `{ challengeToken, challengeId, response }` | `MeResponse` | Cookies with `mfa = true`. Audit: `AUTH_PASSKEY_LOGIN` (`step: mfa`), `AUTH_MFA_VERIFIED` (`method: passkey`). The challenge is bound to the token's user. |
| POST | `/auth/passkeys/reauth/options` | Authenticated | — | `PasskeyOptionsResponse` | Re-authentication with a passkey instead of password + TOTP (`REAUTH` challenge). 409 without a passkey. |
| POST | `/auth/passkeys/reauth/verify` | Authenticated | `{ challengeId, response }` | `OkResponse` | Sets a new access cookie carrying `rat` (like `POST /auth/reauth`). Audit: `AUTH_REAUTH` (`method: passkey`). |

`POST /admin/users/:id/reset-mfa` (§6.1, `users.reset_mfa`, reauth) additionally revokes the user's passkeys and unused
recovery codes.

#### 32.2 Recovery codes

| Method | Path | Permission | Request | Response | Notes / Audit |
| --- | --- | --- | --- | --- | --- |
| GET | `/auth/recovery-codes` | Authenticated | — | `RecoveryCodesStatus` | Remaining count only. |
| POST | `/auth/recovery-codes` | Authenticated, MFA-verified session **(reauth)** | — | `RecoveryCodesResponse` (201) | `RECOVERY_CODE_COUNT` codes shown once; argon2id hashes stored; the previous batch's unused codes are revoked. 409 when the account has no TOTP factor and no passkey. Audit: `AUTH_RECOVERY_CODES_GENERATED` (count only). |
| POST | `/auth/mfa/recovery` | Public with a `verify` challenge, rate-limited | `RecoveryCodeLogin` | `MeResponse` | Uses one code in place of TOTP or a passkey (same lockout counter as `/auth/mfa/verify`: a wrong code counts, and a locked account is refused even with a valid code, which stays unused). Spent by a conditional update (two concurrent uses cannot both succeed). Security alert to the user. Audit: `AUTH_RECOVERY_CODE_USED` (remaining count). |

#### 32.3 Assisted account recovery (lost authenticator and codes)

Status `ACCOUNT_RECOVERY_TRANSITIONS`: PENDING → APPROVED | REJECTED | EXPIRED | CANCELLED; APPROVED → COMPLETED |
EXPIRED | CANCELLED. One open request per user (partial unique index). Expiry `ACCOUNT_RECOVERY_TTL_HOURS` (DB allows at
most 72 h); approval and completion after expiry are refused by the DB.

| Method | Path | Permission | Request | Response | Notes / Audit |
| --- | --- | --- | --- | --- | --- |
| GET | `/admin/account-recovery` | `users.reset_mfa` | `AccountRecoveryListQuery` | `Paginated<AccountRecoverySummary>` | |
| GET | `/admin/account-recovery/:id` | `users.reset_mfa` | — | `AccountRecoverySummary` | |
| POST | `/admin/account-recovery` | `users.reset_mfa` **(reauth)** | `AccountRecoveryCreate` | `AccountRecoverySummary` (201) | Requester = caller ≠ subject (403 `SEPARATION_OF_DUTIES`). Notifies the other holders of `users.reset_mfa` in-app and alerts the subject (`auth.security_alert`). Audit: `ACCOUNT_RECOVERY_REQUESTED`. |
| POST | `/admin/account-recovery/:id/approve` | `users.reset_mfa` **(reauth)** | `AccountRecoveryDecision` | `AccountRecoverySummary` | Approver ≠ requester ≠ subject (DB check → 403). Generates a single-use 256-bit token (SHA-256 stored) and enqueues `auth.recovery_link` to the subject's account e-mail (`addressOverride`; token and `recoverPath` only in `secretPayload`). The link is never returned once e-mail delivery is configured (`devRecoveryPath: null`); e-mail configured but no outbox bound → **503**, nothing changes. Without a channel: `devRecoveryPath` (`/recover#tenant=<slug>&token=<token>`) is returned to the approver only, in this response only, and only when `NODE_ENV` is not production; in production without a channel → 409. Expired → 409 `INVALID_TRANSITION`. Audit: `ACCOUNT_RECOVERY_APPROVED` (`delivery`, `messageId`; never the token). |
| POST | `/admin/account-recovery/:id/reject` | `users.reset_mfa` | `AccountRecoveryDecision` | `AccountRecoverySummary` | Rejecter ≠ subject. Audit: `ACCOUNT_RECOVERY_REJECTED`. |
| POST | `/admin/account-recovery/:id/cancel` | `users.reset_mfa` | `AccountRecoveryDecision` | `AccountRecoverySummary` | Audit: `ACCOUNT_RECOVERY_CANCELLED`. |
| POST | `/auth/account-recovery/complete` | Public, rate-limited | `AccountRecoveryComplete` | `OkResponse` | Sets the new password; revokes all sessions, TOTP factors, passkeys (`revokedReason: account_recovery`) and unused recovery codes; clears login and MFA locks; `mfaEnabled = false`; the person enrols MFA at the next sign-in when their role needs it. COMPLETED (single use; an unknown, used or expired token → 401 with one generic message). Audit: `USER_MFA_RESET` (counts, request id, approver) and `ACCOUNT_RECOVERY_COMPLETED`. Web: `/recover` reads the token from the URL fragment and removes it from the address bar. |

The `auth.recovery_expiry` job (every 15 minutes, registered by `AuthRecoveryModule`) marks overdue PENDING / APPROVED
requests EXPIRED (audit `ACCOUNT_RECOVERY_EXPIRED`, SYSTEM actor) and deletes spent WebAuthn challenges (database clock).
`POST /admin/account-recovery` also refuses a non-ACTIVE subject (409; re-issue the invitation instead) and a second open
request (409), and notifies in-app only the other holders of `users.reset_mfa` (never the requester or the subject).
Reject and cancel are refused for the subject (403).

#### 32.4 Invitation delivery (change to §6.1)

`POST /admin/users` and `POST /admin/users/:id/invitation` keep their permissions and audits. When
`isDeliveryConfigured('EMAIL')`: the invitation token goes only into `secret_payload_encrypted` of an `auth.invitation`
message to the invited e-mail (`addressOverride`, idempotency key `invitation:<userId>:<first 16 of tokenHash>`); the
response `invitation` is `{ expiresAt, delivery: 'OUTBOX', messageId }` with **no** token or `acceptPath`. Otherwise
(no channel) the response is unchanged plus `delivery: 'SHOWN_ONCE'`. Re-issuing revokes the previous token as today.
The web user screens show "Invitation sent to …" or the one-time link accordingly.

### 33. Workspace setup and settings (`apps/api/src/modules/workspace`) — owner workspace-admin, S02, S03, S30

Status: **built** (`feat(workspace)`; migration `20261129200000_workspace_admin_provisioning`; tests
`apps/api/test/workspace-admin.integration.spec.ts`, `apps/api/src/modules/workspace/__tests__`). Web: `/setup`,
`/onboarding`, `/settings`, `/settings/finance` (`components/workspace/**`, `components/settings/**`).

Workspace sections live in `tenants.settings` (`logoFileId`, `environment`, `defaultCountyCode`, `dataProtection`,
`retention`, `security`, `backup`), written under a row lock (`SELECT … FOR UPDATE`), other keys untouched.

#### 33.1 Workspace creation and profile (S02)

| Method | Path | Permission | Request | Response | Notes / Audit |
| --- | --- | --- | --- | --- | --- |
| GET | `/platform/workspaces` | `platform.tenants.manage` | — | `PlatformWorkspaceSummary[]` | Caller's organisation must be PLATFORM (403 otherwise). Names, codes, type, status, demo flag only. |
| POST | `/platform/workspaces` | `platform.tenants.manage` **(reauth)** | `CreateWorkspace` (+ `environment`, `additionalAdmins` ≤ 4, `dataProtection`, `reason`) | `CreateWorkspaceResponse` `{ workspace, adminInvitation, additionalInvitations }` (201) | Caller's organisation must be PLATFORM (service 403 **and** DB). One transaction: `ngao_provision_workspace()` (SECURITY DEFINER; only when `app.tenant_id` is a PLATFORM tenant; never `PLATFORM` type, never `historical_demo`, status ACTIVE; the runtime role still has no INSERT on `tenants`), audit `WORKSPACE_CREATED` in the platform organisation, then the transaction's tenant setting switches to the new organisation: `SYSTEM_ROLES` (`provisionSystemRoles`), one `tenant_modules` row per module (environment preset when `modules` is empty; Office on ⇒ portal service account), every `WORKSPACE_SETUP_ITEMS` row PENDING, each administrator INVITED with `ORGANISATION_OWNER` (ORGANISATION scope). Audit in the new organisation: `WORKSPACE_CREATED`, `USER_CREATED`, `ROLE_ASSIGNED` with `actorType: PLATFORM_SUPPORT` (operator id). Invitations per §32.4: `isDeliveryConfigured('EMAIL')` ⇒ `auth.invitation` via the outbox (`addressOverride` = invited e-mail, payload `organisationName`, `tenantSlug`, `expiresAt`, token only in `secretPayload`, idempotency `invitation:<userId>:<first 16 of tokenHash>`), response `{ delivery: 'OUTBOX', messageId, acceptPath: null }`; outbox not bound ⇒ **503** and nothing is created; no channel ⇒ `{ delivery: 'SHOWN_ONCE', acceptPath }` once. `environment` must allow `type` (`WORKSPACE_ENVIRONMENT_DEFINITIONS`, 400); duplicate e-mails 400; unknown time zone 400; slug taken 409. `dataProtection` given here is recorded **unreviewed** (the organisation reviews it). |
| GET | `/workspace/profile` | `workspace.view` | — | `WorkspaceProfile` (+ `environment`, `defaultCountyCode`, `dataProtection` with `reviewedBy` / `reviewedAt`, `logoScanStatus`) | |
| PATCH | `/workspace/profile` | `workspace.configure` **(reauth)** | `UpdateWorkspaceProfile` (+ `defaultCountyCode`, `dataProtection`, `reason`) | `WorkspaceProfile` | Name and slug are fixed. `logoFileId`: tenant file, PNG / JPEG / WebP, CLEAN (409 `FILE_NOT_CLEAN` with `details.scanStatus`). Unknown time zone 400. `dataProtection` records the caller as reviewer; a new `privacyNoticeVersion` states the Office retention periods in force under that version (§33.3). Marks `workspace.profile` DONE. Audit: `WORKSPACE_PROFILE_UPDATED` (before / after, no secrets). |
| POST | `/workspace/logo` | `workspace.configure` | multipart `file` (PNG / JPEG / WebP ≤ 2 MB) | `{ fileId, scanStatus, sha256 }` (201) | Stored immutably (`purpose: OTHER`, metadata stripped), PENDING until scanned; usable as logo once CLEAN. |

#### 33.2 Onboarding checklist (S03)

| Method | Path | Permission | Request | Response | Notes / Audit |
| --- | --- | --- | --- | --- | --- |
| GET | `/workspace/onboarding` | `workspace.configure` | — | `OnboardingResponse` | Missing rows created PENDING (also for items added later). Each item: `autoDetect`, `detected`, `evidence` (counts only, no names) and `complete` (auto items: detected, or SKIPPED; manual items: DONE / SKIPPED); `completed` counts `complete`. Detection: `reference.import` (registry version + stations), `registry.approved` (an APPROVED registry version), `forms.approved` (an APPROVED form template), `org.teams` (a team), `users.invite` (≥ 2 people invited or active, system accounts excluded), `roles.configure` (≥ 2 people with an active role), `security.mfa_enrolled` (every active privileged user, per the MFA policy, has an active TOTP factor or passkey), `privacy.notice_reviewed` (`dataProtection.reviewedAt`), `retention.set` (retention saved), `backup.verified` (RESTORED_OK within `BACKUP_VERIFICATION_MAX_AGE_DAYS` = 90). |
| PATCH | `/workspace/onboarding/:itemKey` | `workspace.configure` | `UpdateSetupItem` | `WorkspaceSetupItem` | PENDING ↔ DONE / SKIPPED. **DONE on an auto item only while detected** (409 `CONFLICT`, `details.reason: 'NOT_DETECTED'`, `details.evidence`); SKIPPED needs a note ≥ 3 characters (400); unknown key 404. DONE / SKIPPED record `completed_by` / `completed_at` (DB check). An item marked DONE whose data later regresses shows `complete: false`. Audit: `WORKSPACE_SETUP_ITEM_UPDATED`. |

#### 33.3 System settings (S30)

| Method | Path | Permission | Request | Response | Notes / Audit |
| --- | --- | --- | --- | --- | --- |
| GET / PUT | `/workspace/modules`, `/workspace/modules/:key` | §8 | §8 | §8 | Existing module activation (re-auth, reason, `MODULE_UPDATED`); the S30 screen uses it. |
| GET | `/workspace/integrations` | `workspace.view` | — | `IntegrationsResponse` | One entry per `INTEGRATION_KINDS`: tenant selection (default provider, `enabled: false` when no row); `configured` = the server environment selects this provider and has its variables (default providers always configured); `missingEnv` = variable **names** (selector included, e.g. `EMAIL_PROVIDER`), never values; `available` = enabled, configured, not the default provider and: e-mail / SMS / push `isDeliveryConfigured(channel)`, captcha `CaptchaVerifierRegistry.get(provider)`, scanner `MALWARE_SCANNER.isConfigured()` and the last platform `files.scan_pending` run not FAILED. |
| GET | `/workspace/integrations/activity` | `workspace.view` | — | `IntegrationActivityResponse` | Per kind: last outbox message (`updatedAt`, status) or last scanned file (`scannedAt`, status) and 7-day counts by status. No addresses, file names or captcha verdicts (not stored). |
| PUT | `/workspace/integrations/:kind` | `workspace.configure` **(reauth)** | `UpdateIntegrationSetting` | `IntegrationStatus` | Provider must be in `INTEGRATION_PROVIDERS[kind]` (400); `config` strict per kind and no secret-looking key (400; DB check too); enabling a provider this server is not configured for → 409 `details.missingEnv`. `captcha` writes `captchaProvider` (`none` unless enabled) and `captchaSiteKey` into the office module config in the same transaction. Audit: `WORKSPACE_INTEGRATION_UPDATED` (before / after; config only). |
| GET | `/workspace/retention` | `workspace.view` | — | `RetentionResponse` `{ retentionProfile, office, statedUnderNotice, reviewedBy, reviewedAt, lastRun }` | `office` only while the Office module is on. `lastRun` = latest `office.retention` run (tenant row, or platform row read on a connection without a tenant setting; status, times, counts, never error text). |
| PUT | `/workspace/retention` | `workspace.configure` **(reauth)** | `UpdateRetention` `{ retentionProfile?: minimal \| standard \| extended, office?, newNoticeVersion?, reason }` | same | **Stricter than first contracted:** once Office periods are stated under a privacy-notice version, changing them in **either** direction needs `newNoticeVersion` different from the current and the stated version (409 `CONFLICT`, `details.reason: 'NOTICE_VERSION_REQUIRED'`, `details.statedUnderNotice`); the new version becomes `dataProtection.privacyNoticeVersion` (reviewer = caller) and states the new periods. Without a recorded notice the periods are free and the first notice states them. Records the reviewer (`retention.set`). Audit: `WORKSPACE_RETENTION_UPDATED` (profile, periods, stated notice). |
| GET | `/workspace/security` | `workspace.view` | — | `WorkspaceSecurityDetail` = `SecuritySettingsResponse` + `{ policy, serverSessionMaxHours, accessTokenMinutes, policyEnforcedAtSignIn, updatedBy, updatedAt }` | Counts only. `usersWithoutMfa` = active privileged users (role `mfa_required`, MFA-requiring permission, `mfaEnabled`, or everyone under `ALL_USERS`) without an active TOTP factor or passkey; `administratorsWithoutRecoveryCodes` = holders of `workspace.configure`, `users.create`, `roles.configure`, `roles.assign`, `users.reset_mfa` or `platform.tenants.manage` without an unused code. `policyEnforcedAtSignIn` is **false** until auth applies the policy (CHANGE_REQUESTS WA1). |
| PUT | `/workspace/security` | `workspace.configure` **(reauth)** | `UpdateWorkspaceSecurity` `{ mfaPolicy: PRIVILEGED_ROLES \| ALL_USERS, sessionMaxHours \| null, idleTimeoutMinutes \| null, reason }` | `WorkspaceSecurityDetail` | Only tightens the server: `sessionMaxHours` ≤ `JWT_REFRESH_TTL_SECONDS` / 3600 (400); idle ≤ session (400). Audit: `WORKSPACE_PROFILE_UPDATED`, `entityType: WorkspaceSecurityPolicy`. Helpers for auth: `readSecurityPolicy(tx, tenantId)`, `effectiveSignInPolicy(policy, serverRefreshTtl)` in `modules/workspace/workspace-settings.ts`. |
| GET | `/workspace/backup` | `workspace.view` | — | `BackupStatus` `{ last, current, maxAgeDays }` | |
| POST | `/workspace/backup/verifications` | `workspace.configure` | `RecordBackupVerification` `{ testedOn, backupReference, outcome: RESTORED_OK \| RESTORED_WITH_ISSUES \| FAILED, note }` | `BackupStatus` (201) | A restore test the operator ran outside the app (no credentials in the text); `testedOn` not in the future (400). `current` = RESTORED_OK within 90 days (`backup.verified`). Audit: `WORKSPACE_SETUP_ITEM_UPDATED`, `entityType: BackupVerification`. |

### 34. Files scanning and durable jobs (`apps/api/src/platform/scanning`, `apps/api/src/platform/jobs`) — owner platform-infra

Scan flow: `StorageService.storeImmutable()` inserts PENDING (unchanged) → `files.scan_pending` (every
`SCAN_INTERVAL_SECONDS`) takes PENDING / ERROR files per tenant (oldest first, small batches, `FOR UPDATE SKIP LOCKED`),
re-reads the bytes with `readVerified()`, calls `MALWARE_SCANNER.scan()` and writes the verdict: CLEAN / INFECTED (with
`scan_signature` and `quarantined_at`) / ERROR, `scan_engine`, `scanned_at`; appends `file_scan_events`; audits
`FILE_SCAN_RECORDED` (and `FILE_QUARANTINED`) as SYSTEM. INFECTED and quarantine are final (DB). With
`MALWARE_SCANNER=none` the job does nothing and files stay PENDING. The clamd adapter speaks `zINSTREAM` over TCP
(`CLAMD_HOST:CLAMD_PORT`, `CLAMD_TIMEOUT_MS`); a timeout or connection error is ERROR. Callers that need CLEAN (Office
project publication, finance supporting documents, workspace logo, public evidence) check `isScanClean` and answer 409
`FILE_NOT_CLEAN`; signed URLs for INFECTED files are refused (409 `FILE_NOT_CLEAN`).

| Method | Path | Permission | Request | Response | Notes / Audit |
| --- | --- | --- | --- | --- | --- |
| GET | `/files/:id/scan` | `workspace.view` | — | `FileScanSummary` | Tenant file only (RLS). |
| POST | `/files/:id/rescan` | `workspace.configure` **(reauth)** | `{ reason }` | `FileScanSummary` | Only PENDING / ERROR (409 otherwise); queues the file for the next scan run. Audit: `FILE_SCAN_RECORDED` (requested). |
| GET | `/platform/jobs` | `workspace.view` | — | `JobStatusResponse` | Registered keys, interval, last run (tenant runs of the caller's tenant and platform runs; platform errors shown as "failed" without text unless the caller holds `platform.health.view`). |
| GET | `/platform/jobs/runs` | `platform.health.view` | `JobRunsQuery` | `Paginated<JobRunSummary>` | Platform operators only. |
| POST | `/platform/jobs/:key/run` | `platform.tenants.manage` **(reauth)** | `{ reason }` | `JobRunSummary` | `JobScheduler.runNow`. Audit: `JOB_RUN_TRIGGERED`. |

Job keys (`JOB_KEYS`): `messaging.dispatch`, `files.scan_pending`, `office.retention` (replaces the in-process timer;
`OFFICE_RETENTION_INTERVAL_MINUTES` becomes its interval), `field.station_status_record` (replaces the recorder timer),
`tally.comparison_retry` (re-runs failed cross-stage comparisons), `tasks.due_soon`, `auth.recovery_expiry`. Each run
writes a `job_runs` row (RUNNING → SUCCEEDED with counts / FAILED with error; frozen when finished).

#### 34.1 Implementation notes (platform-infra, as built)

| Topic | As built |
| --- | --- |
| Re-run comparison | `POST /tally/submissions/:id/stage-comparison` — `tally.discrepancy.manage` (geo via the submission), module `tally`. VERIFIED collation / declaration forms only (409 otherwise). Response `{ submissionId, differences, caseId }` (`caseId` null when equal or a case is already open). Audit: `tally.stage_comparison.completed` (also written by every successful inline comparison). The `tally.comparison_retry` job (every 5 min) re-runs VERIFIED later-stage forms verified in the last 7 days (and ≥ 2 min ago) with no completion event and no cross-stage case, as the verifier; failures are audited (`tally.stage_comparison.failed`) and retried at 1, 2, 4 … min, at most 8 times. |
| Rescan | `POST /files/:id/rescan` scans the file now when a scanner is configured and returns the new verdict; without a scanner it answers 409 (the file stays PENDING). INFECTED / CLEAN → 409 `INVALID_TRANSITION`. |
| Scan job | ERROR files back off 1, 2, 4 … min (max 6 h) after each error. Every upload kicks the job (BullMQ, collapsed per 5 s). Quarantined objects: `StorageService.signedUrl()` refuses 409 `FILE_NOT_CLEAN` for any storage key with an INFECTED / quarantined row (SECURITY DEFINER `ngao_storage_key_quarantined`), and the local file route answers 404 for links issued before quarantine. |
| CLEAN consumers | Office public evidence (documents **and** photos) needs CLEAN: publishing unscanned evidence answers 409 `FILE_NOT_CLEAN` (`details.evidenceIds`), the public file route answers 404. Ledger approval counts CLEAN documents only (service and DB guard, migration `20261129000200`). |
| Field evidence | `FIELD_EVIDENCE` images are re-encoded without EXIF / XMP / GPS by `StorageService.storeImmutable` itself (the cleaned bytes are the stored original); HEIC is refused there (400). |
| Outbox recipients | `recipient_ref_type` also `CITIZEN_CASE` (Office acknowledgements; no user, the contact the requester gave; migration `20261129000000`). The sealed address of a citizen message is wiped at its final status (masked copy kept). Push messages go one row per active subscription (`PUSH_SUBSCRIPTION`); the outbox stores only a mask. |
| Push endpoints | `POST /me/push/subscriptions` accepts only HTTPS endpoints of known push services (`*.fcm.googleapis.com`, `*.push.services.mozilla.com`, `*.notify.windows.com`, `*.push.apple.com`; 400 otherwise) so the server never POSTs to arbitrary URLs. An endpoint already registered by another user of the tenant is revoked for them. 409 when the server has no messaging keys. |
| Inbound SMS | `STOP`, `STOP ALL`, `UNSUBSCRIBE`, `END`, `CANCEL`, `QUIT` (case-insensitive) opt out. A late `Buffered` report never overwrites a final one. |
| Notification centre | External channels are queued as `notification.alert` outbox messages in the `notify()` transaction (preferences, mandatory types and the 10-minute dedupe as before; quiet hours skip non-CRITICAL). `notification_deliveries` gets `QUEUED` (or `SKIPPED` with the reason) at enqueue and `SENT` / `FAILED` / `SKIPPED` per attempt, with the channel's provider name. `GET /notifications/preferences` reports `emailVerified` / `smsConsent` from contact verifications and `availableChannels` from configured providers. |
| Templates | `auth.invitation` and `auth.recovery_link` are e-mail only (an SMS or push enqueue throws); `addressOverride` is accepted only for invitation, recovery-link and verification templates. |
| Rate limits | Public `POST /auth/*` (except logout): `AUTH_RATE_LIMIT_MAX` per minute per IP and per 15 minutes per hashed identity (organisation + e-mail, `challengeToken`, one-time `token`) in `RATE_LIMIT_STORE`; the portal limiter uses the same store with hashed IP keys. Production always uses Redis; store errors answer 503 `RATE_LIMITED`. |
| Jobs | Intervals: `messaging.dispatch` `MESSAGING_DISPATCH_INTERVAL_SECONDS`; `files.scan_pending` `SCAN_INTERVAL_SECONDS` (on demand only without a scanner); `office.retention` `OFFICE_RETENTION_INTERVAL_MINUTES`; `field.station_status_record` `FIELD_WARROOM_RECORD_SECONDS`; `tally.comparison_retry` 5 min; `tasks.due_soon` hourly (owner only, once per due date, tasks due within 24 h). |

### 35. Display holds and redacted copies (`apps/api/src/modules/tally/controllers/display-holds.controller.ts`) — owner field-pin

HTTP access to what `pnpm demo:redact-34a` does today, through `DisplayHoldsService`. Module `tally`. Every response
carries `dataLabel` (parallel-tally disclaimer, plus HISTORICAL DEMO / SIMULATED DATA for demo tenants). A held original
is never served or altered.

| Method | Path | Permission | Request | Response | Notes / Audit |
| --- | --- | --- | --- | --- | --- |
| GET | `/tally/sources/holds` | `tally.source.download` (geo via the submission) | `DisplayHoldQuery` | `Paginated<DisplayHoldSummary>` | Scope-filtered by the linked submission's station. |
| GET | `/tally/sources/holds/:holdId` | `tally.source.download` (geo) | — | `DisplayHoldSummary` | |
| GET | `/tally/sources/holds/:holdId/redacted/url` | `tally.source.download` (geo) | — | `SignedUrlResponse` | Redacted copy only; 403 `NOT_FOR_DISPLAY_UNTIL_REDACTED` while none is attached; 409 `FILE_NOT_CLEAN` if the copy is not CLEAN. Audit: `FILE_SOURCE_ACCESSED`. |
| POST | `/tally/sources/holds/:holdId/redacted-copy` | `tally.approve` (geo) **(reauth)** | multipart `file` + `reason?` | `DisplayHoldSummary` | `attachRedactedCopy`: not the uploader of the original nor the declarer (403 `SEPARATION_OF_DUTIES`); image re-encoded without metadata; once only (409 `IMMUTABLE_RECORD`). Audit: `FILE_REDACTED_COPY_ATTACHED`. |
| POST | `/tally/sources/holds/:holdId/confirm` | `tally.approve` (geo) **(reauth)** | `ConfirmDeclaredRedaction` | `DisplayHoldSummary` | `confirmDeclaredRedaction` for DECLARED_REDACTED holds only (409 otherwise); same SoD. Audit: `FILE_REDACTED_COPY_ATTACHED`. |

### 36. Field offline PIN and evidence metadata — owner field-pin

No new endpoints. Client (as built, `apps/web/src/lib/offline/pin.ts`): the offline queue key is wrapped with a key
derived from a device PIN of 6–12 digits (PBKDF2-SHA-256, 600 000 iterations, random 128-bit salt per user and device;
AES-GCM wrap bound to the queue database name and the KDF parameters); only the wrapped key and salt are stored. `/m`
asks for the PIN before it opens the queue, online or offline, on every page load and after 5 minutes of inactivity.
Each attempt is counted before it is checked; after 3 failures each attempt waits 30 s doubling (cap 30 min); a warning
shows when 3 attempts are left; after 10 the queue is locked out (no PIN accepted any more). It is **not** wiped
silently: the screen shows the number of items not uploaded and erases them only when the person types that number. A
forgotten PIN is reset only online after `POST /auth/reauth` (password, plus the TOTP code when MFA is on), with the same
count confirmation (items not uploaded cannot be decrypted without the PIN). "Change PIN" checks the current PIN (counted
like an unlock) and re-wraps the same key. Queues created before the PIN are re-encrypted under a new wrapped key when
the PIN is first set. Sign-out deletes database and key (unchanged). Server: `POST /field/evidence` (§16.4) and incident / report evidence uploads
re-encode images and strip EXIF / location metadata server-side (`storage/image-sanitize.ts`) as the PWA already does,
storing the sanitised bytes as the original.

### Pilot hardening status, audit and error summary

| Record | Transitions | History | Audit actions |
| --- | --- | --- | --- |
| Outbox message | `MESSAGE_STATUS_TRANSITIONS` | `message_outbox_events` | `MESSAGE_CANCELLED` (admin) |
| Contact verification | supersede on address change | `contact_verification_events` | `CONTACT_VERIFICATION_SENT`, `CONTACT_VERIFIED`, `CONTACT_SMS_CONSENT_CHANGED`, `CONTACT_SMS_OPTED_OUT` |
| Push subscription | active → revoked | row kept | `PUSH_SUBSCRIBED`, `PUSH_UNSUBSCRIBED` |
| Stored file scan | PENDING / ERROR → CLEAN / INFECTED / ERROR; INFECTED final | `file_scan_events` | `FILE_SCAN_RECORDED`, `FILE_QUARANTINED` |
| Job run | RUNNING → SUCCEEDED / FAILED / SKIPPED; frozen | `job_runs` | `JOB_RUN_TRIGGERED` (manual) |
| Passkey | active → revoked | row kept | `AUTH_PASSKEY_REGISTERED`, `AUTH_PASSKEY_RENAMED`, `AUTH_PASSKEY_REVOKED`, `AUTH_PASSKEY_LOGIN`, `AUTH_PASSKEY_FAILED` |
| Recovery code | unused → used / revoked | rows kept | `AUTH_RECOVERY_CODES_GENERATED`, `AUTH_RECOVERY_CODE_USED` |
| Account recovery | `ACCOUNT_RECOVERY_TRANSITIONS` | audit | `ACCOUNT_RECOVERY_REQUESTED`, `…_APPROVED`, `…_REJECTED`, `…_CANCELLED`, `…_COMPLETED`, `…_EXPIRED` |
| Workspace | — | audit | `WORKSPACE_CREATED`, `WORKSPACE_PROFILE_UPDATED`, `WORKSPACE_SETUP_ITEM_UPDATED`, `WORKSPACE_INTEGRATION_UPDATED`, `WORKSPACE_RETENTION_UPDATED` |
| Display hold | AWAITING_REDACTION / DECLARED_REDACTED → REDACTED_COPY_ATTACHED (once) | hold row | `FILE_DISPLAY_HOLD_CREATED`, `FILE_REDACTION_DECLARED`, `FILE_REDACTED_COPY_ATTACHED` |

| Situation | Status | Code |
| --- | --- | --- |
| File not CLEAN where CLEAN is required | 409 | `FILE_NOT_CLEAN` |
| E-mail / SMS action needs a verified address or SMS consent | 409 | `CONTACT_NOT_VERIFIED` |
| Passkey ceremony failed (unknown credential, bad signature, counter regression, spent challenge) | 401 | `PASSKEY_VERIFICATION_FAILED` |
| Account recovery requester / approver / rejecter conflict | 403 | `SEPARATION_OF_DUTIES` |
| Refused outbox / recovery transition (incl. after expiry) | 409 | `INVALID_TRANSITION` |
| Captcha missing, invalid, unconfigured or provider down | 400 | `ABUSE_CHECK_FAILED` |
| Secret-looking key in integration config | 400 | `VALIDATION_FAILED` |
| Account / IP limit reached | 429 | `RATE_LIMITED` |

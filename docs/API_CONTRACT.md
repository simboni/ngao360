# NGAO360 REST API contract

This is the contract that the API module agents implement and the web UI agents code against.
Every request and response type named here is exported from `@ngao360/shared`
(`packages/shared/src`). If you need a field that is not here, add it to the shared schema
first, then update this file. Do not invent ad-hoc shapes.

Status: §2–3 are **implemented** in the foundation. §4–7 are **to be implemented** by the
reference, tally and admin module agents.

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

---

## 2. Auth (implemented: `apps/api/src/auth`)

| Method | Path | Permission | Request | Response | Notes / Audit |
| --- | --- | --- | --- | --- | --- |
| POST | `/auth/login` | Public, rate-limited | `LoginRequest` | `LoginResponse` | `AUTHENTICATED` sets cookies. `MFA_REQUIRED` or `MFA_ENROLMENT_REQUIRED` returns a 5-minute `challengeToken`. Locks the account after 5 failures for 15 min. Audit: `AUTH_LOGIN_SUCCEEDED` / `AUTH_LOGIN_FAILED`. |
| POST | `/auth/mfa/verify` | Public, rate-limited | `MfaVerifyRequest` | `MeResponse` | Sets cookies. TOTP replay is rejected. Audit: `AUTH_MFA_VERIFIED` / `AUTH_MFA_FAILED`. |
| POST | `/auth/mfa/enrol/start` | Public with `challengeToken`, or a session | `MfaEnrolStartRequest` | `MfaEnrolStartResponse` | Creates a PENDING TOTP factor. |
| POST | `/auth/mfa/enrol/confirm` | Public with `challengeToken`, or a session | `MfaEnrolConfirmRequest` | `MeResponse` | Activates the factor. With a challenge token it also completes login (sets cookies). Audit: `AUTH_MFA_ENROLLED`. |
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
| POST | `/reference/election-cycles` | `reference.edit` | `CreateElectionCycle` | `ElectionCycle` (201) | Takes `dataProvenance` (`LIVE`, `HISTORICAL` or `SYNTHETIC`). |
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
| GET | `/tally/submissions` | `tally.view` | `SubmissionQuery` | `Paginated<SubmissionSummary>` | Scope-filtered. `view=awaiting_me` shows SECOND_REVIEW_PENDING records the caller did not submit or edit. `view=mine` shows the caller's own. |
| GET | `/tally/submissions/:id` | `tally.view` **(geo: submission/params.id)** | `IdParam` | `SubmissionDetail` | `allowedActions` is computed from permissions, SoD and status. |
| GET | `/tally/submissions/:id/source-url` | `tally.view` **(geo)**. Add `?download=1` with `tally.source.download`. | `IdParam` | `SignedUrlResponse` | Inline view by default. Audit: `FILE_SOURCE_ACCESSED` on every call. |
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
| POST | `/admin/users` | `users.create` **(reauth)** | `CreateUser` | `UserDetail` (201) | Hashes passwords with argon2id (`AuthService.hashPassword`). Granting a role also needs `roles.assign`. Audit: `USER_CREATED`, plus `ROLE_ASSIGNED` for each assignment. |
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
| POST | `/admin/role-assignments` | `roles.assign` **(reauth)** | `CreateRoleAssignment` | `RoleAssignment` (201) | Checks the scope target exists, and `expiresAt > validFrom`. A user cannot grant a role to themself. Audit: `ROLE_ASSIGNED`. |
| POST | `/admin/role-assignments/:id/revoke` | `roles.assign` **(reauth)** | `RevokeRoleAssignment` | `RoleAssignment` | Soft revoke (`revokedAt`, `revokedById`, reason). Audit: `ROLE_REVOKED`. |

### 6.4 Audit log

| Method | Path | Permission | Request | Response | Notes / Audit |
| --- | --- | --- | --- | --- | --- |
| GET | `/admin/audit-events` | `audit.view` | `AuditQuery` | `Paginated<AuditEvent>` | Ordered by `seq desc`. |
| GET | `/admin/audit-events/:id` | `audit.view` | `IdParam` | `AuditEvent` | Recomputes `eventHash` and returns `integrity: 'OK' \| 'MISMATCH'`. |
| POST | `/admin/audit-events/export` | `audit.export` **(reauth)** | `AuditQuery` | `SignedUrlResponse` | CSV stored with `purpose: 'EXPORT'`. Audit: `AUDIT_EXPORTED`. |

## 7. Dashboard and notifications (admin module)

| Method | Path | Permission | Request | Response | Notes |
| --- | --- | --- | --- | --- | --- |
| GET | `/dashboard/summary` | `dashboard.view` | `{ electionCycleId? }` | `DashboardSummary` | KPIs: expected stations, forms received, verified, awaiting review, open discrepancies. Tally KPIs only appear for callers with `tally.view`. |
| GET | `/notifications` | Authenticated | `PaginationQuery & { unreadOnly? }` | `Paginated<Notification>` | Hides notifications whose `module` the user can no longer access. |
| POST | `/notifications/:id/read` | Authenticated | `IdParam` | `OkResponse` | Only the caller's own notifications. |
| POST | `/notifications/read-all` | Authenticated | none | `OkResponse` | |

---

## 8. Web client usage

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

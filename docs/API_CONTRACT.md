# NGAO360 REST API contract

This is the contract that the API module agents implement and the web UI agents code against.
Every request and response type named here is exported from `@ngao360/shared`
(`packages/shared/src`). If you need a field that is not here, add it to the shared schema
first, then update this file. Do not invent ad-hoc shapes.

Status: §2–8 are **implemented**. §9–13 (NGAO360 Office and its public portal) are **to be
implemented** by the office module agents; §13.1 (portal info) and the shared Office
infrastructure (module activation, geo resolvers, public rate limiter, abuse check, tenant
resolution) are already implemented.

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
| GET | `/tally/submissions` | `tally.view` | `SubmissionQuery` | `Paginated<SubmissionSummary>` | Scope-filtered. `view=awaiting_me` shows SECOND_REVIEW_PENDING records the caller did not submit or edit. `view=awaiting_supervisor` shows outcomes with a verification awaiting a supervisor action, excluding records the caller took part in. `view=mine` shows the caller's own. |
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
| POST | `/admin/role-assignments` | `roles.assign` **(reauth)** | `CreateRoleAssignment` | `RoleAssignment` (201) | Checks the scope target exists, and `expiresAt > validFrom`. A user cannot grant a role to themself. Grantor scope: an organisation-wide assignment needs an organisation-wide `roles.assign`; a geographic one must lie inside the grantor's `roles.assign` geography (and election cycle); a grantor whose `roles.assign` is not organisation-wide can only hand out permissions they hold over the same target (403 `OUT_OF_SCOPE`). Audit: `ROLE_ASSIGNED`. |
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
| GET | `/dashboard/summary` | `dashboard.view` | `{ electionCycleId? }` | `DashboardSummary` | KPIs: expected stations, forms received, verified, awaiting review, open discrepancies. Tally KPIs only appear for callers with `tally.view`. |
| GET | `/notifications` | Authenticated | `PaginationQuery & { unreadOnly? }` | `Paginated<Notification>` | Hides notifications whose `module` the user can no longer access. |
| POST | `/notifications/:id/read` | Authenticated | `IdParam` | `OkResponse` | Only the caller's own notifications. |
| POST | `/notifications/read-all` | Authenticated | none | `OkResponse` | |

## 8. Tenant module activation (implemented: `apps/api/src/tenant-modules`)

Modules (`TENANT_MODULES` in `@ngao360/shared`): `tally` (default **on**) and `office` (default
**off**). State lives in `tenant_modules` (RLS); a missing row means the default. `GET /auth/me`
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
| Concurrency | Mutable records carry `version`. Mutations take `expectedVersion` and update with `where: { id, version: expectedVersion }`, incrementing `version`; a stale value returns 409 `CONFLICT`. |
| Transitions | Use the shared `canTransition*()` helpers; an illegal move returns 409 `INVALID_TRANSITION`. Every transition writes the named audit action with before/after status and reason. |
| History | `case_events`, `meeting_decisions` and `correspondence_attachments` are append-only (DB trigger, `IMMUTABLE_RECORD`). No Office row is ever deleted (DB trigger). Project evidence may change only its verification and publication fields. Case submission content and references are immutable. |
| Files | `StorageService.storeImmutable(purpose: 'CORRESPONDENCE' \| 'CASE_EVIDENCE' \| 'PROJECT_EVIDENCE')` (images and PDFs only, sniffed, ≤ 25 MB). Downloads use `StorageService.signedUrl()` and every issuance is audited with `FILE_SOURCE_ACCESSED` (`entityType` = the Office record). Public-portal photos are stored with `uploadedById = config.portalServiceUserId`. |
| References | Internal sequential references via `nextReference(tx, tenantId, OFFICE_REFERENCE_PREFIX.*)`: `COR-IN-YYYY-NNNNNN`, `COR-OUT-…`, `APT-…`, `CASE-…`, `PRJ-…`. Citizen cases also get a random `publicReference` (`BG-7K3F-9Q2X`, prefix from the tenant slug initials) and an 8-character tracking code shown once; only its SHA-256 is stored (`allocatePublicReference`, `trackingCodeMatches`). |
| allowedActions | Detail DTOs return `allowedActions` computed from the caller's permissions, the record state and separation-of-duties rules, so the UI never offers an action the API will refuse. |
| Personal data | Requester contact is only in `citizen_case_contacts` and only returned by `GET /office/cases/:id/contact`. No list or detail DTO, export, notification or log line contains contact fields. |
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
| POST | `/office/correspondence/:id/assign` | `office.correspondence.edit` | `AssignCorrespondence` | `CorrespondenceDetail` | Assignee must be ACTIVE and hold `office.correspondence.view` (and `.confidential` for restricted items) — 400 otherwise. `RECEIVED` → `ASSIGNED` when assigning; unassigning keeps status. Audit: `CORRESPONDENCE_ASSIGNED`. Sends an in-app notification (`module: 'office'`, `type: 'correspondence.assigned'`, link `/office/correspondence/:id`). |
| POST | `/office/correspondence/:id/transition` | `office.correspondence.edit` | `CorrespondenceTransition` | `CorrespondenceDetail` | `CORRESPONDENCE_STATUS_TRANSITIONS`: `DRAFT→SENT\|ARCHIVED`, `RECEIVED→ASSIGNED\|FILED`, `ASSIGNED→IN_PROGRESS\|RESPONDED\|FILED`, `IN_PROGRESS→RESPONDED\|FILED`, `RESPONDED→FILED`, `SENT→FILED`, `FILED→ARCHIVED`. `SENT` sets `sentAt` (default now). `reason` required for `FILED` from RECEIVED/ASSIGNED/IN_PROGRESS (no response) and for `ARCHIVED`. Audit: `CORRESPONDENCE_STATUS_CHANGED`. |
| POST | `/office/correspondence/:id/attachments` | `office.correspondence.edit` | multipart `file` + `metadata` (`AddCorrespondenceAttachment` JSON) | `CorrespondenceAttachment` (201) | `storeImmutable(purpose: 'CORRESPONDENCE')`. A duplicate hash reuses the stored file; attaching the same file twice to one item returns 409. Not allowed when ARCHIVED. Audit: `FILE_STORED` (new files) + `CORRESPONDENCE_ATTACHMENT_ADDED`. |
| GET | `/office/correspondence/:id/attachments/:attachmentId/url` | `office.correspondence.view` | params | `SignedUrlResponse` | Inline view; `?download=1` for download. Audit: `FILE_SOURCE_ACCESSED` every call. |
| GET | `/office/correspondence/:id/history` | `office.correspondence.view` | `IdParam` | `AuditEvent[]` | Audit events for the item and its attachments, oldest first. |

## 10. Appointments and meetings (`apps/api/src/modules/office/appointments`)

Web: `/office/appointments` (diary with appointments and meetings tabs).

### 10.1 Appointments

| Method | Path | Permission | Request | Response | Notes / Audit |
| --- | --- | --- | --- | --- | --- |
| GET | `/office/appointments` | `office.appointments.view` | `AppointmentQuery` | `Paginated<AppointmentSummary>` | `from`/`to` filter on `confirmedStart`, falling back to `preferredStart`. `view=mine` (assigned to caller), `pending` (REQUESTED), `follow_up` (`followUpRequired` and `followUpDate ≤ today+7`). |
| GET | `/office/appointments/:id` | `office.appointments.view` | `IdParam` | `AppointmentDetail` | Contact fields are visible to holders of `office.appointments.view` (the requester gave them for this purpose). |
| POST | `/office/appointments` | `office.appointments.manage` | `CreateAppointment` | `AppointmentDetail` (201) | Reference `APT-…`, status `REQUESTED`. `privacyNoticeVersion` must equal `CURRENT_APPOINTMENT_PRIVACY_NOTICE_VERSION` (400 otherwise): the clerk reads or shows `appointmentPrivacyNotice()` to the requester. Audit: `APPOINTMENT_CREATED`. Audit snapshots never contain contact values: record `hasPhone` / `hasEmail` booleans instead (applies to every Office audit event). |
| PATCH | `/office/appointments/:id` | `office.appointments.manage` | `UpdateAppointment` | `AppointmentDetail` | Not in DECLINED/CANCELLED/COMPLETED except follow-up fields. Audit: `APPOINTMENT_UPDATED`. |
| POST | `/office/appointments/:id/transition` | `office.appointments.manage` | `AppointmentTransition` | `AppointmentDetail` | `APPOINTMENT_STATUS_TRANSITIONS`: `REQUESTED→CONFIRMED\|DECLINED\|CANCELLED`, `CONFIRMED→RESCHEDULED\|CANCELLED\|COMPLETED\|NO_SHOW`, `RESCHEDULED→CONFIRMED\|CANCELLED\|COMPLETED\|NO_SHOW`, `NO_SHOW→RESCHEDULED`. CONFIRMED/RESCHEDULED need `confirmedStart`; COMPLETED needs `outcome` (sets `outcomeRecordedAt`; optional follow-up fields); DECLINED/CANCELLED/NO_SHOW need `reason`. Audit: `APPOINTMENT_STATUS_CHANGED`. |

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
| RESOLUTION_PROPOSED, CITIZEN_FEEDBACK | CLOSED | `close` | `office.cases.close` | With `caseCloseRequiresSecondPerson` (default true) the closer must differ from `resolutionProposedById` (403 `SEPARATION_OF_DUTIES`). |
| CLOSED | REOPENED | `reopen` | `office.cases.close` | A new event; the earlier closure fields are kept in the timeline (`CLOSED` event) and cleared on the row. |

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
| POST | `/office/cases/:id/events` | `office.cases.manage` **(geo)**; `NOTE` also needs `office.cases.internal_notes` | `AddCaseEvent` | `CaseEvent` (201) | Visibility derived from type (NOTE/CONTACT_ATTEMPT → INTERNAL, PUBLIC_UPDATE → PUBLIC). Not in CLOSED except NOTE. Audit: `CASE_EVENT_ADDED` (`after` holds type and visibility; the body of a NOTE is never copied into the audit event). |
| POST | `/office/cases/:id/evidence` | `office.cases.manage` **(geo)** | multipart `file` + `metadata` (`AddCaseEvidence`) | `CaseEvent` (201) | `storeImmutable(purpose: 'CASE_EVIDENCE')`; event `EVIDENCE_ADDED`. PUBLIC evidence is listed (description only, no file) on the tracking page. Audit: `FILE_STORED` + `CASE_EVIDENCE_ADDED`. |
| GET | `/office/cases/:id/files/:fileId/url` | `office.cases.view` **(geo)** | params | `SignedUrlResponse` | Only files linked to the case's events. Audit: `FILE_SOURCE_ACCESSED`. |
| GET | `/office/cases/:id/contact` | `office.cases.contact.view` **(geo)** | `IdParam` | `CaseContact` (404 when none) | Every read is audited: `CASE_CONTACT_VIEWED` (no contact values in the event). |
| PUT | `/office/cases/:id/contact` | `office.cases.contact.view` + `office.cases.manage` **(geo)** | `UpdateCaseContact` | `CaseContact` | Correction at the requester's request. Audit: `CASE_CONTACT_UPDATED` (field names only). |
| POST | `/office/cases/:id/contact/erase` | `office.cases.close` **(geo)** **(reauth)** | `EraseCaseContact` | `CaseContact` | Data-subject erasure or retention: nulls name/phone/email, sets `erasedAt`; the case body stays. Audit: `CASE_CONTACT_ERASED`. |
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
`projects_verified_completion_check`) and not the uploader of any cited evidence.

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
| GET | `/public/:tenantSlug/projects/:id/evidence/:evidenceId/file` | public (`read`) | `PublicEvidenceParam` | 302 to a short-lived signed URL | Only `isPublic` evidence of a public project. Not audited (public record). |

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

# NGAO360 REST API contract

This is the contract that the API module agents implement and the web UI agents code against.
Every request and response type named here is exported from `@ngao360/shared`
(`packages/shared/src`). If you need a field that is not here, add it to the shared schema
first, then update this file. Do not invent ad-hoc shapes.

Status: §2–13 are **implemented** (NGAO360 Office included). §15–22 (field and election
operations, the War Room and offline sync) are **to be implemented** by the field module agents;
their data model, shared DTOs, module activation, geo resolvers, station-code location and scope
helpers and the idempotency ledger already exist.

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
| GET | `/dashboard/summary` | `dashboard.view` | `{ electionCycleId? }` | `DashboardSummary` | KPIs: expected stations, forms received, verified, awaiting review, open discrepancies. Tally KPIs only appear for callers with `tally.view`. "Stations with forms" match filed forms to the approved registry by station code within the cycle (station lineage), so a registry amendment never turns a received station into a missing one. |
| GET | `/notifications` | Authenticated | `PaginationQuery & { unreadOnly? }` | `Paginated<Notification>` | Hides notifications whose `module` the user can no longer access. |
| POST | `/notifications/:id/read` | Authenticated | `IdParam` | `OkResponse` | Only the caller's own notifications. |
| POST | `/notifications/read-all` | Authenticated | none | `OkResponse` | |

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

Status: **to be implemented** by the field module agents. The data model (migrations
`20261122000000_station_code_lineage`, `20261122000100_field_election_ops`), shared DTOs
(`packages/shared/src/field/`), DTO classes (`apps/api/src/modules/field/field.dto.ts`), geo
resolvers, location and scope helpers and the idempotency ledger
(`apps/api/src/modules/field/common/`) already exist. Blueprint: 6.1–6.3, 7, 10.3, 11.3, 13.4, 15.

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
| Files | Evidence is stored with `StorageService.storeImmutable(purpose: 'FIELD_EVIDENCE')` (accreditation documents: `'AGENT_DOCUMENT'`): sniffed images and PDFs only, ≤ 25 MB, content-addressed, immutable. Records attach files by id; a caller may attach only files they uploaded (`stored_files.uploaded_by_id`), else 400. Signed URLs are audited with `FILE_SOURCE_ACCESSED` (`entityType` = the field record). |
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
| POST | `/field/agents/:id/reveal` | `field.agents.reveal_sensitive` **(geo, reauth)** | `RevealAgentSensitive` | `AgentSensitiveReveal` | Only the requested fields. Refused for the caller's own agent record (403 `SEPARATION_OF_DUTIES`). `Cache-Control: no-store`. Audit: `AGENT_SENSITIVE_REVEALED` with `after: { fields }` and the reason. |
| PUT | `/field/agents/:id/sensitive` | `field.agents.reveal_sensitive` **(geo, reauth)** | `UpdateAgentSensitive` | `AgentDetail` | Given fields replace stored ones (`null` clears). Refreshes the masked columns and flags; bumps `version`. Audit: `AGENT_SENSITIVE_UPDATED` with changed field names only. |
| POST | `/field/agents/:id/trainings` | `field.agents.training` **(geo)** | `RecordTraining` | `AgentTraining` (201) | Audit: `AGENT_TRAINING_RECORDED`. |
| PATCH | `/field/agents/:id/trainings/:trainingId` | `field.agents.training` **(geo)** | `TrainingParam` + `UpdateTraining` | `AgentTraining` | The training must belong to the agent (404). Audit: `AGENT_TRAINING_RECORDED` (before/after). |
| PUT | `/field/agents/:id/accreditation` | `field.agents.accreditation` **(geo)** | `SetAccreditation` | `AgentAccreditation` | Upsert per (agent, cycle). Records the status; NGAO360 never grants accreditation. Audit: `AGENT_ACCREDITATION_RECORDED`. |
| POST | `/field/agents/:id/accreditation/evidence` | `field.agents.accreditation` **(geo)** | multipart `file` + `metadata` `{ electionCycleId }` | `AgentAccreditation` | `storeImmutable(purpose: 'AGENT_DOCUMENT')` → `evidenceFileId`. Accreditation letters only, never ID copies (UI warning). Audit: `FILE_STORED`, `AGENT_ACCREDITATION_RECORDED`. |
| POST | `/field/agents/:id/user` | `field.agents.edit` **(geo)** | `LinkAgentUser` | `AgentDetail` | Links (or with `null` unlinks) an ACTIVE user of the tenant who is not linked to another agent (409). Grants no role: the station-scoped Polling agent role is assigned in `/admin/role-assignments`. Audit: `AGENT_USER_LINKED`. |
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
| GET | `/field/deployments/coverage` | `field.deployment.view` | `DeploymentCoverageQuery` | `DeploymentCoverage` | Planner grid: every station of the approved registry in scope (`expectedStations`, the denominator), its active slots, `covered` = an active CHIEF_AGENT or STATION_AGENT. Uncovered stations are listed as "Not assigned", never dropped. `conflicts` lists double bookings, inactive or unaccredited agents and codes missing from the approved registry. |
| GET | `/field/deployments/:id` | `field.deployment.view` **(geo)** | `FieldIdParam` | `DeploymentDetail` | Events oldest first; `checkInLocation` only here; `warnings` = non-blocking conflicts. |
| POST | `/field/deployments` | `field.deployment.plan` | `CreateDeployment` | `DeploymentDetail` (201) | Station code resolved in the approved registry and inside the caller's plan scope (403 `OUT_OF_SCOPE`). Agent must exist, be ACTIVE or STANDBY (409 `CONFLICT`, kind `AGENT_NOT_ACTIVE`) and be visible to the caller. Blocking conflicts (`AGENT_DOUBLE_BOOKED` on an overlapping shift, `SLOT_ALREADY_FILLED` for a second chief agent) answer 409 `CONFLICT` with `details.conflicts: DeploymentConflict[]`; `AGENT_NOT_ACCREDITED` is a warning. Status ASSIGNED; event CREATED. Notification `deployment.assigned` to the agent's user. Audit: `DEPLOYMENT_CREATED`. |
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
| POST | `/field/reports` | `field.reports.submit` | `CreateFieldReport` | `FieldReportDetail` (201; replay 200) | Template must be ACTIVE, or have been ACTIVE at `clientCreatedAt` for an offline item (else 409 `CONFLICT`, `reason: 'SERVER_CHANGED'`, `serverState` = current template). Location (station code or area) inside the caller's `field.reports.submit` scope, so a station-scoped agent reports on their own station(s) only (403 `OUT_OF_SCOPE`). `validateFieldAnswers()` must return nothing (400, `path: ['answers', key]`). `eventAt` within the offline age window. `supersedesReportId` must be the caller's own RETURNED report. Reference `FRP-YYYY-NNNNNN`. Ledger kind `FIELD_REPORT`. Audit: `FIELD_REPORT_SUBMITTED` (reference, template key/version, station code, offline flag, answered question keys; no free text). |
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
| GET | `/field/incidents/:id` | `field.incidents.view` **(geo)**, or the reporter | `FieldIdParam` | `IncidentDetail` | Reporter-only callers get the report, status, outcome and their own events (other people's notes hidden). `hasSubject` only; the record itself is §20 subject. |
| POST | `/field/incidents` | `field.incidents.report` | `CreateIncident` | `IncidentDetail` (201; replay 200) | Location inside the caller's report scope (403 `OUT_OF_SCOPE`); station-scoped agents report on their own station(s). `initialSeverity` = `severity` = `config.incidentSeverityDefaults[category]`; `reportedCategory` = `category`. `evidenceFileIds` uploaded by the caller (`original=true` links). Status REPORTED; reference `INC-YYYY-NNNNNN`; events REPORTED (+ EVIDENCE_ADDED). Ledger kind `INCIDENT`. HIGH/CRITICAL notify the incident desk in scope. Audit: `INCIDENT_REPORTED` (reference, category, severity, station code, offline flag, description length; not the text). |
| POST | `/field/incidents/:id/triage` | `field.incidents.triage` **(geo)** | `TriageIncident` | `IncidentDetail` | REPORTED → TRIAGED, or re-triage (severity, category, sensitivity) in TRIAGED / ASSIGNED / ESCALATED without a status change. Triager ≠ reporter (403 `SEPARATION_OF_DUTIES`). Event TRIAGED `{ severity, previousSeverity, category?, previousCategory? }`. Audit: `INCIDENT_TRIAGED`. |
| POST | `/field/incidents/:id/assign` | `field.incidents.assign` **(geo)** | `AssignIncident` | `IncidentDetail` | From TRIAGED, ESCALATED or RESOLVED (sending a resolution back) → ASSIGNED. Assignee ACTIVE and holding `field.incidents.triage` over the incident location (400). Event ASSIGNED; notification `incident.assigned`. Audit: `INCIDENT_ASSIGNED`. |
| POST | `/field/incidents/:id/escalate` | `field.incidents.escalate` **(geo)** | `EscalateIncident` | `IncidentDetail` | From TRIAGED, ASSIGNED or RESOLVED → ESCALATED, `escalatedTo`; optional new assignee (same rule). Event ESCALATED; notification `incident.escalated`. Audit: `INCIDENT_ESCALATED`. |
| POST | `/field/incidents/:id/events` | `field.incidents.triage` **(geo)**; `REFERRED` and evidence holds need `field.incidents.escalate`; the reporter may add `CORRECTION` to their own incident | `AddIncidentEvent` | `IncidentEvent` (201) | Append-only; not on CLOSED (409 `INVALID_TRANSITION`). A CORRECTION never changes the original report: the detail shows it beside the report. Evidence hold sets `evidenceHold` (release clears it). Audit: `INCIDENT_EVENT_ADDED`. |
| POST | `/field/incidents/:id/evidence` | reporter (`field.incidents.report`), or `field.incidents.triage` **(geo)** | `AttachEvidence` | `IncidentDetail` | Files uploaded by the caller; appends `incident_evidence` and an EVIDENCE_ADDED event. Audit: `INCIDENT_EVIDENCE_ADDED`. |
| GET | `/field/incidents/:id/evidence/:fileId/url` | `field.incidents.view` **(geo)** | params, `DownloadQuery` | `SignedUrlResponse` | Audit: `FILE_SOURCE_ACCESSED`. |
| POST | `/field/incidents/:id/resolve` | `field.incidents.resolve` **(geo)** | `ResolveIncident` | `IncidentDetail` | From TRIAGED, ASSIGNED or ESCALATED → RESOLVED with `outcome` and note. `DUPLICATE` needs `duplicateOfId` (another visible incident). UNRESOLVED is the outcome for disputed matters; they never read as resolved. Event RESOLVED. Audit: `INCIDENT_RESOLVED`. |
| POST | `/field/incidents/:id/close` | `field.incidents.close` **(geo)** | `CloseIncident` | `IncidentDetail` | RESOLVED → CLOSED with a closure note; closer ≠ reporter and ≠ resolver (403 `SEPARATION_OF_DUTIES`; DB check `incidents_closer_check`). Event CLOSED. Audit: `INCIDENT_CLOSED`. |
| POST | `/field/incidents/:id/reopen` | `field.incidents.close` **(geo)** | `ReopenIncident` | `IncidentDetail` | CLOSED → TRIAGED with a reason; resolution and closure fields are cleared on the row (they remain in events and audit). Event REOPENED. Audit: `INCIDENT_REOPENED`. |
| GET | `/field/incidents/:id/subject` | `field.incidents.view_subject` **(geo)** | `FieldIdParam` | `IncidentSubject[]` | Newest first. Every call is audited: `INCIDENT_SUBJECT_VIEWED`. |
| POST | `/field/incidents/:id/subject` | `field.incidents.view_subject` **(geo, reauth)** | `RecordIncidentSubject` | `IncidentSubject` (201) | Append-only. Event SUBJECT_RECORDED with the note "Restricted subject record added" only. Audit: `INCIDENT_SUBJECT_RECORDED` (length, reason; not the text). |
| GET | `/field/incidents/:id/history` | `field.incidents.view` **(geo)** | `FieldIdParam` | `AuditEvent[]` | Oldest first; subject views listed without content. |

### 21. War Room (`apps/api/src/modules/field/warroom`) — S16

Web: `/warroom` (layout renders `WarRoomBanner`). `@RequireModule('field', 'tally')`. Scope:
`warroom.view` geography and cycle (station-scoped grants by code). Station status (blueprint 7.2)
is derived **at read time** by `deriveStationStatus()` from deployments (best active status at the
station), field reports (any report = update received), open HIGH/CRITICAL incidents and tally intake
(station-form submissions matched by **station code**: none / received / verification pending /
verified (canonical VERIFIED) / flagged (open holding case, DISPUTED, QUARANTINED)), combined with a
manual override in `station_statuses`. When the derived status differs from the stored one, the read
updates `station_statuses.derived_status` and appends a DERIVED `station_status_events` row in its
own transaction (history of observed changes); manual changes append MANUAL rows.

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

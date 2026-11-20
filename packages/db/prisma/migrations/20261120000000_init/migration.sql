-- CreateEnum
CREATE TYPE "TenantType" AS ENUM ('CAMPAIGN', 'POLITICAL_PARTY', 'ELECTED_OFFICE', 'OBSERVER_ORGANISATION', 'PLATFORM');

-- CreateEnum
CREATE TYPE "TenantStatus" AS ENUM ('ACTIVE', 'SUSPENDED', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "UserStatus" AS ENUM ('INVITED', 'ACTIVE', 'SUSPENDED', 'DEACTIVATED');

-- CreateEnum
CREATE TYPE "MfaFactorType" AS ENUM ('TOTP');

-- CreateEnum
CREATE TYPE "MfaFactorStatus" AS ENUM ('PENDING', 'ACTIVE', 'REVOKED');

-- CreateEnum
CREATE TYPE "ScopeType" AS ENUM ('ORGANISATION', 'COUNTY', 'CONSTITUENCY', 'WARD', 'POLLING_CENTRE', 'POLLING_STATION');

-- CreateEnum
CREATE TYPE "SensitivityLevel" AS ENUM ('PUBLIC', 'INTERNAL', 'CONFIDENTIAL', 'HIGHLY_RESTRICTED');

-- CreateEnum
CREATE TYPE "AuditActorType" AS ENUM ('USER', 'SYSTEM', 'PLATFORM_SUPPORT');

-- CreateEnum
CREATE TYPE "ElectionCycleStatus" AS ENUM ('DRAFT', 'ACTIVE', 'CLOSED', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "GeographicUnitType" AS ENUM ('COUNTY', 'CONSTITUENCY', 'WARD', 'POLLING_CENTRE');

-- CreateEnum
CREATE TYPE "RegistryVersionStatus" AS ENUM ('DRAFT', 'APPROVED', 'SUPERSEDED');

-- CreateEnum
CREATE TYPE "PollingStationStatus" AS ENUM ('ACTIVE', 'INACTIVE', 'PENDING_VERIFICATION');

-- CreateEnum
CREATE TYPE "TallyCentreLevel" AS ENUM ('CONSTITUENCY', 'COUNTY', 'NATIONAL');

-- CreateEnum
CREATE TYPE "OfficeType" AS ENUM ('PRESIDENT', 'NATIONAL_ASSEMBLY', 'COUNTY_ASSEMBLY', 'GOVERNOR', 'SENATOR', 'WOMAN_REPRESENTATIVE');

-- CreateEnum
CREATE TYPE "ContestStatus" AS ENUM ('DRAFT', 'ACTIVE', 'CLOSED');

-- CreateEnum
CREATE TYPE "FormLevel" AS ENUM ('POLLING_STATION', 'CONSTITUENCY', 'COUNTY', 'NATIONAL', 'CERTIFICATE');

-- CreateEnum
CREATE TYPE "FormTemplateApprovalState" AS ENUM ('DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'RETIRED');

-- CreateEnum
CREATE TYPE "OperationalStatus" AS ENUM ('NOT_ASSIGNED', 'ASSIGNED', 'CONFIRMED', 'CHECKED_IN', 'UPDATE_RECEIVED', 'FORM_EXPECTED', 'FORM_RECEIVED', 'VERIFICATION_PENDING', 'VERIFIED_FOR_PARALLEL_TALLY', 'FLAGGED', 'CLOSED');

-- CreateEnum
CREATE TYPE "SubmissionStatus" AS ENUM ('DRAFT', 'SUBMITTED', 'OCR_COMPLETE', 'DATA_ENTRY_REVIEWED', 'SECOND_REVIEW_PENDING', 'VERIFIED', 'RETURNED', 'DISPUTED', 'QUARANTINED', 'EXCLUDED_FROM_AGGREGATE', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "SubmissionSourceType" AS ENUM ('AGENT_UPLOAD', 'CLERK_UPLOAD', 'AUTHORISED_CHANNEL', 'PUBLIC_PORTAL_COPY');

-- CreateEnum
CREATE TYPE "ImageQuality" AS ENUM ('GOOD', 'ACCEPTABLE', 'POOR', 'ILLEGIBLE');

-- CreateEnum
CREATE TYPE "ResultValueChangeSource" AS ENUM ('OCR', 'MANUAL_ENTRY', 'VERIFIER_CORRECTION', 'SUPERVISOR_RESOLUTION');

-- CreateEnum
CREATE TYPE "OcrExtractionStatus" AS ENUM ('QUEUED', 'RUNNING', 'COMPLETED', 'FAILED', 'NOT_CONFIGURED');

-- CreateEnum
CREATE TYPE "ValidationOutcome" AS ENUM ('PASS', 'WARNING', 'FAIL');

-- CreateEnum
CREATE TYPE "VerificationDecision" AS ENUM ('PASS', 'RETURN', 'DISPUTE');

-- CreateEnum
CREATE TYPE "SupervisorAction" AS ENUM ('APPROVED', 'REJECTED', 'THIRD_CHECK_REQUESTED');

-- CreateEnum
CREATE TYPE "DiscrepancyType" AS ENUM ('ARITHMETIC', 'METADATA', 'IMAGE_QUALITY', 'DUPLICATE', 'CROSS_STAGE_MISMATCH', 'FORM_VERSION_MISMATCH', 'REVIEWER_DISAGREEMENT');

-- CreateEnum
CREATE TYPE "DiscrepancySeverity" AS ENUM ('LOW', 'MEDIUM', 'HIGH', 'CRITICAL');

-- CreateEnum
CREATE TYPE "DiscrepancyStatus" AS ENUM ('OPEN', 'UNDER_REVIEW', 'ESCALATED', 'RESOLVED', 'CLOSED');

-- CreateEnum
CREATE TYPE "DiscrepancyLinkRole" AS ENUM ('SOURCE_A', 'SOURCE_B', 'RELATED');

-- CreateEnum
CREATE TYPE "StoredFilePurpose" AS ENUM ('RESULT_FORM', 'EVIDENCE', 'EXPORT', 'REFERENCE_IMPORT', 'OTHER');

-- CreateEnum
CREATE TYPE "MalwareScanStatus" AS ENUM ('PENDING', 'CLEAN', 'INFECTED', 'SKIPPED');

-- CreateEnum
CREATE TYPE "StorageDriverKind" AS ENUM ('LOCAL', 'S3');

-- CreateEnum
CREATE TYPE "ExportFormat" AS ENUM ('CSV', 'XLSX', 'PDF');

-- CreateEnum
CREATE TYPE "IncidentStatus" AS ENUM ('NEW', 'ACKNOWLEDGED', 'ASSIGNED', 'IN_PROGRESS', 'ESCALATED', 'UNRESOLVED', 'CLOSED');

-- CreateEnum
CREATE TYPE "IncidentPriority" AS ENUM ('LOW', 'MEDIUM', 'HIGH', 'URGENT');

-- CreateEnum
CREATE TYPE "NotificationChannel" AS ENUM ('IN_APP', 'EMAIL', 'SMS');

-- CreateTable
CREATE TABLE "tenants" (
    "id" UUID NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "display_name" TEXT,
    "type" "TenantType" NOT NULL,
    "status" "TenantStatus" NOT NULL DEFAULT 'ACTIVE',
    "locale" TEXT NOT NULL DEFAULT 'en-KE',
    "timezone" TEXT NOT NULL DEFAULT 'Africa/Nairobi',
    "retention_profile" TEXT NOT NULL DEFAULT 'standard',
    "data_region" TEXT NOT NULL DEFAULT 'ke',
    "settings" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "tenants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "phone" TEXT,
    "display_name" TEXT NOT NULL,
    "password_hash" TEXT,
    "status" "UserStatus" NOT NULL DEFAULT 'INVITED',
    "mfa_enabled" BOOLEAN NOT NULL DEFAULT false,
    "last_login_at" TIMESTAMPTZ(3),
    "failed_login_count" INTEGER NOT NULL DEFAULT 0,
    "locked_until" TIMESTAMPTZ(3),
    "password_changed_at" TIMESTAMPTZ(3),
    "privacy_notice_version" TEXT,
    "privacy_notice_accepted_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "roles" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "restrictions" TEXT,
    "is_system" BOOLEAN NOT NULL DEFAULT false,
    "mfa_required" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "roles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "permissions" (
    "key" TEXT NOT NULL,
    "module" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "high_risk" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "permissions_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "role_permissions" (
    "tenant_id" UUID NOT NULL,
    "role_id" UUID NOT NULL,
    "permission_key" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "role_permissions_pkey" PRIMARY KEY ("role_id","permission_key")
);

-- CreateTable
CREATE TABLE "role_assignments" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "role_id" UUID NOT NULL,
    "scope_type" "ScopeType" NOT NULL DEFAULT 'ORGANISATION',
    "geographic_unit_id" UUID,
    "polling_station_id" UUID,
    "election_cycle_id" UUID,
    "valid_from" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ(3),
    "granted_by_id" UUID,
    "reason" TEXT,
    "revoked_at" TIMESTAMPTZ(3),
    "revoked_by_id" UUID,
    "revoked_reason" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "role_assignments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sessions" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "refresh_token_hash" TEXT NOT NULL,
    "mfa_verified_at" TIMESTAMPTZ(3),
    "reauth_at" TIMESTAMPTZ(3),
    "user_agent" TEXT,
    "ip_address" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_used_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "revoked_at" TIMESTAMPTZ(3),
    "revoked_reason" TEXT,

    CONSTRAINT "sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mfa_factors" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "type" "MfaFactorType" NOT NULL DEFAULT 'TOTP',
    "status" "MfaFactorStatus" NOT NULL DEFAULT 'PENDING',
    "label" TEXT,
    "secret_encrypted" TEXT NOT NULL,
    "last_used_step" BIGINT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "verified_at" TIMESTAMPTZ(3),
    "revoked_at" TIMESTAMPTZ(3),

    CONSTRAINT "mfa_factors_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_events" (
    "id" UUID NOT NULL,
    "seq" BIGSERIAL NOT NULL,
    "tenant_id" UUID NOT NULL,
    "actor_id" UUID,
    "actor_type" "AuditActorType" NOT NULL DEFAULT 'USER',
    "action" TEXT NOT NULL,
    "entity_type" TEXT NOT NULL,
    "entity_id" TEXT,
    "before_hash" TEXT,
    "after_hash" TEXT,
    "before" JSONB,
    "after" JSONB,
    "reason" TEXT,
    "source_ip" TEXT,
    "user_agent" TEXT,
    "request_id" TEXT,
    "event_hash" TEXT NOT NULL,
    "occurred_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reference_sequences" (
    "tenant_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "next_value" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "reference_sequences_pkey" PRIMARY KEY ("tenant_id","name")
);

-- CreateTable
CREATE TABLE "election_cycles" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "election_date" DATE NOT NULL,
    "jurisdiction" TEXT NOT NULL DEFAULT 'Kenya',
    "legal_config_version" TEXT NOT NULL,
    "status" "ElectionCycleStatus" NOT NULL DEFAULT 'DRAFT',
    "official_sources" JSONB NOT NULL DEFAULT '[]',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "election_cycles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "registry_versions" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "election_cycle_id" UUID NOT NULL,
    "version" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "status" "RegistryVersionStatus" NOT NULL DEFAULT 'DRAFT',
    "station_count" INTEGER NOT NULL DEFAULT 0,
    "source_file_id" UUID,
    "notes" TEXT,
    "imported_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "approved_by_id" UUID,
    "approved_at" TIMESTAMPTZ(3),

    CONSTRAINT "registry_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "geographic_units" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "election_cycle_id" UUID NOT NULL,
    "registry_version_id" UUID,
    "type" "GeographicUnitType" NOT NULL,
    "parent_id" UUID,
    "official_code" TEXT NOT NULL,
    "official_name" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "source_version" TEXT NOT NULL,
    "valid_from" DATE,
    "valid_to" DATE,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "geographic_units_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "polling_stations" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "election_cycle_id" UUID NOT NULL,
    "registry_version_id" UUID NOT NULL,
    "geographic_unit_id" UUID NOT NULL,
    "county_id" UUID NOT NULL,
    "constituency_id" UUID NOT NULL,
    "ward_id" UUID NOT NULL,
    "polling_centre_id" UUID,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "stream_number" INTEGER,
    "registered_voters" INTEGER,
    "status" "PollingStationStatus" NOT NULL DEFAULT 'ACTIVE',
    "latitude" DECIMAL(9,6),
    "longitude" DECIMAL(9,6),
    "location_source" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "polling_stations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tally_centres" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "election_cycle_id" UUID NOT NULL,
    "level" "TallyCentreLevel" NOT NULL,
    "geographic_unit_id" UUID,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "tally_centres_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "contests" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "election_cycle_id" UUID NOT NULL,
    "office_type" "OfficeType" NOT NULL,
    "name" TEXT NOT NULL,
    "geographic_unit_id" UUID,
    "form_series" TEXT NOT NULL,
    "status" "ContestStatus" NOT NULL DEFAULT 'DRAFT',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "contests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "candidate_references" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "contest_id" UUID NOT NULL,
    "candidate_name_as_published" TEXT NOT NULL,
    "party_label" TEXT,
    "is_independent" BOOLEAN NOT NULL DEFAULT false,
    "ballot_order" INTEGER NOT NULL,
    "reference_code" TEXT,
    "source" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "candidate_references_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "form_templates" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "election_cycle_id" UUID NOT NULL,
    "contest_type" "OfficeType" NOT NULL,
    "form_number" TEXT NOT NULL,
    "form_level" "FormLevel" NOT NULL,
    "version" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "effective_date" DATE NOT NULL,
    "field_schema" JSONB NOT NULL,
    "validation_rules" JSONB NOT NULL,
    "official_source" TEXT NOT NULL,
    "official_source_url" TEXT,
    "approval_state" "FormTemplateApprovalState" NOT NULL DEFAULT 'DRAFT',
    "approved_by_id" UUID,
    "approved_at" TIMESTAMPTZ(3),
    "created_by_id" UUID,
    "notes" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "form_templates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stored_files" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "sha256" CHAR(64) NOT NULL,
    "mime_type" TEXT NOT NULL,
    "size_bytes" BIGINT NOT NULL,
    "original_filename" TEXT NOT NULL,
    "purpose" "StoredFilePurpose" NOT NULL,
    "storage_driver" "StorageDriverKind" NOT NULL,
    "storage_key" TEXT NOT NULL,
    "page_count" INTEGER,
    "malware_scan_status" "MalwareScanStatus" NOT NULL DEFAULT 'PENDING',
    "scanned_at" TIMESTAMPTZ(3),
    "uploaded_by_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "stored_files_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "result_submissions" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "reference" TEXT NOT NULL,
    "election_cycle_id" UUID NOT NULL,
    "contest_id" UUID NOT NULL,
    "form_template_id" UUID NOT NULL,
    "form_number" TEXT NOT NULL,
    "polling_station_id" UUID,
    "tally_centre_id" UUID,
    "geographic_unit_id" UUID,
    "registry_version_id" UUID,
    "submitter_id" UUID NOT NULL,
    "source_file_id" UUID NOT NULL,
    "source_type" "SubmissionSourceType" NOT NULL,
    "status" "SubmissionStatus" NOT NULL DEFAULT 'DRAFT',
    "is_canonical" BOOLEAN NOT NULL DEFAULT true,
    "duplicate_flag" BOOLEAN NOT NULL DEFAULT false,
    "duplicate_of_id" UUID,
    "declaration" JSONB NOT NULL DEFAULT '{}',
    "original_metadata" JSONB NOT NULL DEFAULT '{}',
    "image_quality" "ImageQuality",
    "page_count" INTEGER,
    "idempotency_key" UUID NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "submitted_at" TIMESTAMPTZ(3),
    "verified_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "result_submissions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "result_values" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "submission_id" UUID NOT NULL,
    "field_key" TEXT NOT NULL,
    "candidate_reference_id" UUID,
    "numeric_value" INTEGER,
    "text_value" TEXT,
    "ocr_value" TEXT,
    "ocr_confidence" DECIMAL(5,4),
    "confirmed_by_id" UUID,
    "confirmed_at" TIMESTAMPTZ(3),
    "change_version" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "result_values_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "result_value_changes" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "result_value_id" UUID NOT NULL,
    "submission_id" UUID NOT NULL,
    "field_key" TEXT NOT NULL,
    "change_version" INTEGER NOT NULL,
    "old_numeric_value" INTEGER,
    "new_numeric_value" INTEGER,
    "old_text_value" TEXT,
    "new_text_value" TEXT,
    "source" "ResultValueChangeSource" NOT NULL,
    "actor_id" UUID NOT NULL,
    "reason" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "result_value_changes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ocr_extractions" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "submission_id" UUID NOT NULL,
    "status" "OcrExtractionStatus" NOT NULL DEFAULT 'QUEUED',
    "engine" TEXT,
    "engine_version" TEXT,
    "result_json" JSONB,
    "error" TEXT,
    "queued_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "started_at" TIMESTAMPTZ(3),
    "completed_at" TIMESTAMPTZ(3),

    CONSTRAINT "ocr_extractions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "validation_results" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "submission_id" UUID NOT NULL,
    "run_id" UUID NOT NULL,
    "rules_version" INTEGER NOT NULL,
    "rule_key" TEXT NOT NULL,
    "rule_version" INTEGER NOT NULL,
    "outcome" "ValidationOutcome" NOT NULL,
    "field_keys" TEXT[],
    "message" TEXT NOT NULL,
    "details" JSONB NOT NULL DEFAULT '{}',
    "reference" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "validation_results_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "verifications" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "submission_id" UUID NOT NULL,
    "round" INTEGER NOT NULL DEFAULT 1,
    "reviewer_id" UUID NOT NULL,
    "decision" "VerificationDecision" NOT NULL,
    "checklist" JSONB NOT NULL,
    "independent_values" JSONB NOT NULL DEFAULT '[]',
    "mismatched_field_keys" TEXT[],
    "field_comments" JSONB NOT NULL DEFAULT '[]',
    "notes" TEXT,
    "reviewed_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "supervisor_action" "SupervisorAction",
    "supervisor_id" UUID,
    "supervisor_reason" TEXT,
    "supervisor_action_at" TIMESTAMPTZ(3),

    CONSTRAINT "verifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "discrepancy_cases" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "reference" TEXT NOT NULL,
    "election_cycle_id" UUID NOT NULL,
    "contest_id" UUID,
    "variance_type" "DiscrepancyType" NOT NULL,
    "severity" "DiscrepancySeverity" NOT NULL DEFAULT 'MEDIUM',
    "status" "DiscrepancyStatus" NOT NULL DEFAULT 'OPEN',
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "details" JSONB NOT NULL DEFAULT '{}',
    "assigned_to_id" UUID,
    "opened_by_id" UUID NOT NULL,
    "resolution" TEXT,
    "resolved_by_id" UUID,
    "resolved_at" TIMESTAMPTZ(3),
    "closure_approver_id" UUID,
    "closed_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "discrepancy_cases_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "discrepancy_case_submissions" (
    "tenant_id" UUID NOT NULL,
    "case_id" UUID NOT NULL,
    "submission_id" UUID NOT NULL,
    "role" "DiscrepancyLinkRole" NOT NULL DEFAULT 'RELATED',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "discrepancy_case_submissions_pkey" PRIMARY KEY ("case_id","submission_id")
);

-- CreateTable
CREATE TABLE "discrepancy_case_actions" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "case_id" UUID NOT NULL,
    "actor_id" UUID NOT NULL,
    "action" TEXT NOT NULL,
    "note" TEXT,
    "data" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "discrepancy_case_actions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tally_snapshots" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "reference" TEXT NOT NULL,
    "election_cycle_id" UUID NOT NULL,
    "contest_id" UUID NOT NULL,
    "geography_scope_type" "ScopeType" NOT NULL DEFAULT 'ORGANISATION',
    "geographic_unit_id" UUID,
    "calculation_version" TEXT NOT NULL,
    "included_submission_ids" UUID[],
    "totals_json" JSONB NOT NULL,
    "coverage_json" JSONB NOT NULL,
    "expected_stations" INTEGER NOT NULL,
    "included_stations" INTEGER NOT NULL,
    "registry_version_id" UUID,
    "content_hash" TEXT NOT NULL,
    "note" TEXT,
    "created_by_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "released_at" TIMESTAMPTZ(3),
    "released_by_id" UUID,

    CONSTRAINT "tally_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tally_exports" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "snapshot_id" UUID NOT NULL,
    "format" "ExportFormat" NOT NULL,
    "file_id" UUID NOT NULL,
    "created_by_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tally_exports_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "incidents" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "reference" TEXT NOT NULL,
    "election_cycle_id" UUID,
    "category" TEXT NOT NULL,
    "occurred_at" TIMESTAMPTZ(3) NOT NULL,
    "geographic_unit_id" UUID,
    "polling_station_id" UUID,
    "reporter_id" UUID NOT NULL,
    "factual_description" TEXT NOT NULL,
    "evidence_file_ids" UUID[],
    "priority" "IncidentPriority" NOT NULL DEFAULT 'MEDIUM',
    "status" "IncidentStatus" NOT NULL DEFAULT 'NEW',
    "sensitivity" "SensitivityLevel" NOT NULL DEFAULT 'CONFIDENTIAL',
    "assignee_id" UUID,
    "closure_note" TEXT,
    "closed_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "incidents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notifications" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "channel" "NotificationChannel" NOT NULL DEFAULT 'IN_APP',
    "module" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "link" TEXT,
    "read_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "tenants_slug_key" ON "tenants"("slug");

-- CreateIndex
CREATE INDEX "users_tenant_id_status_idx" ON "users"("tenant_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "users_tenant_id_email_key" ON "users"("tenant_id", "email");

-- CreateIndex
CREATE UNIQUE INDEX "roles_tenant_id_key_key" ON "roles"("tenant_id", "key");

-- CreateIndex
CREATE INDEX "role_permissions_tenant_id_idx" ON "role_permissions"("tenant_id");

-- CreateIndex
CREATE INDEX "role_assignments_tenant_id_user_id_idx" ON "role_assignments"("tenant_id", "user_id");

-- CreateIndex
CREATE INDEX "role_assignments_tenant_id_role_id_idx" ON "role_assignments"("tenant_id", "role_id");

-- CreateIndex
CREATE INDEX "sessions_tenant_id_user_id_idx" ON "sessions"("tenant_id", "user_id");

-- CreateIndex
CREATE INDEX "mfa_factors_tenant_id_user_id_status_idx" ON "mfa_factors"("tenant_id", "user_id", "status");

-- CreateIndex
CREATE INDEX "audit_events_tenant_id_occurred_at_idx" ON "audit_events"("tenant_id", "occurred_at" DESC);

-- CreateIndex
CREATE INDEX "audit_events_tenant_id_entity_type_entity_id_idx" ON "audit_events"("tenant_id", "entity_type", "entity_id");

-- CreateIndex
CREATE INDEX "audit_events_tenant_id_actor_id_idx" ON "audit_events"("tenant_id", "actor_id");

-- CreateIndex
CREATE INDEX "audit_events_tenant_id_action_idx" ON "audit_events"("tenant_id", "action");

-- CreateIndex
CREATE UNIQUE INDEX "audit_events_seq_key" ON "audit_events"("seq");

-- CreateIndex
CREATE UNIQUE INDEX "election_cycles_tenant_id_name_key" ON "election_cycles"("tenant_id", "name");

-- CreateIndex
CREATE INDEX "registry_versions_tenant_id_election_cycle_id_status_idx" ON "registry_versions"("tenant_id", "election_cycle_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "registry_versions_tenant_id_election_cycle_id_version_key" ON "registry_versions"("tenant_id", "election_cycle_id", "version");

-- CreateIndex
CREATE INDEX "geographic_units_tenant_id_election_cycle_id_type_idx" ON "geographic_units"("tenant_id", "election_cycle_id", "type");

-- CreateIndex
CREATE INDEX "geographic_units_tenant_id_parent_id_idx" ON "geographic_units"("tenant_id", "parent_id");

-- CreateIndex
CREATE INDEX "geographic_units_tenant_id_path_idx" ON "geographic_units"("tenant_id", "path");

-- CreateIndex
CREATE UNIQUE INDEX "geographic_units_tenant_id_election_cycle_id_type_official__key" ON "geographic_units"("tenant_id", "election_cycle_id", "type", "official_code", "source_version");

-- CreateIndex
CREATE INDEX "polling_stations_tenant_id_election_cycle_id_county_id_idx" ON "polling_stations"("tenant_id", "election_cycle_id", "county_id");

-- CreateIndex
CREATE INDEX "polling_stations_tenant_id_election_cycle_id_constituency_i_idx" ON "polling_stations"("tenant_id", "election_cycle_id", "constituency_id");

-- CreateIndex
CREATE INDEX "polling_stations_tenant_id_election_cycle_id_ward_id_idx" ON "polling_stations"("tenant_id", "election_cycle_id", "ward_id");

-- CreateIndex
CREATE UNIQUE INDEX "polling_stations_tenant_id_registry_version_id_code_key" ON "polling_stations"("tenant_id", "registry_version_id", "code");

-- CreateIndex
CREATE UNIQUE INDEX "tally_centres_tenant_id_election_cycle_id_code_key" ON "tally_centres"("tenant_id", "election_cycle_id", "code");

-- CreateIndex
CREATE INDEX "contests_tenant_id_election_cycle_id_idx" ON "contests"("tenant_id", "election_cycle_id");

-- CreateIndex
CREATE UNIQUE INDEX "contests_tenant_id_election_cycle_id_office_type_geographic_key" ON "contests"("tenant_id", "election_cycle_id", "office_type", "geographic_unit_id");

-- CreateIndex
CREATE UNIQUE INDEX "candidate_references_tenant_id_contest_id_ballot_order_key" ON "candidate_references"("tenant_id", "contest_id", "ballot_order");

-- CreateIndex
CREATE INDEX "form_templates_tenant_id_election_cycle_id_contest_type_app_idx" ON "form_templates"("tenant_id", "election_cycle_id", "contest_type", "approval_state");

-- CreateIndex
CREATE UNIQUE INDEX "form_templates_tenant_id_election_cycle_id_form_number_vers_key" ON "form_templates"("tenant_id", "election_cycle_id", "form_number", "version");

-- CreateIndex
CREATE UNIQUE INDEX "stored_files_tenant_id_sha256_key" ON "stored_files"("tenant_id", "sha256");

-- CreateIndex
CREATE INDEX "result_submissions_tenant_id_election_cycle_id_contest_id_s_idx" ON "result_submissions"("tenant_id", "election_cycle_id", "contest_id", "status");

-- CreateIndex
CREATE INDEX "result_submissions_tenant_id_polling_station_id_idx" ON "result_submissions"("tenant_id", "polling_station_id");

-- CreateIndex
CREATE INDEX "result_submissions_tenant_id_submitter_id_idx" ON "result_submissions"("tenant_id", "submitter_id");

-- CreateIndex
CREATE INDEX "result_submissions_tenant_id_source_file_id_idx" ON "result_submissions"("tenant_id", "source_file_id");

-- CreateIndex
CREATE INDEX "result_submissions_tenant_id_status_updated_at_idx" ON "result_submissions"("tenant_id", "status", "updated_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "result_submissions_tenant_id_reference_key" ON "result_submissions"("tenant_id", "reference");

-- CreateIndex
CREATE UNIQUE INDEX "result_submissions_tenant_id_idempotency_key_key" ON "result_submissions"("tenant_id", "idempotency_key");

-- CreateIndex
CREATE INDEX "result_values_tenant_id_submission_id_idx" ON "result_values"("tenant_id", "submission_id");

-- CreateIndex
CREATE INDEX "result_value_changes_tenant_id_submission_id_idx" ON "result_value_changes"("tenant_id", "submission_id");

-- CreateIndex
CREATE UNIQUE INDEX "result_value_changes_result_value_id_change_version_key" ON "result_value_changes"("result_value_id", "change_version");

-- CreateIndex
CREATE INDEX "ocr_extractions_tenant_id_submission_id_idx" ON "ocr_extractions"("tenant_id", "submission_id");

-- CreateIndex
CREATE INDEX "validation_results_tenant_id_submission_id_run_id_idx" ON "validation_results"("tenant_id", "submission_id", "run_id");

-- CreateIndex
CREATE INDEX "verifications_tenant_id_submission_id_idx" ON "verifications"("tenant_id", "submission_id");

-- CreateIndex
CREATE INDEX "verifications_tenant_id_reviewer_id_idx" ON "verifications"("tenant_id", "reviewer_id");

-- CreateIndex
CREATE UNIQUE INDEX "verifications_submission_id_round_reviewer_id_key" ON "verifications"("submission_id", "round", "reviewer_id");

-- CreateIndex
CREATE INDEX "discrepancy_cases_tenant_id_status_variance_type_idx" ON "discrepancy_cases"("tenant_id", "status", "variance_type");

-- CreateIndex
CREATE INDEX "discrepancy_cases_tenant_id_assigned_to_id_idx" ON "discrepancy_cases"("tenant_id", "assigned_to_id");

-- CreateIndex
CREATE UNIQUE INDEX "discrepancy_cases_tenant_id_reference_key" ON "discrepancy_cases"("tenant_id", "reference");

-- CreateIndex
CREATE INDEX "discrepancy_case_submissions_tenant_id_submission_id_idx" ON "discrepancy_case_submissions"("tenant_id", "submission_id");

-- CreateIndex
CREATE INDEX "discrepancy_case_actions_tenant_id_case_id_idx" ON "discrepancy_case_actions"("tenant_id", "case_id");

-- CreateIndex
CREATE INDEX "tally_snapshots_tenant_id_contest_id_created_at_idx" ON "tally_snapshots"("tenant_id", "contest_id", "created_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "tally_snapshots_tenant_id_reference_key" ON "tally_snapshots"("tenant_id", "reference");

-- CreateIndex
CREATE INDEX "tally_exports_tenant_id_snapshot_id_idx" ON "tally_exports"("tenant_id", "snapshot_id");

-- CreateIndex
CREATE INDEX "incidents_tenant_id_status_priority_idx" ON "incidents"("tenant_id", "status", "priority");

-- CreateIndex
CREATE UNIQUE INDEX "incidents_tenant_id_reference_key" ON "incidents"("tenant_id", "reference");

-- CreateIndex
CREATE INDEX "notifications_tenant_id_user_id_read_at_idx" ON "notifications"("tenant_id", "user_id", "read_at");

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "roles" ADD CONSTRAINT "roles_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "role_permissions" ADD CONSTRAINT "role_permissions_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "role_permissions" ADD CONSTRAINT "role_permissions_role_id_fkey" FOREIGN KEY ("role_id") REFERENCES "roles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "role_permissions" ADD CONSTRAINT "role_permissions_permission_key_fkey" FOREIGN KEY ("permission_key") REFERENCES "permissions"("key") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "role_assignments" ADD CONSTRAINT "role_assignments_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "role_assignments" ADD CONSTRAINT "role_assignments_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "role_assignments" ADD CONSTRAINT "role_assignments_role_id_fkey" FOREIGN KEY ("role_id") REFERENCES "roles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "role_assignments" ADD CONSTRAINT "role_assignments_geographic_unit_id_fkey" FOREIGN KEY ("geographic_unit_id") REFERENCES "geographic_units"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "role_assignments" ADD CONSTRAINT "role_assignments_polling_station_id_fkey" FOREIGN KEY ("polling_station_id") REFERENCES "polling_stations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "role_assignments" ADD CONSTRAINT "role_assignments_election_cycle_id_fkey" FOREIGN KEY ("election_cycle_id") REFERENCES "election_cycles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "role_assignments" ADD CONSTRAINT "role_assignments_granted_by_id_fkey" FOREIGN KEY ("granted_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "role_assignments" ADD CONSTRAINT "role_assignments_revoked_by_id_fkey" FOREIGN KEY ("revoked_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mfa_factors" ADD CONSTRAINT "mfa_factors_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mfa_factors" ADD CONSTRAINT "mfa_factors_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reference_sequences" ADD CONSTRAINT "reference_sequences_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "election_cycles" ADD CONSTRAINT "election_cycles_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "registry_versions" ADD CONSTRAINT "registry_versions_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "registry_versions" ADD CONSTRAINT "registry_versions_election_cycle_id_fkey" FOREIGN KEY ("election_cycle_id") REFERENCES "election_cycles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "registry_versions" ADD CONSTRAINT "registry_versions_source_file_id_fkey" FOREIGN KEY ("source_file_id") REFERENCES "stored_files"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "registry_versions" ADD CONSTRAINT "registry_versions_approved_by_id_fkey" FOREIGN KEY ("approved_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "geographic_units" ADD CONSTRAINT "geographic_units_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "geographic_units" ADD CONSTRAINT "geographic_units_election_cycle_id_fkey" FOREIGN KEY ("election_cycle_id") REFERENCES "election_cycles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "geographic_units" ADD CONSTRAINT "geographic_units_registry_version_id_fkey" FOREIGN KEY ("registry_version_id") REFERENCES "registry_versions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "geographic_units" ADD CONSTRAINT "geographic_units_parent_id_fkey" FOREIGN KEY ("parent_id") REFERENCES "geographic_units"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "polling_stations" ADD CONSTRAINT "polling_stations_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "polling_stations" ADD CONSTRAINT "polling_stations_election_cycle_id_fkey" FOREIGN KEY ("election_cycle_id") REFERENCES "election_cycles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "polling_stations" ADD CONSTRAINT "polling_stations_registry_version_id_fkey" FOREIGN KEY ("registry_version_id") REFERENCES "registry_versions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "polling_stations" ADD CONSTRAINT "polling_stations_geographic_unit_id_fkey" FOREIGN KEY ("geographic_unit_id") REFERENCES "geographic_units"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "polling_stations" ADD CONSTRAINT "polling_stations_county_id_fkey" FOREIGN KEY ("county_id") REFERENCES "geographic_units"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "polling_stations" ADD CONSTRAINT "polling_stations_constituency_id_fkey" FOREIGN KEY ("constituency_id") REFERENCES "geographic_units"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "polling_stations" ADD CONSTRAINT "polling_stations_ward_id_fkey" FOREIGN KEY ("ward_id") REFERENCES "geographic_units"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "polling_stations" ADD CONSTRAINT "polling_stations_polling_centre_id_fkey" FOREIGN KEY ("polling_centre_id") REFERENCES "geographic_units"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tally_centres" ADD CONSTRAINT "tally_centres_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tally_centres" ADD CONSTRAINT "tally_centres_election_cycle_id_fkey" FOREIGN KEY ("election_cycle_id") REFERENCES "election_cycles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tally_centres" ADD CONSTRAINT "tally_centres_geographic_unit_id_fkey" FOREIGN KEY ("geographic_unit_id") REFERENCES "geographic_units"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contests" ADD CONSTRAINT "contests_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contests" ADD CONSTRAINT "contests_election_cycle_id_fkey" FOREIGN KEY ("election_cycle_id") REFERENCES "election_cycles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contests" ADD CONSTRAINT "contests_geographic_unit_id_fkey" FOREIGN KEY ("geographic_unit_id") REFERENCES "geographic_units"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "candidate_references" ADD CONSTRAINT "candidate_references_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "candidate_references" ADD CONSTRAINT "candidate_references_contest_id_fkey" FOREIGN KEY ("contest_id") REFERENCES "contests"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "form_templates" ADD CONSTRAINT "form_templates_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "form_templates" ADD CONSTRAINT "form_templates_election_cycle_id_fkey" FOREIGN KEY ("election_cycle_id") REFERENCES "election_cycles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "form_templates" ADD CONSTRAINT "form_templates_approved_by_id_fkey" FOREIGN KEY ("approved_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "form_templates" ADD CONSTRAINT "form_templates_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stored_files" ADD CONSTRAINT "stored_files_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stored_files" ADD CONSTRAINT "stored_files_uploaded_by_id_fkey" FOREIGN KEY ("uploaded_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "result_submissions" ADD CONSTRAINT "result_submissions_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "result_submissions" ADD CONSTRAINT "result_submissions_election_cycle_id_fkey" FOREIGN KEY ("election_cycle_id") REFERENCES "election_cycles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "result_submissions" ADD CONSTRAINT "result_submissions_contest_id_fkey" FOREIGN KEY ("contest_id") REFERENCES "contests"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "result_submissions" ADD CONSTRAINT "result_submissions_form_template_id_fkey" FOREIGN KEY ("form_template_id") REFERENCES "form_templates"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "result_submissions" ADD CONSTRAINT "result_submissions_polling_station_id_fkey" FOREIGN KEY ("polling_station_id") REFERENCES "polling_stations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "result_submissions" ADD CONSTRAINT "result_submissions_tally_centre_id_fkey" FOREIGN KEY ("tally_centre_id") REFERENCES "tally_centres"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "result_submissions" ADD CONSTRAINT "result_submissions_geographic_unit_id_fkey" FOREIGN KEY ("geographic_unit_id") REFERENCES "geographic_units"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "result_submissions" ADD CONSTRAINT "result_submissions_registry_version_id_fkey" FOREIGN KEY ("registry_version_id") REFERENCES "registry_versions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "result_submissions" ADD CONSTRAINT "result_submissions_submitter_id_fkey" FOREIGN KEY ("submitter_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "result_submissions" ADD CONSTRAINT "result_submissions_source_file_id_fkey" FOREIGN KEY ("source_file_id") REFERENCES "stored_files"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "result_submissions" ADD CONSTRAINT "result_submissions_duplicate_of_id_fkey" FOREIGN KEY ("duplicate_of_id") REFERENCES "result_submissions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "result_values" ADD CONSTRAINT "result_values_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "result_values" ADD CONSTRAINT "result_values_submission_id_fkey" FOREIGN KEY ("submission_id") REFERENCES "result_submissions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "result_values" ADD CONSTRAINT "result_values_candidate_reference_id_fkey" FOREIGN KEY ("candidate_reference_id") REFERENCES "candidate_references"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "result_values" ADD CONSTRAINT "result_values_confirmed_by_id_fkey" FOREIGN KEY ("confirmed_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "result_value_changes" ADD CONSTRAINT "result_value_changes_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "result_value_changes" ADD CONSTRAINT "result_value_changes_result_value_id_fkey" FOREIGN KEY ("result_value_id") REFERENCES "result_values"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "result_value_changes" ADD CONSTRAINT "result_value_changes_submission_id_fkey" FOREIGN KEY ("submission_id") REFERENCES "result_submissions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "result_value_changes" ADD CONSTRAINT "result_value_changes_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ocr_extractions" ADD CONSTRAINT "ocr_extractions_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ocr_extractions" ADD CONSTRAINT "ocr_extractions_submission_id_fkey" FOREIGN KEY ("submission_id") REFERENCES "result_submissions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "validation_results" ADD CONSTRAINT "validation_results_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "validation_results" ADD CONSTRAINT "validation_results_submission_id_fkey" FOREIGN KEY ("submission_id") REFERENCES "result_submissions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "verifications" ADD CONSTRAINT "verifications_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "verifications" ADD CONSTRAINT "verifications_submission_id_fkey" FOREIGN KEY ("submission_id") REFERENCES "result_submissions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "verifications" ADD CONSTRAINT "verifications_reviewer_id_fkey" FOREIGN KEY ("reviewer_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "verifications" ADD CONSTRAINT "verifications_supervisor_id_fkey" FOREIGN KEY ("supervisor_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "discrepancy_cases" ADD CONSTRAINT "discrepancy_cases_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "discrepancy_cases" ADD CONSTRAINT "discrepancy_cases_election_cycle_id_fkey" FOREIGN KEY ("election_cycle_id") REFERENCES "election_cycles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "discrepancy_cases" ADD CONSTRAINT "discrepancy_cases_contest_id_fkey" FOREIGN KEY ("contest_id") REFERENCES "contests"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "discrepancy_cases" ADD CONSTRAINT "discrepancy_cases_assigned_to_id_fkey" FOREIGN KEY ("assigned_to_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "discrepancy_cases" ADD CONSTRAINT "discrepancy_cases_opened_by_id_fkey" FOREIGN KEY ("opened_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "discrepancy_cases" ADD CONSTRAINT "discrepancy_cases_resolved_by_id_fkey" FOREIGN KEY ("resolved_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "discrepancy_cases" ADD CONSTRAINT "discrepancy_cases_closure_approver_id_fkey" FOREIGN KEY ("closure_approver_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "discrepancy_case_submissions" ADD CONSTRAINT "discrepancy_case_submissions_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "discrepancy_case_submissions" ADD CONSTRAINT "discrepancy_case_submissions_case_id_fkey" FOREIGN KEY ("case_id") REFERENCES "discrepancy_cases"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "discrepancy_case_submissions" ADD CONSTRAINT "discrepancy_case_submissions_submission_id_fkey" FOREIGN KEY ("submission_id") REFERENCES "result_submissions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "discrepancy_case_actions" ADD CONSTRAINT "discrepancy_case_actions_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "discrepancy_case_actions" ADD CONSTRAINT "discrepancy_case_actions_case_id_fkey" FOREIGN KEY ("case_id") REFERENCES "discrepancy_cases"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "discrepancy_case_actions" ADD CONSTRAINT "discrepancy_case_actions_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tally_snapshots" ADD CONSTRAINT "tally_snapshots_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tally_snapshots" ADD CONSTRAINT "tally_snapshots_election_cycle_id_fkey" FOREIGN KEY ("election_cycle_id") REFERENCES "election_cycles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tally_snapshots" ADD CONSTRAINT "tally_snapshots_contest_id_fkey" FOREIGN KEY ("contest_id") REFERENCES "contests"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tally_snapshots" ADD CONSTRAINT "tally_snapshots_geographic_unit_id_fkey" FOREIGN KEY ("geographic_unit_id") REFERENCES "geographic_units"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tally_snapshots" ADD CONSTRAINT "tally_snapshots_registry_version_id_fkey" FOREIGN KEY ("registry_version_id") REFERENCES "registry_versions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tally_snapshots" ADD CONSTRAINT "tally_snapshots_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tally_snapshots" ADD CONSTRAINT "tally_snapshots_released_by_id_fkey" FOREIGN KEY ("released_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tally_exports" ADD CONSTRAINT "tally_exports_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tally_exports" ADD CONSTRAINT "tally_exports_snapshot_id_fkey" FOREIGN KEY ("snapshot_id") REFERENCES "tally_snapshots"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tally_exports" ADD CONSTRAINT "tally_exports_file_id_fkey" FOREIGN KEY ("file_id") REFERENCES "stored_files"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tally_exports" ADD CONSTRAINT "tally_exports_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "incidents" ADD CONSTRAINT "incidents_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "incidents" ADD CONSTRAINT "incidents_election_cycle_id_fkey" FOREIGN KEY ("election_cycle_id") REFERENCES "election_cycles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "incidents" ADD CONSTRAINT "incidents_geographic_unit_id_fkey" FOREIGN KEY ("geographic_unit_id") REFERENCES "geographic_units"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "incidents" ADD CONSTRAINT "incidents_polling_station_id_fkey" FOREIGN KEY ("polling_station_id") REFERENCES "polling_stations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "incidents" ADD CONSTRAINT "incidents_reporter_id_fkey" FOREIGN KEY ("reporter_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "incidents" ADD CONSTRAINT "incidents_assignee_id_fkey" FOREIGN KEY ("assignee_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

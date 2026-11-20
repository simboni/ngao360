-- Field and election operations (blueprint 6, 7, 13.4; module 'field').
--
-- Replaces the foundation's placeholder incidents table (never used by any
-- endpoint or seed) with the blueprint 7.3 incident model, and adds agents,
-- deployments, readiness, field reports, war-room station status and the
-- offline-sync ledger. See the end of this file for RLS, append-only and
-- immutability guards.

-- The placeholder table must be empty: incidents are never deleted.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM incidents) THEN
    RAISE EXCEPTION 'incidents is not empty; migrate its rows before replacing the table';
  END IF;
END
$$;
DROP TABLE "incidents";
DROP TYPE "IncidentStatus";
DROP TYPE "IncidentPriority";

-- CreateEnum
CREATE TYPE "IncidentStatus" AS ENUM ('REPORTED', 'TRIAGED', 'ASSIGNED', 'ESCALATED', 'RESOLVED', 'CLOSED');

-- CreateEnum
CREATE TYPE "AgentStatus" AS ENUM ('RECRUITED', 'ACTIVE', 'STANDBY', 'INACTIVE', 'WITHDRAWN');

-- CreateEnum
CREATE TYPE "AgentAvailability" AS ENUM ('AVAILABLE', 'LIMITED', 'UNAVAILABLE');

-- CreateEnum
CREATE TYPE "AgentGender" AS ENUM ('FEMALE', 'MALE', 'OTHER', 'PREFER_NOT_TO_SAY');

-- CreateEnum
CREATE TYPE "AccreditationStatus" AS ENUM ('NOT_SUBMITTED', 'SUBMITTED', 'PENDING', 'APPROVED', 'REJECTED', 'EXPIRED', 'NOT_APPLICABLE');

-- CreateEnum
CREATE TYPE "TrainingStatus" AS ENUM ('SCHEDULED', 'ATTENDED', 'COMPLETED', 'NOT_PASSED', 'ABSENT');

-- CreateEnum
CREATE TYPE "DeploymentRole" AS ENUM ('CHIEF_AGENT', 'STATION_AGENT', 'RELIEF_AGENT', 'RUNNER', 'SUPERVISOR');

-- CreateEnum
CREATE TYPE "DeploymentShift" AS ENUM ('FULL_DAY', 'OPENING', 'DAYTIME', 'CLOSING_AND_COUNTING');

-- CreateEnum
CREATE TYPE "DeploymentStatus" AS ENUM ('ASSIGNED', 'CONFIRMED', 'CHECKED_IN', 'CHECKED_OUT', 'REPLACED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "DeploymentEventType" AS ENUM ('CREATED', 'UPDATED', 'CONFIRMED', 'CHECKED_IN', 'CHECKED_OUT', 'REPLACED', 'CANCELLED', 'NOTE');

-- CreateEnum
CREATE TYPE "ReadinessCategory" AS ENUM ('ACCREDITATION', 'MATERIALS', 'TRANSPORT', 'COMMUNICATIONS', 'PAYMENT');

-- CreateEnum
CREATE TYPE "ReadinessItemStatus" AS ENUM ('NOT_STARTED', 'IN_PROGRESS', 'DONE', 'BLOCKED', 'NOT_APPLICABLE');

-- CreateEnum
CREATE TYPE "ReadinessStatus" AS ENUM ('NOT_STARTED', 'IN_PROGRESS', 'READY', 'BLOCKED');

-- CreateEnum
CREATE TYPE "FieldReportType" AS ENUM ('OPENING_OF_POLLS', 'POLLING_OBSERVATION', 'CLOSING_AND_COUNTING', 'GENERAL');

-- CreateEnum
CREATE TYPE "FieldReportTemplateStatus" AS ENUM ('DRAFT', 'ACTIVE', 'RETIRED');

-- CreateEnum
CREATE TYPE "FieldReportReviewStatus" AS ENUM ('SUBMITTED', 'ACCEPTED', 'RETURNED', 'ESCALATED', 'CLOSED');

-- CreateEnum
CREATE TYPE "IncidentCategory" AS ENUM ('OPENING_OR_CLOSING_TIME', 'MATERIALS', 'EQUIPMENT', 'AGENT_ACCESS', 'VOTER_IDENTIFICATION', 'PROCEDURE', 'COUNTING_AND_FORMS', 'SECURITY', 'VIOLENCE_OR_INTIMIDATION', 'ACCESSIBILITY', 'LOGISTICS', 'COMMUNICATIONS', 'HEALTH_AND_SAFETY', 'OTHER');

-- CreateEnum
CREATE TYPE "IncidentSeverity" AS ENUM ('LOW', 'MEDIUM', 'HIGH', 'CRITICAL');

-- CreateEnum
CREATE TYPE "IncidentOutcome" AS ENUM ('RESOLVED', 'UNRESOLVED', 'REFERRED', 'NO_ACTION_NEEDED', 'DUPLICATE');

-- CreateEnum
CREATE TYPE "IncidentEscalationTarget" AS ENUM ('WAR_ROOM_COMMAND', 'LEGAL_COMPLIANCE', 'SECURITY_LIAISON', 'COMPETENT_AUTHORITY', 'OTHER');

-- CreateEnum
CREATE TYPE "IncidentEventType" AS ENUM ('REPORTED', 'TRIAGED', 'ASSIGNED', 'ESCALATED', 'NOTE', 'CORRECTION', 'EVIDENCE_ADDED', 'EVIDENCE_HOLD_PLACED', 'EVIDENCE_HOLD_RELEASED', 'REFERRED', 'SUBJECT_RECORDED', 'RESOLVED', 'CLOSED', 'REOPENED');

-- CreateEnum
CREATE TYPE "StationStatusSource" AS ENUM ('DERIVED', 'MANUAL');

-- CreateEnum
CREATE TYPE "ClientSubmissionKind" AS ENUM ('FIELD_REPORT', 'INCIDENT', 'INCIDENT_NOTE', 'CHECK_IN', 'ASSIGNMENT_CONFIRMATION');

-- CreateEnum
CREATE TYPE "ClientSubmissionOutcome" AS ENUM ('ACCEPTED', 'REJECTED', 'CONFLICT');

-- AlterEnum

-- This migration adds more than one value to an enum.

-- With PostgreSQL versions 11 and earlier, this is not possible

-- in a single migration. This can be worked around by creating

-- multiple migrations, each migration adding only one value to

-- the enum.


ALTER TYPE "StoredFilePurpose" ADD VALUE 'FIELD_EVIDENCE';
ALTER TYPE "StoredFilePurpose" ADD VALUE 'AGENT_DOCUMENT';

-- CreateTable
CREATE TABLE "agents" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "reference" TEXT NOT NULL,
    "user_id" UUID,
    "given_name" TEXT NOT NULL,
    "family_name" TEXT NOT NULL,
    "other_names" TEXT,
    "gender" "AgentGender",
    "home_ward_id" UUID NOT NULL,
    "home_constituency_id" UUID NOT NULL,
    "home_county_id" UUID NOT NULL,
    "languages" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "status" "AgentStatus" NOT NULL DEFAULT 'RECRUITED',
    "availability" "AgentAvailability" NOT NULL DEFAULT 'AVAILABLE',
    "notes" TEXT,
    "phone_masked" TEXT,
    "national_id_masked" TEXT,
    "has_mpesa_number" BOOLEAN NOT NULL DEFAULT false,
    "has_next_of_kin" BOOLEAN NOT NULL DEFAULT false,
    "privacy_notice_version" TEXT,
    "privacy_notice_ack_at" TIMESTAMPTZ(3),
    "created_by_id" UUID NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "agents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agent_sensitive" (
    "agent_id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "national_id_number" TEXT,
    "phone" TEXT,
    "mpesa_number" TEXT,
    "next_of_kin_name" TEXT,
    "next_of_kin_phone" TEXT,
    "next_of_kin_relationship" TEXT,
    "updated_by_id" UUID NOT NULL,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "agent_sensitive_pkey" PRIMARY KEY ("agent_id")
);

-- CreateTable
CREATE TABLE "agent_accreditations" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "agent_id" UUID NOT NULL,
    "election_cycle_id" UUID NOT NULL,
    "status" "AccreditationStatus" NOT NULL DEFAULT 'NOT_SUBMITTED',
    "accreditation_reference" TEXT,
    "evidence_file_id" UUID,
    "submitted_at" TIMESTAMPTZ(3),
    "decided_at" TIMESTAMPTZ(3),
    "expires_on" DATE,
    "notes" TEXT,
    "updated_by_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "agent_accreditations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agent_trainings" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "agent_id" UUID NOT NULL,
    "election_cycle_id" UUID,
    "title" TEXT NOT NULL,
    "status" "TrainingStatus" NOT NULL DEFAULT 'SCHEDULED',
    "scheduled_on" DATE,
    "materials_issued" BOOLEAN NOT NULL DEFAULT false,
    "attended_at" TIMESTAMPTZ(3),
    "assessment_score" INTEGER,
    "completed_at" TIMESTAMPTZ(3),
    "refresher_due_on" DATE,
    "notes" TEXT,
    "recorded_by_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "agent_trainings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agent_status_events" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "agent_id" UUID NOT NULL,
    "from_status" "AgentStatus",
    "to_status" "AgentStatus" NOT NULL,
    "reason" TEXT,
    "actor_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "agent_status_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "deployments" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "election_cycle_id" UUID NOT NULL,
    "agent_id" UUID NOT NULL,
    "polling_station_code" TEXT NOT NULL,
    "county_id" UUID NOT NULL,
    "constituency_id" UUID NOT NULL,
    "ward_id" UUID NOT NULL,
    "polling_centre_id" UUID,
    "role" "DeploymentRole" NOT NULL,
    "shift" "DeploymentShift" NOT NULL DEFAULT 'FULL_DAY',
    "status" "DeploymentStatus" NOT NULL DEFAULT 'ASSIGNED',
    "supervisor_agent_id" UUID,
    "instructions" TEXT,
    "confirmed_at" TIMESTAMPTZ(3),
    "checked_in_at" TIMESTAMPTZ(3),
    "check_in_latitude" DECIMAL(9,6),
    "check_in_longitude" DECIMAL(9,6),
    "check_in_accuracy_metres" INTEGER,
    "checked_out_at" TIMESTAMPTZ(3),
    "replaces_deployment_id" UUID,
    "cancelled_reason" TEXT,
    "created_by_id" UUID NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "deployments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "deployment_events" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "deployment_id" UUID NOT NULL,
    "type" "DeploymentEventType" NOT NULL,
    "from_status" "DeploymentStatus",
    "to_status" "DeploymentStatus",
    "note" TEXT,
    "has_location" BOOLEAN NOT NULL DEFAULT false,
    "submitted_offline" BOOLEAN NOT NULL DEFAULT false,
    "client_created_at" TIMESTAMPTZ(3),
    "actor_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "deployment_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "readiness_checklists" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "election_cycle_id" UUID NOT NULL,
    "polling_station_code" TEXT NOT NULL,
    "county_id" UUID NOT NULL,
    "constituency_id" UUID NOT NULL,
    "ward_id" UUID NOT NULL,
    "polling_centre_id" UUID,
    "status" "ReadinessStatus" NOT NULL DEFAULT 'NOT_STARTED',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "readiness_checklists_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "readiness_items" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "checklist_id" UUID NOT NULL,
    "category" "ReadinessCategory" NOT NULL,
    "status" "ReadinessItemStatus" NOT NULL DEFAULT 'NOT_STARTED',
    "note" TEXT,
    "due_at" TIMESTAMPTZ(3),
    "updated_by_id" UUID,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "readiness_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "field_report_templates" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "report_type" "FieldReportType" NOT NULL,
    "status" "FieldReportTemplateStatus" NOT NULL DEFAULT 'DRAFT',
    "schema" JSONB NOT NULL,
    "election_cycle_id" UUID,
    "created_by_id" UUID NOT NULL,
    "activated_by_id" UUID,
    "activated_at" TIMESTAMPTZ(3),
    "retired_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "field_report_templates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "field_reports" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "reference" TEXT NOT NULL,
    "template_id" UUID NOT NULL,
    "template_version" INTEGER NOT NULL,
    "report_type" "FieldReportType" NOT NULL,
    "election_cycle_id" UUID NOT NULL,
    "polling_station_code" TEXT,
    "geographic_unit_id" UUID NOT NULL,
    "county_id" UUID,
    "constituency_id" UUID,
    "ward_id" UUID,
    "polling_centre_id" UUID,
    "event_at" TIMESTAMPTZ(3) NOT NULL,
    "received_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "answers" JSONB NOT NULL,
    "notes" TEXT,
    "latitude" DECIMAL(9,6),
    "longitude" DECIMAL(9,6),
    "author_id" UUID NOT NULL,
    "submitted_offline" BOOLEAN NOT NULL DEFAULT false,
    "client_idempotency_key" UUID NOT NULL,
    "device_id" TEXT,
    "client_created_at" TIMESTAMPTZ(3),
    "supersedes_report_id" UUID,
    "review_status" "FieldReportReviewStatus" NOT NULL DEFAULT 'SUBMITTED',
    "reviewer_id" UUID,
    "review_note" TEXT,
    "reviewed_at" TIMESTAMPTZ(3),
    "version" INTEGER NOT NULL DEFAULT 1,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "field_reports_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "field_report_evidence" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "report_id" UUID NOT NULL,
    "stored_file_id" UUID NOT NULL,
    "added_by_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "field_report_evidence_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "incident_events" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "incident_id" UUID NOT NULL,
    "type" "IncidentEventType" NOT NULL,
    "from_status" "IncidentStatus",
    "to_status" "IncidentStatus",
    "note" TEXT,
    "data" JSONB NOT NULL DEFAULT '{}',
    "file_ids" UUID[] DEFAULT ARRAY[]::UUID[],
    "actor_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "incident_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "incident_evidence" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "incident_id" UUID NOT NULL,
    "stored_file_id" UUID NOT NULL,
    "original" BOOLEAN NOT NULL DEFAULT false,
    "added_by_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "incident_evidence_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "incident_subjects" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "incident_id" UUID NOT NULL,
    "description" TEXT NOT NULL,
    "recorded_by_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "incident_subjects_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "station_statuses" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "election_cycle_id" UUID NOT NULL,
    "polling_station_code" TEXT NOT NULL,
    "county_id" UUID NOT NULL,
    "constituency_id" UUID NOT NULL,
    "ward_id" UUID NOT NULL,
    "polling_centre_id" UUID,
    "status" "OperationalStatus" NOT NULL DEFAULT 'NOT_ASSIGNED',
    "source" "StationStatusSource" NOT NULL DEFAULT 'DERIVED',
    "derived_status" "OperationalStatus" NOT NULL DEFAULT 'NOT_ASSIGNED',
    "manual_status" "OperationalStatus",
    "manual_note" TEXT,
    "manual_set_by_id" UUID,
    "components" JSONB NOT NULL DEFAULT '{}',
    "computed_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "station_statuses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "station_status_events" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "station_status_id" UUID NOT NULL,
    "from_status" "OperationalStatus",
    "to_status" "OperationalStatus" NOT NULL,
    "source" "StationStatusSource" NOT NULL,
    "reason" TEXT,
    "actor_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "station_status_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "client_submissions" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "device_id" TEXT NOT NULL,
    "idempotency_key" UUID NOT NULL,
    "kind" "ClientSubmissionKind" NOT NULL,
    "payload_hash" TEXT NOT NULL,
    "outcome" "ClientSubmissionOutcome" NOT NULL,
    "result_type" TEXT,
    "result_id" UUID,
    "result_reference" TEXT,
    "error_code" TEXT,
    "client_created_at" TIMESTAMPTZ(3),
    "attempts" INTEGER NOT NULL DEFAULT 1,
    "first_seen_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_seen_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "client_submissions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "incidents" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "reference" TEXT NOT NULL,
    "election_cycle_id" UUID NOT NULL,
    "reported_category" "IncidentCategory" NOT NULL,
    "category" "IncidentCategory" NOT NULL,
    "initial_severity" "IncidentSeverity" NOT NULL,
    "severity" "IncidentSeverity" NOT NULL,
    "status" "IncidentStatus" NOT NULL DEFAULT 'REPORTED',
    "outcome" "IncidentOutcome",
    "occurred_at" TIMESTAMPTZ(3) NOT NULL,
    "reported_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "polling_station_code" TEXT,
    "geographic_unit_id" UUID NOT NULL,
    "county_id" UUID,
    "constituency_id" UUID,
    "ward_id" UUID,
    "polling_centre_id" UUID,
    "location_description" TEXT,
    "latitude" DECIMAL(9,6),
    "longitude" DECIMAL(9,6),
    "description" TEXT NOT NULL,
    "sensitivity" "SensitivityLevel" NOT NULL DEFAULT 'INTERNAL',
    "reporter_id" UUID NOT NULL,
    "assignee_id" UUID,
    "escalated_to" "IncidentEscalationTarget",
    "evidence_hold" BOOLEAN NOT NULL DEFAULT false,
    "duplicate_of_id" UUID,
    "resolution_note" TEXT,
    "resolved_by_id" UUID,
    "resolved_at" TIMESTAMPTZ(3),
    "closure_note" TEXT,
    "closed_by_id" UUID,
    "closed_at" TIMESTAMPTZ(3),
    "submitted_offline" BOOLEAN NOT NULL DEFAULT false,
    "client_idempotency_key" UUID NOT NULL,
    "device_id" TEXT,
    "client_created_at" TIMESTAMPTZ(3),
    "version" INTEGER NOT NULL DEFAULT 1,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "incidents_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "agents_user_id_key" ON "agents"("user_id");

-- CreateIndex
CREATE INDEX "agents_tenant_id_status_idx" ON "agents"("tenant_id", "status");

-- CreateIndex
CREATE INDEX "agents_tenant_id_home_ward_id_idx" ON "agents"("tenant_id", "home_ward_id");

-- CreateIndex
CREATE INDEX "agents_tenant_id_home_constituency_id_idx" ON "agents"("tenant_id", "home_constituency_id");

-- CreateIndex
CREATE INDEX "agents_tenant_id_home_county_id_idx" ON "agents"("tenant_id", "home_county_id");

-- CreateIndex
CREATE UNIQUE INDEX "agents_tenant_id_reference_key" ON "agents"("tenant_id", "reference");

-- CreateIndex
CREATE INDEX "agent_sensitive_tenant_id_idx" ON "agent_sensitive"("tenant_id");

-- CreateIndex
CREATE INDEX "agent_accreditations_tenant_id_election_cycle_id_status_idx" ON "agent_accreditations"("tenant_id", "election_cycle_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "agent_accreditations_tenant_id_agent_id_election_cycle_id_key" ON "agent_accreditations"("tenant_id", "agent_id", "election_cycle_id");

-- CreateIndex
CREATE INDEX "agent_trainings_tenant_id_agent_id_idx" ON "agent_trainings"("tenant_id", "agent_id");

-- CreateIndex
CREATE INDEX "agent_trainings_tenant_id_election_cycle_id_status_idx" ON "agent_trainings"("tenant_id", "election_cycle_id", "status");

-- CreateIndex
CREATE INDEX "agent_status_events_tenant_id_agent_id_created_at_idx" ON "agent_status_events"("tenant_id", "agent_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "deployments_replaces_deployment_id_key" ON "deployments"("replaces_deployment_id");

-- CreateIndex
CREATE INDEX "deployments_tenant_id_election_cycle_id_polling_station_cod_idx" ON "deployments"("tenant_id", "election_cycle_id", "polling_station_code");

-- CreateIndex
CREATE INDEX "deployments_tenant_id_election_cycle_id_agent_id_idx" ON "deployments"("tenant_id", "election_cycle_id", "agent_id");

-- CreateIndex
CREATE INDEX "deployments_tenant_id_election_cycle_id_status_idx" ON "deployments"("tenant_id", "election_cycle_id", "status");

-- CreateIndex
CREATE INDEX "deployments_tenant_id_election_cycle_id_ward_id_idx" ON "deployments"("tenant_id", "election_cycle_id", "ward_id");

-- CreateIndex
CREATE INDEX "deployments_tenant_id_election_cycle_id_constituency_id_idx" ON "deployments"("tenant_id", "election_cycle_id", "constituency_id");

-- CreateIndex
CREATE INDEX "deployment_events_tenant_id_deployment_id_created_at_idx" ON "deployment_events"("tenant_id", "deployment_id", "created_at");

-- CreateIndex
CREATE INDEX "readiness_checklists_tenant_id_election_cycle_id_status_idx" ON "readiness_checklists"("tenant_id", "election_cycle_id", "status");

-- CreateIndex
CREATE INDEX "readiness_checklists_tenant_id_election_cycle_id_ward_id_idx" ON "readiness_checklists"("tenant_id", "election_cycle_id", "ward_id");

-- CreateIndex
CREATE UNIQUE INDEX "readiness_checklists_tenant_id_election_cycle_id_polling_st_key" ON "readiness_checklists"("tenant_id", "election_cycle_id", "polling_station_code");

-- CreateIndex
CREATE INDEX "readiness_items_tenant_id_category_status_idx" ON "readiness_items"("tenant_id", "category", "status");

-- CreateIndex
CREATE UNIQUE INDEX "readiness_items_tenant_id_checklist_id_category_key" ON "readiness_items"("tenant_id", "checklist_id", "category");

-- CreateIndex
CREATE INDEX "field_report_templates_tenant_id_status_idx" ON "field_report_templates"("tenant_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "field_report_templates_tenant_id_key_version_key" ON "field_report_templates"("tenant_id", "key", "version");

-- CreateIndex
CREATE INDEX "field_reports_tenant_id_election_cycle_id_polling_station_c_idx" ON "field_reports"("tenant_id", "election_cycle_id", "polling_station_code");

-- CreateIndex
CREATE INDEX "field_reports_tenant_id_election_cycle_id_review_status_idx" ON "field_reports"("tenant_id", "election_cycle_id", "review_status");

-- CreateIndex
CREATE INDEX "field_reports_tenant_id_election_cycle_id_ward_id_idx" ON "field_reports"("tenant_id", "election_cycle_id", "ward_id");

-- CreateIndex
CREATE UNIQUE INDEX "field_reports_tenant_id_reference_key" ON "field_reports"("tenant_id", "reference");

-- CreateIndex
CREATE UNIQUE INDEX "field_reports_tenant_id_author_id_client_idempotency_key_key" ON "field_reports"("tenant_id", "author_id", "client_idempotency_key");

-- CreateIndex
CREATE UNIQUE INDEX "field_report_evidence_tenant_id_report_id_stored_file_id_key" ON "field_report_evidence"("tenant_id", "report_id", "stored_file_id");

-- CreateIndex
CREATE INDEX "incident_events_tenant_id_incident_id_created_at_idx" ON "incident_events"("tenant_id", "incident_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "incident_evidence_tenant_id_incident_id_stored_file_id_key" ON "incident_evidence"("tenant_id", "incident_id", "stored_file_id");

-- CreateIndex
CREATE INDEX "incident_subjects_tenant_id_incident_id_idx" ON "incident_subjects"("tenant_id", "incident_id");

-- CreateIndex
CREATE INDEX "station_statuses_tenant_id_election_cycle_id_status_idx" ON "station_statuses"("tenant_id", "election_cycle_id", "status");

-- CreateIndex
CREATE INDEX "station_statuses_tenant_id_election_cycle_id_ward_id_idx" ON "station_statuses"("tenant_id", "election_cycle_id", "ward_id");

-- CreateIndex
CREATE UNIQUE INDEX "station_statuses_tenant_id_election_cycle_id_polling_statio_key" ON "station_statuses"("tenant_id", "election_cycle_id", "polling_station_code");

-- CreateIndex
CREATE INDEX "station_status_events_tenant_id_station_status_id_created_a_idx" ON "station_status_events"("tenant_id", "station_status_id", "created_at");

-- CreateIndex
CREATE INDEX "client_submissions_tenant_id_user_id_device_id_last_seen_at_idx" ON "client_submissions"("tenant_id", "user_id", "device_id", "last_seen_at");

-- CreateIndex
CREATE INDEX "client_submissions_tenant_id_outcome_last_seen_at_idx" ON "client_submissions"("tenant_id", "outcome", "last_seen_at");

-- CreateIndex
CREATE UNIQUE INDEX "client_submissions_tenant_id_user_id_idempotency_key_key" ON "client_submissions"("tenant_id", "user_id", "idempotency_key");

-- CreateIndex
CREATE INDEX "incidents_tenant_id_election_cycle_id_status_severity_idx" ON "incidents"("tenant_id", "election_cycle_id", "status", "severity");

-- CreateIndex
CREATE INDEX "incidents_tenant_id_election_cycle_id_polling_station_code_idx" ON "incidents"("tenant_id", "election_cycle_id", "polling_station_code");

-- CreateIndex
CREATE INDEX "incidents_tenant_id_election_cycle_id_ward_id_idx" ON "incidents"("tenant_id", "election_cycle_id", "ward_id");

-- CreateIndex
CREATE INDEX "incidents_tenant_id_assignee_id_status_idx" ON "incidents"("tenant_id", "assignee_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "incidents_tenant_id_reporter_id_client_idempotency_key_key" ON "incidents"("tenant_id", "reporter_id", "client_idempotency_key");

-- AddForeignKey
ALTER TABLE "agents" ADD CONSTRAINT "agents_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agents" ADD CONSTRAINT "agents_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agents" ADD CONSTRAINT "agents_home_ward_id_fkey" FOREIGN KEY ("home_ward_id") REFERENCES "geographic_units"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agents" ADD CONSTRAINT "agents_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_sensitive" ADD CONSTRAINT "agent_sensitive_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_sensitive" ADD CONSTRAINT "agent_sensitive_agent_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "agents"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_sensitive" ADD CONSTRAINT "agent_sensitive_updated_by_id_fkey" FOREIGN KEY ("updated_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_accreditations" ADD CONSTRAINT "agent_accreditations_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_accreditations" ADD CONSTRAINT "agent_accreditations_agent_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "agents"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_accreditations" ADD CONSTRAINT "agent_accreditations_election_cycle_id_fkey" FOREIGN KEY ("election_cycle_id") REFERENCES "election_cycles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_accreditations" ADD CONSTRAINT "agent_accreditations_evidence_file_id_fkey" FOREIGN KEY ("evidence_file_id") REFERENCES "stored_files"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_accreditations" ADD CONSTRAINT "agent_accreditations_updated_by_id_fkey" FOREIGN KEY ("updated_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_trainings" ADD CONSTRAINT "agent_trainings_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_trainings" ADD CONSTRAINT "agent_trainings_agent_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "agents"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_trainings" ADD CONSTRAINT "agent_trainings_election_cycle_id_fkey" FOREIGN KEY ("election_cycle_id") REFERENCES "election_cycles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_trainings" ADD CONSTRAINT "agent_trainings_recorded_by_id_fkey" FOREIGN KEY ("recorded_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_status_events" ADD CONSTRAINT "agent_status_events_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_status_events" ADD CONSTRAINT "agent_status_events_agent_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "agents"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_status_events" ADD CONSTRAINT "agent_status_events_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deployments" ADD CONSTRAINT "deployments_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deployments" ADD CONSTRAINT "deployments_election_cycle_id_fkey" FOREIGN KEY ("election_cycle_id") REFERENCES "election_cycles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deployments" ADD CONSTRAINT "deployments_agent_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "agents"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deployments" ADD CONSTRAINT "deployments_supervisor_agent_id_fkey" FOREIGN KEY ("supervisor_agent_id") REFERENCES "agents"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deployments" ADD CONSTRAINT "deployments_replaces_deployment_id_fkey" FOREIGN KEY ("replaces_deployment_id") REFERENCES "deployments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deployments" ADD CONSTRAINT "deployments_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deployment_events" ADD CONSTRAINT "deployment_events_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deployment_events" ADD CONSTRAINT "deployment_events_deployment_id_fkey" FOREIGN KEY ("deployment_id") REFERENCES "deployments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deployment_events" ADD CONSTRAINT "deployment_events_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "readiness_checklists" ADD CONSTRAINT "readiness_checklists_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "readiness_checklists" ADD CONSTRAINT "readiness_checklists_election_cycle_id_fkey" FOREIGN KEY ("election_cycle_id") REFERENCES "election_cycles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "readiness_items" ADD CONSTRAINT "readiness_items_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "readiness_items" ADD CONSTRAINT "readiness_items_checklist_id_fkey" FOREIGN KEY ("checklist_id") REFERENCES "readiness_checklists"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "readiness_items" ADD CONSTRAINT "readiness_items_updated_by_id_fkey" FOREIGN KEY ("updated_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "field_report_templates" ADD CONSTRAINT "field_report_templates_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "field_report_templates" ADD CONSTRAINT "field_report_templates_election_cycle_id_fkey" FOREIGN KEY ("election_cycle_id") REFERENCES "election_cycles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "field_report_templates" ADD CONSTRAINT "field_report_templates_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "field_report_templates" ADD CONSTRAINT "field_report_templates_activated_by_id_fkey" FOREIGN KEY ("activated_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "field_reports" ADD CONSTRAINT "field_reports_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "field_reports" ADD CONSTRAINT "field_reports_template_id_fkey" FOREIGN KEY ("template_id") REFERENCES "field_report_templates"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "field_reports" ADD CONSTRAINT "field_reports_election_cycle_id_fkey" FOREIGN KEY ("election_cycle_id") REFERENCES "election_cycles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "field_reports" ADD CONSTRAINT "field_reports_geographic_unit_id_fkey" FOREIGN KEY ("geographic_unit_id") REFERENCES "geographic_units"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "field_reports" ADD CONSTRAINT "field_reports_author_id_fkey" FOREIGN KEY ("author_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "field_reports" ADD CONSTRAINT "field_reports_reviewer_id_fkey" FOREIGN KEY ("reviewer_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "field_reports" ADD CONSTRAINT "field_reports_supersedes_report_id_fkey" FOREIGN KEY ("supersedes_report_id") REFERENCES "field_reports"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "field_report_evidence" ADD CONSTRAINT "field_report_evidence_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "field_report_evidence" ADD CONSTRAINT "field_report_evidence_report_id_fkey" FOREIGN KEY ("report_id") REFERENCES "field_reports"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "field_report_evidence" ADD CONSTRAINT "field_report_evidence_stored_file_id_fkey" FOREIGN KEY ("stored_file_id") REFERENCES "stored_files"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "field_report_evidence" ADD CONSTRAINT "field_report_evidence_added_by_id_fkey" FOREIGN KEY ("added_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "incidents" ADD CONSTRAINT "incidents_resolved_by_id_fkey" FOREIGN KEY ("resolved_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "incidents" ADD CONSTRAINT "incidents_closed_by_id_fkey" FOREIGN KEY ("closed_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "incidents" ADD CONSTRAINT "incidents_duplicate_of_id_fkey" FOREIGN KEY ("duplicate_of_id") REFERENCES "incidents"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "incident_events" ADD CONSTRAINT "incident_events_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "incident_events" ADD CONSTRAINT "incident_events_incident_id_fkey" FOREIGN KEY ("incident_id") REFERENCES "incidents"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "incident_events" ADD CONSTRAINT "incident_events_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "incident_evidence" ADD CONSTRAINT "incident_evidence_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "incident_evidence" ADD CONSTRAINT "incident_evidence_incident_id_fkey" FOREIGN KEY ("incident_id") REFERENCES "incidents"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "incident_evidence" ADD CONSTRAINT "incident_evidence_stored_file_id_fkey" FOREIGN KEY ("stored_file_id") REFERENCES "stored_files"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "incident_evidence" ADD CONSTRAINT "incident_evidence_added_by_id_fkey" FOREIGN KEY ("added_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "incident_subjects" ADD CONSTRAINT "incident_subjects_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "incident_subjects" ADD CONSTRAINT "incident_subjects_incident_id_fkey" FOREIGN KEY ("incident_id") REFERENCES "incidents"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "incident_subjects" ADD CONSTRAINT "incident_subjects_recorded_by_id_fkey" FOREIGN KEY ("recorded_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "station_statuses" ADD CONSTRAINT "station_statuses_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "station_statuses" ADD CONSTRAINT "station_statuses_election_cycle_id_fkey" FOREIGN KEY ("election_cycle_id") REFERENCES "election_cycles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "station_statuses" ADD CONSTRAINT "station_statuses_manual_set_by_id_fkey" FOREIGN KEY ("manual_set_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "station_status_events" ADD CONSTRAINT "station_status_events_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "station_status_events" ADD CONSTRAINT "station_status_events_station_status_id_fkey" FOREIGN KEY ("station_status_id") REFERENCES "station_statuses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "station_status_events" ADD CONSTRAINT "station_status_events_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "client_submissions" ADD CONSTRAINT "client_submissions_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "client_submissions" ADD CONSTRAINT "client_submissions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- CreateIndex
CREATE UNIQUE INDEX "incidents_tenant_id_reference_key" ON "incidents"("tenant_id", "reference");

-- AddForeignKey
ALTER TABLE "incidents" ADD CONSTRAINT "incidents_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "incidents" ADD CONSTRAINT "incidents_election_cycle_id_fkey" FOREIGN KEY ("election_cycle_id") REFERENCES "election_cycles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "incidents" ADD CONSTRAINT "incidents_geographic_unit_id_fkey" FOREIGN KEY ("geographic_unit_id") REFERENCES "geographic_units"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "incidents" ADD CONSTRAINT "incidents_reporter_id_fkey" FOREIGN KEY ("reporter_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "incidents" ADD CONSTRAINT "incidents_assignee_id_fkey" FOREIGN KEY ("assignee_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ===========================================================================
-- Tenant isolation (RLS) on every new tenant-owned table.
-- ===========================================================================
SELECT ngao_enable_tenant_rls('agents');
SELECT ngao_enable_tenant_rls('agent_sensitive');
SELECT ngao_enable_tenant_rls('agent_accreditations');
SELECT ngao_enable_tenant_rls('agent_trainings');
SELECT ngao_enable_tenant_rls('agent_status_events');
SELECT ngao_enable_tenant_rls('deployments');
SELECT ngao_enable_tenant_rls('deployment_events');
SELECT ngao_enable_tenant_rls('readiness_checklists');
SELECT ngao_enable_tenant_rls('readiness_items');
SELECT ngao_enable_tenant_rls('field_report_templates');
SELECT ngao_enable_tenant_rls('field_reports');
SELECT ngao_enable_tenant_rls('field_report_evidence');
SELECT ngao_enable_tenant_rls('incidents');
SELECT ngao_enable_tenant_rls('incident_events');
SELECT ngao_enable_tenant_rls('incident_evidence');
SELECT ngao_enable_tenant_rls('incident_subjects');
SELECT ngao_enable_tenant_rls('station_statuses');
SELECT ngao_enable_tenant_rls('station_status_events');
SELECT ngao_enable_tenant_rls('client_submissions');

-- ===========================================================================
-- Runtime role privileges. Nothing in field operations is ever deleted.
-- ===========================================================================
GRANT SELECT, INSERT, UPDATE ON
  agents, agent_sensitive, agent_accreditations, agent_trainings, deployments,
  readiness_checklists, readiness_items, field_report_templates, field_reports,
  incidents, station_statuses, client_submissions
  TO ngao_app;
GRANT SELECT, INSERT ON
  agent_status_events, deployment_events, field_report_evidence, incident_events,
  incident_evidence, incident_subjects, station_status_events
  TO ngao_app;
REVOKE DELETE, TRUNCATE ON
  agents, agent_sensitive, agent_accreditations, agent_trainings, deployments,
  readiness_checklists, readiness_items, field_report_templates, field_reports,
  incidents, station_statuses, client_submissions
  FROM ngao_app;
REVOKE UPDATE, DELETE, TRUNCATE ON
  agent_status_events, deployment_events, field_report_evidence, incident_events,
  incident_evidence, incident_subjects, station_status_events
  FROM ngao_app;

-- Mutable records: no DELETE or TRUNCATE (even for the owner role).
DO $$
DECLARE
  tbl text;
BEGIN
  FOREACH tbl IN ARRAY ARRAY[
    'agents', 'agent_sensitive', 'agent_accreditations', 'agent_trainings', 'deployments',
    'readiness_checklists', 'readiness_items', 'field_report_templates', 'field_reports',
    'incidents', 'station_statuses', 'client_submissions'
  ]
  LOOP
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE DELETE ON %I FOR EACH ROW EXECUTE FUNCTION ngao_reject_modification()',
      tbl || '_no_delete', tbl
    );
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE TRUNCATE ON %I FOR EACH STATEMENT EXECUTE FUNCTION ngao_reject_modification()',
      tbl || '_no_truncate', tbl
    );
  END LOOP;
END
$$;

-- Append-only history: no UPDATE, DELETE or TRUNCATE.
DO $$
DECLARE
  tbl text;
BEGIN
  FOREACH tbl IN ARRAY ARRAY[
    'agent_status_events', 'deployment_events', 'field_report_evidence', 'incident_events',
    'incident_evidence', 'incident_subjects', 'station_status_events'
  ]
  LOOP
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION ngao_reject_modification()',
      tbl || '_append_only', tbl
    );
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE TRUNCATE ON %I FOR EACH STATEMENT EXECUTE FUNCTION ngao_reject_modification()',
      tbl || '_no_truncate', tbl
    );
  END LOOP;
END
$$;

-- ===========================================================================
-- Immutability guards
-- ===========================================================================

-- Incidents: the original report never changes; corrections are incident_events.
CREATE OR REPLACE FUNCTION ngao_incidents_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
     OR NEW.reference IS DISTINCT FROM OLD.reference
     OR NEW.election_cycle_id IS DISTINCT FROM OLD.election_cycle_id
     OR NEW.reported_category IS DISTINCT FROM OLD.reported_category
     OR NEW.initial_severity IS DISTINCT FROM OLD.initial_severity
     OR NEW.occurred_at IS DISTINCT FROM OLD.occurred_at
     OR NEW.reported_at IS DISTINCT FROM OLD.reported_at
     OR NEW.polling_station_code IS DISTINCT FROM OLD.polling_station_code
     OR NEW.geographic_unit_id IS DISTINCT FROM OLD.geographic_unit_id
     OR NEW.county_id IS DISTINCT FROM OLD.county_id
     OR NEW.constituency_id IS DISTINCT FROM OLD.constituency_id
     OR NEW.ward_id IS DISTINCT FROM OLD.ward_id
     OR NEW.polling_centre_id IS DISTINCT FROM OLD.polling_centre_id
     OR NEW.location_description IS DISTINCT FROM OLD.location_description
     OR NEW.latitude IS DISTINCT FROM OLD.latitude
     OR NEW.longitude IS DISTINCT FROM OLD.longitude
     OR NEW.description IS DISTINCT FROM OLD.description
     OR NEW.reporter_id IS DISTINCT FROM OLD.reporter_id
     OR NEW.submitted_offline IS DISTINCT FROM OLD.submitted_offline
     OR NEW.client_idempotency_key IS DISTINCT FROM OLD.client_idempotency_key
     OR NEW.device_id IS DISTINCT FROM OLD.device_id
     OR NEW.client_created_at IS DISTINCT FROM OLD.client_created_at THEN
    RAISE EXCEPTION 'IMMUTABLE_RECORD: the original incident report cannot change; add a correction event instead'
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER incidents_guard BEFORE UPDATE ON incidents
  FOR EACH ROW EXECUTE FUNCTION ngao_incidents_guard();

-- Field reports: submitted content never changes; only the review fields do.
CREATE OR REPLACE FUNCTION ngao_field_reports_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
     OR NEW.reference IS DISTINCT FROM OLD.reference
     OR NEW.template_id IS DISTINCT FROM OLD.template_id
     OR NEW.template_version IS DISTINCT FROM OLD.template_version
     OR NEW.report_type IS DISTINCT FROM OLD.report_type
     OR NEW.election_cycle_id IS DISTINCT FROM OLD.election_cycle_id
     OR NEW.polling_station_code IS DISTINCT FROM OLD.polling_station_code
     OR NEW.geographic_unit_id IS DISTINCT FROM OLD.geographic_unit_id
     OR NEW.county_id IS DISTINCT FROM OLD.county_id
     OR NEW.constituency_id IS DISTINCT FROM OLD.constituency_id
     OR NEW.ward_id IS DISTINCT FROM OLD.ward_id
     OR NEW.polling_centre_id IS DISTINCT FROM OLD.polling_centre_id
     OR NEW.event_at IS DISTINCT FROM OLD.event_at
     OR NEW.received_at IS DISTINCT FROM OLD.received_at
     OR NEW.answers IS DISTINCT FROM OLD.answers
     OR NEW.notes IS DISTINCT FROM OLD.notes
     OR NEW.latitude IS DISTINCT FROM OLD.latitude
     OR NEW.longitude IS DISTINCT FROM OLD.longitude
     OR NEW.author_id IS DISTINCT FROM OLD.author_id
     OR NEW.submitted_offline IS DISTINCT FROM OLD.submitted_offline
     OR NEW.client_idempotency_key IS DISTINCT FROM OLD.client_idempotency_key
     OR NEW.device_id IS DISTINCT FROM OLD.device_id
     OR NEW.client_created_at IS DISTINCT FROM OLD.client_created_at
     OR NEW.supersedes_report_id IS DISTINCT FROM OLD.supersedes_report_id THEN
    RAISE EXCEPTION 'IMMUTABLE_RECORD: a submitted field report cannot change; submit a new report instead'
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER field_reports_guard BEFORE UPDATE ON field_reports
  FOR EACH ROW EXECUTE FUNCTION ngao_field_reports_guard();

-- Field report templates: an ACTIVE or RETIRED template is frozen; ACTIVE may only retire.
CREATE OR REPLACE FUNCTION ngao_field_report_templates_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status <> 'DRAFT' THEN
    IF NEW.key IS DISTINCT FROM OLD.key
       OR NEW.version IS DISTINCT FROM OLD.version
       OR NEW.name IS DISTINCT FROM OLD.name
       OR NEW.description IS DISTINCT FROM OLD.description
       OR NEW.report_type IS DISTINCT FROM OLD.report_type
       OR NEW.schema IS DISTINCT FROM OLD.schema
       OR NEW.election_cycle_id IS DISTINCT FROM OLD.election_cycle_id
       OR NEW.created_by_id IS DISTINCT FROM OLD.created_by_id
       OR NEW.activated_by_id IS DISTINCT FROM OLD.activated_by_id
       OR NEW.activated_at IS DISTINCT FROM OLD.activated_at
       OR NOT (NEW.status = OLD.status OR (OLD.status = 'ACTIVE' AND NEW.status = 'RETIRED')) THEN
      RAISE EXCEPTION 'IMMUTABLE_RECORD: an active field report template cannot change; create a new version'
        USING ERRCODE = 'P0001';
    END IF;
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER field_report_templates_guard BEFORE UPDATE ON field_report_templates
  FOR EACH ROW EXECUTE FUNCTION ngao_field_report_templates_guard();

-- Deployments: the slot identity (agent, station, cycle, role) never changes;
-- a different agent or station is a replacement (new row).
CREATE OR REPLACE FUNCTION ngao_deployments_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
     OR NEW.election_cycle_id IS DISTINCT FROM OLD.election_cycle_id
     OR NEW.agent_id IS DISTINCT FROM OLD.agent_id
     OR NEW.polling_station_code IS DISTINCT FROM OLD.polling_station_code
     OR NEW.role IS DISTINCT FROM OLD.role
     OR NEW.replaces_deployment_id IS DISTINCT FROM OLD.replaces_deployment_id
     OR NEW.created_by_id IS DISTINCT FROM OLD.created_by_id
     OR (OLD.status IN ('REPLACED', 'CANCELLED', 'CHECKED_OUT') AND NEW.status IS DISTINCT FROM OLD.status) THEN
    RAISE EXCEPTION 'IMMUTABLE_RECORD: a deployment keeps its agent, station and role; replace it instead'
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER deployments_guard BEFORE UPDATE ON deployments
  FOR EACH ROW EXECUTE FUNCTION ngao_deployments_guard();

-- Idempotency ledger: identity and payload hash are fixed; only the retry
-- counters may change.
CREATE OR REPLACE FUNCTION ngao_client_submissions_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
     OR NEW.user_id IS DISTINCT FROM OLD.user_id
     OR NEW.device_id IS DISTINCT FROM OLD.device_id
     OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
     OR NEW.kind IS DISTINCT FROM OLD.kind
     OR NEW.payload_hash IS DISTINCT FROM OLD.payload_hash
     OR NEW.first_seen_at IS DISTINCT FROM OLD.first_seen_at
     OR (OLD.outcome = 'ACCEPTED' AND (NEW.outcome IS DISTINCT FROM OLD.outcome
         OR NEW.result_id IS DISTINCT FROM OLD.result_id
         OR NEW.result_type IS DISTINCT FROM OLD.result_type)) THEN
    RAISE EXCEPTION 'IMMUTABLE_RECORD: a recorded client submission cannot change'
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER client_submissions_guard BEFORE UPDATE ON client_submissions
  FOR EACH ROW EXECUTE FUNCTION ngao_client_submissions_guard();

-- ===========================================================================
-- Integrity checks and partial unique indexes
-- ===========================================================================
ALTER TABLE tenant_modules DROP CONSTRAINT tenant_modules_key_check;
ALTER TABLE tenant_modules
  ADD CONSTRAINT tenant_modules_key_check CHECK (module_key IN ('tally', 'office', 'field'));

-- One active deployment per agent and shift in a cycle (double booking is a conflict).
CREATE UNIQUE INDEX deployments_agent_active_shift_key
  ON deployments (tenant_id, election_cycle_id, agent_id, shift)
  WHERE status IN ('ASSIGNED', 'CONFIRMED', 'CHECKED_IN');
-- One active chief agent per station and shift.
CREATE UNIQUE INDEX deployments_station_chief_active_key
  ON deployments (tenant_id, election_cycle_id, polling_station_code, shift)
  WHERE role = 'CHIEF_AGENT' AND status IN ('ASSIGNED', 'CONFIRMED', 'CHECKED_IN');

ALTER TABLE deployments
  ADD CONSTRAINT deployments_check_in_location_check
    CHECK ((check_in_latitude IS NULL) = (check_in_longitude IS NULL)),
  ADD CONSTRAINT deployments_checked_in_check
    CHECK (status NOT IN ('CHECKED_IN', 'CHECKED_OUT') OR checked_in_at IS NOT NULL),
  ADD CONSTRAINT deployments_replacement_check
    CHECK (replaces_deployment_id IS NULL OR replaces_deployment_id <> id);

ALTER TABLE agents
  ADD CONSTRAINT agents_privacy_notice_check
    CHECK ((privacy_notice_version IS NULL) = (privacy_notice_ack_at IS NULL));

ALTER TABLE agent_trainings
  ADD CONSTRAINT agent_trainings_score_check CHECK (assessment_score IS NULL OR assessment_score BETWEEN 0 AND 100);

ALTER TABLE field_reports
  ADD CONSTRAINT field_reports_coordinates_check CHECK ((latitude IS NULL) = (longitude IS NULL)),
  ADD CONSTRAINT field_reports_reviewer_check CHECK (reviewer_id IS NULL OR reviewer_id <> author_id);

ALTER TABLE field_report_templates
  ADD CONSTRAINT field_report_templates_activation_check
    CHECK (status = 'DRAFT' OR (activated_by_id IS NOT NULL AND activated_at IS NOT NULL)),
  ADD CONSTRAINT field_report_templates_maker_checker_check
    CHECK (activated_by_id IS NULL OR activated_by_id <> created_by_id);
-- One ACTIVE version per template key.
CREATE UNIQUE INDEX field_report_templates_one_active_key
  ON field_report_templates (tenant_id, key) WHERE status = 'ACTIVE';

ALTER TABLE incidents
  ADD CONSTRAINT incidents_coordinates_check CHECK ((latitude IS NULL) = (longitude IS NULL)),
  ADD CONSTRAINT incidents_resolved_check
    CHECK (status NOT IN ('RESOLVED', 'CLOSED') OR (outcome IS NOT NULL AND resolution_note IS NOT NULL AND resolved_by_id IS NOT NULL)),
  ADD CONSTRAINT incidents_closed_check
    CHECK (status <> 'CLOSED' OR (closure_note IS NOT NULL AND closed_by_id IS NOT NULL AND closed_at IS NOT NULL)),
  -- Closure by an authorised reviewer who neither reported nor resolved it (blueprint 7.3 step 6).
  ADD CONSTRAINT incidents_closer_check
    CHECK (closed_by_id IS NULL OR (closed_by_id <> reporter_id AND closed_by_id IS DISTINCT FROM resolved_by_id)),
  ADD CONSTRAINT incidents_duplicate_check CHECK (duplicate_of_id IS NULL OR duplicate_of_id <> id);

ALTER TABLE station_statuses
  ADD CONSTRAINT station_statuses_manual_check
    CHECK ((source = 'MANUAL') = (manual_status IS NOT NULL)),
  ADD CONSTRAINT station_statuses_manual_status_check
    CHECK (manual_status IS NULL OR manual_status IN ('FLAGGED', 'CLOSED'));

-- ===========================================================================
-- Permission catalogue: the foundation's placeholder incidents.* keys are
-- replaced by field.incidents.* (system roles are re-provisioned by the seed).
-- ===========================================================================
DELETE FROM role_permissions WHERE permission_key IN ('incidents.view', 'incidents.create', 'incidents.manage');
DELETE FROM permissions WHERE key IN ('incidents.view', 'incidents.create', 'incidents.manage');

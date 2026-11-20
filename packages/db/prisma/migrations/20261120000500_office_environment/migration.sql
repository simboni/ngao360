-- NGAO360 Office environment (blueprint 9): tenant module activation, correspondence,
-- appointments, meetings, citizen cases, referrals, institutions and projects.
-- Generated DDL first, then hand-written tenant isolation, append-only and integrity guards.

-- CreateEnum
CREATE TYPE "ContactPreference" AS ENUM ('NONE', 'PHONE', 'SMS', 'EMAIL');

-- CreateEnum
CREATE TYPE "VerificationStatus" AS ENUM ('UNVERIFIED', 'PENDING_VERIFICATION', 'VERIFIED', 'DISPUTED');

-- CreateEnum
CREATE TYPE "CorrespondenceDirection" AS ENUM ('INCOMING', 'OUTGOING');

-- CreateEnum
CREATE TYPE "CorrespondenceChannel" AS ENUM ('POST', 'HAND_DELIVERY', 'EMAIL', 'COURIER', 'INTERNAL_MEMO', 'OTHER');

-- CreateEnum
CREATE TYPE "CorrespondenceCategory" AS ENUM ('GENERAL', 'INVITATION', 'PETITION', 'COMPLAINT', 'REQUEST_FOR_SUPPORT', 'GOVERNMENT_CIRCULAR', 'INTERGOVERNMENTAL', 'LEGAL', 'MEDIA', 'FINANCE', 'OTHER');

-- CreateEnum
CREATE TYPE "CorrespondenceStatus" AS ENUM ('DRAFT', 'RECEIVED', 'ASSIGNED', 'IN_PROGRESS', 'RESPONDED', 'SENT', 'FILED', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "AppointmentSource" AS ENUM ('WALK_IN', 'PHONE', 'EMAIL', 'LETTER', 'REFERRAL', 'OTHER');

-- CreateEnum
CREATE TYPE "AppointmentStatus" AS ENUM ('REQUESTED', 'CONFIRMED', 'RESCHEDULED', 'DECLINED', 'CANCELLED', 'COMPLETED', 'NO_SHOW');

-- CreateEnum
CREATE TYPE "MeetingStatus" AS ENUM ('SCHEDULED', 'HELD', 'CANCELLED');

-- CreateEnum
CREATE TYPE "ActionItemStatus" AS ENUM ('OPEN', 'DONE', 'CANCELLED');

-- CreateEnum
CREATE TYPE "CaseCategory" AS ENUM ('WATER_SANITATION', 'ROADS_TRANSPORT', 'HEALTH', 'EDUCATION_BURSARY', 'AGRICULTURE_LIVESTOCK', 'LAND_HOUSING', 'TRADE_MARKETS', 'ENVIRONMENT_WASTE', 'SOCIAL_SUPPORT', 'PUBLIC_SERVICE_COMPLAINT', 'SECURITY_REFERRAL', 'OTHER');

-- CreateEnum
CREATE TYPE "CaseSource" AS ENUM ('PORTAL', 'WALK_IN', 'PHONE', 'LETTER', 'EMAIL', 'SMS', 'OUTREACH');

-- CreateEnum
CREATE TYPE "CasePriority" AS ENUM ('LOW', 'MEDIUM', 'HIGH', 'URGENT');

-- CreateEnum
CREATE TYPE "CaseStatus" AS ENUM ('SUBMITTED', 'TRIAGE', 'ASSIGNED', 'IN_PROGRESS', 'REFERRED', 'RESOLUTION_PROPOSED', 'CITIZEN_FEEDBACK', 'CLOSED', 'REOPENED');

-- CreateEnum
CREATE TYPE "CaseClosureReason" AS ENUM ('RESOLVED', 'REFERRED_OUT', 'DUPLICATE', 'OUT_OF_JURISDICTION', 'NO_RESPONSE_FROM_REQUESTER', 'WITHDRAWN', 'ABUSIVE_OR_SPAM');

-- CreateEnum
CREATE TYPE "CaseEventType" AS ENUM ('SUBMITTED', 'STATUS_CHANGED', 'ASSIGNED', 'NOTE', 'PUBLIC_UPDATE', 'CONTACT_ATTEMPT', 'EVIDENCE_ADDED', 'REFERRED', 'REFERRAL_UPDATED', 'RESOLUTION_PROPOSED', 'CITIZEN_FEEDBACK', 'CLOSED', 'REOPENED');

-- CreateEnum
CREATE TYPE "CaseEventVisibility" AS ENUM ('PUBLIC', 'INTERNAL');

-- CreateEnum
CREATE TYPE "CaseEventActorType" AS ENUM ('STAFF', 'REQUESTER', 'SYSTEM');

-- CreateEnum
CREATE TYPE "ReferralStatus" AS ENUM ('SENT', 'ACKNOWLEDGED', 'RESPONDED', 'NO_RESPONSE', 'CLOSED');

-- CreateEnum
CREATE TYPE "InstitutionType" AS ENUM ('COUNTY_DEPARTMENT', 'COUNTY_ENTITY', 'COUNTY_ASSEMBLY', 'NATIONAL_MINISTRY', 'NATIONAL_AGENCY', 'STATE_CORPORATION', 'CONSTITUENCY_FUND', 'DEVELOPMENT_PARTNER', 'NON_GOVERNMENTAL', 'CONTRACTOR', 'OTHER');

-- CreateEnum
CREATE TYPE "ProjectCategory" AS ENUM ('WATER_SANITATION', 'ROADS_INFRASTRUCTURE', 'HEALTH', 'EDUCATION', 'AGRICULTURE', 'TRADE_MARKETS', 'ENERGY', 'ENVIRONMENT', 'SOCIAL_SERVICES', 'YOUTH_SPORTS', 'HOUSING_URBAN', 'ICT', 'OTHER');

-- CreateEnum
CREATE TYPE "CommitmentSource" AS ENUM ('MANIFESTO_PLEDGE', 'PUBLIC_STATEMENT', 'COUNTY_INTEGRATED_DEVELOPMENT_PLAN', 'ANNUAL_DEVELOPMENT_PLAN', 'COUNTY_BUDGET', 'NATIONAL_BUDGET', 'CONSTITUENCY_FUND', 'DEVELOPMENT_PARTNER_AGREEMENT', 'CITIZEN_REQUEST', 'OTHER');

-- CreateEnum
CREATE TYPE "FundingSource" AS ENUM ('COUNTY_GOVERNMENT', 'NATIONAL_GOVERNMENT', 'CONSTITUENCY_FUND', 'DEVELOPMENT_PARTNER', 'PUBLIC_PRIVATE_PARTNERSHIP', 'OTHER', 'NOT_YET_IDENTIFIED');

-- CreateEnum
CREATE TYPE "ProjectStatus" AS ENUM ('PROPOSED', 'COMMITTED', 'APPROVED', 'FUNDED', 'PROCUREMENT', 'ONGOING', 'DELAYED', 'COMPLETED', 'VERIFIED_COMPLETED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "MilestoneStatus" AS ENUM ('PLANNED', 'IN_PROGRESS', 'DONE', 'DELAYED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "ProjectEvidenceType" AS ENUM ('PHOTO', 'INSPECTION_REPORT', 'COMPLETION_CERTIFICATE', 'HANDOVER_DOCUMENT', 'PAYMENT_RECORD', 'CONTRACT_DOCUMENT', 'MEETING_MINUTES', 'OTHER_DOCUMENT');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "StoredFilePurpose" ADD VALUE 'CORRESPONDENCE';
ALTER TYPE "StoredFilePurpose" ADD VALUE 'CASE_EVIDENCE';
ALTER TYPE "StoredFilePurpose" ADD VALUE 'PROJECT_EVIDENCE';

-- CreateTable
CREATE TABLE "tenant_modules" (
    "tenant_id" UUID NOT NULL,
    "module_key" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL,
    "config" JSONB NOT NULL DEFAULT '{}',
    "updated_by_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "tenant_modules_pkey" PRIMARY KEY ("tenant_id","module_key")
);

-- CreateTable
CREATE TABLE "institutions" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "short_name" TEXT,
    "type" "InstitutionType" NOT NULL,
    "parent_id" UUID,
    "contact_email" TEXT,
    "contact_phone" TEXT,
    "physical_address" TEXT,
    "mandate" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "institutions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "correspondence" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "reference" TEXT NOT NULL,
    "direction" "CorrespondenceDirection" NOT NULL,
    "channel" "CorrespondenceChannel" NOT NULL,
    "category" "CorrespondenceCategory" NOT NULL,
    "sensitivity" "SensitivityLevel" NOT NULL DEFAULT 'INTERNAL',
    "subject" TEXT NOT NULL,
    "sender_name" TEXT,
    "sender_organisation" TEXT,
    "recipient_name" TEXT,
    "recipient_organisation" TEXT,
    "external_reference" TEXT,
    "document_date" DATE,
    "received_at" TIMESTAMPTZ(3),
    "sent_at" TIMESTAMPTZ(3),
    "response_due_date" DATE,
    "status" "CorrespondenceStatus" NOT NULL,
    "assigned_to_id" UUID,
    "summary" TEXT,
    "linked_case_id" UUID,
    "in_reply_to_id" UUID,
    "created_by_id" UUID NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "correspondence_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "correspondence_attachments" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "correspondence_id" UUID NOT NULL,
    "stored_file_id" UUID NOT NULL,
    "label" TEXT,
    "added_by_id" UUID NOT NULL,
    "added_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "correspondence_attachments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "appointments" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "reference" TEXT NOT NULL,
    "source" "AppointmentSource" NOT NULL,
    "requester_name" TEXT NOT NULL,
    "requester_organisation" TEXT,
    "contact_phone" TEXT,
    "contact_email" TEXT,
    "contact_preference" "ContactPreference" NOT NULL DEFAULT 'PHONE',
    "purpose" TEXT NOT NULL,
    "preferred_start" TIMESTAMPTZ(3),
    "preferred_end" TIMESTAMPTZ(3),
    "confirmed_start" TIMESTAMPTZ(3),
    "confirmed_end" TIMESTAMPTZ(3),
    "venue" TEXT,
    "assigned_office" TEXT,
    "assigned_to_id" UUID,
    "status" "AppointmentStatus" NOT NULL DEFAULT 'REQUESTED',
    "outcome" TEXT,
    "outcome_recorded_at" TIMESTAMPTZ(3),
    "follow_up_required" BOOLEAN NOT NULL DEFAULT false,
    "follow_up_date" DATE,
    "follow_up_notes" TEXT,
    "privacy_notice_version" TEXT NOT NULL,
    "linked_case_id" UUID,
    "linked_correspondence_id" UUID,
    "created_by_id" UUID NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "appointments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "meetings" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "scheduled_start" TIMESTAMPTZ(3) NOT NULL,
    "scheduled_end" TIMESTAMPTZ(3),
    "venue" TEXT,
    "online_link" TEXT,
    "status" "MeetingStatus" NOT NULL DEFAULT 'SCHEDULED',
    "sensitivity" "SensitivityLevel" NOT NULL DEFAULT 'INTERNAL',
    "agenda" JSONB NOT NULL DEFAULT '[]',
    "participants" JSONB NOT NULL DEFAULT '[]',
    "minutes" TEXT,
    "minutes_recorded_by_id" UUID,
    "minutes_recorded_at" TIMESTAMPTZ(3),
    "owner_id" UUID NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "meetings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "meeting_action_items" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "meeting_id" UUID NOT NULL,
    "description" TEXT NOT NULL,
    "owner_id" UUID,
    "owner_name" TEXT,
    "due_date" DATE,
    "status" "ActionItemStatus" NOT NULL DEFAULT 'OPEN',
    "completed_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "meeting_action_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "meeting_decisions" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "meeting_id" UUID NOT NULL,
    "decision" TEXT NOT NULL,
    "rationale" TEXT,
    "supersedes_id" UUID,
    "recorded_by_id" UUID NOT NULL,
    "recorded_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "meeting_decisions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "citizen_cases" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "reference" TEXT NOT NULL,
    "public_reference" TEXT NOT NULL,
    "tracking_code_hash" TEXT,
    "source" "CaseSource" NOT NULL,
    "category" "CaseCategory" NOT NULL,
    "priority" "CasePriority" NOT NULL DEFAULT 'MEDIUM',
    "sensitivity" "SensitivityLevel" NOT NULL DEFAULT 'INTERNAL',
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "geographic_unit_id" UUID,
    "county_id" UUID,
    "constituency_id" UUID,
    "ward_id" UUID,
    "location_description" TEXT,
    "privacy_notice_version" TEXT NOT NULL,
    "consent_to_contact" BOOLEAN NOT NULL DEFAULT false,
    "status" "CaseStatus" NOT NULL DEFAULT 'SUBMITTED',
    "assignee_id" UUID,
    "triaged_by_id" UUID,
    "triaged_at" TIMESTAMPTZ(3),
    "next_review_date" DATE,
    "resolution_summary" TEXT,
    "resolution_proposed_by_id" UUID,
    "resolution_proposed_at" TIMESTAMPTZ(3),
    "closure_reason" "CaseClosureReason",
    "closure_note" TEXT,
    "closed_by_id" UUID,
    "closed_at" TIMESTAMPTZ(3),
    "duplicate_of_id" UUID,
    "created_by_id" UUID,
    "submitted_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "version" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "citizen_cases_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "citizen_case_contacts" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "case_id" UUID NOT NULL,
    "name" TEXT,
    "phone" TEXT,
    "email" TEXT,
    "preference" "ContactPreference" NOT NULL DEFAULT 'NONE',
    "preferred_language" TEXT,
    "retention_until" DATE,
    "erased_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "citizen_case_contacts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "case_events" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "case_id" UUID NOT NULL,
    "type" "CaseEventType" NOT NULL,
    "visibility" "CaseEventVisibility" NOT NULL,
    "actor_type" "CaseEventActorType" NOT NULL,
    "actor_id" UUID,
    "body" TEXT,
    "from_status" "CaseStatus",
    "to_status" "CaseStatus",
    "stored_file_id" UUID,
    "referral_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "case_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "case_referrals" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "case_id" UUID NOT NULL,
    "institution_id" UUID NOT NULL,
    "referred_at" DATE NOT NULL,
    "contact_person" TEXT,
    "contact_detail" TEXT,
    "institution_reference" TEXT,
    "follow_up_date" DATE,
    "status" "ReferralStatus" NOT NULL DEFAULT 'SENT',
    "response_summary" TEXT,
    "requester_contact_shared" BOOLEAN NOT NULL DEFAULT false,
    "referred_by_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "case_referrals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "projects" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "reference" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "category" "ProjectCategory" NOT NULL,
    "geographic_unit_id" UUID,
    "county_id" UUID,
    "constituency_id" UUID,
    "ward_id" UUID,
    "location_description" TEXT,
    "latitude" DECIMAL(9,6),
    "longitude" DECIMAL(9,6),
    "responsible_institution_id" UUID NOT NULL,
    "implementing_agency_id" UUID,
    "owner_name" TEXT,
    "tracking_officer_id" UUID,
    "approval_authority" TEXT,
    "commitment_source" "CommitmentSource" NOT NULL,
    "commitment_source_detail" TEXT,
    "funding_source" "FundingSource" NOT NULL DEFAULT 'NOT_YET_IDENTIFIED',
    "funding_source_detail" TEXT,
    "currency" CHAR(3) NOT NULL DEFAULT 'KES',
    "approved_allocation" DECIMAL(16,2),
    "allocation_source" TEXT,
    "contract_amount" DECIMAL(16,2),
    "contract_amount_is_public" BOOLEAN NOT NULL DEFAULT false,
    "expenditure_reported" DECIMAL(16,2),
    "expenditure_source" TEXT,
    "expenditure_as_of" DATE,
    "expenditure_verification_status" "VerificationStatus" NOT NULL DEFAULT 'UNVERIFIED',
    "expenditure_verified_by_id" UUID,
    "expenditure_verified_at" TIMESTAMPTZ(3),
    "start_date" DATE,
    "expected_completion_date" DATE,
    "actual_completion_date" DATE,
    "delay_reason" TEXT,
    "status" "ProjectStatus" NOT NULL DEFAULT 'PROPOSED',
    "completion_reported_by_id" UUID,
    "completion_reported_at" TIMESTAMPTZ(3),
    "completion_verified_by_id" UUID,
    "completion_verified_at" TIMESTAMPTZ(3),
    "completion_verification_note" TEXT,
    "is_public" BOOLEAN NOT NULL DEFAULT false,
    "public_fields" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "public_summary" TEXT,
    "published_by_id" UUID,
    "published_at" TIMESTAMPTZ(3),
    "created_by_id" UUID NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "projects_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "project_milestones" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "sequence" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "planned_date" DATE,
    "actual_date" DATE,
    "status" "MilestoneStatus" NOT NULL DEFAULT 'PLANNED',
    "verification_status" "VerificationStatus" NOT NULL DEFAULT 'UNVERIFIED',
    "verified_by_id" UUID,
    "verified_at" TIMESTAMPTZ(3),
    "verification_note" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "project_milestones_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "project_evidence" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "milestone_id" UUID,
    "type" "ProjectEvidenceType" NOT NULL,
    "description" TEXT NOT NULL,
    "captured_on" DATE,
    "source_description" TEXT,
    "stored_file_id" UUID NOT NULL,
    "uploaded_by_id" UUID NOT NULL,
    "uploaded_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "latitude" DECIMAL(9,6),
    "longitude" DECIMAL(9,6),
    "verification_status" "VerificationStatus" NOT NULL DEFAULT 'UNVERIFIED',
    "verified_by_id" UUID,
    "verified_at" TIMESTAMPTZ(3),
    "verification_note" TEXT,
    "is_public" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "project_evidence_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "institutions_tenant_id_type_idx" ON "institutions"("tenant_id", "type");

-- CreateIndex
CREATE UNIQUE INDEX "institutions_tenant_id_name_key" ON "institutions"("tenant_id", "name");

-- CreateIndex
CREATE INDEX "correspondence_tenant_id_direction_status_idx" ON "correspondence"("tenant_id", "direction", "status");

-- CreateIndex
CREATE INDEX "correspondence_tenant_id_assigned_to_id_status_idx" ON "correspondence"("tenant_id", "assigned_to_id", "status");

-- CreateIndex
CREATE INDEX "correspondence_tenant_id_response_due_date_idx" ON "correspondence"("tenant_id", "response_due_date");

-- CreateIndex
CREATE UNIQUE INDEX "correspondence_tenant_id_reference_key" ON "correspondence"("tenant_id", "reference");

-- CreateIndex
CREATE INDEX "correspondence_attachments_tenant_id_correspondence_id_idx" ON "correspondence_attachments"("tenant_id", "correspondence_id");

-- CreateIndex
CREATE UNIQUE INDEX "correspondence_attachments_correspondence_id_stored_file_id_key" ON "correspondence_attachments"("correspondence_id", "stored_file_id");

-- CreateIndex
CREATE INDEX "appointments_tenant_id_status_confirmed_start_idx" ON "appointments"("tenant_id", "status", "confirmed_start");

-- CreateIndex
CREATE INDEX "appointments_tenant_id_assigned_to_id_idx" ON "appointments"("tenant_id", "assigned_to_id");

-- CreateIndex
CREATE UNIQUE INDEX "appointments_tenant_id_reference_key" ON "appointments"("tenant_id", "reference");

-- CreateIndex
CREATE INDEX "meetings_tenant_id_scheduled_start_idx" ON "meetings"("tenant_id", "scheduled_start");

-- CreateIndex
CREATE INDEX "meeting_action_items_tenant_id_meeting_id_idx" ON "meeting_action_items"("tenant_id", "meeting_id");

-- CreateIndex
CREATE INDEX "meeting_action_items_tenant_id_owner_id_status_idx" ON "meeting_action_items"("tenant_id", "owner_id", "status");

-- CreateIndex
CREATE INDEX "meeting_decisions_tenant_id_meeting_id_idx" ON "meeting_decisions"("tenant_id", "meeting_id");

-- CreateIndex
CREATE INDEX "citizen_cases_tenant_id_status_idx" ON "citizen_cases"("tenant_id", "status");

-- CreateIndex
CREATE INDEX "citizen_cases_tenant_id_assignee_id_status_idx" ON "citizen_cases"("tenant_id", "assignee_id", "status");

-- CreateIndex
CREATE INDEX "citizen_cases_tenant_id_county_id_idx" ON "citizen_cases"("tenant_id", "county_id");

-- CreateIndex
CREATE INDEX "citizen_cases_tenant_id_constituency_id_idx" ON "citizen_cases"("tenant_id", "constituency_id");

-- CreateIndex
CREATE INDEX "citizen_cases_tenant_id_ward_id_idx" ON "citizen_cases"("tenant_id", "ward_id");

-- CreateIndex
CREATE INDEX "citizen_cases_tenant_id_next_review_date_idx" ON "citizen_cases"("tenant_id", "next_review_date");

-- CreateIndex
CREATE UNIQUE INDEX "citizen_cases_tenant_id_reference_key" ON "citizen_cases"("tenant_id", "reference");

-- CreateIndex
CREATE UNIQUE INDEX "citizen_cases_tenant_id_public_reference_key" ON "citizen_cases"("tenant_id", "public_reference");

-- CreateIndex
CREATE UNIQUE INDEX "citizen_case_contacts_case_id_key" ON "citizen_case_contacts"("case_id");

-- CreateIndex
CREATE INDEX "citizen_case_contacts_tenant_id_retention_until_idx" ON "citizen_case_contacts"("tenant_id", "retention_until");

-- CreateIndex
CREATE INDEX "case_events_tenant_id_case_id_created_at_idx" ON "case_events"("tenant_id", "case_id", "created_at");

-- CreateIndex
CREATE INDEX "case_referrals_tenant_id_case_id_idx" ON "case_referrals"("tenant_id", "case_id");

-- CreateIndex
CREATE INDEX "case_referrals_tenant_id_follow_up_date_idx" ON "case_referrals"("tenant_id", "follow_up_date");

-- CreateIndex
CREATE INDEX "projects_tenant_id_status_idx" ON "projects"("tenant_id", "status");

-- CreateIndex
CREATE INDEX "projects_tenant_id_county_id_idx" ON "projects"("tenant_id", "county_id");

-- CreateIndex
CREATE INDEX "projects_tenant_id_constituency_id_idx" ON "projects"("tenant_id", "constituency_id");

-- CreateIndex
CREATE INDEX "projects_tenant_id_ward_id_idx" ON "projects"("tenant_id", "ward_id");

-- CreateIndex
CREATE INDEX "projects_tenant_id_responsible_institution_id_idx" ON "projects"("tenant_id", "responsible_institution_id");

-- CreateIndex
CREATE INDEX "projects_tenant_id_is_public_idx" ON "projects"("tenant_id", "is_public");

-- CreateIndex
CREATE UNIQUE INDEX "projects_tenant_id_reference_key" ON "projects"("tenant_id", "reference");

-- CreateIndex
CREATE INDEX "project_milestones_tenant_id_project_id_idx" ON "project_milestones"("tenant_id", "project_id");

-- CreateIndex
CREATE UNIQUE INDEX "project_milestones_project_id_sequence_key" ON "project_milestones"("project_id", "sequence");

-- CreateIndex
CREATE INDEX "project_evidence_tenant_id_project_id_idx" ON "project_evidence"("tenant_id", "project_id");

-- CreateIndex
CREATE INDEX "project_evidence_tenant_id_milestone_id_idx" ON "project_evidence"("tenant_id", "milestone_id");

-- AddForeignKey
ALTER TABLE "tenant_modules" ADD CONSTRAINT "tenant_modules_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tenant_modules" ADD CONSTRAINT "tenant_modules_updated_by_id_fkey" FOREIGN KEY ("updated_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "institutions" ADD CONSTRAINT "institutions_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "institutions" ADD CONSTRAINT "institutions_parent_id_fkey" FOREIGN KEY ("parent_id") REFERENCES "institutions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "correspondence" ADD CONSTRAINT "correspondence_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "correspondence" ADD CONSTRAINT "correspondence_assigned_to_id_fkey" FOREIGN KEY ("assigned_to_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "correspondence" ADD CONSTRAINT "correspondence_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "correspondence" ADD CONSTRAINT "correspondence_linked_case_id_fkey" FOREIGN KEY ("linked_case_id") REFERENCES "citizen_cases"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "correspondence" ADD CONSTRAINT "correspondence_in_reply_to_id_fkey" FOREIGN KEY ("in_reply_to_id") REFERENCES "correspondence"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "correspondence_attachments" ADD CONSTRAINT "correspondence_attachments_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "correspondence_attachments" ADD CONSTRAINT "correspondence_attachments_correspondence_id_fkey" FOREIGN KEY ("correspondence_id") REFERENCES "correspondence"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "correspondence_attachments" ADD CONSTRAINT "correspondence_attachments_stored_file_id_fkey" FOREIGN KEY ("stored_file_id") REFERENCES "stored_files"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "correspondence_attachments" ADD CONSTRAINT "correspondence_attachments_added_by_id_fkey" FOREIGN KEY ("added_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_assigned_to_id_fkey" FOREIGN KEY ("assigned_to_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_linked_case_id_fkey" FOREIGN KEY ("linked_case_id") REFERENCES "citizen_cases"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_linked_correspondence_id_fkey" FOREIGN KEY ("linked_correspondence_id") REFERENCES "correspondence"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "meetings" ADD CONSTRAINT "meetings_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "meetings" ADD CONSTRAINT "meetings_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "meetings" ADD CONSTRAINT "meetings_minutes_recorded_by_id_fkey" FOREIGN KEY ("minutes_recorded_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "meeting_action_items" ADD CONSTRAINT "meeting_action_items_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "meeting_action_items" ADD CONSTRAINT "meeting_action_items_meeting_id_fkey" FOREIGN KEY ("meeting_id") REFERENCES "meetings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "meeting_action_items" ADD CONSTRAINT "meeting_action_items_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "meeting_decisions" ADD CONSTRAINT "meeting_decisions_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "meeting_decisions" ADD CONSTRAINT "meeting_decisions_meeting_id_fkey" FOREIGN KEY ("meeting_id") REFERENCES "meetings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "meeting_decisions" ADD CONSTRAINT "meeting_decisions_supersedes_id_fkey" FOREIGN KEY ("supersedes_id") REFERENCES "meeting_decisions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "meeting_decisions" ADD CONSTRAINT "meeting_decisions_recorded_by_id_fkey" FOREIGN KEY ("recorded_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "citizen_cases" ADD CONSTRAINT "citizen_cases_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "citizen_cases" ADD CONSTRAINT "citizen_cases_geographic_unit_id_fkey" FOREIGN KEY ("geographic_unit_id") REFERENCES "geographic_units"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "citizen_cases" ADD CONSTRAINT "citizen_cases_county_id_fkey" FOREIGN KEY ("county_id") REFERENCES "geographic_units"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "citizen_cases" ADD CONSTRAINT "citizen_cases_constituency_id_fkey" FOREIGN KEY ("constituency_id") REFERENCES "geographic_units"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "citizen_cases" ADD CONSTRAINT "citizen_cases_ward_id_fkey" FOREIGN KEY ("ward_id") REFERENCES "geographic_units"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "citizen_cases" ADD CONSTRAINT "citizen_cases_assignee_id_fkey" FOREIGN KEY ("assignee_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "citizen_cases" ADD CONSTRAINT "citizen_cases_triaged_by_id_fkey" FOREIGN KEY ("triaged_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "citizen_cases" ADD CONSTRAINT "citizen_cases_resolution_proposed_by_id_fkey" FOREIGN KEY ("resolution_proposed_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "citizen_cases" ADD CONSTRAINT "citizen_cases_closed_by_id_fkey" FOREIGN KEY ("closed_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "citizen_cases" ADD CONSTRAINT "citizen_cases_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "citizen_cases" ADD CONSTRAINT "citizen_cases_duplicate_of_id_fkey" FOREIGN KEY ("duplicate_of_id") REFERENCES "citizen_cases"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "citizen_case_contacts" ADD CONSTRAINT "citizen_case_contacts_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "citizen_case_contacts" ADD CONSTRAINT "citizen_case_contacts_case_id_fkey" FOREIGN KEY ("case_id") REFERENCES "citizen_cases"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "case_events" ADD CONSTRAINT "case_events_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "case_events" ADD CONSTRAINT "case_events_case_id_fkey" FOREIGN KEY ("case_id") REFERENCES "citizen_cases"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "case_events" ADD CONSTRAINT "case_events_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "case_events" ADD CONSTRAINT "case_events_stored_file_id_fkey" FOREIGN KEY ("stored_file_id") REFERENCES "stored_files"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "case_events" ADD CONSTRAINT "case_events_referral_id_fkey" FOREIGN KEY ("referral_id") REFERENCES "case_referrals"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "case_referrals" ADD CONSTRAINT "case_referrals_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "case_referrals" ADD CONSTRAINT "case_referrals_case_id_fkey" FOREIGN KEY ("case_id") REFERENCES "citizen_cases"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "case_referrals" ADD CONSTRAINT "case_referrals_institution_id_fkey" FOREIGN KEY ("institution_id") REFERENCES "institutions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "case_referrals" ADD CONSTRAINT "case_referrals_referred_by_id_fkey" FOREIGN KEY ("referred_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "projects" ADD CONSTRAINT "projects_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "projects" ADD CONSTRAINT "projects_geographic_unit_id_fkey" FOREIGN KEY ("geographic_unit_id") REFERENCES "geographic_units"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "projects" ADD CONSTRAINT "projects_county_id_fkey" FOREIGN KEY ("county_id") REFERENCES "geographic_units"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "projects" ADD CONSTRAINT "projects_constituency_id_fkey" FOREIGN KEY ("constituency_id") REFERENCES "geographic_units"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "projects" ADD CONSTRAINT "projects_ward_id_fkey" FOREIGN KEY ("ward_id") REFERENCES "geographic_units"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "projects" ADD CONSTRAINT "projects_responsible_institution_id_fkey" FOREIGN KEY ("responsible_institution_id") REFERENCES "institutions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "projects" ADD CONSTRAINT "projects_implementing_agency_id_fkey" FOREIGN KEY ("implementing_agency_id") REFERENCES "institutions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "projects" ADD CONSTRAINT "projects_tracking_officer_id_fkey" FOREIGN KEY ("tracking_officer_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "projects" ADD CONSTRAINT "projects_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "projects" ADD CONSTRAINT "projects_completion_reported_by_id_fkey" FOREIGN KEY ("completion_reported_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "projects" ADD CONSTRAINT "projects_completion_verified_by_id_fkey" FOREIGN KEY ("completion_verified_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "projects" ADD CONSTRAINT "projects_expenditure_verified_by_id_fkey" FOREIGN KEY ("expenditure_verified_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "projects" ADD CONSTRAINT "projects_published_by_id_fkey" FOREIGN KEY ("published_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_milestones" ADD CONSTRAINT "project_milestones_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_milestones" ADD CONSTRAINT "project_milestones_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_milestones" ADD CONSTRAINT "project_milestones_verified_by_id_fkey" FOREIGN KEY ("verified_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_evidence" ADD CONSTRAINT "project_evidence_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_evidence" ADD CONSTRAINT "project_evidence_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_evidence" ADD CONSTRAINT "project_evidence_milestone_id_fkey" FOREIGN KEY ("milestone_id") REFERENCES "project_milestones"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_evidence" ADD CONSTRAINT "project_evidence_stored_file_id_fkey" FOREIGN KEY ("stored_file_id") REFERENCES "stored_files"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_evidence" ADD CONSTRAINT "project_evidence_uploaded_by_id_fkey" FOREIGN KEY ("uploaded_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_evidence" ADD CONSTRAINT "project_evidence_verified_by_id_fkey" FOREIGN KEY ("verified_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ============================================================================
-- Hand-written: tenant isolation, privileges, append-only logs, integrity guards.
-- ============================================================================

-- Tenant isolation (RLS keyed on app.tenant_id) on every new tenant-owned table.
SELECT ngao_enable_tenant_rls('tenant_modules');
SELECT ngao_enable_tenant_rls('institutions');
SELECT ngao_enable_tenant_rls('correspondence');
SELECT ngao_enable_tenant_rls('correspondence_attachments');
SELECT ngao_enable_tenant_rls('appointments');
SELECT ngao_enable_tenant_rls('meetings');
SELECT ngao_enable_tenant_rls('meeting_action_items');
SELECT ngao_enable_tenant_rls('meeting_decisions');
SELECT ngao_enable_tenant_rls('citizen_cases');
SELECT ngao_enable_tenant_rls('citizen_case_contacts');
SELECT ngao_enable_tenant_rls('case_events');
SELECT ngao_enable_tenant_rls('case_referrals');
SELECT ngao_enable_tenant_rls('projects');
SELECT ngao_enable_tenant_rls('project_milestones');
SELECT ngao_enable_tenant_rls('project_evidence');

-- Runtime role privileges (default privileges already grant these; stated explicitly).
GRANT SELECT, INSERT, UPDATE ON
  tenant_modules, institutions, correspondence, appointments, meetings, meeting_action_items,
  citizen_cases, citizen_case_contacts, case_referrals, projects, project_milestones, project_evidence
  TO ngao_app;
GRANT SELECT, INSERT ON correspondence_attachments, meeting_decisions, case_events TO ngao_app;

-- Office records are never deleted (status changes, erasure of contact fields and
-- soft deactivation only).
REVOKE DELETE, TRUNCATE ON
  tenant_modules, institutions, correspondence, appointments, meetings, meeting_action_items,
  citizen_cases, citizen_case_contacts, case_referrals, projects, project_milestones, project_evidence
  FROM ngao_app;
DO $$
DECLARE
  tbl text;
BEGIN
  FOREACH tbl IN ARRAY ARRAY[
    'tenant_modules', 'institutions', 'correspondence', 'appointments', 'meetings', 'meeting_action_items',
    'citizen_cases', 'citizen_case_contacts', 'case_referrals', 'projects', 'project_milestones', 'project_evidence'
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

-- Append-only history: case timeline, meeting decision log, correspondence attachments.
REVOKE UPDATE, DELETE, TRUNCATE ON case_events, meeting_decisions, correspondence_attachments FROM ngao_app;
DO $$
DECLARE
  tbl text;
BEGIN
  FOREACH tbl IN ARRAY ARRAY['case_events', 'meeting_decisions', 'correspondence_attachments']
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

-- ---------------------------------------------------------------------------
-- Integrity constraints
-- ---------------------------------------------------------------------------
ALTER TABLE tenant_modules
  ADD CONSTRAINT tenant_modules_key_check CHECK (module_key IN ('tally', 'office'));

ALTER TABLE correspondence
  ADD CONSTRAINT correspondence_direction_status_check CHECK (
    (direction = 'INCOMING' AND status IN ('RECEIVED', 'ASSIGNED', 'IN_PROGRESS', 'RESPONDED', 'FILED', 'ARCHIVED'))
    OR (direction = 'OUTGOING' AND status IN ('DRAFT', 'SENT', 'FILED', 'ARCHIVED'))
  );

ALTER TABLE citizen_cases
  ADD CONSTRAINT citizen_cases_closed_check CHECK (
    status <> 'CLOSED' OR (closure_reason IS NOT NULL AND closed_by_id IS NOT NULL AND closed_at IS NOT NULL)
  ),
  ADD CONSTRAINT citizen_cases_resolution_check CHECK (
    status NOT IN ('RESOLUTION_PROPOSED', 'CITIZEN_FEEDBACK')
    OR (resolution_summary IS NOT NULL AND resolution_proposed_by_id IS NOT NULL)
  ),
  ADD CONSTRAINT citizen_cases_portal_creator_check CHECK (source = 'PORTAL' OR created_by_id IS NOT NULL);

ALTER TABLE citizen_case_contacts
  ADD CONSTRAINT citizen_case_contacts_erased_check CHECK (
    erased_at IS NULL OR (name IS NULL AND phone IS NULL AND email IS NULL)
  );

ALTER TABLE case_events
  ADD CONSTRAINT case_events_actor_check CHECK (actor_type <> 'STAFF' OR actor_id IS NOT NULL),
  -- Internal notes and contact attempts are never requester-visible.
  ADD CONSTRAINT case_events_note_visibility_check CHECK (
    type NOT IN ('NOTE', 'CONTACT_ATTEMPT') OR visibility = 'INTERNAL'
  );

ALTER TABLE projects
  ADD CONSTRAINT projects_coordinates_check CHECK ((latitude IS NULL) = (longitude IS NULL)),
  ADD CONSTRAINT projects_amounts_check CHECK (
    (approved_allocation IS NULL OR approved_allocation >= 0)
    AND (contract_amount IS NULL OR contract_amount >= 0)
    AND (expenditure_reported IS NULL OR expenditure_reported >= 0)
  ),
  -- Verified completion needs a recorded verifier who is not the person who reported completion.
  ADD CONSTRAINT projects_verified_completion_check CHECK (
    status <> 'VERIFIED_COMPLETED'
    OR (completion_verified_by_id IS NOT NULL AND completion_verified_at IS NOT NULL
        AND completion_reported_by_id IS NOT NULL
        AND completion_verified_by_id <> completion_reported_by_id)
  ),
  ADD CONSTRAINT projects_publication_check CHECK (NOT is_public OR (published_by_id IS NOT NULL AND published_at IS NOT NULL)),
  ADD CONSTRAINT projects_public_fields_check CHECK (
    public_fields <@ ARRAY['description', 'implementingAgency', 'projectOwner', 'fundingSource', 'approvedAllocation',
                           'contractAmount', 'expenditure', 'schedule', 'milestones', 'evidence', 'mapLocation']::text[]
  ),
  -- A contract amount can be published only when it is a matter of public record.
  ADD CONSTRAINT projects_contract_amount_public_check CHECK (
    contract_amount_is_public OR NOT ('contractAmount' = ANY (public_fields))
  ),
  ADD CONSTRAINT projects_expenditure_verifier_check CHECK (
    expenditure_verification_status NOT IN ('VERIFIED', 'DISPUTED') OR expenditure_verified_by_id IS NOT NULL
  );

ALTER TABLE project_milestones
  ADD CONSTRAINT project_milestones_verifier_check CHECK (
    verification_status NOT IN ('VERIFIED', 'DISPUTED') OR verified_by_id IS NOT NULL
  );

ALTER TABLE project_evidence
  ADD CONSTRAINT project_evidence_coordinates_check CHECK ((latitude IS NULL) = (longitude IS NULL)),
  -- Nobody verifies evidence they uploaded.
  ADD CONSTRAINT project_evidence_verifier_check CHECK (
    (verification_status NOT IN ('VERIFIED', 'DISPUTED') OR verified_by_id IS NOT NULL)
    AND (verified_by_id IS NULL OR verified_by_id <> uploaded_by_id)
  ),
  -- Only verified evidence may be shown publicly.
  ADD CONSTRAINT project_evidence_public_check CHECK (NOT is_public OR verification_status = 'VERIFIED');

-- ---------------------------------------------------------------------------
-- Guards: immutable identity of citizen cases and project evidence.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION ngao_citizen_cases_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
     OR NEW.reference IS DISTINCT FROM OLD.reference
     OR NEW.public_reference IS DISTINCT FROM OLD.public_reference
     OR NEW.source IS DISTINCT FROM OLD.source
     OR NEW.description IS DISTINCT FROM OLD.description
     OR NEW.privacy_notice_version IS DISTINCT FROM OLD.privacy_notice_version
     OR NEW.submitted_at IS DISTINCT FROM OLD.submitted_at
     OR NEW.created_by_id IS DISTINCT FROM OLD.created_by_id
     OR (OLD.tracking_code_hash IS NOT NULL AND NEW.tracking_code_hash IS DISTINCT FROM OLD.tracking_code_hash) THEN
    RAISE EXCEPTION 'IMMUTABLE_RECORD: the submitted content and references of a citizen case cannot change'
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER citizen_cases_guard BEFORE UPDATE ON citizen_cases
  FOR EACH ROW EXECUTE FUNCTION ngao_citizen_cases_guard();

CREATE OR REPLACE FUNCTION ngao_project_evidence_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
     OR NEW.project_id IS DISTINCT FROM OLD.project_id
     OR NEW.milestone_id IS DISTINCT FROM OLD.milestone_id
     OR NEW.type IS DISTINCT FROM OLD.type
     OR NEW.description IS DISTINCT FROM OLD.description
     OR NEW.captured_on IS DISTINCT FROM OLD.captured_on
     OR NEW.source_description IS DISTINCT FROM OLD.source_description
     OR NEW.stored_file_id IS DISTINCT FROM OLD.stored_file_id
     OR NEW.uploaded_by_id IS DISTINCT FROM OLD.uploaded_by_id
     OR NEW.uploaded_at IS DISTINCT FROM OLD.uploaded_at
     OR NEW.latitude IS DISTINCT FROM OLD.latitude
     OR NEW.longitude IS DISTINCT FROM OLD.longitude THEN
    RAISE EXCEPTION 'IMMUTABLE_RECORD: project evidence can only change its verification and publication fields'
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER project_evidence_guard BEFORE UPDATE ON project_evidence
  FOR EACH ROW EXECUTE FUNCTION ngao_project_evidence_guard();

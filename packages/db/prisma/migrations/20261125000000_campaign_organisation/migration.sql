-- Campaign and organisation (blueprint 5.1–5.4, 10.1–10.3, 14, 15.3, 15.4).
-- Tenant module 'campaign'. Departments and teams, tasks, events and logistics,
-- the communications content workflow, the finance ledger with configurable
-- limits, report templates and the export log, the notification centre
-- (extends `notifications`) and the breach register.
--
-- Generated part (Prisma) first, then: RLS on every new table, runtime-role
-- privileges, no-delete and append-only triggers, immutability guards,
-- separation-of-duties checks and partial unique indexes.

-- CreateEnum
CREATE TYPE "DepartmentVisibility" AS ENUM ('ORGANISATION', 'DEPARTMENT', 'RESTRICTED');

-- CreateEnum
CREATE TYPE "TeamStatus" AS ENUM ('ACTIVE', 'PAUSED', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "TeamContactChannel" AS ENUM ('IN_APP', 'EMAIL', 'PHONE', 'MESSAGING_GROUP', 'OTHER');

-- CreateEnum
CREATE TYPE "TeamMemberRole" AS ENUM ('COORDINATOR', 'MEMBER', 'VOLUNTEER');

-- CreateEnum
CREATE TYPE "TaskStatus" AS ENUM ('DRAFT', 'READY', 'IN_PROGRESS', 'BLOCKED', 'SUBMITTED_FOR_REVIEW', 'COMPLETED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "TaskPriority" AS ENUM ('LOW', 'NORMAL', 'HIGH', 'URGENT');

-- CreateEnum
CREATE TYPE "TaskSourceType" AS ENUM ('DASHBOARD', 'PROJECT', 'EVENT', 'INCIDENT', 'CASE');

-- CreateEnum
CREATE TYPE "TaskEventType" AS ENUM ('CREATED', 'UPDATED', 'ASSIGNED', 'COLLABORATORS_CHANGED', 'REVIEWER_CHANGED', 'STATUS_CHANGED', 'DEPENDENCY_ADDED', 'DEPENDENCY_REMOVED', 'CHECKLIST_UPDATED', 'COMMENTED', 'ATTACHMENT_ADDED', 'EVIDENCE_ADDED', 'REVIEW_APPROVED', 'REVIEW_RETURNED');

-- CreateEnum
CREATE TYPE "TaskAttachmentKind" AS ENUM ('ATTACHMENT', 'COMPLETION_EVIDENCE');

-- CreateEnum
CREATE TYPE "CampaignEventType" AS ENUM ('MEETING', 'TOWN_HALL', 'PUBLIC_RALLY', 'TRAINING', 'PRESS_BRIEFING', 'FUNDRAISER', 'COMMUNITY_SERVICE', 'INTERNAL', 'OTHER');

-- CreateEnum
CREATE TYPE "CampaignEventStatus" AS ENUM ('DRAFT', 'PLANNED', 'CONFIRMED', 'IN_PROGRESS', 'COMPLETED', 'POSTPONED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "CampaignEventVisibility" AS ENUM ('INTERNAL', 'INVITED_TEAMS', 'PUBLIC');

-- CreateEnum
CREATE TYPE "LogisticsItemType" AS ENUM ('VEHICLE', 'EQUIPMENT', 'VENUE_SERVICE', 'MATERIALS', 'CATERING', 'OTHER');

-- CreateEnum
CREATE TYPE "LogisticsStatus" AS ENUM ('REQUESTED', 'CONFIRMED', 'COLLECTED', 'RETURNED', 'DAMAGED', 'LOST', 'CANCELLED');

-- CreateEnum
CREATE TYPE "CheckInMethod" AS ENUM ('MANUAL', 'QR_CODE', 'SIGN_IN_SHEET', 'SELF_CHECK_IN');

-- CreateEnum
CREATE TYPE "AttendanceRole" AS ENUM ('ORGANISER', 'STAFF', 'VOLUNTEER', 'SPEAKER', 'GUEST', 'PARTICIPANT', 'MEDIA');

-- CreateEnum
CREATE TYPE "EventDocumentKind" AS ENUM ('AGENDA', 'PERMIT', 'BRIEFING', 'PHOTO', 'AFTER_ACTION_EVIDENCE', 'OTHER');

-- CreateEnum
CREATE TYPE "AfterActionStatus" AS ENUM ('DRAFT', 'SUBMITTED', 'APPROVED', 'RETURNED');

-- CreateEnum
CREATE TYPE "ContentType" AS ENUM ('NOTICE', 'PRESS_RELEASE', 'BULLETIN', 'WEBSITE_UPDATE', 'EVENT_INFO');

-- CreateEnum
CREATE TYPE "ContentAudience" AS ENUM ('INTERNAL_ALL', 'INTERNAL_DEPARTMENT', 'MEDIA', 'PUBLIC_WEBSITE', 'PUBLIC_NOTICE', 'PARTNERS');

-- CreateEnum
CREATE TYPE "ContentStatus" AS ENUM ('DRAFT', 'EDITORIAL_REVIEW', 'AWAITING_APPROVAL', 'APPROVED', 'PUBLISHED', 'ARCHIVED', 'WITHDRAWN');

-- CreateEnum
CREATE TYPE "ContentRevisionKind" AS ENUM ('CREATED', 'EDITED', 'SUBMITTED_FOR_REVIEW', 'RETURNED', 'EDITORIAL_APPROVED', 'APPROVED', 'PUBLISHED', 'CORRECTED', 'ARCHIVED', 'WITHDRAWN');

-- CreateEnum
CREATE TYPE "FinanceAccountType" AS ENUM ('BANK', 'MOBILE_MONEY', 'CASH', 'OTHER');

-- CreateEnum
CREATE TYPE "FinanceAccountStatus" AS ENUM ('ACTIVE', 'CLOSED');

-- CreateEnum
CREATE TYPE "FinanceCategoryKind" AS ENUM ('INCOME', 'EXPENSE', 'TRANSFER');

-- CreateEnum
CREATE TYPE "FinancePayeeKind" AS ENUM ('SUPPLIER', 'INDIVIDUAL', 'ORGANISATION', 'STAFF', 'OTHER');

-- CreateEnum
CREATE TYPE "ContributionSourceKind" AS ENUM ('INDIVIDUAL', 'ORGANISATION', 'POLITICAL_PARTY', 'OWN_FUNDS', 'OTHER');

-- CreateEnum
CREATE TYPE "FinanceTransactionType" AS ENUM ('CONTRIBUTION', 'EXPENSE', 'TRANSFER', 'REFUND', 'REVERSAL');

-- CreateEnum
CREATE TYPE "FinanceTransactionStatus" AS ENUM ('DRAFT', 'REQUESTED', 'APPROVED', 'PAID', 'REJECTED', 'CANCELLED', 'REVERSED');

-- CreateEnum
CREATE TYPE "FinanceDocumentKind" AS ENUM ('INVOICE', 'RECEIPT', 'CONTRACT', 'BANK_SLIP', 'MOBILE_MONEY_STATEMENT', 'APPROVAL_MEMO', 'DECLARATION', 'OTHER');

-- CreateEnum
CREATE TYPE "FinanceTransactionEventType" AS ENUM ('CREATED', 'UPDATED', 'DOCUMENT_ADDED', 'REQUESTED', 'APPROVED', 'REJECTED', 'PAID', 'CANCELLED', 'REVERSED', 'COMPLIANCE_EVALUATED');

-- CreateEnum
CREATE TYPE "BudgetLineStatus" AS ENUM ('DRAFT', 'APPROVED', 'CLOSED');

-- CreateEnum
CREATE TYPE "FinanceLimitKind" AS ENUM ('SINGLE_SOURCE_CAP_PCT', 'SPENDING_LIMIT', 'REPORTING_DEADLINE');

-- CreateEnum
CREATE TYPE "FinanceCapBasis" AS ENUM ('TOTAL_CONTRIBUTIONS', 'SPENDING_LIMIT');

-- CreateEnum
CREATE TYPE "LimitEnforcement" AS ENUM ('WARN', 'BLOCK');

-- CreateEnum
CREATE TYPE "ReportTemplateScope" AS ENUM ('PRIVATE', 'ROLES', 'ORGANISATION');

-- CreateEnum
CREATE TYPE "NotificationSeverity" AS ENUM ('INFO', 'WARNING', 'CRITICAL');

-- CreateEnum
CREATE TYPE "NotificationDeliveryStatus" AS ENUM ('QUEUED', 'SENT', 'FAILED', 'SKIPPED');

-- CreateEnum
CREATE TYPE "NotificationAckAction" AS ENUM ('ACKNOWLEDGED', 'ESCALATED', 'CLOSED');

-- CreateEnum
CREATE TYPE "BreachStatus" AS ENUM ('DETECTED', 'CONTAINED', 'EVIDENCE_PRESERVED', 'ASSESSED', 'NOTIFIED', 'REMEDIATED', 'CLOSED');

-- CreateEnum
CREATE TYPE "BreachSeverity" AS ENUM ('LOW', 'MEDIUM', 'HIGH', 'CRITICAL');

-- CreateEnum
CREATE TYPE "BreachEventType" AS ENUM ('DETECTED', 'CONTAINED', 'EVIDENCE_PRESERVED', 'ASSESSED', 'CONTROLLER_NOTIFIED', 'REGULATOR_NOTIFIED', 'SUBJECTS_NOTIFIED', 'NOTIFICATION_NOT_REQUIRED', 'REMEDIATED', 'LESSONS_RECORDED', 'CLOSED', 'REOPENED', 'NOTE');

-- AlterEnum
ALTER TYPE "NotificationChannel" ADD VALUE 'PUSH';

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "StoredFilePurpose" ADD VALUE 'TASK_ATTACHMENT';
ALTER TYPE "StoredFilePurpose" ADD VALUE 'EVENT_DOCUMENT';
ALTER TYPE "StoredFilePurpose" ADD VALUE 'FINANCE_DOCUMENT';
ALTER TYPE "StoredFilePurpose" ADD VALUE 'BREACH_EVIDENCE';

-- AlterTable
ALTER TABLE "notifications" ADD COLUMN     "acknowledged_at" TIMESTAMPTZ(3),
ADD COLUMN     "entity_id" TEXT,
ADD COLUMN     "entity_type" TEXT,
ADD COLUMN     "requires_ack" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "severity" "NotificationSeverity" NOT NULL DEFAULT 'INFO';

-- CreateTable
CREATE TABLE "departments" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "lead_user_id" UUID,
    "parent_id" UUID,
    "path" TEXT NOT NULL,
    "depth" INTEGER NOT NULL DEFAULT 0,
    "budget_code" TEXT,
    "active_from" DATE,
    "active_to" DATE,
    "visibility" "DepartmentVisibility" NOT NULL DEFAULT 'ORGANISATION',
    "created_by_id" UUID NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "departments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "teams" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "department_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "coordinator_user_id" UUID,
    "geographic_unit_id" UUID,
    "contact_channel" "TeamContactChannel" NOT NULL DEFAULT 'IN_APP',
    "contact_detail" TEXT,
    "status" "TeamStatus" NOT NULL DEFAULT 'ACTIVE',
    "created_by_id" UUID NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "teams_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "team_members" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "team_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "role" "TeamMemberRole" NOT NULL DEFAULT 'MEMBER',
    "joined_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "left_at" TIMESTAMPTZ(3),
    "added_by_id" UUID NOT NULL,
    "removed_by_id" UUID,

    CONSTRAINT "team_members_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tasks" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "reference" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "acceptance_criteria" TEXT,
    "owner_id" UUID NOT NULL,
    "reviewer_id" UUID,
    "created_by_id" UUID NOT NULL,
    "priority" "TaskPriority" NOT NULL DEFAULT 'NORMAL',
    "status" "TaskStatus" NOT NULL DEFAULT 'DRAFT',
    "start_at" TIMESTAMPTZ(3),
    "due_at" TIMESTAMPTZ(3),
    "department_id" UUID,
    "team_id" UUID,
    "geographic_unit_id" UUID,
    "source_type" "TaskSourceType",
    "source_id" UUID,
    "source_label" TEXT,
    "completed_at" TIMESTAMPTZ(3),
    "cancelled_at" TIMESTAMPTZ(3),
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "tasks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "task_collaborators" (
    "tenant_id" UUID NOT NULL,
    "task_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "added_by_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "task_collaborators_pkey" PRIMARY KEY ("task_id","user_id")
);

-- CreateTable
CREATE TABLE "task_dependencies" (
    "tenant_id" UUID NOT NULL,
    "task_id" UUID NOT NULL,
    "depends_on_task_id" UUID NOT NULL,
    "created_by_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "task_dependencies_pkey" PRIMARY KEY ("task_id","depends_on_task_id")
);

-- CreateTable
CREATE TABLE "task_checklist_items" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "task_id" UUID NOT NULL,
    "label" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "is_done" BOOLEAN NOT NULL DEFAULT false,
    "done_by_id" UUID,
    "done_at" TIMESTAMPTZ(3),
    "removed_at" TIMESTAMPTZ(3),
    "created_by_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "task_checklist_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "task_comments" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "task_id" UUID NOT NULL,
    "author_id" UUID NOT NULL,
    "body" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "task_comments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "task_attachments" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "task_id" UUID NOT NULL,
    "file_id" UUID NOT NULL,
    "kind" "TaskAttachmentKind" NOT NULL DEFAULT 'ATTACHMENT',
    "note" TEXT,
    "added_by_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "task_attachments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "task_events" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "task_id" UUID NOT NULL,
    "type" "TaskEventType" NOT NULL,
    "from_status" "TaskStatus",
    "to_status" "TaskStatus",
    "actor_id" UUID NOT NULL,
    "note" TEXT,
    "data" JSONB,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "task_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "campaign_events" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "reference" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "type" "CampaignEventType" NOT NULL,
    "purpose" TEXT,
    "starts_at" TIMESTAMPTZ(3) NOT NULL,
    "ends_at" TIMESTAMPTZ(3) NOT NULL,
    "venue_name" TEXT,
    "venue_address" TEXT,
    "latitude" DECIMAL(9,6),
    "longitude" DECIMAL(9,6),
    "geographic_unit_id" UUID,
    "organiser_id" UUID NOT NULL,
    "department_id" UUID,
    "budget_minor" BIGINT,
    "currency" CHAR(3) NOT NULL DEFAULT 'KES',
    "visibility" "CampaignEventVisibility" NOT NULL DEFAULT 'INTERNAL',
    "status" "CampaignEventStatus" NOT NULL DEFAULT 'DRAFT',
    "cancellation_reason" TEXT,
    "created_by_id" UUID NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "campaign_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "event_invited_teams" (
    "tenant_id" UUID NOT NULL,
    "event_id" UUID NOT NULL,
    "team_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "event_invited_teams_pkey" PRIMARY KEY ("event_id","team_id")
);

-- CreateTable
CREATE TABLE "event_agenda_items" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "event_id" UUID NOT NULL,
    "position" INTEGER NOT NULL,
    "starts_at" TIMESTAMPTZ(3),
    "duration_minutes" INTEGER,
    "title" TEXT NOT NULL,
    "notes" TEXT,
    "owner_id" UUID,
    "removed_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "event_agenda_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "event_logistics_items" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "event_id" UUID NOT NULL,
    "item_type" "LogisticsItemType" NOT NULL,
    "description" TEXT NOT NULL,
    "asset_reference" TEXT,
    "supplier_name" TEXT,
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "custodian_id" UUID,
    "collection_at" TIMESTAMPTZ(3),
    "return_due_at" TIMESTAMPTZ(3),
    "returned_at" TIMESTAMPTZ(3),
    "status" "LogisticsStatus" NOT NULL DEFAULT 'REQUESTED',
    "damage_notes" TEXT,
    "created_by_id" UUID NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "event_logistics_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "event_attendances" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "event_id" UUID NOT NULL,
    "participant_name" TEXT NOT NULL,
    "participant_user_id" UUID,
    "team_id" UUID,
    "role" "AttendanceRole" NOT NULL DEFAULT 'PARTICIPANT',
    "check_in_method" "CheckInMethod" NOT NULL DEFAULT 'MANUAL',
    "checked_in_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "recorded_by_id" UUID NOT NULL,
    "has_contact" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "event_attendances_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "event_attendance_contacts" (
    "attendance_id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "phone" TEXT,
    "email" TEXT,
    "consent_notice_version" TEXT NOT NULL,
    "purpose" TEXT NOT NULL,
    "consented_at" TIMESTAMPTZ(3) NOT NULL,
    "erased_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "event_attendance_contacts_pkey" PRIMARY KEY ("attendance_id")
);

-- CreateTable
CREATE TABLE "event_documents" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "event_id" UUID NOT NULL,
    "file_id" UUID NOT NULL,
    "kind" "EventDocumentKind" NOT NULL,
    "note" TEXT,
    "added_by_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "event_documents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "event_after_action_reports" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "event_id" UUID NOT NULL,
    "status" "AfterActionStatus" NOT NULL DEFAULT 'DRAFT',
    "what_occurred" TEXT NOT NULL,
    "attendance_total" INTEGER NOT NULL,
    "attendance_breakdown" JSONB NOT NULL DEFAULT '{}',
    "actual_spend_minor" BIGINT,
    "currency" CHAR(3) NOT NULL DEFAULT 'KES',
    "issues" TEXT,
    "lessons" TEXT,
    "author_id" UUID NOT NULL,
    "reviewer_id" UUID,
    "reviewed_at" TIMESTAMPTZ(3),
    "review_note" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "event_after_action_reports_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "content_items" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "reference" TEXT NOT NULL,
    "type" "ContentType" NOT NULL,
    "title" TEXT NOT NULL,
    "summary" TEXT,
    "body" TEXT NOT NULL,
    "audience" "ContentAudience" NOT NULL,
    "department_id" UUID,
    "event_id" UUID,
    "author_id" UUID NOT NULL,
    "editor_id" UUID,
    "approver_id" UUID,
    "approved_at" TIMESTAMPTZ(3),
    "published_at" TIMESTAMPTZ(3),
    "published_by_id" UUID,
    "archived_at" TIMESTAMPTZ(3),
    "withdrawn_at" TIMESTAMPTZ(3),
    "scheduled_for" TIMESTAMPTZ(3),
    "status" "ContentStatus" NOT NULL DEFAULT 'DRAFT',
    "revision" INTEGER NOT NULL DEFAULT 1,
    "correction_count" INTEGER NOT NULL DEFAULT 0,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "content_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "content_revisions" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "content_id" UUID NOT NULL,
    "kind" "ContentRevisionKind" NOT NULL,
    "revision" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "body_sha256" CHAR(64) NOT NULL,
    "from_status" "ContentStatus",
    "to_status" "ContentStatus",
    "note" TEXT,
    "actor_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "content_revisions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "finance_accounts" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "type" "FinanceAccountType" NOT NULL,
    "institution" TEXT,
    "account_number_masked" TEXT,
    "currency" CHAR(3) NOT NULL DEFAULT 'KES',
    "is_dedicated_campaign_account" BOOLEAN NOT NULL DEFAULT false,
    "status" "FinanceAccountStatus" NOT NULL DEFAULT 'ACTIVE',
    "created_by_id" UUID NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "finance_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "finance_categories" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kind" "FinanceCategoryKind" NOT NULL,
    "parent_id" UUID,
    "description" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "finance_categories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "finance_payees" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "kind" "FinancePayeeKind" NOT NULL,
    "tax_pin_masked" TEXT,
    "tax_pin_hash" TEXT,
    "phone_masked" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "notes" TEXT,
    "created_by_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "finance_payees_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "contribution_sources" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "display_name" TEXT NOT NULL,
    "kind" "ContributionSourceKind" NOT NULL,
    "identifier_masked" TEXT,
    "identifier_hash" TEXT,
    "declared" BOOLEAN NOT NULL DEFAULT false,
    "declared_at" TIMESTAMPTZ(3),
    "notes" TEXT,
    "created_by_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "contribution_sources_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "finance_budget_lines" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "department_id" UUID,
    "event_id" UUID,
    "category_id" UUID,
    "election_cycle_id" UUID,
    "amount_minor" BIGINT NOT NULL,
    "currency" CHAR(3) NOT NULL DEFAULT 'KES',
    "period_start" DATE,
    "period_end" DATE,
    "status" "BudgetLineStatus" NOT NULL DEFAULT 'DRAFT',
    "approved_by_id" UUID,
    "approved_at" TIMESTAMPTZ(3),
    "created_by_id" UUID NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "finance_budget_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "finance_transactions" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "reference" TEXT NOT NULL,
    "type" "FinanceTransactionType" NOT NULL,
    "status" "FinanceTransactionStatus" NOT NULL DEFAULT 'DRAFT',
    "account_id" UUID NOT NULL,
    "counter_account_id" UUID,
    "category_id" UUID NOT NULL,
    "budget_line_id" UUID,
    "amount_minor" BIGINT NOT NULL,
    "currency" CHAR(3) NOT NULL DEFAULT 'KES',
    "transaction_date" DATE NOT NULL,
    "payee_id" UUID,
    "contribution_source_id" UUID,
    "external_reference" TEXT,
    "description" TEXT NOT NULL,
    "department_id" UUID,
    "event_id" UUID,
    "election_cycle_id" UUID,
    "requested_by_id" UUID NOT NULL,
    "requested_at" TIMESTAMPTZ(3),
    "approved_by_id" UUID,
    "approved_at" TIMESTAMPTZ(3),
    "rejected_by_id" UUID,
    "rejected_at" TIMESTAMPTZ(3),
    "rejection_reason" TEXT,
    "paid_by_id" UUID,
    "paid_at" TIMESTAMPTZ(3),
    "payment_reference" TEXT,
    "cancelled_at" TIMESTAMPTZ(3),
    "cancellation_reason" TEXT,
    "reverses_id" UUID,
    "reversed_at" TIMESTAMPTZ(3),
    "compliance_flags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "compliance_evaluated_at" TIMESTAMPTZ(3),
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "finance_transactions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "finance_transaction_documents" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "transaction_id" UUID NOT NULL,
    "file_id" UUID NOT NULL,
    "kind" "FinanceDocumentKind" NOT NULL,
    "note" TEXT,
    "added_by_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "finance_transaction_documents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "finance_transaction_events" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "transaction_id" UUID NOT NULL,
    "type" "FinanceTransactionEventType" NOT NULL,
    "from_status" "FinanceTransactionStatus",
    "to_status" "FinanceTransactionStatus",
    "actor_id" UUID NOT NULL,
    "note" TEXT,
    "data" JSONB,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "finance_transaction_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "finance_limit_settings" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "kind" "FinanceLimitKind" NOT NULL,
    "label" TEXT NOT NULL,
    "value_basis_points" INTEGER,
    "cap_basis" "FinanceCapBasis",
    "value_minor" BIGINT,
    "currency" CHAR(3),
    "deadline_date" DATE,
    "election_cycle_id" UUID,
    "period_label" TEXT NOT NULL,
    "office_type" "OfficeType",
    "effective_from" DATE NOT NULL,
    "effective_to" DATE,
    "legal_source_note" TEXT NOT NULL,
    "verified" BOOLEAN NOT NULL DEFAULT false,
    "verified_by_id" UUID,
    "verified_at" TIMESTAMPTZ(3),
    "enforcement" "LimitEnforcement" NOT NULL DEFAULT 'WARN',
    "supersedes_id" UUID,
    "created_by_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "finance_limit_settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "report_templates" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "dataset_key" TEXT NOT NULL,
    "definition" JSONB NOT NULL,
    "owner_id" UUID NOT NULL,
    "permission_scope" "ReportTemplateScope" NOT NULL DEFAULT 'PRIVATE',
    "shared_role_keys" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "classification" "SensitivityLevel" NOT NULL DEFAULT 'INTERNAL',
    "standard_report_key" TEXT,
    "archived_at" TIMESTAMPTZ(3),
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "report_templates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "report_exports" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "template_id" UUID,
    "dataset_key" TEXT NOT NULL,
    "format" "ExportFormat" NOT NULL,
    "fields" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "definition" JSONB NOT NULL,
    "filters_description" TEXT NOT NULL,
    "applied_scope" TEXT NOT NULL,
    "classification" "SensitivityLevel" NOT NULL,
    "sensitive" BOOLEAN NOT NULL DEFAULT false,
    "row_count" INTEGER NOT NULL,
    "file_id" UUID,
    "sha256" CHAR(64),
    "reason" TEXT,
    "reauth_at" TIMESTAMPTZ(3),
    "generated_by_id" UUID NOT NULL,
    "generated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "report_exports_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notification_preferences" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "channel" "NotificationChannel" NOT NULL,
    "type" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "notification_preferences_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notification_deliveries" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "notification_id" UUID NOT NULL,
    "channel" "NotificationChannel" NOT NULL,
    "provider" TEXT NOT NULL,
    "status" "NotificationDeliveryStatus" NOT NULL,
    "attempt" INTEGER NOT NULL DEFAULT 1,
    "error" TEXT,
    "provider_message_id" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notification_deliveries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notification_acknowledgements" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "notification_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "action" "NotificationAckAction" NOT NULL,
    "note" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notification_acknowledgements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "breach_records" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "reference" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "is_drill" BOOLEAN NOT NULL DEFAULT false,
    "status" "BreachStatus" NOT NULL DEFAULT 'DETECTED',
    "severity" "BreachSeverity" NOT NULL,
    "detected_at" TIMESTAMPTZ(3) NOT NULL,
    "data_categories" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "estimated_subjects" INTEGER,
    "systems_affected" TEXT,
    "containment_summary" TEXT,
    "risk_assessment" TEXT,
    "notification_decision" TEXT,
    "controller_notified_at" TIMESTAMPTZ(3),
    "regulator_notified_at" TIMESTAMPTZ(3),
    "subjects_notified_at" TIMESTAMPTZ(3),
    "remediation_summary" TEXT,
    "lessons_learned" TEXT,
    "owner_id" UUID,
    "reported_by_id" UUID NOT NULL,
    "closed_by_id" UUID,
    "closed_at" TIMESTAMPTZ(3),
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "breach_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "breach_events" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "breach_id" UUID NOT NULL,
    "type" "BreachEventType" NOT NULL,
    "from_status" "BreachStatus",
    "to_status" "BreachStatus",
    "note" TEXT NOT NULL,
    "occurred_at" TIMESTAMPTZ(3) NOT NULL,
    "actor_id" UUID NOT NULL,
    "evidence_file_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "breach_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "departments_tenant_id_parent_id_idx" ON "departments"("tenant_id", "parent_id");

-- CreateIndex
CREATE INDEX "departments_tenant_id_lead_user_id_idx" ON "departments"("tenant_id", "lead_user_id");

-- CreateIndex
CREATE UNIQUE INDEX "departments_tenant_id_code_key" ON "departments"("tenant_id", "code");

-- CreateIndex
CREATE INDEX "teams_tenant_id_coordinator_user_id_idx" ON "teams"("tenant_id", "coordinator_user_id");

-- CreateIndex
CREATE INDEX "teams_tenant_id_geographic_unit_id_idx" ON "teams"("tenant_id", "geographic_unit_id");

-- CreateIndex
CREATE UNIQUE INDEX "teams_tenant_id_department_id_name_key" ON "teams"("tenant_id", "department_id", "name");

-- CreateIndex
CREATE INDEX "team_members_tenant_id_user_id_idx" ON "team_members"("tenant_id", "user_id");

-- CreateIndex
CREATE INDEX "team_members_tenant_id_team_id_idx" ON "team_members"("tenant_id", "team_id");

-- CreateIndex
CREATE INDEX "tasks_tenant_id_status_idx" ON "tasks"("tenant_id", "status");

-- CreateIndex
CREATE INDEX "tasks_tenant_id_owner_id_status_idx" ON "tasks"("tenant_id", "owner_id", "status");

-- CreateIndex
CREATE INDEX "tasks_tenant_id_reviewer_id_status_idx" ON "tasks"("tenant_id", "reviewer_id", "status");

-- CreateIndex
CREATE INDEX "tasks_tenant_id_department_id_idx" ON "tasks"("tenant_id", "department_id");

-- CreateIndex
CREATE INDEX "tasks_tenant_id_due_at_idx" ON "tasks"("tenant_id", "due_at");

-- CreateIndex
CREATE INDEX "tasks_tenant_id_source_type_source_id_idx" ON "tasks"("tenant_id", "source_type", "source_id");

-- CreateIndex
CREATE UNIQUE INDEX "tasks_tenant_id_reference_key" ON "tasks"("tenant_id", "reference");

-- CreateIndex
CREATE INDEX "task_collaborators_tenant_id_user_id_idx" ON "task_collaborators"("tenant_id", "user_id");

-- CreateIndex
CREATE INDEX "task_dependencies_tenant_id_depends_on_task_id_idx" ON "task_dependencies"("tenant_id", "depends_on_task_id");

-- CreateIndex
CREATE INDEX "task_checklist_items_tenant_id_task_id_idx" ON "task_checklist_items"("tenant_id", "task_id");

-- CreateIndex
CREATE INDEX "task_comments_tenant_id_task_id_created_at_idx" ON "task_comments"("tenant_id", "task_id", "created_at");

-- CreateIndex
CREATE INDEX "task_attachments_tenant_id_task_id_idx" ON "task_attachments"("tenant_id", "task_id");

-- CreateIndex
CREATE INDEX "task_events_tenant_id_task_id_created_at_idx" ON "task_events"("tenant_id", "task_id", "created_at");

-- CreateIndex
CREATE INDEX "campaign_events_tenant_id_starts_at_idx" ON "campaign_events"("tenant_id", "starts_at");

-- CreateIndex
CREATE INDEX "campaign_events_tenant_id_status_idx" ON "campaign_events"("tenant_id", "status");

-- CreateIndex
CREATE INDEX "campaign_events_tenant_id_department_id_idx" ON "campaign_events"("tenant_id", "department_id");

-- CreateIndex
CREATE UNIQUE INDEX "campaign_events_tenant_id_reference_key" ON "campaign_events"("tenant_id", "reference");

-- CreateIndex
CREATE INDEX "event_invited_teams_tenant_id_team_id_idx" ON "event_invited_teams"("tenant_id", "team_id");

-- CreateIndex
CREATE INDEX "event_agenda_items_tenant_id_event_id_idx" ON "event_agenda_items"("tenant_id", "event_id");

-- CreateIndex
CREATE INDEX "event_logistics_items_tenant_id_event_id_idx" ON "event_logistics_items"("tenant_id", "event_id");

-- CreateIndex
CREATE INDEX "event_logistics_items_tenant_id_custodian_id_idx" ON "event_logistics_items"("tenant_id", "custodian_id");

-- CreateIndex
CREATE INDEX "event_attendances_tenant_id_event_id_idx" ON "event_attendances"("tenant_id", "event_id");

-- CreateIndex
CREATE INDEX "event_documents_tenant_id_event_id_idx" ON "event_documents"("tenant_id", "event_id");

-- CreateIndex
CREATE UNIQUE INDEX "event_after_action_reports_event_id_key" ON "event_after_action_reports"("event_id");

-- CreateIndex
CREATE INDEX "event_after_action_reports_tenant_id_status_idx" ON "event_after_action_reports"("tenant_id", "status");

-- CreateIndex
CREATE INDEX "content_items_tenant_id_status_idx" ON "content_items"("tenant_id", "status");

-- CreateIndex
CREATE INDEX "content_items_tenant_id_author_id_idx" ON "content_items"("tenant_id", "author_id");

-- CreateIndex
CREATE UNIQUE INDEX "content_items_tenant_id_reference_key" ON "content_items"("tenant_id", "reference");

-- CreateIndex
CREATE INDEX "content_revisions_tenant_id_content_id_created_at_idx" ON "content_revisions"("tenant_id", "content_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "finance_accounts_tenant_id_name_key" ON "finance_accounts"("tenant_id", "name");

-- CreateIndex
CREATE UNIQUE INDEX "finance_categories_tenant_id_code_key" ON "finance_categories"("tenant_id", "code");

-- CreateIndex
CREATE INDEX "finance_payees_tenant_id_name_idx" ON "finance_payees"("tenant_id", "name");

-- CreateIndex
CREATE UNIQUE INDEX "finance_payees_tenant_id_tax_pin_hash_key" ON "finance_payees"("tenant_id", "tax_pin_hash");

-- CreateIndex
CREATE INDEX "contribution_sources_tenant_id_display_name_idx" ON "contribution_sources"("tenant_id", "display_name");

-- CreateIndex
CREATE UNIQUE INDEX "contribution_sources_tenant_id_identifier_hash_key" ON "contribution_sources"("tenant_id", "identifier_hash");

-- CreateIndex
CREATE INDEX "finance_budget_lines_tenant_id_department_id_idx" ON "finance_budget_lines"("tenant_id", "department_id");

-- CreateIndex
CREATE INDEX "finance_budget_lines_tenant_id_event_id_idx" ON "finance_budget_lines"("tenant_id", "event_id");

-- CreateIndex
CREATE UNIQUE INDEX "finance_budget_lines_tenant_id_code_key" ON "finance_budget_lines"("tenant_id", "code");

-- CreateIndex
CREATE UNIQUE INDEX "finance_transactions_reverses_id_key" ON "finance_transactions"("reverses_id");

-- CreateIndex
CREATE INDEX "finance_transactions_tenant_id_status_idx" ON "finance_transactions"("tenant_id", "status");

-- CreateIndex
CREATE INDEX "finance_transactions_tenant_id_type_transaction_date_idx" ON "finance_transactions"("tenant_id", "type", "transaction_date");

-- CreateIndex
CREATE INDEX "finance_transactions_tenant_id_account_id_idx" ON "finance_transactions"("tenant_id", "account_id");

-- CreateIndex
CREATE INDEX "finance_transactions_tenant_id_contribution_source_id_idx" ON "finance_transactions"("tenant_id", "contribution_source_id");

-- CreateIndex
CREATE INDEX "finance_transactions_tenant_id_budget_line_id_idx" ON "finance_transactions"("tenant_id", "budget_line_id");

-- CreateIndex
CREATE UNIQUE INDEX "finance_transactions_tenant_id_reference_key" ON "finance_transactions"("tenant_id", "reference");

-- CreateIndex
CREATE INDEX "finance_transaction_documents_tenant_id_transaction_id_idx" ON "finance_transaction_documents"("tenant_id", "transaction_id");

-- CreateIndex
CREATE INDEX "finance_transaction_events_tenant_id_transaction_id_created_idx" ON "finance_transaction_events"("tenant_id", "transaction_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "finance_limit_settings_supersedes_id_key" ON "finance_limit_settings"("supersedes_id");

-- CreateIndex
CREATE INDEX "finance_limit_settings_tenant_id_kind_effective_from_idx" ON "finance_limit_settings"("tenant_id", "kind", "effective_from");

-- CreateIndex
CREATE INDEX "report_templates_tenant_id_owner_id_idx" ON "report_templates"("tenant_id", "owner_id");

-- CreateIndex
CREATE INDEX "report_templates_tenant_id_dataset_key_idx" ON "report_templates"("tenant_id", "dataset_key");

-- CreateIndex
CREATE INDEX "report_exports_tenant_id_generated_at_idx" ON "report_exports"("tenant_id", "generated_at");

-- CreateIndex
CREATE INDEX "report_exports_tenant_id_generated_by_id_idx" ON "report_exports"("tenant_id", "generated_by_id");

-- CreateIndex
CREATE UNIQUE INDEX "notification_preferences_tenant_id_user_id_channel_type_key" ON "notification_preferences"("tenant_id", "user_id", "channel", "type");

-- CreateIndex
CREATE INDEX "notification_deliveries_tenant_id_notification_id_idx" ON "notification_deliveries"("tenant_id", "notification_id");

-- CreateIndex
CREATE INDEX "notification_deliveries_tenant_id_status_created_at_idx" ON "notification_deliveries"("tenant_id", "status", "created_at");

-- CreateIndex
CREATE INDEX "notification_acknowledgements_tenant_id_notification_id_idx" ON "notification_acknowledgements"("tenant_id", "notification_id");

-- CreateIndex
CREATE INDEX "breach_records_tenant_id_status_idx" ON "breach_records"("tenant_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "breach_records_tenant_id_reference_key" ON "breach_records"("tenant_id", "reference");

-- CreateIndex
CREATE INDEX "breach_events_tenant_id_breach_id_occurred_at_idx" ON "breach_events"("tenant_id", "breach_id", "occurred_at");

-- AddForeignKey
ALTER TABLE "departments" ADD CONSTRAINT "departments_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "departments" ADD CONSTRAINT "departments_lead_user_id_fkey" FOREIGN KEY ("lead_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "departments" ADD CONSTRAINT "departments_parent_id_fkey" FOREIGN KEY ("parent_id") REFERENCES "departments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "departments" ADD CONSTRAINT "departments_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "teams" ADD CONSTRAINT "teams_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "teams" ADD CONSTRAINT "teams_department_id_fkey" FOREIGN KEY ("department_id") REFERENCES "departments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "teams" ADD CONSTRAINT "teams_coordinator_user_id_fkey" FOREIGN KEY ("coordinator_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "teams" ADD CONSTRAINT "teams_geographic_unit_id_fkey" FOREIGN KEY ("geographic_unit_id") REFERENCES "geographic_units"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "teams" ADD CONSTRAINT "teams_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "team_members" ADD CONSTRAINT "team_members_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "team_members" ADD CONSTRAINT "team_members_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "team_members" ADD CONSTRAINT "team_members_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "team_members" ADD CONSTRAINT "team_members_added_by_id_fkey" FOREIGN KEY ("added_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "team_members" ADD CONSTRAINT "team_members_removed_by_id_fkey" FOREIGN KEY ("removed_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_reviewer_id_fkey" FOREIGN KEY ("reviewer_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_department_id_fkey" FOREIGN KEY ("department_id") REFERENCES "departments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_geographic_unit_id_fkey" FOREIGN KEY ("geographic_unit_id") REFERENCES "geographic_units"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "task_collaborators" ADD CONSTRAINT "task_collaborators_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "task_collaborators" ADD CONSTRAINT "task_collaborators_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "tasks"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "task_collaborators" ADD CONSTRAINT "task_collaborators_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "task_collaborators" ADD CONSTRAINT "task_collaborators_added_by_id_fkey" FOREIGN KEY ("added_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "task_dependencies" ADD CONSTRAINT "task_dependencies_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "task_dependencies" ADD CONSTRAINT "task_dependencies_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "tasks"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "task_dependencies" ADD CONSTRAINT "task_dependencies_depends_on_task_id_fkey" FOREIGN KEY ("depends_on_task_id") REFERENCES "tasks"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "task_dependencies" ADD CONSTRAINT "task_dependencies_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "task_checklist_items" ADD CONSTRAINT "task_checklist_items_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "task_checklist_items" ADD CONSTRAINT "task_checklist_items_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "tasks"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "task_checklist_items" ADD CONSTRAINT "task_checklist_items_done_by_id_fkey" FOREIGN KEY ("done_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "task_checklist_items" ADD CONSTRAINT "task_checklist_items_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "task_comments" ADD CONSTRAINT "task_comments_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "task_comments" ADD CONSTRAINT "task_comments_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "tasks"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "task_comments" ADD CONSTRAINT "task_comments_author_id_fkey" FOREIGN KEY ("author_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "task_attachments" ADD CONSTRAINT "task_attachments_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "task_attachments" ADD CONSTRAINT "task_attachments_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "tasks"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "task_attachments" ADD CONSTRAINT "task_attachments_file_id_fkey" FOREIGN KEY ("file_id") REFERENCES "stored_files"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "task_attachments" ADD CONSTRAINT "task_attachments_added_by_id_fkey" FOREIGN KEY ("added_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "task_events" ADD CONSTRAINT "task_events_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "task_events" ADD CONSTRAINT "task_events_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "tasks"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "task_events" ADD CONSTRAINT "task_events_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "campaign_events" ADD CONSTRAINT "campaign_events_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "campaign_events" ADD CONSTRAINT "campaign_events_organiser_id_fkey" FOREIGN KEY ("organiser_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "campaign_events" ADD CONSTRAINT "campaign_events_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "campaign_events" ADD CONSTRAINT "campaign_events_department_id_fkey" FOREIGN KEY ("department_id") REFERENCES "departments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "campaign_events" ADD CONSTRAINT "campaign_events_geographic_unit_id_fkey" FOREIGN KEY ("geographic_unit_id") REFERENCES "geographic_units"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "event_invited_teams" ADD CONSTRAINT "event_invited_teams_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "event_invited_teams" ADD CONSTRAINT "event_invited_teams_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "campaign_events"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "event_invited_teams" ADD CONSTRAINT "event_invited_teams_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "event_agenda_items" ADD CONSTRAINT "event_agenda_items_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "event_agenda_items" ADD CONSTRAINT "event_agenda_items_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "campaign_events"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "event_agenda_items" ADD CONSTRAINT "event_agenda_items_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "event_logistics_items" ADD CONSTRAINT "event_logistics_items_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "event_logistics_items" ADD CONSTRAINT "event_logistics_items_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "campaign_events"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "event_logistics_items" ADD CONSTRAINT "event_logistics_items_custodian_id_fkey" FOREIGN KEY ("custodian_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "event_logistics_items" ADD CONSTRAINT "event_logistics_items_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "event_attendances" ADD CONSTRAINT "event_attendances_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "event_attendances" ADD CONSTRAINT "event_attendances_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "campaign_events"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "event_attendances" ADD CONSTRAINT "event_attendances_participant_user_id_fkey" FOREIGN KEY ("participant_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "event_attendances" ADD CONSTRAINT "event_attendances_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "event_attendances" ADD CONSTRAINT "event_attendances_recorded_by_id_fkey" FOREIGN KEY ("recorded_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "event_attendance_contacts" ADD CONSTRAINT "event_attendance_contacts_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "event_attendance_contacts" ADD CONSTRAINT "event_attendance_contacts_attendance_id_fkey" FOREIGN KEY ("attendance_id") REFERENCES "event_attendances"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "event_documents" ADD CONSTRAINT "event_documents_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "event_documents" ADD CONSTRAINT "event_documents_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "campaign_events"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "event_documents" ADD CONSTRAINT "event_documents_file_id_fkey" FOREIGN KEY ("file_id") REFERENCES "stored_files"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "event_documents" ADD CONSTRAINT "event_documents_added_by_id_fkey" FOREIGN KEY ("added_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "event_after_action_reports" ADD CONSTRAINT "event_after_action_reports_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "event_after_action_reports" ADD CONSTRAINT "event_after_action_reports_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "campaign_events"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "event_after_action_reports" ADD CONSTRAINT "event_after_action_reports_author_id_fkey" FOREIGN KEY ("author_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "event_after_action_reports" ADD CONSTRAINT "event_after_action_reports_reviewer_id_fkey" FOREIGN KEY ("reviewer_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "content_items" ADD CONSTRAINT "content_items_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "content_items" ADD CONSTRAINT "content_items_department_id_fkey" FOREIGN KEY ("department_id") REFERENCES "departments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "content_items" ADD CONSTRAINT "content_items_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "campaign_events"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "content_items" ADD CONSTRAINT "content_items_author_id_fkey" FOREIGN KEY ("author_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "content_items" ADD CONSTRAINT "content_items_editor_id_fkey" FOREIGN KEY ("editor_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "content_items" ADD CONSTRAINT "content_items_approver_id_fkey" FOREIGN KEY ("approver_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "content_items" ADD CONSTRAINT "content_items_published_by_id_fkey" FOREIGN KEY ("published_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "content_revisions" ADD CONSTRAINT "content_revisions_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "content_revisions" ADD CONSTRAINT "content_revisions_content_id_fkey" FOREIGN KEY ("content_id") REFERENCES "content_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "content_revisions" ADD CONSTRAINT "content_revisions_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "finance_accounts" ADD CONSTRAINT "finance_accounts_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "finance_accounts" ADD CONSTRAINT "finance_accounts_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "finance_categories" ADD CONSTRAINT "finance_categories_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "finance_categories" ADD CONSTRAINT "finance_categories_parent_id_fkey" FOREIGN KEY ("parent_id") REFERENCES "finance_categories"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "finance_payees" ADD CONSTRAINT "finance_payees_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "finance_payees" ADD CONSTRAINT "finance_payees_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contribution_sources" ADD CONSTRAINT "contribution_sources_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contribution_sources" ADD CONSTRAINT "contribution_sources_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "finance_budget_lines" ADD CONSTRAINT "finance_budget_lines_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "finance_budget_lines" ADD CONSTRAINT "finance_budget_lines_department_id_fkey" FOREIGN KEY ("department_id") REFERENCES "departments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "finance_budget_lines" ADD CONSTRAINT "finance_budget_lines_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "campaign_events"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "finance_budget_lines" ADD CONSTRAINT "finance_budget_lines_category_id_fkey" FOREIGN KEY ("category_id") REFERENCES "finance_categories"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "finance_budget_lines" ADD CONSTRAINT "finance_budget_lines_election_cycle_id_fkey" FOREIGN KEY ("election_cycle_id") REFERENCES "election_cycles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "finance_budget_lines" ADD CONSTRAINT "finance_budget_lines_approved_by_id_fkey" FOREIGN KEY ("approved_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "finance_budget_lines" ADD CONSTRAINT "finance_budget_lines_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "finance_transactions" ADD CONSTRAINT "finance_transactions_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "finance_transactions" ADD CONSTRAINT "finance_transactions_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "finance_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "finance_transactions" ADD CONSTRAINT "finance_transactions_counter_account_id_fkey" FOREIGN KEY ("counter_account_id") REFERENCES "finance_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "finance_transactions" ADD CONSTRAINT "finance_transactions_category_id_fkey" FOREIGN KEY ("category_id") REFERENCES "finance_categories"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "finance_transactions" ADD CONSTRAINT "finance_transactions_budget_line_id_fkey" FOREIGN KEY ("budget_line_id") REFERENCES "finance_budget_lines"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "finance_transactions" ADD CONSTRAINT "finance_transactions_payee_id_fkey" FOREIGN KEY ("payee_id") REFERENCES "finance_payees"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "finance_transactions" ADD CONSTRAINT "finance_transactions_contribution_source_id_fkey" FOREIGN KEY ("contribution_source_id") REFERENCES "contribution_sources"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "finance_transactions" ADD CONSTRAINT "finance_transactions_department_id_fkey" FOREIGN KEY ("department_id") REFERENCES "departments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "finance_transactions" ADD CONSTRAINT "finance_transactions_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "campaign_events"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "finance_transactions" ADD CONSTRAINT "finance_transactions_election_cycle_id_fkey" FOREIGN KEY ("election_cycle_id") REFERENCES "election_cycles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "finance_transactions" ADD CONSTRAINT "finance_transactions_requested_by_id_fkey" FOREIGN KEY ("requested_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "finance_transactions" ADD CONSTRAINT "finance_transactions_approved_by_id_fkey" FOREIGN KEY ("approved_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "finance_transactions" ADD CONSTRAINT "finance_transactions_rejected_by_id_fkey" FOREIGN KEY ("rejected_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "finance_transactions" ADD CONSTRAINT "finance_transactions_paid_by_id_fkey" FOREIGN KEY ("paid_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "finance_transactions" ADD CONSTRAINT "finance_transactions_reverses_id_fkey" FOREIGN KEY ("reverses_id") REFERENCES "finance_transactions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "finance_transaction_documents" ADD CONSTRAINT "finance_transaction_documents_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "finance_transaction_documents" ADD CONSTRAINT "finance_transaction_documents_transaction_id_fkey" FOREIGN KEY ("transaction_id") REFERENCES "finance_transactions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "finance_transaction_documents" ADD CONSTRAINT "finance_transaction_documents_file_id_fkey" FOREIGN KEY ("file_id") REFERENCES "stored_files"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "finance_transaction_documents" ADD CONSTRAINT "finance_transaction_documents_added_by_id_fkey" FOREIGN KEY ("added_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "finance_transaction_events" ADD CONSTRAINT "finance_transaction_events_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "finance_transaction_events" ADD CONSTRAINT "finance_transaction_events_transaction_id_fkey" FOREIGN KEY ("transaction_id") REFERENCES "finance_transactions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "finance_transaction_events" ADD CONSTRAINT "finance_transaction_events_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "finance_limit_settings" ADD CONSTRAINT "finance_limit_settings_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "finance_limit_settings" ADD CONSTRAINT "finance_limit_settings_election_cycle_id_fkey" FOREIGN KEY ("election_cycle_id") REFERENCES "election_cycles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "finance_limit_settings" ADD CONSTRAINT "finance_limit_settings_verified_by_id_fkey" FOREIGN KEY ("verified_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "finance_limit_settings" ADD CONSTRAINT "finance_limit_settings_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "finance_limit_settings" ADD CONSTRAINT "finance_limit_settings_supersedes_id_fkey" FOREIGN KEY ("supersedes_id") REFERENCES "finance_limit_settings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "report_templates" ADD CONSTRAINT "report_templates_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "report_templates" ADD CONSTRAINT "report_templates_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "report_exports" ADD CONSTRAINT "report_exports_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "report_exports" ADD CONSTRAINT "report_exports_template_id_fkey" FOREIGN KEY ("template_id") REFERENCES "report_templates"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "report_exports" ADD CONSTRAINT "report_exports_file_id_fkey" FOREIGN KEY ("file_id") REFERENCES "stored_files"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "report_exports" ADD CONSTRAINT "report_exports_generated_by_id_fkey" FOREIGN KEY ("generated_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notification_preferences" ADD CONSTRAINT "notification_preferences_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notification_preferences" ADD CONSTRAINT "notification_preferences_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notification_deliveries" ADD CONSTRAINT "notification_deliveries_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notification_deliveries" ADD CONSTRAINT "notification_deliveries_notification_id_fkey" FOREIGN KEY ("notification_id") REFERENCES "notifications"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notification_acknowledgements" ADD CONSTRAINT "notification_acknowledgements_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notification_acknowledgements" ADD CONSTRAINT "notification_acknowledgements_notification_id_fkey" FOREIGN KEY ("notification_id") REFERENCES "notifications"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notification_acknowledgements" ADD CONSTRAINT "notification_acknowledgements_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "breach_records" ADD CONSTRAINT "breach_records_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "breach_records" ADD CONSTRAINT "breach_records_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "breach_records" ADD CONSTRAINT "breach_records_reported_by_id_fkey" FOREIGN KEY ("reported_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "breach_records" ADD CONSTRAINT "breach_records_closed_by_id_fkey" FOREIGN KEY ("closed_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "breach_events" ADD CONSTRAINT "breach_events_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "breach_events" ADD CONSTRAINT "breach_events_breach_id_fkey" FOREIGN KEY ("breach_id") REFERENCES "breach_records"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "breach_events" ADD CONSTRAINT "breach_events_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "breach_events" ADD CONSTRAINT "breach_events_evidence_file_id_fkey" FOREIGN KEY ("evidence_file_id") REFERENCES "stored_files"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ===========================================================================
-- Module key
-- ===========================================================================
ALTER TABLE tenant_modules DROP CONSTRAINT IF EXISTS tenant_modules_key_check;
ALTER TABLE tenant_modules
  ADD CONSTRAINT tenant_modules_key_check CHECK (module_key IN ('tally', 'office', 'field', 'campaign'));

-- ===========================================================================
-- Tenant isolation (RLS) on every new tenant-owned table.
-- ===========================================================================
SELECT ngao_enable_tenant_rls('departments');
SELECT ngao_enable_tenant_rls('teams');
SELECT ngao_enable_tenant_rls('team_members');
SELECT ngao_enable_tenant_rls('tasks');
SELECT ngao_enable_tenant_rls('task_collaborators');
SELECT ngao_enable_tenant_rls('task_dependencies');
SELECT ngao_enable_tenant_rls('task_checklist_items');
SELECT ngao_enable_tenant_rls('task_comments');
SELECT ngao_enable_tenant_rls('task_attachments');
SELECT ngao_enable_tenant_rls('task_events');
SELECT ngao_enable_tenant_rls('campaign_events');
SELECT ngao_enable_tenant_rls('event_invited_teams');
SELECT ngao_enable_tenant_rls('event_agenda_items');
SELECT ngao_enable_tenant_rls('event_logistics_items');
SELECT ngao_enable_tenant_rls('event_attendances');
SELECT ngao_enable_tenant_rls('event_attendance_contacts');
SELECT ngao_enable_tenant_rls('event_documents');
SELECT ngao_enable_tenant_rls('event_after_action_reports');
SELECT ngao_enable_tenant_rls('content_items');
SELECT ngao_enable_tenant_rls('content_revisions');
SELECT ngao_enable_tenant_rls('finance_accounts');
SELECT ngao_enable_tenant_rls('finance_categories');
SELECT ngao_enable_tenant_rls('finance_payees');
SELECT ngao_enable_tenant_rls('contribution_sources');
SELECT ngao_enable_tenant_rls('finance_budget_lines');
SELECT ngao_enable_tenant_rls('finance_transactions');
SELECT ngao_enable_tenant_rls('finance_transaction_documents');
SELECT ngao_enable_tenant_rls('finance_transaction_events');
SELECT ngao_enable_tenant_rls('finance_limit_settings');
SELECT ngao_enable_tenant_rls('report_templates');
SELECT ngao_enable_tenant_rls('report_exports');
SELECT ngao_enable_tenant_rls('notification_preferences');
SELECT ngao_enable_tenant_rls('notification_deliveries');
SELECT ngao_enable_tenant_rls('notification_acknowledgements');
SELECT ngao_enable_tenant_rls('breach_records');
SELECT ngao_enable_tenant_rls('breach_events');

-- ===========================================================================
-- Runtime role privileges.
--   mutable records:   SELECT, INSERT, UPDATE        (never deleted)
--   link rows:         SELECT, INSERT, DELETE        (membership of a set; changes are on the timeline)
--   append-only:       SELECT, INSERT
-- ===========================================================================
REVOKE ALL ON
  departments, teams, team_members, tasks, task_checklist_items, campaign_events,
  event_agenda_items, event_logistics_items, event_attendances, event_attendance_contacts,
  event_after_action_reports, content_items, finance_accounts, finance_categories, finance_payees,
  contribution_sources, finance_budget_lines, finance_transactions, finance_limit_settings,
  report_templates, notification_preferences, breach_records,
  task_collaborators, task_dependencies, event_invited_teams,
  task_comments, task_attachments, task_events, event_documents, content_revisions,
  finance_transaction_documents, finance_transaction_events, report_exports,
  notification_deliveries, notification_acknowledgements, breach_events
  FROM ngao_app;
GRANT SELECT, INSERT, UPDATE ON
  departments, teams, team_members, tasks, task_checklist_items, campaign_events,
  event_agenda_items, event_logistics_items, event_attendances, event_attendance_contacts,
  event_after_action_reports, content_items, finance_accounts, finance_categories, finance_payees,
  contribution_sources, finance_budget_lines, finance_transactions, finance_limit_settings,
  report_templates, notification_preferences, breach_records
  TO ngao_app;
GRANT SELECT, INSERT, DELETE ON task_collaborators, task_dependencies, event_invited_teams TO ngao_app;
GRANT SELECT, INSERT ON
  task_comments, task_attachments, task_events, event_documents, content_revisions,
  finance_transaction_documents, finance_transaction_events, report_exports,
  notification_deliveries, notification_acknowledgements, breach_events
  TO ngao_app;

-- Mutable records: no DELETE or TRUNCATE (even for the owner role).
DO $$
DECLARE
  tbl text;
BEGIN
  FOREACH tbl IN ARRAY ARRAY[
    'departments', 'teams', 'team_members', 'tasks', 'task_checklist_items', 'campaign_events',
    'event_agenda_items', 'event_logistics_items', 'event_attendances', 'event_attendance_contacts',
    'event_after_action_reports', 'content_items', 'finance_accounts', 'finance_categories',
    'finance_payees', 'contribution_sources', 'finance_budget_lines', 'finance_transactions',
    'finance_limit_settings', 'report_templates', 'notification_preferences', 'breach_records'
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
    'task_comments', 'task_attachments', 'task_events', 'event_documents', 'content_revisions',
    'finance_transaction_documents', 'finance_transaction_events', 'report_exports',
    'notification_deliveries', 'notification_acknowledgements', 'breach_events'
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

-- Link rows: no UPDATE (remove and re-add instead) and no TRUNCATE.
DO $$
DECLARE
  tbl text;
BEGIN
  FOREACH tbl IN ARRAY ARRAY['task_collaborators', 'task_dependencies', 'event_invited_teams']
  LOOP
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION ngao_reject_modification()',
      tbl || '_no_update', tbl
    );
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE TRUNCATE ON %I FOR EACH STATEMENT EXECUTE FUNCTION ngao_reject_modification()',
      tbl || '_no_truncate', tbl
    );
  END LOOP;
END
$$;

-- ===========================================================================
-- Checks and partial unique indexes
-- ===========================================================================
ALTER TABLE departments
  ADD CONSTRAINT departments_active_range_check CHECK (active_to IS NULL OR active_from IS NULL OR active_to >= active_from),
  ADD CONSTRAINT departments_not_own_parent_check CHECK (parent_id IS NULL OR parent_id <> id);

CREATE UNIQUE INDEX team_members_active_key ON team_members (tenant_id, team_id, user_id) WHERE left_at IS NULL;

ALTER TABLE tasks
  ADD CONSTRAINT tasks_reviewer_not_owner_check CHECK (reviewer_id IS NULL OR reviewer_id <> owner_id),
  ADD CONSTRAINT tasks_due_after_start_check CHECK (due_at IS NULL OR start_at IS NULL OR due_at >= start_at),
  ADD CONSTRAINT tasks_source_check CHECK (source_id IS NULL OR source_type IS NOT NULL);

ALTER TABLE task_dependencies
  ADD CONSTRAINT task_dependencies_not_self_check CHECK (task_id <> depends_on_task_id);

ALTER TABLE campaign_events
  ADD CONSTRAINT campaign_events_time_check CHECK (ends_at >= starts_at),
  ADD CONSTRAINT campaign_events_budget_check CHECK (budget_minor IS NULL OR budget_minor >= 0),
  ADD CONSTRAINT campaign_events_currency_check CHECK (currency ~ '^[A-Z]{3}$'),
  ADD CONSTRAINT campaign_events_coordinates_check CHECK ((latitude IS NULL) = (longitude IS NULL));

ALTER TABLE event_logistics_items
  ADD CONSTRAINT event_logistics_items_quantity_check CHECK (quantity > 0),
  ADD CONSTRAINT event_logistics_items_damage_check CHECK (status NOT IN ('DAMAGED', 'LOST') OR damage_notes IS NOT NULL);

ALTER TABLE event_attendance_contacts
  ADD CONSTRAINT event_attendance_contacts_value_check CHECK (erased_at IS NOT NULL OR phone IS NOT NULL OR email IS NOT NULL);

ALTER TABLE event_after_action_reports
  ADD CONSTRAINT event_after_action_reviewer_check CHECK (reviewer_id IS NULL OR reviewer_id <> author_id),
  ADD CONSTRAINT event_after_action_approved_check CHECK (status <> 'APPROVED' OR (reviewer_id IS NOT NULL AND reviewed_at IS NOT NULL)),
  ADD CONSTRAINT event_after_action_amounts_check CHECK (attendance_total >= 0 AND (actual_spend_minor IS NULL OR actual_spend_minor >= 0)),
  ADD CONSTRAINT event_after_action_currency_check CHECK (currency ~ '^[A-Z]{3}$');

ALTER TABLE content_items
  ADD CONSTRAINT content_items_approver_not_author_check CHECK (approver_id IS NULL OR approver_id <> author_id),
  ADD CONSTRAINT content_items_published_check CHECK (status NOT IN ('PUBLISHED', 'ARCHIVED', 'WITHDRAWN') OR (approver_id IS NOT NULL AND published_at IS NOT NULL));

ALTER TABLE finance_accounts
  ADD CONSTRAINT finance_accounts_currency_check CHECK (currency ~ '^[A-Z]{3}$');

ALTER TABLE finance_budget_lines
  ADD CONSTRAINT finance_budget_lines_owner_check CHECK (department_id IS NOT NULL OR event_id IS NOT NULL),
  ADD CONSTRAINT finance_budget_lines_amount_check CHECK (amount_minor >= 0),
  ADD CONSTRAINT finance_budget_lines_currency_check CHECK (currency ~ '^[A-Z]{3}$'),
  ADD CONSTRAINT finance_budget_lines_approver_check CHECK (approved_by_id IS NULL OR approved_by_id <> created_by_id),
  ADD CONSTRAINT finance_budget_lines_period_check CHECK (period_end IS NULL OR period_start IS NULL OR period_end >= period_start);

-- Ledger entries: positive integer minor units, ISO currency, counterparty per type,
-- requester ≠ approver, requester ≠ payer, requester ≠ rejecter, reversal link per type.
ALTER TABLE finance_transactions
  ADD CONSTRAINT finance_transactions_amount_check CHECK (amount_minor > 0),
  ADD CONSTRAINT finance_transactions_currency_check CHECK (currency ~ '^[A-Z]{3}$'),
  ADD CONSTRAINT finance_transactions_approver_check CHECK (approved_by_id IS NULL OR approved_by_id <> requested_by_id),
  ADD CONSTRAINT finance_transactions_payer_check CHECK (paid_by_id IS NULL OR paid_by_id <> requested_by_id),
  ADD CONSTRAINT finance_transactions_rejecter_check CHECK (rejected_by_id IS NULL OR rejected_by_id <> requested_by_id),
  ADD CONSTRAINT finance_transactions_reversal_check CHECK ((type = 'REVERSAL') = (reverses_id IS NOT NULL) AND (reverses_id IS NULL OR reverses_id <> id)),
  ADD CONSTRAINT finance_transactions_counterparty_check CHECK (
    (type = 'CONTRIBUTION' AND contribution_source_id IS NOT NULL AND payee_id IS NULL)
    OR (type IN ('EXPENSE', 'REFUND') AND payee_id IS NOT NULL AND contribution_source_id IS NULL)
    OR (type = 'TRANSFER' AND counter_account_id IS NOT NULL AND counter_account_id <> account_id)
    OR type = 'REVERSAL'
  ),
  ADD CONSTRAINT finance_transactions_approved_check CHECK (status NOT IN ('APPROVED', 'PAID', 'REVERSED') OR (approved_by_id IS NOT NULL AND approved_at IS NOT NULL)),
  ADD CONSTRAINT finance_transactions_paid_check CHECK (status <> 'PAID' OR (paid_by_id IS NOT NULL AND paid_at IS NOT NULL AND payment_reference IS NOT NULL));

ALTER TABLE finance_limit_settings
  ADD CONSTRAINT finance_limit_settings_kind_check CHECK (
    (kind = 'SINGLE_SOURCE_CAP_PCT' AND value_basis_points BETWEEN 1 AND 10000 AND cap_basis IS NOT NULL AND value_minor IS NULL AND deadline_date IS NULL)
    OR (kind = 'SPENDING_LIMIT' AND value_minor IS NOT NULL AND value_minor >= 0 AND currency IS NOT NULL AND value_basis_points IS NULL AND deadline_date IS NULL)
    OR (kind = 'REPORTING_DEADLINE' AND deadline_date IS NOT NULL AND value_minor IS NULL AND value_basis_points IS NULL)
  ),
  ADD CONSTRAINT finance_limit_settings_source_check CHECK (length(btrim(legal_source_note)) >= 10),
  ADD CONSTRAINT finance_limit_settings_effective_check CHECK (effective_to IS NULL OR effective_to >= effective_from),
  ADD CONSTRAINT finance_limit_settings_currency_check CHECK (currency IS NULL OR currency ~ '^[A-Z]{3}$'),
  ADD CONSTRAINT finance_limit_settings_verified_check CHECK (NOT verified OR (verified_by_id IS NOT NULL AND verified_at IS NOT NULL));

ALTER TABLE breach_records
  ADD CONSTRAINT breach_records_closer_check CHECK (closed_by_id IS NULL OR closed_by_id <> reported_by_id),
  ADD CONSTRAINT breach_records_closed_check CHECK (status <> 'CLOSED' OR (closed_by_id IS NOT NULL AND closed_at IS NOT NULL AND lessons_learned IS NOT NULL)),
  ADD CONSTRAINT breach_records_subjects_check CHECK (estimated_subjects IS NULL OR estimated_subjects >= 0);

-- ===========================================================================
-- Immutability guards
-- ===========================================================================

-- Team membership: identity fixed; leaving is recorded once.
CREATE OR REPLACE FUNCTION ngao_team_members_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
     OR NEW.team_id IS DISTINCT FROM OLD.team_id
     OR NEW.user_id IS DISTINCT FROM OLD.user_id
     OR NEW.joined_at IS DISTINCT FROM OLD.joined_at
     OR NEW.added_by_id IS DISTINCT FROM OLD.added_by_id
     OR (OLD.left_at IS NOT NULL AND (NEW.left_at IS DISTINCT FROM OLD.left_at OR NEW.removed_by_id IS DISTINCT FROM OLD.removed_by_id OR NEW.role IS DISTINCT FROM OLD.role)) THEN
    RAISE EXCEPTION 'IMMUTABLE_RECORD: team membership history cannot change; add the member again instead'
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER team_members_guard BEFORE UPDATE ON team_members
  FOR EACH ROW EXECUTE FUNCTION ngao_team_members_guard();

-- Tasks: reference and creator fixed; COMPLETED and CANCELLED are final.
CREATE OR REPLACE FUNCTION ngao_tasks_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
     OR NEW.reference IS DISTINCT FROM OLD.reference
     OR NEW.created_by_id IS DISTINCT FROM OLD.created_by_id
     OR NEW.source_type IS DISTINCT FROM OLD.source_type
     OR NEW.source_id IS DISTINCT FROM OLD.source_id
     OR (OLD.status IN ('COMPLETED', 'CANCELLED') AND (
          NEW.status IS DISTINCT FROM OLD.status
          OR NEW.title IS DISTINCT FROM OLD.title
          OR NEW.owner_id IS DISTINCT FROM OLD.owner_id
          OR NEW.reviewer_id IS DISTINCT FROM OLD.reviewer_id
          OR NEW.completed_at IS DISTINCT FROM OLD.completed_at
          OR NEW.cancelled_at IS DISTINCT FROM OLD.cancelled_at)) THEN
    RAISE EXCEPTION 'IMMUTABLE_RECORD: a completed or cancelled task cannot change; create a follow-up task'
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER tasks_guard BEFORE UPDATE ON tasks
  FOR EACH ROW EXECUTE FUNCTION ngao_tasks_guard();

-- Events: reference and creator fixed; COMPLETED and CANCELLED keep their status.
CREATE OR REPLACE FUNCTION ngao_campaign_events_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
     OR NEW.reference IS DISTINCT FROM OLD.reference
     OR NEW.created_by_id IS DISTINCT FROM OLD.created_by_id
     OR (OLD.status IN ('COMPLETED', 'CANCELLED') AND NEW.status IS DISTINCT FROM OLD.status) THEN
    RAISE EXCEPTION 'IMMUTABLE_RECORD: a completed or cancelled event keeps its status'
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER campaign_events_guard BEFORE UPDATE ON campaign_events
  FOR EACH ROW EXECUTE FUNCTION ngao_campaign_events_guard();

-- Attendance contact: values can only be erased (set to NULL with erased_at), never replaced.
CREATE OR REPLACE FUNCTION ngao_event_attendance_contacts_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
     OR NEW.consent_notice_version IS DISTINCT FROM OLD.consent_notice_version
     OR NEW.purpose IS DISTINCT FROM OLD.purpose
     OR NEW.consented_at IS DISTINCT FROM OLD.consented_at
     OR (NEW.phone IS DISTINCT FROM OLD.phone AND NEW.phone IS NOT NULL)
     OR (NEW.email IS DISTINCT FROM OLD.email AND NEW.email IS NOT NULL)
     OR (OLD.erased_at IS NOT NULL AND NEW.erased_at IS DISTINCT FROM OLD.erased_at) THEN
    RAISE EXCEPTION 'IMMUTABLE_RECORD: consent-based contact details can only be erased'
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER event_attendance_contacts_guard BEFORE UPDATE ON event_attendance_contacts
  FOR EACH ROW EXECUTE FUNCTION ngao_event_attendance_contacts_guard();

-- After-action report: frozen once APPROVED.
CREATE OR REPLACE FUNCTION ngao_event_after_action_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
     OR NEW.event_id IS DISTINCT FROM OLD.event_id
     OR NEW.author_id IS DISTINCT FROM OLD.author_id
     OR (OLD.status = 'APPROVED' AND ROW(NEW.*) IS DISTINCT FROM ROW(OLD.*)) THEN
    RAISE EXCEPTION 'IMMUTABLE_RECORD: an approved after-action report cannot change'
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER event_after_action_guard BEFORE UPDATE ON event_after_action_reports
  FOR EACH ROW EXECUTE FUNCTION ngao_event_after_action_guard();

-- Content: identity fixed; published text changes only with a new revision (correction);
-- ARCHIVED and WITHDRAWN are final; publication time is set once.
CREATE OR REPLACE FUNCTION ngao_content_items_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
     OR NEW.reference IS DISTINCT FROM OLD.reference
     OR NEW.type IS DISTINCT FROM OLD.type
     OR NEW.author_id IS DISTINCT FROM OLD.author_id
     OR NEW.revision < OLD.revision
     OR (OLD.published_at IS NOT NULL AND NEW.published_at IS DISTINCT FROM OLD.published_at)
     OR (OLD.status IN ('ARCHIVED', 'WITHDRAWN') AND ROW(NEW.*) IS DISTINCT FROM ROW(OLD.*))
     OR (OLD.status = 'PUBLISHED'
         AND (NEW.title IS DISTINCT FROM OLD.title OR NEW.body IS DISTINCT FROM OLD.body OR NEW.summary IS DISTINCT FROM OLD.summary)
         AND NEW.revision = OLD.revision)
     OR (OLD.status = 'PUBLISHED' AND (NEW.approver_id IS DISTINCT FROM OLD.approver_id OR NEW.audience IS DISTINCT FROM OLD.audience)) THEN
    RAISE EXCEPTION 'IMMUTABLE_RECORD: published content changes only through a recorded correction'
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER content_items_guard BEFORE UPDATE ON content_items
  FOR EACH ROW EXECUTE FUNCTION ngao_content_items_guard();

-- Budget lines: an APPROVED or CLOSED line keeps its amount and owner; CLOSED is final.
CREATE OR REPLACE FUNCTION ngao_finance_budget_lines_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
     OR NEW.created_by_id IS DISTINCT FROM OLD.created_by_id
     OR (OLD.status IN ('APPROVED', 'CLOSED') AND (
          NEW.amount_minor IS DISTINCT FROM OLD.amount_minor
          OR NEW.currency IS DISTINCT FROM OLD.currency
          OR NEW.code IS DISTINCT FROM OLD.code
          OR NEW.department_id IS DISTINCT FROM OLD.department_id
          OR NEW.event_id IS DISTINCT FROM OLD.event_id
          OR NEW.approved_by_id IS DISTINCT FROM OLD.approved_by_id
          OR NEW.approved_at IS DISTINCT FROM OLD.approved_at))
     OR (OLD.status = 'CLOSED' AND NEW.status IS DISTINCT FROM OLD.status) THEN
    RAISE EXCEPTION 'IMMUTABLE_RECORD: an approved budget line cannot change; add a new line'
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER finance_budget_lines_guard BEFORE UPDATE ON finance_budget_lines
  FOR EACH ROW EXECUTE FUNCTION ngao_finance_budget_lines_guard();

-- Ledger entries.
--  * Approval needs a category (NOT NULL), a counterparty (check above), an external
--    reference and at least one supporting document.
--  * From APPROVED on, financial fields are frozen. Allowed moves: APPROVED → PAID,
--    APPROVED / PAID → REVERSED. REJECTED, CANCELLED and REVERSED are final.
--  * Payment details are written once.
CREATE OR REPLACE FUNCTION ngao_finance_transactions_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
     OR NEW.reference IS DISTINCT FROM OLD.reference
     OR NEW.type IS DISTINCT FROM OLD.type
     OR NEW.requested_by_id IS DISTINCT FROM OLD.requested_by_id
     OR NEW.reverses_id IS DISTINCT FROM OLD.reverses_id THEN
    RAISE EXCEPTION 'IMMUTABLE_RECORD: a ledger entry keeps its reference, type, requester and reversal link'
      USING ERRCODE = 'P0001';
  END IF;

  IF OLD.status IN ('APPROVED', 'PAID', 'REVERSED', 'REJECTED', 'CANCELLED') AND (
       NEW.account_id IS DISTINCT FROM OLD.account_id
       OR NEW.counter_account_id IS DISTINCT FROM OLD.counter_account_id
       OR NEW.category_id IS DISTINCT FROM OLD.category_id
       OR NEW.budget_line_id IS DISTINCT FROM OLD.budget_line_id
       OR NEW.amount_minor IS DISTINCT FROM OLD.amount_minor
       OR NEW.currency IS DISTINCT FROM OLD.currency
       OR NEW.transaction_date IS DISTINCT FROM OLD.transaction_date
       OR NEW.payee_id IS DISTINCT FROM OLD.payee_id
       OR NEW.contribution_source_id IS DISTINCT FROM OLD.contribution_source_id
       OR NEW.external_reference IS DISTINCT FROM OLD.external_reference
       OR NEW.description IS DISTINCT FROM OLD.description
       OR NEW.department_id IS DISTINCT FROM OLD.department_id
       OR NEW.event_id IS DISTINCT FROM OLD.event_id
       OR NEW.election_cycle_id IS DISTINCT FROM OLD.election_cycle_id
       OR NEW.requested_at IS DISTINCT FROM OLD.requested_at
       OR NEW.approved_by_id IS DISTINCT FROM OLD.approved_by_id
       OR NEW.approved_at IS DISTINCT FROM OLD.approved_at
       OR NEW.rejected_by_id IS DISTINCT FROM OLD.rejected_by_id
       OR NEW.rejected_at IS DISTINCT FROM OLD.rejected_at
       OR NEW.rejection_reason IS DISTINCT FROM OLD.rejection_reason
       OR NEW.cancelled_at IS DISTINCT FROM OLD.cancelled_at
       OR NEW.compliance_flags IS DISTINCT FROM OLD.compliance_flags
       OR NEW.compliance_evaluated_at IS DISTINCT FROM OLD.compliance_evaluated_at) THEN
    RAISE EXCEPTION 'IMMUTABLE_RECORD: an approved ledger entry cannot change; record a reversing entry'
      USING ERRCODE = 'P0001';
  END IF;

  IF NEW.status IS DISTINCT FROM OLD.status AND OLD.status IN ('APPROVED', 'PAID', 'REVERSED', 'REJECTED', 'CANCELLED')
     AND NOT ((OLD.status = 'APPROVED' AND NEW.status IN ('PAID', 'REVERSED')) OR (OLD.status = 'PAID' AND NEW.status = 'REVERSED')) THEN
    RAISE EXCEPTION 'IMMUTABLE_RECORD: ledger entry status % cannot become %', OLD.status, NEW.status
      USING ERRCODE = 'P0001';
  END IF;

  IF OLD.paid_at IS NOT NULL AND (NEW.paid_at IS DISTINCT FROM OLD.paid_at OR NEW.paid_by_id IS DISTINCT FROM OLD.paid_by_id OR NEW.payment_reference IS DISTINCT FROM OLD.payment_reference) THEN
    RAISE EXCEPTION 'IMMUTABLE_RECORD: payment details are recorded once'
      USING ERRCODE = 'P0001';
  END IF;

  IF OLD.reversed_at IS NOT NULL AND NEW.reversed_at IS DISTINCT FROM OLD.reversed_at THEN
    RAISE EXCEPTION 'IMMUTABLE_RECORD: a reversal is recorded once'
      USING ERRCODE = 'P0001';
  END IF;

  IF NEW.status = 'APPROVED' AND OLD.status IS DISTINCT FROM 'APPROVED' THEN
    IF NEW.external_reference IS NULL OR btrim(NEW.external_reference) = '' THEN
      RAISE EXCEPTION 'APPROVAL_INCOMPLETE: a ledger entry needs a receipt, invoice or payment reference before approval'
        USING ERRCODE = 'P0001';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM finance_transaction_documents d WHERE d.transaction_id = NEW.id) THEN
      RAISE EXCEPTION 'APPROVAL_INCOMPLETE: a ledger entry needs a supporting document before approval'
        USING ERRCODE = 'P0001';
    END IF;
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER finance_transactions_guard BEFORE UPDATE ON finance_transactions
  FOR EACH ROW EXECUTE FUNCTION ngao_finance_transactions_guard();

-- A ledger entry cannot be inserted already approved (approval is a separate, recorded step).
CREATE OR REPLACE FUNCTION ngao_finance_transactions_insert_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status NOT IN ('DRAFT', 'REQUESTED') THEN
    RAISE EXCEPTION 'IMMUTABLE_RECORD: ledger entries start as DRAFT or REQUESTED and are approved separately'
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER finance_transactions_insert_guard BEFORE INSERT ON finance_transactions
  FOR EACH ROW EXECUTE FUNCTION ngao_finance_transactions_insert_guard();

-- Limit settings: versioned. Only the end date and the verification fields may change.
CREATE OR REPLACE FUNCTION ngao_finance_limit_settings_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
     OR NEW.kind IS DISTINCT FROM OLD.kind
     OR NEW.label IS DISTINCT FROM OLD.label
     OR NEW.value_basis_points IS DISTINCT FROM OLD.value_basis_points
     OR NEW.cap_basis IS DISTINCT FROM OLD.cap_basis
     OR NEW.value_minor IS DISTINCT FROM OLD.value_minor
     OR NEW.currency IS DISTINCT FROM OLD.currency
     OR NEW.deadline_date IS DISTINCT FROM OLD.deadline_date
     OR NEW.election_cycle_id IS DISTINCT FROM OLD.election_cycle_id
     OR NEW.period_label IS DISTINCT FROM OLD.period_label
     OR NEW.office_type IS DISTINCT FROM OLD.office_type
     OR NEW.effective_from IS DISTINCT FROM OLD.effective_from
     OR NEW.legal_source_note IS DISTINCT FROM OLD.legal_source_note
     OR NEW.enforcement IS DISTINCT FROM OLD.enforcement
     OR NEW.supersedes_id IS DISTINCT FROM OLD.supersedes_id
     OR NEW.created_by_id IS DISTINCT FROM OLD.created_by_id THEN
    RAISE EXCEPTION 'IMMUTABLE_RECORD: a limit setting is versioned; create a new setting that supersedes it'
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER finance_limit_settings_guard BEFORE UPDATE ON finance_limit_settings
  FOR EACH ROW EXECUTE FUNCTION ngao_finance_limit_settings_guard();

-- Breach records: identity of the report fixed.
CREATE OR REPLACE FUNCTION ngao_breach_records_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
     OR NEW.reference IS DISTINCT FROM OLD.reference
     OR NEW.is_drill IS DISTINCT FROM OLD.is_drill
     OR NEW.detected_at IS DISTINCT FROM OLD.detected_at
     OR NEW.reported_by_id IS DISTINCT FROM OLD.reported_by_id THEN
    RAISE EXCEPTION 'IMMUTABLE_RECORD: a breach record keeps its reference, drill flag, detection time and reporter'
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER breach_records_guard BEFORE UPDATE ON breach_records
  FOR EACH ROW EXECUTE FUNCTION ngao_breach_records_guard();

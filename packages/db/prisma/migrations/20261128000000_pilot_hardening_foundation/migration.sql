-- Pilot hardening foundation (docs/ARCHITECTURE.md §16, docs/API_CONTRACT.md §31–36).
--
-- Prepares four parallel work areas (platform-infra, auth-recovery, workspace-admin, field-pin):
--   1. message_outbox (+ append-only message_outbox_events): durable e-mail / SMS / push delivery
--      with idempotency keys, retries, dead letters and delivery reports. Addresses encrypted with a
--      keyed hash; one-time secrets wiped at a terminal status (CHECK).
--   2. contact_verifications (+ append-only events): verified e-mail / phone and SMS consent with
--      version and opt-out (blueprint 10.3). push_subscriptions (encrypted endpoint and keys).
--   3. job_runs: one row per run of a durable repeatable job; tenant_id NULL for platform runs.
--   4. stored_files scan fields (engine, signature, quarantine) + ERROR status, and the append-only
--      file_scan_events history. INFECTED and quarantine are final (trigger). Fail closed:
--      PENDING and ERROR files are not CLEAN.
--   5. webauthn_credentials, webauthn_challenges, recovery_codes, account_recovery_requests
--      (approver ≠ requester ≠ subject).
--   6. workspace_setup_items (S03 checklist) and tenant_integration_settings (non-secret config
--      only; a check refuses secret-looking keys). Secrets stay in the environment.
--
-- Every new table has tenant_id + RLS (job_runs: tenant rows per tenant, platform rows only without
-- a tenant setting). Nothing is deleted by the runtime role except spent WebAuthn challenges.

-- CreateEnum
CREATE TYPE "MessageChannel" AS ENUM ('EMAIL', 'SMS', 'PUSH');

-- CreateEnum
CREATE TYPE "MessageStatus" AS ENUM ('QUEUED', 'SENDING', 'SENT', 'FAILED', 'SKIPPED', 'DEAD');

-- CreateEnum
CREATE TYPE "MessageDeliveryReportStatus" AS ENUM ('PENDING', 'DELIVERED', 'UNDELIVERED', 'REJECTED', 'EXPIRED', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "ContactChannel" AS ENUM ('EMAIL', 'SMS');

-- CreateEnum
CREATE TYPE "ContactVerificationEventType" AS ENUM ('CODE_SENT', 'VERIFIED', 'VERIFICATION_FAILED', 'CONSENT_GIVEN', 'OPTED_OUT', 'OPTED_IN', 'SUPERSEDED');

-- CreateEnum
CREATE TYPE "JobRunStatus" AS ENUM ('RUNNING', 'SUCCEEDED', 'FAILED', 'SKIPPED');

-- CreateEnum
CREATE TYPE "WebauthnChallengePurpose" AS ENUM ('REGISTER', 'AUTHENTICATE', 'REAUTH');

-- CreateEnum
CREATE TYPE "AccountRecoveryStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'COMPLETED', 'EXPIRED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "WorkspaceSetupItemStatus" AS ENUM ('PENDING', 'DONE', 'SKIPPED');

-- AlterEnum
ALTER TYPE "MalwareScanStatus" ADD VALUE 'ERROR';

-- AlterTable
ALTER TABLE "stored_files" ADD COLUMN     "quarantined_at" TIMESTAMPTZ(3),
ADD COLUMN     "scan_engine" TEXT,
ADD COLUMN     "scan_signature" TEXT;

-- CreateTable
CREATE TABLE "message_outbox" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "channel" "MessageChannel" NOT NULL,
    "template_key" TEXT NOT NULL,
    "recipient_user_id" UUID,
    "recipient_ref_type" TEXT NOT NULL,
    "recipient_ref_id" UUID NOT NULL,
    "address_encrypted" TEXT,
    "address_hash" CHAR(64),
    "address_masked" TEXT,
    "payload" JSONB NOT NULL DEFAULT '{}',
    "secret_payload_encrypted" TEXT,
    "status" "MessageStatus" NOT NULL DEFAULT 'QUEUED',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "max_attempts" INTEGER NOT NULL DEFAULT 5,
    "next_attempt_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "locked_until" TIMESTAMPTZ(3),
    "last_error" TEXT,
    "provider" TEXT,
    "provider_message_id" TEXT,
    "delivery_status" "MessageDeliveryReportStatus",
    "delivery_status_at" TIMESTAMPTZ(3),
    "idempotency_key" TEXT NOT NULL,
    "notification_id" UUID,
    "created_by_id" UUID,
    "sent_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "message_outbox_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "message_outbox_events" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "message_id" UUID NOT NULL,
    "attempt" INTEGER NOT NULL,
    "from_status" "MessageStatus",
    "to_status" "MessageStatus" NOT NULL,
    "provider" TEXT,
    "provider_message_id" TEXT,
    "delivery_status" "MessageDeliveryReportStatus",
    "error" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "message_outbox_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "contact_verifications" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "channel" "ContactChannel" NOT NULL,
    "address_hash" CHAR(64) NOT NULL,
    "address_masked" TEXT NOT NULL,
    "code_hash" CHAR(64),
    "code_expires_at" TIMESTAMPTZ(3),
    "code_attempts" INTEGER NOT NULL DEFAULT 0,
    "verified_at" TIMESTAMPTZ(3),
    "sms_consent_version" TEXT,
    "sms_consent_at" TIMESTAMPTZ(3),
    "sms_opted_out_at" TIMESTAMPTZ(3),
    "sms_opt_out_source" TEXT,
    "superseded_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "contact_verifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "contact_verification_events" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "verification_id" UUID NOT NULL,
    "type" "ContactVerificationEventType" NOT NULL,
    "consent_version" TEXT,
    "source" TEXT NOT NULL,
    "actor_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "contact_verification_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "push_subscriptions" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "endpoint_hash" CHAR(64) NOT NULL,
    "endpoint_encrypted" TEXT NOT NULL,
    "keys_encrypted" TEXT NOT NULL,
    "device_label" TEXT,
    "user_agent" TEXT,
    "last_success_at" TIMESTAMPTZ(3),
    "revoked_at" TIMESTAMPTZ(3),
    "revoked_reason" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "push_subscriptions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "job_runs" (
    "id" UUID NOT NULL,
    "tenant_id" UUID,
    "job_key" TEXT NOT NULL,
    "queue_job_id" TEXT,
    "scheduled_for" TIMESTAMPTZ(3),
    "started_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" TIMESTAMPTZ(3),
    "status" "JobRunStatus" NOT NULL DEFAULT 'RUNNING',
    "counts" JSONB NOT NULL DEFAULT '{}',
    "error" TEXT,
    "instance" TEXT,

    CONSTRAINT "job_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "file_scan_events" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "stored_file_id" UUID NOT NULL,
    "status" "MalwareScanStatus" NOT NULL,
    "engine" TEXT,
    "signature" TEXT,
    "error" TEXT,
    "quarantined" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "file_scan_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "webauthn_credentials" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "credential_id" TEXT NOT NULL,
    "public_key" BYTEA NOT NULL,
    "sign_count" BIGINT NOT NULL DEFAULT 0,
    "transports" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "aaguid" TEXT,
    "backup_eligible" BOOLEAN NOT NULL DEFAULT false,
    "backup_state" BOOLEAN NOT NULL DEFAULT false,
    "device_label" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_used_at" TIMESTAMPTZ(3),
    "revoked_at" TIMESTAMPTZ(3),
    "revoked_by_id" UUID,
    "revoked_reason" TEXT,

    CONSTRAINT "webauthn_credentials_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "webauthn_challenges" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "user_id" UUID,
    "purpose" "WebauthnChallengePurpose" NOT NULL,
    "challenge_hash" CHAR(64) NOT NULL,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "consumed_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "webauthn_challenges_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "recovery_codes" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "batch_id" UUID NOT NULL,
    "code_hash" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "used_at" TIMESTAMPTZ(3),
    "revoked_at" TIMESTAMPTZ(3),

    CONSTRAINT "recovery_codes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "account_recovery_requests" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "requested_by_id" UUID NOT NULL,
    "identity_check_note" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "status" "AccountRecoveryStatus" NOT NULL DEFAULT 'PENDING',
    "approved_by_id" UUID,
    "approved_at" TIMESTAMPTZ(3),
    "rejected_by_id" UUID,
    "rejected_at" TIMESTAMPTZ(3),
    "rejection_reason" TEXT,
    "token_hash" CHAR(64),
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "completed_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "account_recovery_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workspace_setup_items" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "item_key" TEXT NOT NULL,
    "status" "WorkspaceSetupItemStatus" NOT NULL DEFAULT 'PENDING',
    "note" TEXT,
    "completed_by_id" UUID,
    "completed_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "workspace_setup_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tenant_integration_settings" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "config" JSONB NOT NULL DEFAULT '{}',
    "updated_by_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "tenant_integration_settings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "message_outbox_status_next_attempt_at_idx" ON "message_outbox"("status", "next_attempt_at");

-- CreateIndex
CREATE INDEX "message_outbox_tenant_id_status_created_at_idx" ON "message_outbox"("tenant_id", "status", "created_at");

-- CreateIndex
CREATE INDEX "message_outbox_provider_provider_message_id_idx" ON "message_outbox"("provider", "provider_message_id");

-- CreateIndex
CREATE UNIQUE INDEX "message_outbox_tenant_id_idempotency_key_key" ON "message_outbox"("tenant_id", "idempotency_key");

-- CreateIndex
CREATE INDEX "message_outbox_events_tenant_id_message_id_created_at_idx" ON "message_outbox_events"("tenant_id", "message_id", "created_at");

-- CreateIndex
CREATE INDEX "contact_verifications_tenant_id_user_id_channel_idx" ON "contact_verifications"("tenant_id", "user_id", "channel");

-- CreateIndex
CREATE INDEX "contact_verification_events_tenant_id_verification_id_creat_idx" ON "contact_verification_events"("tenant_id", "verification_id", "created_at");

-- CreateIndex
CREATE INDEX "push_subscriptions_tenant_id_user_id_idx" ON "push_subscriptions"("tenant_id", "user_id");

-- CreateIndex
CREATE INDEX "job_runs_job_key_started_at_idx" ON "job_runs"("job_key", "started_at");

-- CreateIndex
CREATE INDEX "job_runs_tenant_id_job_key_started_at_idx" ON "job_runs"("tenant_id", "job_key", "started_at");

-- CreateIndex
CREATE INDEX "file_scan_events_tenant_id_stored_file_id_created_at_idx" ON "file_scan_events"("tenant_id", "stored_file_id", "created_at");

-- CreateIndex
CREATE INDEX "webauthn_credentials_tenant_id_user_id_idx" ON "webauthn_credentials"("tenant_id", "user_id");

-- CreateIndex
CREATE UNIQUE INDEX "webauthn_credentials_tenant_id_credential_id_key" ON "webauthn_credentials"("tenant_id", "credential_id");

-- CreateIndex
CREATE UNIQUE INDEX "webauthn_challenges_tenant_id_challenge_hash_key" ON "webauthn_challenges"("tenant_id", "challenge_hash");

-- CreateIndex
CREATE INDEX "recovery_codes_tenant_id_user_id_batch_id_idx" ON "recovery_codes"("tenant_id", "user_id", "batch_id");

-- CreateIndex
CREATE UNIQUE INDEX "account_recovery_requests_token_hash_key" ON "account_recovery_requests"("token_hash");

-- CreateIndex
CREATE INDEX "account_recovery_requests_tenant_id_user_id_status_idx" ON "account_recovery_requests"("tenant_id", "user_id", "status");

-- CreateIndex
CREATE INDEX "account_recovery_requests_tenant_id_status_created_at_idx" ON "account_recovery_requests"("tenant_id", "status", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "workspace_setup_items_tenant_id_item_key_key" ON "workspace_setup_items"("tenant_id", "item_key");

-- CreateIndex
CREATE UNIQUE INDEX "tenant_integration_settings_tenant_id_kind_key" ON "tenant_integration_settings"("tenant_id", "kind");

-- AddForeignKey
ALTER TABLE "message_outbox" ADD CONSTRAINT "message_outbox_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "message_outbox" ADD CONSTRAINT "message_outbox_recipient_user_id_fkey" FOREIGN KEY ("recipient_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "message_outbox" ADD CONSTRAINT "message_outbox_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "message_outbox" ADD CONSTRAINT "message_outbox_notification_id_fkey" FOREIGN KEY ("notification_id") REFERENCES "notifications"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "message_outbox_events" ADD CONSTRAINT "message_outbox_events_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "message_outbox_events" ADD CONSTRAINT "message_outbox_events_message_id_fkey" FOREIGN KEY ("message_id") REFERENCES "message_outbox"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contact_verifications" ADD CONSTRAINT "contact_verifications_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contact_verifications" ADD CONSTRAINT "contact_verifications_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contact_verification_events" ADD CONSTRAINT "contact_verification_events_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contact_verification_events" ADD CONSTRAINT "contact_verification_events_verification_id_fkey" FOREIGN KEY ("verification_id") REFERENCES "contact_verifications"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contact_verification_events" ADD CONSTRAINT "contact_verification_events_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "push_subscriptions" ADD CONSTRAINT "push_subscriptions_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "push_subscriptions" ADD CONSTRAINT "push_subscriptions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "job_runs" ADD CONSTRAINT "job_runs_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "file_scan_events" ADD CONSTRAINT "file_scan_events_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "file_scan_events" ADD CONSTRAINT "file_scan_events_stored_file_id_fkey" FOREIGN KEY ("stored_file_id") REFERENCES "stored_files"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "webauthn_credentials" ADD CONSTRAINT "webauthn_credentials_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "webauthn_credentials" ADD CONSTRAINT "webauthn_credentials_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "webauthn_credentials" ADD CONSTRAINT "webauthn_credentials_revoked_by_id_fkey" FOREIGN KEY ("revoked_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "webauthn_challenges" ADD CONSTRAINT "webauthn_challenges_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "webauthn_challenges" ADD CONSTRAINT "webauthn_challenges_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recovery_codes" ADD CONSTRAINT "recovery_codes_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recovery_codes" ADD CONSTRAINT "recovery_codes_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "account_recovery_requests" ADD CONSTRAINT "account_recovery_requests_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "account_recovery_requests" ADD CONSTRAINT "account_recovery_requests_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "account_recovery_requests" ADD CONSTRAINT "account_recovery_requests_requested_by_id_fkey" FOREIGN KEY ("requested_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "account_recovery_requests" ADD CONSTRAINT "account_recovery_requests_approved_by_id_fkey" FOREIGN KEY ("approved_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "account_recovery_requests" ADD CONSTRAINT "account_recovery_requests_rejected_by_id_fkey" FOREIGN KEY ("rejected_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workspace_setup_items" ADD CONSTRAINT "workspace_setup_items_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workspace_setup_items" ADD CONSTRAINT "workspace_setup_items_completed_by_id_fkey" FOREIGN KEY ("completed_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tenant_integration_settings" ADD CONSTRAINT "tenant_integration_settings_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tenant_integration_settings" ADD CONSTRAINT "tenant_integration_settings_updated_by_id_fkey" FOREIGN KEY ("updated_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ===========================================================================
-- Row-level security
-- ===========================================================================
SELECT ngao_enable_tenant_rls('message_outbox');
SELECT ngao_enable_tenant_rls('message_outbox_events');
SELECT ngao_enable_tenant_rls('contact_verifications');
SELECT ngao_enable_tenant_rls('contact_verification_events');
SELECT ngao_enable_tenant_rls('push_subscriptions');
SELECT ngao_enable_tenant_rls('file_scan_events');
SELECT ngao_enable_tenant_rls('webauthn_credentials');
SELECT ngao_enable_tenant_rls('webauthn_challenges');
SELECT ngao_enable_tenant_rls('recovery_codes');
SELECT ngao_enable_tenant_rls('account_recovery_requests');
SELECT ngao_enable_tenant_rls('workspace_setup_items');
SELECT ngao_enable_tenant_rls('tenant_integration_settings');

-- job_runs: a tenant sees its own runs; platform-wide runs (tenant_id NULL) are visible and
-- writable only on a connection with no tenant set (the scheduler), never inside withTenant().
ALTER TABLE "job_runs" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "job_runs";
CREATE POLICY tenant_isolation ON "job_runs"
  USING (tenant_id = ngao_current_tenant() OR (tenant_id IS NULL AND ngao_current_tenant() IS NULL))
  WITH CHECK (tenant_id = ngao_current_tenant() OR (tenant_id IS NULL AND ngao_current_tenant() IS NULL));

-- ===========================================================================
-- Checks
-- ===========================================================================
ALTER TABLE "message_outbox"
  ADD CONSTRAINT "message_outbox_ref_type_check" CHECK ("recipient_ref_type" IN ('USER', 'PUSH_SUBSCRIPTION')),
  ADD CONSTRAINT "message_outbox_template_key_check" CHECK ("template_key" ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$'),
  ADD CONSTRAINT "message_outbox_idempotency_key_check" CHECK (length("idempotency_key") BETWEEN 8 AND 200),
  ADD CONSTRAINT "message_outbox_attempts_check" CHECK ("attempts" >= 0 AND "max_attempts" BETWEEN 1 AND 20 AND "attempts" <= "max_attempts"),
  ADD CONSTRAINT "message_outbox_address_pair_check" CHECK (("address_encrypted" IS NULL) = ("address_hash" IS NULL)),
  ADD CONSTRAINT "message_outbox_secret_wiped_check"
    CHECK ("status"::text NOT IN ('SENT', 'SKIPPED', 'DEAD') OR "secret_payload_encrypted" IS NULL),
  ADD CONSTRAINT "message_outbox_sent_at_check" CHECK ("status"::text <> 'SENT' OR "sent_at" IS NOT NULL),
  ADD CONSTRAINT "message_outbox_payload_object_check" CHECK (jsonb_typeof("payload") = 'object');

ALTER TABLE "contact_verifications"
  ADD CONSTRAINT "contact_verifications_sms_only_check"
    CHECK ("channel"::text = 'SMS' OR ("sms_consent_version" IS NULL AND "sms_consent_at" IS NULL AND "sms_opted_out_at" IS NULL AND "sms_opt_out_source" IS NULL)),
  ADD CONSTRAINT "contact_verifications_consent_pair_check" CHECK (("sms_consent_version" IS NULL) = ("sms_consent_at" IS NULL)),
  ADD CONSTRAINT "contact_verifications_code_pair_check" CHECK (("code_hash" IS NULL) = ("code_expires_at" IS NULL)),
  ADD CONSTRAINT "contact_verifications_attempts_check" CHECK ("code_attempts" >= 0);
CREATE UNIQUE INDEX "contact_verifications_current_key"
  ON "contact_verifications"("tenant_id", "user_id", "channel") WHERE "superseded_at" IS NULL;

ALTER TABLE "contact_verification_events"
  ADD CONSTRAINT "contact_verification_events_source_check" CHECK ("source" IN ('settings', 'sms_reply', 'admin', 'system'));

CREATE UNIQUE INDEX "push_subscriptions_active_endpoint_key"
  ON "push_subscriptions"("tenant_id", "endpoint_hash") WHERE "revoked_at" IS NULL;
ALTER TABLE "push_subscriptions"
  ADD CONSTRAINT "push_subscriptions_revoked_reason_check"
    CHECK (("revoked_at" IS NULL) = ("revoked_reason" IS NULL) AND ("revoked_reason" IS NULL OR "revoked_reason" IN ('user', 'expired', 'admin')));

ALTER TABLE "job_runs"
  ADD CONSTRAINT "job_runs_job_key_check" CHECK ("job_key" ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$'),
  ADD CONSTRAINT "job_runs_finished_check" CHECK (("status"::text = 'RUNNING') = ("finished_at" IS NULL)),
  ADD CONSTRAINT "job_runs_counts_object_check" CHECK (jsonb_typeof("counts") = 'object');

ALTER TABLE "webauthn_credentials"
  ADD CONSTRAINT "webauthn_credentials_sign_count_check" CHECK ("sign_count" >= 0),
  ADD CONSTRAINT "webauthn_credentials_label_check" CHECK (length(trim("device_label")) BETWEEN 1 AND 100),
  ADD CONSTRAINT "webauthn_credentials_revoked_check"
    CHECK ("revoked_at" IS NOT NULL OR ("revoked_by_id" IS NULL AND "revoked_reason" IS NULL));

ALTER TABLE "webauthn_challenges"
  ADD CONSTRAINT "webauthn_challenges_lifetime_check"
    CHECK ("expires_at" > "created_at" AND "expires_at" <= "created_at" + interval '10 minutes');

ALTER TABLE "account_recovery_requests"
  ADD CONSTRAINT "account_recovery_requests_requester_not_subject_check" CHECK ("requested_by_id" <> "user_id"),
  ADD CONSTRAINT "account_recovery_requests_approver_check"
    CHECK ("approved_by_id" IS NULL OR ("approved_by_id" <> "requested_by_id" AND "approved_by_id" <> "user_id")),
  ADD CONSTRAINT "account_recovery_requests_rejecter_check" CHECK ("rejected_by_id" IS NULL OR "rejected_by_id" <> "user_id"),
  ADD CONSTRAINT "account_recovery_requests_expiry_check"
    CHECK ("expires_at" > "created_at" AND "expires_at" <= "created_at" + interval '72 hours'),
  ADD CONSTRAINT "account_recovery_requests_approved_check"
    CHECK ("status"::text NOT IN ('APPROVED', 'COMPLETED')
           OR ("approved_by_id" IS NOT NULL AND "approved_at" IS NOT NULL AND "token_hash" IS NOT NULL)),
  ADD CONSTRAINT "account_recovery_requests_rejected_check"
    CHECK ("status"::text <> 'REJECTED' OR ("rejected_by_id" IS NOT NULL AND "rejected_at" IS NOT NULL AND "rejection_reason" IS NOT NULL)),
  ADD CONSTRAINT "account_recovery_requests_completed_check" CHECK (("status"::text = 'COMPLETED') = ("completed_at" IS NOT NULL));
CREATE UNIQUE INDEX "account_recovery_requests_open_key"
  ON "account_recovery_requests"("tenant_id", "user_id") WHERE "status" IN ('PENDING', 'APPROVED');

ALTER TABLE "workspace_setup_items"
  ADD CONSTRAINT "workspace_setup_items_key_check" CHECK ("item_key" ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$'),
  ADD CONSTRAINT "workspace_setup_items_completed_check" CHECK (("status"::text = 'PENDING') = ("completed_at" IS NULL));

-- Integration settings hold non-secret configuration only. A recursive check refuses any object key
-- that looks like a secret (api key, secret, password, token, private key, credential) at any depth.
CREATE OR REPLACE FUNCTION ngao_jsonb_has_secret_key(doc jsonb) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
  k text;
  v jsonb;
BEGIN
  IF doc IS NULL THEN
    RETURN false;
  END IF;
  IF jsonb_typeof(doc) = 'object' THEN
    FOR k, v IN SELECT * FROM jsonb_each(doc) LOOP
      IF k ~* '(secret|password|passwd|api[_-]?key|token|private[_-]?key|credential|auth[_-]?key)' THEN
        RETURN true;
      END IF;
      IF ngao_jsonb_has_secret_key(v) THEN
        RETURN true;
      END IF;
    END LOOP;
  ELSIF jsonb_typeof(doc) = 'array' THEN
    FOR v IN SELECT * FROM jsonb_array_elements(doc) LOOP
      IF ngao_jsonb_has_secret_key(v) THEN
        RETURN true;
      END IF;
    END LOOP;
  END IF;
  RETURN false;
END
$$;
GRANT EXECUTE ON FUNCTION ngao_jsonb_has_secret_key(jsonb) TO ngao_app;

ALTER TABLE "tenant_integration_settings"
  ADD CONSTRAINT "tenant_integration_settings_kind_check" CHECK ("kind" IN ('email', 'sms', 'push', 'captcha', 'scanner')),
  ADD CONSTRAINT "tenant_integration_settings_provider_check" CHECK ("provider" ~ '^[a-z][a-z0-9_-]{1,39}$'),
  ADD CONSTRAINT "tenant_integration_settings_config_object_check" CHECK (jsonb_typeof("config") = 'object'),
  ADD CONSTRAINT "tenant_integration_settings_no_secrets_check" CHECK (NOT ngao_jsonb_has_secret_key("config"));

-- ===========================================================================
-- Stored files: scan verdicts. INFECTED and quarantine are final; every infected file is quarantined.
-- ===========================================================================
UPDATE "stored_files" SET "quarantined_at" = COALESCE("scanned_at", "created_at")
  WHERE "malware_scan_status"::text = 'INFECTED' AND "quarantined_at" IS NULL;
ALTER TABLE "stored_files"
  ADD CONSTRAINT "stored_files_infected_quarantined_check"
    CHECK ("malware_scan_status"::text <> 'INFECTED' OR "quarantined_at" IS NOT NULL);

CREATE OR REPLACE FUNCTION ngao_stored_files_scan_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  -- Fail safe: an INFECTED verdict always quarantines, even if the writer forgot to.
  IF TG_OP = 'INSERT' THEN
    IF NEW.malware_scan_status::text = 'INFECTED' AND NEW.quarantined_at IS NULL THEN
      NEW.quarantined_at := now();
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.malware_scan_status::text = 'INFECTED' AND NEW.quarantined_at IS NULL AND OLD.quarantined_at IS NULL THEN
    NEW.quarantined_at := now();
  END IF;
  IF OLD.malware_scan_status::text = 'INFECTED' AND NEW.malware_scan_status::text <> 'INFECTED' THEN
    RAISE EXCEPTION 'IMMUTABLE_RECORD: an INFECTED verdict is final' USING ERRCODE = 'P0001';
  END IF;
  IF OLD.quarantined_at IS NOT NULL AND NEW.quarantined_at IS DISTINCT FROM OLD.quarantined_at THEN
    RAISE EXCEPTION 'IMMUTABLE_RECORD: a quarantined file stays quarantined' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER stored_files_scan_guard BEFORE INSERT OR UPDATE ON "stored_files"
  FOR EACH ROW EXECUTE FUNCTION ngao_stored_files_scan_guard();

-- ===========================================================================
-- Message outbox: state machine (MESSAGE_STATUS_TRANSITIONS in @ngao360/shared)
--   QUEUED  -> SENDING | SKIPPED | DEAD
--   SENDING -> SENDING (lease taken over) | SENT | FAILED | SKIPPED | DEAD
--   FAILED  -> SENDING | DEAD
--   SENT    -> SENT (delivery report only)
--   SKIPPED, DEAD: final
-- ===========================================================================
CREATE OR REPLACE FUNCTION ngao_message_outbox_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  f text := OLD.status::text;
  t text := NEW.status::text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'IMMUTABLE_RECORD: outbox messages cannot be deleted' USING ERRCODE = 'P0001';
  END IF;
  IF NEW.id <> OLD.id OR NEW.tenant_id <> OLD.tenant_id OR NEW.channel <> OLD.channel
     OR NEW.template_key <> OLD.template_key
     OR NEW.recipient_user_id IS DISTINCT FROM OLD.recipient_user_id
     OR NEW.recipient_ref_type <> OLD.recipient_ref_type OR NEW.recipient_ref_id <> OLD.recipient_ref_id
     OR NEW.idempotency_key <> OLD.idempotency_key OR NEW.created_at <> OLD.created_at
     OR NEW.created_by_id IS DISTINCT FROM OLD.created_by_id
     OR NEW.notification_id IS DISTINCT FROM OLD.notification_id
     OR NEW.payload <> OLD.payload OR NEW.max_attempts <> OLD.max_attempts
     OR (OLD.address_hash IS NOT NULL AND (NEW.address_hash IS DISTINCT FROM OLD.address_hash
                                          OR NEW.address_encrypted IS DISTINCT FROM OLD.address_encrypted))
     OR (OLD.secret_payload_encrypted IS NULL AND NEW.secret_payload_encrypted IS NOT NULL) THEN
    RAISE EXCEPTION 'IMMUTABLE_RECORD: outbox message identity, recipient and payload are immutable'
      USING ERRCODE = 'P0001';
  END IF;
  IF NEW.attempts < OLD.attempts THEN
    RAISE EXCEPTION 'IMMUTABLE_RECORD: outbox attempts never decrease' USING ERRCODE = 'P0001';
  END IF;
  IF f IN ('SKIPPED', 'DEAD') THEN
    RAISE EXCEPTION 'INVALID_TRANSITION: outbox message is final (%)', f USING ERRCODE = 'P0001';
  END IF;
  IF f = 'SENT' THEN
    IF t <> 'SENT' OR NEW.provider IS DISTINCT FROM OLD.provider
       OR NEW.provider_message_id IS DISTINCT FROM OLD.provider_message_id
       OR NEW.sent_at IS DISTINCT FROM OLD.sent_at OR NEW.attempts <> OLD.attempts THEN
      RAISE EXCEPTION 'INVALID_TRANSITION: a SENT message only receives delivery reports' USING ERRCODE = 'P0001';
    END IF;
    RETURN NEW;
  END IF;
  IF f = t AND f <> 'SENDING' THEN
    RETURN NEW;
  END IF;
  IF NOT (
       (f = 'QUEUED' AND t IN ('SENDING', 'SKIPPED', 'DEAD'))
    OR (f = 'SENDING' AND t IN ('SENDING', 'SENT', 'FAILED', 'SKIPPED', 'DEAD'))
    OR (f = 'FAILED' AND t IN ('SENDING', 'DEAD'))
  ) THEN
    RAISE EXCEPTION 'INVALID_TRANSITION: outbox message % -> %', f, t USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER message_outbox_guard BEFORE UPDATE OR DELETE ON "message_outbox"
  FOR EACH ROW EXECUTE FUNCTION ngao_message_outbox_guard();

-- ===========================================================================
-- Contact verifications: owner, channel and address are fixed (a new address supersedes the row);
-- a superseded row is frozen.
-- ===========================================================================
CREATE OR REPLACE FUNCTION ngao_contact_verifications_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'IMMUTABLE_RECORD: contact verifications cannot be deleted' USING ERRCODE = 'P0001';
  END IF;
  IF OLD.superseded_at IS NOT NULL THEN
    RAISE EXCEPTION 'IMMUTABLE_RECORD: a superseded contact verification is frozen' USING ERRCODE = 'P0001';
  END IF;
  IF NEW.id <> OLD.id OR NEW.tenant_id <> OLD.tenant_id OR NEW.user_id <> OLD.user_id
     OR NEW.channel <> OLD.channel OR NEW.address_hash <> OLD.address_hash OR NEW.created_at <> OLD.created_at
     OR (OLD.verified_at IS NOT NULL AND NEW.verified_at IS DISTINCT FROM OLD.verified_at) THEN
    RAISE EXCEPTION 'IMMUTABLE_RECORD: contact owner, channel, address and verification time are fixed; supersede instead'
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER contact_verifications_guard BEFORE UPDATE OR DELETE ON "contact_verifications"
  FOR EACH ROW EXECUTE FUNCTION ngao_contact_verifications_guard();

-- Push subscriptions: endpoint and keys fixed; revocation final.
CREATE OR REPLACE FUNCTION ngao_push_subscriptions_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'IMMUTABLE_RECORD: push subscriptions are revoked, not deleted' USING ERRCODE = 'P0001';
  END IF;
  IF OLD.revoked_at IS NOT NULL THEN
    RAISE EXCEPTION 'IMMUTABLE_RECORD: a revoked push subscription is frozen' USING ERRCODE = 'P0001';
  END IF;
  IF NEW.id <> OLD.id OR NEW.tenant_id <> OLD.tenant_id OR NEW.user_id <> OLD.user_id
     OR NEW.endpoint_hash <> OLD.endpoint_hash OR NEW.endpoint_encrypted <> OLD.endpoint_encrypted
     OR NEW.keys_encrypted <> OLD.keys_encrypted OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'IMMUTABLE_RECORD: push subscription endpoint and keys are immutable' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER push_subscriptions_guard BEFORE UPDATE OR DELETE ON "push_subscriptions"
  FOR EACH ROW EXECUTE FUNCTION ngao_push_subscriptions_guard();

-- Job runs: a finished run is frozen; identity fixed.
CREATE OR REPLACE FUNCTION ngao_job_runs_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'IMMUTABLE_RECORD: job runs cannot be deleted' USING ERRCODE = 'P0001';
  END IF;
  IF OLD.finished_at IS NOT NULL THEN
    RAISE EXCEPTION 'IMMUTABLE_RECORD: a finished job run is frozen' USING ERRCODE = 'P0001';
  END IF;
  IF NEW.id <> OLD.id OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR NEW.job_key <> OLD.job_key
     OR NEW.started_at <> OLD.started_at OR NEW.queue_job_id IS DISTINCT FROM OLD.queue_job_id
     OR NEW.scheduled_for IS DISTINCT FROM OLD.scheduled_for THEN
    RAISE EXCEPTION 'IMMUTABLE_RECORD: job run identity is immutable' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER job_runs_guard BEFORE UPDATE OR DELETE ON "job_runs"
  FOR EACH ROW EXECUTE FUNCTION ngao_job_runs_guard();

-- WebAuthn credentials: key material and owner fixed; counter never decreases; revocation final.
CREATE OR REPLACE FUNCTION ngao_webauthn_credentials_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'IMMUTABLE_RECORD: passkeys are revoked, not deleted' USING ERRCODE = 'P0001';
  END IF;
  IF OLD.revoked_at IS NOT NULL THEN
    RAISE EXCEPTION 'IMMUTABLE_RECORD: a revoked passkey is frozen' USING ERRCODE = 'P0001';
  END IF;
  IF NEW.id <> OLD.id OR NEW.tenant_id <> OLD.tenant_id OR NEW.user_id <> OLD.user_id
     OR NEW.credential_id <> OLD.credential_id OR NEW.public_key <> OLD.public_key
     OR NEW.aaguid IS DISTINCT FROM OLD.aaguid OR NEW.created_at <> OLD.created_at
     OR NEW.backup_eligible <> OLD.backup_eligible THEN
    RAISE EXCEPTION 'IMMUTABLE_RECORD: passkey owner and key material are immutable' USING ERRCODE = 'P0001';
  END IF;
  IF NEW.sign_count < OLD.sign_count THEN
    RAISE EXCEPTION 'IMMUTABLE_RECORD: passkey signature counter cannot go down (possible cloned authenticator)'
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER webauthn_credentials_guard BEFORE UPDATE OR DELETE ON "webauthn_credentials"
  FOR EACH ROW EXECUTE FUNCTION ngao_webauthn_credentials_guard();

-- WebAuthn challenges: consumed once; only spent (consumed or expired) challenges may be deleted.
CREATE OR REPLACE FUNCTION ngao_webauthn_challenges_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.consumed_at IS NULL AND OLD.expires_at > now() THEN
      RAISE EXCEPTION 'IMMUTABLE_RECORD: a live WebAuthn challenge cannot be deleted' USING ERRCODE = 'P0001';
    END IF;
    RETURN OLD;
  END IF;
  IF OLD.consumed_at IS NOT NULL
     OR (to_jsonb(NEW) - 'consumed_at') IS DISTINCT FROM (to_jsonb(OLD) - 'consumed_at') THEN
    RAISE EXCEPTION 'IMMUTABLE_RECORD: a WebAuthn challenge is consumed once and never changed' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER webauthn_challenges_guard BEFORE UPDATE OR DELETE ON "webauthn_challenges"
  FOR EACH ROW EXECUTE FUNCTION ngao_webauthn_challenges_guard();

-- Recovery codes: used or revoked once; a revoked code cannot be used.
CREATE OR REPLACE FUNCTION ngao_recovery_codes_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'IMMUTABLE_RECORD: recovery codes are revoked, not deleted' USING ERRCODE = 'P0001';
  END IF;
  IF (to_jsonb(NEW) - 'used_at' - 'revoked_at') IS DISTINCT FROM (to_jsonb(OLD) - 'used_at' - 'revoked_at')
     OR (OLD.used_at IS NOT NULL AND NEW.used_at IS DISTINCT FROM OLD.used_at)
     OR (OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS DISTINCT FROM OLD.revoked_at)
     OR (OLD.revoked_at IS NOT NULL AND NEW.used_at IS DISTINCT FROM OLD.used_at) THEN
    RAISE EXCEPTION 'IMMUTABLE_RECORD: a recovery code is used or revoked once' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER recovery_codes_guard BEFORE UPDATE OR DELETE ON "recovery_codes"
  FOR EACH ROW EXECUTE FUNCTION ngao_recovery_codes_guard();

-- Account recovery (ACCOUNT_RECOVERY_TRANSITIONS in @ngao360/shared)
--   PENDING  -> APPROVED | REJECTED | EXPIRED | CANCELLED
--   APPROVED -> COMPLETED | EXPIRED | CANCELLED
--   REJECTED, COMPLETED, EXPIRED, CANCELLED: final
-- Approval and completion are refused after expiry.
CREATE OR REPLACE FUNCTION ngao_account_recovery_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  f text := OLD.status::text;
  t text := NEW.status::text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'IMMUTABLE_RECORD: account recovery requests cannot be deleted' USING ERRCODE = 'P0001';
  END IF;
  IF NEW.id <> OLD.id OR NEW.tenant_id <> OLD.tenant_id OR NEW.user_id <> OLD.user_id
     OR NEW.requested_by_id <> OLD.requested_by_id OR NEW.identity_check_note <> OLD.identity_check_note
     OR NEW.reason <> OLD.reason OR NEW.expires_at <> OLD.expires_at OR NEW.created_at <> OLD.created_at
     OR (OLD.approved_by_id IS NOT NULL AND (NEW.approved_by_id IS DISTINCT FROM OLD.approved_by_id
                                            OR NEW.approved_at IS DISTINCT FROM OLD.approved_at))
     OR (OLD.token_hash IS NOT NULL AND NEW.token_hash IS DISTINCT FROM OLD.token_hash) THEN
    RAISE EXCEPTION 'IMMUTABLE_RECORD: account recovery request details are immutable' USING ERRCODE = 'P0001';
  END IF;
  IF f = t THEN
    IF f IN ('REJECTED', 'COMPLETED', 'EXPIRED', 'CANCELLED') AND to_jsonb(NEW) - 'updated_at' IS DISTINCT FROM to_jsonb(OLD) - 'updated_at' THEN
      RAISE EXCEPTION 'IMMUTABLE_RECORD: a closed account recovery request is frozen' USING ERRCODE = 'P0001';
    END IF;
    RETURN NEW;
  END IF;
  IF NOT (
       (f = 'PENDING' AND t IN ('APPROVED', 'REJECTED', 'EXPIRED', 'CANCELLED'))
    OR (f = 'APPROVED' AND t IN ('COMPLETED', 'EXPIRED', 'CANCELLED'))
  ) THEN
    RAISE EXCEPTION 'INVALID_TRANSITION: account recovery % -> %', f, t USING ERRCODE = 'P0001';
  END IF;
  IF t IN ('APPROVED', 'COMPLETED') AND OLD.expires_at <= now() THEN
    RAISE EXCEPTION 'INVALID_TRANSITION: account recovery request has expired' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER account_recovery_requests_guard BEFORE UPDATE OR DELETE ON "account_recovery_requests"
  FOR EACH ROW EXECUTE FUNCTION ngao_account_recovery_guard();

-- Workspace setup items and integration settings: mutable, never deleted.
-- ===========================================================================
-- Runtime role privileges.
--   mutable records:   SELECT, INSERT, UPDATE (never deleted)
--   append-only:       SELECT, INSERT
--   spent challenges:  SELECT, INSERT, UPDATE, DELETE (trigger allows only consumed / expired rows)
-- ===========================================================================
REVOKE ALL ON
  message_outbox, message_outbox_events, contact_verifications, contact_verification_events,
  push_subscriptions, job_runs, file_scan_events, webauthn_credentials, webauthn_challenges,
  recovery_codes, account_recovery_requests, workspace_setup_items, tenant_integration_settings
  FROM ngao_app;
GRANT SELECT, INSERT, UPDATE ON
  message_outbox, contact_verifications, push_subscriptions, job_runs, webauthn_credentials,
  recovery_codes, account_recovery_requests, workspace_setup_items, tenant_integration_settings
  TO ngao_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON webauthn_challenges TO ngao_app;
GRANT SELECT, INSERT ON message_outbox_events, contact_verification_events, file_scan_events TO ngao_app;

-- Mutable records: no DELETE (except the guards above) or TRUNCATE, even for the owner role.
DO $$
DECLARE
  tbl text;
BEGIN
  FOREACH tbl IN ARRAY ARRAY['workspace_setup_items', 'tenant_integration_settings'] LOOP
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE DELETE ON %I FOR EACH ROW EXECUTE FUNCTION ngao_reject_modification()',
      tbl || '_no_delete', tbl
    );
  END LOOP;
  FOREACH tbl IN ARRAY ARRAY[
    'message_outbox', 'contact_verifications', 'push_subscriptions', 'job_runs', 'webauthn_credentials',
    'recovery_codes', 'account_recovery_requests', 'workspace_setup_items', 'tenant_integration_settings'
  ] LOOP
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
  FOREACH tbl IN ARRAY ARRAY['message_outbox_events', 'contact_verification_events', 'file_scan_events'] LOOP
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

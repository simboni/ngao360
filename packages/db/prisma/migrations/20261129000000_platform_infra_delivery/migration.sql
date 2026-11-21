-- Platform infrastructure: delivery, scanning and job lookups (platform-infra, docs/ARCHITECTURE.md §16).
--
--   1. message_outbox may address a citizen case requester (recipient_ref_type 'CITIZEN_CASE', no user)
--      for Office portal acknowledgements. The address stays sealed; nothing else is stored.
--   2. The sealed address of a message may be wiped (address_encrypted and address_hash set to NULL
--      together) once the message is final (SENT, SKIPPED, DEAD). Citizen addresses are wiped at once
--      by the dispatcher (data minimisation); the masked copy stays for the delivery log.
--   3. SECURITY DEFINER lookups for code that runs without a tenant (dispatcher, scanner, provider
--      webhooks). Each returns tenant ids only, never row content; the caller then works inside
--      withTenant() under RLS as usual.
--
-- No new tables. Nothing here weakens RLS: the functions are owned by the migration role and return
-- uuids only.

-- ---------------------------------------------------------------------------
-- 1. Citizen-case recipients
-- ---------------------------------------------------------------------------
ALTER TABLE "message_outbox" DROP CONSTRAINT "message_outbox_ref_type_check";
ALTER TABLE "message_outbox"
  ADD CONSTRAINT "message_outbox_ref_type_check" CHECK ("recipient_ref_type" IN ('USER', 'PUSH_SUBSCRIPTION', 'CITIZEN_CASE')),
  -- A message to a user names the user; a citizen-case message never does.
  ADD CONSTRAINT "message_outbox_recipient_kind_check"
    CHECK (("recipient_ref_type" = 'CITIZEN_CASE') = ("recipient_user_id" IS NULL));

-- ---------------------------------------------------------------------------
-- 2. Outbox guard: same rules as 20261128000000, plus wiping the sealed address at a final status.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION ngao_message_outbox_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  f text := OLD.status::text;
  t text := NEW.status::text;
  wiping boolean := OLD.address_hash IS NOT NULL AND NEW.address_hash IS NULL AND NEW.address_encrypted IS NULL
                    AND NEW.status::text IN ('SENT', 'SKIPPED', 'DEAD');
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
     OR NEW.address_masked IS DISTINCT FROM OLD.address_masked
     OR (OLD.address_hash IS NOT NULL AND NOT wiping AND (NEW.address_hash IS DISTINCT FROM OLD.address_hash
                                          OR NEW.address_encrypted IS DISTINCT FROM OLD.address_encrypted))
     OR (OLD.address_hash IS NULL AND (NEW.address_hash IS NOT NULL OR NEW.address_encrypted IS NOT NULL))
     OR (OLD.secret_payload_encrypted IS NULL AND NEW.secret_payload_encrypted IS NOT NULL) THEN
    RAISE EXCEPTION 'IMMUTABLE_RECORD: outbox message identity, recipient and payload are immutable'
      USING ERRCODE = 'P0001';
  END IF;
  IF NEW.attempts < OLD.attempts THEN
    RAISE EXCEPTION 'IMMUTABLE_RECORD: outbox attempts never decrease' USING ERRCODE = 'P0001';
  END IF;
  IF f IN ('SKIPPED', 'DEAD') THEN
    -- A final message only loses its sealed address (erasure); nothing else changes.
    IF wiping AND (to_jsonb(NEW) - 'address_encrypted' - 'address_hash' - 'updated_at')
                  = (to_jsonb(OLD) - 'address_encrypted' - 'address_hash' - 'updated_at') THEN
      RETURN NEW;
    END IF;
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

-- ---------------------------------------------------------------------------
-- 3. Tenant lookups for tenant-less workers and webhooks (tenant ids only)
-- ---------------------------------------------------------------------------

-- Tenants with outbox messages due now (dispatcher).
CREATE OR REPLACE FUNCTION ngao_outbox_due_tenants() RETURNS SETOF uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT DISTINCT tenant_id FROM message_outbox
  WHERE (status IN ('QUEUED', 'FAILED') AND next_attempt_at <= now())
     OR (status = 'SENDING' AND locked_until IS NOT NULL AND locked_until <= now())
$$;

-- Tenant of a message by provider and provider message id (delivery reports). NULL when unknown.
CREATE OR REPLACE FUNCTION ngao_outbox_tenant_by_provider_id(p_provider text, p_provider_message_id text) RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT tenant_id FROM message_outbox
  WHERE provider = p_provider AND provider_message_id = p_provider_message_id
  ORDER BY created_at DESC
  LIMIT 1
$$;

-- Tenants with a current SMS contact for this keyed phone hash (inbound STOP replies).
CREATE OR REPLACE FUNCTION ngao_sms_contact_tenants(p_address_hash text) RETURNS SETOF uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT DISTINCT tenant_id FROM contact_verifications
  WHERE channel = 'SMS' AND superseded_at IS NULL AND address_hash = p_address_hash
$$;

-- Tenants with files waiting for a malware scan (PENDING, or ERROR to retry).
CREATE OR REPLACE FUNCTION ngao_files_scan_due_tenants() RETURNS SETOF uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT DISTINCT tenant_id FROM stored_files
  WHERE malware_scan_status IN ('PENDING', 'ERROR') AND quarantined_at IS NULL
$$;

REVOKE ALL ON FUNCTION ngao_outbox_due_tenants() FROM PUBLIC;
REVOKE ALL ON FUNCTION ngao_outbox_tenant_by_provider_id(text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION ngao_sms_contact_tenants(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION ngao_files_scan_due_tenants() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ngao_outbox_due_tenants() TO ngao_app;
GRANT EXECUTE ON FUNCTION ngao_outbox_tenant_by_provider_id(text, text) TO ngao_app;
GRANT EXECUTE ON FUNCTION ngao_sms_contact_tenants(text) TO ngao_app;
GRANT EXECUTE ON FUNCTION ngao_files_scan_due_tenants() TO ngao_app;

-- Indexes for the lookups above.
CREATE INDEX IF NOT EXISTS "contact_verifications_sms_hash_idx"
  ON "contact_verifications"("address_hash") WHERE "channel" = 'SMS' AND "superseded_at" IS NULL;
CREATE INDEX IF NOT EXISTS "stored_files_scan_due_idx"
  ON "stored_files"("tenant_id", "created_at") WHERE "malware_scan_status" IN ('PENDING', 'ERROR');

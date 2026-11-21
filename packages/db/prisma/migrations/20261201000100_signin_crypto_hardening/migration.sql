-- Go-live gaps: column-level encryption of agent personal data, key rotation and job_runs retention.
--
--   1. agent_sensitive: the six personal-data columns hold AES-256-GCM ciphertext ("ag1.…", sealed
--      by the API under AGENT_DATA_KEY). CHECK constraints refuse plaintext in new writes; they are
--      NOT VALID because rows written before this release are encrypted by the API's start-up data
--      migration (and `pnpm ops:rotate-keys --target agent-data`), which then validates them
--      (`--validate`). Keyed lookup hashes (national ID, phone) for duplicate checks. Erasure also
--      clears the hashes, and the erased guard keeps them cleared.
--   2. Key rotation: the immutability guards of message_outbox, contact_verifications and
--      push_subscriptions skip an UPDATE that only re-encrypts / re-hashes the crypto columns (same
--      NULL-ness, every other column unchanged), and only inside a transaction that set
--      `ngao.key_rotation = on` as a role that is not the runtime role ngao_app (the rotation CLI
--      connects as the schema owner). Everything else still goes through the guard unchanged.
--   3. job_runs retention: finished runs older than the retention period are deleted only through
--      ngao_purge_job_runs() (SECURITY DEFINER; never younger than 7 days, never RUNNING rows). The
--      runtime role still has no DELETE privilege on job_runs; TRUNCATE stays refused.

-- ---------------------------------------------------------------------------
-- 1. agent_sensitive
-- ---------------------------------------------------------------------------
ALTER TABLE "agent_sensitive" ADD COLUMN "national_id_hash" CHAR(64);
ALTER TABLE "agent_sensitive" ADD COLUMN "phone_hash" CHAR(64);
CREATE INDEX "agent_sensitive_tenant_id_national_id_hash_idx" ON "agent_sensitive"("tenant_id", "national_id_hash");
CREATE INDEX "agent_sensitive_tenant_id_phone_hash_idx" ON "agent_sensitive"("tenant_id", "phone_hash");

ALTER TABLE "agent_sensitive"
  ADD CONSTRAINT "agent_sensitive_hashes_check"
    CHECK (("national_id_hash" IS NULL OR "national_id_hash" ~ '^[0-9a-f]{64}$')
       AND ("phone_hash" IS NULL OR "phone_hash" ~ '^[0-9a-f]{64}$')),
  ADD CONSTRAINT "agent_sensitive_encrypted_check"
    CHECK (("national_id_number" IS NULL OR "national_id_number" ~ '^ag1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*$')
       AND ("phone" IS NULL OR "phone" ~ '^ag1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*$')
       AND ("mpesa_number" IS NULL OR "mpesa_number" ~ '^ag1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*$')
       AND ("next_of_kin_name" IS NULL OR "next_of_kin_name" ~ '^ag1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*$')
       AND ("next_of_kin_phone" IS NULL OR "next_of_kin_phone" ~ '^ag1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*$')
       AND ("next_of_kin_relationship" IS NULL OR "next_of_kin_relationship" ~ '^ag1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*$'))
    NOT VALID;

-- Erased personal data stays erased, lookup hashes included.
CREATE OR REPLACE FUNCTION ngao_agent_sensitive_erased_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.erased_at IS NOT NULL AND (
       NEW.erased_at IS DISTINCT FROM OLD.erased_at
    OR NEW.national_id_number IS NOT NULL OR NEW.phone IS NOT NULL OR NEW.mpesa_number IS NOT NULL
    OR NEW.next_of_kin_name IS NOT NULL OR NEW.next_of_kin_phone IS NOT NULL OR NEW.next_of_kin_relationship IS NOT NULL
    OR NEW.national_id_hash IS NOT NULL OR NEW.phone_hash IS NOT NULL) THEN
    RAISE EXCEPTION 'agent personal data was erased and cannot be restored' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

-- Tenants that still hold rows written before column encryption (tenant ids only, no personal
-- data), so the API's start-up data migration does not scan every tenant on each boot.
CREATE OR REPLACE FUNCTION ngao_agent_sensitive_legacy_tenants() RETURNS SETOF uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT DISTINCT tenant_id FROM agent_sensitive
  WHERE (national_id_number IS NOT NULL AND national_id_number NOT LIKE 'ag1.%')
     OR (phone IS NOT NULL AND phone NOT LIKE 'ag1.%')
     OR (mpesa_number IS NOT NULL AND mpesa_number NOT LIKE 'ag1.%')
     OR (next_of_kin_name IS NOT NULL AND next_of_kin_name NOT LIKE 'ag1.%')
     OR (next_of_kin_phone IS NOT NULL AND next_of_kin_phone NOT LIKE 'ag1.%')
     OR (next_of_kin_relationship IS NOT NULL AND next_of_kin_relationship NOT LIKE 'ag1.%')
$$;
REVOKE ALL ON FUNCTION ngao_agent_sensitive_legacy_tenants() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ngao_agent_sensitive_legacy_tenants() TO ngao_app;

-- ---------------------------------------------------------------------------
-- 2. Key rotation: re-key-only updates of guarded crypto columns
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION ngao_key_rotation_rekey_only(old_row jsonb, new_row jsonb, cols text[]) RETURNS boolean
LANGUAGE plpgsql STABLE AS $$
DECLARE
  c text;
  is_super boolean;
BEGIN
  IF coalesce(current_setting('ngao.key_rotation', true), '') <> 'on' THEN
    RETURN false;
  END IF;
  -- Never for the runtime role (or a role that inherits it), whatever it sets.
  SELECT rolsuper INTO is_super FROM pg_roles WHERE rolname = current_user;
  IF current_user::text = 'ngao_app' OR (NOT coalesce(is_super, false) AND pg_has_role(current_user, 'ngao_app', 'MEMBER')) THEN
    RETURN false;
  END IF;
  IF (old_row - cols) IS DISTINCT FROM (new_row - cols) THEN
    RETURN false;
  END IF;
  FOREACH c IN ARRAY cols LOOP
    IF (coalesce(old_row -> c, 'null'::jsonb) = 'null'::jsonb)
       IS DISTINCT FROM (coalesce(new_row -> c, 'null'::jsonb) = 'null'::jsonb) THEN
      RETURN false;
    END IF;
  END LOOP;
  RETURN true;
END
$$;

DROP TRIGGER IF EXISTS message_outbox_guard ON "message_outbox";
CREATE TRIGGER message_outbox_guard BEFORE DELETE ON "message_outbox"
  FOR EACH ROW EXECUTE FUNCTION ngao_message_outbox_guard();
CREATE TRIGGER message_outbox_guard_update BEFORE UPDATE ON "message_outbox"
  FOR EACH ROW
  WHEN (NOT ngao_key_rotation_rekey_only(to_jsonb(OLD), to_jsonb(NEW), ARRAY['address_encrypted', 'address_hash', 'secret_payload_encrypted']))
  EXECUTE FUNCTION ngao_message_outbox_guard();

DROP TRIGGER IF EXISTS contact_verifications_guard ON "contact_verifications";
CREATE TRIGGER contact_verifications_guard BEFORE DELETE ON "contact_verifications"
  FOR EACH ROW EXECUTE FUNCTION ngao_contact_verifications_guard();
CREATE TRIGGER contact_verifications_guard_update BEFORE UPDATE ON "contact_verifications"
  FOR EACH ROW
  WHEN (NOT ngao_key_rotation_rekey_only(to_jsonb(OLD), to_jsonb(NEW), ARRAY['address_hash']))
  EXECUTE FUNCTION ngao_contact_verifications_guard();

DROP TRIGGER IF EXISTS push_subscriptions_guard ON "push_subscriptions";
CREATE TRIGGER push_subscriptions_guard BEFORE DELETE ON "push_subscriptions"
  FOR EACH ROW EXECUTE FUNCTION ngao_push_subscriptions_guard();
CREATE TRIGGER push_subscriptions_guard_update BEFORE UPDATE ON "push_subscriptions"
  FOR EACH ROW
  WHEN (NOT ngao_key_rotation_rekey_only(to_jsonb(OLD), to_jsonb(NEW), ARRAY['endpoint_hash', 'endpoint_encrypted', 'keys_encrypted']))
  EXECUTE FUNCTION ngao_push_subscriptions_guard();

-- ---------------------------------------------------------------------------
-- 3. job_runs retention
-- ---------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS "job_runs_finished_at_idx" ON "job_runs"("finished_at") WHERE "finished_at" IS NOT NULL;

DROP TRIGGER IF EXISTS job_runs_guard ON "job_runs";
CREATE TRIGGER job_runs_guard BEFORE UPDATE ON "job_runs"
  FOR EACH ROW EXECUTE FUNCTION ngao_job_runs_guard();
-- A DELETE reaches the guard (which refuses it) unless the purge function is running and the row
-- finished more than 7 days ago.
CREATE TRIGGER job_runs_guard_delete BEFORE DELETE ON "job_runs"
  FOR EACH ROW
  WHEN (NOT (coalesce(current_setting('ngao.job_runs_purge', true), '') = 'on'
             AND OLD.finished_at IS NOT NULL AND OLD.finished_at < now() - interval '7 days'))
  EXECUTE FUNCTION ngao_job_runs_guard();

CREATE OR REPLACE FUNCTION ngao_purge_job_runs(p_before timestamptz, p_limit integer) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  n integer;
BEGIN
  IF p_before IS NULL OR p_before > now() - interval '7 days' THEN
    RAISE EXCEPTION 'job runs younger than 7 days are always kept' USING ERRCODE = 'check_violation';
  END IF;
  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 10000 THEN
    RAISE EXCEPTION 'p_limit must be between 1 and 10000' USING ERRCODE = 'check_violation';
  END IF;
  PERFORM set_config('ngao.job_runs_purge', 'on', true);
  DELETE FROM job_runs WHERE id IN (
    SELECT id FROM job_runs
    WHERE finished_at IS NOT NULL AND finished_at < p_before
    ORDER BY finished_at
    LIMIT p_limit
  );
  GET DIAGNOSTICS n = ROW_COUNT;
  PERFORM set_config('ngao.job_runs_purge', '', true);
  RETURN n;
END
$$;
REVOKE ALL ON FUNCTION ngao_purge_job_runs(timestamptz, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ngao_purge_job_runs(timestamptz, integer) TO ngao_app;

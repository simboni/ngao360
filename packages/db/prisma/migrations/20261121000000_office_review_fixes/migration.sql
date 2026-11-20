-- NGAO360 Office review fixes.
--
-- Redaction of citizen-case personal content (blueprint 15.2: storage
-- limitation and the right to deletion promised in the portal privacy notice).
-- Case descriptions are immutable and the case timeline is append-only, so the
-- only way to remove personal content is the SECURITY DEFINER function below.
-- It leaves a tombstone (redacted_at) and changes nothing else.

ALTER TABLE "citizen_cases" ADD COLUMN "redacted_at" TIMESTAMPTZ(3), ADD COLUMN "redacted_by_id" UUID;
ALTER TABLE "citizen_cases" ADD CONSTRAINT "citizen_cases_redacted_by_id_fkey"
  FOREIGN KEY ("redacted_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "case_events" ADD COLUMN "redacted_at" TIMESTAMPTZ(3);

-- Redaction mode: set (transaction-locally) only inside ngao_redact_citizen_case,
-- which runs as the schema owner. The runtime role cannot use it by setting the
-- GUC itself, because the guards also require a caller other than ngao_app.
CREATE OR REPLACE FUNCTION ngao_case_redaction_active() RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT COALESCE(current_setting('ngao.case_redaction', true), '') = 'on' AND current_user <> 'ngao_app'
$$;

CREATE OR REPLACE FUNCTION ngao_citizen_cases_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
     OR NEW.reference IS DISTINCT FROM OLD.reference
     OR NEW.public_reference IS DISTINCT FROM OLD.public_reference
     OR NEW.source IS DISTINCT FROM OLD.source
     OR NEW.privacy_notice_version IS DISTINCT FROM OLD.privacy_notice_version
     OR NEW.submitted_at IS DISTINCT FROM OLD.submitted_at
     OR NEW.created_by_id IS DISTINCT FROM OLD.created_by_id
     OR (OLD.tracking_code_hash IS NOT NULL AND NEW.tracking_code_hash IS DISTINCT FROM OLD.tracking_code_hash) THEN
    RAISE EXCEPTION 'IMMUTABLE_RECORD: the submitted content and references of a citizen case cannot change'
      USING ERRCODE = 'P0001';
  END IF;
  -- A redaction is permanent.
  IF OLD.redacted_at IS NOT NULL AND (NEW.redacted_at IS DISTINCT FROM OLD.redacted_at OR NEW.redacted_by_id IS DISTINCT FROM OLD.redacted_by_id) THEN
    RAISE EXCEPTION 'IMMUTABLE_RECORD: a redaction cannot be undone' USING ERRCODE = 'P0001';
  END IF;
  IF NEW.redacted_at IS DISTINCT FROM OLD.redacted_at AND NOT ngao_case_redaction_active() THEN
    RAISE EXCEPTION 'IMMUTABLE_RECORD: cases are redacted only through ngao_redact_citizen_case' USING ERRCODE = 'P0001';
  END IF;
  -- The submitted description changes only when a redaction replaces it.
  IF NEW.description IS DISTINCT FROM OLD.description
     AND NOT (ngao_case_redaction_active() AND OLD.redacted_at IS NULL AND NEW.redacted_at IS NOT NULL) THEN
    RAISE EXCEPTION 'IMMUTABLE_RECORD: the submitted content and references of a citizen case cannot change'
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END
$$;

-- case_events stays append-only, except that a redaction may clear the body
-- and the file link of requester-supplied events (once).
DROP TRIGGER IF EXISTS case_events_append_only ON case_events;
CREATE OR REPLACE FUNCTION ngao_case_events_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'IMMUTABLE_RECORD: case timeline events cannot be deleted' USING ERRCODE = 'P0001';
  END IF;
  IF ngao_case_redaction_active()
     AND OLD.redacted_at IS NULL AND NEW.redacted_at IS NOT NULL
     AND NEW.id IS NOT DISTINCT FROM OLD.id
     AND NEW.tenant_id IS NOT DISTINCT FROM OLD.tenant_id
     AND NEW.case_id IS NOT DISTINCT FROM OLD.case_id
     AND NEW.type IS NOT DISTINCT FROM OLD.type
     AND NEW.visibility IS NOT DISTINCT FROM OLD.visibility
     AND NEW.actor_type IS NOT DISTINCT FROM OLD.actor_type
     AND NEW.actor_id IS NOT DISTINCT FROM OLD.actor_id
     AND NEW.from_status IS NOT DISTINCT FROM OLD.from_status
     AND NEW.to_status IS NOT DISTINCT FROM OLD.to_status
     AND NEW.referral_id IS NOT DISTINCT FROM OLD.referral_id
     AND NEW.created_at IS NOT DISTINCT FROM OLD.created_at
     AND (NEW.stored_file_id IS NULL OR NEW.stored_file_id IS NOT DISTINCT FROM OLD.stored_file_id) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'IMMUTABLE_RECORD: the case timeline is append-only' USING ERRCODE = 'P0001';
END
$$;
CREATE TRIGGER case_events_guard BEFORE UPDATE OR DELETE ON case_events
  FOR EACH ROW EXECUTE FUNCTION ngao_case_events_guard();

-- Redact one case of the current tenant. Returns 1 when redacted, 0 when the
-- case is unknown in this tenant or was already redacted. Removes: the
-- description (replaced by p_tombstone), the location text, the title
-- (replaced by p_title), and the body and photo link of every event the
-- requester supplied (submission, feedback, portal photo). Staff-written
-- events, statuses, dates, category and area stay, so the anonymised record of
-- what the office did is kept.
CREATE OR REPLACE FUNCTION ngao_redact_citizen_case(p_case_id uuid, p_actor_id uuid, p_title text, p_tombstone text)
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_tenant uuid := ngao_current_tenant();
  v_count integer;
BEGIN
  IF v_tenant IS NULL THEN
    RAISE EXCEPTION 'FORBIDDEN: tenant context required' USING ERRCODE = 'P0001';
  END IF;
  PERFORM set_config('ngao.case_redaction', 'on', true);
  UPDATE citizen_cases
     SET description = p_tombstone,
         location_description = NULL,
         title = p_title,
         redacted_at = now(),
         redacted_by_id = p_actor_id,
         version = version + 1,
         updated_at = now()
   WHERE id = p_case_id AND tenant_id = v_tenant AND redacted_at IS NULL;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  IF v_count > 0 THEN
    UPDATE case_events
       SET body = CASE WHEN body IS NULL THEN NULL ELSE p_tombstone END,
           stored_file_id = NULL,
           redacted_at = now()
     WHERE case_id = p_case_id AND tenant_id = v_tenant AND actor_type = 'REQUESTER' AND redacted_at IS NULL;
  END IF;
  PERFORM set_config('ngao.case_redaction', 'off', true);
  RETURN v_count;
END
$$;
REVOKE ALL ON FUNCTION ngao_redact_citizen_case(uuid, uuid, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ngao_redact_citizen_case(uuid, uuid, text, text) TO ngao_app;

-- Projects: the evidence a completion verification relied on. If one of these
-- items is later disputed or un-verified and the rest no longer suffice, the
-- verification is withdrawn (blueprint 9.3: verified completion rests on
-- verified documentary evidence, never on a photograph alone).
ALTER TABLE "projects" ADD COLUMN "completion_evidence_ids" UUID[] NOT NULL DEFAULT ARRAY[]::UUID[];

-- Approved (and every later stage) needs a recorded approval authority, so a
-- pledge is never presented as an approved project (blueprint 9.3).
ALTER TABLE "projects" ADD CONSTRAINT "projects_approval_authority_check" CHECK (
  status IN ('PROPOSED', 'COMMITTED', 'CANCELLED')
  OR (approval_authority IS NOT NULL AND btrim(approval_authority) <> '')
) NOT VALID;

-- Pilot security review: privacy and tenancy fixes.
--
-- 1. Walk-in / office appointment contact details can be erased (audited, by request or by the
--    office.retention job after the contact retention period).
-- 2. Agent sensitive data (national ID, phone, M-Pesa, next of kin) can be erased, also for a
--    WITHDRAWN agent, and is erased by the field.agent_retention job.
-- 3. tenants gets row-level security and column-level UPDATE grants for the runtime role:
--    inside a tenant transaction only the own tenant is visible (a PLATFORM tenant sees all, for
--    workspace provisioning) and only the own tenant can be updated, and never its id, slug,
--    type, status, historical_demo or created_at. Without a tenant context (sign-in by
--    organisation code, the public portal, background jobs iterating tenants) rows stay readable
--    but nothing can be updated.

ALTER TABLE "appointments" ADD COLUMN "contact_erased_at" TIMESTAMPTZ(3);
ALTER TABLE "agent_sensitive" ADD COLUMN "erased_at" TIMESTAMPTZ(3);

-- Erased contact details stay erased.
CREATE OR REPLACE FUNCTION ngao_appointment_contact_erased_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.contact_erased_at IS NOT NULL AND (
       NEW.contact_erased_at IS DISTINCT FROM OLD.contact_erased_at
    OR NEW.contact_phone IS NOT NULL
    OR NEW.contact_email IS NOT NULL
    OR NEW.requester_name IS DISTINCT FROM OLD.requester_name
    OR NEW.requester_organisation IS NOT NULL) THEN
    RAISE EXCEPTION 'appointment contact details were erased and cannot be restored' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
DROP TRIGGER IF EXISTS appointments_contact_erased_guard ON "appointments";
CREATE TRIGGER appointments_contact_erased_guard BEFORE UPDATE ON "appointments"
  FOR EACH ROW EXECUTE FUNCTION ngao_appointment_contact_erased_guard();

CREATE OR REPLACE FUNCTION ngao_agent_sensitive_erased_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.erased_at IS NOT NULL AND (
       NEW.erased_at IS DISTINCT FROM OLD.erased_at
    OR NEW.national_id_number IS NOT NULL OR NEW.phone IS NOT NULL OR NEW.mpesa_number IS NOT NULL
    OR NEW.next_of_kin_name IS NOT NULL OR NEW.next_of_kin_phone IS NOT NULL OR NEW.next_of_kin_relationship IS NOT NULL) THEN
    RAISE EXCEPTION 'agent personal data was erased and cannot be restored' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
DROP TRIGGER IF EXISTS agent_sensitive_erased_guard ON "agent_sensitive";
CREATE TRIGGER agent_sensitive_erased_guard BEFORE UPDATE ON "agent_sensitive"
  FOR EACH ROW EXECUTE FUNCTION ngao_agent_sensitive_erased_guard();

-- ---------------------------------------------------------------------------
-- tenants: RLS and column grants
-- ---------------------------------------------------------------------------
-- SECURITY DEFINER (owner bypasses RLS on its own table) so the policy does not recurse.
CREATE OR REPLACE FUNCTION ngao_current_tenant_is_platform() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (SELECT 1 FROM tenants WHERE id = ngao_current_tenant() AND type = 'PLATFORM')
$$;
REVOKE ALL ON FUNCTION ngao_current_tenant_is_platform() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ngao_current_tenant_is_platform() TO ngao_app;

ALTER TABLE "tenants" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenants_read ON "tenants";
DROP POLICY IF EXISTS tenants_update_own ON "tenants";
CREATE POLICY tenants_read ON "tenants" FOR SELECT
  USING (ngao_current_tenant() IS NULL OR id = ngao_current_tenant() OR ngao_current_tenant_is_platform());
CREATE POLICY tenants_update_own ON "tenants" FOR UPDATE
  USING (id = ngao_current_tenant())
  WITH CHECK (id = ngao_current_tenant());

REVOKE UPDATE ON "tenants" FROM ngao_app;
GRANT UPDATE ("display_name", "timezone", "locale", "data_region", "settings", "retention_profile", "updated_at") ON "tenants" TO ngao_app;

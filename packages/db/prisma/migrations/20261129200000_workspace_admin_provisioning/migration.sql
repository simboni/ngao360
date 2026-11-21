-- ============================================================================
-- Workspace administration (owner: workspace-admin; API contract §33.1).
--
-- The runtime role `ngao_app` may read and update tenants but never insert them
-- (20261120000100_rls_and_integrity). S02 lets a platform operator create an
-- organisation over HTTP, so creation goes through one narrow SECURITY DEFINER
-- function instead of a broader grant:
--   * callable only on a connection whose tenant setting (app.tenant_id) is a
--     PLATFORM organisation, i.e. inside withTenant(<platform tenant>);
--   * never creates a PLATFORM organisation;
--   * never sets historical_demo (demo organisations come only from the demo CLI
--     with the owner role), and starts every organisation ACTIVE with the
--     standard retention profile;
--   * validates the slug and that settings is a JSON object.
-- Everything else (roles, modules, setup items, the first administrator, audit)
-- is written by the API as ngao_app under the new tenant's RLS setting.
-- ============================================================================

CREATE OR REPLACE FUNCTION ngao_provision_workspace(
  p_id uuid,
  p_slug text,
  p_name text,
  p_display_name text,
  p_type "TenantType",
  p_timezone text,
  p_locale text,
  p_data_region text,
  p_settings jsonb
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  caller_type "TenantType";
BEGIN
  SELECT t.type INTO caller_type FROM tenants t WHERE t.id = ngao_current_tenant();
  IF caller_type IS DISTINCT FROM 'PLATFORM'::"TenantType" THEN
    RAISE EXCEPTION 'WORKSPACE_PROVISIONING_FORBIDDEN: organisations are created from the platform organisation only'
      USING ERRCODE = 'P0001';
  END IF;
  IF p_type = 'PLATFORM'::"TenantType" THEN
    RAISE EXCEPTION 'WORKSPACE_PROVISIONING_INVALID: a platform organisation cannot be created here' USING ERRCODE = 'P0001';
  END IF;
  IF p_slug IS NULL OR p_slug !~ '^[a-z0-9][a-z0-9-]{1,62}$' THEN
    RAISE EXCEPTION 'WORKSPACE_PROVISIONING_INVALID: slug' USING ERRCODE = 'P0001';
  END IF;
  IF p_name IS NULL OR length(btrim(p_name)) < 2 THEN
    RAISE EXCEPTION 'WORKSPACE_PROVISIONING_INVALID: name' USING ERRCODE = 'P0001';
  END IF;
  IF p_settings IS NULL OR jsonb_typeof(p_settings) <> 'object' THEN
    RAISE EXCEPTION 'WORKSPACE_PROVISIONING_INVALID: settings' USING ERRCODE = 'P0001';
  END IF;

  INSERT INTO tenants (id, slug, name, display_name, type, status, locale, timezone, retention_profile,
                       data_region, settings, historical_demo, created_at, updated_at)
  VALUES (p_id, p_slug, btrim(p_name), p_display_name, p_type, 'ACTIVE', p_locale, p_timezone, 'standard',
          p_data_region, p_settings, false, now(), now());
  RETURN p_id;
END;
$$;

REVOKE ALL ON FUNCTION ngao_provision_workspace(uuid, text, text, text, "TenantType", text, text, text, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ngao_provision_workspace(uuid, text, text, text, "TenantType", text, text, text, jsonb) TO ngao_app;

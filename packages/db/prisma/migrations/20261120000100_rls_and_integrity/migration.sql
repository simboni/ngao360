-- ============================================================================
-- NGAO360: row-level security, append-only/immutability guards, partial unique
-- indexes and runtime-role grants.
--
-- Tenant isolation model
--   * The API connects as role `ngao_app` (not table owner, NOBYPASSRLS).
--   * Each request runs inside a transaction that calls
--       SELECT set_config('app.tenant_id', '<uuid>', true);
--     (see packages/db withTenant()).
--   * Every table with a tenant_id column gets policy `tenant_isolation`
--     comparing tenant_id with that setting. With no setting, no rows match.
--   * The owner role (`ngao`, used by migrations/seed) bypasses RLS because the
--     policies are not FORCEd; it must never be used by the API at runtime.
--
-- New tenant-owned tables in later migrations MUST call:
--     SELECT ngao_enable_tenant_rls('<table_name>');
-- ============================================================================

-- Runtime role (password/LOGIN are set by scripts/db-bootstrap.sql or the
-- docker init script; created here NOLOGIN only if missing so grants apply).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ngao_app') THEN
    CREATE ROLE ngao_app NOLOGIN NOBYPASSRLS;
  END IF;
END
$$;

-- ---------------------------------------------------------------------------
-- Helper: current tenant from the session setting (NULL when unset/empty).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION ngao_current_tenant() RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('app.tenant_id', true), '')::uuid
$$;

-- ---------------------------------------------------------------------------
-- Helper: enable RLS + tenant policy on a table with a tenant_id column.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION ngao_enable_tenant_rls(tbl text) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', tbl);
  EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', tbl);
  EXECUTE format(
    'CREATE POLICY tenant_isolation ON %I USING (tenant_id = ngao_current_tenant()) '
    'WITH CHECK (tenant_id = ngao_current_tenant())',
    tbl
  );
END
$$;

DO $$
DECLARE
  t record;
BEGIN
  FOR t IN
    SELECT c.table_name
    FROM information_schema.columns c
    JOIN information_schema.tables tb
      ON tb.table_name = c.table_name AND tb.table_schema = c.table_schema
    WHERE c.table_schema = current_schema()
      AND c.column_name = 'tenant_id'
      AND tb.table_type = 'BASE TABLE'
  LOOP
    PERFORM ngao_enable_tenant_rls(t.table_name);
  END LOOP;
END
$$;

-- ---------------------------------------------------------------------------
-- Generic guards
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION ngao_reject_modification() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'IMMUTABLE_RECORD: % on % is not permitted (append-only)', TG_OP, TG_TABLE_NAME
    USING ERRCODE = 'P0001';
END
$$;

-- Append-only tables: no UPDATE, DELETE or TRUNCATE.
DO $$
DECLARE
  tbl text;
BEGIN
  FOREACH tbl IN ARRAY ARRAY[
    'audit_events',
    'result_value_changes',
    'discrepancy_case_actions',
    'validation_results'
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

-- Records that may change state but must never be deleted.
DO $$
DECLARE
  tbl text;
BEGIN
  FOREACH tbl IN ARRAY ARRAY[
    'result_submissions',
    'result_values',
    'verifications',
    'discrepancy_cases',
    'discrepancy_case_submissions',
    'tally_exports',
    'ocr_extractions'
  ]
  LOOP
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE DELETE ON %I FOR EACH ROW EXECUTE FUNCTION ngao_reject_modification()',
      tbl || '_no_delete', tbl
    );
  END LOOP;
END
$$;

-- stored_files: immutable original. Only malware scan status may be recorded.
CREATE OR REPLACE FUNCTION ngao_stored_files_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'IMMUTABLE_RECORD: stored files cannot be deleted' USING ERRCODE = 'P0001';
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
     OR NEW.sha256 IS DISTINCT FROM OLD.sha256
     OR NEW.mime_type IS DISTINCT FROM OLD.mime_type
     OR NEW.size_bytes IS DISTINCT FROM OLD.size_bytes
     OR NEW.original_filename IS DISTINCT FROM OLD.original_filename
     OR NEW.purpose IS DISTINCT FROM OLD.purpose
     OR NEW.storage_driver IS DISTINCT FROM OLD.storage_driver
     OR NEW.storage_key IS DISTINCT FROM OLD.storage_key
     OR NEW.page_count IS DISTINCT FROM OLD.page_count
     OR NEW.uploaded_by_id IS DISTINCT FROM OLD.uploaded_by_id
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'IMMUTABLE_RECORD: stored file content and metadata are immutable'
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER stored_files_guard BEFORE UPDATE OR DELETE ON stored_files
  FOR EACH ROW EXECUTE FUNCTION ngao_stored_files_guard();
CREATE TRIGGER stored_files_no_truncate BEFORE TRUNCATE ON stored_files
  FOR EACH STATEMENT EXECUTE FUNCTION ngao_reject_modification();

-- tally_snapshots: immutable; release fields may be set once (NULL -> value).
CREATE OR REPLACE FUNCTION ngao_tally_snapshots_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'IMMUTABLE_RECORD: tally snapshots cannot be deleted' USING ERRCODE = 'P0001';
  END IF;
  IF (to_jsonb(NEW) - 'released_at' - 'released_by_id')
       IS DISTINCT FROM (to_jsonb(OLD) - 'released_at' - 'released_by_id') THEN
    RAISE EXCEPTION 'IMMUTABLE_RECORD: tally snapshot content is immutable; create a new snapshot'
      USING ERRCODE = 'P0001';
  END IF;
  IF OLD.released_at IS NOT NULL AND (
       NEW.released_at IS DISTINCT FROM OLD.released_at
       OR NEW.released_by_id IS DISTINCT FROM OLD.released_by_id) THEN
    RAISE EXCEPTION 'IMMUTABLE_RECORD: snapshot release cannot be changed' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER tally_snapshots_guard BEFORE UPDATE OR DELETE ON tally_snapshots
  FOR EACH ROW EXECUTE FUNCTION ngao_tally_snapshots_guard();

-- result_submissions: source linkage and original metadata are immutable.
CREATE OR REPLACE FUNCTION ngao_result_submissions_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
     OR NEW.reference IS DISTINCT FROM OLD.reference
     OR NEW.source_file_id IS DISTINCT FROM OLD.source_file_id
     OR NEW.submitter_id IS DISTINCT FROM OLD.submitter_id
     OR NEW.original_metadata IS DISTINCT FROM OLD.original_metadata
     OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'IMMUTABLE_RECORD: submission source, submitter and original metadata are immutable'
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER result_submissions_guard BEFORE UPDATE ON result_submissions
  FOR EACH ROW EXECUTE FUNCTION ngao_result_submissions_guard();

-- ---------------------------------------------------------------------------
-- Integrity constraints Prisma cannot express
-- ---------------------------------------------------------------------------

-- One active canonical submission per station + form + contest (cycle is implied by contest).
CREATE UNIQUE INDEX result_submissions_canonical_station_uq
  ON result_submissions (tenant_id, contest_id, form_number, polling_station_id)
  WHERE is_canonical
    AND polling_station_id IS NOT NULL
    AND status NOT IN ('ARCHIVED', 'EXCLUDED_FROM_AGGREGATE');

-- One active canonical submission per tally centre + form + contest.
CREATE UNIQUE INDEX result_submissions_canonical_centre_uq
  ON result_submissions (tenant_id, contest_id, form_number, tally_centre_id)
  WHERE is_canonical
    AND tally_centre_id IS NOT NULL
    AND status NOT IN ('ARCHIVED', 'EXCLUDED_FROM_AGGREGATE');

ALTER TABLE result_submissions
  ADD CONSTRAINT result_submissions_location_ck
  CHECK ((polling_station_id IS NULL) <> (tally_centre_id IS NULL));

-- One current value per (submission, field, candidate) including candidate-less fields.
CREATE UNIQUE INDEX result_values_field_uq
  ON result_values (
    submission_id,
    field_key,
    COALESCE(candidate_reference_id, '00000000-0000-0000-0000-000000000000'::uuid)
  );

ALTER TABLE result_values
  ADD CONSTRAINT result_values_non_negative_ck CHECK (numeric_value IS NULL OR numeric_value >= 0),
  ADD CONSTRAINT result_values_ocr_confidence_ck
    CHECK (ocr_confidence IS NULL OR (ocr_confidence >= 0 AND ocr_confidence <= 1));

ALTER TABLE stored_files
  ADD CONSTRAINT stored_files_sha256_ck CHECK (sha256 ~ '^[a-f0-9]{64}$'),
  ADD CONSTRAINT stored_files_size_ck CHECK (size_bytes >= 0);

ALTER TABLE role_assignments
  ADD CONSTRAINT role_assignments_scope_ck CHECK (
    (scope_type = 'ORGANISATION' AND geographic_unit_id IS NULL AND polling_station_id IS NULL)
    OR (scope_type = 'POLLING_STATION' AND polling_station_id IS NOT NULL)
    OR (scope_type IN ('COUNTY', 'CONSTITUENCY', 'WARD', 'POLLING_CENTRE') AND geographic_unit_id IS NOT NULL)
  ),
  ADD CONSTRAINT role_assignments_expiry_ck CHECK (expires_at IS NULL OR expires_at > valid_from);

ALTER TABLE candidate_references
  ADD CONSTRAINT candidate_references_ballot_order_ck CHECK (ballot_order >= 1);

ALTER TABLE polling_stations
  ADD CONSTRAINT polling_stations_registered_voters_ck
    CHECK (registered_voters IS NULL OR registered_voters >= 0);

ALTER TABLE geographic_units
  ADD CONSTRAINT geographic_units_valid_range_ck CHECK (valid_to IS NULL OR valid_from IS NULL OR valid_to >= valid_from);

-- ---------------------------------------------------------------------------
-- Grants for the runtime role
-- ---------------------------------------------------------------------------
GRANT USAGE ON SCHEMA public TO ngao_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ngao_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ngao_app;
GRANT EXECUTE ON FUNCTION ngao_current_tenant() TO ngao_app;

-- Global catalogue and Prisma bookkeeping: read-only for the API.
REVOKE INSERT, UPDATE, DELETE ON permissions FROM ngao_app;
REVOKE ALL ON _prisma_migrations FROM ngao_app;
-- Tenants: the API may read and update settings, never create or delete tenants.
REVOKE INSERT, DELETE ON tenants FROM ngao_app;

-- Append-only / immutable tables: defence in depth beyond triggers.
REVOKE UPDATE, DELETE, TRUNCATE ON audit_events, result_value_changes, discrepancy_case_actions, validation_results FROM ngao_app;
REVOKE DELETE, TRUNCATE ON stored_files, tally_snapshots, result_submissions, result_values, verifications, discrepancy_cases, discrepancy_case_submissions, tally_exports, ocr_extractions FROM ngao_app;

ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ngao_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO ngao_app;

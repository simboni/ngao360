-- AlterTable
ALTER TABLE "registry_versions" ADD COLUMN     "publication_date" DATE;

-- CreateTable
CREATE TABLE "registry_imports" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "registry_version_id" UUID NOT NULL,
    "source_file_id" UUID,
    "status" TEXT NOT NULL,
    "publication_date" DATE,
    "source_url" TEXT,
    "change_notes" TEXT,
    "report" JSONB,
    "units_created" INTEGER NOT NULL DEFAULT 0,
    "stations_created" INTEGER NOT NULL DEFAULT 0,
    "rows_rejected" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "imported_by_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "registry_imports_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "registry_imports_tenant_id_registry_version_id_created_at_idx" ON "registry_imports"("tenant_id", "registry_version_id", "created_at");

-- AddForeignKey
ALTER TABLE "registry_imports" ADD CONSTRAINT "registry_imports_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "registry_imports" ADD CONSTRAINT "registry_imports_registry_version_id_fkey" FOREIGN KEY ("registry_version_id") REFERENCES "registry_versions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "registry_imports" ADD CONSTRAINT "registry_imports_source_file_id_fkey" FOREIGN KEY ("source_file_id") REFERENCES "stored_files"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "registry_imports" ADD CONSTRAINT "registry_imports_imported_by_id_fkey" FOREIGN KEY ("imported_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ============================================================================
-- Hand-written: tenant isolation, append-only log, reference-data guards.
-- ============================================================================

-- registry_imports: tenant-owned, append-only (import lifecycle + validation report).
SELECT ngao_enable_tenant_rls('registry_imports');
GRANT SELECT, INSERT ON registry_imports TO ngao_app;
REVOKE UPDATE, DELETE, TRUNCATE ON registry_imports FROM ngao_app;
CREATE TRIGGER registry_imports_append_only BEFORE UPDATE OR DELETE ON registry_imports
  FOR EACH ROW EXECUTE FUNCTION ngao_reject_modification();
CREATE TRIGGER registry_imports_no_truncate BEFORE TRUNCATE ON registry_imports
  FOR EACH STATEMENT EXECUTE FUNCTION ngao_reject_modification();

-- registry_versions: APPROVED and SUPERSEDED versions are immutable. The only change
-- allowed is APPROVED -> SUPERSEDED when a newer version is approved.
CREATE OR REPLACE FUNCTION ngao_registry_versions_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status IN ('APPROVED', 'SUPERSEDED') THEN
    IF TG_OP = 'DELETE' THEN
      RAISE EXCEPTION 'IMMUTABLE_RECORD: approved registry versions cannot be deleted' USING ERRCODE = 'P0001';
    END IF;
    IF (to_jsonb(NEW) - 'status') IS DISTINCT FROM (to_jsonb(OLD) - 'status')
       OR NOT (NEW.status = OLD.status OR (OLD.status = 'APPROVED' AND NEW.status = 'SUPERSEDED')) THEN
      RAISE EXCEPTION 'IMMUTABLE_RECORD: registry version % is %; create a new version', OLD.version, OLD.status
        USING ERRCODE = 'P0001';
    END IF;
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER registry_versions_guard BEFORE UPDATE OR DELETE ON registry_versions
  FOR EACH ROW EXECUTE FUNCTION ngao_registry_versions_guard();

-- polling_stations: rows may only be added, changed or removed while their registry
-- version is DRAFT. Identical re-writes (e.g. an idempotent seed) are allowed.
-- SECURITY DEFINER so the status lookup is not affected by the caller's RLS context.
CREATE OR REPLACE FUNCTION ngao_polling_stations_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  old_status text;
  new_status text;
BEGIN
  IF TG_OP IN ('UPDATE', 'DELETE') THEN
    SELECT status::text INTO old_status FROM registry_versions WHERE id = OLD.registry_version_id;
  END IF;
  IF TG_OP IN ('INSERT', 'UPDATE') THEN
    SELECT status::text INTO new_status FROM registry_versions WHERE id = NEW.registry_version_id;
  END IF;
  IF TG_OP = 'UPDATE'
     AND (to_jsonb(NEW) - 'updated_at') IS NOT DISTINCT FROM (to_jsonb(OLD) - 'updated_at') THEN
    RETURN NEW;
  END IF;
  IF (old_status IS NOT NULL AND old_status <> 'DRAFT') OR (new_status IS NOT NULL AND new_status <> 'DRAFT') THEN
    RAISE EXCEPTION 'IMMUTABLE_RECORD: polling stations can only change in a DRAFT registry version'
      USING ERRCODE = 'P0001';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION ngao_polling_stations_guard() FROM PUBLIC;
CREATE TRIGGER polling_stations_guard BEFORE INSERT OR UPDATE OR DELETE ON polling_stations
  FOR EACH ROW EXECUTE FUNCTION ngao_polling_stations_guard();

-- form_templates: APPROVED and RETIRED templates are immutable. Allowed: APPROVED -> RETIRED
-- (with notes / updated_at). Changes become a new template version.
CREATE OR REPLACE FUNCTION ngao_form_templates_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.approval_state IN ('APPROVED', 'RETIRED') THEN
    IF TG_OP = 'DELETE' THEN
      RAISE EXCEPTION 'IMMUTABLE_RECORD: approved form templates cannot be deleted' USING ERRCODE = 'P0001';
    END IF;
    IF (to_jsonb(NEW) - 'approval_state' - 'notes' - 'updated_at')
         IS DISTINCT FROM (to_jsonb(OLD) - 'approval_state' - 'notes' - 'updated_at')
       OR NOT (NEW.approval_state = OLD.approval_state
               OR (OLD.approval_state = 'APPROVED' AND NEW.approval_state = 'RETIRED')) THEN
      RAISE EXCEPTION 'IMMUTABLE_RECORD: form template % v% is %; create a new version',
        OLD.form_number, OLD.version, OLD.approval_state USING ERRCODE = 'P0001';
    END IF;
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER form_templates_guard BEFORE UPDATE OR DELETE ON form_templates
  FOR EACH ROW EXECUTE FUNCTION ngao_form_templates_guard();

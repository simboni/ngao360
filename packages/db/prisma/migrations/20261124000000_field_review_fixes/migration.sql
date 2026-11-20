-- Field review fixes.

-- 1. Station-scoped grants follow a code edit of their station.
--    polling_stations.code can change while its registry version is DRAFT. The
--    copy on role_assignments (lineage key of the grant) must follow, otherwise
--    after approval the grant would match whichever station now holds the old code.
CREATE OR REPLACE FUNCTION ngao_polling_stations_code_to_grants() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.code IS DISTINCT FROM OLD.code THEN
    UPDATE role_assignments
       SET polling_station_code = NEW.code
     WHERE polling_station_id = NEW.id;
  END IF;
  RETURN NULL;
END
$$;
CREATE TRIGGER polling_stations_code_to_grants
  AFTER UPDATE OF code ON "polling_stations"
  FOR EACH ROW EXECUTE FUNCTION ngao_polling_stations_code_to_grants();

-- 2. Upload claims for content-addressed field files.
--    stored_files is unique on (tenant_id, sha256): identical bytes uploaded by a
--    second person return the first person's row. Each uploader gets a claim, and
--    field evidence is authorised by claim rather than by stored_files.uploaded_by_id.
CREATE TABLE "field_file_claims" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "stored_file_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "purpose" "StoredFilePurpose" NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "field_file_claims_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "field_file_claims_tenant_id_stored_file_id_user_id_purpose_key"
  ON "field_file_claims"("tenant_id", "stored_file_id", "user_id", "purpose");
CREATE INDEX "field_file_claims_tenant_id_user_id_idx" ON "field_file_claims"("tenant_id", "user_id");
ALTER TABLE "field_file_claims" ADD CONSTRAINT "field_file_claims_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "field_file_claims" ADD CONSTRAINT "field_file_claims_stored_file_id_fkey"
  FOREIGN KEY ("stored_file_id") REFERENCES "stored_files"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "field_file_claims" ADD CONSTRAINT "field_file_claims_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

SELECT ngao_enable_tenant_rls('field_file_claims');
GRANT SELECT, INSERT ON field_file_claims TO ngao_app;
REVOKE UPDATE, DELETE, TRUNCATE ON field_file_claims FROM ngao_app;
CREATE TRIGGER field_file_claims_no_update BEFORE UPDATE ON field_file_claims
  FOR EACH ROW EXECUTE FUNCTION ngao_reject_modification();
CREATE TRIGGER field_file_claims_no_delete BEFORE DELETE ON field_file_claims
  FOR EACH ROW EXECUTE FUNCTION ngao_reject_modification();
CREATE TRIGGER field_file_claims_no_truncate BEFORE TRUNCATE ON field_file_claims
  FOR EACH STATEMENT EXECUTE FUNCTION ngao_reject_modification();

-- Existing field files: the first uploader's claim.
INSERT INTO field_file_claims (id, tenant_id, stored_file_id, user_id, purpose, created_at)
SELECT gen_random_uuid(), sf.tenant_id, sf.id, sf.uploaded_by_id, sf.purpose, sf.created_at
  FROM stored_files sf
 WHERE sf.purpose IN ('FIELD_EVIDENCE', 'AGENT_DOCUMENT') AND sf.uploaded_by_id IS NOT NULL
ON CONFLICT DO NOTHING;

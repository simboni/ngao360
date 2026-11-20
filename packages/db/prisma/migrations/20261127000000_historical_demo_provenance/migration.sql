-- Historical demo provenance (docs/DEMO_2022.md, DECISIONS.md update 2026-11-20).
--
-- 1. A cycle kind HISTORICAL_DEMO for demos built on historical (2022) data in which some or all
--    figures are simulated, plus a `contains_simulated_data` flag and free-text provenance notes on
--    every cycle. Every screen, snapshot and export of such a cycle carries the label
--    "HISTORICAL DEMO / SIMULATED DATA" in addition to the parallel-tally disclaimer.
-- 2. A tenant-level `historical_demo` marker so the web shell labels every screen of a demo tenant.
-- 3. Display holds on stored result-form images that may show personal data (presiding officers' and
--    agents' names and signatures on real scans): such an image is not shown until a redacted copy is
--    attached. The original is never altered.
--
-- The labels can only be added, never removed: the triggers below refuse to clear them, also for the
-- owner role.

ALTER TYPE "DataProvenance" ADD VALUE IF NOT EXISTS 'HISTORICAL_DEMO';

ALTER TABLE "election_cycles"
  ADD COLUMN "contains_simulated_data" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "provenance_notes" TEXT;

ALTER TABLE "tenants" ADD COLUMN "historical_demo" BOOLEAN NOT NULL DEFAULT false;

CREATE OR REPLACE FUNCTION ngao_guard_cycle_demo_label() RETURNS trigger AS $$
BEGIN
  IF OLD.data_provenance::text = 'HISTORICAL_DEMO' AND NEW.data_provenance::text <> 'HISTORICAL_DEMO' THEN
    RAISE EXCEPTION 'IMMUTABLE_RECORD: a historical demo election cycle keeps its provenance label'
      USING ERRCODE = 'P0001';
  END IF;
  IF OLD.contains_simulated_data AND NOT NEW.contains_simulated_data THEN
    RAISE EXCEPTION 'IMMUTABLE_RECORD: the simulated-data label of an election cycle cannot be removed'
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER election_cycles_demo_label_guard
  BEFORE UPDATE ON "election_cycles"
  FOR EACH ROW EXECUTE FUNCTION ngao_guard_cycle_demo_label();

CREATE OR REPLACE FUNCTION ngao_guard_tenant_demo_label() RETURNS trigger AS $$
BEGIN
  IF OLD.historical_demo AND NOT NEW.historical_demo THEN
    RAISE EXCEPTION 'IMMUTABLE_RECORD: the historical demo label of an organisation cannot be removed'
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER tenants_demo_label_guard
  BEFORE UPDATE ON "tenants"
  FOR EACH ROW EXECUTE FUNCTION ngao_guard_tenant_demo_label();

-- Display holds for result-form images ------------------------------------------------------------

CREATE TABLE "stored_file_display_holds" (
  "id" UUID NOT NULL,
  "tenant_id" UUID NOT NULL,
  "stored_file_id" UUID NOT NULL,
  "reason" TEXT NOT NULL,
  "redacted_file_id" UUID,
  "redacted_by_id" UUID,
  "redacted_at" TIMESTAMPTZ(3),
  "created_by_id" UUID NOT NULL,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "stored_file_display_holds_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "stored_file_display_holds_redacted_differs" CHECK ("redacted_file_id" IS NULL OR "redacted_file_id" <> "stored_file_id"),
  CONSTRAINT "stored_file_display_holds_redaction_complete" CHECK (("redacted_file_id" IS NULL) = ("redacted_at" IS NULL) AND ("redacted_file_id" IS NULL) = ("redacted_by_id" IS NULL))
);

CREATE UNIQUE INDEX "stored_file_display_holds_tenant_id_stored_file_id_key" ON "stored_file_display_holds"("tenant_id", "stored_file_id");

ALTER TABLE "stored_file_display_holds" ADD CONSTRAINT "stored_file_display_holds_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "stored_file_display_holds" ADD CONSTRAINT "stored_file_display_holds_stored_file_id_fkey" FOREIGN KEY ("stored_file_id") REFERENCES "stored_files"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "stored_file_display_holds" ADD CONSTRAINT "stored_file_display_holds_redacted_file_id_fkey" FOREIGN KEY ("redacted_file_id") REFERENCES "stored_files"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "stored_file_display_holds" ADD CONSTRAINT "stored_file_display_holds_redacted_by_id_fkey" FOREIGN KEY ("redacted_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "stored_file_display_holds" ADD CONSTRAINT "stored_file_display_holds_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

SELECT ngao_enable_tenant_rls('stored_file_display_holds');

-- A hold is never deleted, and the only change is attaching the redacted copy once.
CREATE OR REPLACE FUNCTION ngao_guard_display_hold() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'IMMUTABLE_RECORD: display holds cannot be deleted' USING ERRCODE = 'P0001';
  END IF;
  IF OLD.redacted_file_id IS NOT NULL
     OR NEW.id <> OLD.id OR NEW.tenant_id <> OLD.tenant_id OR NEW.stored_file_id <> OLD.stored_file_id
     OR NEW.reason <> OLD.reason OR NEW.created_by_id <> OLD.created_by_id OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'IMMUTABLE_RECORD: a display hold only changes once, when its redacted copy is attached'
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER stored_file_display_holds_guard
  BEFORE UPDATE OR DELETE ON "stored_file_display_holds"
  FOR EACH ROW EXECUTE FUNCTION ngao_guard_display_hold();

GRANT SELECT, INSERT, UPDATE ON "stored_file_display_holds" TO ngao_app;
REVOKE DELETE, TRUNCATE ON "stored_file_display_holds" FROM ngao_app;

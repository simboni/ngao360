-- Station lineage (docs/STATUS.md registry gap).
--
-- A registry amendment (a new APPROVED registry version) creates new polling
-- station rows with new ids and the same station codes. Polling-station-scoped
-- grants, dashboard "stations with forms" counts and intake duplicate detection
-- therefore key on (election cycle, station code) instead of the row id.

-- Role assignments keep the station row they were made on (foreign key) and
-- carry its code, so the grant follows the code across registry versions of
-- the station's cycle.
ALTER TABLE "role_assignments" ADD COLUMN "polling_station_code" TEXT;

UPDATE "role_assignments" ra
   SET "polling_station_code" = ps."code"
  FROM "polling_stations" ps
 WHERE ps."id" = ra."polling_station_id";

CREATE INDEX "role_assignments_tenant_id_polling_station_code_idx"
  ON "role_assignments"("tenant_id", "polling_station_code");

-- Lookups by code within a cycle (lineage matching).
CREATE INDEX "polling_stations_tenant_id_election_cycle_id_code_idx"
  ON "polling_stations"("tenant_id", "election_cycle_id", "code");

-- The code is always derived from the station row; callers cannot set a code
-- that disagrees with the station they granted.
CREATE OR REPLACE FUNCTION ngao_role_assignments_station_code() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.polling_station_id IS NULL THEN
    NEW.polling_station_code := NULL;
  ELSE
    SELECT ps.code INTO NEW.polling_station_code FROM polling_stations ps WHERE ps.id = NEW.polling_station_id;
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER role_assignments_station_code
  BEFORE INSERT OR UPDATE OF polling_station_id, polling_station_code ON "role_assignments"
  FOR EACH ROW EXECUTE FUNCTION ngao_role_assignments_station_code();

ALTER TABLE "role_assignments"
  ADD CONSTRAINT role_assignments_station_code_check
  CHECK (scope_type <> 'POLLING_STATION' OR polling_station_code IS NOT NULL);

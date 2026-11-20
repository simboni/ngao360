-- Field and election operations, integration pass.
-- War Room and readiness roll-ups select the approved registry's active
-- stations by (tenant, registry version, status); at 55k stations under RLS
-- this index gives the planner a cheap path and a better row estimate
-- (docs/CHANGE_REQUESTS.md, Field: API item 8).
CREATE INDEX IF NOT EXISTS "polling_stations_tenant_id_registry_version_id_status_idx"
  ON "polling_stations" ("tenant_id", "registry_version_id", "status");

ANALYZE "polling_stations";

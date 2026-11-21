#!/usr/bin/env bash
# Runs the load test against the dedicated load database (scripts/load/setup-load-db.sh first):
#   1. writes the id context for the driver from the load database
#   2. starts a private Redis (port LOAD_REDIS_PORT, default 6380) so queues never mix with development
#   3. starts the API (PROCESS_ROLE=api, port LOAD_API_PORT, default 4100) and a separate worker
#      (PROCESS_ROLE=worker), both on the load database, from the built apps/api/dist
#   4. runs scripts/load/run-load.mjs and writes .load/results-<timestamp>.json
#   5. stops everything
#
#   set -a; . ./.env; set +a; pnpm --filter @ngao360/api build; scripts/load/run-load.sh
#
# Load-only overrides: the per-IP global limit is raised (one client IP drives every virtual user here;
# in production the limit applies per real client IP), access tokens live an hour.
set -Eeuo pipefail
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
LOAD_DB="${LOAD_DB:-ngao360_load}"
[[ "$LOAD_DB" == *load* ]] || { echo "LOAD_DB must contain 'load'" >&2; exit 1; }
: "${DATABASE_URL:?}" "${APP_DATABASE_URL:?}"
OWNER_URL="$(echo "${DATABASE_URL%%\?*}" | sed -E "s#/[^/]+\$#/$LOAD_DB#")"
APP_URL="$(echo "${APP_DATABASE_URL%%\?*}" | sed -E "s#/[^/]+\$#/$LOAD_DB#")"
PORT="${LOAD_API_PORT:-4100}"
REDIS_PORT="${LOAD_REDIS_PORT:-6380}"
OUTDIR="$REPO_ROOT/.load"
mkdir -p "$OUTDIR/storage"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
log() { printf '%s load: %s\n' "$(date -u +%H:%M:%S)" "$*" >&2; }

# 1. Context.
psql -X -At "$OWNER_URL" > "$OUTDIR/context.json" <<'SQL'
SELECT json_build_object(
  'tenantSlug', 'demo',
  'cycleId', c.id, 'contestId', ct.id, 'templateId', ft.id,
  'intakeStationIds', (SELECT json_agg(id) FROM (
      SELECT ps.id FROM polling_stations ps JOIN registry_versions r ON r.id = ps.registry_version_id AND r.status = 'APPROVED'
      WHERE r.tenant_id = t.id AND ps.code LIKE 'LD-%'
        AND NOT EXISTS (SELECT 1 FROM result_submissions rs WHERE rs.polling_station_id = ps.id)
      ORDER BY ps.code LIMIT 5000) x),
  'openingTemplateId', (SELECT frt.id FROM field_report_templates frt WHERE frt.tenant_id = t.id AND frt.report_type = 'OPENING_OF_POLLS' AND frt.status = 'ACTIVE' ORDER BY frt.version DESC LIMIT 1),
  'openingAnswers', (SELECT fr.answers FROM field_reports fr WHERE fr.tenant_id = t.id AND fr.report_type = 'OPENING_OF_POLLS' AND fr.reference NOT LIKE 'LOAD-%' ORDER BY fr.received_at LIMIT 1),
  'agentStationCode', (SELECT ra.polling_station_code FROM role_assignments ra JOIN users u ON u.id = ra.user_id WHERE u.email = 'agent1@demo.example.org' AND ra.revoked_at IS NULL LIMIT 1),
  'loadAgents', (SELECT json_agg(json_build_object('email', u.email, 'code', ra.polling_station_code) ORDER BY u.email)
      FROM users u JOIN role_assignments ra ON ra.user_id = u.id AND ra.revoked_at IS NULL
      WHERE u.tenant_id = t.id AND u.email LIKE 'load.agent%')
)
FROM tenants t
JOIN election_cycles c ON c.tenant_id = t.id AND c.name = '2027 General Election'
JOIN contests ct ON ct.tenant_id = t.id AND ct.election_cycle_id = c.id AND ct.office_type = 'GOVERNOR'
JOIN form_templates ft ON ft.tenant_id = t.id AND ft.election_cycle_id = c.id AND ft.form_number = '37A' AND ft.approval_state = 'APPROVED'
WHERE t.slug = 'demo';
SQL

# 2. Private Redis.
redis-server --port "$REDIS_PORT" --save '' --appendonly no --daemonize yes --pidfile "$OUTDIR/redis.pid" --logfile "$OUTDIR/redis.log"
PIDS=()
cleanup() {
  for p in "${PIDS[@]+"${PIDS[@]}"}"; do kill "$p" 2>/dev/null || true; done
  wait 2>/dev/null || true
  redis-cli -p "$REDIS_PORT" shutdown nosave >/dev/null 2>&1 || true
}
trap cleanup EXIT

# 3. API + worker.
common_env=(
  NODE_ENV=production COOKIE_SECURE=true
  DATABASE_URL="$OWNER_URL?schema=public" APP_DATABASE_URL="$APP_URL?schema=public&connection_limit=${LOAD_DB_POOL:-20}"
  REDIS_URL="redis://127.0.0.1:$REDIS_PORT" QUEUES_ENABLED=true JOBS_ENABLED=true RATE_LIMIT_STORE=redis
  STORAGE_DRIVER=local STORAGE_LOCAL_ROOT="$OUTDIR/storage"
  RATE_LIMIT_MAX=1000000 AUTH_RATE_LIMIT_MAX=1000 JWT_ACCESS_TTL_SECONDS=3600
  API_PORT="$PORT" API_PUBLIC_URL="http://127.0.0.1:$PORT" WEB_ORIGIN="http://127.0.0.1:3100"
  MESSAGING_ENCRYPTION_KEY="${MESSAGING_ENCRYPTION_KEY:-$(head -c 32 /dev/urandom | base64)}"
  MESSAGING_HASH_KEY="${MESSAGING_HASH_KEY:-$(head -c 48 /dev/urandom | base64)}"
  AGENT_DATA_KEY="${AGENT_DATA_KEY:-$(head -c 32 /dev/urandom | base64)}"
  EMAIL_PROVIDER=log SMS_PROVIDER=log PUSH_PROVIDER=log MALWARE_SCANNER=none CAPTCHA_PROVIDER=none
)
cd "$REPO_ROOT/apps/api"
# LOAD_API_INSTANCES API processes on consecutive ports (horizontal scaling; the driver round-robins).
INSTANCES="${LOAD_API_INSTANCES:-1}"
API_URLS=()
for i in $(seq 0 $((INSTANCES - 1))); do
  p=$((PORT + i))
  env "${common_env[@]}" API_PORT="$p" PROCESS_ROLE=api node ${LOAD_API_NODE_ARGS:-} dist/main.js > "$OUTDIR/api-$STAMP-$i.log" 2>&1 &
  PIDS+=($!)
  API_URLS+=("http://127.0.0.1:$p/api")
done
env "${common_env[@]}" PROCESS_ROLE=worker WORKER_HEARTBEAT_FILE="$OUTDIR/worker.alive" node dist/worker.js > "$OUTDIR/worker-$STAMP.log" 2>&1 &
PIDS+=($!)
for u in "${API_URLS[@]}"; do
  for _ in $(seq 1 60); do
    curl -fsS "$u/health" >/dev/null 2>&1 && break
    sleep 1
  done
  curl -fsS "$u/health" >/dev/null || { tail -20 "$OUTDIR"/api-"$STAMP"-*.log >&2; exit 1; }
done
log "$INSTANCES API instance(s) from :$PORT (PROCESS_ROLE=api) with a separate worker; load database $LOAD_DB"

# 4. Drive.
LOAD_API="$(IFS=,; echo "${API_URLS[*]}")" LOAD_CONTEXT="$OUTDIR/context.json" LOAD_OUT="$OUTDIR/results-$STAMP.json" \
  LOAD_SECRETS_FILE="$OUTDIR/totp-secrets.json" node "$REPO_ROOT/scripts/load/run-load.mjs"
log "results: $OUTDIR/results-$STAMP.json"

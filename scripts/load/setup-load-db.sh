#!/usr/bin/env bash
# Creates (or recreates) the dedicated load-test database and fills it with synthetic data:
# migrations, the standard synthetic seed with pre-enrolled demo TOTP, then scripts/load/seed-load.sql
# (~55,000 stations, ~45,000 result forms, ~49,000 deployments, ~63,000 field reports).
#
#   LOAD_DB=ngao360_load scripts/load/setup-load-db.sh            # uses DATABASE_URL's host and owner role
#
# Refuses to touch a database whose name does not contain "load". Never run on a real deployment.
set -Eeuo pipefail
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
LOAD_DB="${LOAD_DB:-ngao360_load}"
STATIONS="${LOAD_STATIONS:-55000}"
[[ "$LOAD_DB" == *load* ]] || { echo "LOAD_DB must contain 'load' (got $LOAD_DB)" >&2; exit 1; }
: "${DATABASE_URL:?set DATABASE_URL (owner role)}"
base="${DATABASE_URL%%\?*}"; base="${base%/*}"
OWNER_URL="$base/$LOAD_DB"
STORAGE="${LOAD_STORAGE_ROOT:-$REPO_ROOT/.load/storage}"

log() { printf '%s load-setup: %s\n' "$(date -u +%H:%M:%S)" "$*" >&2; }
t0=$(date +%s)
psql -X -q "$base/postgres" -c "DROP DATABASE IF EXISTS \"$LOAD_DB\" WITH (FORCE)" -c "CREATE DATABASE \"$LOAD_DB\""
log "migrating $LOAD_DB"
(cd "$REPO_ROOT/packages/db" && DATABASE_URL="$OWNER_URL?schema=public" npx prisma migrate deploy >/dev/null)
log "standard synthetic seed (pre-enrolled demo TOTP)"
mkdir -p "$STORAGE"
seed() {
  (cd "$REPO_ROOT/packages/db" && env -u NODE_ENV DATABASE_URL="$OWNER_URL?schema=public" SEED_DEMO_MFA=preenrolled SEED_STORAGE_ROOT="$STORAGE" \
    npx tsx src/seed/index.ts > "$REPO_ROOT/.load/seed.log" 2>&1)
}
mkdir -p "$REPO_ROOT/.load"
# Known seed issue on a FRESH database (docs/OPERATIONS.md): the campaign ledger seed stops at the
# CLEAN-document approval check; a second run skips the partial campaign data and completes the rest.
seed || { log "seed stopped (known campaign ledger issue on a fresh database); re-running"; seed; }
log "load data ($STATIONS stations)"
t1=$(date +%s)
psql -X -q "$OWNER_URL" -v stations="$STATIONS" -f "$REPO_ROOT/scripts/load/seed-load.sql"
log "done: seed-load.sql $(( $(date +%s) - t1 )) s, total $(( $(date +%s) - t0 )) s, database $(psql -X -At "$OWNER_URL" -c "SELECT pg_size_pretty(pg_database_size(current_database()))")"

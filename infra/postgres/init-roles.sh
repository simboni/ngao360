#!/usr/bin/env bash
# Runs once on first container start (docker-entrypoint-initdb.d).
# ngao_app is the runtime API role: not owner, NOBYPASSRLS, so RLS is enforced.
# With NGAO_OWNER_DB_PASSWORD set (docker-compose.prod.yml), a separate NON-superuser role
# ngao_owner becomes the database owner and runs the migrations, so no application container ever
# holds superuser credentials (POSTGRES_USER stays for break-glass administration only).
# Without it (development compose), POSTGRES_USER owns the schema and runs migrations.
set -euo pipefail
: "${NGAO_APP_DB_PASSWORD:?NGAO_APP_DB_PASSWORD must be set}"
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
  -v app_password="$NGAO_APP_DB_PASSWORD" <<'SQL'
SELECT format('CREATE ROLE ngao_app LOGIN NOBYPASSRLS PASSWORD %L', :'app_password')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ngao_app') \gexec
SELECT format('GRANT CONNECT ON DATABASE %I TO ngao_app', current_database()) \gexec
SQL

if [ -n "${NGAO_OWNER_DB_PASSWORD:-}" ]; then
  psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
    -v owner_password="$NGAO_OWNER_DB_PASSWORD" <<'SQL'
SELECT format('CREATE ROLE ngao_owner LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD %L', :'owner_password')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ngao_owner') \gexec
-- Database owner => member of pg_database_owner => may create in schema public (PostgreSQL 15+).
SELECT format('ALTER DATABASE %I OWNER TO ngao_owner', current_database()) \gexec
SQL
fi

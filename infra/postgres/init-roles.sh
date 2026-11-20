#!/usr/bin/env bash
# Runs once on first container start (docker-entrypoint-initdb.d).
# POSTGRES_USER (ngao) owns the schema and runs migrations.
# ngao_app is the runtime API role: not owner, NOBYPASSRLS, so RLS is enforced.
set -euo pipefail
: "${NGAO_APP_DB_PASSWORD:?NGAO_APP_DB_PASSWORD must be set}"
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
  -v app_password="$NGAO_APP_DB_PASSWORD" <<'SQL'
SELECT format('CREATE ROLE ngao_app LOGIN NOBYPASSRLS PASSWORD %L', :'app_password')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ngao_app') \gexec
SELECT format('GRANT CONNECT ON DATABASE %I TO ngao_app', current_database()) \gexec
SQL

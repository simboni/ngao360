-- Creates the NGAO360 database roles. Run once per Postgres cluster as a superuser:
--   psql -v owner_password=... -v app_password=... -f scripts/db-bootstrap.sql
--
-- ngao      : schema owner; runs migrations and seed (DATABASE_URL). Bypasses RLS as table owner.
-- ngao_app  : runtime API role (APP_DATABASE_URL). Not owner, no BYPASSRLS: RLS is enforced.
\set ON_ERROR_STOP on
\if :{?owner_password}
\else
  \set owner_password ngao_dev_owner
\endif
\if :{?app_password}
\else
  \set app_password ngao_dev_app
\endif

SELECT format('CREATE ROLE ngao LOGIN CREATEDB PASSWORD %L', :'owner_password')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ngao') \gexec
SELECT format('CREATE ROLE ngao_app LOGIN NOBYPASSRLS PASSWORD %L', :'app_password')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ngao_app') \gexec

SELECT 'CREATE DATABASE ngao360 OWNER ngao'
WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = 'ngao360') \gexec
SELECT 'CREATE DATABASE ngao360_test OWNER ngao'
WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = 'ngao360_test') \gexec

GRANT CONNECT ON DATABASE ngao360 TO ngao_app;
GRANT CONNECT ON DATABASE ngao360_test TO ngao_app;

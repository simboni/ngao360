#!/bin/sh
# One-shot MinIO initialisation for docker-compose.prod.yml (runs in the minio/mc image).
#  - originals bucket created WITH Object Lock (only possible at creation; implies versioning)
#  - default retention COMPLIANCE for S3_OBJECT_LOCK_DAYS (the API also sets it on every write)
#  - private bucket (no anonymous access)
#  - a scoped application user that can write and read objects but has no delete permission,
#    and a read-only backup user. The MinIO root credentials are never given to the API.
# Idempotent: re-running keeps the existing bucket and users (passwords are reset to the env values).
set -eu
: "${MINIO_ROOT_USER:?}" "${MINIO_ROOT_PASSWORD:?}" "${S3_BUCKET:?}" "${S3_APP_ACCESS_KEY_ID:?}" "${S3_APP_SECRET_ACCESS_KEY:?}"
DAYS="${S3_OBJECT_LOCK_DAYS:-2555}"
MODE="${S3_OBJECT_LOCK_MODE:-COMPLIANCE}"

mc alias set ngao http://minio:9000 "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD" >/dev/null

if mc ls "ngao/$S3_BUCKET" >/dev/null 2>&1; then
  if ! mc retention info --default "ngao/$S3_BUCKET" >/dev/null 2>&1; then
    echo "Bucket $S3_BUCKET exists WITHOUT Object Lock. Object Lock can only be enabled at creation:" >&2
    echo "create a new locked bucket and migrate (see docs/RUNBOOKS.md, 'Object Lock')." >&2
    exit 1
  fi
else
  mc mb --with-lock "ngao/$S3_BUCKET"
fi
mc retention set --default "$MODE" "${DAYS}d" "ngao/$S3_BUCKET"
mc anonymous set none "ngao/$S3_BUCKET"

sed "s/BUCKET/$S3_BUCKET/g" /deploy/minio/app-policy.json > /tmp/app-policy.json
sed "s/BUCKET/$S3_BUCKET/g" /deploy/minio/backup-policy.json > /tmp/backup-policy.json
mc admin policy create ngao ngao-app /tmp/app-policy.json
mc admin policy create ngao ngao-backup /tmp/backup-policy.json
mc admin user add ngao "$S3_APP_ACCESS_KEY_ID" "$S3_APP_SECRET_ACCESS_KEY"
mc admin policy attach ngao ngao-app --user "$S3_APP_ACCESS_KEY_ID" 2>/dev/null || true
if [ -n "${S3_BACKUP_ACCESS_KEY_ID:-}" ] && [ -n "${S3_BACKUP_SECRET_ACCESS_KEY:-}" ]; then
  mc admin user add ngao "$S3_BACKUP_ACCESS_KEY_ID" "$S3_BACKUP_SECRET_ACCESS_KEY"
  mc admin policy attach ngao ngao-backup --user "$S3_BACKUP_ACCESS_KEY_ID" 2>/dev/null || true
fi
echo "MinIO ready: bucket $S3_BUCKET, Object Lock $MODE ${DAYS}d, app user without delete."

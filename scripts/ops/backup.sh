#!/usr/bin/env bash
# NGAO360 logical backup: a consistent pg_dump (custom format) plus, from the SAME database snapshot,
# exact row counts per table, the audit chain digest, the RLS table list and a storage manifest
# (every stored_files row with its SHA-256), and for the local storage driver a copy of the blobs.
#
#   DATABASE_URL=postgresql://ngao:...@host:5432/ngao360 BACKUP_DIR=/srv/backups scripts/ops/backup.sh
#
# Environment:
#   DATABASE_URL         owner connection (schema owner `ngao`; reads every tenant). Or the libpq PG* variables.
#   BACKUP_DIR           where to write ngao360-<UTC timestamp>/ (default ./backups)
#   STORAGE_DRIVER       local | s3 (default local)
#   STORAGE_LOCAL_ROOT   local storage root (default apps/api/storage); a relative path is resolved
#                        against apps/api, the API's working directory (as `./storage` in .env is)
#   BACKUP_COPY_BLOBS    true | false: copy local blobs into the backup (default true for local)
#   BACKUP_VERIFY_BLOBS  all | none | <N>: re-hash local blobs against the database while backing up (default all)
#   BACKUP_RETENTION_DAYS  delete backup folders older than this many days (default 0 = keep all)
#   BACKUP_ALLOW_MISSING_BLOBS  true to finish (exit 0) although originals are missing from storage; they are
#                        listed in blobs-missing.txt and the restore drill reports them (default false: fail)
#
# Never prints secrets: the connection string is passed to libpq only. Exit status is non-zero on any
# failure (including a blob whose bytes do not match its recorded SHA-256).
set -Eeuo pipefail
umask 077

log() { printf '%s backup: %s\n' "$(date -u +%H:%M:%S)" "$*" >&2; }
die() { log "ERROR: $*"; exit 1; }

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DB_URL="${DATABASE_URL:-}"
# Prisma's ?schema=public is not a libpq parameter.
DB_URL="${DB_URL%%\?schema=public}"
DB_URL="${DB_URL//\?schema=public&/?}"
BACKUP_DIR="${BACKUP_DIR:-$REPO_ROOT/backups}"
STORAGE_DRIVER="${STORAGE_DRIVER:-local}"
STORAGE_LOCAL_ROOT="${STORAGE_LOCAL_ROOT:-$REPO_ROOT/apps/api/storage}"
case "$STORAGE_LOCAL_ROOT" in /*) ;; *) STORAGE_LOCAL_ROOT="$REPO_ROOT/apps/api/$STORAGE_LOCAL_ROOT" ;; esac
COPY_BLOBS="${BACKUP_COPY_BLOBS:-$([ "$STORAGE_DRIVER" = local ] && echo true || echo false)}"
VERIFY_BLOBS="${BACKUP_VERIFY_BLOBS:-all}"
RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-0}"

for bin in pg_dump psql sha256sum; do command -v "$bin" >/dev/null || die "$bin not found"; done

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
OUT="$BACKUP_DIR/ngao360-$STAMP"
mkdir -p "$OUT"
START=$(date +%s)
log "writing $OUT"

psql_args=(-X -v ON_ERROR_STOP=1 -q)
[ -n "$DB_URL" ] && psql_args+=("$DB_URL")

# ---------------------------------------------------------------------------------------------
# 1. Hold one REPEATABLE READ transaction open and export its snapshot. pg_dump and every metadata
#    query below import that snapshot, so the dump, the counts and the manifest describe exactly
#    the same database state even while the API keeps writing.
# ---------------------------------------------------------------------------------------------
FIFO_DIR="$(mktemp -d)"
mkfifo "$FIFO_DIR/in" "$FIFO_DIR/out"
psql "${psql_args[@]}" -At <"$FIFO_DIR/in" >"$FIFO_DIR/out" 2>"$FIFO_DIR/err" &
HOLDER=$!
exec 7>"$FIFO_DIR/in"
exec 8<"$FIFO_DIR/out"
cleanup() {
  exec 7>&- 2>/dev/null || true
  wait "$HOLDER" 2>/dev/null || true
  rm -f "$FIFO_DIR/in" "$FIFO_DIR/out" "$FIFO_DIR/err"
  rmdir "$FIFO_DIR" 2>/dev/null || true
}
trap cleanup EXIT
echo "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY; SELECT pg_export_snapshot();" >&7
read -r -t 30 SNAPSHOT <&8 || die "could not export a snapshot: $(cat "$FIFO_DIR/err")"
log "snapshot $SNAPSHOT"

in_snapshot() {
  # Runs SQL from stdin inside the exported snapshot; output unaligned, tab-separated, no headers.
  { echo "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;"; echo "SET TRANSACTION SNAPSHOT '$SNAPSHOT';"; cat; echo "COMMIT;"; } |
    psql "${psql_args[@]}" -At -F $'\t' -P footer=off
}

# ---------------------------------------------------------------------------------------------
# 2. Dump (custom format, compressed) from the snapshot.
# ---------------------------------------------------------------------------------------------
dump_args=(--format=custom --compress=6 --snapshot="$SNAPSHOT" --file="$OUT/db.dump")
[ -n "$DB_URL" ] && dump_args+=("--dbname=$DB_URL")
pg_dump "${dump_args[@]}"
log "pg_dump done ($(du -h "$OUT/db.dump" | cut -f1))"

# ---------------------------------------------------------------------------------------------
# 3. Metadata from the same snapshot.
# ---------------------------------------------------------------------------------------------
TABLES=$(in_snapshot <<'SQL'
SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename;
SQL
)
{
  for t in $TABLES; do printf "SELECT '%s', count(*) FROM public.%s;\n" "$t" "\"$t\""; done
} | in_snapshot > "$OUT/row-counts.tsv"
log "row counts: $(wc -l < "$OUT/row-counts.tsv") tables, $(awk -F'\t' '{s+=$2} END {print s}' "$OUT/row-counts.tsv") rows"

# Tables with row-level security (must be identical after a restore).
in_snapshot > "$OUT/rls-tables.tsv" <<'SQL'
SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relrowsecurity
ORDER BY c.relname;
SQL

# Audit chain digest: SHA-256 over "seq:event_hash\n" in seq order. A restore that drops, adds,
# reorders or alters any event's hash produces a different digest.
in_snapshot <<'SQL' | sha256sum | cut -d' ' -f1 > "$OUT/audit-chain.sha256"
SELECT seq || ':' || event_hash FROM audit_events ORDER BY seq;
SQL
in_snapshot > "$OUT/audit-head.tsv" <<'SQL'
SELECT count(*), coalesce(min(seq), 0), coalesce(max(seq), 0), coalesce((SELECT event_hash FROM audit_events ORDER BY seq DESC LIMIT 1), '') FROM audit_events;
SQL

# Storage manifest: every original with its hash and size.
in_snapshot > "$OUT/storage-manifest.tsv" <<'SQL'
SELECT id, tenant_id, storage_driver, storage_key, sha256, size_bytes, malware_scan_status
FROM stored_files ORDER BY storage_key;
SQL
FILES=$(wc -l < "$OUT/storage-manifest.tsv")
log "storage manifest: $FILES files"

echo "COMMIT;" >&7
exec 7>&-
wait "$HOLDER" || die "snapshot holder failed: $(cat "$FIFO_DIR/err")"

# ---------------------------------------------------------------------------------------------
# 4. Blobs (local driver): verify bytes against the manifest and copy them into the backup.
#    With S3 the originals are versioned and under Object Lock; replicate the bucket separately
#    (docs/RUNBOOKS.md) and let the restore drill spot-check it.
# ---------------------------------------------------------------------------------------------
BLOB_CHECKED=0
BLOB_BAD=0
BLOB_MISSING=0
if [ "$STORAGE_DRIVER" = local ]; then
  [ -d "$STORAGE_LOCAL_ROOT" ] || die "STORAGE_LOCAL_ROOT $STORAGE_LOCAL_ROOT does not exist"
  limit=0
  case "$VERIFY_BLOBS" in all) limit=-1 ;; none) limit=0 ;; *) limit=$VERIFY_BLOBS ;; esac
  n=0
  while IFS=$'\t' read -r _id _tenant driver key sha _size _scan; do
    [ "$driver" = LOCAL ] || continue
    src="$STORAGE_LOCAL_ROOT/$key"
    if [ ! -f "$src" ]; then
      BLOB_MISSING=$((BLOB_MISSING + 1))
      echo "$key" >> "$OUT/blobs-missing.txt"
      continue
    fi
    if [ "$limit" -lt 0 ] || [ "$n" -lt "$limit" ]; then
      actual=$(sha256sum "$src" | cut -d' ' -f1)
      BLOB_CHECKED=$((BLOB_CHECKED + 1))
      if [ "$actual" != "$sha" ]; then
        BLOB_BAD=$((BLOB_BAD + 1))
        echo "$key expected=$sha actual=$actual" >> "$OUT/blobs-mismatch.txt"
      fi
      n=$((n + 1))
    fi
    if [ "$COPY_BLOBS" = true ]; then
      mkdir -p "$OUT/blobs/$(dirname "$key")"
      cp -p "$src" "$OUT/blobs/$key"
    fi
  done < "$OUT/storage-manifest.tsv"
  log "blobs: checked $BLOB_CHECKED, mismatched $BLOB_BAD, missing $BLOB_MISSING, copied=$COPY_BLOBS"
fi

# ---------------------------------------------------------------------------------------------
# 5. Summary and checksums of every file in the backup.
# ---------------------------------------------------------------------------------------------
END=$(date +%s)
SERVER_VERSION=$(psql "${psql_args[@]}" -Atc "SHOW server_version")
MIGRATION=$(psql "${psql_args[@]}" -Atc "SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NOT NULL ORDER BY migration_name DESC LIMIT 1")
read -r AUDIT_COUNT AUDIT_MIN AUDIT_MAX AUDIT_LAST < <(tr '\t' ' ' < "$OUT/audit-head.tsv")
cat > "$OUT/backup.json" <<JSON
{
  "format": "ngao360-backup/1",
  "createdAt": "$(date -u -d "@$START" +%Y-%m-%dT%H:%M:%SZ)",
  "durationSeconds": $((END - START)),
  "snapshot": "$SNAPSHOT",
  "postgres": "$SERVER_VERSION",
  "latestMigration": "$MIGRATION",
  "dumpBytes": $(stat -c %s "$OUT/db.dump"),
  "tables": $(wc -l < "$OUT/row-counts.tsv"),
  "rows": $(awk -F'\t' '{s+=$2} END {print s+0}' "$OUT/row-counts.tsv"),
  "audit": { "events": $AUDIT_COUNT, "minSeq": $AUDIT_MIN, "maxSeq": $AUDIT_MAX, "lastEventHash": "$AUDIT_LAST", "chainDigest": "$(cat "$OUT/audit-chain.sha256")" },
  "storage": { "driver": "$STORAGE_DRIVER", "files": $FILES, "blobsVerified": $BLOB_CHECKED, "blobsMismatched": $BLOB_BAD, "blobsMissing": $BLOB_MISSING, "blobsCopied": $COPY_BLOBS }
}
JSON
(cd "$OUT" && find . -type f ! -name SHA256SUMS -print0 | sort -z | xargs -0 sha256sum > SHA256SUMS)
log "done in $((END - START)) s: $(du -sh "$OUT" | cut -f1) total"

if [ "$RETENTION_DAYS" -gt 0 ]; then
  find "$BACKUP_DIR" -maxdepth 1 -type d -name 'ngao360-*' -mtime +"$RETENTION_DAYS" -print -exec rm -r -- {} + >&2
fi

[ "$BLOB_BAD" -eq 0 ] || die "$BLOB_BAD stored file(s) do not match their SHA-256 (see blobs-mismatch.txt)"
if [ "$BLOB_MISSING" -gt 0 ] && [ "${BACKUP_ALLOW_MISSING_BLOBS:-false}" != true ]; then
  die "$BLOB_MISSING stored file(s) are missing from $STORAGE_LOCAL_ROOT (see blobs-missing.txt)"
fi
echo "$OUT"
